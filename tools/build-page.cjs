'use strict';

/**
 * 把 ui/page.template.html 复制成随包的 ui/page.html，只换掉开头那段头注释。
 * 只是生成插件包内的页面；不属于插件运行时。
 *
 * 之前这里还要把 qrcode-generator 内联进模板的占位行。卡片上的登录页签拿掉之后
 * 页面不再画二维码，二维码只在设置页用（settings.html 直接引 /ui/qrcode.js），
 * 所以这一步退化成纯复制。
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const templatePath = path.join(root, 'ui', 'page.template.html');
const outPath = path.join(root, 'ui', 'page.html');

const template = fs.readFileSync(templatePath, 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(root, 'ghost.json'), 'utf8')).version;

if (template.includes('__QRCODE_LIB__')) {
  throw new Error('template still has the __QRCODE_LIB__ placeholder; the card no longer inlines the library');
}

// 模板开头那段「这是源文件、真正的页面是 page.html」的自述，放进生成出来的 page.html
// 就变成了谎话（读者手里这份正是 page.html）。生成时换成「这是生成文件」的说明。
const page = template.replace(/^\s*<!--[\s\S]*?-->/, () =>
  '<!--\n'
  + '  这是生成文件，不要直接改它：改 ui/page.template.html，再跑 tools/build-page.cjs 重新生成。\n'
  + '-->\n')
  // 卡片自报的版本号跟着 ghost.json 走，别让它在源码里另存一份再慢慢过期。
  .replace(/(new App\(\{ name: '[^']*', version: ')[^']*(' \})/, (whole, before, after) => before + version + after);

// 生成后自检：只有一个 script 块（页面自己的 module），且没有游离的 </script>。
const opens = (page.match(/<script/g) || []).length;
const closes = (page.match(/<\/script>/g) || []).length;
if (opens !== 1 || closes !== 1) {
  throw new Error('assembled page has ' + opens + ' <script> and ' + closes + ' </script> blocks');
}
if (/真正随包、真正被宿主加载的是/.test(page)) {
  throw new Error('template header comment leaked into page.html');
}
if (/renderLogin|refreshLogin|waitForLogin|data-tab="login"/.test(page)) {
  throw new Error('login code leaked into page.html; it belongs to the settings page only');
}

fs.writeFileSync(outPath, page, 'utf8');
console.log('wrote', outPath, 'bytes=', Buffer.byteLength(page, 'utf8'));
