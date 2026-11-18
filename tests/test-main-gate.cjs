'use strict';

/**
 * main.js 的「闸门 / 记账」薄壳，以及它和共享判定（schedule/decide.cjs）的接线。
 *
 * 1.5.0 收尾之后 main.js 里**不再有判定规则**：段表、窗口、尝试次数、互动额度
 * 全靠 worker 问 schedule/decide.cjs（`duty/segments` / `duty/layout` / `duty/decide`）。
 * 所以这份测试做两件事：
 *   1. 用一个「照着 node/worker.cjs 的 duty/* 写的」假 worker，把 main.js 的接线跑起来，
 *      看它喂进去的形状对不对、拿回来的字段有没有用对；
 *   2. §12 是**反回归**：那几个函数名只允许在 decide.cjs 里有定义，main.js 里出现就失败。
 * 规则本身对不对由 test-decide.cjs 盯；带网络 / 落盘的路径由 test-main.cjs 盯。
 *
 *   node tests/test-main-gate.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'main.js');
const decidePath = path.join(root, 'schedule', 'decide.cjs');
const code = fs.readFileSync(mainPath, 'utf8');
const decideCode = fs.readFileSync(decidePath, 'utf8');
const decideLib = require(decidePath);

let passed = 0;
function assert(condition, label) {
  if (!condition) throw new Error('ASSERT FAILED: ' + label);
  passed += 1;
  console.log('  ✓ ' + label);
}

/**
 * 假 worker：方法名、参数、返回形状和 node/worker.cjs 的 duty/* 一一对应，
 * 算法直接 require 同一个 decide.cjs —— 和真实 worker 的做法一致。
 */
const workerCalls = [];
function fakeWorker(request) {
  const method = String((request && request.method) || '');
  const params = (request && request.params) || {};
  workerCalls.push(method);
  const nowDate = params.now ? new Date(params.now) : new Date();
  let data = {}; // duty/sync 之类这份测试不覆盖落盘，回空对象即可
  if (method === 'duty/decide') {
    data = decideLib.decide(params.config, params.state, nowDate, params.options);
  } else if (method === 'duty/segments') {
    const segments = decideLib.segmentTable(params.segments, params.autoRoundsPerDay);
    data = { segments, total: segments.reduce((sum, row) => sum + row.rounds, 0) };
  } else if (method === 'duty/layout') {
    data = decideLib.layout(params.config, params.state, nowDate);
  }
  return { ok: true, result: { ok: true, data } };
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: async function () { return { ok: false, status: 0, json: async function () { return {}; } }; },
  BroadcastChannel: class {
    constructor() {}
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
  },
  cindy: {
    send: async function () { return null; },
    onHostMessage: function () {},
    agent: {},
    node: { request: async function (request) { return fakeWorker(request); } },
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'main.js' });

const S = sandbox;
const countWorker = (method) => workerCalls.filter((name) => name === method).length;

async function run() {
  console.log('# 1. 段表（经 duty/segments）：解析、排序、去重叠、兜底');
  const segsOf = async function (segments, legacy) {
    return (await S.segmentsInfo({ segments: segments, autoRoundsPerDay: legacy }, 'test')).segments;
  };
  let rows = await segsOf([
    { start: '18:00', end: '24:00', rounds: 1 },
    { start: '06:00', end: '10:00', rounds: 1 },
  ]);
  assert(rows.length === 2, '两段都保留');
  assert(rows[0].start === '06:00' && rows[1].start === '18:00', '按起点排序');
  assert(rows[0].key === '360' && rows[0].end === '10:00', '段键 = 起点分钟数（06:00 → 360），起止仍是 HH:MM 原文');
  assert(rows[1].label === '18:00–24:00 ×1', '标签形如 18:00–24:00 ×1');

  rows = await segsOf([
    { start: '06:00', end: '10:00', rounds: 1 },
    { start: '09:00', end: '12:00', rounds: 1 },
  ]);
  assert(rows.length === 1 && rows[0].start === '06:00', '重叠段丢掉后一个（先配的优先）');

  rows = await segsOf([{ start: '22:00', end: '02:00', rounds: 1 }]);
  assert(rows.length === 1 && rows[0].start === '00:00' && rows[0].end === '24:00', '跨零点的段不合法 → 退回整天 ×1');

  rows = await segsOf([{ start: '06:00', end: '10:00', rounds: 99 }]);
  assert(rows[0].rounds === 6, '轮次被钳在 1–6');

  rows = await segsOf([]);
  assert(rows.length === 1 && rows[0].start === '00:00' && rows[0].rounds === 1, '空段表 → 整天 ×1');

  // rounds 缺失 / 为 0 的段整段丢掉（不是钳成 1），否则同一份设置会算出多一个窗口。
  rows = await segsOf([{ start: '06:00', end: '10:00' }]);
  assert(rows.length === 1 && rows[0].start === '00:00' && rows[0].end === '24:00', 'rounds 缺失的段被丢掉，退回整天 ×1');
  rows = await segsOf([{ start: '06:00', end: '10:00', rounds: 0 }, { start: '18:00', end: '24:00', rounds: 1 }]);
  assert(rows.length === 1 && rows[0].start === '18:00', 'rounds=0 的段整段丢掉（和闸门脚本一样，不是钳成 1）');

  console.log('# 2. 此刻落在哪一段（经 duty/layout）：还在不在段里、这段还剩几轮');
  const config = {
    segments: [
      { start: '06:00', end: '10:00', rounds: 1 },
      { start: '18:00', end: '24:00', rounds: 1 },
    ],
  };
  const at = function (hour, minute) {
    return new Date(2026, 10, 16, hour, minute, 0);
  };
  const DAY2 = '2026-11-16';
  const win = function (cfg, state, date) {
    return S.turnLayout(cfg, state, date, 'test');
  };
  const gateOf = function (extra) {
    return { gate: Object.assign({ day: DAY2, seg: {}, starts: {}, slotAt: {} }, extra || {}) };
  };

  let window0 = await win(config, gateOf(), at(8, 0));
  assert(window0.open === true && window0.segment.label === '06:00–10:00 ×1', '08:00 在早段且放行');
  assert(window0.slot === '360#0', '槽位 = 段键#段内第几轮');
  assert(window0.autoRoundsPerDay === 2, '一天总轮次 = 各段之和');

  window0 = await win(config, gateOf(), at(10, 0));
  assert(window0.open === false && window0.blocked === 'outside_segments', '10:00 是右开区间 → 不在段内');

  window0 = await win(config, gateOf({ seg: { 360: 1 } }), at(8, 30));
  assert(window0.open === false && window0.blocked === 'segment_done', '早段跑满 → segment_done');

  window0 = await win(config, gateOf({ seg: { 360: 1 } }), at(19, 0));
  assert(window0.open === true && window0.slot === '1080#0', '早段跑满不影响晚段');

  window0 = await win(config, gateOf({ seg: { 360: 1, 1080: 1 } }), at(19, 0));
  assert(window0.open === false, '晚段也跑满 → 跳过');

  const two = { segments: [{ start: '00:00', end: '24:00', rounds: 2 }] };
  window0 = await win(two, gateOf({ seg: { 0: 1 } }), at(8, 0));
  assert(window0.open === true && window0.slot === '0#1', '段内第 2 轮用同一个段的额度，槽位进到 0#1');

  console.log('# 3. 记账（gateDay）与旧镜像');
  let gate = S.gateDay({ gate: { day: '2026-11-16', seg: { 360: 1, 1080: 1 }, starts: { '360#0': 1 } } }, '2026-11-16');
  assert(gate.runsToday === 2 && gate.seg['360'] === 1, '按段读出今天跑成的轮次');
  gate = S.gateDay({ gate: { day: '2026-11-15', seg: { 360: 1 } } }, '2026-11-16');
  assert(gate.runsToday === 0 && Object.keys(gate.seg).length === 0, '跨天归零');
  gate = S.gateDay({ gate: { day: '2026-11-16', runs: 2 } }, '2026-11-16');
  assert(gate.seg['0'] === 2 && gate.runsToday === 2, '1.3.x 的 runs 迁到整天段');
  gate = S.gateDay({ gate: { day: '2026-11-16', windows: { all: true } } }, '2026-11-16');
  assert(gate.seg['0'] === 1 && gate.runsToday === 1, '1.2.x 的 windows 勾掉一档 = 跑成一轮');

  let legacy = S.legacyGateMirror({ seg: { 360: 1 }, runsToday: 1 }, 2);
  assert(legacy.runs === 1 && legacy.autoRoundsPerDay === 2, '旧镜像的 runs / 上限（总轮次由 duty/segments 给）');
  assert(Object.keys(legacy.windows).length === 0, '没跑满时旧镜像不勾 windows');
  const legacyDone = S.legacyGateMirror({ seg: { 360: 1, 1080: 1 }, runsToday: 2 }, 2);
  assert(legacyDone.windows.all === true, '跑满时旧镜像勾 windows.all（旧脚本据此跳过）');

  console.log('# 4. 槽位解析');
  assert(S.parseSlot('360#1').key === '360' && S.parseSlot('360#1').index === 1, '正常槽位');
  assert(S.parseSlot('0').key === '0' && S.parseSlot('0').index === 0, '1.3.x 的裸数字槽位');
  assert(S.parseSlot('').key === '', '空槽位');

  console.log('# 5. 互动轮额度（经 duty/layout 的 inbox）');
  const today = S.dateKey(new Date());
  const nowD = new Date();
  const inboxCfg = { replyToComments: true, inboxChecksPerDay: 20, inboxMinGapMin: 15, replyPerRound: 2, replyPerDay: 5 };
  const inboxOf = async function (cfg, state) {
    return (await S.turnLayout(cfg, state, nowD, 'test')).inbox;
  };
  let limits = await inboxOf(inboxCfg, {
    inbox: { day: today, checks: 3, lastAt: '' },
    replies: [{ day: today, round: 'a' }, { day: today, round: 'b' }],
  });
  assert(limits.checksUsed === 3 && limits.checksLeft === 17, '检查次数与剩余');
  assert(limits.repliedToday === 2, '今天已经回复的条数');
  limits = await inboxOf(inboxCfg, { inbox: { day: today, checks: 2, lastAt: '' }, inboxHookDay: today, inboxHookTries: 4 });
  assert(limits.checksUsed === 4, '插件记的与脚本记的取较大值（不是相加）');
  limits = await inboxOf(Object.assign({}, inboxCfg, { replyToComments: false }), { inbox: { day: today, checks: 0, lastAt: '' } });
  assert(limits.enabled === false, '回复开关关着 → 互动轮没开');

  const nowMinus = function (minutes) { return new Date(Date.now() - minutes * 60000).toISOString(); };
  limits = await inboxOf(inboxCfg, {
    inbox: { day: today, checks: 1, lastAt: nowMinus(30) },
    inboxHookDay: today,
    inboxHookTries: 1,
    inboxHookAt: nowMinus(5),
  });
  assert(limits.lastAt > Date.now() - 10 * 60000, '最近检查时刻取较晚的那份');

  console.log('# 6. 互动轮的归属（attribInbox）');
  const live = { token: 'i1', day: today, at: new Date().toISOString() };
  let att = S.attribInbox({ inboxLock: live }, 'i1');
  assert(att.round && att.live === true && !att.mismatch, 'token 对得上 → 归属这次检查');
  att = S.attribInbox({ inboxLock: live }, 'i2');
  assert(att.mismatch === true, 'token 对不上 → mismatch');
  att = S.attribInbox({ inboxLock: null }, 'i3');
  assert(att.mismatch === true, '没有锁却带 token → mismatch（僵尸轮次）');
  att = S.attribInbox({ inboxLock: null }, '');
  assert(att.round === null && att.mismatch === false, '没有锁也不带 token → 按临时写入处理');
  att = S.attribInbox({ inboxLock: { token: 'i9', day: today, at: nowMinus(20) } }, 'i9');
  assert(att.round && att.live === false && !att.mismatch, '锁过期（>15 分钟）但还在归属期（<30 分钟）内 → 认得出是谁');
  att = S.attribInbox({ inboxLock: { token: 'i9', day: today, at: nowMinus(10) } }, 'i9');
  assert(att.round && att.live === true && !att.mismatch, '10 分钟前那次检查仍在锁里（15 分钟）');
  att = S.attribInbox({ inboxLock: { token: 'i9', day: today, at: nowMinus(60) } }, 'i9');
  assert(att.mismatch === true, '超过归属期（30 分钟）→ 那次检查已经作废');

  console.log('# 7. 章程里两套流程不互相污染');
  // CHARTER / INBOX_CHARTER 是顶层 const（在 vm 里不挂到全局对象），走它们各自的生成函数拿。
  const charter = sandbox.charterFor({});
  const inboxCharter = sandbox.inboxCharterFor({});
  assert(charter.indexOf('不回复别人的追问') >= 0, '日报轮章程明说这一轮不回复');
  assert(charter.indexOf('budget 的 `reply` 大于 0') < 0, '日报轮章程不再教「budget.reply > 0 时去回」');
  assert(inboxCharter.indexOf('bili_reply') >= 0 && inboxCharter.indexOf('bili_comment') >= 0, '互动轮章程提到 bili_reply 并且明确不许 bili_comment');
  assert(inboxCharter.indexOf('finish') >= 0, '互动轮章程要求收尾');

  console.log('# 8. 互动轮里不许发评论 / 收藏 / 私信（laneOf：按调用方带的 token 判）');
  const liveInbox = { token: 'i1', day: today, at: new Date().toISOString() };
  const liveRound = { token: 'r1', day: today, slot: '360#0', manual: false, at: new Date().toISOString() };
  assert(S.laneOf({ inboxLock: liveInbox }, '', '') === 'inbox', '只有互动检查在跑 → 互动轮只该回复');
  assert(
    S.laneOf({ inboxLock: liveInbox, roundLock: liveRound }, 'r1', '') === 'report',
    '两把锁同时活着时，带对 roundId 的那次调用仍算日报轮（评论该放）'
  );
  assert(
    S.laneOf({ inboxLock: liveInbox, roundLock: liveRound }, '', '') === 'inbox',
    '两把锁同时活着、又不带 token → 按最窄的那条车道（拒）'
  );
  const staleInbox = { token: 'i2', day: today, at: nowMinus(20) };
  assert(
    S.laneOf({ inboxLock: staleInbox }, '', '') === 'inbox',
    '锁过期但仍在归属期（30 分钟）内 → 仍然按互动轮算'
  );
  assert(S.laneOf({ inboxLock: null }, '', '') === 'report', '没有互动检查 → 日报轮');
  assert(S.laneOf({ inboxLock: null }, 'r1', '') === 'inbox', '带了一个对不上的 roundId → 保守地按互动轮算（后面 attribRound 会拒）');

  console.log('# 9. 每个槽位上次开跑的时刻（slotAt）');
  gate = S.gateDay({ gate: { day: '2026-11-16', seg: {}, starts: {}, slotAt: { '360#0': '2026-11-16T08:00:00.000Z' } } }, '2026-11-16');
  assert(gate.slotAt['360#0'] === '2026-11-16T08:00:00.000Z', '同一天原样读出');
  gate = S.gateDay({ gate: { day: '2026-11-15', slotAt: { '360#0': '2026-11-15T08:00:00.000Z' } } }, '2026-11-16');
  assert(Object.keys(gate.slotAt).length === 0, '跨天清空（昨天那次的放行不能算到今天）');

  console.log('# 10. 一次放行只记一次尝试（layout.attempts.next）');
  const day10 = '2026-11-16';
  const now10 = new Date(2026, 10, 16, 9, 0, 0);
  const iso10 = function (ms) { return new Date(ms).toISOString(); };
  const state10 = function (extra) {
    const base = { gate: Object.assign({ day: day10, seg: {}, starts: {}, slotAt: {} }, extra || {}) };
    return base;
  };
  const hookState = function (tries, hookAt, gateExtra) {
    const state = state10(gateExtra);
    state.hookStartsDay = day10;
    state.hookStarts = { '360#0': tries };
    state.hookAt = iso10(hookAt);
    return state;
  };
  const nextOf = async function (state) {
    return (await win(config, state, now10)).attempts.next;
  };

  // 正常路径：脚本已经替这一拍记过（hookStarts=1），插件上次同步还停在 0。
  assert(await nextOf(hookState(1, now10.getTime() - 60000)) === 1, '脚本记过一次 + 插件没认领 → 这次算 1 次（不再 +1）');

  // 中间插了一个会同步的工具：插件把脚本那次收进来了（starts=1），但 slotAt 还没有这个槽位。
  assert(
    await nextOf(hookState(1, now10.getTime() - 60000, { starts: { '360#0': 1 } })) === 1,
    '同步过之后也只算 1 次（以前会算成 2 次）'
  );

  // 同一轮里第二次开跑（不常见，但模型可能重复调）：上一次开跑比放行新 → 加一次。
  assert(
    await nextOf(hookState(1, now10.getTime() - 120000, {
      starts: { '360#0': 1 },
      slotAt: { '360#0': iso10(now10.getTime() - 60000) },
    })) === 2,
    '放行之后又开过一次 → 这一拍再加一次'
  );

  // 没有脚本放行（手动跑任务、或任务没挂 hook）：插件自己记。
  assert(await nextOf(state10()) === 1, '没有脚本放行 → 插件自己 +1');

  // 放行是很久以前的事（超出时效）：不能当成这一拍。
  assert(
    await nextOf(hookState(1, now10.getTime() - 3 * 60 * 60 * 1000)) === 2,
    '陈旧的放行记录不再顶替这一拍'
  );

  // 昨天的放行记录完全不算数。
  const yesterday = hookState(9, now10.getTime() - 60000);
  yesterday.hookStartsDay = '2026-11-15';
  assert(await nextOf(yesterday) === 1, '昨天的 hookDay 不参与今天的尝试计数');

  console.log('# 11. 脚本刚放行的那一次不算「已经用过」（attempts.before / inbox.checksUsed）');
  // 已经试过 2 次，脚本又给这一拍放行了第 3 次：这一拍必须能跑，不能被自己判成试满。
  const beforeOf = async function (state) {
    return (await win(config, state, now10)).attempts.before;
  };
  assert(
    await beforeOf(hookState(3, now10.getTime() - 60000, { starts: { '360#0': 2 } })) === 2,
    '脚本已把这一拍记进 hookStarts 时，「之前试过几次」是 2（含它会是 3）'
  );
  assert(
    await beforeOf(hookState(3, now10.getTime() - 60000, { starts: { '360#0': 3 } })) === 2,
    '同步把 hookStarts 收进 starts 之后同样是 2（不会变成 3 → 误判试满）'
  );
  assert(
    await beforeOf(hookState(3, now10.getTime() - 60 * 60 * 1000, { starts: { '360#0': 3 } })) === 3,
    '陈旧的放行不能抵扣 → 真的试满 3 次'
  );

  // 互动轮同理：checksPerDay=20、脚本已把第 20 次放行记进去时，这一次仍然放行。
  const inboxState = {
    inbox: { day: today, checks: 19, lastAt: '' },
    inboxHookDay: today,
    inboxHookTries: 20,
    inboxHookAt: nowMinus(1),
  };
  limits = await inboxOf(inboxCfg, inboxState);
  assert(limits.checksUsed === 19 && limits.checksLeft === 1, '等认领的那一次暂时不算 → 还剩 1 次（最后这次能跑）');
  assert(limits.checksRaw === 20 && limits.checksPending === true, '账本里仍是 20，暂停计入的标记为 true');
  limits = await inboxOf(inboxCfg, Object.assign({}, inboxState, { inboxHookAt: '' }));
  assert(limits.checksUsed === 20 && limits.checksLeft === 0, '没有放行时刻可判 → 按已用 20 算（保守的一侧）');

  console.log('# 12. 反回归：判定只有一份（main.js 里不许再出现第二个定义）');
  // 这 14 个名字在 1.4.0 的 main.js 和 gate.mjs 里各有一份；1.5.0 收成 decide.cjs 一份。
  // 任何人把它们再抄回 main.js，下面第一条就会失败。
  const JUDGEMENT = [
    'parseClock', 'normalizeSegments', 'segmentKey', 'segmentLabel', 'segmentAt', 'segmentTotal',
    'segmentState', 'attemptsBefore', 'slotAttempts', 'allowanceUnclaimed',
    'inboxChecksUsed', 'inboxLastCheckAt', 'inboxAllowanceUnclaimed', 'inboxLimits',
  ];
  const defines = function (source, name) {
    return new RegExp('(^|\\n)\\s*(?:async\\s+)?function\\s+' + name + '\\s*\\(').test(source);
  };
  const definedHere = JUDGEMENT.filter(function (name) { return defines(code, name); });
  assert(definedHere.length === 0, 'main.js 里这 14 个判定函数一个都没有定义' + (definedHere.length ? '（还有：' + definedHere.join(', ') + '）' : ''));

  // 名字出现在注释里没关系（说明「规则在哪」），但不能再被调用。
  const calledHere = code.split('\n').filter(function (line) {
    const isComment = /^\s*(\*|\/\/|\/\*)/.test(line);
    return !isComment && JUDGEMENT.some(function (name) {
      return new RegExp('\\b' + name + '\\s*\\(').test(line);
    });
  });
  assert(calledHere.length === 0, 'main.js 里这些名字一次都没有被调用（只在注释里提到）');

  const coreNames = ['parseClock', 'normalizeSegments', 'segmentLabel', 'segmentAt'];
  assert(coreNames.every(function (name) { return defines(decideCode, name); }),
    '这四个核心函数（解析 / 洗表 / 标签 / 落在哪段）只在 schedule/decide.cjs 里有定义');

  // 接线也要真的走 worker：换掉判定就会换掉插件的结论。
  assert(countWorker('duty/layout') > 0, '插件的窗口 / 尝试次数 / 互动额度是问 worker 的（duty/layout）');

  const gateCfg = await S.gateConfigFor({
    segments: [{ start: '06:00', end: '10:00', rounds: 99 }],
    perDay: 5,
    replyToComments: true,
    inboxChecksPerDay: 2,
    inboxMinGapMin: 15,
  }, 'test');
  assert(gateCfg.segments.length === 1 && gateCfg.segments[0].rounds === 6
    && Object.keys(gateCfg.segments[0]).sort().join(',') === 'end,rounds,start',
  '写镜像之前先经 duty/segments 洗完（99 → 6，只留三个原始字段）');
  assert(gateCfg.autoRoundsPerDay === 6, '旧版闸门脚本读的 autoRoundsPerDay = 洗完各段之和');

  const mirrorState = S.mirrorState(
    {
      gate: { day: today, seg: { 360: 1 }, starts: { '360#0': 2 }, slotAt: { '360#0': new Date().toISOString() } },
      hookStartsDay: today,
      hookStarts: { '360#0': 2 },
      hookAt: new Date().toISOString(),
      inbox: { day: today, checks: 1, lastAt: '' },
    },
    S.gateDay({ gate: { day: today, seg: { 360: 1 } } }, today),
    today
  );
  assert(
    ['seg', 'starts', 'slotAt', 'maxTries', 'hookStarts', 'hookDay', 'hookAt', 'inboxChecks', 'inboxLastAt', 'inboxLock']
      .every(function (key) { return key in mirrorState; }),
    '插件喂给判定的记账和闸门镜像同一个形状（少了哪一项，两边就会给出不同结论）'
  );

  const segmentsCalls = countWorker('duty/segments');
  await S.segmentsInfo(config, 'test');
  await S.segmentsInfo(config, 'test');
  assert(countWorker('duty/segments') - segmentsCalls <= 1, '同样的设置只问一次 worker（段表缓存，同步镜像是热路径）');

  // 插件显示的「还能开」和闸门的结论必须是同一份数：这一槽试满 3 次时两边都说停。
  const fullCfg = { segments: [{ start: '00:00', end: '24:00', rounds: 2 }], perDay: 5, maxTries: 3 };
  const fullState = { gate: { day: today, seg: {}, starts: { '0#0': 3 }, slotAt: {} } };
  const fullLayout = await win(fullCfg, fullState, new Date());
  const fullMirror = S.buildMirror(
    { autoRoundsPerDay: 2 },
    { gate: { day: today, seg: {}, starts: { '0#0': 3 }, slotAt: {} } },
    { used: 0, autoUsed: 0 },
    new Date(),
    { loggedIn: true }
  );
  const fullDecision = decideLib.decide(fullCfg, fullMirror, new Date(), { claim: true });
  assert(fullDecision.report.reason === 'tries_exhausted' && fullLayout.attempts.before >= fullLayout.maxTries,
    'layout 与 decide 读同一份尝试次数（插件说还能开、闸门说试满，就是又分叉了）');

  console.log('# 13. 反回归：锁的时长只许一个数（main.js 与 decide.cjs 不许漂移）');
  // 「这一轮多久之后就算死了」是判定规则，但它仍是两份常量：main.js 判「这次调用算不算它头上」
  // 必须同步跑（每个工具调用都要过），改成问 worker 就得把这些路径全变成 await。
  // 既然搬不动，就让测试盯着两边相等——谁改一处忘了另一处，这里直接红，不靠人记得。
  const TTL_PAIRS = [
    { main: 'ROUND_LOCK_TTL_MS', decide: 'LOCK_TTL_MS', what: '刷视频轮的锁' },
    { main: 'INBOX_LOCK_TTL_MS', decide: 'INBOX_LOCK_TTL_MS', what: '互动轮的锁' },
  ];
  const readConstMs = function (source, name, file) {
    // 只认「const NAME = <纯数字表达式>;」，别的写法（引用另一个常量、调函数）说明这条断言
    // 已经跟不上代码了，要当场报出来而不是静默跳过。
    const match = new RegExp('\\bconst\\s+' + name + '\\s*=\\s*([^;\\n]+);').exec(source);
    assert(match, '在 ' + file + ' 里找得到常量 ' + name);
    const expr = match[1].trim();
    assert(/^[0-9\s*+\-().]+$/.test(expr),
      file + ' 的 ' + name + ' 是纯数字表达式（' + expr + '）——不是的话，这条断言要改成顺着赋值去读');
    return vm.runInNewContext(expr);
  };
  TTL_PAIRS.forEach(function (pair) {
    const inMain = readConstMs(code, pair.main, 'main.js');
    const inDecide = readConstMs(decideCode, pair.decide, 'schedule/decide.cjs');
    assert(inMain === inDecide,
      pair.what + '在两边是同一个数（main.js ' + pair.main + '=' + inMain + 'ms，decide.cjs '
        + pair.decide + '=' + inDecide + 'ms）');
  });

  console.log('# 14. 私信日上限（dmPerDay）的读入边界：0 / 1 / 5 / 缺字段 / 非整数');
  // 默认值本身就是兼容承诺：1.5.0 写死的是 2，旧 /kv 里没有这个键时必须还是 2，
  // 不能因为「没配过」就变成 0（那等于升级当天悄悄关掉了已经在用的私信投递）。
  const dm = function (value) {
    const stored = {};
    if (value !== undefined) stored.dmPerDay = value;
    return S.normalizeConfig(stored).dmPerDay;
  };
  assert(dm(undefined) === 2, '旧配置里没有 dmPerDay → 默认 2（升级当天行为不变）');
  assert(dm(0) === 0, 'dmPerDay=0 原样保留（= 一条私信都不发）');
  assert(dm(1) === 1, 'dmPerDay=1 原样保留');
  assert(dm(5) === 5, 'dmPerDay=5 原样保留（上限）');
  assert(dm(6) === 5 && dm(-3) === 0, '整数越界按范围钳：6 → 5、-3 → 0');
  assert(dm(2.5) === 2 && dm('abc') === 2 && dm(null) === 2, '非整数 / NaN / null → 退回默认 2');
  assert(dm('3') === 3, '字符串数字照样认（设置页和 /kv 都可能给字符串）');

  console.log('\nALL PASS (' + passed + ' checks)');
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
