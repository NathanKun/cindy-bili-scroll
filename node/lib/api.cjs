'use strict';

/**
 * B 站业务接口封装。
 *
 * 全部端点形状对照 bilibili-api-python 17.4.x 的 data/api/*.json 移植
 * （repo 已归档，改从 PyPI sdist 取源码核对）：WBI 签名、表单字段、
 * 回调参数都按那边的实现来，避免"能发出去但对方不认"。
 */

const { BiliHttp, BiliError, parseLoginCredential } = require('./http.cjs');

const URLS = {
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  spi: 'https://api.bilibili.com/x/frontend/finger/spi',
  recommend: 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd',
  recommendPlain: 'https://api.bilibili.com/x/web-interface/index/top/feed/rcmd',
  search: 'https://api.bilibili.com/x/web-interface/wbi/search/type',
  view: 'https://api.bilibili.com/x/web-interface/view',
  player: 'https://api.bilibili.com/x/player/wbi/v2',
  videoshot: 'https://api.bilibili.com/x/player/videoshot',
  replyList: 'https://api.bilibili.com/x/v2/reply',
  replyMain: 'https://api.bilibili.com/x/v2/reply/main',
  replyReplies: 'https://api.bilibili.com/x/v2/reply/reply',
  replyAdd: 'https://api.bilibili.com/x/v2/reply/add',
  favDeal: 'https://api.bilibili.com/x/v3/fav/resource/deal',
  favFolders: 'https://api.bilibili.com/x/v3/fav/folder/created/list-all',
  dmSend: 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg',
  msgUnread: 'https://api.bilibili.com/x/msgfeed/unread',
  msgReply: 'https://api.bilibili.com/x/msgfeed/reply',
  msgAt: 'https://api.bilibili.com/x/msgfeed/at',
  qrGenerate: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header',
  qrPoll: 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll',
};

const ORDER = {
  totalrank: 'totalrank',
  click: 'click',
  pubdate: 'pubdate',
  dm: 'dm',
  stow: 'stow',
  scores: 'scores',
};

function httpsUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  return url.replace(/^http:/, 'https:');
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<em class="keyword">/g, '')
    .replace(/<\/em>/g, '')
    .replace(/<[^>]+>/g, '');
}

function durationText(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

function numberText(value) {
  const n = Number(value) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}

class Bili {
  constructor(credential) {
    this.http = new BiliHttp(credential);
    this.credential = this.http.cred;
  }

  /** 账号信息；未登录时 isLogin=false（不抛错，调用方据此引导登录） */
  async account() {
    try {
      const data = await this.http.request(URLS.nav);
      return {
        ok: true,
        isLogin: Boolean(data && data.isLogin),
        mid: (data && data.mid) || 0,
        uname: (data && data.uname) || '',
        face: (data && data.face) || '',
        level: (data && data.level_info && data.level_info.current_level) || 0,
        vip: Boolean(data && data.vipStatus),
      };
    } catch (error) {
      if (error instanceof BiliError && error.code === 'NOT_LOGGED_IN') {
        return { ok: true, isLogin: false, mid: 0, uname: '', face: '', level: 0, vip: false };
      }
      throw error;
    }
  }

  async recommend(ps) {
    const count = Math.max(1, Math.min(Number(ps) || 20, 40));
    const params = {
      ps: count,
      fresh_type: 3,
      fresh_idx: 1,
      fresh_idx_1h: 1,
      feed_version: 'V8',
      homepage_ver: 1,
      brush: 0,
      y_num: 5,
      screen: '1920x1080',
      web_location: 1430650,
    };
    let data;
    try {
      data = await this.http.request(URLS.recommend, { params, wbi: true });
    } catch (error) {
      // WBI 偶尔抽风：公开兜底端点不需要签名
      if (error instanceof BiliError && error.code !== 'NOT_LOGGED_IN') {
        data = await this.http.request(URLS.recommendPlain, { params: { ps: count, fresh_type: 3 } });
      } else {
        throw error;
      }
    }
    const items = (data && (data.item || data.data)) || [];
    const videos = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (item.goto && item.goto !== 'av') continue; // 直播 / 番剧 / 广告卡片
      if (!item.bvid) continue;
      const owner = item.owner || {};
      const stat = item.stat || {};
      videos.push({
        bvid: item.bvid,
        title: stripHtml(item.title),
        author: owner.name || '',
        mid: owner.mid || 0,
        play: stat.view || 0,
        playText: numberText(stat.view),
        danmaku: stat.danmaku || 0,
        like: stat.like || 0,
        duration: durationText(item.duration),
        pubdate: item.pubdate || 0,
        reason: (item.rcmd_reason && item.rcmd_reason.content) || '',
      });
      if (videos.length >= count) break;
    }
    return { source: 'recommend', count: videos.length, videos };
  }

  async search(options) {
    const opts = options || {};
    const keyword = String(opts.keyword || '').trim();
    if (!keyword) throw new BiliError('BAD_REQUEST', 'keyword 不能为空');
    const pages = Math.max(1, Math.min(Number(opts.pages) || 1, 5));
    const order = ORDER[opts.order] || ORDER.totalrank;
    const collected = [];
    const seen = new Set();
    for (let page = 1; page <= pages; page += 1) {
      const data = await this.http.request(URLS.search, {
        wbi: true,
        params: {
          search_type: 'video',
          keyword,
          page,
          page_size: 20,
          order,
          web_location: 1430650,
        },
      });
      const list = (data && data.result) || [];
      if (!list.length) break;
      for (const item of list) {
        if (!item || !item.bvid || seen.has(item.bvid)) continue;
        seen.add(item.bvid);
        collected.push({
          bvid: item.bvid,
          title: stripHtml(item.title),
          author: item.author || '',
          mid: item.mid || 0,
          play: item.play || 0,
          playText: numberText(item.play),
          danmaku: item.video_review || 0,
          review: item.review || 0,
          duration: item.duration || '',
          pubdate: item.pubdate || 0,
          description: String(item.description || '').slice(0, 160),
        });
      }
      if (collected.length >= 60) break;
    }
    return { source: 'search', keyword, order, count: collected.length, videos: collected };
  }

  async video(bvid) {
    const id = String(bvid || '').trim();
    if (!/^BV[0-9A-Za-z]{10}$/.test(id)) {
      throw new BiliError('BAD_REQUEST', 'bvid 格式不对，应当是 BV 开头的 12 位编号');
    }
    const data = await this.http.request(URLS.view, { params: { bvid: id } });
    if (!data) throw new BiliError('NOT_FOUND', '取不到这个视频的信息');
    const stat = data.stat || {};
    return {
      bvid: data.bvid,
      aid: data.aid,
      cid: data.cid,
      title: data.title,
      desc: String(data.desc || '').slice(0, 600),
      author: (data.owner && data.owner.name) || '',
      mid: (data.owner && data.owner.mid) || 0,
      duration: durationText(data.duration),
      durationSeconds: data.duration || 0,
      pubdate: data.pubdate || 0,
      cover: httpsUrl(data.pic),
      tid: data.tid || 0,
      tname: data.tname || '',
      stat: {
        view: stat.view || 0,
        viewText: numberText(stat.view),
        danmaku: stat.danmaku || 0,
        reply: stat.reply || 0,
        favorite: stat.favorite || 0,
        like: stat.like || 0,
        coin: stat.coin || 0,
      },
      pages: Array.isArray(data.pages)
        ? data.pages.map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: durationText(p.duration) }))
        : [],
    };
  }

  async subtitle(bvid, options) {
    const opts = options || {};
    // 调用方已经取过 view 时直接复用 aid/cid，省一次请求（也少一次风控暴露）
    const info =
      opts.aid && opts.cid
        ? { aid: Number(opts.aid), cid: Number(opts.cid), bvid: String(bvid || ''), title: String(opts.title || '') }
        : await this.video(bvid);
    const data = await this.http.request(URLS.player, {
      wbi: true,
      params: {
        aid: info.aid,
        cid: info.cid,
        isGaiaAvoided: false,
        web_location: 1315873,
      },
    });
    const list = (data && data.subtitle && data.subtitle.subtitles) || [];
    if (!list.length) {
      return {
        bvid: info.bvid,
        title: info.title,
        available: false,
        reason: this.credential.sessdata
          ? '该视频没有字幕轨（AI 字幕通常要在 B 站客户端里生成过才有）'
          : '未登录时看不到 AI 字幕；先在插件里扫码登录再试',
        languages: [],
        text: '',
      };
    }
    const preferred =
      list.find((s) => ['ai-zh', 'zh-CN', 'zh'].includes(s.lan)) || list[0];
    const url = httpsUrl(preferred.subtitle_url);
    if (!url) throw new BiliError('NOT_FOUND', '字幕地址为空');
    const body = await this.http._rawJson(url);
    const segments = (body && body.body) || [];
    const lines = segments.map((item) => String(item.content || '').trim()).filter(Boolean);
    let text = lines.join('\n');
    const maxChars = Math.max(500, Math.min(Number(opts.maxChars) || 30000, 60000));
    const full = text.length;
    const truncated = full > maxChars;
    if (truncated) {
      // 只留开头会把结论砍掉——长视频（两三个小时的课）最要紧的判断几乎都在结尾。
      // 所以按 65% / 35% 留「开头 + 结尾」，中间省略多少字写在接缝处。
      const headLen = Math.floor(maxChars * 0.65);
      const tailLen = maxChars - headLen;
      const skipped = full - headLen - tailLen;
      text =
        text.slice(0, headLen)
        + '\n…（字幕过长：中间省略约 ' + skipped + ' 字，下面是结尾）…\n'
        + text.slice(full - tailLen);
    }
    return {
      bvid: info.bvid,
      title: info.title,
      available: lines.length > 0,
      language: preferred.lan_doc || preferred.lan || '',
      languages: list.map((s) => ({ lan: s.lan, label: s.lan_doc || s.lan })),
      segments: lines.length,
      chars: lines.join('\n').length,
      truncated,
      shownChars: truncated ? maxChars : full,
      text,
    };
  }

  async comments(bvid, ps) {
    const info = await this.video(bvid);
    const count = Math.max(1, Math.min(Number(ps) || 20, 50));
    const data = await this.http.request(URLS.replyList, {
      params: { type: 1, oid: info.aid, ps: count, pn: 1, sort: 2 },
    });
    const replies = (data && data.replies) || [];
    // rpid_str 优先：JSON 里的 rpid 是数字，JSON.parse 那一刻就已经丢精度了，
    // 拿它当 parent 回复会挂错楼。没有 rpid_str 时**不能假装拿到的是准确 id**：
    // 标成 exact:false，让上层提示「这个 id 可能已经丢了几位，别拿它回楼中楼」。
    const rpidOf = (item) => {
      const str = item.rpid_str;
      if (str !== undefined && str !== null && str !== '') return { rpid: String(str), exact: true };
      if (item.rpid === undefined || item.rpid === null || item.rpid === '') return { rpid: '', exact: true };
      return { rpid: String(item.rpid), exact: false };
    };
    let lossy = false;
    const comments = replies.map((item) => {
      const id = rpidOf(item);
      if (!id.exact) lossy = true;
      return {
        rpid: id.rpid,
        rpidExact: id.exact,
        user: (item.member && item.member.uname) || '',
        mid: (item.member && item.member.mid) || 0,
        content: String((item.content && item.content.message) || '').slice(0, 300),
        like: item.like || 0,
        replies: item.rcount || 0,
        topReplies: Array.isArray(item.replies)
          ? item.replies.slice(0, 2).map((sub) => {
              // rpid 必须带上：回复楼中楼时它是 parent，缺了就只能回到顶层。
              const subId = rpidOf(sub);
              if (!subId.exact) lossy = true;
              return {
                rpid: subId.rpid,
                rpidExact: subId.exact,
                user: (sub.member && sub.member.uname) || '',
                content: String((sub.content && sub.content.message) || '').slice(0, 160),
              };
            })
          : [],
      };
    });
    return {
      bvid: info.bvid,
      total: (data && data.page && data.page.count) || 0,
      count: comments.length,
      // true：这批 rpid 里有接口没给字符串版的，超过 2^53 的那几位可能已经丢了。
      rpidLossy: lossy,
      comments,
    };
  }

  async postComment(options) {
    const opts = options || {};
    if (!this.credential.sessdata || !this.credential.bili_jct) {
      throw new BiliError('NOT_LOGGED_IN', '发评论需要先扫码登录');
    }
    const text = String(opts.text || '').trim();
    if (!text) throw new BiliError('BAD_REQUEST', '评论内容不能为空');
    if (text.length > 1000) throw new BiliError('BAD_REQUEST', '评论过长（上限 1000 字）');
    // 私信里拿到的只有 oid（aid），没有 bvid；有 aid 就不必再查一次视频。
    let aid = Number(opts.aid) || 0;
    let bvid = String(opts.bvid || '').trim();
    if (!aid) {
      if (!bvid) throw new BiliError('BAD_REQUEST', '需要 bvid 或 aid');
      const info = await this.video(bvid);
      aid = info.aid;
      bvid = info.bvid;
    }
    const data = { oid: aid, type: 1, message: text, plat: 1, statistics: { appId: 100, platform: 5 }, gaia_source: 'main_web' };
    if (opts.root) {
      // rpid 是 64 位整数：`Number()` 过 2^53 就开始往下取整，末几位变成 0，
      // 发出去要么「评论不存在」，要么挂到别人楼里。原样按字符串传，别在这里转数字。
      data.root = String(opts.root);
      data.parent = String(opts.parent || opts.root);
    }
    const result = await this.http.request(URLS.replyAdd, {
      method: 'POST',
      wbi: true,
      csrf: true,
      data,
    });
    // rpid_str 优先：有的响应同时给数字版和字符串版，数字版可能已经丢精度。
    const rawRpid = result && (result.rpid_str || result.rpid);
    const rpid = rawRpid === undefined || rawRpid === null || rawRpid === '' ? null : String(rawRpid);
    return { ok: true, bvid, aid, rpid, root: opts.root || null, parent: opts.parent || null };
  }

  async favorite(options) {
    const opts = options || {};
    if (!this.credential.sessdata || !this.credential.bili_jct) {
      throw new BiliError('NOT_LOGGED_IN', '收藏需要先扫码登录');
    }
    const folderId = Number(opts.folderId);
    if (!folderId) throw new BiliError('BAD_REQUEST', '没有配置目标收藏夹（设置页「偏好」里选一个）');
    const info = await this.video(opts.bvid);
    await this.http.request(URLS.favDeal, {
      method: 'POST',
      csrf: true,
      data: { rid: info.aid, type: 2, add_media_ids: folderId, del_media_ids: '' },
    });
    return { ok: true, bvid: info.bvid, folderId, title: info.title };
  }

  async favoriteFolders() {
    if (!this.credential.sessdata) throw new BiliError('NOT_LOGGED_IN', '看收藏夹需要先扫码登录');
    const mid = Number(this.credential.dedeuserid) || 0;
    if (!mid) throw new BiliError('NOT_LOGGED_IN', '凭据里没有 DedeUserID，请重新登录');
    const data = await this.http.request(URLS.favFolders, { params: { up_mid: mid } });
    return {
      folders: ((data && data.list) || []).map((f) => ({
        id: f.id,
        title: f.title,
        count: f.media_count || 0,
      })),
    };
  }

  async sendDm(options) {
    const opts = options || {};
    if (!this.credential.sessdata || !this.credential.bili_jct) {
      throw new BiliError('NOT_LOGGED_IN', '发私信需要先扫码登录');
    }
    const receiver = Number(opts.uid);
    if (!receiver) throw new BiliError('BAD_REQUEST', '没有收件人 UID');
    const sender = Number(this.credential.dedeuserid) || 0;
    if (!sender) throw new BiliError('NOT_LOGGED_IN', '凭据里没有 DedeUserID，请重新登录');
    const text = String(opts.text || '').trim();
    if (!text) throw new BiliError('BAD_REQUEST', '私信内容不能为空');
    const devId = this.credential.buvid3 || 'A6716E9A-7CE3-47AF-994B-F0B34178D28D';
    const data = {
      'msg[sender_uid]': sender,
      'msg[receiver_id]': receiver,
      'msg[receiver_type]': 1,
      'msg[msg_type]': 1,
      'msg[msg_status]': 0,
      'msg[content]': JSON.stringify({ content: text }),
      'msg[dev_id]': devId,
      'msg[new_face_version]': 0,
      'msg[timestamp]': Math.floor(Date.now() / 1000),
      from_filework: 0,
      build: 0,
      mobi_app: 'web',
    };
    const result = await this.http.request(
      URLS.dmSend + '?w_sender_uid=' + sender + '&w_receiver_id=' + receiver,
      { method: 'POST', csrf: true, data }
    );
    const inner = result && result.data;
    const msgKey =
      (result && result.msg_key) || (inner && inner.msg_key) || (inner && inner.msgKey) || null;
    if (!msgKey) {
      return {
        ok: false,
        delivered: false,
        reason: '接口回了成功但没有投递回执（msg_key）⇒ 很可能没送到（对方不收陌生人私信 / 被风控）',
        raw: result,
      };
    }
    return { ok: true, delivered: true, msgKey: String(msgKey).slice(0, 16), receiver };
  }

  async inbox() {
    if (!this.credential.sessdata) throw new BiliError('NOT_LOGGED_IN', '看消息需要先扫码登录');
    const tries = [
      this.http.request(URLS.msgUnread).catch(() => null),
      this.http.request(URLS.msgReply, { params: { pn: 1, ps: 8 } }).catch(() => null),
      this.http.request(URLS.msgAt, { params: { pn: 1, ps: 8 } }).catch(() => null),
    ];
    const settled = await Promise.all(tries);
    const unread = settled[0];
    const replies = settled[1];
    const at = settled[2];
    // 三个接口全挂时不能回一个空列表——那看起来和「没有人回你」一模一样，
    // 模型会照着「没人问」继续往下走。宁可报错。
    if (!unread && !replies && !at) {
      throw new BiliError('INBOX_UNAVAILABLE', '消息接口三个都没通（可能是风控或网络问题），现在拿不到收件箱。');
    }
    // source_id 是 oid（aid），不是 bvid；rpid 藏在 item.uri 里
    // （`bilibili://comment/detail/{oid}/{rpid}?…`），解不出来就只能回到顶层，回不到本人。
    // rpid 一律按字符串取：64 位 id 转 Number 会丢精度，拿它去回复就挂错楼。
    const mapItem = (it, type) => {
      const uri = String((it.item && it.item.uri) || it.uri || '');
      const parsed = /comment\/(?:detail\/)?(\d+)\/(\d+)/.exec(uri) || /comment\/detail\/(\d+)/.exec(uri);
      const aidFromUri = parsed ? parsed[1] : '';
      const rpid = parsed && parsed[2] ? parsed[2] : '';
      // aid 也是 oid，跟 rpid 同源，一律出字符串：bili_reply 的 aid 声明就是 string，
      // 这里回数字会让「原样传回去」变成一次类型不符的调用。
      const sourceId = String((it.item && it.item.source_id) || '').trim();
      return {
        type,
        user: (it.user && it.user.nickname) || '',
        text: String((it.item && it.item.source_content) || it.source_content || '').slice(0, 200),
        aid: aidFromUri || sourceId,
        rpid,
        title: String((it.item && it.item.title) || '').slice(0, 120),
        at: it.reply_time || it.at_time || it.ctime || '',
      };
    };
    const items = ((replies && replies.items) || []).map((it) => mapItem(it, 'reply'));
    const atItems = ((at && at.items) || []).map((it) => mapItem(it, 'at'));
    return {
      unread: unread || {},
      items: items.concat(atItems).slice(0, 16),
      partial: !unread || !replies || !at,
      note: '回复某人时用 bili_reply({aid, rpid, text, confirm:true})；aid 与 rpid 直接取这里的字段。',
    };
  }

  /**
   * 复核：接口回「发送成功」不等于公开可见（新号、被风控会压审）。
   * 顶层评论查主楼列表，楼中楼查该 root 下的回复列表。
   * 只回「查到 / 没查到」，绝不回「没发出去」——那是两件事。
   */
  async commentCheck(options) {
    const opts = options || {};
    // rpid 全程按字符串比：转成 Number 之后 64 位 id 会丢精度，
    // 于是「明明发出去了」也会被判成没查到——这条误报比不查更坏。
    const rpid = String(opts.rpid === undefined || opts.rpid === null ? '' : opts.rpid).trim();
    const root = String(opts.root === undefined || opts.root === null ? '' : opts.root).trim();
    if (!/^\d+$/.test(rpid)) throw new BiliError('BAD_REQUEST', '需要 rpid');
    const idsOf = (item) => [item.rpid, item.rpid_str].filter((v) => v !== undefined && v !== null).map(String);
    let aid = Number(opts.aid) || 0;
    if (!aid) {
      if (!opts.bvid) throw new BiliError('BAD_REQUEST', '需要 bvid 或 aid');
      aid = (await this.video(opts.bvid)).aid;
    }
    if (root && root !== rpid) {
      const data = await this.http.request(URLS.replyReplies, {
        params: { type: 1, oid: aid, root, ps: 20, pn: 1 },
      });
      const list = (data && data.replies) || [];
      const hit = list.find((item) => idsOf(item).indexOf(rpid) !== -1);
      return {
        visible: Boolean(hit),
        state: hit ? Number(hit.state || 0) : null,
        detail: hit ? '' : '该楼中楼列表里没有这条（ps=20 只翻了一页）',
        checked: list.length,
      };
    }
    const data = await this.http.request(URLS.replyMain, {
      params: { type: 1, oid: aid, mode: 2, next: 0, ps: 30 },
    });
    const list = (data && data.replies) || [];
    const hit = list.find((item) => idsOf(item).indexOf(rpid) !== -1);
    return {
      visible: Boolean(hit),
      state: hit ? Number(hit.state || 0) : null,
      detail: hit ? '' : '最新 30 条主楼里没有这条',
      checked: list.length,
    };
  }

  async resolveUser(name) {
    const keyword = String(name || '').trim();
    if (!keyword) throw new BiliError('BAD_REQUEST', '昵称不能为空');
    const data = await this.http.request(URLS.search, {
      wbi: true,
      params: { search_type: 'bili_user', keyword, page: 1, page_size: 10 },
    });
    const list = (data && data.result) || [];
    return {
      matches: list.slice(0, 5).map((u) => ({
        mid: u.mid,
        uname: u.uname,
        fans: u.fans || 0,
        videos: u.videos || 0,
        sign: String(u.usign || '').slice(0, 80),
      })),
    };
  }

}

class LoginSession {
  constructor(http) {
    this.http = http;
    this.key = '';
    this.url = '';
    this.createdAt = 0;
    this.credential = null;
  }

  async start() {
    const data = await this.http._rawJson(URLS.qrGenerate);
    if (!data || data.code !== 0 || !data.data || !data.data.qrcode_key) {
      throw new BiliError('QR_FAILED', '生成登录二维码失败：' + ((data && data.message) || '未知原因'));
    }
    this.key = data.data.qrcode_key;
    this.url = data.data.url;
    this.createdAt = Date.now();
    this.credential = null;
    return { key: this.key, url: this.url, expiresIn: 180 };
  }

  /** status: waiting | scanned | expired | ok */
  async poll() {
    if (!this.key) return { status: 'no_session', message: '没有进行中的登录，请重新获取二维码' };
    const { response, text } = await this.http._rawFetch(
      URLS.qrPoll + '?qrcode_key=' + encodeURIComponent(this.key),
      {}
    );
    let body;
    try {
      body = JSON.parse(text);
    } catch (_error) {
      throw new BiliError('NOT_JSON', '登录状态查询返回异常（HTTP ' + response.status + '）');
    }
    if (!body || body.code !== 0 || !body.data) {
      throw new BiliError('QR_POLL_FAILED', (body && body.message) || '登录状态查询失败');
    }
    const code = body.data.code;
    if (code === 86101) return { status: 'waiting', message: '还没扫码' };
    if (code === 86090) return { status: 'scanned', message: '已扫码，请在手机上确认登录' };
    if (code === 86038) return { status: 'expired', message: '二维码已过期，请重新获取' };
    if (code !== 0) {
      return { status: 'error', message: body.data.message || '未知登录状态 code=' + code };
    }
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const credential = parseLoginCredential(body.data.url || '', setCookies);
    if (!credential.sessdata) {
      return { status: 'error', message: '登录成功但没拿到 SESSDATA，请重试' };
    }
    this.credential = credential;
    return { status: 'ok', credential, message: '登录成功' };
  }
}

module.exports = { Bili, LoginSession, BiliError, httpsUrl, numberText, durationText };
