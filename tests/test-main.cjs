'use strict';

/**
 * 在本地用假的 cindy 主机跑一遍 main.js 的工具分派，确认纯逻辑没错。
 * 不联网、不碰真实插件目录（fs 是本进程里的内存表）。
 *
 * 这份文件是插件唯一的回归测试：每个「#」段对应一条曾经真实出错的路径，
 * 改 main.js 之后跑一遍（node tests/test-main.cjs）。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainPath = path.resolve(__dirname, '..', 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');

const files = new Map();
const kv = {};
let handler = null;
let lastMirror = null;
let failRead = null;      // 设成路径 → 那一次 read 返回失败（模拟读盘故障）
const failPaths = new Set(); // 这些路径的每一次 read 都失败（模拟持续故障，直到 delete）
let kvBroken = false;     // true → fetch('/kv') 抛错
let deleteNoop = false;   // true → delete 回 ok 但文件其实没删（模拟退出登录没删掉）
let nextHookStarts = null; // duty/sync 回传的 hookStarts（模拟闸门脚本自己加的计数）
let nextHookDay = '';      // 那份计数属于哪一天（脚本的 hookDay）
let onStateRead = null;    // (第几次读) => void：模拟「两次读之间另一条调用改了 state.json」
let stateReads = 0;
let failReadAt = null;     // { key, n }：第 n 次读这个文件时失败（模拟「读到一半才坏」）
const readCounts = new Map();
let commentCounter = 900;
let inboxNext = null;       // msg/inbox 的返回值：{ items: [...], partial?: bool }
let authInvalid = false;   // true → auth/account 回 isLogin=false（模拟「B站 不认这段 Cookie」）
let qrPollPlan = null;     // 按顺序消费的扫码状态（null = 一直 waiting）
let qrPollCount = 0;       // 插件一共问了几次扫码状态
let qrStartCount = 0;      // 插件一共要了几张二维码
let accountCount = 0;      // 插件一共问了几次「这是谁」
const pending = new Map();

const cindy = {
  onHostMessage(fn) { handler = fn; },
  async send(message) {
    if (message.type === 'fs-request') {
      const key = message.path;
      if (message.op === 'write') {
        files.set(key, message.content);
        return { ok: true, op: 'write', path: key, bytes: Buffer.byteLength(message.content) };
      }
      if (message.op === 'read') {
        if (failPaths.has(key)) return { ok: false, errorCode: 'IO', message: '磁盘读失败' };
        if (failRead === key) { failRead = null; return { ok: false, errorCode: 'IO', message: '磁盘读失败' }; }
        const nth = (readCounts.get(key) || 0) + 1;
        readCounts.set(key, nth);
        if (failReadAt && failReadAt.key === key && failReadAt.n === nth) {
          failReadAt = null;
          return { ok: false, errorCode: 'IO', message: '磁盘读失败' };
        }
        if (onStateRead && key === 'state.json') {
          stateReads += 1;
          onStateRead(stateReads);
        }
        if (!files.has(key)) return { ok: false, errorCode: 'NOT_FOUND', message: 'not found: ' + key };
        return { ok: true, op: 'read', path: key, content: files.get(key) };
      }
      if (message.op === 'list') {
        // 列数据目录根时 path 是空串，前缀就是空（以前拼成 '/'，根目录下的文件永远列不出来）
        const prefix = message.path ? message.path.replace(/\/$/, '') + '/' : '';
        const entries = [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ path: k }));
        return { ok: true, op: 'list', entries };
      }
      if (message.op === 'delete') {
        if (!deleteNoop) files.delete(key);
        return { ok: true, op: 'delete', path: key };
      }
      return { ok: false, message: 'unknown op' };
    }
    if (message.type === 'tool-result') {
      const resolve = pending.get(message.callId);
      if (resolve) { pending.delete(message.callId); resolve(message); }
      return { ok: true };
    }
    return { ok: true };
  },
  node: { async request(request) {
    const method = request.method;
    const params = request.params || {};
    if (method === 'duty/sync') {
      lastMirror = { config: params.config, state: params.state };
      // 真实 duty.sync 会连 hookDay 一起回传（脚本自己记的「这份计数属于哪一天」）；
      // 插件只在 hookDay 就是今天时才收回计数。这里照真实形状回。
      return {
        ok: true,
        result: {
          ok: true,
          data: { ok: true, hookStarts: nextHookStarts, hookDay: nextHookStarts ? nextHookDay : null },
        },
      };
    }
    if (method === 'duty/decide' || method === 'duty/segments' || method === 'duty/layout') {
      // 真实的 worker 会 require('../schedule/decide.cjs')；测试里直接引同一个文件，
      // 保证插件这条路径和闸门脚本用的是同一份判定（含 duty/segments 与 duty/layout，
      // 插件已经不自己算段表/窗口/额度了）。
      const lib = require(path.join(__dirname, '..', 'schedule', 'decide.cjs'));
      const nowDate = params.now ? new Date(params.now) : new Date();
      let data;
      if (method === 'duty/decide') {
        data = lib.decide(params.config, params.state, nowDate, params.options);
      } else if (method === 'duty/segments') {
        const segments = lib.segmentTable(params.segments, params.autoRoundsPerDay);
        data = { segments, total: segments.reduce((sum, row) => sum + row.rounds, 0) };
      } else {
        data = lib.layout(params.config, params.state, nowDate);
      }
      return { ok: true, result: { ok: true, data } };
    }
    if (method === 'auth/account') {
      accountCount += 1;
      const cred = params.credential || {};
      const logged = Boolean(cred.sessdata) && !authInvalid;
      return {
        ok: true,
        result: {
          ok: true,
          data: logged
            ? { isLogin: true, mid: 42, uname: '测试账号', level: 5, vip: false }
            : { isLogin: false, mid: 0, uname: '', level: 0, vip: false },
        },
      };
    }
    if (method === 'auth/qr-start') {
      qrStartCount += 1;
      return { ok: true, result: { ok: true, data: { key: 'KEY123', url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=KEY123', expiresIn: 180 } } };
    }
    if (method === 'auth/qr-poll') {
      qrPollCount += 1;
      const status = Array.isArray(qrPollPlan) && qrPollPlan.length ? qrPollPlan.shift() : 'waiting';
      if (status === 'ok') {
        return {
          ok: true,
          result: {
            ok: true,
            data: {
              status: 'ok',
              message: '登录成功',
              credential: { sessdata: 'SESS-XYZ', bili_jct: 'JCT-XYZ', dedeuserid: '42', buvid3: 'BV-XYZ' },
            },
          },
        };
      }
      const messages = { waiting: '还没扫码', scanned: '已扫码，请在手机上确认登录', expired: '二维码已过期，请重新获取' };
      return { ok: true, result: { ok: true, data: { status, message: messages[status] || status } } };
    }
    if (method === 'search' || method === 'recommend') {
      return {
        ok: true,
        result: {
          ok: true,
          data: {
            source: method,
            count: 2,
            videos: [
              { bvid: 'BV1tKs76bEyi', title: '星舰十五飞 全程回放', author: 'SpaceX中文', description: '回收', duration: '18:32', views: '30.1万' },
              { bvid: 'BV1neverseen', title: '完全没刷过的一条', author: '别人', description: '', duration: '01:00', views: '1万' },
            ],
          },
        },
      };
    }
    if (method === 'video') {
      return {
        ok: true,
        result: {
          ok: true,
          data: {
            bvid: params.bvid || 'BV1tKs76bEyi', aid: 111, cid: 222, title: '星舰十五飞 全程回放',
            desc: 'd', author: 'SpaceX中文', mid: 7, duration: '18:32', durationSeconds: 1112,
            pubdate: 0, cover: 'https://i0.hdslb.com/x.jpg', tname: '科技',
            stat: { view: 301000, viewText: '30.1万', danmaku: 100, reply: 50, favorite: 9, like: 20, coin: 3 },
            pages: [],
          },
        },
      };
    }
    if (method === 'subtitle') {
      if (params.bvid === 'BVnosubtitle') {
        return { ok: true, result: { ok: true, data: { bvid: params.bvid, available: false, reason: '该视频没有字幕轨', text: '' } } };
      }
      return { ok: true, result: { ok: true, data: { bvid: params.bvid, available: true, language: '中文（自动生成）', segments: 3, chars: 30, text: '第一段\n第二段\n第三段' } } };
    }
    if (method === 'comments') {
      return { ok: true, result: { ok: true, data: { total: 1, count: 1, comments: [{ rpid: 1, user: 'u', content: '这条视频把引擎结构讲清楚了', like: 3, topReplies: [{ rpid: 12, user: 'v', content: '同意' }] }] } } };
    }
    if (method === 'comment/post') {
      commentCounter += 1;
      return { ok: true, result: { ok: true, data: { ok: true, bvid: params.bvid || '', aid: params.aid || 111, rpid: commentCounter, root: params.root || null } } };
    }
    if (method === 'comment/check') {
      // worker 那边会查两遍（自己的凭证 + 不带登录态），这里把两种结果都模拟出来：
      //   900–949  自己的和匿名的都查得到 → 真公开
      //   950–979  只有自己的查得到     → 「仅自己可见」（实测里踩过的那个假阳性）
      //   980–989  匿名那一遍请求失败   → 判不了
      //   其它     两边都查不到
      const id = Number(params.rpid);
      let own = id >= 900;
      let anonymous = id >= 900;
      let anonymousError = '';
      if (id >= 950 && id < 980) anonymous = false;
      if (id >= 980 && id < 990) { anonymous = null; anonymousError = '匿名复查被风控拦了'; }
      return {
        ok: true,
        result: {
          ok: true,
          data: {
            visible: own,
            state: own ? 0 : null,
            detail: own ? '' : '最新 30 条主楼里没有这条',
            anonymous: anonymous === null ? null : { visible: anonymous, detail: anonymous ? '' : '最新 30 条主楼里没有这条' },
            anonymousError,
          },
        },
      };
    }
    if (method === 'favorite/folders') {
      return { ok: true, result: { ok: true, data: { folders: [{ id: 101, title: '默认收藏夹', count: 3 }, { id: 202, title: '值得看', count: 7 }] } } };
    }
    if (method === 'dm/send') {
      return { ok: true, result: { ok: true, data: { ok: true, delivered: true, msgKey: 'abcdef1234567890' } } };
    }
    if (method === 'msg/inbox') {
      // 收件箱内容由测试设置；partial=true 模拟「有一部分接口没读到」。
      const plan = inboxNext || {};
      return {
        ok: true,
        result: {
          ok: true,
          data: {
            unread: { reply: 0, at: 0, dm: 0 },
            items: Array.isArray(plan.items) ? plan.items : [],
            partial: Boolean(plan.partial),
          },
        },
      };
    }
    return { ok: true, result: { ok: true, data: { stub: method } } };
  } },
};

const fetchStub = async (url, init) => {
  if (url !== '/kv') throw new Error('unexpected fetch ' + url);
  if (kvBroken) throw new Error('network down');
  if (init && init.method === 'PUT') {
    Object.keys(kv).forEach((key) => delete kv[key]);
    Object.assign(kv, JSON.parse(init.body));
    return { ok: true, status: 204, async json() { return {}; } };
  }
  return { ok: true, status: 200, async json() { return JSON.parse(JSON.stringify(kv)); } };
};

/**
 * 假的 BroadcastChannel：设置页那条线（页面 ←→ 电子脑）在真机上就是这个通道。
 * 这里只做最小实现——记下发出的话，能按消息派发 onmessage，供测试断言。
 */
const fakeChannels = [];
class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.sent = [];
    fakeChannels.push(this);
  }
  postMessage(data) { this.sent.push(JSON.parse(JSON.stringify(data))); }
  addEventListener() {}
  removeEventListener() {}
  set onmessage(fn) { this.handler = fn; }
  get onmessage() { return this.handler; }
  async deliver(data) {
    if (this.handler) await this.handler({ data: JSON.parse(JSON.stringify(data)) });
  }
  replies() { return this.sent.filter((item) => item && item.type === 'bili-login-reply'); }
}

const context = {
  cindy,
  fetch: fetchStub,
  BroadcastChannel: FakeBroadcastChannel,
  console: { log() {}, error() {}, warn() {} },
  setTimeout,
  clearTimeout,
  JSON,
  Math,
  Date,
  Promise,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Set,
  Map,
  RegExp,
  Error,
  encodeURIComponent,
  process,
};

vm.createContext(context);
vm.runInContext(source, context, { filename: 'main.js' });

let callSeq = 0;
async function call(tool, args) {
  const callId = 'call-' + (callSeq += 1);
  const promise = new Promise((resolve) => pending.set(callId, resolve));
  await handler({ type: 'tool-call', tool, args, callId });
  return await promise;
}

function body(message) {
  return message && message.ok ? message.result.structuredContent || {} : {};
}

function show(label, message) {
  const text = message.ok
    ? JSON.stringify(message.result.structuredContent).slice(0, 220)
    : 'ERROR ' + message.errorCode + ': ' + message.message;
  console.log('• ' + label + ' → ' + (message.ok ? 'ok' : 'fail') + ' ' + text);
}

function assert(condition, label) {
  if (!condition) throw new Error('ASSERT FAILED: ' + label);
  console.log('  ✓ ' + label);
}

function stateFile() {
  try { return JSON.parse(files.get('state.json') || '{}'); } catch (_e) { return {}; }
}

/**
 * 开一轮手动。手动轮有每日上限（MANUAL_MAX_PER_DAY），而这套测试在一个「今天」里
 * 开十几轮——每轮之前把当日计数清零，测的是轮次本身而不是上限。上限另有专测。
 */
async function manualRound() {
  const state = stateFile();
  delete state.manualDay;
  delete state.manualCount;
  files.set('state.json', JSON.stringify(state));
  return call('bili_round', { manual: true });
}

/** 模拟「12 分钟过去了」：把这一轮的锁做成过期，等价于模型崩了之后下一拍。 */
function expireLock() {
  const state = stateFile();
  if (!state.roundLock) return;
  state.roundLock.at = new Date(Date.now() - 13 * 60 * 1000).toISOString();
  files.set('state.json', JSON.stringify(state));
}

function reportText() {
  return files.get('out/' + new Date().toISOString().slice(0, 10) + '.md') || '';
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

(async () => {
  console.log('# 1. 未登录时 bili_round 应该要求登录');
  let r = await call('bili_round', {});
  show('bili_round', r);
  assert(body(r).go === false && body(r).reason === 'not_logged_in', 'go=false / not_logged_in');

  console.log('# 2. 放入凭证后手动一轮放行，章程内联');
  files.set('credential.json', JSON.stringify({ sessdata: 'x', bili_jct: 'y', dedeuserid: '1', buvid3: 'a', buvid4: 'b' }));
  await call('bili_config', { set: { manualCooldownMin: 0 } });
  r = await manualRound();
  const round = body(r);
  assert(round.go === true, 'go=true（手动）');
  assert(typeof round.charter === 'string' && round.charter.includes('红线'), 'charter 已内联');
  assert(round.charter.includes('500 字') && round.charter.includes('bili_verify'), '章程里有私信上限与复核步骤');
  assert(round.budget.comment === 0 && round.budget.dm === 0, '默认不发评论不发私信');
  assert(Boolean(round.roundId), '返回 roundId（一轮的标识）');
  r = await call('bili_round', {});
  assert(body(r).reason === 'busy', '同一时间只允许一轮（busy）');
  r = await call('bili_round', { action: 'finish', status: 'nothing', note: '测试收尾' });
  assert(body(r).finished === false && body(r).reason === 'round_required', '有锁却不带 roundId → 拒绝（不许替别人收尾）');
  r = await call('bili_round', { action: 'finish', status: 'nothing', note: '测试收尾', roundId: round.roundId });
  assert(body(r).finished === true, 'finish 释放这一轮');
  assert(reportText().includes('这一轮没写出日报'), 'finish 补了占位日报');
  assert(r.ok && body(r).autoRound === null, '手动轮不占每天的自动轮次');

  console.log('# 3. 日报计数：## / ### 都算，围栏里不算，重复 BV 只算一次');
  const fence = '```\n### BV1zzzzzzzzz\n```\n';
  r = await call('bili_report_append', { text: fence + '### BV1tKs76bEyi\n标题 / UP / 12:00 / 1.2万播放\n**档位**：值得看\n为什么值得：讲清了回收塔架' });
  show('bili_report_append', r);
  assert(body(r).selectedToday === 1, '围栏里的示例没被数进去（selectedToday=1）');
  r = await call('bili_report_append', { text: '## BV1bbbbbbbbb\n标题 / UP / 05:00 / 9万播放\n**档位**：可以看' });
  assert(body(r).selectedToday === 2, '两个井号也算（selectedToday=2）');
  r = await call('bili_report_append', { text: '### BV1tKs76bEyi\n重复写同一个 BV\n**档位**：值得看' });
  assert(body(r).selectedToday === 2, '同一个 BV 写两次仍算一条');

  console.log('# 4. 超额度时 append 必须拒绝，且不改文件');
  await call('bili_config', { set: { perDay: 2 } });
  const before = reportText();
  r = await call('bili_report_append', { text: '### BV1ccccccccc\n第三条\n**档位**：可以看' });
  show('bili_report_append', r);
  assert(!r.ok && r.errorCode === 'QUOTA_EXCEEDED', 'QUOTA_EXCEEDED');
  assert(reportText() === before, '拒绝时文件没变');
  await call('bili_config', { set: { perDay: 5 } });

  console.log('# 5. 判重表');
  r = await call('bili_seen', { record: { bvid: 'BV1tKs76bEyi', title: 't', up: 'u', status: '挑了' } });
  assert(r.ok && body(r).recorded.bvid === 'BV1tKs76bEyi', 'append ok');
  r = await call('bili_seen', { limit: 5 });
  assert(body(r).count === 1, '读到 1 条');
  r = await call('bili_seen', { bvid: 'BV1ccCCCCCCC'.toUpperCase() });
  assert(body(r).count === 0, '按 BV 查全表（查不到就是 0，不是报错）');

  console.log('# 6. bili_detail：字幕 / 无字幕 / 拉取失败 三种要分开');
  r = await call('bili_detail', { bvid: 'BV1tKs76bEyi' });
  assert(body(r).subtitle.available === true, '有字幕');
  assert(body(r).video.bvid === 'BV1tKs76bEyi', '带视频详情');
  r = await call('bili_detail', { bvid: 'BVnosubtitle' });
  assert(body(r).subtitle.available === false && !body(r).subtitle.failed, '没字幕轨：available=false 且不标 failed');
  assert(r.result.content[0].text.includes('没有字幕'), '文案说「没有字幕」');
  const stateAfterDetail = stateFile();
  assert(stateAfterDetail.covers && stateAfterDetail.covers.BV1tKs76bEyi, '封面记进 state.covers（卡片墙用）');
  r = await call('bili_detail', { bvid: 'BV1tKs76bEyi', subtitle: false });
  assert(body(r).subtitle === null, 'subtitle=false 不拉字幕');

  console.log('# 7. 评论：设置关 → 拒绝；开启后套话被拦、@ 规整、额度生效、记账失败不改判');
  r = await call('bili_comment', { bvid: 'BV1tKs76bEyi', text: 'x', confirm: true });
  assert(!r.ok && r.errorCode === 'COMMENT_DISABLED', 'COMMENT_DISABLED');
  r = await call('bili_config', { set: { autoComment: true, mentionName: '阿康' } });
  assert(!r.ok && r.errorCode === 'CONFIRM_REQUIRED', '开自动评论需要 confirm');
  r = await call('bili_config', { set: { autoComment: true, mentionName: '阿康' }, confirm: true });
  assert(r.ok && body(r).config.autoComment === true, 'autoComment 已开');
  assert(body(r).config.mentionName === '阿康', 'mentionName 存下来了（以前会被丢掉）');
  r = await call('bili_comment', { bvid: 'BV1tKs76bEyi', text: '本期视频讲得很清楚，值得一看', confirm: true });
  assert(r.ok && body(r).blocked_by === 'style', '套话开头被拦');
  r = await call('bili_comment', { bvid: 'BV1tKs76bEyi', text: '@ 阿康 回收塔架的三段抱紧动作只有看了才说得出来', confirm: true });
  const sent = body(r);
  assert(sent.sent === true && sent.bookkeeping === 'ok', '正常评论发出');
  assert(files.get('seen.jsonl').includes('@阿康'), '@ 与昵称之间没有空格');
  r = await call('bili_comment', { bvid: 'BV1tKs76bEyi', text: '再来一条', confirm: true });
  assert(!r.ok && r.errorCode === 'COMMENT_BUDGET', '每日评论额度生效');

  console.log('# 8. 私信：默认关闭 / 超 500 字被拦 / 开启后能发');
  r = await call('bili_dm', { text: 'hi', confirm: true });
  assert(!r.ok && r.errorCode === 'DM_DISABLED', 'DM_DISABLED');
  await call('bili_config', { set: { dmMode: 'only', dmUid: 4242 }, confirm: true });
  r = await call('bili_dm', { text: 'x'.repeat(501), confirm: true });
  assert(!r.ok && r.errorCode === 'DM_TOO_LONG', '501 字被拦（B站 上限 500）');
  r = await call('bili_dm', { text: 'x'.repeat(400), confirm: true });
  assert(r.ok && body(r).sent === true, '400 字发出');

  console.log('# 9. 回复：64 位 id 一律按字符串走；bili_inbox 给的 aid 也能直接回');
  r = await call('bili_reply', { bvid: 'BV1tKs76bEyi', rpid: '12', root: '11', text: '这个角度有意思', confirm: true });
  assert(!r.ok && r.errorCode === 'REPLY_DISABLED', 'REPLY_DISABLED');
  // 1.4.0 起「打开回复」也算打开一个会花钱 / 会对外说话的开关，必须带 confirm。
  await call('bili_config', { set: { replyToComments: true, replyPerRound: 2 }, confirm: true });
  const bigRpid = '1800000000000000123';
  r = await call('bili_reply', { aid: '555', rpid: bigRpid, root: '11', text: '这个角度有意思，抱紧那一下确实是关键', confirm: true });
  show('bili_reply(aid)', r);
  assert(r.ok && body(r).sent === true && body(r).replyTo === bigRpid, '用 aid 回复成功，且 rpid 末几位没被丢');
  assert(body(r).root === '11', '楼中楼挂在顶层评论 11 下');
  assert(typeof body(r).replyTo === 'string', 'replyTo 回的是字符串（数字过 2^53 会丢精度）');
  r = await call('bili_reply', { rpid: '12', text: 'x', confirm: true });
  assert(!r.ok && r.errorCode === 'BAD_REQUEST', '既没 bvid 也没 aid → BAD_REQUEST');

  console.log('# 10. 复核：写进日报「评论复核」一节，措辞只说「没查到」；刚发不到 90 秒的不查');
  const stateVerify = stateFile();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  // 前面几段刚发的评论也要「变老」：90 秒内的一律不查，那是审核延迟不是失败。
  (stateVerify.commentLog || []).forEach((item) => { item.at = fiveMinAgo; });
  stateVerify.commentLog = (stateVerify.commentLog || []).concat([
    { day: today(), bvid: 'BV1tKs76bEyi', rpid: 1, at: fiveMinAgo },
  ]);
  files.set('state.json', JSON.stringify(stateVerify));
  r = await call('bili_verify', {});
  show('bili_verify', r);
  assert(r.ok && body(r).checked === 2, '复核了两条');
  assert(body(r).results.some((x) => x.visible === true) && body(r).results.some((x) => x.visible === false), '可见 / 没查到 两种都报');
  assert(reportText().includes('## 评论复核'), '日报里有「评论复核」一节');
  assert(reportText().includes('公开可见') && reportText().includes('没查到'), '两种措辞都进日报');
  assert(reportText().includes('不带登录态也查得到'), '「公开可见」写明了是靠不带登录态那一遍确认的');
  assert(!/没发出去/.test(reportText()), '措辞里没有「没发出去」');
  r = await call('bili_verify', {});
  assert(r.ok && body(r).results.filter((x) => x.visible === true).every((x) => x.cached === true), '7 天内可见的直接用缓存');

  // 刚发出不到 90 秒：还在审核队列里，标成「还没查」而不是「没查到」。
  const stateFresh = stateFile();
  stateFresh.commentLog = [{ day: today(), bvid: 'BV1fresh1111', rpid: '1999999999999999999', at: new Date().toISOString() }];
  files.set('state.json', JSON.stringify(stateFresh));
  r = await call('bili_verify', {});
  show('bili_verify(刚发出)', r);
  assert(body(r).results[0].tooRecent === true && body(r).results[0].visible === null, '刚发出的标成 tooRecent，不查');
  assert(/还没查/.test(r.result.content[0].text) && !/没查到/.test(r.result.content[0].text), '文案写「还没查」而不是「没查到」');
  r = await call('bili_verify', { force: true });
  assert(body(r).results[0].tooRecent === undefined, 'force=true 时照查');

  console.log('# 10.1 复核要用「不带登录态」那一边判定：仅自己可见必须明说');
  // 实测踩过的坑：一条评论自己看得见、UP 主看不见、@ 也没提醒，老版本只查了自己
  // 那一遍，于是把「仅自己可见」报成了「公开可见」。
  const stateShadow = stateFile();
  stateShadow.commentLog = [
    { day: today(), bvid: 'BVshadow1111', rpid: '952', at: fiveMinAgo },
    { day: today(), bvid: 'BVgone111111', rpid: '42', at: fiveMinAgo },
    { day: today(), bvid: 'BVblocked111', rpid: '982', at: fiveMinAgo },
  ];
  files.set('state.json', JSON.stringify(stateShadow));
  r = await call('bili_verify', { force: true });
  show('bili_verify(仅自己可见)', r);
  const shadowHit = body(r).results.find((x) => x.rpid === '952');
  const goneHit = body(r).results.find((x) => x.rpid === '42');
  const blockedHit = body(r).results.find((x) => x.rpid === '982');
  assert(shadowHit && shadowHit.visible === false, '只有自己查得到 → 不算公开可见');
  assert(/只有你自己看得见/.test(shadowHit.detail || ''), '并且说清别人看不到');
  assert(goneHit && goneHit.visible === false, '两边都查不到 → 没查到');
  assert(blockedHit && blockedHit.visible === null, '匿名那一遍失败 → 判不了，不瞎报');
  assert(/匿名复查没做成/.test(blockedHit.detail || ''), '并说清是匿名复查没做成');
  assert(reportText().includes('别人看不到：只有你自己看得见'), '日报里也写清「别人看不到」，不写成公开');

  // 1.3.4 及以前按「自己看得到」判出来的缓存是错的，修好口径后不能接着用。
  const stateStale = stateFile();
  stateStale.commentLog = [{ day: today(), bvid: 'BVshadow1111', rpid: '952', at: fiveMinAgo }];
  stateStale.verify = { 952: { at: fiveMinAgo, visible: true } };   // 没有 v：旧口径的结论
  files.set('state.json', JSON.stringify(stateStale));
  r = await call('bili_verify', {});
  show('bili_verify(旧缓存)', r);
  assert(body(r).results[0].cached !== true, '旧口径的缓存不再命中');
  assert(body(r).results[0].visible === false, '重新判定后仍然是「不公开」');

  console.log('# 11. 卡片墙：日报 → 卡片 + 封面 + 收藏夹');
  r = await call('view_data', { kind: 'cards' });
  const cards = body(r);
  show('view_data(cards)', r);
  assert(cards.kind === 'cards' && cards.cards.length === 2, '拆出 2 张卡片');
  assert(cards.cards[0].bvid === 'BV1tKs76bEyi' && cards.cards[0].verdict === '值得看', '档位解析正确');
  assert(cards.cards[0].cover === 'https://i0.hdslb.com/x.jpg', '封面来自 detail 缓存');
  assert(Array.isArray(cards.folders) && cards.folders.length === 2, '收藏夹列表');
  r = await call('open_view', { intent: 'cards' });
  assert(body(r).intent === 'cards', 'open_view(cards)');

  console.log('# 12. 一轮的生命周期：锁 → 记成跑成 → segment_done；崩了三次 → tries_exhausted');
  r = await call('bili_round', {});
  assert(body(r).go === true, '自动轮放行');
  const autoId = body(r).roundId;
  assert(body(r).autoRound === 1, '今天是第 1 次自动轮');
  r = await call('bili_round', { action: 'finish', status: 'ok', roundId: autoId });
  assert(body(r).autoRound === 1 && body(r).finished === true, 'finish 记下这是第几次自动轮');
  assert(lastMirror.state.runs === 1, '镜像里 runs=1');
  r = await call('bili_round', {});
  assert(body(r).reason === 'segment_done', '同一天再自动开 → segment_done（这一段的上限已满）');
  r = await manualRound();
  assert(body(r).go === true, 'manual=true 不受每日轮次限制');
  assert(body(r).autoRound === null, '手动轮不算自动轮次');
  await call('bili_round', { action: 'finish', roundId: body(r).roundId });

  const stateA = stateFile();
  stateA.gate = { day: today(), runs: 0, starts: {}, manualExtra: 0 };
  stateA.roundLock = null;
  files.set('state.json', JSON.stringify(stateA));
  for (let i = 1; i <= 3; i += 1) {
    r = await call('bili_round', {});
    assert(body(r).go === true, '第 ' + i + ' 次放行（模型随后崩掉）');
    assert(lastMirror.state.starts['0#0'] === i, "starts['0#0']=" + i);
    expireLock();
  }
  r = await call('bili_round', {});
  assert(body(r).reason === 'tries_exhausted', '第 4 次 tries_exhausted');

  console.log('# 13. 日报形态 off：append 拒绝，额度靠判重表，finish 照样算一轮');
  await call('bili_config', { set: { reportLevel: 'off' } });
  const stateB = stateFile();
  stateB.gate = { day: today(), runs: 0, starts: {}, manualExtra: 0 };
  stateB.roundLock = null;
  files.set('state.json', JSON.stringify(stateB));
  reportText();
  files.delete('out/' + today() + '.md');
  r = await call('bili_round', {});
  assert(body(r).go === true, 'off 状态下自动轮放行');
  const roundOff = body(r).roundId;
  r = await call('bili_report_append', { text: '### BV1ddddddddd\nx\n**档位**：可以看' });
  assert(body(r).written === false && body(r).reason === 'reportLevel=off', 'append 明确拒绝并给出替代做法');
  r = await call('bili_seen', { record: { bvid: 'BV1ddddddddd', title: 'x', status: '挑了' } });
  // 判重表里今天有两条「挑了」(#5 的 BV1tKs76bEyi + 这里的 BV1ddddddddd)，off 时额度就看这个。
  assert(lastMirror.state.pickedAuto === 2, 'off 时额度来自判重表的「挑了」');
  r = await call('bili_round', { action: 'finish', status: 'ok', roundId: roundOff });
  assert(lastMirror.state.runs === 1, 'off 时 finish 仍然把这一天算成跑过一轮（以前这里会漏）');
  assert(!files.has('out/' + today() + '.md'), 'off 时不写日报');
  await call('bili_config', { set: { reportLevel: 'full' } });

  console.log('# 14. 日报读盘失败时 append 必须拒绝（不能整份覆盖）');
  const stateC = stateFile();
  stateC.gate = { day: today(), windows: {}, starts: {}, manualExtra: 0 };
  stateC.roundLock = null;
  files.set('state.json', JSON.stringify(stateC));
  files.set('out/' + today() + '.md', '# B站日报 · ' + today() + '\n\n### BV1eeeeeeeee\n已有的\n**档位**：值得看\n');
  failRead = 'out/' + today() + '.md';
  r = await call('bili_report_append', { text: '### BV1fffffffff\n新的\n**档位**：可以看' });
  show('bili_report_append(读失败)', r);
  assert(!r.ok && r.errorCode === 'FS_READ_FAILED', 'FS_READ_FAILED');
  assert(reportText().includes('BV1eeeeeeeee'), '原内容还在');

  console.log('# 15. 设置读失败时不能把默认值写回去');
  const kvBefore = JSON.stringify(kv);
  kvBroken = true;
  r = await call('bili_config', { set: { perDay: 3 } });
  show('bili_config(读失败)', r);
  assert(!r.ok && r.errorCode === 'CONFIG_UNAVAILABLE', 'CONFIG_UNAVAILABLE');
  assert(JSON.stringify(kv) === kvBefore, '设置没被覆盖');
  kvBroken = false;

  console.log('# 16. 退出登录');
  r = await call('bili_config', { action: 'logout', confirm: true });
  assert(r.ok && body(r).loggedOut === true, '凭证已清');
  // 镜像里不再放账号昵称：脚本不读它，没必要把使用者的昵称在家目录里再存一份。
  assert(lastMirror.state.loggedIn === false && lastMirror.state.account === undefined, '镜像 loggedIn=false，不再带账号昵称');
  r = await call('bili_round', {});
  assert(body(r).reason === 'not_logged_in', '之后要求重新登录');

  console.log('# 17. 退出登录没真删掉时必须报错，不能假装成功');
  files.set('credential.json', JSON.stringify({ sessdata: 'x', bili_jct: 'y', dedeuserid: '1' }));
  deleteNoop = true;
  r = await call('bili_config', { action: 'logout', confirm: true });
  show('bili_config(logout 没删掉)', r);
  assert(!r.ok && r.errorCode === 'LOGOUT_FAILED', 'LOGOUT_FAILED');
  assert(files.has('credential.json'), '凭证文件确实还在');
  deleteNoop = false;
  r = await call('bili_config', { action: 'logout', confirm: true });
  assert(r.ok && body(r).loggedOut === true, '真删掉之后才报成功');
  files.set('credential.json', JSON.stringify({ sessdata: 'x', bili_jct: 'y', dedeuserid: '1' }));

  console.log('# 18. 评论额度按「轮」算：同一轮第二条被拦，下一轮重新有额度');
  // 私信测试把 dmMode 设成了 only —— 那本身就意味着「不公开评论」，这里先改回 both。
  await call('bili_config', { set: { dmMode: 'both', autoComment: true, commentPerRound: 1, perDay: 0 }, confirm: true });
  await call('bili_config', { set: { manualCooldownMin: 0 } });
  r = await manualRound();
  const roundA = body(r).roundId;
  assert(body(r).budget.comment === 1, '新一轮有 1 条评论额度');
  r = await call('bili_comment', { bvid: 'BV1aaaaaaaab', text: '抱紧动作的三段分解，只有看了才说得出来', confirm: true });
  assert(r.ok && body(r).sent === true, '第一条发出');
  r = await call('bili_comment', { bvid: 'BV1aaaaaaaac', text: '这段收音比官方直播清楚多了', confirm: true });
  show('bili_comment(同一轮第二条)', r);
  assert(!r.ok && r.errorCode === 'COMMENT_BUDGET', '同一轮第二条被拦（以前按天算）');
  r = await call('bili_comment', { bvid: 'BV1aaaaaaaab', text: '换个说法再来一条', confirm: true });
  assert(!r.ok, '同一视频再评论被拦');
  assert(r.errorCode === 'COMMENT_BUDGET' || r.errorCode === 'COMMENT_DUPLICATE', '拦得住（额度或重复）');
  await call('bili_round', { action: 'finish', roundId: roundA });
  r = await manualRound();
  assert(r.ok && body(r).budget.comment === 1, '下一轮重新有 1 条额度（不是「今天已经发过」）');

  console.log('# 19. finish 带错 roundId → 拒绝收尾，不把别人那一轮收掉');
  const liveRound = stateFile().roundLock;
  r = await call('bili_round', { action: 'finish', roundId: 'r-stale-token' });
  show('bili_round(finish 错 token)', r);
  assert(!r.ok === false && body(r).reason === 'round_mismatch', 'round_mismatch');
  assert(stateFile().roundLock && stateFile().roundLock.token === liveRound.token, '这一轮的锁还在（没被误收）');

  console.log('# 20. 同样的视频只评论一次（换个说法也不行）');
  await call('bili_round', { action: 'finish', roundId: liveRound.token });
  await manualRound();
  r = await call('bili_comment', { bvid: 'BV1aaaaaaaab', text: '换个角度：这段时长控制得比新闻稿好', confirm: true });
  show('bili_comment(重复 BV)', r);
  assert(!r.ok && r.errorCode === 'COMMENT_DUPLICATE', 'COMMENT_DUPLICATE');

  console.log('# 21. 闸门脚本加的 hookStarts 必须被插件收回记账（且只收今天那份）');
  nextHookStarts = { all: 2 };
  nextHookDay = today();
  await call('bili_config', {});
  assert(stateFile().hookStarts && stateFile().hookStarts.all === 2, 'state.hookStarts 收到了脚本的计数');
  assert(stateFile().hookStartsDay === today(), '记账上标的是今天');
  // 跨零点那一拍：脚本昨天记的「试满 3 次」不能被当成今天的——否则插件判 tries_exhausted，
  // 而 precheck 那边按 hookDay 认为今天还没试过，两边结论相反。
  nextHookStarts = { all: 3 };
  nextHookDay = '2020-01-01';
  await call('bili_config', {});
  assert(stateFile().hookStarts.all === 2, '别的日子的计数没被收进来');
  nextHookStarts = null;
  nextHookDay = '';
  const gateBefore = stateFile().gate;
  failRead = 'state.json';
  r = await call('bili_config', {});
  assert(r.ok, '读盘失败时 config 不该失败');
  assert(JSON.stringify(stateFile().gate) === JSON.stringify(gateBefore), '读失败时没有把记账冲掉');
  failRead = null;

  console.log('# 22. 记账文件读不出来时不能覆盖它');
  const stateRaw = files.get('state.json');
  files.set('state.json', '{ 这不是合法 JSON');
  r = await call('bili_seen', { record: { bvid: 'BV1ddddddddd', status: '挑了' } });
  show('bili_seen(state 坏)', r);
  assert(!r.ok && r.errorCode === 'STATE_UNAVAILABLE', 'STATE_UNAVAILABLE');
  assert(files.get('state.json') === '{ 这不是合法 JSON', '坏文件没被覆盖');
  files.set('state.json', stateRaw);

  console.log('# 23. 复核结果写进「这条评论自己那天」的日报');
  const stateV = stateFile();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  stateV.commentLog = (stateV.commentLog || []).concat([
    // 10 分钟前发的：过了 90 秒的「还没查」窗口，走真正的可见性检查
    { day: yesterday, bvid: 'BV1yesterday', rpid: '1900000000000000001', at: new Date(Date.now() - 600000).toISOString() },
  ]);
  files.set('state.json', JSON.stringify(stateV));
  r = await call('bili_verify', {});
  show('bili_verify(跨天)', r);
  assert(r.ok, 'verify 成功');
  assert((body(r).wroteDays || []).indexOf(yesterday) === -1, '昨天没有日报 → 不写（不硬造一份）');
  files.set('out/' + yesterday + '.md', '# B站日报 · ' + yesterday + '\n\n### BV1yesterday\n昨天挑的\n**档位**：可以看\n');
  r = await call('bili_verify', {});
  assert((body(r).wroteDays || []).indexOf(yesterday) !== -1, '昨天有日报 → 写进昨天那一份');
  assert((files.get('out/' + yesterday + '.md') || '').includes('## 评论复核'), '昨天日报里有「评论复核」一节');

  console.log('# 24. 私信投递设成 only 时不许公开评论');
  await call('bili_round', { action: 'finish', roundId: stateFile().roundLock.token });
  await call('bili_config', { set: { dmMode: 'only', autoComment: true, commentPerRound: 3 }, confirm: true });
  r = await manualRound();
  const roundOnly = body(r).roundId;
  assert(r.ok && body(r).budget.comment === 0, '开轮时评论额度就是 0');
  r = await call('bili_comment', { bvid: 'BV1onlymodex', text: '这条评论不该发出去', confirm: true });
  show('bili_comment(dmMode=only)', r);
  assert(!r.ok && r.errorCode === 'COMMENT_DISABLED', 'COMMENT_DISABLED');
  await call('bili_config', { set: { dmMode: 'both' }, confirm: true });
  await call('bili_round', { action: 'finish', roundId: roundOnly });

  console.log('# 25. 判重表读不出来时开轮：不给评论额度，且明确告诉模型');
  // 注意：文件「不存在」是正常状态（新装），只有「文件在、读失败」才算读不到——
  // 所以这里不删文件，只让这一次读盘失败。
  assert(files.has('seen.jsonl'), '前提：判重表文件存在');
  failRead = 'seen.jsonl';
  r = await manualRound();
  show('bili_round(判重表读失败)', r);
  console.log('    seenUnavailable=' + String(body(r).seenUnavailable)
    + ' commentBudget=' + String(body(r).budget && body(r).budget.comment));
  assert(r.ok && body(r).seenUnavailable === true, 'seenUnavailable=true');
  assert(body(r).budget.comment === 0, '评论额度压到 0（别把「读不到」当成「没刷过」）');
  failRead = null;
  await call('bili_round', { action: 'finish', roundId: body(r).roundId });
  r = await manualRound();
  assert(body(r).seenUnavailable === false && body(r).budget.comment === 3, '读得到时恢复额度');
  await call('bili_round', { action: 'finish', roundId: body(r).roundId });

  console.log('# 26. 回复比评论更短：101 字必须被拦（章程与工具描述都写 100）');
  await call('bili_config', { set: { replyToComments: true, replyPerRound: 2 }, confirm: true });
  // 1.4.0：回复只属于互动轮，刷视频轮里调用会被拒（REPLY_OUTSIDE_INTERACTION）。
  // 这一段测的是长度闸门，所以先把刚开的手动轮收尾，走「没有轮次时」的临时写入路径。
  const roundLen = body(await manualRound()).roundId;
  await call('bili_round', { action: 'finish', roundId: roundLen });
  const longReply = '好'.repeat(101);
  r = await call('bili_reply', { bvid: 'BV1aaaaaaaab', rpid: '1900000000000000002', text: longReply, confirm: true });
  show('bili_reply(101 字)', r);
  assert(r.ok && body(r).blocked_by === 'style', '被风格闸门拦下');
  assert(String(body(r).reason || '').includes('100'), '原因里说的是 100 字上限');
  r = await call('bili_reply', { bvid: 'BV1aaaaaaaab', rpid: '1900000000000000002', text: '好'.repeat(80), confirm: true });
  assert(r.ok && body(r).sent === true, '80 字能发');

  console.log('# 27. 负数收藏夹 / 负数 UID 不能原样发出去');
  // mentionName 前面设成了「阿康」，不清掉的话负数 UID 会落回昵称解析、真的发出去
  await call('bili_config', { set: { favFolderId: 0, dmUid: 0, mentionName: '' }, confirm: true });
  // 私信额度是「每轮一条」，前面 ad-hoc 那一轮已经用掉了，这里先正经开一轮
  await call('bili_config', { set: { dmMode: 'both' }, confirm: true });
  r = await manualRound();
  const roundNeg = body(r).roundId;
  r = await call('bili_favorite', { bvid: 'BV1aaaaaaaab', folderId: -5, confirm: true });
  show('bili_favorite(folderId=-5)', r);
  assert(!r.ok && r.errorCode === 'NO_FOLDER', '负数被当成没配置（不是「收藏到 -5」）');
  r = await call('bili_dm', { text: '测试正文', uid: -1, confirm: true });
  show('bili_dm(uid=-1)', r);
  assert(!r.ok && r.errorCode === 'NO_RECIPIENT', '负数 UID 落回「没填 UID」，而不是发给 -1');
  await call('bili_round', { action: 'finish', roundId: roundNeg });

  console.log('# 28. 「文件不存在」不能当成「读失败」（新装 / 新的一天）');
  files.delete('seen.jsonl');
  r = await manualRound();
  assert(r.ok && body(r).seenUnavailable === false, '判重表还不存在 → 不算读失败');
  await call('bili_round', { action: 'finish', roundId: body(r).roundId });
  files.delete('out/' + today() + '.md');
  r = await call('bili_report_append', { text: '### BV1freshdayx\n新的一天\n**档位**：可以看' });
  show('bili_report_append(今天还没有日报)', r);
  assert(r.ok, '今天还没有日报也能新建');
  assert(reportText().includes('BV1freshdayx'), '确实写进去了');

  // 这一段之后要用干净的额度设置，先把可能被前面段落改过的项归位。
  await call('bili_config', {
    confirm: true,
    set: {
      perDay: 0, peakValley: false, manualCooldownMin: 0, reportLevel: 'full',
      autoComment: false, commentPerRound: 1, dmMode: 'off', replyToComments: false,
    },
  });
  const cleanState = () => {
    const s = stateFile();
    s.gate = { day: today(), runs: 0, starts: {}, manualExtra: 0 };
    s.roundLock = null;
    delete s.hookStarts;
    delete s.hookStartsDay;
    files.set('state.json', JSON.stringify(s));
    return s;
  };

  console.log('# 29. bili_browse：seen 标记（以前 seenSet 根本没定义，整个工具抛 ReferenceError）');
  cleanState();
  files.set('seen.jsonl', JSON.stringify({ day: today(), bvid: 'BV1tKs76bEyi', title: 'x', status: '跳过' }) + '\n');
  r = await call('bili_browse', { source: 'search', keyword: '星舰' });
  show('bili_browse', r);
  assert(r.ok, 'bili_browse 不再抛错');
  let vids = body(r).videos || [];
  assert(vids.some((v) => v.bvid === 'BV1tKs76bEyi' && v.seen === true), '判重表里有的标 seen=true');
  assert(vids.some((v) => v.bvid === 'BV1neverseen' && v.seen === false), '判重表里没有的标 seen=false');
  assert(body(r).seenUnavailable === false, '读得到时 seenUnavailable=false');
  // 判重表读不到：seen 必须是 null（不是 false），并且明说这一轮别评论
  failRead = 'seen.jsonl';
  r = await call('bili_browse', { source: 'recommend' });
  vids = body(r).videos || [];
  assert(body(r).seenUnavailable === true, '判重表读不到时 seenUnavailable=true');
  assert(vids.length > 0 && vids.every((v) => v.seen === null), '一条都不许标成「没刷过」');

  console.log('# 30. 闸门脚本的 hookStarts 必须按天算（昨天试满 3 次不该挡住今天）');
  const stale = cleanState();
  // 1.4.0 的槽位是「段键#段内第几轮」，默认整天段的槽位是 '0#0'（1.3.x 写的是裸 '0'）。
  stale.hookStarts = { '0#0': 3 };
  stale.hookStartsDay = '2020-01-01';
  files.set('state.json', JSON.stringify(stale));
  r = await call('bili_round', {});
  show('bili_round(昨天试满)', r);
  assert(body(r).go === true, '昨天的 3 次不算今天');
  await call('bili_round', { action: 'finish', roundId: body(r).roundId });
  const sameDay = cleanState();
  sameDay.hookStarts = { '0#0': 3 };
  sameDay.hookStartsDay = today();
  files.set('state.json', JSON.stringify(sameDay));
  r = await call('bili_round', {});
  assert(body(r).reason === 'tries_exhausted', '今天这一轮试满 3 次 → tries_exhausted');

  console.log('# 31. 并发两条 bili_report_append：两条都要落盘');
  cleanState();
  files.delete('out/' + today() + '.md');
  const [appendA, appendB] = await Promise.all([
    call('bili_report_append', { text: '### BV1concAAAAA\n甲 / up / 01:00 / 1万播放\n**档位**：可以看' }),
    call('bili_report_append', { text: '### BV1concBBBBB\n乙 / up / 02:00 / 2万播放\n**档位**：可以看' }),
  ]);
  assert(appendA.ok && appendB.ok, '两条都返回成功');
  assert(reportText().includes('BV1concAAAAA') && reportText().includes('BV1concBBBBB'),
    '两条都在日报里（没有后写盖前写）');

  console.log('# 32. 并发两条评论：每轮 1 条的额度必须挡住第二条');
  await call('bili_config', { set: { autoComment: true, commentPerRound: 1, dmMode: 'off' }, confirm: true });
  files.delete('seen.jsonl');
  r = await manualRound();
  const concurrentRound = body(r).roundId;
  const comments = await Promise.all([
    call('bili_comment', {
      bvid: 'BV1concAAAAA', confirm: true,
      text: '塔架开合那段的时机我回看了三次，比新闻稿清楚得多',
    }),
    call('bili_comment', {
      bvid: 'BV1concBBBBB', confirm: true,
      text: '三级回收那一段把时间轴拆得很细，值得单独存一份',
    }),
  ]);
  const sentCount = comments.filter((x) => x.ok && body(x).sent === true).length;
  const budgetBlocked = comments.filter((x) => !x.ok && x.errorCode === 'COMMENT_BUDGET').length;
  show('bili_comment(并发)', comments[0]);
  assert(sentCount === 1 && budgetBlocked === 1, '并发两条评论只发出去一条（额度在锁里判断）');

  console.log('# 33. 只读工具要给这一轮的锁续期（否则读字幕读久了锁会过期）');
  const staged = stateFile();
  staged.roundLock = Object.assign({}, staged.roundLock, {
    at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  files.set('state.json', JSON.stringify(staged));
  const lockBefore = stateFile().roundLock.at;
  await call('bili_comments', { bvid: 'BV1concAAAAA' });
  const lockAfter = stateFile().roundLock.at;
  assert(lockBefore !== lockAfter, '锁的 at 被刷新了');
  assert(Date.now() - Date.parse(lockAfter) < 60 * 1000, '刷新成「刚刚」');

  console.log('# 34. 没有 `### BV` 的段落不能写进日报（否则能绕开每日额度）');
  r = await call('bili_report_append', { text: '这一轮没什么值得看的，跳过 3 条。' });
  show('bili_report_append(无 BV)', r);
  assert(!r.ok && r.errorCode === 'BAD_REQUEST', '被拒绝并说明格式');
  await call('bili_round', { action: 'finish', roundId: concurrentRound });

  console.log('# 35. 凭证坏了 / 读不到，不能都报成「没登录」');
  files.set('credential.json', '{这不是 JSON');
  r = await manualRound();
  show('bili_round(凭证坏)', r);
  assert(body(r).reason === 'credential_corrupt', '坏凭证报 credential_corrupt');
  files.set('credential.json', JSON.stringify({ sessdata: 'x', bili_jct: 'y', dedeuserid: '1' }));
  // 把「上次已知是登录着的」摆回去：否则读到的是上一段坏凭证留下的 false，
  // 验不出「这一拍读盘失败有没有把它写成 false」。
  const beforeUnreadable = stateFile();
  beforeUnreadable.loggedIn = true;
  files.set('state.json', JSON.stringify(beforeUnreadable));
  lastMirror = null;
  failRead = 'credential.json';
  r = await manualRound();
  show('bili_round(凭证读不到)', r);
  assert(body(r).reason === 'credential_unreadable', '读盘失败报 credential_unreadable（不请人重新扫码）');
  assert(lastMirror !== null, '读盘失败也照样同步了值班镜像（闸门要知道今天的状态）');
  assert(lastMirror.state.loggedIn !== false, '读盘失败不把 loggedIn=false 写进值班镜像');

  console.log('# 36. 手动轮一天有上限（manual=true 不是绕过闸门的后门）');
  let s36 = cleanState();
  s36.manualDay = today();
  s36.manualCount = 4;
  files.set('state.json', JSON.stringify(s36));
  r = await call('bili_round', { manual: true });
  show('bili_round(手动第 5 轮)', r);
  assert(body(r).go === false && body(r).reason === 'manual_capped', '第 5 轮被 manual_capped 挡住');
  s36 = cleanState();
  s36.manualDay = '2020-01-01';
  s36.manualCount = 4;
  files.set('state.json', JSON.stringify(s36));
  r = await call('bili_round', { manual: true });
  assert(body(r).go === true, '昨天的计数不带进今天');
  await call('bili_round', { action: 'finish', roundId: body(r).roundId });

  console.log('# 37. 手动一轮最多挑 manualMax 条（以前只是 budget 里的一句话，模型不照做就没人管）');
  await call('bili_config', { set: { perDay: 0, manualMax: 1, manualCooldownMin: 0 }, confirm: true });
  cleanState();
  files.delete('out/' + today() + '.md');
  r = await manualRound();
  const manualRoundId = body(r).roundId;
  assert(body(r).budget.picks === 1, 'budget 里说这一轮 1 条');
  r = await call('bili_report_append', { text: '### BV1manualc01\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(r.ok, '第一条写进去了');
  r = await call('bili_report_append', { text: '### BV1manualc02\n标题 / UP / 11:00 / 2万播放\n**档位**：可以看' });
  show('bili_report_append(手动第 2 条)', r);
  assert(!r.ok && r.errorCode === 'QUOTA_EXCEEDED', '第 2 条被手动上限挡住');
  await call('bili_round', { action: 'finish', roundId: manualRoundId });

  console.log('# 38. 手动轮挑的不吃自动额度（以前 bili_round 说还剩 2 条，append 却全拒）');
  await call('bili_config', {
    set: { perDay: 2, manualMax: 2, peakValley: false, noon: true, night: true, manualCooldownMin: 0 },
    confirm: true,
  });
  cleanState();
  files.delete('out/' + today() + '.md');
  r = await manualRound();
  const mixRoundId = body(r).roundId;
  r = await call('bili_report_append', { text: '### BV1mixmanua1\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(r.ok && body(r).quota.left === 2, '手动挑了 1 条之后，自动额度还是 2（不是 1）');
  await call('bili_round', { action: 'finish', roundId: mixRoundId });
  r = await call('bili_round', {});
  show('bili_round(手动之后开自动轮)', r);
  assert(body(r).go === true && body(r).budget.picks === 2, '手动的条数不算进自动额度');
  const autoRoundId = body(r).roundId;
  r = await call('bili_report_append', { text: '### BV1mixauto01\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  show('bili_report_append(自动第 1 条)', r);
  assert(r.ok, '自动轮第一条写得进去');
  r = await call('bili_report_append', { text: '### BV1mixauto02\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(r.ok, '自动轮第二条写得进去（承诺的 2 条真的能花掉）');
  r = await call('bili_report_append', { text: '### BV1mixauto03\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(!r.ok && r.errorCode === 'QUOTA_EXCEEDED', '第 3 条才超额度');
  await call('bili_round', { action: 'finish', roundId: autoRoundId });

  console.log('# 39. 日报读不到时不许开轮（否则整轮白烧，写下去必然 FS_READ_FAILED）');
  cleanState();
  files.set('out/' + today() + '.md', '# B站日报 · ' + today() + '\n\n### BV1readfail1\nx\n**档位**：可以看\n');
  // 持续失败：1.5.0 起 bili_round 开跑前会先读一次日报（要给分派判额度），
  // 一次性失败会被那一次读消耗掉，测不到「开轮前就拦住」。
  failPaths.add('out/' + today() + '.md');
  r = await call('bili_round', {});
  show('bili_round(日报读不到)', r);
  assert(body(r).go === false && body(r).reason === 'report_unreadable', '开轮前就拦住');
  failPaths.delete('out/' + today() + '.md');

  console.log('# 40. 私信正文里有 @ 直接拒（章程写了，但以前没人执行）');
  cleanState();
  await call('bili_config', { set: { dmMode: 'only', dmUid: 42 }, confirm: true });
  r = await call('bili_dm', { text: '今天这三条值得看 @某人 一起看', confirm: true });
  show('bili_dm(带 @)', r);
  assert(!r.ok && r.errorCode === 'DM_NO_MENTION', 'DM_NO_MENTION');
  await call('bili_config', { set: { dmMode: 'off' }, confirm: true });

  console.log('# 41. 日报形态 off：判重表里的「挑了」也受手动上限管，重复记不重复计数');
  await call('bili_config', { set: { reportLevel: 'off', perDay: 0, manualMax: 1, manualCooldownMin: 0 }, confirm: true });
  cleanState();
  files.delete('seen.jsonl');
  r = await manualRound();
  const offRoundId = body(r).roundId;
  r = await call('bili_seen', { record: { bvid: 'BV1offpick01', status: '挑了' } });
  assert(r.ok, '第一条「挑了」记上了');
  r = await call('bili_seen', { record: { bvid: 'BV1offpick02', status: '挑了' } });
  show('bili_seen(off 第 2 条)', r);
  assert(!r.ok && r.errorCode === 'QUOTA_EXCEEDED', '第 2 条被手动上限挡住（off 形态以前完全不设防）');
  const extraBefore = stateFile().gate ? Number(stateFile().gate.manualExtra) || 0 : 0;
  r = await call('bili_seen', { record: { bvid: 'BV1offpick01', status: '挑了' } });
  assert(r.ok, '重复记同一个 BV 允许（幂等记账）');
  const extraAfter = stateFile().gate ? Number(stateFile().gate.manualExtra) || 0 : 0;
  assert(extraAfter === extraBefore, 'manualExtra 不因重复记而 +1（否则自动额度被虚高）');
  await call('bili_round', { action: 'finish', roundId: offRoundId });

  console.log('# 42. 锁过期后写的条目仍属于那一轮（手动上限不能因为读字幕超时就失效）');
  await call('bili_config', { set: { reportLevel: 'full', perDay: 0, manualMax: 1, manualCooldownMin: 0 }, confirm: true });
  cleanState();
  files.delete('out/' + today() + '.md');
  r = await manualRound();
  const staleId = body(r).roundId;
  r = await call('bili_report_append', { text: '### BV1stale0001\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(r.ok, '第一条写进去了');
  expireLock();
  r = await call('bili_report_append', { text: '### BV1stale0002\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  show('bili_report_append(锁过期后)', r);
  assert(!r.ok && r.errorCode === 'QUOTA_EXCEEDED', '锁过期也不放过第 2 条');

  console.log('# 43. 隔夜的残留锁不再认领今天的写入（不能把记账和日期一起拽回去）');
  await call('bili_config', { set: { reportLevel: 'full', perDay: 5, manualMax: 3, manualCooldownMin: 0 }, confirm: true });
  const s43 = cleanState();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  s43.gate = { day: today(), runs: 1, starts: { 0: 1 }, manualExtra: 0 };
  s43.roundLock = {
    token: 'r-ancient-1', day: threeDaysAgo, slot: '1', manual: true, picks: 2,
    at: new Date(Date.now() - 3 * 86400000).toISOString(),
  };
  files.set('state.json', JSON.stringify(s43));
  files.delete('out/' + today() + '.md');
  r = await call('bili_report_append', { text: '### BV1ancient01\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  show('bili_report_append(残留锁)', r);
  assert(r.ok && body(r).day === today(), '写进今天的日报，不是三天前那份');
  const s43after = stateFile();
  // 1.4.0 起记账按段存（旧的 runs:1 读进来会迁成 seg['0'] = 1），不再写 gate.runs。
  assert(s43after.gate.day === today() && s43after.gate.starts['0'] === 1 && s43after.gate.seg['0'] === 1,
    '今天的记账没被一份全零的旧账覆盖');
  assert(s43after.roundLock.picks === 2 && s43after.roundLock.at === s43.roundLock.at,
    '残留锁没被认领，也没被续期');

  console.log('# 44. 僵尸轮次的写入（带 roundId）不能记到新一轮头上');
  cleanState();
  files.delete('out/' + today() + '.md');
  r = await manualRound();
  const zombieId = body(r).roundId;
  expireLock();
  r = await manualRound();
  const nextId = body(r).roundId;
  assert(nextId !== zombieId, '新一轮接管了锁');
  r = await call('bili_report_append', { roundId: zombieId, text: '### BV1zombie001\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  show('bili_report_append(僵尸 roundId)', r);
  assert(!r.ok && r.errorCode === 'ROUND_MISMATCH', '僵尸轮次的 append 被拒');
  r = await call('bili_seen', { roundId: zombieId, record: { bvid: 'BV1zombie001', status: '挑了' } });
  assert(!r.ok && r.errorCode === 'ROUND_MISMATCH', '僵尸轮次的 seen 同样被拒');
  r = await call('bili_report_append', { roundId: nextId, text: '### BV1zombie002\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(r.ok, '新一轮自己的写入照常');
  await call('bili_round', { action: 'finish', roundId: nextId });

  console.log('# 45. 手动轮重写同一条不算新额度（纯改写不该被上限拦）');
  await call('bili_config', { set: { reportLevel: 'full', perDay: 0, manualMax: 1, manualCooldownMin: 0 }, confirm: true });
  cleanState();
  files.delete('out/' + today() + '.md');
  r = await manualRound();
  const rewriteId = body(r).roundId;
  r = await call('bili_report_append', { text: '### BV1rewrite01\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(r.ok, '第一条写进去了');
  r = await call('bili_report_append', { text: '### BV1rewrite01\n标题（改写）/ UP / 10:00 / 1万播放\n**档位**：值得看' });
  show('bili_report_append(重写同一条)', r);
  assert(r.ok && body(r).selectedToday === 1, '同一个 BV 再写一遍不占新额度');
  await call('bili_round', { action: 'finish', roundId: rewriteId });

  console.log('# 46. 私信里的邮箱 / 裸 @ 不该被当成 @ 人');
  await call('bili_config', { set: { dmMode: 'both', dmUid: 42 }, confirm: true });
  const s46 = cleanState();
  s46.dmLog = [];
  files.set('state.json', JSON.stringify(s46));
  r = await call('bili_dm', { text: '今天的日报：素材见 me@example.com，另外价格@ 300 元那事没提', confirm: true });
  show('bili_dm(邮箱)', r);
  assert(r.ok, '邮箱和裸 @ 不触发 DM_NO_MENTION');
  r = await call('bili_dm', { text: '今天 @张三 也看了这条', confirm: true });
  assert(!r.ok && r.errorCode === 'DM_NO_MENTION', '@昵称 仍然拒');
  await call('bili_config', { set: { dmMode: 'off' }, confirm: true });

  console.log('# 47. 收尾也认「过期但还属于这一轮」的锁（跨零点那一轮不能按今天收）');
  await call('bili_config', { set: { reportLevel: 'full', perDay: 5, manualMax: 2, manualCooldownMin: 0 }, confirm: true });
  cleanState();
  r = await manualRound();
  const lateId = body(r).roundId;
  const s47 = stateFile();
  s47.roundLock.day = yesterday;
  s47.roundLock.slot = '1';
  s47.roundLock.at = new Date(Date.now() - 13 * 60 * 1000).toISOString();
  files.set('state.json', JSON.stringify(s47));
  files.set('out/' + yesterday + '.md', '# B站日报 · ' + yesterday + '\n\n### BV1latest001\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看\n');
  r = await call('bili_round', { action: 'finish' });
  show('bili_round(finish 不带 token)', r);
  assert(body(r).finished === false && body(r).reason === 'round_required', '过期的锁也要求带 roundId');
  r = await call('bili_round', { action: 'finish', roundId: lateId });
  show('bili_round(finish 过期锁)', r);
  assert(body(r).finished === true && body(r).day === yesterday,
    '按这一轮开始那天收尾');
  assert(stateFile().gate.day === today(), '今天的记账没被拨回昨天');
  assert(stateFile().roundLock === null, '锁放掉了');

  console.log('# 48. 锁已经收掉 / 超过 2 小时时，带 roundId 的写入算「这一轮结束了」而不是 ad-hoc');
  cleanState();
  files.delete('out/' + today() + '.md');
  r = await manualRound();
  const doneId = body(r).roundId;
  await call('bili_round', { action: 'finish', roundId: doneId });
  r = await call('bili_report_append', { roundId: doneId, text: '### BV1finished1\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  show('bili_report_append(轮次已收)', r);
  assert(!r.ok && r.errorCode === 'ROUND_MISMATCH', '收尾之后的写入被拒（不降级成 ad-hoc）');
  r = await call('bili_report_append', { text: '### BV1adhoc0001\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(r.ok, '不带 roundId 的照旧按 ad-hoc 写');
  const s48 = stateFile();
  s48.roundLock = {
    token: 'r-tooold', day: today(), slot: '', manual: false, picks: 0,
    at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  };
  files.set('state.json', JSON.stringify(s48));
  r = await call('bili_report_append', { roundId: 'r-tooold', text: '### BV1toooold01\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(!r.ok && r.errorCode === 'ROUND_MISMATCH', '超过 2 小时的锁也不再认领');
  cleanState();

  console.log('# 49. BV 号后面必须断开（按前 10 位截断会把两个视频塌成一条）');
  files.delete('out/' + today() + '.md');
  r = await call('bili_report_append', { text: '### BV1tKs76bEyi_\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  show('bili_report_append(id 带后缀)', r);
  assert(!r.ok && r.errorCode === 'BAD_REQUEST', 'id 后面紧跟标点被拒');
  r = await call('bili_report_append', { text: '### BV1tKs76bEyiX\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(!r.ok && r.errorCode === 'BAD_REQUEST', 'id 多一位也被拒');
  assert(!files.get('out/' + today() + '.md'), '两次都一个字没写');
  r = await call('bili_report_append', { text: '### BV1tKs76bEyi 星舰第 15 飞\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  assert(r.ok, '后面是空格的正常写法照常写进去');

  console.log('# 50. 收藏的投递记录落在这一轮自己那天（跨零点也能进对日报）');
  cleanState();
  // 1.4.0 起「设置里选了收藏夹」是这个功能的开关，folderId 参数不能代它打开。
  await call('bili_config', { set: { favFolderId: 123 }, confirm: true });
  r = await manualRound();
  const favId = body(r).roundId;
  const s50 = stateFile();
  s50.roundLock.day = yesterday;
  files.set('state.json', JSON.stringify(s50));
  r = await call('bili_favorite', { bvid: 'BV1favorite1', folderId: 123, confirm: true, roundId: favId });
  show('bili_favorite(跨零点轮次)', r);
  assert(r.ok, '收藏成功');
  const delivery = (stateFile().deliveries || []).slice(-1)[0];
  assert(delivery && delivery.kind === 'favorite' && delivery.day === yesterday,
    '投递记录记在昨天那一轮名下，不是今天');
  r = await call('bili_favorite', { bvid: 'BV1favorite2', folderId: 123, confirm: true, roundId: 'r-nope' });
  assert(!r.ok && r.errorCode === 'ROUND_MISMATCH', '收藏也认 roundId');
  cleanState();

  console.log('# 51. 没带 roundId 的收藏也按「当下在跑的那一轮」归日（跨零点不能记到今天）');
  cleanState();
  r = await manualRound();
  const favDayId = body(r).roundId;
  const s51 = stateFile();
  s51.roundLock.day = yesterday;
  files.set('state.json', JSON.stringify(s51));
  r = await call('bili_favorite', { bvid: 'BV1favday001', folderId: 123, confirm: true });
  show('bili_favorite(不带 roundId)', r);
  assert(r.ok, '不带 roundId 的收藏照常成功');
  const delivery51 = (stateFile().deliveries || []).slice(-1)[0];
  assert(delivery51 && delivery51.kind === 'favorite' && delivery51.day === yesterday,
    '投递记录跟着那一轮的日期（而不是今天）');
  assert(s51.roundLock && stateFile().roundLock.token === favDayId, '收藏没把那一轮的锁换掉');
  cleanState();

  console.log('# 52. 三种 ROUND_MISMATCH 说清各自的原因（别让人以为是同一个毛病）');
  cleanState();
  r = await manualRound();
  const wordId = body(r).roundId;
  const s52 = stateFile();
  s52.roundLock.at = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  files.set('state.json', JSON.stringify(s52));
  r = await call('bili_report_append', { roundId: wordId, text: '### BV1word00001\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  show('append(自己的 token 但锁超 2 小时)', r);
  assert(!r.ok && r.errorCode === 'ROUND_MISMATCH', '超过 2 小时的自己那轮也被拒');
  assert(/2 小时/.test(r.message || ''), '提示指向「这一轮超时作废」，不是「被别人接管」');

  cleanState();
  files.delete('out/' + today() + '.md');
  r = await manualRound();
  const goneId = body(r).roundId;
  await call('bili_round', { action: 'finish', roundId: goneId });
  r = await call('bili_round', { action: 'finish', roundId: goneId });
  show('bili_round(finish 重复一次)', r);
  assert(body(r).finished === false && body(r).reason === 'round_mismatch', '同一 token 再收一次被拒');
  assert(/已经收尾/.test(body(r).message || ''), '提示是「这一轮已经收尾」，不是「新一轮接管」');

  cleanState();
  r = await manualRound();
  const otherId = body(r).roundId;
  const s52b = stateFile();
  s52b.roundLock.token = 'r-somebody-else';
  files.set('state.json', JSON.stringify(s52b));
  r = await call('bili_report_append', { roundId: otherId, text: '### BV1word00002\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  show('append(锁是别人的)', r);
  assert(/接管/.test(r.message || ''), '提示是「被新一轮接管」并点出现任 token');
  assert((r.message || '').indexOf('r-somebody-else') >= 0, '把现任 roundId 直接告诉模型');
  cleanState();

  console.log('# 53. #### BV坏id 这种四级标题也要拦；代码围栏里的示例不拦');
  files.delete('out/' + today() + '.md');
  r = await call('bili_report_append', { text: '#### BV1deep0001X_\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看\n\n### BV1deep00002\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看' });
  show('append(#### 坏 id)', r);
  assert(!r.ok && r.errorCode === 'BAD_REQUEST' && /BV 号写错了/.test(r.message || ''), '四级标题里的坏 id 同样拒绝');
  assert(!files.get('out/' + today() + '.md'), '一个字没写');
  r = await call('bili_report_append', {
    text: '格式示例（这段不算条目）：\n\n```\n#### BV1fenced001X\n标题 / UP / 时长 / 播放\n```\n\n### BV1fenced002\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看',
  });
  show('append(围栏里有坏 id 的示例)', r);
  assert(r.ok, '围栏里的示例不影响正常写入');
  assert(body(r).selectedToday === 1, '只数了围栏外面那条');
  cleanState();

  console.log('# 54. 抢到锁那一刻再判一次轮次：这期间那一轮被收掉了就不再开第二轮');
  await call('bili_config', { set: { peakValley: false, perDay: 5, reportLevel: 'full' }, confirm: true });
  const s54 = cleanState();
  s54.gate = { day: today(), runs: 0, starts: {}, manualExtra: 0 };
  files.set('state.json', JSON.stringify(s54));
  files.delete('out/' + today() + '.md');
  // 第 1 次读是锁外那次判断，第 2 次是抢到锁之后的权威读。在第 2 次读之前把今天的
  // 轮次记成跑过——等价于「同一轮的 finish 正好插在这两步之间提交了」。
  stateReads = 0;
  onStateRead = function (n) {
    if (n !== 2) return;
    const mid = stateFile();
    mid.gate = { day: today(), runs: 1, starts: {}, manualExtra: 0 };
    files.set('state.json', JSON.stringify(mid));
  };
  r = await call('bili_round', {});
  onStateRead = null;
  show('bili_round(轮次在抢锁时用完了)', r);
  assert(!r.ok || body(r).go === false, '没有再开第二轮');
  assert((body(r).reason || '') === 'segment_done', '理由是这一段的自动轮次已经跑满（segment_done）');
  assert(!stateFile().roundLock, '没有落下新锁（否则 12 分钟里谁都开不了轮）');

  console.log('# 55. state.json 读不到时不写值班镜像（宁可旧，不要编一份空账）');
  const s55 = cleanState();
  s55.gate = { day: today(), runs: 1, starts: { 0: 2 }, manualExtra: 1 };
  s55.roundLock = { token: 'r55', day: today(), slot: '1', manual: false, picks: 0, at: new Date().toISOString() };
  files.set('state.json', JSON.stringify(s55));
  files.delete('credential.json');
  lastMirror = { marker: 'before' };
  failPaths.add('state.json');
  r = await call('bili_round', {});
  assert(!r.ok || body(r).reason === 'not_logged_in', '这条路径照常回「没登录」');
  // 1.4.0：记账读不到时**设置那半照样镜像**（config.json 不依赖记账），
  // state.json 不写——宁可旧，也不编一份空账。以前是整次同步一起放弃，
  // 结果设置页改了「互动轮开/关」在插件状态坏掉时永远同步不到闸门。
  assert(lastMirror && lastMirror.config && lastMirror.state === undefined,
    '读不到记账时只镜像设置，不写 state.json');
  failPaths.delete('state.json');
  files.set('credential.json', JSON.stringify({ sessdata: 'x', bili_jct: 'y', dedeuserid: '1', buvid3: 'a', buvid4: 'b' }));
  const s55b = stateFile();
  s55b.roundLock = null;
  files.set('state.json', JSON.stringify(s55b));
  lastMirror = { marker: 'before' };
  await call('bili_round', { manual: true });
  assert(lastMirror && lastMirror.marker !== 'before', '记账读得到时照常镜像（对照）');

  console.log('# 56. 日报形态 off 时判重表读不到，收尾照样算成功（只是条数没核对）');
  await call('bili_config', { set: { reportLevel: 'off', perDay: 5, manualMax: 3, manualCooldownMin: 0 }, confirm: true });
  cleanState();
  files.delete('seen.jsonl');
  r = await manualRound();
  const offId56 = body(r).roundId;
  assert(Boolean(offId56), '手动轮开起来了');
  failRead = 'seen.jsonl';
  r = await call('bili_round', { action: 'finish', roundId: offId56 });
  show('bili_round(finish + 判重表读不到)', r);
  assert(r.ok && body(r).finished === true, '收尾没有被报成失败（档位已经勾了，报失败只会让模型再调一次）');
  assert(body(r).countUnverified === true, '如实标出「条数没核对上」');
  assert(stateFile().roundLock === null, '锁已经放掉');
  await call('bili_config', { set: { reportLevel: 'full' }, confirm: true });
  cleanState();

  console.log('# 57. 日报在「锁外还读得到、锁里读不到」的那一刻，手动轮也不开');
  await call('bili_config', { set: { reportLevel: 'full', perDay: 5, manualMax: 3, manualCooldownMin: 0 }, confirm: true });
  cleanState();
  files.set('out/' + today() + '.md', '# B站日报 · ' + today() + '\n\n### BV1halfread1\n标题 / UP / 10:00 / 1万播放\n**档位**：可以看\n');
  // 第 1 次读日报是锁外那次额度判断，第 2 次是抢到锁之后的重判。让第 2 次失败。
  readCounts.clear();
  failReadAt = { key: 'out/' + today() + '.md', n: 2 };
  r = await call('bili_round', { manual: true });
  show('bili_round(manual，锁里日报读到一半坏了)', r);
  assert(!r.ok || body(r).go === false, '手动轮也不开（写进去会盖掉已挑的条目）');
  assert((body(r).reason || '') === 'report_unreadable', '理由是报告读不到');
  assert(!stateFile().roundLock, '没有落下锁（否则 12 分钟里谁都开不了轮）');
  failReadAt = null;
  cleanState();
  files.delete('out/' + today() + '.md');

  console.log('# 58. 每天最多自动跑几轮：设 2 就早晚各放行一次，第三次才拒');
  // 1.4.0 用段配额表达「一天 2 轮」：一段整天 ×2（autoRoundsPerDay 已经不存在）。
  await call('bili_config', { set: { segments: [{ start: '00:00', end: '24:00', rounds: 2 }], perDay: 5, reportLevel: 'full', manualCooldownMin: 0 }, confirm: true });
  cleanState();
  files.delete('out/' + today() + '.md');
  r = await call('bili_round', {});
  assert(body(r).go === true && body(r).autoRound === 1, '第一次自动轮：autoRound=1');
  r = await call('bili_round', { action: 'finish', status: 'ok', roundId: body(r).roundId });
  assert(body(r).finished === true, '第一次收尾');
  assert(lastMirror.state.runs === 1 && lastMirror.state.autoRoundsPerDay === 2, '镜像里 runs=1 / 上限 2');
  r = await call('bili_round', {});
  assert(body(r).go === true && body(r).autoRound === 2, '同一天第二次自动轮照常放行：autoRound=2');
  r = await call('bili_round', { action: 'finish', status: 'ok', roundId: body(r).roundId });
  assert(body(r).finished === true, '第二次收尾');
  assert(lastMirror.state.runs === 2, '镜像里 runs=2');
  r = await call('bili_round', {});
  assert(body(r).reason === 'segment_done', '第三次 → segment_done');
  assert(/2\/2 轮/.test(body(r).message), '说清这一段的上限是 2 轮');
  await call('bili_config', { set: { segments: [{ start: '00:00', end: '24:00', rounds: 1 }] }, confirm: true });

  console.log('# 59. 视频记忆：笔记写进判重表，下一轮开跑时带回来，候选上也挂一份');
  await call('bili_config', {
    set: { reportLevel: 'full', perDay: 5, manualMax: 3, manualCooldownMin: 0, autoRoundsPerDay: 1 },
    confirm: true,
  });
  cleanState();
  files.delete('seen.jsonl');
  files.delete('out/' + today() + '.md');
  r = await manualRound();
  let memId = body(r).roundId;
  assert(Boolean(memId), '开起一轮用来写笔记');
  r = await call('bili_seen', {
    record: { bvid: 'BV1tKs76bEyi', title: '星舰十五飞 全程回放', up: 'SpaceX中文', status: '跳过', note: '回收画面重复太多，讲了半小时没给数据，看标题就够了' },
    roundId: memId,
  });
  show('bili_seen(记笔记)', r);
  assert(r.ok && /回收画面/.test(body(r).recorded.note || ''), 'note 原样记进判重表');
  r = await call('bili_seen', {
    record: { bvid: 'BV1longnote', status: '跳过', note: 'x'.repeat(400) },
    roundId: memId,
  });
  assert((body(r).recorded.note || '').length === 200, '超长笔记截到 200 字（判重表是只追加的，不能让一条撑爆）');
  r = await call('bili_seen', { record: { bvid: 'BV1nonote', status: '跳过' }, roundId: memId });
  assert(body(r).recorded.note === undefined, '没写笔记就不带这个键（免得多出一行空噪音）');
  await call('bili_round', { action: 'finish', status: 'nothing', roundId: memId });

  cleanState();
  r = await call('bili_round', { manual: true });
  const mem = body(r).memory;
  show('bili_round(memory)', r);
  assert(Boolean(mem) && Array.isArray(mem.notes) && mem.notes.length >= 2, 'memory.notes 把旧笔记带回来了');
  assert(mem.notes.some((n) => n.bvid === 'BV1tKs76bEyi' && /回收画面/.test(n.note)), '那条判断原样回来了');
  assert(mem.notes.some((n) => n.day === today() && n.status === '跳过'), '笔记带着它是哪一天、判成了什么');
  assert(mem.ups.some((u) => u.up === 'SpaceX中文' && u.count >= 1), '按 UP 折叠出「上次怎么看这个 UP」');
  const memRoundId = body(r).roundId;

  r = await call('bili_browse', { source: 'search', keyword: '星舰' });
  vids = body(r).videos || [];
  const hit = vids.find((v) => v.bvid === 'BV1tKs76bEyi');
  show('bili_browse(挂笔记)', r);
  assert(hit && /回收画面/.test(hit.note || ''), '见过的视频挂上当时的笔记');
  assert(hit && /回收画面/.test(hit.upNote || ''), '同一个 UP 也挂上 upNote');
  const fresh = vids.find((v) => v.bvid === 'BV1neverseen');
  assert(fresh && fresh.note === undefined && fresh.upNote === undefined, '没刷过的候选不带 note');
  await call('bili_round', { action: 'finish', status: 'nothing', roundId: memRoundId });

  // 判重表读不到时 memory 必须是 null：给一份空记忆等于告诉模型「我以前什么都没想过」。
  cleanState();
  failRead = 'seen.jsonl';
  r = await call('bili_round', { manual: true });
  show('bili_round(判重表读不到时的 memory)', r);
  assert(body(r).memory === null, '判重表读不到时 memory=null（不是空对象）');
  assert(body(r).seenUnavailable === true, '并且明说判重表读不到');
  await call('bili_round', { action: 'finish', status: 'nothing', roundId: body(r).roundId });

  console.log('# 60. 设置页桥：登录搬进设置页，凭证只在内存里递一次');
  const bridgeChannel = fakeChannels.find((item) => item.name === 'cindy-bili-scroll');
  assert(Boolean(bridgeChannel), '插件启动时就挂上了设置页那条频道');
  let bridgeSeq = 0;
  async function askBridge(action, payload, reqId) {
    const id = reqId || ('t-' + (bridgeSeq += 1));
    await bridgeChannel.deliver({ type: 'bili-login', reqId: id, action, payload });
    const replies = bridgeChannel.replies().filter((item) => item.reqId === id);
    return replies[replies.length - 1];
  }

  files.delete('credential.json');
  accountCount = 0;
  r = await askBridge('status', {});
  show('桥 status（没凭证）', { ok: true, result: { structuredContent: r.data } });
  assert(r.ok && r.data.loggedIn === false, '没凭证时如实回「未登录」');
  assert(accountCount === 0, '查状态不碰 B站 接口');

  qrStartCount = 0;
  r = await askBridge('qr-start', {});
  show('桥 qr-start', { ok: true, result: { structuredContent: r.data } });
  assert(r.ok && /passport\.bilibili\.com/.test(r.data.url || ''), '只在点了按钮之后才去要二维码');
  assert(r.data.key === undefined, '回执里不带 qrcode_key（页面用不上）');
  assert(qrStartCount === 1, '要了一次二维码');

  // 页面每 600ms 重发同一条：重发撞上「取二维码」会把第一张作废，扫的那张就废了
  const firstDup = await askBridge('qr-start', {}, 'dup-1');
  const secondDup = await askBridge('qr-start', {}, 'dup-1');
  assert(qrStartCount === 2, '同一个 reqId 重发只真跑一次');
  assert(JSON.stringify(firstDup) === JSON.stringify(secondDup), '重发拿到的是同一份回执');

  qrPollPlan = ['ok'];
  r = await askBridge('qr-poll', {});
  show('桥 qr-poll', { ok: true, result: { structuredContent: r.data } });
  assert(r.ok && r.data.status === 'ok', '扫码确认后回 ok');
  assert((files.get('credential.json') || '').includes('SESS-XYZ'), '扫码等到的凭证落盘');

  accountCount = 0;
  r = await askBridge('status', {});
  assert(r.data.loggedIn === true && r.data.verified === false, '本机状态：已登录、未核对');
  assert(accountCount === 0, '打开设置页只读本机凭证');
  assert(r.data.account && r.data.account.uname === '测试账号', '昵称来自本机凭证');

  accountCount = 0;
  r = await askBridge('status', { verify: true });
  assert(accountCount === 1 && r.data.verified === true, '点了「核对一下」才真问 B站');

  const secretCookie = 'SESSDATA=deadbeef; bili_jct=CSRF-9127';
  authInvalid = true;
  r = await askBridge('cookie', { cookie: secretCookie });
  show('桥 cookie（不被认）', { ok: false, message: r.error });
  assert(r.ok === false && /不认这段 Cookie/.test(r.error || ''), 'B站 不认时说清原因');
  assert(!JSON.stringify(r).includes('deadbeef'), '失败回执里没有 Cookie 原文');

  authInvalid = false;
  r = await askBridge('cookie', { cookie: secretCookie });
  assert(r.ok === true && r.data.account.uname === '测试账号', '认得过就登录成功');
  assert(!JSON.stringify(r).includes('deadbeef'), '成功回执里也没有 Cookie 原文');
  assert(!JSON.stringify(r).includes('CSRF-9127'), 'bili_jct 原样不进回执');
  assert((files.get('credential.json') || '').includes('deadbeef'), '但凭证确实落了盘');
  assert(lastMirror.state.loggedIn === true, '顺手把「已登录」推进闸门镜像');

  r = await askBridge('cookie', { cookie: 'bili_jct=abc' });
  assert(r.ok === false && /SESSDATA/.test(r.error || ''), '缺 SESSDATA 时直接拒');
  assert((files.get('credential.json') || '').includes('deadbeef'), '被拒的那段没有覆盖已有凭证');

  // 只给 SESSDATA 也能登录，但要把「没有 bili_jct 就不能互动」说清楚
  r = await askBridge('cookie', { cookie: 'SESSDATA=only-sess' });
  assert(r.ok === true && r.data.hasBiliJct === false, '只给 SESSDATA 也能登录（hasBiliJct=false）');
  assert((r.data.warnings || []).some((w) => /bili_jct/.test(w)), '并说清缺 bili_jct 的后果');

  r = await askBridge('logout', {});
  assert(r.ok && r.data.loggedOut === true, '退出登录成功');
  assert(!files.has('credential.json'), '凭证文件真的删掉了（回读确认过）');
  r = await askBridge('status', {});
  assert(r.data.loggedIn === false, '退出后状态随之变成未登录');

  r = await askBridge('whatever', {});
  assert(r.ok === false && r.code === 'BAD_REQUEST', '不认识的动作明确拒绝');

  console.log('# 61. 设置页三个 Cookie 栏：只填值，名字由插件拼回去');
  files.delete('credential.json');
  r = await askBridge('cookie', { fields: { SESSDATA: 'raw-sess', bili_jct: 'raw-jct', DedeUserID: '777' } });
  show('桥 cookie(fields)', { ok: true, result: { structuredContent: r.data } });
  assert(r.ok === true, '三个分开的值也能登录');
  let savedCred = JSON.parse(files.get('credential.json') || '{}');
  assert(savedCred.sessdata === 'raw-sess', 'SESSDATA 存的是值本身');
  assert(savedCred.bili_jct === 'raw-jct', 'bili_jct 存的是值本身');
  assert(savedCred.dedeuserid === '777', 'DedeUserID 存的是值本身');
  assert(!JSON.stringify(r).includes('raw-sess'), '回执里没有值原文');

  // 有人习惯整段粘：名字必须被削掉，不能把「SESSDATA=xxx」当成值存进去
  r = await askBridge('cookie', { fields: { SESSDATA: 'SESSDATA=val2;', bili_jct: '"quoted-jct"', DedeUserID: '' } });
  assert(r.ok === true, '带名字也能登录（宽容一点）');
  savedCred = JSON.parse(files.get('credential.json') || '{}');
  assert(savedCred.sessdata === 'val2', '多粘的「SESSDATA=」和结尾分号被削掉');
  assert(savedCred.bili_jct === 'quoted-jct', '成对引号被剥掉');
  assert(savedCred.dedeuserid === '42', 'DedeUserID 留空时用接口的 mid 兜底');

  r = await askBridge('cookie', { fields: { SESSDATA: '', bili_jct: 'x' } });
  show('桥 cookie(缺 SESSDATA)', { ok: false, message: r.error });
  assert(r.ok === false && /没填 SESSDATA/.test(r.error || ''), 'SESSDATA 空着直接拒');
  savedCred = JSON.parse(files.get('credential.json') || '{}');
  assert(savedCred.sessdata === 'val2', '被拒的那次没有覆盖已有凭证');

  console.log('# 62. 审批面：跑一轮要用的工具都免逐次确认，只有改设置要点');
  // 定时任务的权限模式不在 schedule 定义里，靠任务默认跑；所以「一轮里用到的工具」
  // 必须在插件这边就声明 auto，否则哪天任务被设成询问档，凌晨那一轮会卡在一张没人看的卡片上。
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ghost.json'), 'utf8'));
  const approvalOf = (name) => (manifest.tools.find((t) => t.name === name) || {}).approval;
  const roundTools = [
    'bili_round', 'bili_browse', 'bili_detail', 'bili_comments', 'bili_inbox', 'bili_verify',
    'bili_report_append', 'bili_seen', 'bili_comment', 'bili_reply', 'bili_favorite', 'bili_dm',
  ];
  for (const name of roundTools) assert(approvalOf(name) === 'auto', name + ' 是 approval:auto');
  assert(approvalOf('bili_config') === 'each-call', '改设置 / 退出登录仍然逐次确认');
  assert(approvalOf('open_view') === undefined && approvalOf('view_data') === undefined, '开页面 / 页面读数据不额外声明');

  console.log('# 63. 互动轮：空收件箱 / 部分读取 / 手动上限 / 非空一次完整检查');
  await call('bili_config', {
    set: {
      replyToComments: true, inboxChecksPerDay: 20, inboxMinGapMin: 0, replyPerRound: 1, replyPerDay: 5,
      autoComment: true, commentPerRound: 1, favFolderId: 202, dmMode: 'both', dmUid: 4242,
    },
    confirm: true,
  });
  cleanState();
  files.set('credential.json', JSON.stringify({ sessdata: 'S', bili_jct: 'J', dedeuserid: '1', buvid3: 'a', buvid4: 'b' }));

  inboxNext = { items: [] };
  r = await call('bili_inbox', { action: 'start' });
  show('bili_inbox(空)', r);
  assert(r.ok && body(r).go === true && body(r).nothing === true && !body(r).inboxId, '空收件箱：直接收尾，不发 inboxId');
  assert(stateFile().inbox.checks === 1, '空收件箱也占一次自动检查');

  inboxNext = { items: [], partial: true };
  r = await call('bili_inbox', { action: 'start' });
  assert(r.ok && body(r).partial === true && body(r).nothing === true, '接口只读了一半 → 明确标 partial，不当成「没人回复」');

  // 手动检查也计数：空收件箱过去不计，`manual=true` 于是成了绕开上限的后门。
  for (let i = 0; i < 6; i += 1) {
    inboxNext = { items: [] };
    r = await call('bili_inbox', { action: 'start', manual: true });
    assert(r.ok && body(r).go === true, '手动空检查第 ' + (i + 1) + ' 次放行');
  }
  assert(stateFile().inboxManualCount === 6, '空的手动检查也计入手动次数');
  r = await call('bili_inbox', { action: 'start', manual: true });
  assert(body(r).reason === 'manual_capped', '第 7 次手动检查 → manual_capped');

  inboxNext = { items: [{ type: 'reply', aid: '555', rpid: '1900000000000000002', user: '观众', text: '这条结尾是什么意思？', title: '测试视频' }] };
  r = await call('bili_inbox', { action: 'start' });
  show('bili_inbox(有 1 条)', r);
  assert(body(r).go === true && body(r).nothing === false && body(r).inboxId, '非空：开一次检查并给 inboxId');
  assert(body(r).budget.reply === 1, '回复额度来自 replyPerRound');
  const inboxId63 = body(r).inboxId;
  r = await call('bili_reply', { aid: '555', rpid: '1900000000000000002', text: '你说的是着陆段那一下，那里确实最关键', confirm: true, inboxId: inboxId63 });
  show('bili_reply(带 inboxId)', r);
  assert(r.ok && body(r).sent === true, '带 inboxId 的回复成功');
  const lastReply = (stateFile().replies || []).slice(-1)[0];
  assert(lastReply && lastReply.via === 'inbox' && lastReply.round === inboxId63, '回复记在这一次互动检查名下');
  r = await call('bili_comment', { bvid: 'BV1aaaaaaaab', text: '互动轮里不该能评论，这一条必须被拒', confirm: true });
  assert(!r.ok && r.errorCode === 'INBOX_ONLY_TURN', '互动轮里评论被拒（互动轮只回复）');
  r = await call('bili_favorite', { bvid: 'BV1aaaaaaaab', confirm: true });
  assert(!r.ok && r.errorCode === 'INBOX_ONLY_TURN', '互动轮里收藏被拒');
  r = await call('bili_dm', { text: '互动轮里不该发私信', confirm: true });
  assert(!r.ok && r.errorCode === 'INBOX_ONLY_TURN', '互动轮里私信被拒');
  r = await call('bili_inbox', { action: 'finish', inboxId: inboxId63 });
  assert(r.ok && body(r).finished === true, 'finish 收尾');
  assert(!stateFile().inboxLock, '收尾后锁被清掉');
  cleanState();
  inboxNext = null;

  console.log('# 64. 单车道分派：一条 cron 下，bili_round 自己决定做日报轮还是互动轮');
  await call('bili_config', {
    set: {
      segments: [{ start: '00:00', end: '24:00', rounds: 1 }],
      perDay: 5,
      reportLevel: 'full',
      replyToComments: true,
      inboxChecksPerDay: 2,
      inboxMinGapMin: 0,
      replyPerRound: 1,
      manualCooldownMin: 0,
    },
    confirm: true,
  });
  cleanState();
  {
    const s64 = stateFile();
    delete s64.inbox;
    delete s64.inboxLock;
    delete s64.inboxLog;
    files.set('state.json', JSON.stringify(s64));
  }
  files.delete('out/' + today() + '.md');
  inboxNext = { items: [] };

  r = await call('bili_round', {});
  show('bili_round(日报轮有额度)', r);
  assert(body(r).go === true && body(r).mode === 'report', '两条车道都有活 → 先开日报轮');
  assert(/每一天|日报/.test(String(body(r).charter || '')), '带的是日报轮章程');
  const dispatchRound = body(r).roundId;
  r = await call('bili_round', { action: 'finish', roundId: dispatchRound });
  assert(body(r).finished === true, '日报轮收尾（这一段跑满）');

  r = await call('bili_round', {});
  show('bili_round(日报段跑满、收件箱空)', r);
  assert(body(r).mode === 'inbox' && body(r).nothing === true, '同一拍转互动轮；收件箱空则自动收尾');
  assert(body(r).finished === true && body(r).inboxId === null, '空收件箱不建锁、不用再调 finish');
  assert((stateFile().inbox || {}).checks === 1, '这一次算「今天第 1 次检查」');
  assert(!stateFile().roundLock, '没有顺手再开一个日报轮');

  inboxNext = {
    items: [{ type: 'reply', aid: '777', rpid: '1900000000000000123', user: '观众', text: '下期什么时候更？', title: '某条视频' }],
  };
  r = await call('bili_round', {});
  show('bili_round(互动轮有活)', r);
  assert(body(r).mode === 'inbox' && Boolean(body(r).inboxId), '给 inboxId，不新建工具');
  assert(/互动轮/.test(String(body(r).charter || '')), '带的是互动轮章程');
  const dispatchInbox = body(r).inboxId;
  r = await call('bili_reply', {
    inboxId: dispatchInbox,
    aid: '777',
    rpid: '1900000000000000123',
    text: '下周三，正在剪。',
    confirm: true,
  });
  assert(r.ok, '在 bili_round 开出来的这次检查里能回复');
  r = await call('bili_inbox', { action: 'finish', inboxId: dispatchInbox });
  assert(body(r).finished === true, '互动检查收尾');

  r = await call('bili_round', {});
  show('bili_round(两条车道都用完)', r);
  assert(body(r).go === false && body(r).mode === 'none', '都没活 → mode=none');
  assert(body(r).reason === 'segment_done', '日报轮的原因：这一段跑满');
  assert(body(r).inboxReason === 'inbox_checks_exhausted', '互动轮的原因：今天检查次数用满');
  assert(!stateFile().roundLock, 'mode=none 不落锁');
  assert(/用满 2\/2 次/.test(String(body(r).message || '')), '一句话里把两边都说清');

  // 手动轮不经过分派：使用者亲口说「现在刷一轮」就该刷，哪怕自动轮次已经用完。
  r = await call('bili_round', { manual: true });
  show('bili_round(手动，自动轮次已用完)', r);
  assert(body(r).go === true && body(r).mode === 'report' && body(r).manual === true, '手动轮照样开日报轮');
  const reentryRound = body(r).roundId;

  // 重入：已经有一轮在跑时再调一次 start。模型可能在上下文压缩后重调，这时
  // 不能回一句「这一拍直接结束」——那等于让它丢下自己那一轮。
  const reentry = await call('bili_round', {});
  show('bili_round(有一轮在跑时重入)', reentry);
  assert(body(reentry).go === false && body(reentry).mode === 'none', '重入不再开第二轮');
  assert(
    /那就是你自己这一轮/.test(String(body(reentry).message || '')),
    '并且说清「如果是你自己这一轮，继续做完、别重开也别结束」'
  );

  await call('bili_round', { action: 'finish', roundId: reentryRound });
  inboxNext = null;

  console.log('# 65. 私信日上限按设置走（dmPerDay）：0 / 1 / 2 / 5 各是什么效果');
  // 起因：日上限以前写死 2。12:02、15:25 各发过一条之后，晚间那轮 budget.dm=0，
  // 模型正确地没发——但使用者没有任何办法把它调大。现在它是设置项（默认仍是 2）。
  // cleanState 不动 dmLog（记账就是记账），这里要单独清，否则前面 §2 那一批私信
  // 还记在今天名下，dmPerDay=1 一开场就已经是 0 了。
  const resetDmLog = () => {
    const s = stateFile();
    s.dmLog = [];
    files.set('state.json', JSON.stringify(s));
  };
  resetDmLog();
  await call('bili_config', {
    set: { dmMode: 'both', dmUid: 42, dmPerDay: 0, autoComment: false, manualCooldownMin: 0 },
    confirm: true,
  });
  cleanState();
  files.delete('out/' + today() + '.md');

  // dmPerDay=0：budget 说 0，真发也被拒——两边口径必须一致，否则模型按 budget 发、工具再打回来。
  r = await manualRound();
  assert(body(r).go === true && body(r).budget.dm === 0, 'dmPerDay=0 → budget.dm 是 0（这一轮不发私信）');
  const dmZeroRound = body(r).roundId;
  r = await call('bili_dm', { text: '今天挑了三支片子。', confirm: true, roundId: dmZeroRound });
  assert(!r.ok && r.errorCode === 'DM_BUDGET', 'dmPerDay=0 时真发会被拒（不是只在 budget 里写 0）');
  await call('bili_round', { action: 'finish', roundId: dmZeroRound });

  // dmPerDay=1：一轮一条照旧，发满之后当天下一次开轮 budget 就该是 0。
  await call('bili_config', { set: { dmPerDay: 1 }, confirm: true });
  cleanState();
  r = await manualRound();
  assert(body(r).budget.dm === 1, 'dmPerDay=1 → 今天还没发过，这一轮能发 1 条');
  const dmOneRound = body(r).roundId;
  r = await call('bili_dm', { text: '今天挑了三支片子。', confirm: true, roundId: dmOneRound });
  assert(r.ok && body(r).sent === true, '第 1 条发出去了');
  r = await call('bili_dm', { text: '再补一条。', confirm: true, roundId: dmOneRound });
  assert(!r.ok && r.errorCode === 'DM_BUDGET', '同一轮第 2 条仍被拒（每轮最多 1 条没变）');
  await call('bili_round', { action: 'finish', roundId: dmOneRound });
  r = await manualRound();
  assert(body(r).budget.dm === 0, '已发 1 / 上限 1 → 当天下一轮 budget.dm=0');
  const dmFullRound = body(r).roundId;
  r = await call('bili_dm', { text: '第三条。', confirm: true, roundId: dmFullRound });
  assert(!r.ok && /一天最多 1 条/.test(String(r.message || '')), '拒绝时说的上限也按设置走（一天最多 1 条）');
  await call('bili_round', { action: 'finish', roundId: dmFullRound });

  // dmPerDay=2（默认）：发到第 2 条之后，第 3 轮 budget 归零——就是主人实测到的那一幕。
  await call('bili_config', { set: { dmPerDay: 2 }, confirm: true });
  r = await manualRound();
  assert(body(r).budget.dm === 1, '已发 1 / 上限 2 → 还能发 1 条');
  const dmTwoRound = body(r).roundId;
  r = await call('bili_dm', { text: '今天挑了三支片子。', confirm: true, roundId: dmTwoRound });
  assert(r.ok && body(r).sent === true, '第 2 条发出去了');
  await call('bili_round', { action: 'finish', roundId: dmTwoRound });
  r = await manualRound();
  assert(body(r).budget.dm === 0, '已发 2 / 上限 2 → 晚间那轮 budget.dm=0（默认行为与 1.5.0 完全一致）');
  const dmStuckRound = body(r).roundId;
  await call('bili_round', { action: 'finish', roundId: dmStuckRound });

  // dmPerDay=5：同一份记账，只是把上限调大——晚间那轮又能发了。这就是这次改动的意义。
  await call('bili_config', { set: { dmPerDay: 5 }, confirm: true });
  r = await manualRound();
  assert(body(r).budget.dm === 1, '已发 2 / 上限 5 → 这一轮又能发 1 条（上限真的可调了）');
  const dmFiveRound = body(r).roundId;
  r = await call('bili_dm', { text: '今天的第 3 条。', confirm: true, roundId: dmFiveRound });
  assert(r.ok && body(r).sent === true, '上限调大之后第 3 条发得出去');
  await call('bili_round', { action: 'finish', roundId: dmFiveRound });

  console.log('# 66. 日报有产出才开卡片墙：finish 的 reportUpdated');
  await call('bili_config', { set: { dmMode: 'off', dmPerDay: 2, reportLevel: 'full' }, confirm: true });
  cleanState();
  files.delete('out/' + today() + '.md');

  // ① 有产出：写了一条 ### BV…，收尾说「日报已更新」。
  r = await manualRound();
  const cardsRound = body(r).roundId;
  r = await call('bili_report_append', {
    roundId: cardsRound,
    text: '### BV1tKs76bEyi\n标题 / UP / 12:00 / 1.2万播放\n**档位**：值得看\n为什么值得：讲清了回收塔架',
  });
  assert(r.ok && body(r).written === true, '这一轮写了一条日报');
  r = await call('bili_round', { action: 'finish', roundId: cardsRound });
  assert(body(r).reportUpdated === true, '写了新条目 → reportUpdated=true');
  assert(/open_view/.test(JSON.stringify(r)) && /cards/.test(JSON.stringify(r)),
    '收尾文字里点名了 open_view({intent:"cards"})（模型不用猜下一步）');

  // ② 无产出（日报已经存在，只是这一轮没写东西）：不补占位，也不该开卡片墙。
  r = await manualRound();
  const emptyRound = body(r).roundId;
  r = await call('bili_round', { action: 'finish', roundId: emptyRound, status: 'nothing', note: '这轮没挑到' });
  assert(body(r).finished === true && body(r).stubbed === false, '日报已存在 → 不收占位');
  assert(body(r).reportUpdated === false, '这一轮没写新条目 → reportUpdated=false（不开卡片墙）');

  // ③ 写失败：append 读不到日报 → 抛错、不记账；收尾时这条轮次没有产出。
  r = await manualRound();
  const failedRound = body(r).roundId;
  failPaths.add('out/' + today() + '.md');
  r = await call('bili_report_append', {
    roundId: failedRound,
    text: '### BV1fffffffff\n标题 / UP / 03:00 / 8000播放\n**档位**：可以看\n为什么值得：写不进去的那条',
  });
  assert(!r.ok && r.errorCode === 'FS_READ_FAILED', '日报读不到 → append 直接失败（不会假装写好了）');
  failPaths.delete('out/' + today() + '.md');
  r = await call('bili_round', { action: 'finish', roundId: failedRound, status: 'error', note: '日报写不进去' });
  assert(body(r).reportUpdated === false, '写失败的那一轮 → reportUpdated=false');

  // ④ 只补了占位（这一轮什么都没写成、日报还是空的）：仍然 false。
  files.delete('out/' + today() + '.md');
  r = await manualRound();
  const stubRound = body(r).roundId;
  r = await call('bili_round', { action: 'finish', roundId: stubRound, status: 'nothing' });
  assert(body(r).stubbed === true, '空日报 → 补占位');
  assert(body(r).reportUpdated === false, '占位不算产出 → reportUpdated=false');

  console.log('# 67. 闸门刚放行的那一刻，bili_inbox 真的能开起来（线上那次「没活干」的端到端回归）');
  // 线上现场：precheck 输出 `run: 互动轮…` 并写回 inboxHookAt，模型被叫醒后 bili_inbox
  // 回「离上次互动检查还不到 30 分钟」——闸门自己的章被当成了上一次检查。
  // 这里直接照那份 state 摆一遍，走完整的工具路径（main.js → duty/layout → decide.cjs）。
  await call('bili_config', {
    set: {
      replyToComments: true, inboxChecksPerDay: 20, inboxMinGapMin: 15, replyPerRound: 1, replyPerDay: 5,
    },
    confirm: true,
  });
  files.set('credential.json', JSON.stringify({ sessdata: 'S', bili_jct: 'J', dedeuserid: '1', buvid3: 'a', buvid4: 'b' }));
  cleanState();
  const stampGate = () => {
    const s = stateFile();
    s.day = today();
    s.inbox = null;
    s.inboxChecks = 0;
    s.inboxLastAt = '';
    s.inboxHookTries = 1;
    s.inboxHookDay = today();
    // 刻意退后 2 秒：检查时刻是 `new Date()`，两者在同一毫秒内会撞成相等，
    // 断言偶尔假失败（这台机器上约每五六轮一次）。退后之后「检查晚于章」是构造出来的事实。
    s.inboxHookAt = new Date(Date.now() - 2000).toISOString();
    delete s.inboxLog;
    delete s.inboxManualDay;
    delete s.inboxManualCount;
    s.inboxLock = null;
    files.set('state.json', JSON.stringify(s));
  };
  stampGate();
  inboxNext = { items: [{ type: 'reply', aid: '555', rpid: '1900000000000000003', user: '观众', text: '这段是真的吗？', title: '测试视频' }] };
  r = await call('bili_inbox', { action: 'start' });
  show('bili_inbox(闸门刚放行)', r);
  assert(r.ok && body(r).go === true && Boolean(body(r).inboxId), '闸门刚放行 → 这次检查真的开起来了（不再回 too_soon）');
  // 注意：这里返回的 limits 是「开起来之后」重算的，lastAt 就是刚才这一次检查的时刻。
  // 「闸门的章不算上一次检查」由开起来这件事本身和 test-decide §12 ⑥ 钉住。
  assert(body(r).limits.lastAt > 0 && body(r).limits.lastAt > Date.parse(stateFile().inboxHookAt),
    '开起来之后 limits.lastAt 是这次检查的时刻，不是闸门那颗章的复制');
  const inboxIdGate = body(r).inboxId;
  r = await call('bili_inbox', { action: 'finish', inboxId: inboxIdGate });
  assert(r.ok && body(r).finished === true, '这一次检查正常收尾');
  assert(Boolean(stateFile().inbox) && stateFile().inbox.checks >= 1, 'state.inbox 终于被写上了（线上一直是 null）');
  // 收尾之后闸门再敲：插件账上的 lastAt 已经是真的检查时刻，间隔重新生效。
  r = await call('bili_inbox', { action: 'start' });
  assert(body(r).go === false && body(r).reason === 'inbox_too_soon', '查过之后按最小间隔挡（这一条不能因为上面的修复而失效）');
  cleanState();
  inboxNext = null;

  console.log('\nALL PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
