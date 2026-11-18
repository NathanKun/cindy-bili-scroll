'use strict';

/**
 * `schedule/decide.cjs` —— 1.5.0 的「这一拍做什么」，也是**唯一一份**判定。
 *
 * 闸门脚本、Node 工作进程、插件（经工作进程）三处都调它。这份测试盯三类事：
 *   1. 分派本身对不对（日报轮优先、日报满了转互动、都没活给 none、锁互斥）；
 *   2. `layout` / `attemptsOf` / `inboxLimitsOf` 这些「插件要的解释」和 `decide`
 *      的结论是不是同一套数（插件显示「还能跑」而 decide 说不能，就是又分叉了）；
 *   3. 段表的两种形态（给判断的分钟数 / 给存储和展示的 HH:MM + key + label）
 *      出自同一次清洗，不是两张表。
 *
 * main.js 里还有没有第二个定义，由 test-main-gate.cjs 的 §12 反回归盯着。
 *
 *   node tests/test-decide.cjs
 */

const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
  decide,
  layout,
  segmentTable,
  normalizeSegments,
  parseClock,
} = require(path.join(root, 'schedule', 'decide.cjs'));

let passed = 0;
function assert(condition, label) {
  if (!condition) throw new Error('ASSERT FAILED: ' + label);
  passed += 1;
  console.log('  ✓ ' + label);
}

const DAY = '2026-11-17';
/** 本机时区的某天某时（decide 用的是本地时间）。 */
function at(hour, minute, day) {
  const [y, m, d] = String(day || DAY).split('-').map(Number);
  return new Date(y, m - 1, d, hour || 0, minute || 0, 0);
}

const segments = [
  { start: '06:00', end: '10:00', rounds: 1 },
  { start: '18:00', end: '24:00', rounds: 1 },
];
const baseConfig = {
  perDay: 5,
  segments,
  replyToComments: true,
  inboxChecksPerDay: 3,
  inboxMinGapMin: 15,
};
const baseState = {
  day: DAY,
  pickedAuto: 0,
  seg: {},
  starts: {},
  maxTries: 3,
  lock: null,
  inboxChecks: 0,
  inboxLastAt: '',
  inboxLock: null,
  loggedIn: true,
};

const S = (patch) => Object.assign({}, baseState, patch || {});
const C = (patch) => Object.assign({}, baseConfig, patch || {});

console.log('# 1. 日报轮优先');
let d = decide(C(), S(), at(8, 0));
assert(d.mode === 'report' && d.reason === 'report_ready', '两条车道都有活 → 先跑日报轮');
assert(d.slot === '360#0', '槽位 = 段键#段内第几轮');
assert(d.segment && d.segment.label === '06:00–10:00 ×1', '带出当前段（含标签）');
assert(d.quota && d.quota.kind === 'report' && d.quota.runs === 0 && d.quota.rounds === 1, 'quota 是日报轮这一份');

console.log('# 2. 日报这一段跑满 → 转互动轮（额度不互相吃）');
d = decide(C(), S({ seg: { 360: 1 } }), at(8, 30));
assert(d.report.reason === 'segment_done', '日报轮的理由是 segment_done');
assert(d.mode === 'inbox' && d.reason === 'inbox_ready', '同一拍转去做互动检查');
assert(d.quota.kind === 'inbox' && d.quota.checksPerDay === 3, 'quota 换成互动那一份');
d = decide(C(), S({ seg: { 360: 1 } }), at(19, 0));
assert(d.mode === 'report' && d.slot === '1080#0', '晚段自己还有额度（早段跑满不牵连）');

console.log('# 3. 两条车道都没活 → none，并分别给出原因');
d = decide(C({ replyToComments: false }), S({ seg: { 360: 1 } }), at(8, 0));
assert(d.mode === 'none' && d.reason === 'segment_done', 'mode=none，reason 取日报轮那条');
assert(d.inbox.reason === 'inbox_disabled', '互动轮单独说明「没开」');
d = decide(C({ segments: [{ start: '06:00', end: '10:00', rounds: 1 }], replyToComments: false }), S(), at(12, 0));
assert(d.mode === 'none' && d.reason === 'outside_segments', '不在任何时段内（互动关着 → 真的没活）');
// 时段只管日报轮：互动轮有自己的一套次数，12:00 照样可以检查回复。
d = decide(C({ segments: [{ start: '06:00', end: '10:00', rounds: 1 }] }), S(), at(12, 0));
assert(d.mode === 'inbox', '不在刷B站时段内 ≠ 不能做互动轮');

console.log('# 4. 锁互斥（单车道）：一件事在跑，另一条车道也得等');
d = decide(C(), S({ lock: { at: at(8, 0).toISOString(), slot: '360#0' } }), at(8, 1));
assert(d.mode === 'none' && d.report.reason === 'busy', '日报轮在跑 → 都不动');
assert(d.inbox.reason === 'report_running', '互动轮的理由是「日报轮在跑」');
d = decide(C(), S({ inboxLock: { at: at(8, 0).toISOString() } }), at(8, 1));
assert(d.mode === 'none' && d.report.reason === 'inbox_running', '互动检查在跑 → 连日报轮也不开');
d = decide(C(), S({ lock: { at: at(7, 0).toISOString() } }), at(8, 0));
assert(d.mode === 'report', '过了 12 分钟的日报锁不再挡');
d = decide(C(), S({ inboxLock: { at: at(7, 50).toISOString() } }), at(8, 0));
assert(d.mode === 'none' && d.report.reason === 'inbox_running', '10 分钟前的互动锁仍算在跑（锁 15 分钟）');
d = decide(C(), S({ inboxLock: { at: at(7, 40).toISOString() } }), at(8, 0));
assert(d.mode === 'report', '过了 15 分钟的互动锁不再挡（归属期仍是 30 分钟，由 main.js 的 laneOf 管）');

console.log('# 5. 没登录 / 没有镜像');
d = decide(C(), S({ loggedIn: false }), at(8, 0));
assert(d.mode === 'none' && d.reason === 'not_logged_in' && d.inbox.reason === 'not_logged_in', '没登录：两条车道都停');
d = decide(null, S(), at(8, 0));
assert(d.mode === 'none' && d.reason === 'no_mirror', '没有设置 → no_mirror');
d = decide(C(), null, at(8, 0));
assert(d.mode === 'none' && d.reason === 'no_mirror', '没有记账 → no_mirror');

console.log('# 6. 每日条数 / 尝试次数');
d = decide(C({ perDay: 2 }), S({ pickedAuto: 2 }), at(8, 0));
assert(d.report.reason === 'quota_exhausted' && d.mode === 'inbox', '挑满每日额度 → 转互动检查');
d = decide(C({ perDay: 0 }), S({ pickedAuto: 999 }), at(8, 0));
assert(d.mode === 'report', 'perDay=0 是「不限流」，不是「一条都不许」');
d = decide(C(), S({ starts: { '360#0': 3 } }), at(8, 0));
assert(d.report.reason === 'tries_exhausted' && d.mode === 'inbox', '这一槽试满 3 次 → 转互动检查');
d = decide(C(), S({ starts: { '360#0': 2 } }), at(8, 0));
assert(d.mode === 'report' && d.report.tries === 2, '试了 2 次还剩最后一次');

console.log('# 7. 互动车道自己的账');
d = decide(C(), S({ seg: { 360: 1 }, inboxChecks: 3 }), at(8, 0));
assert(d.mode === 'none' && d.inbox.reason === 'inbox_checks_exhausted', '检查次数用满 → none');
d = decide(C(), S({ seg: { 360: 1 }, inboxHookTries: 3, inboxHookDay: DAY }), at(8, 0));
assert(d.inbox.reason === 'inbox_checks_exhausted', '脚本记的放行次数同样算（取较大值）');
d = decide(C(), S({ seg: { 360: 1 }, inboxHookTries: 3, inboxHookDay: '2026-11-16' }), at(8, 0));
assert(d.mode === 'inbox', '昨天脚本记的次数不算今天');
d = decide(C(), S({ seg: { 360: 1 }, inboxChecks: 1, inboxLastAt: at(8, 0).toISOString() }), at(8, 5));
assert(d.inbox.reason === 'inbox_too_soon' && d.inbox.gapLeftMs > 0, '离上次不到 15 分钟 → too soon');
d = decide(C(), S({ seg: { 360: 1 }, inboxChecks: 1, inboxLastAt: at(7, 0).toISOString() }), at(8, 0));
assert(d.mode === 'inbox', '过了最小间隔 → 放行');
d = decide(C({ inboxMinGapMin: 0 }), S({ seg: { 360: 1 }, inboxLastAt: at(8, 0).toISOString() }), at(8, 0));
assert(d.mode === 'inbox', '间隔设 0 → 不挡');

console.log('# 8. 跨天：昨天的账不带进今天');
d = decide(C(), S({ day: '2026-11-16', seg: { 360: 1 }, pickedAuto: 5, inboxChecks: 3 }), at(8, 0));
assert(d.mode === 'report' && d.report.runs === 0 && d.report.pickedAuto === 0, '昨天跑满 / 挑满都不挡今天');
assert(d.inbox.checksUsed === 0, '昨天的检查次数也不算');

console.log('# 9. 升级前的老镜像照样读得懂');
d = decide(C({ segments: undefined, autoRoundsPerDay: 2 }), S({ seg: undefined, runs: 1 }), at(8, 0));
assert(d.mode === 'report' && d.slot === '0#1', '只有 runs / autoRoundsPerDay → 整天段 ×2 的第 2 轮');
d = decide(C({ segments: undefined, autoRoundsPerDay: 2 }), S({ seg: undefined, runs: 3 }), at(8, 0));
assert(d.mode === 'inbox', '老镜像说今天跑成了 3 轮（整天段 ×2）→ 日报轮让位');
// 混合镜像（新段表 + 老 runs）：老账只算在整天段上，跟 main.js 的 gateDay 一样，
// 不能算到 06:00–10:00 这一段头上，否则两边对同一份镜像给出不同结论。
d = decide(C(), S({ seg: undefined, runs: 3 }), at(8, 0));
assert(d.mode === 'report' && d.report.runs === 0, '混合镜像：老 runs 不挡 06:00 那一段');
d = decide(C({ segments: undefined, autoRoundsPerDay: 1 }), S({ seg: undefined, windows: { all: true } }), at(8, 0));
assert(d.mode === 'inbox', '1.2.x 的 windows.all=true 也算跑满');

console.log('# 10. 段表的两种形态出自同一次清洗（判断用分钟数 / 存储展示用 HH:MM + key + label）');
const cases = [
  null,
  [],
  [{ start: '06:00', end: '10:00', rounds: 1 }],
  [{ start: '18:00', end: '24:00', rounds: 1 }, { start: '06:00', end: '10:00', rounds: 2 }],
  [{ start: '06:00', end: '10:00', rounds: 1 }, { start: '09:00', end: '12:00', rounds: 1 }],
  [{ start: '22:00', end: '02:00', rounds: 1 }],
  [{ start: '06:00', end: '10:00' }],
  [{ start: '06:00', end: '10:00', rounds: 0 }],
  [{ start: '06:00', end: '10:00', rounds: 99 }],
  [{ start: '06:00', end: '06:00', rounds: 1 }],
  [{ start: 'aa:bb', end: '10:00', rounds: 1 }],
];
for (const input of cases) {
  const numeric = normalizeSegments(input, 1);
  const table = segmentTable(input, 1);
  // 两种形态必须逐段描述同一张表：起点/终点/轮次一致，key 就是起点分钟数，
  // label 就是那段 `HH:MM–HH:MM ×N` 的展示形态。
  const shapeNumeric = numeric.map((seg) => [seg.start, seg.end, seg.rounds].join('|')).join(',');
  const shapeTable = table.map((seg) => [
    parseClock(seg.start), parseClock(seg.end), seg.rounds,
  ].join('|')).join(',');
  const keysOk = table.every((seg, i) => seg.key === String(numeric[i].start));
  const labelsOk = table.every((seg) => seg.label === seg.start + '–' + seg.end + ' ×' + seg.rounds);
  assert(shapeNumeric === shapeTable && keysOk && labelsOk,
    '一致：' + JSON.stringify(input) + ' → ' + shapeNumeric);
}

console.log('# 11. 同一个输入永远同一个结论（纯函数）');
const first = decide(C(), S({ seg: { 360: 1 } }), at(8, 0));
const second = decide(C(), S({ seg: { 360: 1 } }), at(8, 0));
assert(JSON.stringify(first) === JSON.stringify(second), '两次调用结果逐字相同');
assert(Object.keys(first).sort().join(',') === 'at,day,inbox,mode,quota,reason,report,segment,slot', '返回的就是 mode/reason/segment/quota 这一套');

console.log('# 12. 闸门刚放行的那一拍，插件不会被自己的章挡掉（1.5.0–1.6.0 的线上 bug）');
// 现场：21:45 的 cron 里闸门输出 `run: 互动轮…`、写回 inboxHookAt=21:15，模型被叫醒后
// 插件立刻回「离上次互动检查还不到 30 分钟」。根因是 minGap 用了 max(inboxLastAt, inboxHookAt)
// ——闸门自己刚盖的章被读成「上一次检查」，于是每一个被放行的拍子都自我作废，state.inbox
// 一直是 null，别人回的评论一次都没被处理过。
// 闸门刚放行、这一次还没被认领：hookTries=1，插件账上是 0 次、从没查过。
const gateJustAllowed = S({
  seg: { 360: 1 },
  inboxChecks: 0,
  inboxLastAt: '',
  inboxHookTries: 1,
  inboxHookDay: DAY,
  inboxHookAt: at(8, 0).toISOString(),
});
d = decide(C(), gateJustAllowed, at(8, 1), { claim: true });
assert(d.mode === 'inbox' && d.inbox.reason === 'ready', '① 闸门刚放行 → 插件问（claim:true）是 ready（回归测试）');
assert(d.inbox.gapLeftMs === 0, '① 那一次的章不算「上一次检查」→ gapLeftMs=0，不是 14 分钟');
assert(d.inbox.checksUsed === 0, '① 待认领的那一次额度上已经暂扣，显示今天用了 0 次');

d = decide(C(), gateJustAllowed, at(8, 1), { claim: false });
assert(d.inbox.ok === false && d.inbox.reason === 'inbox_too_soon', '② 同一份状态，闸门问（claim:false）仍然不放行');
assert(d.inbox.gapLeftMs === 14 * 60000, '② 闸门按自己的章算间隔：还要等 14 分钟（不会每 15 分钟放行一次）');

// 真正查过一次：插件账上有 lastAt，脚本记的次数不大于它 → 那一次已经认领了，正常按间隔判。
d = decide(C(), S({
  seg: { 360: 1 },
  inboxChecks: 1,
  inboxLastAt: at(8, 0).toISOString(),
  inboxHookTries: 1,
  inboxHookDay: DAY,
  inboxHookAt: at(8, 0).toISOString(),
}), at(8, 5), { claim: true });
assert(d.inbox.reason === 'inbox_too_soon' && d.inbox.gapLeftMs === 10 * 60000, '③ 已认领的检查仍受最小间隔约束（还差 10 分钟）');

// 从没查过、也从没放行：第一次不被挡（这条以前就对，钉住它别被上面的开关带歪）。
d = decide(C(), S({ seg: { 360: 1 } }), at(8, 0), { claim: true });
assert(d.mode === 'inbox' && d.inbox.reason === 'ready' && d.inbox.gapLeftMs === 0, '④ 从没查过 → 第一次放行');

// 放了行但已经过 ALLOWANCE_WINDOW_MS（30 分钟）还没被认领：那个模型早该跑完了，
// 这一次不再当成「待认领」，额度上照算用过一次（宁可少给，不能凭空多给）。
d = decide(C(), S({
  seg: { 360: 1 },
  inboxChecks: 0,
  inboxLastAt: '',
  inboxHookTries: 1,
  inboxHookDay: DAY,
  inboxHookAt: at(7, 0).toISOString(),
}), at(8, 0), { claim: true });
assert(d.inbox.checksUsed === 1, '⑤ 陈放行（60 分钟前）不再当成待认领 → 额度上算用了 1 次');
assert(d.inbox.reason === 'ready' && d.inbox.gapLeftMs === 0, '⑤ 陈章在很久以前，不挡这一拍');

// layout 是插件「我要给人看的数」，口径必须跟 claim:true 一致。
const layFresh = layout(C(), gateJustAllowed, at(8, 1));
assert(layFresh.inbox.lastAt === 0, '⑥ 刚放行后 layout.inbox.lastAt 是 0，不是闸门的章');
assert(layFresh.inbox.lastAt !== Date.parse(gateJustAllowed.inboxHookAt), '⑥ 明确：不得显示「0 分钟前刚查过」');
const layDone = layout(C(), S({ seg: { 360: 1 }, inboxChecks: 1, inboxLastAt: at(8, 0).toISOString() }), at(8, 5));
assert(layDone.inbox.lastAt === at(8, 0).getTime(), '⑥ 真查过一次时 lastAt 照常取那次检查的时刻');

console.log('\nALL PASS (' + passed + ' checks)');
