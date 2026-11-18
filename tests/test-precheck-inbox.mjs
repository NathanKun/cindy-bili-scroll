#!/usr/bin/env node

/**
 * 弃用的互动闸门（schedule/precheck-inbox.mjs）在 1.5.0 里的行为。
 *
 * 1.5.0 把两条任务合并成一条：只有一个判定（schedule/decide.cjs）、一个闸门脚本
 * （precheck.mjs）。precheck-inbox.mjs 保留一个版本周期，只是原样转调新闸门 ——
 * 这样 1.4.0 留下的那条互动任务的 hook 不会突然「脚本不存在」而每拍失败。
 *
 * 这份测试验三件事：
 *   1. 它和新闸门**逐字一致**（同一个 home、同一个 --now，退出码与 stdout 相同）；
 *   2. 互动那条车道本身还判得对（次数 / 间隔 / 锁 / 跨天）；
 *   3. 它现在**也会为日报轮放行**（弃用脚本没有第二条车道了）——这正是
 *      「升级后必须删掉旧那条任务」的原因，留个测试把这件事说清楚。
 *
 *   node tests/test-precheck-inbox.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const shim = path.resolve(import.meta.dirname, '..', 'schedule', 'precheck-inbox.mjs');
const gate = path.resolve(import.meta.dirname, '..', 'schedule', 'precheck.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-inbox-test-'));

let passed = 0;

function assert(condition, label) {
  if (!condition) throw new Error('ASSERT FAILED: ' + label);
  passed += 1;
  console.log('  ✓ ' + label);
}

function setup(config, state) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
  if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state), 'utf8');
  return dir;
}

function runScript(script, dir, now) {
  try {
    const stdout = execFileSync(process.execPath, [script, '--home', dir, '--now', now], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout.trim() };
  } catch (error) {
    return { code: error.status, out: String(error.stdout || '').trim() };
  }
}

function run(dir, now) {
  return runScript(shim, dir, now);
}

function readState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch (_e) { return {}; }
}

const today = '2026-11-16';
// 半天一段、跑满一轮：日报轮这一拍没活，只剩互动车道能放行 —— 这样测的就是互动那条线。
const config = {
  replyToComments: true,
  inboxChecksPerDay: 20,
  inboxMinGapMin: 15,
  perDay: 5,
  segments: [{ start: '00:00', end: '24:00', rounds: 1 }],
};
const reportDone = { day: today, pickedAuto: 0, seg: { 0: 1 }, starts: {}, loggedIn: true, inboxChecks: 0, inboxLastAt: '' };

console.log('# 1. 还没同步过 → 放行一次，且放行本身有上限');
let dir = setup(null, null);
assert(run(dir, today + 'T09:00:00').code === 0, '没有 config/state 时 exit 0（第 1 次）');
assert(run(dir, today + 'T09:05:00').code === 0, '第 2 次');
assert(run(dir, today + 'T09:10:00').code === 0, '第 3 次');
const bootOut = run(dir, today + 'T09:15:00');
assert(bootOut.code === 2 && /试了 3 次/.test(bootOut.out), '第 4 次跳过');
assert(readState(dir).hookStarts.boot === 3, '计数落在 hookStarts.boot 上（两个闸门合成一个，不再有 bootInbox）');

console.log('# 2. 互动车道放行：记一次检查，不动日报轮的尝试计数');
dir = setup(config, reportDone);
const first = run(dir, today + 'T09:00:00');
assert(first.code === 0 && /互动轮：今天的第 1\/20 次检查/.test(first.out), '放行，报第 1/20 次检查');
const afterFirst = readState(dir);
assert(afterFirst.inboxHookTries === 1, '放行次数记进 inboxHookTries');
assert(afterFirst.inboxHookDay === today, '同时记下是哪一天');
assert(!afterFirst.hookStarts || afterFirst.hookStarts['0#0'] === undefined, '没有把互动那次记到日报轮的槽位上');

console.log('# 3. 两条车道都没活 → 跳过，并把两边的原因都说清');
dir = setup(Object.assign({}, config, { replyToComments: false }), reportDone);
const none = run(dir, today + 'T09:00:00');
assert(none.code === 2, '互动关着 + 日报这一段跑满 → 跳过');
assert(/已经跑成 1\/1 轮/.test(none.out), '说了日报轮为什么没活');
dir = setup(config, Object.assign({}, reportDone, { inboxChecks: 20 }));
const used = run(dir, today + 'T09:00:00');
assert(used.code === 2 && /用满 20\/20 次/.test(used.out), '说了互动轮为什么没活');

console.log('# 4. 互动次数：插件记的与脚本记的取较大值');
dir = setup(config, Object.assign({}, reportDone, { inboxChecks: 20 }));
assert(run(dir, today + 'T09:00:00').code === 2, '插件记的 20/20 → 跳过');
dir = setup(config, Object.assign({}, reportDone, { inboxHookTries: 20, inboxHookDay: today }));
assert(run(dir, today + 'T09:00:00').code === 2, '脚本记的 20/20 → 跳过');
dir = setup(config, Object.assign({}, reportDone, { inboxChecks: 19 }));
assert(run(dir, today + 'T09:00:00').code === 0, '19/20 → 还放行，且下一次是 20');

console.log('# 5. 最小间隔');
const realNow = new Date();
const realToday = realNow.getFullYear() + '-' + String(realNow.getMonth() + 1).padStart(2, '0')
  + '-' + String(realNow.getDate()).padStart(2, '0');
const realReportDone = Object.assign({}, reportDone, { day: realToday });
const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
dir = setup(config, Object.assign({}, realReportDone, { inboxLastAt: fiveMinAgo }));
assert(run(dir, realNow.toISOString()).code === 2, '5 分钟前检查过（间隔 15）→ 跳过');
dir = setup(config, Object.assign({}, realReportDone, { inboxLastAt: twentyMinAgo }));
assert(run(dir, realNow.toISOString()).code === 0, '20 分钟前检查过 → 放行');
dir = setup(config, Object.assign({}, realReportDone, { inboxHookAt: fiveMinAgo, inboxHookDay: realToday }));
assert(run(dir, realNow.toISOString()).code === 2, '脚本自己记的上一次放行也算间隔');
dir = setup(Object.assign({}, config, { inboxMinGapMin: 0 }), Object.assign({}, reportDone, { inboxLastAt: fiveMinAgo }));
assert(run(dir, new Date().toISOString()).code === 0, '间隔设成 0 → 不挡');

console.log('# 6. 已经有一次检查在跑 → 跳过；过期不再挡');
dir = setup(config, Object.assign({}, reportDone, {
  inboxLock: { at: new Date(Date.now() - 60 * 1000).toISOString(), manual: false },
}));
assert(run(dir, new Date().toISOString()).code === 2, '1 分钟前的锁 → 跳过');
dir = setup(config, Object.assign({}, reportDone, {
  inboxLock: { at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), manual: false },
}));
assert(run(dir, new Date().toISOString()).code === 2, '10 分钟前的锁仍在 15 分钟窗口内 → 跳过');
dir = setup(config, Object.assign({}, reportDone, {
  inboxLock: { at: new Date(Date.now() - 20 * 60 * 1000).toISOString(), manual: false },
}));
assert(run(dir, new Date().toISOString()).code === 0, '20 分钟前的锁（已过期）→ 放行');

console.log('# 7. 跨天：昨天的检查次数不该挡今天');
// 12:00 不在 06:00–10:00 这一段里：日报轮被时段挡住，这一拍只剩互动车道，
// 才能看清「昨天用满的检查次数会不会带过来」。否则新的一天日报通道也是空的，
// 单车道会先放日报（优先级在那边，是对的）。
const noonConfig = Object.assign({}, config, { segments: [{ start: '06:00', end: '10:00', rounds: 1 }] });
dir = setup(noonConfig, {
  day: '2026-11-15',
  pickedAuto: 0,
  seg: { 0: 1 },
  starts: {},
  loggedIn: true,
  inboxChecks: 20,
  // 用「当天 11:00」而不是「一小时前」：下面把时钟拨到 12:00，用真实的一小时前
  // 会在晚上跑测试时落到未来（现在是 19:17，一小时前是 18:17 > 12:00），
  // 于是被「最小间隔」挡住——那是测试的时区坑，不是插件的问题。
  inboxLastAt: new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate(), 11, 0, 0).toISOString(),
  inboxHookTries: 20,
  inboxHookDay: '2026-11-15',
  inboxHookAt: new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate(), 11, 0, 0).toISOString(),
});
const noon = new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate(), 12, 0, 0).toISOString();
const cross = run(dir, noon);
assert(cross.code === 0 && /互动轮/.test(cross.out), '昨天用满也放行今天（这一拍是互动车道）');
assert(readState(dir).inboxHookTries === 1, '新的一天从 1 开始');

console.log('# 8. 跳过时会留下原因（给人看）');
dir = setup(Object.assign({}, config, { replyToComments: false }), reportDone);
run(dir, today + 'T09:00:00');
assert(/已经跑成 1\/1 轮/.test(readState(dir).lastSkip.reason), 'lastSkip 写清了原因');

console.log('# 9. 弃用脚本 = 新闸门：同一份输入，退出码与输出逐字一致');
const cases = [
  ['两条车道都没活', Object.assign({}, config, { replyToComments: false }), reportDone],
  ['互动车道放行', config, reportDone],
  ['日报车道放行', config, Object.assign({}, reportDone, { seg: {} })],
  ['有一轮在跑', config, Object.assign({}, reportDone, { seg: {}, lock: { at: today + 'T08:55:00Z' } })],
];

for (const [name, cfg, st] of cases) {
  const a = runScript(gate, setup(cfg, st), today + 'T09:00:00');
  const b = runScript(shim, setup(cfg, st), today + 'T09:00:00');
  assert(a.code === b.code && a.out === b.out, name + '：两个脚本结论一致（exit ' + a.code + '）');
}

console.log('# 10. 弃用脚本现在也会放行日报轮（所以旧任务必须删掉）');
dir = setup(config, Object.assign({}, reportDone, { seg: {} }));
const both = run(dir, today + 'T09:00:00');
assert(both.code === 0, '日报轮有活时，旧互动任务的 hook 也会放行');
assert(/日报轮/.test(both.out), '输出明说了这是日报轮（模型会按 bili_round 的 mode 走，不会跑错）');

fs.rmSync(root, { recursive: true, force: true });
console.log('\nALL PASS (' + passed + ' checks)');
