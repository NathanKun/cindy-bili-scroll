#!/usr/bin/env node
'use strict';

/**
 * 闸门自测：用一份假的 ~/bili-duty 目录，跑**已安装**的 precheck.mjs 六种情形。
 *
 * 每个用例都从零写一份 config/state，避免上一次运行写进去的 hook* 计数污染结果；
 * `--now` 固定成 2026-11-17T09:00:00，所以结果不随真实时间变。
 *
 *   node tests/gate-selftest/run.mjs [precheck.mjs 的路径，缺省用本仓库 schedule/precheck.mjs]
 *
 * 不联网、不碰真实 ~/bili-duty。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 缺省测本仓库的源码；要测已安装的那份，把它的绝对路径作为第一个参数传进来。
const gate = process.argv[2]
  || path.resolve(here, '..', '..', 'schedule', 'precheck.mjs');

const baseState = {
  version: 6,
  day: '2026-11-17',
  pickedAuto: 0,
  seg: {},
  starts: {},
  maxTries: 3,
  lock: null,
  inboxChecks: 0,
  inboxLastAt: '',
  inboxLock: null,
  loggedIn: true,
};

const cases = [
  {
    id: 'a',
    why: '日报段内有额度 → 放行日报轮',
    config: { segments: [{ start: '00:00', end: '24:00', rounds: 2 }], perDay: 5, replyToComments: true, inboxChecksPerDay: 2, inboxMinGapMin: 60 },
    state: {},
    expect: 0,
  },
  {
    id: 'b',
    why: '这一段跑满、互动还有次数 → 放行互动轮',
    config: { segments: [{ start: '00:00', end: '24:00', rounds: 1 }], perDay: 5, replyToComments: true, inboxChecksPerDay: 2, inboxMinGapMin: 60 },
    state: { seg: { 0: 1 } },
    expect: 0,
  },
  {
    id: 'c',
    why: '这一段跑满、互动关着 → 跳过',
    config: { segments: [{ start: '00:00', end: '24:00', rounds: 1 }], perDay: 5, replyToComments: false, inboxChecksPerDay: 0, inboxMinGapMin: 0 },
    state: { seg: { 0: 1 } },
    expect: 2,
  },
  {
    id: 'd',
    why: '有一轮日报在跑（5 分钟前）→ 跳过',
    config: { segments: [{ start: '00:00', end: '24:00', rounds: 2 }], perDay: 5, replyToComments: true, inboxChecksPerDay: 2, inboxMinGapMin: 60 },
    state: { lock: { at: '2026-11-17T08:55:00', slot: '0#0', manual: false } },
    expect: 2,
  },
  {
    id: 'e',
    why: '有一次互动检查在跑（10 分钟前，锁 15 分钟）→ 跳过',
    config: { segments: [{ start: '00:00', end: '24:00', rounds: 1 }], perDay: 5, replyToComments: true, inboxChecksPerDay: 2, inboxMinGapMin: 0 },
    state: { seg: { 0: 1 }, inboxChecks: 1, inboxLastAt: '2026-11-17T08:50:00', inboxLock: { at: '2026-11-17T08:50:00', manual: false } },
    expect: 2,
  },
  {
    id: 'f',
    why: '互动锁已过期（20 分钟前）→ 放行互动轮',
    config: { segments: [{ start: '00:00', end: '24:00', rounds: 1 }], perDay: 5, replyToComments: true, inboxChecksPerDay: 2, inboxMinGapMin: 0 },
    state: { seg: { 0: 1 }, inboxChecks: 1, inboxLastAt: '2026-11-17T08:40:00', inboxLock: { at: '2026-11-17T08:40:00', manual: false } },
    expect: 0,
  },
];

let bad = 0;
const root = fs.mkdtempSync(path.join(here, 'run-'));
for (const c of cases) {
  const home = path.join(root, c.id);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(c.config, null, 2));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify(Object.assign({}, baseState, c.state), null, 2));
  const r = spawnSync(process.execPath, [gate, '--home', home, '--now', '2026-11-17T09:00:00'], { encoding: 'utf8' });
  const line = String(r.stdout || '').trim();
  const ok = r.status === c.expect;
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id} exit=${r.status} (expect ${c.expect})  ${line}`);
  console.log(`     ${c.why}`);
}
fs.rmSync(root, { recursive: true, force: true });
console.log(bad === 0 ? '\nALL PASS (6 cases)' : `\n${bad} case(s) failed`);
process.exit(bad === 0 ? 0 : 1);
