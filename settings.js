'use strict';

/**
 * 刷B站 · 设置页
 *
 * 只读写 /kv（与 main.js 同一份参数）；不碰凭证，凭证只在插件自身的私有数据目录。
 * 默认值与 main.js 的 DEFAULT_CONFIG 保持一致：少了哪个键就按默认值补上，保存时整体写回。
 */

var DEFAULTS = {
  keywords: [],
  autoKeyword: false,
  excludeWords: [],
  searchSort: 'pubdate',
  searchPages: 2,
  fetchPerRound: 8,
  perDay: 5,
  manualMax: 3,
  manualCooldownMin: 3,
  reportLevel: 'full',
  // 时段配额：与 main.js 的 DEFAULT_CONFIG 一致（整天 ×1 = 1.3.x 的老行为）。
  segments: [{ start: '00:00', end: '24:00', rounds: 1 }],
  autoComment: false,
  commentPerRound: 1,
  mentionName: '',
  commentLength: 'medium',
  dmMode: 'off',
  dmUid: 0,
  dmPerDay: 2,
  replyToComments: false,
  replyPerRound: 1,
  replyPerDay: 5,
  inboxChecksPerDay: 0,
  inboxMinGapMin: 15,
  favFolderId: 0,
  personaPrompt: ''
};

var TEXT_KEYS = ['personaPrompt', 'mentionName'];
var LIST_KEYS = ['keywords', 'excludeWords'];
var BOOL_KEYS = ['autoKeyword', 'autoComment', 'replyToComments'];
var NUMBER_KEYS = [
  'searchPages', 'fetchPerRound', 'perDay', 'manualMax', 'manualCooldownMin',
  'commentPerRound', 'dmUid', 'dmPerDay', 'replyPerRound', 'replyPerDay', 'inboxChecksPerDay', 'inboxMinGapMin',
  'favFolderId'
];
var SELECT_KEYS = ['searchSort', 'reportLevel', 'commentLength', 'dmMode'];
/**
 * 1.3.x 及更早的设置键，保存时一并清掉。
 * 时段控制权已经交给 cron（peakValley / noon / night 不再有任何作用），
 * autoRoundsPerDay 已经迁进 segments；留着它们等于在 /kv 里存第二份时间设置，
 * 下次谁读谁都会以为它还生效。
 */
var LEGACY_KEYS = ['autoRoundsPerDay', 'peakValley', 'noon', 'night'];

// 与 main.js 的 NUM_RANGES 逐字一致：设置页是入口，在这里就钳住才不会把 999 存进去。
var RANGES = {
  searchPages: [1, 5],
  fetchPerRound: [1, 30],
  perDay: [0, 40],
  manualMax: [1, 20],
  manualCooldownMin: [0, 240],
  commentPerRound: [0, 20],
  dmUid: [0, 9007199254740991],
  dmPerDay: [0, 5],
  replyPerRound: [0, 5],
  replyPerDay: [0, 40],
  inboxChecksPerDay: [0, 48],
  inboxMinGapMin: [0, 720],
  favFolderId: [0, 9007199254740991]
};

var statusEl = document.querySelector('#status');
var saveButton = document.querySelector('#save');
var resetButton = document.querySelector('#reset');
var stored = {};

function setStatus(text) {
  statusEl.textContent = text || '';
}

function readList(value) {
  return String(value || '')
    .split(/[\n,，]+/)
    .map(function (item) { return item.trim(); })
    .filter(Boolean)
    .slice(0, 50);
}

function clampNumber(key, value) {
  var fallback = DEFAULTS[key];
  var range = RANGES[key] || [0, 9007199254740991];
  var number = Math.round(Number(value));
  if (!isFinite(number)) return fallback;
  return Math.max(range[0], Math.min(range[1], number));
}

/**
 * 收藏夹下拉的候选来自 main.js 写进 /kv 的缓存（这个页面是零桥沙箱页：
 * 只有 /kv，没有工具通道，自己拉不了收藏夹）。没有缓存就只是一个空的下拉，手填照样能用。
 */
function fillFolderOptions(folders) {
  var list = document.querySelector('#favFolderList');
  if (!list) return;
  list.textContent = '';
  (Array.isArray(folders) ? folders : []).forEach(function (folder) {
    if (!folder || !folder.id) return;
    var option = document.createElement('option');
    option.value = String(folder.id);
    option.label = (folder.title || String(folder.id)) + '（' + (folder.count || 0) + ' 条）';
    list.appendChild(option);
  });
}

function fillForm(config) {
  LIST_KEYS.forEach(function (key) {
    var input = document.getElementById(key);
    if (input) input.value = (config[key] || []).join('\n');
  });
  TEXT_KEYS.forEach(function (key) {
    var input = document.getElementById(key);
    if (input) input.value = config[key] || '';
  });
  BOOL_KEYS.forEach(function (key) {
    var input = document.getElementById(key);
    if (input) input.checked = Boolean(config[key]);
  });
  NUMBER_KEYS.forEach(function (key) {
    var input = document.getElementById(key);
    if (input) input.value = String(config[key]);
  });
  SELECT_KEYS.forEach(function (key) {
    var input = document.getElementById(key);
    if (input) input.value = String(config[key]);
  });
  renderSegments(config.segments);
}

function collectForm() {
  var config = {};
  LIST_KEYS.forEach(function (key) {
    config[key] = readList(document.getElementById(key).value);
  });
  TEXT_KEYS.forEach(function (key) {
    config[key] = String(document.getElementById(key).value || '').trim();
  });
  BOOL_KEYS.forEach(function (key) {
    config[key] = Boolean(document.getElementById(key).checked);
  });
  NUMBER_KEYS.forEach(function (key) {
    config[key] = clampNumber(key, document.getElementById(key).value);
  });
  SELECT_KEYS.forEach(function (key) {
    config[key] = String(document.getElementById(key).value || DEFAULTS[key]);
  });
  config.segments = collectSegments();
  return config;
}

// ---------------------------------------------------------------- 时段配额
//
// 这里是唯一能让使用者看见「一天怎么分配」的地方：每一段是「一天之内的一个时段 +
// 这段最多跑几轮」。**不跨零点**——跨零点会让「这一轮算哪一天」变得要命，而它本来
// 就能拆成两段表达（设置页的提示里也这么写）。
//
// 校验放在保存前，不合法就整份不保存、并说清楚是哪一段错：静默丢掉一段等于偷偷
// 改了使用者配的额度，第二天他会以为插件坏了。

var segmentListEl = document.querySelector('#segmentList');
var SEGMENT_MAX_ROUNDS = 6;
var SEGMENT_MAX_COUNT = 6;

/**
 * 表单自己的 `HH:MM` ↔ 分钟换算，**只用来当场校验和排序**（这个页面是零桥沙箱页：
 * 没有 require、也调不到随包 Node，所以用不了 decide.cjs）。
 *
 * 真正生效的段表永远是 `schedule/decide.cjs` 洗完的那一张——判定、写镜像、闸门脚本
 * 都只认它。这里名字刻意不叫 `parseClock`：那是判定规则的名字，全仓库只该有一个
 * 定义（`plugins/_scratch/test-main-gate.cjs` §12 会检查）。
 */
function formMinutes(text) {
  var match = /^(\d{1,2}):(\d{2})$/.exec(String(text === undefined || text === null ? '' : text).trim());
  if (!match) return NaN;
  var hours = Number(match[1]);
  var minutes = Number(match[2]);
  if (minutes > 59 || hours > 24) return NaN;
  var total = hours * 60 + minutes;
  return total <= 1440 ? total : NaN;
}

function formClock(minutes) {
  function pad2(n) { return String(n).padStart(2, '0'); }
  return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
}

function addSegmentRow(seg) {
  var item = String(seg && seg.start !== undefined ? seg.start : '06:00');
  var row = document.createElement('div');
  row.className = 'seg';

  var start = document.createElement('input');
  start.type = 'text';
  start.className = 'seg-start';
  start.value = item;
  start.setAttribute('aria-label', '这一段从几点开始');
  start.setAttribute('placeholder', '06:00');
  start.setAttribute('inputmode', 'numeric');

  var dash = document.createElement('span');
  dash.className = 'sep';
  dash.textContent = '–';

  var end = document.createElement('input');
  end.type = 'text';
  end.className = 'seg-end';
  end.value = String(seg && seg.end !== undefined ? seg.end : '10:00');
  end.setAttribute('aria-label', '这一段到几点结束');
  end.setAttribute('placeholder', '10:00');
  end.setAttribute('inputmode', 'numeric');

  var times = document.createElement('span');
  times.className = 'sep';
  times.textContent = '×';

  var rounds = document.createElement('input');
  rounds.type = 'number';
  rounds.className = 'seg-rounds';
  rounds.min = '1';
  rounds.max = String(SEGMENT_MAX_ROUNDS);
  rounds.step = '1';
  rounds.value = String(seg && seg.rounds ? seg.rounds : 1);
  rounds.setAttribute('aria-label', '这一段最多跑几轮');

  var unit = document.createElement('span');
  unit.className = 'sep';
  unit.textContent = '轮';

  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'del';
  del.textContent = '删除';
  del.addEventListener('click', function () {
    if (segmentListEl.querySelectorAll('.seg').length <= 1) {
      setStatus('至少要留一段。想整天放开，就写 00:00–24:00。');
      return;
    }
    row.remove();
  });

  row.appendChild(start);
  row.appendChild(dash);
  row.appendChild(end);
  row.appendChild(times);
  row.appendChild(rounds);
  row.appendChild(unit);
  row.appendChild(del);
  segmentListEl.appendChild(row);
}

function renderSegments(segments) {
  if (!segmentListEl) return;
  segmentListEl.textContent = '';
  var list = Array.isArray(segments) ? segments.filter(function (seg) { return seg && seg.start && seg.end; }) : [];
  if (!list.length) list = DEFAULTS.segments.slice();
  list.slice(0, SEGMENT_MAX_COUNT).forEach(addSegmentRow);
}

/**
 * 读出段表。任何一处不合法都抛错（保存中止），不静默修正：
 * 静默修正会让使用者以为「填的就是生效的」。
 */
function collectSegments() {
  var rows = segmentListEl ? segmentListEl.querySelectorAll('.seg') : [];
  var out = [];
  for (var index = 0; index < rows.length; index += 1) {
    var number = index + 1;
    var start = formMinutes(rows[index].querySelector('.seg-start').value);
    var end = formMinutes(rows[index].querySelector('.seg-end').value);
    var rounds = Math.round(Number(rows[index].querySelector('.seg-rounds').value));
    if (!isFinite(start) || !isFinite(end) || start >= 1440) {
      throw new Error('第 ' + number + ' 段的时间没写对：要写成 HH:MM（例如 06:00），最晚到 24:00。');
    }
    if (!(end > start)) {
      throw new Error('第 ' + number + ' 段的结束时间要晚于开始时间；要跨到第二天请拆成两段（例如 22:00–24:00 和 00:00–02:00）。');
    }
    if (!isFinite(rounds) || rounds < 1 || rounds > SEGMENT_MAX_ROUNDS) {
      throw new Error('第 ' + number + ' 段「最多跑几轮」要在 1–' + SEGMENT_MAX_ROUNDS + ' 之间。');
    }
    for (var other = 0; other < out.length; other += 1) {
      var prev = out[other];
      var prevStart = formMinutes(prev.start);
      var prevEnd = formMinutes(prev.end);
      if (start < prevEnd && prevStart < end) {
        throw new Error('第 ' + number + ' 段和第 ' + (other + 1) + ' 段时间重叠了，同一时刻只能属于一段。');
      }
    }
    out.push({ start: formClock(start), end: formClock(end), rounds: rounds });
  }
  if (!out.length) return DEFAULTS.segments.slice();
  if (out.length > SEGMENT_MAX_COUNT) throw new Error('最多配 ' + SEGMENT_MAX_COUNT + ' 段。');
  out.sort(function (a, b) { return formMinutes(a.start) - formMinutes(b.start); });
  return out;
}

if (segmentListEl) {
  document.querySelector('#segmentAdd').addEventListener('click', function () {
    if (segmentListEl.querySelectorAll('.seg').length >= SEGMENT_MAX_COUNT) {
      setStatus('最多配 ' + SEGMENT_MAX_COUNT + ' 段。');
      return;
    }
    // 新段默认接在最后一段结束的地方，省得还要手算一个不重叠的区间。
    var rows = segmentListEl.querySelectorAll('.seg');
    var lastEnd = rows.length ? rows[rows.length - 1].querySelector('.seg-end').value : '00:00';
    var startMin = formMinutes(lastEnd);
    if (!isFinite(startMin) || startMin >= 1440) startMin = 0;
    var endMin = Math.min(1440, startMin + 240);
    addSegmentRow({ start: formClock(startMin), end: formClock(endMin), rounds: 1 });
  });
  document.querySelector('#segmentPreset').addEventListener('click', function () {
    renderSegments([
      { start: '06:00', end: '10:00', rounds: 1 },
      { start: '18:00', end: '24:00', rounds: 1 },
    ]);
    setStatus('已填成「早上一轮 + 晚上一轮」，记得点「保存设置」。');
  });
}

function setTab(name) {
  var buttons = document.querySelectorAll('#tabs button');
  for (var index = 0; index < buttons.length; index += 1) {
    var button = buttons[index];
    button.setAttribute('aria-selected', button.getAttribute('data-tab') === name ? 'true' : 'false');
  }
  var panes = document.querySelectorAll('fieldset[id^="pane-"]');
  for (var i = 0; i < panes.length; i += 1) {
    panes[i].hidden = panes[i].id !== 'pane-' + name;
  }
}

document.querySelector('#tabs').addEventListener('click', function (event) {
  var button = event.target.closest('button[data-tab]');
  if (!button) return;
  setTab(button.getAttribute('data-tab'));
});

saveButton.addEventListener('click', async function () {
  if (saveButton.disabled) return;
  saveButton.disabled = true;
  setStatus('正在保存…');
  try {
    var config = collectForm();
    var next = Object.assign({}, stored, config);
    // 老键（autoRoundsPerDay / peakValley / noon / night）不留在 /kv 里：
    // 留着会有两份时间设置，而只有 segments 是生效的那一份。
    LEGACY_KEYS.forEach(function (key) { delete next[key]; });
    var response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(next) });
    if (!response.ok) throw new Error('保存失败（HTTP ' + response.status + '）');
    stored = next;
    setStatus('已保存，正在同步给自动任务…');
    // 保存之后请插件立刻重写闸门镜像（%APPDATA%\Cindy\duty\cindy-bili-scroll/）。不这么做会死锁：前置检查脚本
    // 读的镜像只在插件被调用时更新，而插件正是被这个脚本挡住才没人调用它——
    // 把互动轮从关改成开，脚本会一直读到「关」，永远不放行，也就永远没有下一次同步。
    var synced = await syncMirror();
    if (synced === 'ok') setStatus('已保存，自动任务的前置检查也同步好了。');
    else if (synced === 'partial') setStatus('已保存。设置同步给自动任务了，但插件读不到自己的记账，闸门看到的当天记录停在上一份——自动任务下一次跑起来会自动对齐。');
    else setStatus('已保存。插件这会儿没醒，自动任务的前置检查还没同步；在聊天里说一句「刷B站 看设置」可以补上。');
  } catch (error) {
    setStatus(error && error.message ? error.message : '保存失败');
  } finally {
    saveButton.disabled = false;
  }
});

resetButton.addEventListener('click', function () {
  fillForm(DEFAULTS);
  setStatus('已填回默认值，记得点「保存设置」。');
});

// ---------------------------------------------------------------- 登录（与插件后台通信）

/**
 * 这个设置页是零桥沙箱页：只有 /kv，没有工具通道，也不能直连 B站。所以登录这件
 * 事只能摆在页面上、活由插件后台（电子脑）来干。
 *
 * 中间那条线是 BroadcastChannel。插件后台是按需拉起的，刚打开设置页时它多半没
 * 在跑，所以先 fetch 一次 /wake 叫醒，再按 reqId 每几百毫秒重发一次直到收到回执；
 * 后台那边按 reqId 去重，重发不会把同一件事干两遍。
 *
 * Cookie 只在这里递一次：进内存 → 问 B站「这是谁」→ 落盘。它不进 /kv、不进日志、
 * 也不在回执里带回来。
 */
var GHOST_ID = 'cindy-bili-scroll';
var BRIDGE_NAME = 'cindy-bili-scroll';
var channel = null;
var requestSeq = 0;

function openChannel() {
  if (!channel && typeof BroadcastChannel === 'function') channel = new BroadcastChannel(BRIDGE_NAME);
  return channel;
}

async function wakeGhost() {
  var urls = ['/wake', 'cindy-ghost://' + GHOST_ID + '/wake'];
  for (var index = 0; index < urls.length; index += 1) {
    try {
      var response = await fetch(urls[index]);
      if (response && response.ok) return true;
    } catch (error) {
      /* 换下一个地址再试 */
    }
  }
  return false;
}

/**
 * 保存之后把闸门镜像对齐一次（尽力而为）。
 *
 * 失败不算保存失败：/kv 已经写好了，插件下次被调用时还会自己同步一次。
 */
async function syncMirror() {
  try {
    await wakeGhost();
    var data = await askGhost('sync', {}, 8000);
    if (!data || !data.synced) return 'failed';
    return data.partial ? 'partial' : 'ok';
  } catch (error) {
    return 'failed';
  }
}

function askGhost(action, payload, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var bc = openChannel();
    if (!bc) {
      reject(new Error('这个界面没法跟插件后台通信（宿主版本较旧），请到卡片里的「登录」页签操作。'));
      return;
    }
    var reqId = 'q' + Date.now() + '-' + (requestSeq += 1);
    var settled = false;
    var repeater = null;
    var deadline = null;

    function finish(error, data) {
      if (settled) return;
      settled = true;
      if (repeater) clearInterval(repeater);
      if (deadline) clearTimeout(deadline);
      bc.removeEventListener('message', onMessage);
      if (error) reject(error); else resolve(data || {});
    }

    function onMessage(event) {
      var msg = event && event.data;
      if (!msg || msg.type !== 'bili-login-reply' || msg.reqId !== reqId) return;
      if (msg.ok) finish(null, msg.data);
      else finish(new Error(msg.error || '操作失败'));
    }

    function send() {
      if (settled) return;
      bc.postMessage({ type: 'bili-login', reqId: reqId, action: action, payload: payload || {} });
    }

    bc.addEventListener('message', onMessage);
    send();
    repeater = setInterval(send, 600);
    deadline = setTimeout(function () {
      finish(new Error('插件没有回应。稍后再试一次；一直这样就到卡片里的「登录」页签操作。'));
    }, timeoutMs || 20000);
  });
}

var loginStateEl = document.querySelector('#loginState');
var loginVerifyButton = document.querySelector('#loginVerify');
var qrCanvas = document.querySelector('#qrCanvas');
var qrHint = document.querySelector('#qrHint');
var qrStartButton = document.querySelector('#qrStart');
var qrCancelButton = document.querySelector('#qrCancel');
var cookieFields = {
  SESSDATA: document.querySelector('#cookieSessdata'),
  bili_jct: document.querySelector('#cookieJct'),
  DedeUserID: document.querySelector('#cookieUid')
};
var cookieSubmitButton = document.querySelector('#cookieSubmit');
var cookieClearButton = document.querySelector('#cookieClear');
var logoutButton = document.querySelector('#logout');
var logoutHint = document.querySelector('#logoutHint');
var qrTimer = null;
var qrBusy = false;
var logoutArmed = false;

function describeAccount(account) {
  if (!account) return '未知账号';
  var name = account.uname || ('UID ' + (account.mid || '?'));
  return name + (account.level ? ' · Lv' + account.level : '');
}

function setLoginState(text) {
  loginStateEl.textContent = text;
}

function stopQrPolling() {
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = null;
  qrBusy = false;
  qrCancelButton.hidden = true;
}

function drawQr(url) {
  var context = qrCanvas.getContext('2d');
  if (!context || typeof qrcode !== 'function') return false;
  var qr = qrcode(0, 'M');
  qr.addData(String(url));
  qr.make();
  var count = qr.getModuleCount();
  var scale = Math.max(3, Math.floor(180 / count));
  qrCanvas.width = count * scale;
  qrCanvas.height = count * scale;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, qrCanvas.width, qrCanvas.height);
  context.fillStyle = '#000000';
  for (var row = 0; row < count; row += 1) {
    for (var col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) context.fillRect(col * scale, row * scale, scale, scale);
    }
  }
  return true;
}

function startQrPolling() {
  stopQrPolling();
  qrCancelButton.hidden = false;
  qrTimer = setInterval(async function () {
    // 页面不在前台就不问：二维码本来就有 180 秒有效期，人不在屏幕前的时候
    // 每 3 秒打一次 B站 只是白花接口。
    if (document.hidden || qrBusy) return;
    qrBusy = true;
    try {
      var data = await askGhost('qr-poll', {}, 12000);
      if (data.status === 'ok') {
        stopQrPolling();
        qrCanvas.hidden = true;
        qrHint.textContent = '登录成功。';
        setLoginState('已登录：' + describeAccount(data.account));
        setStatus(data.message || '登录成功');
        return;
      }
      if (data.status === 'scanned') {
        qrHint.textContent = '已扫码，请在手机上点确认。';
        return;
      }
      if (data.status === 'expired' || data.status === 'error' || data.status === 'no_session') {
        stopQrPolling();
        qrCanvas.hidden = true;
        qrHint.textContent = data.message || '二维码失效了，重新点一次「生成二维码」。';
      }
    } catch (error) {
      /* 一次没回应不算失败，下一拍再问；用户不想等了可以点取消 */
    } finally {
      qrBusy = false;
    }
  }, 3000);
}

qrStartButton.addEventListener('click', async function () {
  if (qrStartButton.disabled) return;
  qrStartButton.disabled = true;
  stopQrPolling();
  qrCanvas.hidden = true;
  qrHint.textContent = '正在向 B站 要二维码…';
  setStatus('');
  try {
    await wakeGhost();
    var data = await askGhost('qr-start', {});
    if (!data.url) throw new Error('没拿到二维码地址，稍后再试一次。');
    if (!drawQr(data.url)) throw new Error('二维码画不出来（这个宿主少了绘图能力），改用下面的 Cookie 登录。');
    qrCanvas.hidden = false;
    qrHint.textContent = '用手机 B站 App 扫码，确认时选「记住我 / 长期」。二维码 180 秒内有效。';
    startQrPolling();
  } catch (error) {
    qrHint.textContent = (error && error.message) || '取二维码失败';
  } finally {
    qrStartButton.disabled = false;
  }
});

qrCancelButton.addEventListener('click', function () {
  stopQrPolling();
  qrCanvas.hidden = true;
  qrHint.textContent = '已取消。要登录再点一次「生成二维码」。';
});

var COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID'];

/** 从一段「名字=值; 名字=值」里挑出我们要的三个（名字不分大小写）。 */
function extractCookiePairs(text) {
  var found = {};
  String(text || '').split(';').forEach(function (part) {
    var item = part.trim();
    if (!item) return;
    var eq = item.indexOf('=');
    if (eq <= 0) return;
    var name = item.slice(0, eq).trim().toLowerCase();
    var value = item.slice(eq + 1).trim();
    if (!value) return;
    for (var index = 0; index < COOKIE_NAMES.length; index += 1) {
      if (name === COOKIE_NAMES[index].toLowerCase()) found[COOKIE_NAMES[index]] = value;
    }
  });
  return found;
}

function clearCookieFields() {
  COOKIE_NAMES.forEach(function (name) {
    if (cookieFields[name]) cookieFields[name].value = '';
  });
}

function readCookieFields() {
  var fields = {};
  COOKIE_NAMES.forEach(function (name) {
    if (cookieFields[name]) fields[name] = String(cookieFields[name].value || '').trim();
  });
  return fields;
}

/**
 * 三个输入框的粘贴处理：
 * - 整段请求头（或「名字=值」好几段）粘进任意一栏 → 认名字，自动分到各自的栏里；
 * - 只粘了一个「名字=值」，且名字就是这一栏的 → 把名字削掉再放进去；
 * - 否则当值本身处理，只把结尾多余的分号去掉。
 * 名字写在每栏的 label 上（不是占位符），所以填完之后照样看得见这一栏是什么。
 */
Object.keys(cookieFields).forEach(function (name) {
  var input = cookieFields[name];
  if (!input) return;
  input.addEventListener('paste', function (event) {
    var text = event.clipboardData && event.clipboardData.getData('text');
    if (!text) return;
    var pairs = extractCookiePairs(text);
    var known = Object.keys(pairs);
    if (known.length === 0) {
      var value = String(text).trim().replace(/[;\s]+$/, '');
      if (!value) return;
      event.preventDefault();
      input.value = value;
      setStatus('');
      return;
    }
    event.preventDefault();
    known.forEach(function (key) {
      if (cookieFields[key]) cookieFields[key].value = pairs[key];
    });
    setStatus(known.length > 1 ? '按名字分到了 ' + known.length + ' 栏，核对一下再提交。' : '');
  });
});

cookieClearButton.addEventListener('click', function () {
  clearCookieFields();
  setStatus('');
});

cookieSubmitButton.addEventListener('click', async function () {
  if (cookieSubmitButton.disabled) return;
  var fields = readCookieFields();
  if (!fields.SESSDATA) {
    setStatus('SESSDATA 那一栏还没填——那是登录态的关键项。');
    if (cookieFields.SESSDATA) cookieFields.SESSDATA.focus();
    return;
  }
  cookieSubmitButton.disabled = true;
  setStatus('正在让 B站 认这三个值…');
  try {
    await wakeGhost();
    var data = await askGhost('cookie', { fields: fields }, 25000);
    // 落盘了就把屏幕上的值抹掉：没有理由让登录凭证在输入框里继续挂着。
    clearCookieFields();
    setLoginState('已登录：' + describeAccount(data.account));
    var extra = Array.isArray(data.warnings) && data.warnings.length ? '（' + data.warnings.join('；') + '）' : '';
    setStatus((data.message || '登录成功') + extra);
  } catch (error) {
    setStatus((error && error.message) || '登录失败');
  } finally {
    cookieSubmitButton.disabled = false;
  }
});

async function refreshLoginState(verify) {
  try {
    await wakeGhost();
    var data = await askGhost('status', { verify: verify === true }, verify ? 25000 : 12000);
    if (data.loggedIn === false) {
      setLoginState('还没有登录。扫码或粘贴 Cookie，任选一种。');
      return;
    }
    var suffix = data.verified ? '' : '（本机记着的账号，点「核对一下」问 B站 确认）';
    setLoginState('已登录：' + describeAccount(data.account) + suffix);
    if (data.message) setStatus(data.message);
  } catch (error) {
    setLoginState('看不出登录状态：' + ((error && error.message) || '插件没有回应'));
  }
}

loginVerifyButton.addEventListener('click', async function () {
  if (loginVerifyButton.disabled) return;
  loginVerifyButton.disabled = true;
  setStatus('正在问 B站…');
  try {
    await refreshLoginState(true);
    setStatus('');
  } finally {
    loginVerifyButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async function () {
  if (!logoutArmed) {
    logoutArmed = true;
    logoutHint.textContent = '再点一次就真的清掉本机凭证（credential.json）。';
    setTimeout(function () {
      logoutArmed = false;
      logoutHint.textContent = '清掉本机的凭证文件（credential.json）。要点两次才执行。';
    }, 6000);
    return;
  }
  logoutArmed = false;
  logoutHint.textContent = '清掉本机的凭证文件（credential.json）。要点两次才执行。';
  logoutButton.disabled = true;
  setStatus('正在清除凭证…');
  try {
    await wakeGhost();
    await askGhost('logout', {}, 15000);
    setLoginState('还没有登录。扫码或粘贴 Cookie，任选一种。');
    setStatus('已清除本机凭证。');
  } catch (error) {
    setStatus((error && error.message) || '清除失败');
  } finally {
    logoutButton.disabled = false;
  }
});

// 打开这一页就问一次**本机**状态：只读凭证文件，不碰 B站 接口。
refreshLoginState(false);

(async function start() {
  try {
    var response = await fetch('/kv');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var value = await response.json();
    stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    var config = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      var current = stored[key];
      var fallback = DEFAULTS[key];
      if (Array.isArray(fallback)) config[key] = Array.isArray(current) ? current : fallback;
      else if (typeof fallback === 'boolean') config[key] = current === undefined ? fallback : Boolean(current);
      else if (typeof fallback === 'number') {
        // 0 是合法值（perDay=0 表示不限流），不能用 `Number(x) || fallback` 判。
        var number = Number(current);
        config[key] = current === undefined || current === null || !isFinite(number)
          ? fallback
          : clampNumber(key, number);
      } else config[key] = current === undefined || current === null ? fallback : String(current);
    });
    // 时段配额的老数据：1.3.x 只有「每天最多自动跑几轮」（autoRoundsPerDay）。
    // 按它迁成一段整天，总轮次一分不少；没有就连默认值都按整天 ×1 显示。
    // 1.2.x 的峰谷三开关（peakValley / noon / night）不再读，也不再显示——
    // 时间控制权在 cron 手里，多一个时间开关只会和 cron 抢同一件事。
    var segments = Array.isArray(stored.segments) ? stored.segments : null;
    if (!segments || !segments.length) {
      var legacyRounds = Math.round(Number(stored.autoRoundsPerDay));
      segments = isFinite(legacyRounds) && legacyRounds >= 1
        ? [{ start: '00:00', end: '24:00', rounds: Math.max(1, Math.min(SEGMENT_MAX_ROUNDS, legacyRounds)) }]
        : DEFAULTS.segments.slice();
    }
    config.segments = segments;
    fillForm(config);
    fillFolderOptions(stored.favFolders);
    setStatus('');
  } catch (error) {
    // 读失败时绝不能允许保存：那会把「默认值」整份写回去，清掉关键词和人设。
    fillForm(DEFAULTS);
    saveButton.disabled = true;
    resetButton.disabled = true;
    setStatus('读不到已保存的设置（' + ((error && error.message) || '未知原因') + '）。为了不覆盖你已经填过的内容，保存已禁用，请关掉重新打开设置页。');
  }
})();
