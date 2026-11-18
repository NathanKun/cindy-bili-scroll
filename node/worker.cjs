'use strict';

/**
 * 刷B站 · 随包 Node 工作进程
 *
 * 与 main.js 之间是一行一个 JSON-RPC 2.0 对象。stdout 只写协议消息，日志走 stderr。
 * 这里做 B 站网络这一件事：除了 duty/sync 要把值斑文件镜像到 %APPDATA%\Cindy\duty\cindy-bili-scroll/（脚本要读），
 * 其他一律不落盘、不读文件。凭证由 main.js 每次调用时作为 params.credential 传进来，
 * 本进程只在内存里缓存，不写日志、不落盘。
 *
 * 统一返回：{ ok: true, data: {...} } 或 { ok: false, error: { code, message, ... } }
 */

const readline = require('node:readline');

const { Bili, LoginSession, BiliError } = require('./lib/api.cjs');
const duty = require('./lib/duty.cjs');

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function log(...args) {
  process.stderr.write('[cindy-bili-scroll] ' + args.map(String).join(' ') + '\n');
}

function credentialOf(params) {
  const cred = params && params.credential;
  if (!cred || typeof cred !== 'object') return {};
  return {
    sessdata: typeof cred.sessdata === 'string' ? cred.sessdata : '',
    bili_jct: typeof cred.bili_jct === 'string' ? cred.bili_jct : '',
    dedeuserid: typeof cred.dedeuserid === 'string' ? cred.dedeuserid : '',
    dedeuserid_ckmd5: typeof cred.dedeuserid_ckmd5 === 'string' ? cred.dedeuserid_ckmd5 : '',
    buvid3: typeof cred.buvid3 === 'string' ? cred.buvid3 : '',
    buvid4: typeof cred.buvid4 === 'string' ? cred.buvid4 : '',
  };
}

// 一次 RPC 建一个新实例会让「300ms 限速」和「WBI 密钥 30 分钟缓存」每次都归零：
// 同一轮里连着拉十几条字幕，实际就是十几份签名密钥、限速也形同虚设。
// 按账号指纹复用一个实例，凭证换了（重新登录）就自然落到新实例上。
const clients = new Map();

function client(params) {
  const credential = credentialOf(params);
  const key = [credential.sessdata, credential.dedeuserid, credential.bili_jct].join('|');
  let instance = clients.get(key);
  if (!instance) {
    if (clients.size >= 3) clients.clear();
    instance = new Bili(credential);
    clients.set(key, instance);
  }
  return instance;
}

const handlers = {
  async 'auth/qr-start'() {
    const session = new LoginSession(client({}).http);
    return await session.start();
  },

  async 'auth/qr-poll'(params) {
    const key = String((params && params.key) || '').trim();
    if (!key) throw new BiliError('BAD_REQUEST', '缺少 qrcode_key');
    const session = new LoginSession(client(params).http);
    session.key = key;
    return await session.poll();
  },

  async 'auth/account'(params) {
    return await client(params).account();
  },

  async recommend(params) {
    return await client(params).recommend(params && params.ps);
  },

  async search(params) {
    return await client(params).search({
      keyword: params && params.keyword,
      pages: params && params.pages,
      order: params && params.order,
    });
  },

  async video(params) {
    return await client(params).video(params && params.bvid);
  },

  async subtitle(params) {
    return await client(params).subtitle(params && params.bvid, {
      aid: params && params.aid,
      cid: params && params.cid,
      title: params && params.title,
      maxChars: params && params.maxChars,
    });
  },

  async comments(params) {
    return await client(params).comments(params && params.bvid, params && params.ps);
  },

  async 'comment/post'(params) {
    return await client(params).postComment({
      bvid: params && params.bvid,
      aid: params && params.aid,
      text: params && params.text,
      root: params && params.root,
      parent: params && params.parent,
    });
  },

  async 'comment/check'(params) {
    const args = {
      bvid: params && params.bvid,
      aid: params && params.aid,
      rpid: params && params.rpid,
      root: params && params.root,
    };
    // 「我这边看得见」不等于「别人看得见」。
    //
    // B站 对审核中 / 被限流的评论，只对发布者自己的凭证放行：用自己的 cookie 去拉
    // 最新主楼，那条明明在里面，匿名（或别的账号）拉同一份列表却没有它。所以复核必须
    // 查两遍——用自己的凭证一遍（判断「我这儿还有没有」），再**不带登录态**一遍
    // （判断「别人那儿有没有」）。只有匿名那一遍也查得到，才算真的公开。
    //
    // 这一条是实测出来的：一条评论自己看得见、UP 主看不见、@ 也没提醒，
    // 老版本只查了自己那一遍，于是把「仅自己可见」报成了「公开可见」。
    const own = await client(params).commentCheck(args);
    let anonymous = null;
    let anonymousError = '';
    try {
      anonymous = await client({ credential: {} }).commentCheck(args);
    } catch (error) {
      anonymousError = (error && error.message) || '匿名复查失败';
    }
    return Object.assign({}, own, { anonymous, anonymousError });
  },

  async 'favorite/add'(params) {
    return await client(params).favorite({
      bvid: params && params.bvid,
      folderId: params && params.folderId,
    });
  },

  async 'favorite/folders'(params) {
    return await client(params).favoriteFolders();
  },

  async 'dm/send'(params) {
    return await client(params).sendDm({ uid: params && params.uid, text: params && params.text });
  },

  async 'msg/inbox'(params) {
    return await client(params).inbox();
  },

  async 'user/resolve'(params) {
    return await client(params).resolveUser(params && params.name);
  },

  // ── 值班文件：给自动化前置检查脚本（preRunHook）读的那两个 JSON ──
  //    插件写、脚本只读。写失败不让这一轮失败——脚本读不到顶多放行一次。
  async 'duty/sync'(params) {
    return duty.sync({ config: params && params.config, state: params && params.state });
  },

  async 'duty/status'() {
    return duty.status();
  },

  // 「这一拍做什么」的判定。**逻辑只有一份**（schedule/decide.cjs），前置检查脚本
  // import 的是同一个文件。main.js 是沙箱脚本、没有 require，所以它把自己刚读到的
  // 记账递过来、由这里代跑一次——插件是权威判定（记账最新），脚本只是保守粗筛。
  async 'duty/decide'(params) {
    // 惰性 require：这个文件按包内相对路径取，属于包结构的一部分。
    // 取不到只会让这一个方法失败（插件那边退回日报轮的老路径），不影响别的工具。
    const { decide } = require('../schedule/decide.cjs');
    return decide(
      params && params.config,
      params && params.state,
      params && params.now ? params.now : new Date(),
      // 插件问的是「我这个模型现在能不能开这一轮」：脚本刚放行、还没被认领的那一次
      // 就是这一轮，要从「之前试过几次」里扣掉。
      params && params.options
    );
  },

  // 段表（洗完之后的 HH:MM + 派生 key/label）。插件写 config.json 镜像、说清
  // 「这一轮属于哪一段」都要它——规则在 decide.cjs，插件只拿结果。
  async 'duty/segments'(params) {
    const { segmentTable } = require('../schedule/decide.cjs');
    const segments = segmentTable(
      params && params.segments,
      params && params.autoRoundsPerDay
    );
    return { segments, total: segments.reduce((sum, row) => sum + row.rounds, 0) };
  },

  // 插件这一拍要的全部判定数据：此刻在哪一段 / 还剩几轮 / 这一槽位试过几次 /
  // 互动检查今天还剩几次。一把给齐，省得它自己拼输入再分四次问。
  async 'duty/layout'(params) {
    const { layout } = require('../schedule/decide.cjs');
    return layout(
      params && params.config,
      params && params.state,
      params && params.now ? params.now : new Date()
    );
  },
};

function errorPayload(error) {
  if (error instanceof BiliError) {
    return {
      code: error.code || 'BILI_ERROR',
      message: error.message || 'B 站请求失败',
      biliCode: error.biliCode,
      httpStatus: error.httpStatus,
    };
  }
  return { code: 'INTERNAL', message: (error && error.message) || '工作进程内部错误' };
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', async (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch (_error) {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const method = request && request.method;
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
  if (!handler) {
    reply({
      jsonrpc: '2.0',
      id: request && request.id,
      error: { code: -32601, message: 'Method not found: ' + String(method) },
    });
    return;
  }
  try {
    const data = await handler(request.params || {});
    reply({ jsonrpc: '2.0', id: request.id, result: { ok: true, data } });
  } catch (error) {
    log('method', method, 'failed:', errorPayload(error).code, error && error.message);
    reply({
      jsonrpc: '2.0',
      id: request.id,
      result: { ok: false, error: errorPayload(error) },
    });
  }
});

