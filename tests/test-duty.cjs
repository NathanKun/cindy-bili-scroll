'use strict';

/**
 * duty.cjs（值班镜像的写入侧）的合并规则测试。
 *
 * 关键一条：脚本自己记的 hookStarts 不能因为插件镜像的 state.day 变了就被丢掉。
 * 最危险的时刻正是跨零点——脚本凌晨已经放过两次行（它写的是 hookDay=今天），
 * 而插件整夜没被调用（state.day 还是昨天），这时插件第一次同步如果按天判，
 * 那两次计数就没了，闸门重新从 0 数，模型会被多叫醒几次。
 *
 *   node tests/test-duty.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 在 require 之前把各平台的标准数据目录都指到临时目录。1.6.2 起镜像不在 ~/bili-duty
// 而在 %APPDATA%\Cindy\duty\cindy-bili-scroll（macOS / Linux 各有各的根），所以三个环境变量都要设：
// 只设 HOME 的话，Windows 上会写到真实的 %APPDATA%，测试就把用户自己的记账盖掉了。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-duty-home-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
process.env.APPDATA = path.join(sandbox, 'AppData', 'Roaming');
process.env.XDG_DATA_HOME = path.join(sandbox, '.local', 'share');

const duty = require(path.resolve(__dirname, '..', 'node', 'lib', 'duty.cjs'));
// 路径由 duty.cjs 自己算，测试不另写一份——写了就会像这次一样跟主线漂移。
const statePath = path.join(duty.homeDir(), 'state.json');

let passed = 0;
function assert(condition, label) {
  if (!condition) throw new Error('ASSERT FAILED: ' + label);
  passed += 1;
  console.log('  ✓ ' + label);
}

console.log('# 1. 插件镜像写到按平台的 duty 目录，且带齐闸门要的设置');
const first = duty.sync({
  config: { perDay: 5, autoRoundsPerDay: 2, peakValley: true, noon: true, night: true },
  state: { day: '2026-11-15', pickedAuto: 0, runs: 0, starts: {} },
});
assert(first.ok && first.wrote.length === 2, 'config.json 与 state.json 都写了');
assert(path.resolve(duty.homeDir()) !== path.resolve(duty.legacyHomeDir()),
  '写的是新位置，不是 1.6.1 的 ~/bili-duty');

console.log('# 2. 跨天：脚本凌晨记的 hookStarts 必须活下来');
const seeded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
seeded.hookStarts = { night: 2 };
seeded.hookDay = '2026-11-16';
seeded.lastSkip = null;
fs.writeFileSync(statePath, JSON.stringify(seeded), 'utf8');

const second = duty.sync({
  config: { perDay: 5, autoRoundsPerDay: 2, peakValley: true, noon: true, night: true },
  state: { day: '2026-11-16', pickedAuto: 0, runs: 1, starts: { 0: 1 } },
});
const merged = JSON.parse(fs.readFileSync(statePath, 'utf8'));
assert(merged.hookStarts && merged.hookStarts.night === 2, 'hookStarts 没被丢掉（不按 day 判）');
assert(merged.hookDay === '2026-11-16', 'hookDay 也保留着（脚本靠它判天）');
assert(second.hookStarts && second.hookStarts.night === 2, '回传给插件的合并值里有那两次');
assert(merged.day === '2026-11-16', '镜像的 day 用插件的新值');
assert(merged.runs === 1, '跑成几轮照旧写进去');
assert(merged.starts['0'] === 1, '插件的尝试计数照旧写进去');

assert(second.hookDay === '2026-11-16', '回传的 hookDay 是脚本自己记的那天（插件靠它判收不收这份计数）');

console.log('# 3. 同一天里连续同步，脚本计数继续累加而不是被盖掉');
const third = duty.sync({
  config: { perDay: 5, autoRoundsPerDay: 2, peakValley: true, noon: true, night: true },
  state: { day: '2026-11-16', pickedAuto: 1, runs: 1, starts: { 0: 2 } },
});
assert(third.hookStarts.night === 2, '第二次同步也还是 2');

console.log('# 4. 脚本的计数属于昨天时，回传的 hookDay 也得是昨天（插件据此拒收）');
const stale = JSON.parse(fs.readFileSync(statePath, 'utf8'));
stale.hookStarts = { all: 3 };
stale.hookDay = '2026-11-15';
fs.writeFileSync(statePath, JSON.stringify(stale), 'utf8');
const fourth = duty.sync({
  config: { perDay: 5, autoRoundsPerDay: 2, peakValley: true, noon: true, night: true },
  state: { day: '2026-11-16', pickedAuto: 0, runs: 0, starts: {} },
});
assert(fourth.hookStarts.all === 3 && fourth.hookDay === '2026-11-15',
  '计数照旧保留在文件里，但回传的 hookDay 是昨天——插件不会把它当今天的三次');

// 闸门唯一读不到「每天几轮」的方式就是这里把它漏掉：config.json 必须原样带过去。
console.log('# 5. config 原样落盘，闸门要的几个键一个不少');
const cfg = JSON.parse(fs.readFileSync(path.join(duty.homeDir(), 'config.json'), 'utf8'));
assert(Object.keys(cfg).sort().join(',') === 'autoRoundsPerDay,night,noon,peakValley,perDay',
  '五个设置键都在，包括 autoRoundsPerDay');
assert(cfg.autoRoundsPerDay === 2, 'autoRoundsPerDay 原样保留（闸门靠它数轮次）');

console.log('\nALL PASS (' + passed + ' checks)');
