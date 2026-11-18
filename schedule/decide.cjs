'use strict';

/**
 * 刷B站 · 「这一拍该做什么」的**唯一实现**。
 *
 * 1.5.0 起只有一条自动化：cron 反复敲，闸门脚本判「要不要叫模型」（零 token），
 * 模型被叫醒后第一步调 `bili_round({action:"start"})`，由插件用**新鲜记账**再判一次
 * 「这一拍做日报轮、互动轮，还是什么都不做」，并给对应章程。
 *
 * 判定只有这一份代码，三个地方都调它：
 *   - schedule/precheck.mjs      （读 %APPDATA%\Cindy\duty\cindy-bili-scroll 的镜像，判这一拍放不放行）
 *   - node/worker.cjs 的 duty/*  （插件把**自己刚读到的记账**按同一形状递进来）
 *   - main.js 通过 cindy.node.request('duty/decide' / 'duty/segments' / 'duty/layout') 调上面那些
 * 闸门只能看到上一次同步的镜像（有时差），所以它是保守粗筛；插件那边是权威判定。
 * 两边不一致时最多是白叫一次短会话，绝不会多发一条内容。
 *
 * `bili_round` 要知道的一切也都从这里出（`layout`）：此刻在哪一段、这一段还剩几轮、
 * 这一槽位试过几次、互动检查今天还剩几次。沙箱里的 main.js 没有 require，所以它拿
 * 段表、窗口、尝试次数、互动额度**只能问 worker**——这正是「规则只有一份」的代价，
 * 也是它成立的保证：main.js 里连一个 `parseClock` 都没有，想改规则无从改起。
 *
 * 这个文件刻意是 CommonJS、零依赖：ESM 脚本 `import` 它、CJS 的 worker `require` 它，
 * 两边都不需要转译。它**只做判断、不落盘、不发请求**，所以可以拿假数据反复跑。
 *
 * 两条车道的账本彼此独立，绝不合成一个大池：
 *   - 日报轮：时段配额（一天之内的左闭右开区间 + 每段最多几轮）+ 每日挑几 + 每槽位尝试次数
 *   - 互动轮：每天检查几次 + 两次之间的最小间隔
 * 共用的是**互斥**（同一时刻只做一件事），不是额度。
 */

const LOCK_TTL_MS = 12 * 60 * 1000;
// 互动检查的锁（15 分钟），只用来防并发。
// 「谁属于这条车道」由调用方带的 token 判（main.js 的 laneOf），不靠锁，所以锁比归属
// 窗口（30 分钟）短不会再留洞：崩在半路的检查最多让下一拍等一次，不会连累再下一拍。
const INBOX_LOCK_TTL_MS = 15 * 60 * 1000;
// 「脚本刚放、插件还没认领」的那一次尝试，在多久之内算「这一拍的机会」。
const ALLOWANCE_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TRIES = 3;
const SEGMENT_MAX_ROUNDS = 6;
const SEGMENT_MAX_COUNT = 6;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** 非负整数；解析不了就是 0（缺字段、手改坏的镜像都按「没有」处理）。 */
function wholeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** "HH:MM" → 当天第几分钟；`24:00` 合法（= 1440）。解析不了返回 NaN。 */
function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text === undefined || text === null ? '' : text).trim());
  if (!match) return NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 24) return NaN;
  const total = hours * 60 + minutes;
  return total <= 1440 ? total : NaN;
}

/** 第几分钟 → "HH:MM"（`1440` → `24:00`）。 */
function clockText(minutes) {
  return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
}

function segmentKeyOf(seg) {
  return String(seg.start);
}

function segmentLabel(seg) {
  return clockText(seg.start) + '–' + clockText(seg.end) + ' ×' + seg.rounds;
}

/**
 * 把段表洗成可用的一份：一天之内的左闭右开区间、按起点排序、重叠的丢掉、
 * 一段都没有就退回「整天 ×1」。
 *
 * 镜像可能是旧版插件写的（没有 segments，只有 autoRoundsPerDay），也可能被人手改过。
 * **读不到合法的段表时宁可退成「整天 ×1」**——那等于 1.3.x 的老行为，不会多放行，
 * 也不会让自动任务整天不动。
 */
function normalizeSegments(raw, legacyRounds) {
  const list = Array.isArray(raw) ? raw : null;
  const kept = [];
  if (list) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const start = parseClock(item.start);
      const end = parseClock(item.end);
      const rounds = Math.round(Number(item.rounds));
      if (!Number.isFinite(start) || start < 0 || start >= 1440) continue;
      if (!Number.isFinite(end) || !(end > start)) continue;
      if (!Number.isFinite(rounds) || rounds < 1) continue;
      if (kept.some((seg) => start < seg.end && seg.start < end)) continue;
      kept.push({ start, end, rounds: Math.min(rounds, SEGMENT_MAX_ROUNDS) });
      if (kept.length >= SEGMENT_MAX_COUNT) break;
    }
  }
  if (!kept.length) {
    const rounds = Math.round(Number(legacyRounds));
    kept.push({ start: 0, end: 1440, rounds: Number.isFinite(rounds) && rounds >= 1 ? Math.min(rounds, SEGMENT_MAX_ROUNDS) : 1 });
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

/** 现在落在哪一段（没有就是 null）。按本机时区。 */
function segmentAt(segments, date) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const seg of segments) {
    if (minutes >= seg.start && minutes < seg.end) return seg;
  }
  return null;
}

/**
 * 清洗过的段表，给人看/给存储用的形态：`HH:MM` + 派生出来的 key 与 label。
 *
 * 段表规则只有 normalizeSegments 那一段代码，这里只是换个形态输出——插件要写进
 * config.json（`duty/segments`）、要说清「这一轮属于哪一段」（`duty/layout`），
 * 都是同一张表的两种读法，不是第二份实现。
 */
function tableView(list) {
  return list.map((seg) => ({
    start: clockText(seg.start),
    end: clockText(seg.end),
    rounds: seg.rounds,
    // 段的身份 = 起点的分钟数（"360" 表示 06:00 开始那段）。槽位 `360#1` 用的就是它。
    key: segmentKeyOf(seg),
    label: segmentLabel(seg),
  }));
}

/** 设置里那张段表洗完之后的唯一形态（含派生 key / label）。 */
function segmentTable(raw, legacyRounds) {
  return tableView(normalizeSegments(raw, legacyRounds));
}

/**
 * 还在有效期内的锁。锁里的时刻解析不了就当没有锁（跟 1.4.0 一致）：
 * 把一份读不懂的记账当成「永远在跑」会让自动任务静默死掉。
 *
 * 这里用传进来的 `nowMs`，不用 Date.now()：`--now` 调试时「假装现在几点」
 * 必须同时决定锁有没有过期，否则测试里锁永远都是活的。
 */
function liveLock(lock, ttlMs, nowMs) {
  const value = asObject(lock);
  if (!value || !value.at) return null;
  const at = Date.parse(String(value.at));
  if (!Number.isFinite(at)) return null;
  return nowMs - at < ttlMs ? value : null;
}

/**
 * 此刻在哪一段、这一段还剩几轮。
 *
 * `decide` 的「日报轮能不能开」就是这条链上的一个结论；插件还要把同一件事
 * **解释给人听**（hint）并且记住 `slot`（尝试计数按它分开），所以这里单独成型。
 * 两边读的是同一张段表、同一份记账，不存在「插件算的一套、闸门算的另一套」。
 *
 * 返回的 `hint` / `blocked` 是模型和仪表盘看的原文，改动要当成改输出文案。
 *
 * 记账必须是**已经按天归一化**的那一份（插件侧是 `mirrorState` / `gateDay` 的结果）：
 * 跨天的旧账由调用方清零，这里只看 `seg` 里今天的数。
 */
function windowOf(rawConfig, rawState, nowMs) {
  const config = asObject(rawConfig) || {};
  const state = asObject(rawState) || {};
  const list = normalizeSegments(config.segments, config.autoRoundsPerDay);
  const rows = tableView(list);
  const seg = segmentAt(list, new Date(nowMs));
  const counts = asObject(state.seg) || {};
  const table = rows.map((row) => ({
    label: row.label,
    rounds: row.rounds,
    runs: wholeNumber(counts[row.key]),
  }));
  const base = {
    segments: table,
    // 今天的自动轮总数（各段之和）与已跑成总数：给使用者看，也用来给旧版闸门脚本留后路。
    autoRoundsPerDay: rows.reduce((sum, row) => sum + row.rounds, 0),
    runsToday: table.reduce((sum, row) => sum + row.runs, 0),
  };

  if (!seg) {
    return Object.assign(base, {
      open: false,
      slot: '',
      segment: null,
      blocked: 'outside_segments',
      hint: '现在不在任何刷B站时段内（' + (rows.map((row) => row.label).join(' · ') || '没有配置时段') + '）。'
        + '时段决定「什么时候能跑、跑几轮」，具体几点敲由自动化任务的 cron 决定。',
    });
  }

  const key = segmentKeyOf(seg);
  const runs = wholeNumber(counts[key]);
  const cap = Math.max(1, seg.rounds || 1);
  const detail = {
    label: segmentLabel(seg),
    key,
    start: clockText(seg.start),
    end: clockText(seg.end),
    rounds: cap,
    runs,
  };

  if (runs >= cap) {
    return Object.assign(base, {
      open: false,
      slot: '',
      segment: detail,
      blocked: 'segment_done',
      hint: '「' + detail.label + '」这一段今天已经跑成 ' + runs + '/' + cap + ' 轮，额度用完了；其他时段各自的额度不受影响。',
    });
  }
  return Object.assign(base, {
    open: true,
    // 尝试计数的键：段起点 + 段内第几轮。插件、闸门脚本、worker 算出的是同一个字符串。
    slot: key + '#' + runs,
    segment: detail,
    blocked: '',
    hint: '',
  });
}

/**
 * 这个槽位到「这一拍之前」试过几次、这一拍开跑之后该记成几次。
 *
 * 两边都记尝试次数：插件记 `starts[槽位]`（真的开起来了），闸门脚本记 `hookStarts[槽位]`
 * （我放行过）。正常路径上脚本先记了这一次，所以 max(两边) 恰好等于「这一拍记完之后」
 * 的值；但这一轮里如果先跑过一个会同步的工具，插件就已经把脚本那次收进来了——那时再
 * 加 1 就是同一次尝试算两遍，maxTries 实际只剩 2 次。
 *
 * 判断依据是时间：`hookAt` 是脚本最近一次放行的时刻，`slotAt[槽位]` 是插件上一次在这个
 * 槽位真正开跑的时刻；放行比开跑新（且在时效内）⇒ 还没被认领。于是：
 *   - `before` = 「之前」试过几次（脚本给这一拍的放行不算在里面，额度判断要用它）
 *   - `next`   = 这一拍开跑之后该写回去的数（脚本那次不重复记）
 */
function attemptsOf(rawState, slot, nowMs) {
  const state = asObject(rawState) || {};
  const day = dateKey(new Date(nowMs));
  if (!slot) return { raw: 0, unclaimed: false, before: 0, next: 0 };
  const starts = state.day === day ? asObject(state.starts) || {} : {};
  // hookStarts 是闸门脚本自己记的，按它记下的 hookDay 判天，不跟镜像的 day 走：
  // 插件可能整夜没被调用（day 还是昨天），而脚本凌晨已经放过两次行。
  const hookStarts = state.hookDay === day ? asObject(state.hookStarts) || {} : {};
  const raw = Math.max(wholeNumber(starts[slot]), wholeNumber(hookStarts[slot]));
  const allowedAt = state.hookDay === day ? Date.parse(String(state.hookAt || '')) : NaN;
  const slotAt = asObject(state.slotAt) || {};
  const startedAt = Date.parse(String(slotAt[slot] || ''));
  const unclaimed = Number.isFinite(allowedAt)
    && (!Number.isFinite(startedAt) || allowedAt > startedAt)
    && Math.abs(nowMs - allowedAt) <= ALLOWANCE_WINDOW_MS;
  return { raw, unclaimed, before: Math.max(0, raw - (unclaimed ? 1 : 0)), next: unclaimed ? raw : raw + 1 };
}

/**
 * 互动检查的额度：今天用掉几次、还剩几次、离最小间隔还差多久。
 *
 * 账本有两份记录（插件记「开起来了」、脚本记「我放行过」），取较大值而不是相加：
 * 同一次检查两边都记，相加会一次算两次；而两边也可能各多记一次（脚本放行后模型没跑到
 * `bili_inbox`，或使用者在聊天里手动开了一次），取较大值正好都算进去。
 *
 * `checksPending` = 脚本刚放行、这一次 start 还没认领的那一次。额度判断把它暂扣
 * （那正是本次），写回账本时用 `checksRaw`（含它），否则账会越写越少。
 *
 * `options.claim` 跟 `decide` 的意思一样：谁在问。待认领那一次的**盖章时刻**是不是
 * 「上一次检查」的时刻，两边答案不同——
 *   - 闸门（claim:false）：算。它靠自己的章控制最小间隔，不认就等于每敲一拍都放行。
 *   - 插件（claim:true）且这一次待认领：不算。那一次就是本次，拿它的章去比 minGap
 *     会立刻判 `inbox_too_soon`，闸门放行的每一拍都自我作废（1.5.0–1.6.0 的线上 bug）。
 * 陈放行（超过 ALLOWANCE_WINDOW_MS 还没认领）本来就不是 `pending`：模型早该醒了。
 */
function inboxLimitsOf(rawConfig, rawState, nowMs, options) {
  const opts = asObject(options) || {};
  const claim = opts.claim === true;
  const config = asObject(rawConfig) || {};
  const state = asObject(rawState) || {};
  const day = dateKey(new Date(nowMs));
  const pluginChecks = state.day === day ? wholeNumber(state.inboxChecks) : 0;
  const hookTries = state.inboxHookDay === day ? wholeNumber(state.inboxHookTries) : 0;
  const raw = Math.max(pluginChecks, hookTries);
  const pluginAt = Date.parse(String(state.inboxLastAt || ''));
  const hookAt = state.inboxHookDay === day ? Date.parse(String(state.inboxHookAt || '')) : NaN;
  // 放行之后 30 分钟还没被认领，就不能再算「这一拍的那一次」：那个模型早该跑完了。
  const hookFresh = Number.isFinite(hookAt) && Math.abs(nowMs - hookAt) <= ALLOWANCE_WINDOW_MS;
  const pending = hookTries > pluginChecks
    && Number.isFinite(hookAt)
    && (hookAt >= (Number.isFinite(pluginAt) ? pluginAt : 0) || hookFresh)
    && hookFresh;
  const used = Math.max(0, raw - (pending ? 1 : 0));
  const checksPerDay = wholeNumber(config.inboxChecksPerDay);
  const lastAt = Math.max(
    Number.isFinite(pluginAt) ? pluginAt : 0,
    claim && pending ? 0 : (Number.isFinite(hookAt) ? hookAt : 0)
  );
  const replies = Array.isArray(state.replies) ? state.replies : [];
  return {
    enabled: config.replyToComments === true && checksPerDay > 0,
    checksUsed: used,
    checksPerDay,
    checksLeft: Math.max(0, checksPerDay - used),
    checksRaw: raw,
    checksPending: pending,
    lastAt,
    minGapMin: Math.max(0, Number(config.inboxMinGapMin) || 0),
    replyPerRound: Math.max(0, Number(config.replyPerRound) || 0),
    replyPerDay: Math.max(0, Number(config.replyPerDay) || 0),
    repliedToday: replies.filter((entry) => entry && String(entry.atDay || entry.day) === day).length,
  };
}

/**
 * 插件那一边要的**全部**判定数据，一次问完（`duty/layout`）。
 *
 * main.js 是沙箱脚本，没有 require：段表、窗口、尝试次数、互动额度它都算不出来，
 * 只能问 worker。与其让它按自己的理解拼四份输入、再各问一次，不如这里一把给齐——
 * 少四次往返，也不可能出现「两次调用之间记账变了」而各答一半。
 *
 * 输入形状 = 镜像（config 一半 + state 一半），和 `decide` 收到的完全一样；
 * 唯一的额外字段是 `replies`（只是数一下今天回了几条，不从闸门镜像里过）。
 */
function layout(rawConfig, rawState, nowInput) {
  const now = nowInput instanceof Date
    ? new Date(nowInput.getTime())
    : new Date(nowInput === undefined || nowInput === null ? Date.now() : nowInput);
  const nowMs = now.getTime();
  const state = asObject(rawState) || {};
  const win = windowOf(rawConfig, rawState, nowMs);
  return Object.assign({ day: dateKey(now), at: now.toISOString() }, win, {
    maxTries: Math.max(1, wholeNumber(state.maxTries) || DEFAULT_MAX_TRIES),
    attempts: attemptsOf(rawState, win.slot, nowMs),
    // 插件问自己要展示的数据（设置页、工具返回、minGap 判断），口径跟 claim:true 一致：
    // 待认领那一次的章不是「上一次检查」，否则会显示「0 分钟前刚查过」并挡掉这一拍。
    inbox: inboxLimitsOf(rawConfig, rawState, nowMs, { claim: true }),
  });
}

/**
 * 这一拍做什么。
 *
 * @param {object} rawConfig 镜像里的设置（segments / perDay / replyToComments /
 *   inboxChecksPerDay / inboxMinGapMin；旧镜像还可能有 autoRoundsPerDay）
 * @param {object} rawState  镜像里的记账（见 main.js 的 buildMirror）。除了段/额度/锁，
 *   还读 `slotAt`（各槽位开跑时刻，用来判「脚本刚放的那一次有没有被认领」）和
 *   `reportUnavailable`（今天的日报读不到，不能开日报轮）
 * @param {Date|string|number} [nowInput] 假装现在是什么时候（缺省=现在）
 * @param {{claim?: boolean}} [options] 见下面「谁在问」
 * @returns {{
 *   mode: 'report'|'inbox'|'none',
 *   reason: string,
 *   day: string,
 *   at: string,
 *   segment: object|null,
 *   slot: string,
 *   quota: object|null,
 *   report: {ok: boolean, reason: string, segment: object|null, slot: string, runs: number,
 *            rounds: number, tries: number, maxTries: number, pickedAuto: number, perDay: number},
 *   inbox: {ok: boolean, reason: string, checksUsed: number, checksPerDay: number,
 *           lastAt: number, minGapMin: number, gapLeftMs: number}
 * }}
 *
 * `options.claim`（默认 false）：谁在问。
 *   - 闸门问的是「这一拍要不要叫模型」。它自己上一次放行如果没被认领，那仍然是一次
 *     已经花掉的尝试——所以不能扣掉，否则每敲一拍都能把上一次的放行当成本拍的机会，
 *     3 次的尝试预算永远用不完。
 *   - 插件问的是「我这个模型现在能不能开这一轮」。脚本刚放行、还等着被认领的那一次
 *     就是这一轮：不扣掉它，插件的额度判定会拿「包括这一拍」的数去比上限，正好把
 *     最后一次机会判掉。
 * 同一个开关也管**时刻**：插件这一问如果正对着待认领的那一次，它的盖章时刻不能算成
 * 「上一次检查」的时刻（否则 minGap 立刻把这一拍判成 too_soon，闸门放行的每一拍都白醒）。
 * 规则本身仍然只有一份（`attemptsOf` / `inboxLimitsOf`），差别只是「上一次放行算不算
 * 已经用掉」——所以它是这个函数的选项，不是第二套账。
 */
function decide(rawConfig, rawState, nowInput, options) {
  const opts = asObject(options) || {};
  const claim = opts.claim === true;
  const now = nowInput instanceof Date
    ? new Date(nowInput.getTime())
    : new Date(nowInput === undefined || nowInput === null ? Date.now() : nowInput);
  const nowMs = now.getTime();
  const today = dateKey(now);
  const config = asObject(rawConfig);
  const state = asObject(rawState);

  const decision = {
    mode: 'none',
    reason: 'no_mirror',
    day: today,
    at: now.toISOString(),
    segment: null,
    slot: '',
    quota: null,
    report: {
      ok: false,
      reason: 'no_mirror',
      segment: null,
      slot: '',
      runs: 0,
      rounds: 0,
      tries: 0,
      maxTries: DEFAULT_MAX_TRIES,
      pickedAuto: 0,
      perDay: 0,
    },
    inbox: {
      ok: false,
      reason: 'no_mirror',
      checksUsed: 0,
      checksPerDay: 0,
      lastAt: 0,
      minGapMin: 0,
      gapLeftMs: 0,
    },
  };
  if (!config || !state) return decision;

  // 记账只对「今天」有效。跨过零点，昨天跑成的轮次、昨天挑的条都不该再挡今天。
  const fresh = state.day === today;

  const segments = normalizeSegments(config.segments, config.autoRoundsPerDay);
  const current = segmentAt(segments, now);
  const segment = current
    ? {
      key: segmentKeyOf(current),
      label: segmentLabel(current),
      start: current.start,
      end: current.end,
      rounds: current.rounds,
    }
    : null;
  decision.segment = segment;

  const reportLock = liveLock(state.lock, LOCK_TTL_MS, nowMs);
  const inboxLock = liveLock(state.inboxLock, INBOX_LOCK_TTL_MS, nowMs);

  // ── 日报轮 ──────────────────────────────────────────────────────────
  const perDay = wholeNumber(config.perDay);
  const pickedAuto = fresh ? wholeNumber(state.pickedAuto) : 0;
  let runs = 0;
  if (fresh && segment) {
    const seg = asObject(state.seg);
    if (seg) {
      runs = wholeNumber(seg[segment.key]);
    } else if (state.runs !== undefined && state.runs !== null && Number.isFinite(Number(state.runs))) {
      // 1.3.x 的旧镜像：只有一个「今天跑成了几轮」，不分段。
      // 只记在整天段（键 "0"）上，跟 main.js 的 gateDay 一样——旧账不能算到
      // 06:00–10:00 这种新段头上，否则闸门和插件会对同一份镜像给出不同结论。
      runs = segment.key === '0' ? wholeNumber(state.runs) : 0;
    } else if (asObject(state.windows)) {
      // 1.2.x 的旧镜像：勾掉过几档就算跑成了几轮。
      const windows = asObject(state.windows);
      runs = segment.key === '0' ? Object.keys(windows).filter((key) => windows[key]).length : 0;
    }
  }
  const slot = segment ? segment.key + '#' + runs : '';
  // 尝试次数：同一个 attemptsOf，只是「脚本刚放行的那一次算不算已经用掉」按谁在问决定。
  const attempts = attemptsOf(state, slot, nowMs);
  const tries = claim ? attempts.before : attempts.raw;
  const maxTries = Math.max(1, wholeNumber(state.maxTries) || DEFAULT_MAX_TRIES);

  const report = {
    ok: false,
    reason: '',
    segment,
    slot,
    runs,
    rounds: segment ? segment.rounds : 0,
    tries,
    maxTries,
    pickedAuto,
    perDay,
    reportUnavailable: state.reportUnavailable === true,
  };
  if (state.loggedIn === false) {
    report.reason = 'not_logged_in';
  } else if (reportLock) {
    report.reason = 'busy';
  } else if (inboxLock) {
    // 单车道：互动检查跑着的时候不另开一个模型会话。等它收尾（锁 15 分钟过期）再说。
    report.reason = 'inbox_running';
  } else if (report.reportUnavailable) {
    // 今天的日报读不到：开轮写进去会盖掉已挑的条目。插件比脚本先知道这件事。
    report.reason = 'report_unreadable';
  } else if (perDay > 0 && pickedAuto >= perDay) {
    // perDay = 0 是「不自动限流」，不是「一条都不许」。
    report.reason = 'quota_exhausted';
  } else if (!segment) {
    report.reason = 'outside_segments';
  } else if (runs >= segment.rounds) {
    report.reason = 'segment_done';
  } else if (tries >= maxTries) {
    report.reason = 'tries_exhausted';
  } else {
    report.ok = true;
    report.reason = 'ready';
  }

  // ── 互动轮 ──────────────────────────────────────────────────────────
  const limits = inboxLimitsOf(config, state, nowMs, { claim });
  const checksPerDay = limits.checksPerDay;
  // 脚本刚放行的那一次算不算「已经用过」，同样只看谁在问。
  const checksUsed = claim ? limits.checksUsed : limits.checksRaw;
  const lastAt = limits.lastAt;
  const minGapMin = limits.minGapMin;
  const gapLeftMs = minGapMin > 0 && lastAt > 0 ? Math.max(0, lastAt + minGapMin * 60000 - nowMs) : 0;

  const inbox = {
    ok: false,
    reason: '',
    checksUsed,
    checksPerDay,
    lastAt,
    minGapMin,
    // 今天一次都还没检查过时，昨天的时间戳不该挡住第一次：`lastAt + gap` 已经落在
    // 过去，这里算出来自然是 0，不需要额外开关。
    gapLeftMs,
  };
  if (state.loggedIn === false) {
    inbox.reason = 'not_logged_in';
  } else if (config.replyToComments !== true || checksPerDay <= 0) {
    inbox.reason = 'inbox_disabled';
  } else if (reportLock) {
    // 设计如此：日报轮在跑的时候互动轮被堵住。两个会话同时动同一个账号，
    // 插件分不清是哪个模型在调工具，红线就只剩一句提示了。
    inbox.reason = 'report_running';
  } else if (inboxLock) {
    inbox.reason = 'inbox_busy';
  } else if (checksUsed >= checksPerDay) {
    inbox.reason = 'inbox_checks_exhausted';
  } else if (gapLeftMs > 0) {
    inbox.reason = 'inbox_too_soon';
  } else {
    inbox.ok = true;
    inbox.reason = 'ready';
  }

  decision.report = report;
  decision.inbox = inbox;

  if (report.ok) {
    decision.mode = 'report';
    decision.reason = 'report_ready';
    decision.slot = slot;
    decision.quota = {
      kind: 'report',
      segment,
      runs,
      rounds: segment.rounds,
      slot,
      tries,
      maxTries,
      pickedAuto,
      perDay,
    };
  } else if (inbox.ok) {
    decision.mode = 'inbox';
    decision.reason = 'inbox_ready';
    decision.quota = {
      kind: 'inbox',
      checksUsed,
      checksPerDay,
      lastAt,
      minGapMin,
      gapLeftMs,
    };
  } else {
    // 都没活：reason 取日报轮那一条（它是最常见的「这一拍为什么什么都不做」），
    // 互动轮的原因在 decision.inbox.reason 里，需要时一起看。
    decision.mode = 'none';
    decision.reason = report.reason;
    decision.quota = null;
  }
  return decision;
}

module.exports = {
  decide,
  layout,
  windowOf,
  attemptsOf,
  inboxLimitsOf,
  segmentTable,
  liveLock,
  parseClock,
  normalizeSegments,
  segmentKeyOf,
  segmentLabel,
  segmentAt,
  clockText,
  dateKey,
  pad2,
  ALLOWANCE_WINDOW_MS,
  DEFAULT_MAX_TRIES,
  LOCK_TTL_MS,
  INBOX_LOCK_TTL_MS,
  SEGMENT_MAX_ROUNDS,
  SEGMENT_MAX_COUNT,
};
