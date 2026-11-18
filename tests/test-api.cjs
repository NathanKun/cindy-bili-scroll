'use strict';

/**
 * 工作进程侧的契约测试（node/lib/api.cjs）。
 *
 * 这里不联网：把 Bili 实例的 http 换成假的实现，只验「发给 B站的形状」和
 * 「从 B站 拿回来的形状怎么解读」。跑法：node tests/test-api.cjs
 *
 * 覆盖的都是真出过问题的地方：
 *   - rpid 是 64 位整数，`Number()` 过 2^53 就丢精度 → 发出去挂错楼 / 复核误报
 *   - 收件箱三个接口全挂时回空列表 → 看起来和「没人回你」一模一样
 */

const path = require('node:path');
const { Bili, BiliError } = require(path.resolve(__dirname, '..', 'node', 'lib', 'api.cjs'));

function assert(condition, label) {
  if (!condition) throw new Error('ASSERT FAILED: ' + label);
  console.log('  ✓ ' + label);
}

function makeBili(requestImpl) {
  const bili = new Bili({ sessdata: 's', bili_jct: 'j', dedeuserid: '42', buvid3: 'b3', buvid4: 'b4' });
  const calls = [];
  bili.http = {
    cred: bili.credential,
    async request(url, options) {
      calls.push({ url, options });
      return requestImpl(url, options, calls);
    },
  };
  return { bili, calls };
}

const BIG_RPID = '1800000000000000123'; // > 2^53，Number() 之后会变成 ...000

(async () => {
  console.log('# 1. 发评论：root / parent 按字符串传，不要转数字');
  let sentData = null;
  let ctx = makeBili((url, options) => {
    if (/x\/web-interface\/view/.test(url)) return { bvid: 'BV1tKs76bEyi', aid: 111, cid: 222, title: 't', pages: [] };
    sentData = options && options.data;
    return { rpid: 1800000000000000100, rpid_str: BIG_RPID };
  });
  let r = await ctx.bili.postComment({ bvid: 'BV1tKs76bEyi', text: '一句人话', root: BIG_RPID, parent: '1799999999999999999' });
  assert(sentData && sentData.root === BIG_RPID, '发送时 root 是原样字符串');
  assert(sentData.parent === '1799999999999999999', '发送时 parent 是原样字符串');
  assert(/^\d+$/.test(sentData.root) && sentData.root.length === BIG_RPID.length, 'root 位数没被截断');
  assert(r.rpid === BIG_RPID, '返回的 rpid 取 rpid_str（数字版已经丢精度）');
  assert(typeof r.rpid === 'string', '返回的 rpid 是字符串');

  console.log('# 2. 复核：rpid 按字符串比，大 id 不能误判成「没查到」');
  ctx = makeBili((url) => {
    if (/x\/web-interface\/view/.test(url)) return { bvid: 'BV1tKs76bEyi', aid: 111, cid: 222, title: 't', pages: [] };
    if (/reply\/reply/.test(url)) return { replies: [] };
    return { replies: [{ rpid: 1800000000000000100, rpid_str: BIG_RPID }] };
  });
  r = await ctx.bili.commentCheck({ bvid: 'BV1tKs76bEyi', rpid: BIG_RPID });
  assert(r.visible === true, '主楼里用 rpid_str 能比中（以前 Number() 后比不中）');
  r = await ctx.bili.commentCheck({ bvid: 'BV1tKs76bEyi', rpid: '1900000000000000000' });
  assert(r.visible === false, '真不存在的 id 仍然是没查到');
  r = await ctx.bili.commentCheck({ bvid: 'BV1tKs76bEyi', rpid: BIG_RPID, root: '1799999999999999999' });
  assert(r.visible === false, '楼中楼那一支走 reply/reply，空列表 → 没查到');
  let threw = null;
  try {
    await ctx.bili.commentCheck({ bvid: 'BV1tKs76bEyi', rpid: '' });
  } catch (error) {
    threw = error;
  }
  assert(threw instanceof BiliError && threw.code === 'BAD_REQUEST', '空 rpid → BAD_REQUEST');

  console.log('# 3. 收件箱：三个接口全挂必须报错，不能回空列表');
  ctx = makeBili(() => {
    throw new BiliError('BILI_ERROR', '412');
  });
  threw = null;
  try {
    await ctx.bili.inbox();
  } catch (error) {
    threw = error;
  }
  assert(threw instanceof BiliError && threw.code === 'INBOX_UNAVAILABLE', 'INBOX_UNAVAILABLE');

  console.log('# 4. 收件箱：只挂一部分时如实标 partial，并把 rpid 当字符串给出来');
  ctx = makeBili((url) => {
    if (/msgfeed\/unread/.test(url)) throw new BiliError('BILI_ERROR', '412');
    if (/msgfeed\/reply/.test(url)) {
      return {
        items: [{
          user: { nickname: '阿康' },
          item: { uri: 'bilibili://comment/detail/111/' + BIG_RPID, source_content: '你说的那点我也在想', source_id: 111, title: '星舰' },
          reply_time: 1700000000,
        }],
      };
    }
    return { items: [] };
  });
  r = await ctx.bili.inbox();
  assert(r.partial === true, 'partial=true（未读数那一路挂了）');
  assert(r.items.length === 1, '拿到 1 条');
  assert(r.items[0].rpid === BIG_RPID && typeof r.items[0].rpid === 'string', 'rpid 是原样字符串');
  assert(r.items[0].aid === '111', 'aid 来自 uri 里的 oid，且是字符串');

  console.log('# 5. 字幕：超长时留「开头 + 结尾」，不能只留开头把结论砍掉');
  // 造一段明显超过 30000 字的字幕：结尾放一句能认出来的话。
  const longLines = [];
  for (let index = 0; index < 4000; index += 1) longLines.push('这是第 ' + index + ' 句字幕，用来把长度撑起来。');
  longLines.push('最后一句：所以我的结论是这东西值得看但不急着上手。');
  ctx = makeBili(
    (url) => {
      if (/player/.test(url)) {
        return { subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/x.json' }] } };
      }
      return { body: longLines.map((content) => ({ content })) };
    }
  );
  ctx.bili.http._rawJson = async () => ({ body: longLines.map((content) => ({ content })) });
  r = await ctx.bili.subtitle('BV1tKs76bEyi', { aid: 1, cid: 2, maxChars: 5000 });
  assert(r.truncated === true, '超长时标 truncated');
  assert(r.chars > 5000, 'chars 报的是完整长度，不是被截后的长度');
  assert(r.text.length <= 5200, '只给 maxChars 那么多');
  assert(r.text.startsWith('这是第 0 句字幕'), '保留了开头');
  assert(/中间省略约 \d+ 字/.test(r.text), '接缝处写清省略了多少');
  assert(r.text.endsWith('所以我的结论是这东西值得看但不急着上手。'), '保留了结尾——结论不能被砍掉');

  ctx = makeBili(() => ({ subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: '//x/y.json' }] } }));
  ctx.bili.http._rawJson = async () => ({ body: [{ content: '短' }, { content: '字幕' }] });
  r = await ctx.bili.subtitle('BV1tKs76bEyi', { aid: 1, cid: 2 });
  assert(r.truncated === false && r.text === '短\n字幕', '没超长就原样给全文，不加任何标记');

  console.log('\nALL PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
