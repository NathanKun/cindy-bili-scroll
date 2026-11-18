#!/usr/bin/env node

/**
 * 时段配额闸门的场景测试（schedule/precheck.mjs）。
 * 用 --home / --now 两个调试开关在临时目录里跑真实子进程，不碰 ~/bili-duty。
 *
 *   node tests/test-precheck.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '..', 'schedule', 'precheck.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-duty-test-'));

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

function run(dir, now) {
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

function readState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch (_e) { return {}; }
}

function writeState(dir, patch) {
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(Object.assign(readState(dir), patch)), 'utf8');
}

const SEGMENTS = [
  { start: '06:00', end: '10:00', rounds: 1 },
  { start: '18:00', end: '24:00', rounds: 1 },
];
const baseConfig = { segments: SEGMENTS, perDay: 5 };
const baseState = { day: '2026-11-16', pickedAuto: 0, seg: {}, starts: {}, loggedIn: true, maxTries: 3 };

console.log('# 1. 还没同步过 → 放行一次（让插件把值班文件写出来）');
let dir = setup(null, null);
assert(run(dir, '2026-11-16T13:00:00').code === 0, '没有 config/state 时 exit 0');

console.log('# 1b. 但「首次放行」不是无底洞：试满 3 次就停');
dir = setup(null, null);
assert(run(dir, '2026-11-16T13:00:00').code === 0, '第 1 次放行');
assert(run(dir, '2026-11-16T13:05:00').code === 0, '第 2 次放行');
assert(run(dir, '2026-11-16T13:10:00').code === 0, '第 3 次放行');
const bootOut = run(dir, '2026-11-16T13:15:00');
assert(bootOut.code === 2 && /试了 3 次/.test(bootOut.out), '第 4 次跳过（插件一直写不出镜像时不会每拍白叫模型）');
assert(readState(dir).hookStarts.boot === 3, '计数落在 hookStarts.boot 上（和段位槽位分开）');
dir = setup(null, { hookDay: '2026-11-15', hookStarts: { boot: 3 }, day: '2026-11-15' });
assert(run(dir, '2026-11-16T13:00:00').code === 0, '新的一天重新给 3 次机会');

console.log('# 2. 没登录 → 跳过');
dir = setup(baseConfig, Object.assign({}, baseState, { loggedIn: false }));
let out = run(dir, '2026-11-16T08:00:00');
assert(out.code === 2 && /登录/.test(out.out), 'loggedIn=false → exit 2');

console.log('# 3. 时段之间 → 跳过（时间只由 cron 与段表共同决定）');
dir = setup(baseConfig, baseState);
out = run(dir, '2026-11-16T13:00:00');
assert(out.code === 2 && /不在任何刷B站时段内/.test(out.out), '13:00 不在任何段内 → 跳过');

console.log('# 4. 早上一轮 + 晚上一轮：互不侵占额度');
dir = setup(baseConfig, baseState);
assert(run(dir, '2026-11-16T08:00:00').code === 0, '08:00 早段 → 放行');
assert(readState(dir).hookStarts['360#0'] === 1, "早段尝试记在 hookStarts['360#0']");
writeState(dir, { seg: { 360: 1 } });          // 模拟 finish 把早段记成跑成 1 轮
out = run(dir, '2026-11-16T08:30:00');
assert(out.code === 2 && /06:00–10:00 ×1/.test(out.out), '早段跑满 → 08:30 跳过');
assert(run(dir, '2026-11-16T18:30:00').code === 0, '晚段不受早段影响 → 18:30 放行');
writeState(dir, { seg: { 360: 1, 1080: 1 } });
assert(run(dir, '2026-11-16T19:00:00').code === 2, '晚段也跑满 → 跳过');

console.log('# 5. 段内多轮：同一段里第 2 轮用同一个段的额度');
dir = setup({ segments: [{ start: '00:00', end: '24:00', rounds: 2 }], perDay: 5 }, baseState);
assert(run(dir, '2026-11-16T08:00:00').code === 0, '第 1 轮放行');
assert(readState(dir).hookStarts['0#0'] === 1, '第 1 轮记在 0#0');
writeState(dir, { seg: { 0: 1 } });
out = run(dir, '2026-11-16T09:00:00');
assert(out.code === 0 && /第 2\/2 轮/.test(out.out), '第 2 轮放行');
assert(readState(dir).hookStarts['0#1'] === 1, '第 2 轮记在 0#1（尝试次数按轮分开）');
writeState(dir, { seg: { 0: 2 } });
assert(run(dir, '2026-11-16T10:00:00').code === 2, '第 3 次 → 跳过');

console.log('# 6. 尝试次数：同一段的第 1 轮试满 3 次，不牵连第 2 轮');
dir = setup({ segments: [{ start: '00:00', end: '24:00', rounds: 2 }], perDay: 5 },
  Object.assign({}, baseState, { seg: { 0: 0 }, starts: { '0#0': 3 } }));
assert(run(dir, '2026-11-16T08:00:00').code === 2, '0#0 试满 3 次 → 跳过');
// 把第 1 轮记成“跑成但没挑到东西”，第 2 轮就轮到 0#1 这个槽位。
dir = setup({ segments: [{ start: '00:00', end: '24:00', rounds: 2 }], perDay: 5 },
  Object.assign({}, baseState, { seg: { 0: 1 }, starts: { '0#0': 3 } }));
assert(run(dir, '2026-11-16T09:00:00').code === 0, '第 2 轮（0#1）照常放行');

console.log('# 7. hookStarts 按脚本自己的 hookDay 判天');
dir = setup(baseConfig, Object.assign({}, baseState, { hookStarts: { '360#0': 3 }, hookDay: '2026-11-15' }));
assert(run(dir, '2026-11-16T08:00:00').code === 0, '昨天的 3 次不挡今天');
assert(readState(dir).hookStarts['360#0'] === 1, '今天从 1 开始');
dir = setup(baseConfig, Object.assign({}, baseState, { hookStarts: { '360#0': 3 }, hookDay: '2026-11-16' }));
assert(run(dir, '2026-11-16T08:00:00').code === 2, '今天试满 3 次 → 跳过');

console.log('# 8. 额度：perDay>0 用完就停，perDay=0 视为不限流');
dir = setup(baseConfig, Object.assign({}, baseState, { pickedAuto: 5 }));
assert(run(dir, '2026-11-16T08:00:00').code === 2, 'pickedAuto=5 / perDay=5 → 跳过');
dir = setup(Object.assign({}, baseConfig, { perDay: 0 }), Object.assign({}, baseState, { pickedAuto: 5 }));
assert(run(dir, '2026-11-16T08:00:00').code === 0, 'perDay=0 → 不限流');

console.log('# 9. 已经有一轮在跑 → 跳过；过期的锁不再挡');
// 锁的过期是按**传进来的 now** 算的（`--now` 就是注入点；不传才是系统时间）。
// 这一段故意用真实时间戳构造锁、并用真实 now 跑，所以下面把段设成整天：
// 这样时钟落在几点都不会被「不在段内」提前挡掉，测的就是锁本身。
const allDay = { segments: [{ start: '00:00', end: '24:00', rounds: 2 }], perDay: 5 };
const realNow = new Date();
const realToday = realNow.getFullYear() + '-' + String(realNow.getMonth() + 1).padStart(2, '0')
  + '-' + String(realNow.getDate()).padStart(2, '0');
const realState = Object.assign({}, baseState, { day: realToday });
dir = setup(allDay, Object.assign({}, realState, {
  lock: { at: new Date(Date.now() - 60 * 1000).toISOString(), manual: false, slot: '0#0' },
}));
out = run(dir, realNow.toISOString());
assert(out.code === 2 && /有一轮在跑/.test(out.out), '新鲜的锁 → 跳过');
const dir9 = setup(allDay, Object.assign({}, realState, {
  lock: { at: new Date(Date.now() - 20 * 60 * 1000).toISOString(), manual: false, slot: '0#0' },
}));
assert(run(dir9, realNow.toISOString()).code === 0, '过期的锁（20 分钟前）不再挡');

console.log('# 10. 跨天：昨天的记账不该挡今天');
dir = setup(baseConfig, Object.assign({}, baseState, {
  day: '2026-11-15', pickedAuto: 5, seg: { 360: 1 }, starts: { '360#0': 3 },
}));
assert(run(dir, '2026-11-16T08:00:00').code === 0, '昨天跑满也放行今天');

console.log('# 11. 升级前的老镜像：只有 autoRoundsPerDay / runs，按「整天 ×N」接着用');
dir = setup({ autoRoundsPerDay: 2, perDay: 5 },
  Object.assign({}, baseState, { seg: undefined, runs: 1, starts: { 0: 0 } }));
assert(run(dir, '2026-11-16T08:00:00').code === 0, 'runs=1 / 上限 2 → 放行第 2 轮');
assert(readState(dir).hookStarts['0#1'] === 1, '老镜像按整天段（键 0）记第 2 轮');
dir = setup({ autoRoundsPerDay: 2, perDay: 5 }, Object.assign({}, baseState, { seg: undefined, runs: 2 }));
assert(run(dir, '2026-11-16T08:00:00').code === 2, 'runs=2 / 上限 2 → 跳过');
dir = setup({ autoRoundsPerDay: 1, perDay: 5 }, Object.assign({}, baseState, { seg: undefined, runs: undefined, windows: { all: true } }));
assert(run(dir, '2026-11-16T08:00:00').code === 2, '1.2.x 的 windows.all=true → 仍然跳过');

console.log('# 12. 段表坏了：退回「整天 ×1」，不静默失灵');
dir = setup({ segments: [{ start: '25:00', end: '26:00', rounds: 1 }], perDay: 5 }, baseState);
assert(run(dir, '2026-11-16T03:00:00').code === 0, '非法段表 → 整天 ×1 仍然放行');
writeState(dir, { seg: { 0: 1 } });
assert(run(dir, '2026-11-16T04:00:00').code === 2, '整天 ×1 跑成一轮后跳过');

fs.rmSync(root, { recursive: true, force: true });
console.log('\nALL PASS (' + passed + ' checks)');
