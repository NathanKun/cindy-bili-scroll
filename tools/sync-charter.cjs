'use strict';

/**
 * 让 prompts/duty.md、prompts/inbox.md 和 main.js 里的章程数组保持一致。
 *
 * 章程的正文只存在于 main.js 的 CHARTER_LINES / INBOX_CHARTER_LINES 里（沙箱读不到包内
 * 文件，必须内联）；prompts/ 下那两份是给人看的副本，随包发布，方便阅读 / 提 issue 时引用。
 * 两份不一致就是漂移，所以这里做单向生成 + 校验：
 *
 *   node tools/sync-charter.cjs           # 用 main.js 覆盖 prompts/*.md
 *   node tools/sync-charter.cjs --check   # 只比对，不一致就 exit 1
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');

/** 从 main.js 里取出一个字符串数组字面量（只用于我们自己的源码）。 */
function linesOf(name) {
  const match = new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\n\\];').exec(source);
  if (!match) throw new Error(name + ' array not found in main.js');
  const lines = vm.runInNewContext('[' + match[1] + ']');
  if (!Array.isArray(lines) || !lines.length || !lines.every((line) => typeof line === 'string')) {
    throw new Error(name + ' did not evaluate to an array of strings');
  }
  return lines.join('\n');
}

const targets = [
  { name: 'CHARTER_LINES', file: path.join(root, 'prompts', 'duty.md') },
  { name: 'INBOX_CHARTER_LINES', file: path.join(root, 'prompts', 'inbox.md') },
];

let bad = false;
for (const target of targets) {
  const charter = linesOf(target.name);
  const current = fs.existsSync(target.file) ? fs.readFileSync(target.file, 'utf8') : '';
  const label = path.relative(root, target.file) + ' ↔ ' + target.name;
  if (current === charter) {
    console.log('ok: ' + label + ' (' + charter.length + ' chars)');
    continue;
  }
  if (process.argv.includes('--check')) {
    const a = charter.split('\n');
    const b = current.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        console.error('drift at ' + label + ' line ' + (i + 1));
        console.error('  main.js : ' + JSON.stringify(a[i]));
        console.error('  ' + path.basename(target.file) + ' : ' + JSON.stringify(b[i]));
        break;
      }
    }
    bad = true;
    continue;
  }
  fs.writeFileSync(target.file, charter, 'utf8');
  console.log('wrote ' + label + ' (' + charter.length + ' chars)');
}

if (bad) {
  console.error('fix: node tools/sync-charter.cjs');
  process.exit(1);
}
