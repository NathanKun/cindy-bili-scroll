/**
 * 刷B站 · 闸门脚本的后勤：读文件 / 算时间 / 写计数 / 退出。
 *
 * 判断逻辑**不在这里**，全在 `decide.cjs` —— 那一份同时被三个调用方使用：
 *   - 这个脚本（`import` 它，回答「这一拍要不要叫模型」）
 *   - Node 工作进程的 `duty/decide`、`duty/segments`、`duty/layout`
 *   - 插件 `main.js`（经上面那几个 worker 方法拿段表、窗口、尝试次数、互动额度）
 * 这个文件只把那份模块转出来，再补上脚本才需要的东西（命令行开关、原子写、exit 0/2）。
 *
 * 为什么判定要放在一个 `.cjs` 里：插件 `main.js` 是沙箱脚本，没有 import / require，
 * 又必须和闸门用同一套规则。于是共享的那份做成 CommonJS，脚本 `import` 它、
 * worker `require` 它，插件通过 worker 调。
 *
 * 所以段表、窗口、尝试次数、互动额度在仓库里都只有一处定义；`main.js` 里连一个
 * `parseClock` 都没有，改规则只有这一个地方可改。`plugins/_scratch/test-main-gate.cjs`
 * 的 §12 会在有人把副本抄回 `main.js` 时直接失败。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import decideLib from './decide.cjs';

// 只转出脚本真正用到的几个（其余由 decide.cjs 直接导出，worker 那边 require 它）。
export const {
  decide,
  segmentLabel,
  dateKey,
  DEFAULT_MAX_TRIES,
  LOCK_TTL_MS,
  INBOX_LOCK_TTL_MS,
} = decideLib;

/** 读命令行开关：`--home <目录>` / `--now <ISO时间>`。 */
export function flag(name) {
  const index = process.argv.indexOf('--' + name);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : '';
}

/**
 * 值班目录的根。与 `node/lib/duty.cjs` 的 `appRoot()` **必须算出同一个路径**——
 * 两边各算一次是刻意的：这样不用把路径写进配置，也不会因为哪一边没更新而错位。
 * 不要放家目录根：那里会被同步 / 备份工具扫进去。
 */
function dutyRoot() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cindy', 'duty');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cindy', 'duty');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'cindy', 'duty');
}

export function dutyHome() {
  const custom = flag('home');
  return custom ? path.resolve(custom) : path.join(dutyRoot(), 'cindy-bili-scroll');
}

/** 1.6.1 及更早写的位置：家目录根下的 `bili-duty`。仅用于搬家。 */
export function legacyDutyHome() {
  return path.join(os.homedir(), 'bili-duty');
}

/**
 * 第一次在新位置跑之前，把旧位置的两个文件拷过来。
 * 闸门先于插件被调用的时候（cron 比插件先醒），不搬就会读到一份空记账，
 * 轻则白放行一次，重则把旧位置的尝试计数当没有。
 */
export function migrateLegacyHome(home) {
  // 显式 `--home` 是调试 / 测试用的临时目录，绝不能把真主人的值班文件拷进去：
  // 那会让「空目录 → 放行一次」这类用例读到真实记账，判出完全不同的结果。
  if (flag('home')) return;
  const legacy = legacyDutyHome();
  if (path.resolve(legacy) === path.resolve(home)) return;
  for (const name of ['config.json', 'state.json']) {
    const from = path.join(legacy, name);
    const to = path.join(home, name);
    if (fs.existsSync(to) || !fs.existsSync(from)) continue;
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.copyFileSync(from, to);
    } catch (_error) {
      // 搬不动就按「还没同步过」处理，脚本自己有逃生门。
    }
  }
}

/** 调试用：`--now 2026-11-14T13:05:00` 假装现在是什么时候。 */
export function nowDate() {
  const custom = flag('now');
  return custom ? new Date(custom) : new Date();
}

export function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 原子写 state.json 里的一个补丁；写不了不影响这一拍的判定。
 *
 * 文件不存在时**创建它**：脚本自己也得能记账。以前这里遇到缺文件就直接放弃，
 * 于是「首次放行」那条逃生门变成了无底洞——插件要是一直写不出镜像（凭证目录坏了、
 * worker 起不来），脚本永远看不到自己的计数，每一拍都放行一个新的模型。
 * 现在脚本能自己落下计数，试满 3 次就停。
 */
export function writeStatePatch(home, patch) {
  const file = path.join(home, 'state.json');
  // 插件会整份写回同一个文件。脚本只想改自己那几个键，但「读 → 合并 → rename」
  // 之间如果插件刚好写完新账（刚 finish 一轮、刚释放锁），这次读就旧了，照旧快照
  // 写回去会把插件刚写的锁 / 段记账整体回滚——那不是「多叫一次模型」，而是两条车道
  // 一起被复活出来的锁按 12 分钟。所以写之前再看一眼文件有没有变过，变过就重读重合并。
  const stamp = statStamp(file);
  let current = readJson(file) || {};
  try {
    if (statStamp(file) !== stamp) current = readJson(file) || {};
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, current, patch), null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_error) {
    // 写不进去必须让调用方知道：脚本的所有上限（首次放行 3 次、每槽 3 次、每天几次检查）
    // 都只存在这个文件里。悄悄放行又不记账 = 每一拍白叫一次模型，一天几十次。
    return false;
  }
}

/** 文件的「修改戳」：拿不到就当空（不存在 / 没权限）。 */
function statStamp(file) {
  try {
    const st = fs.statSync(file);
    return st.mtimeMs + ':' + st.size;
  } catch (_error) {
    return '';
  }
}

/** 跳过这一拍：记下原因（给人看），exit 2。 */
export function skip(home, reason, source) {
  writeStatePatch(home, {
    lastSkip: { reason, at: new Date().toISOString(), source: String(source || '') },
  });
  process.stdout.write('skip: ' + reason + '\n');
  process.exit(2);
}

/** 放行：exit 0。 */
export function allow(message) {
  process.stdout.write('run: ' + message + '\n');
  process.exit(0);
}
