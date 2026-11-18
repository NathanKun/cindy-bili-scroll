#!/usr/bin/env node

/**
 * 刷B站 · 自动化的前置检查（Cindy preRunHook）—— 1.5.0 起**只管一条任务**。
 *
 * 挂在「刷B站 · 自动运行」那条自动化上，每次到点先跑它，**不经过大模型、不花 token**：
 *   exit 0  → 放行，这一拍才真的叫模型（做日报轮还是互动轮由插件判）
 *   exit 2  → 跳过本拍（任务记录里记为 skipped，模型不会被唤醒）
 *   其它退出码 → 按「前置检查失败」处理，任务不会跑（fail-closed）
 *
 * 它只做三件事：
 *   1. 读两个镜像文件（插件写的 `%APPDATA%\Cindy\duty\cindy-bili-scroll/{config,state}.json`）；
 *   2. 调 `decide()` 问「这一拍有没有事做」（判定逻辑只有那一份，见 decide.cjs）；
 *   3. 有就放行、并把自己这一次放行记进计数；没有就跳过。
 *
 * **它不决定「做哪一件」**：preRunHook 的 stdout 不会进模型上下文，说了也没人听。
 * 真正的分派在插件里（模型第一步调 `bili_round({action:"start"})`，插件用刚读到的
 * 新鲜记账再判一次，返回 mode=report / inbox / none）。闸门只是保守粗筛：
 * 它看到「有活」就放行，哪怕插件转头发现已经没有活了 —— 代价是一次没干活的短会话。
 *
 * 方向基本是单向的（插件写、脚本读），只有一个例外：**本脚本放行时写自己的计数**。
 *   - 日报轮：`hookStarts[段内槽位] + 1` —— 放行之后模型可能压根没走到 bili_round，
 *     不在这里记，cron 就会每一拍重试到天荒地老；
 *   - 互动轮：`inboxHookTries + 1` —— 模型崩在半路的那一次也是一次真账单。
 * 插件同步时原样保留这些键（见 node/lib/duty.cjs），并把合并后的值读回去，
 * 让两边算的是同一个数。
 *
 * 用法（手动跑一次看看会被放行还是跳过）：
 *   node schedule/precheck.mjs
 *   echo $?          # 0 = 放行，2 = 跳过
 *
 * 调试开关（正常使用不需要）：
 *   --home <目录>   换一个值班目录（默认 %APPDATA%\Cindy\duty\cindy-bili-scroll）
 *   --now <ISO时间> 假装现在是什么时候，例如 2026-11-14T13:05:00
 */

import path from 'node:path';

import {
  DEFAULT_MAX_TRIES,
  allow,
  dateKey,
  decide,
  dutyHome,
  migrateLegacyHome,
  nowDate,
  readJson,
  segmentLabel,
  skip,
  writeStatePatch,
} from './gate.mjs';

const HOME = dutyHome();
// 1.6.2 起值班目录搬到了 AppData / XDG 下。闸门常常比插件先醒，
// 所以搬家的第一步在这里做：新位置是空的、旧位置有文件，就先拷过来再判。
migrateLegacyHome(HOME);
const now = nowDate();
const today = dateKey(now);

const config = readJson(path.join(HOME, 'config.json'));
const state = readJson(path.join(HOME, 'state.json'));

// 还没同步过（刚装、刚登录、刚改设置）：放行一次，那一轮会把值班文件写出来。
//
// 但**放行本身也计数**：插件要是一直写不出来（凭证目录坏了、worker 起不来、
// /kv 读不到），这条逃生门就会变成每一拍都放行——一个 5 分钟的 cron 一天能白叫
// 近三百次模型。计数落在脚本自己能写的 hookStarts.boot 上。
if (!config || !state) {
  const prevHook = state && state.hookDay === today && state.hookStarts && typeof state.hookStarts === 'object'
    ? state.hookStarts
    : {};
  const bootTries = Number(prevHook.boot) || 0;
  if (bootTries >= DEFAULT_MAX_TRIES) {
    skip(
      HOME,
      '插件还没同步过设置（缺 ' + (config ? 'state.json' : 'config.json') + '），已经试了 ' + bootTries + ' 次都没成：先不叫模型，去插件设置页看一眼',
      'gate'
    );
  }
  const wrote = writeStatePatch(HOME, {
    hookStarts: Object.assign({}, prevHook, { boot: bootTries + 1 }),
    hookDay: today,
    hookAt: now.toISOString(),
  });
  if (!wrote) skip(HOME, '记不下这次放行（写不了 ' + HOME + '\\state.json）：先不叫模型，检查一下这个目录的权限/磁盘', 'gate');
  allow('还没同步过：放行一次让插件写出值班文件（第 ' + (bootTries + 1) + '/' + DEFAULT_MAX_TRIES + ' 次）');
}

const decision = decide(config, state, now);

if (decision.mode === 'none') {
  skip(HOME, explain(decision), 'gate');
}

if (decision.mode === 'report') {
  // 记「这一段这一轮试过一次」。槽位 = 段键#段内第几轮，跨天/跨段各记各的，
  // 一次崩溃只烧掉这一槽，不牵连同段下一轮，也不牵连晚上那段。
  const slot = decision.report.slot;
  const prevHook = state.hookDay === today && state.hookStarts && typeof state.hookStarts === 'object'
    ? state.hookStarts
    : {};
  const tries = decision.report.tries;
  const wrote = writeStatePatch(HOME, {
    hookStarts: Object.assign({}, prevHook, { [slot]: tries + 1 }),
    hookDay: today,
    // hookAt 只由日报轮那一次放行更新：插件用「放行时刻比槽位开跑时刻新」来判断
    // 这次放行是不是还没被认领（见 main.js 的 allowanceUnclaimed）。互动轮的放行
    // 时刻记在 inboxHookAt 里，两个槽互不干扰。
    hookAt: now.toISOString(),
    lastSkip: null,
  });
  if (!wrote) skip(HOME, '记不下这次放行（写不了 ' + HOME + '\\state.json）：先不叫模型，检查一下这个目录的权限/磁盘', 'gate');
  const seg = decision.report.segment;
  allow(
    '日报轮：「' + segmentLabel(seg) + '」第 ' + (decision.report.runs + 1) + '/' + decision.report.rounds + ' 轮'
    + ', 尝试 ' + (tries + 1) + '/' + decision.report.maxTries
    + ', pickedAuto=' + decision.report.pickedAuto + '/' + (decision.report.perDay || '∞')
  );
}

// mode === 'inbox'
{
  const used = decision.inbox.checksUsed;
  const wrote = writeStatePatch(HOME, {
    inboxHookTries: used + 1,
    inboxHookDay: today,
    inboxHookAt: now.toISOString(),
    lastSkip: null,
  });
  if (!wrote) skip(HOME, '记不下这次放行（写不了 ' + HOME + '\\state.json）：先不叫模型，检查一下这个目录的权限/磁盘', 'gate');
  allow('互动轮：今天的第 ' + (used + 1) + '/' + decision.inbox.checksPerDay + ' 次检查');
}

/**
 * 跳过时给人看的一句话。
 *
 * 两条车道各自的原因都要说清楚：只写「日报轮这一段跑满了」会让人以为自动任务整体停了，
 * 而实际上互动轮可能还在跑（或者反过来被关着，那也该说）。
 */
function explain(result) {
  const report = result.report || {};
  const inbox = result.inbox || {};
  const head = reportReason(report);
  // 两条车道被同一件事挡住时（同一把锁、或同一轮在跑），别再重复说一遍。
  const sameCause = (report.reason === 'inbox_running' && inbox.reason === 'inbox_busy')
    || (report.reason === 'busy' && inbox.reason === 'report_running')
    || (report.reason === 'not_logged_in' && inbox.reason === 'not_logged_in');
  const tail = sameCause ? '' : inboxReason(inbox);
  return tail ? head + '；' + tail : head;
}

function reportReason(report) {
  switch (report.reason) {
    case 'not_logged_in':
      return '还没登录 B 站（打开插件设置页的「登录」页签）';
    case 'busy':
      return '已经有一轮在跑（12 分钟内的锁），等它收尾';
    case 'inbox_running':
      return '有一次互动检查在跑（锁 15 分钟内有效），单车道要等它收尾';
    case 'quota_exhausted':
      return '今天的额度已满 ' + report.pickedAuto + '/' + report.perDay;
    case 'report_unreadable':
      return '读不到今天的日报（没法核对今天已经挑了几条），插件已经报告过这件事';
    case 'outside_segments':
      return '现在不在任何刷B站时段内';
    case 'segment_done':
      return '「' + labelOf(report.segment) + '」这一段今天已经跑成 ' + report.runs + '/' + report.rounds + ' 轮';
    case 'tries_exhausted':
      return '「' + labelOf(report.segment) + '」第 ' + (report.runs + 1) + ' 轮已经试了 ' + report.tries + ' 次都没成';
    default:
      return '日报轮没有可做的事（' + String(report.reason || 'unknown') + '）';
  }
}

function inboxReason(inbox) {
  switch (inbox.reason) {
    case 'inbox_disabled':
      return '';
    case 'report_running':
      return '互动轮在等日报轮收尾';
    case 'inbox_busy':
      return '已经有一次互动检查在跑';
    case 'inbox_checks_exhausted':
      return '互动检查今天已经用满 ' + inbox.checksUsed + '/' + inbox.checksPerDay + ' 次';
    case 'inbox_too_soon':
      return '离上一次互动检查还不到 ' + inbox.minGapMin + ' 分钟';
    default:
      return '';
  }
}

function labelOf(segment) {
  if (!segment) return '当前时段';
  return typeof segment.label === 'string' ? segment.label : segmentLabel(segment);
}
