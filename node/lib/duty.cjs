'use strict';

/**
 * 值班文件 —— 给"自动化前置检查脚本"看的两个文件。
 *
 * 为什么要它们：Cindy 的自动化可以挂一个 preRunHook 脚本（exit 0 放行 / exit 2 跳过本轮、
 * 零 token）。那个脚本跑在项目目录里，读不到插件的私有数据目录和 /kv，所以插件每次开跑 /
 * 改设置 / 写日报之后，把**判断需要的最小事实**镜像到用户家目录下的一个固定位置：
 *
 *   %APPDATA%\Cindy\duty\cindy-bili-scroll/config.json   闸门要的几个设置（segments / perDay / 互动轮那三个数；另带
 *                             autoRoundsPerDay 给旧脚本兜底）—— 只放这几个，关键词、排除词、
 *                             口吻提示、@ 昵称、私信收件人这些留在插件私有目录
 *   %APPDATA%\Cindy\duty\cindy-bili-scroll/state.json    记账（今天挑了几条、各段跑成了几轮、每个槽位试了几次、
 *                             互动检查几次、有没有一轮在跑）
 *
 * 方向是**单向的：插件写，脚本只读**。手改 config.json 会在插件下次开跑时被覆盖。
 * 这里只做落盘，不含任何 B 站逻辑；写失败不抛（脚本读不到顶多放行一次，由那一轮自己收场）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 由前置检查脚本写、插件必须原样保留的键。 */
// hookDay 是脚本自己记「hookStarts 是哪一天的」的键：插件不写它，也不该把它盖掉。
// inboxHookTries / inboxHookDay / inboxHookAt 是互动闸门脚本的同一套记账：
// 脚本放行一次就 +1，插件同步时原样保留并读回来，两边算「今天检查了几次」才是同一个数。
const SCRIPT_KEYS = [
  'hookStarts', 'hookDay', 'lastSkip', 'hookAt',
  'inboxHookTries', 'inboxHookDay', 'inboxHookAt',
];

const APP_DIR = 'cindy-bili-scroll';
const LEGACY_DIR = 'bili-duty';

/**
 * 值班目录的根。**不要写到家目录根上**：那里会被各种同步 / 备份工具扫进去，
 * 而这两个文件是账号的活动记录。按平台各自的标准位置放：
 *   Windows  %APPDATA%\Cindy\duty\cindy-bili-scroll
 *   macOS    ~/Library/Application Support/Cindy/duty/cindy-bili-scroll
 *   Linux    $XDG_DATA_HOME/cindy/duty/cindy-bili-scroll
 * 两边（这里和 schedule/gate.mjs）各算一次，不靠配置同步。
 */
function appRoot() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cindy', 'duty');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cindy', 'duty');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'cindy', 'duty');
}

function homeDir() {
  return path.join(appRoot(), APP_DIR);
}

/** 1.6.1 及更早写的位置：家目录根下的 `bili-duty`。仅用于搬家。 */
function legacyHomeDir() {
  return path.join(os.homedir(), LEGACY_DIR);
}

/**
 * 旧位置搬一次家：**只在新位置缺、旧位置有**时拷，搬过的和全新安装都不动手。
 * 旧目录留着不删——删不删由用户决定，插件不替他清场。
 */
function migrateLegacy(home) {
  const legacy = legacyHomeDir();
  if (path.resolve(legacy) === path.resolve(home)) return;
  for (const name of ['config.json', 'state.json']) {
    const from = path.join(legacy, name);
    const to = path.join(home, name);
    if (fs.existsSync(to) || !fs.existsSync(from)) continue;
    try {
      fs.copyFileSync(from, to);
    } catch (_error) {
      // 搬不动不影响主流程：下一次同步会把新值整个写出去。
    }
  }
}

function ensureHome() {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true });
  migrateLegacy(dir);
  return dir;
}

/** 先写临时文件再 rename：脚本随时可能来读，不能让它读到半个 JSON */
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonMaybe(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : fallback;
  } catch (_error) {
    return fallback;
  }
}

/**
 * 把插件当前的事实镜像出去。
 * @param {{config?: object, state?: object}} payload
 * @returns {{ok: true, home: string, wrote: string[], hookStarts: object|null, hookDay: string|null,
 *   inboxHookTries: number, inboxHookDay: string|null, inboxHookAt: string|null}}
 */
function sync(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const home = ensureHome();
  const wrote = [];
  let hookStarts = null;
  let hookDay = null;
  let hookAt = null;
  let inboxHookTries = 0;
  let inboxHookDay = null;
  let inboxHookAt = null;
  if (data.config && typeof data.config === 'object' && !Array.isArray(data.config)) {
    writeJsonAtomic(path.join(home, 'config.json'), data.config);
    wrote.push('config.json');
  }
  if (data.state && typeof data.state === 'object' && !Array.isArray(data.state)) {
    // 脚本自己维护的键（它放行一次就 +1 的尝试计数）必须原样保留：
    // 整份覆盖等于每次同步都把「这一档试过几次」清零，模型一崩就会无限重试。
    const file = path.join(home, 'state.json');
    const previous = readJsonMaybe(file, {});
    const merged = Object.assign({}, data.state);
    // 一律原样保留脚本自己的键，**不按 previous.day 判**：跨零点那一拍正是最危险的
    // ——脚本凌晨已经放过两次行（它写的是 hookDay=今天），插件整夜没被调用，
    // previous.day 还是昨天。按天判会把这两次计数丢掉，闸门重新从 0 数，
    // 「一档试 3 次就放弃」在午夜前后失效，模型会被多叫醒几次。
    // 昨天的计数不会污染今天：脚本自己用 hookDay 判天（见 schedule/precheck.mjs）。
    for (const key of SCRIPT_KEYS) {
      if (previous[key] !== undefined) merged[key] = previous[key];
    }
    writeJsonAtomic(file, merged);
    wrote.push('state.json');
    // 把合并后的 hookStarts 回传：插件那边要用它算「这一档试了几次」，
    // 不回传的话插件只能拿自己的旧值，脚本加的那几次全丢。
    //
    // 但**必须连 hookDay 一起回传**：脚本是按 hookDay 判天的（见 schedule/precheck.mjs），
    // 插件若不知道这份计数属于哪一天，就会把昨天的三次当成今天的写进自己的记账，
    // 于是插件说「这一档已经放弃」、脚本说「今天还没试过」——两边结论相反，
    // 模型被放行又被拒，白叫醒好几拍。判定留给插件，这里只如实交代日期。
    hookStarts = merged.hookStarts && typeof merged.hookStarts === 'object' ? merged.hookStarts : {};
    hookDay = merged.hookDay === undefined || merged.hookDay === null ? null : String(merged.hookDay);
    // 最近一次放行的时刻。插件用它判断「脚本刚给的那次放行是不是还没被 bili_round
    // 认领」——认领过就不要再把同一次尝试记第二遍。
    hookAt = merged.hookAt === undefined || merged.hookAt === null ? null : String(merged.hookAt);
    // 互动闸门那一份：插件要用它算「今天检查了几次」，所以同样回传，连同它自己的日期。
    inboxHookTries = Number(merged.inboxHookTries) || 0;
    inboxHookDay = merged.inboxHookDay === undefined || merged.inboxHookDay === null
      ? null
      : String(merged.inboxHookDay);
    inboxHookAt = merged.inboxHookAt === undefined || merged.inboxHookAt === null
      ? null
      : String(merged.inboxHookAt);
  }
  return { ok: true, home, wrote, hookStarts, hookDay, hookAt, inboxHookTries, inboxHookDay, inboxHookAt };
}

function status() {
  const home = homeDir();
  return {
    ok: true,
    home,
    exists: fs.existsSync(home),
    config: readJsonMaybe(path.join(home, 'config.json'), null),
    state: readJsonMaybe(path.join(home, 'state.json'), null),
  };
}

module.exports = { homeDir, legacyHomeDir, ensureHome, sync, status, readJsonMaybe, writeJsonAtomic };
