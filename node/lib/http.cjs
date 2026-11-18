'use strict';

/**
 * B 站 HTTP 客户端（零依赖，只用 Node 内置 fetch / crypto）
 *
 * 为什么不用 cindy.fetch：主机的代发通道会接管 Cookie / Authorization 头，
 * 而 B 站的全部账号能力（评论、私信、收藏、AI 字幕）都靠 Cookie 里的
 * SESSDATA + bili_jct。所以这里由随包 Node 进程自己发请求——这也是 Cindy
 * 的 node 能力的正常用法（进程拥有本机网络权限，插件详情会如实披露）。
 *
 * 负责三件事：
 *   1. Cookie 组装（buvid3 / buvid4 缺失时自动到 finger/spi 取一份）
 *   2. WBI 签名（nav 拿 img_key/sub_key → mixin 重排 → w_rid=md5(query+key)）
 *   3. 频控与风控退避（每次请求之间至少隔 300ms；412 刷新 buvid 重试一次）
 */

const crypto = require('node:crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const THROTTLE_MS = 300;
const WBI_TTL_MS = 30 * 60 * 1000;

class BiliError extends Error {
  constructor(code, message, extra) {
    super(message || 'B 站接口返回错误');
    this.name = 'BiliError';
    this.code = code;
    Object.assign(this, extra || {});
  }
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把解码过的值塞回 Cookie：B 站认的是 URL 编码后的形态（SESSDATA 里有 %2C）。 */
function cookieEncode(value) {
  return encodeURIComponent(String(value));
}

class BiliHttp {
  constructor(credential) {
    this.cred = credential && typeof credential === 'object' ? { ...credential } : {};
    this.wbiKeys = null;
    this.wbiTime = 0;
    this.lastAt = 0;
    this.throttleMs = THROTTLE_MS;
  }

  get loggedIn() {
    return Boolean(this.cred.sessdata);
  }

  cookieHeader() {
    const parts = [];
    if (this.cred.sessdata) parts.push('SESSDATA=' + this.cred.sessdata);
    if (this.cred.bili_jct) parts.push('bili_jct=' + this.cred.bili_jct);
    if (this.cred.buvid3) parts.push('buvid3=' + this.cred.buvid3);
    if (this.cred.buvid4) parts.push('buvid4=' + this.cred.buvid4);
    if (this.cred.dedeuserid) parts.push('DedeUserID=' + this.cred.dedeuserid);
    if (this.cred.dedeuserid) parts.push('DedeUserID__ckMd5=' + (this.cred.dedeuserid_ckmd5 || ''));
    const cleaned = parts.filter((p) => !p.endsWith('='));
    return cleaned.join('; ');
  }

  async ensureCookie() {
    if (this.cred.buvid3) return;
    let body;
    try {
      body = await this._rawJson('https://api.bilibili.com/x/frontend/finger/spi');
    } catch (_error) {
      return; // 拿不到 buvid 也继续：公开接口通常仍能通，风控接口会自己报错
    }
    const data = (body && body.data) || {};
    if (data.b_3) this.cred.buvid3 = data.b_3;
    if (data.b_4) this.cred.buvid4 = data.b_4;
  }

  async ensureWbi(force) {
    if (!force && this.wbiKeys && Date.now() - this.wbiTime < WBI_TTL_MS) {
      return this.wbiKeys;
    }
    const body = await this._rawJson('https://api.bilibili.com/x/web-interface/nav');
    const img = body && body.data && body.data.wbi_img;
    if (!img || !img.img_url || !img.sub_url) {
      throw new BiliError('WBI_UNAVAILABLE', '取不到 WBI 签名密钥（B 站 nav 接口无 wbi_img）');
    }
    const imgKey = img.img_url.split('/').pop().split('.')[0];
    const subKey = img.sub_url.split('/').pop().split('.')[0];
    const raw = imgKey + subKey;
    const key = MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
    this.wbiKeys = { key };
    this.wbiTime = Date.now();
    return this.wbiKeys;
  }

  async sign(params) {
    const { key } = await this.ensureWbi();
    const wts = Math.round(Date.now() / 1000);
    const all = Object.assign({}, params, { wts });
    const query = Object.keys(all)
      .sort()
      .map((name) => {
        const value = String(all[name]);
        const filtered = Array.from(value)
          .filter((ch) => "!'()*".indexOf(ch) === -1)
          .join('');
        return encodeURIComponent(name) + '=' + encodeURIComponent(filtered);
      })
      .join('&');
    return query + '&w_rid=' + md5(query + key);
  }

  async _throttle() {
    const now = Date.now();
    const wait = this.lastAt + this.throttleMs - now;
    if (wait > 0) await sleep(wait);
    this.lastAt = Date.now();
  }

  async _rawFetch(url, init) {
    await this._throttle();
    const headers = {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(init.headers || {}),
    };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(url, {
      method: init.method || 'GET',
      headers,
      body: init.body,
      redirect: 'follow',
    });
    const text = await response.text();
    return { response, text };
  }

  async _rawJson(url, init) {
    const { response, text } = await this._rawFetch(url || '', init || {});
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (_error) {
      throw new BiliError(
        'NOT_JSON',
        'B 站返回的不是 JSON（HTTP ' + response.status + '），多半被风控拦了',
        { httpStatus: response.status }
      );
    }
    return body;
  }

  /**
   * 发一个 B 站接口请求，返回 data 字段；code !== 0 直接抛 BiliError。
   * opts: { method, params, data, wbi, csrf, expectLogin }
   */
  async request(url, opts) {
    const options = opts || {};
    let attempt = 0;
    let lastError = null;
    while (attempt < 2) {
      attempt += 1;
      try {
        await this.ensureCookie();
        let finalUrl = url;
        let body;
        const method = (options.method || 'GET').toUpperCase();
        let query = '';
        if (options.wbi) {
          query = await this.sign(options.params || {});
        } else if (options.params) {
          query = Object.keys(options.params)
            .filter((k) => options.params[k] !== undefined && options.params[k] !== null)
            .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(options.params[k])))
            .join('&');
        }
        if (query) finalUrl += (finalUrl.indexOf('?') === -1 ? '?' : '&') + query;
        if (method !== 'GET') {
          const form = new URLSearchParams();
          const data = Object.assign({}, options.data || {});
          if (options.csrf) data.csrf = this.cred.bili_jct || '';
          for (const key of Object.keys(data)) {
            const value = data[key];
            if (value === undefined || value === null) continue;
            form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
          }
          body = form.toString();
        }
        const { response, text } = await this._rawFetch(finalUrl, {
          method,
          body,
          headers: body
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : undefined,
        });
        if (response.status === 412) {
          this.cred.buvid3 = '';
          this.cred.buvid4 = '';
          await this.ensureCookie();
          this.throttleMs = 800;
          lastError = new BiliError('RISK_CONTROL', '被 B 站风控拦下（HTTP 412），稍后再试');
          continue;
        }
        let payload;
        try {
          payload = JSON.parse(text);
        } catch (_error) {
          throw new BiliError(
            'NOT_JSON',
            'B 站返回的不是 JSON（HTTP ' + response.status + '）',
            { httpStatus: response.status }
          );
        }
        if (payload && typeof payload.code === 'number' && payload.code !== 0) {
          throw new BiliError(
            codeToErrorCode(payload.code),
            payload.message || payload.msg || 'B 站接口返回 code=' + payload.code,
            { biliCode: payload.code }
          );
        }
        return payload ? payload.data : null;
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof BiliError &&
          (error.code === 'RISK_CONTROL' || error.code === 'NETWORK_ERROR');
        if (!retryable) throw error;
      }
    }
    throw lastError || new BiliError('UNKNOWN', 'B 站请求失败');
  }
}

function codeToErrorCode(code) {
  if (code === -101) return 'NOT_LOGGED_IN';
  if (code === -400) return 'BAD_REQUEST';
  if (code === -403) return 'FORBIDDEN';
  if (code === -404) return 'NOT_FOUND';
  if (code === -412) return 'RISK_CONTROL';
  if (code === -509) return 'RATE_LIMITED';
  if (code === 62002) return 'VIDEO_UNAVAILABLE';
  if (code === 62012) return 'VIDEO_PRIVATE';
  return 'BILI_ERROR';
}

/** 从扫码登录成功回来的 URL / Set-Cookie 里取凭证。 */
function parseLoginCredential(url, setCookies) {
  const out = {};
  const apply = (key, value) => {
    if (!value) return;
    if (key === 'SESSDATA') out.sessdata = value;
    else if (key === 'bili_jct') out.bili_jct = value;
    else if (key === 'DedeUserID') out.dedeuserid = value;
    else if (key === 'DedeUserID__ckMd5') out.dedeuserid_ckmd5 = value;
    else if (key === 'buvid3') out.buvid3 = value;
    else if (key === 'buvid4') out.buvid4 = value;
  };
  // 1) 优先 Set-Cookie：里面的值就是原样要回传的编码形态
  for (const line of setCookies || []) {
    const pair = String(line).split(';')[0];
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    apply(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  // 2) 再从 URL 查询串补缺（不解码，保持 %2C 原样）
  if (url && url.indexOf('?') !== -1) {
    const query = url.slice(url.indexOf('?') + 1).split('#')[0];
    for (const piece of query.split('&')) {
      const index = piece.indexOf('=');
      if (index <= 0) continue;
      const key = piece.slice(0, index);
      const value = piece.slice(index + 1);
      if (key === 'SESSDATA' || key === 'bili_jct' || key === 'DedeUserID') {
        if (!out[key === 'DedeUserID' ? 'dedeuserid' : key === 'SESSDATA' ? 'sessdata' : 'bili_jct']) {
          apply(key, value);
        }
      }
    }
  }
  return out;
}

module.exports = { BiliHttp, BiliError, parseLoginCredential, UA, cookieEncode };
