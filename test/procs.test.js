'use strict';
// test/procs.test.js — tests for bridge/procs.js parent-chain attribution.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const procs = require('../bridge/procs.js');

const T0 = Date.now() - 3600e3;
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

// A miniature process table modeled on the real machine:
//   code.exe(1) -> claude.exe(2) -> bun launcher(3, plugin path) -> bun server(4)
//                                 -> python webapp(5)
//   CCXProcess(6) -> node adobe(7)
//   pythonw orphan(8): ppid 999 does not exist
//   recycled(9): ppid 10 exists but started AFTER 9 → treated as parent-gone
const TABLE = [
  { pid: 1, ppid: 0, name: 'Code.exe', cmd: 'C:\\vscode\\Code.exe', started: iso(0) },
  { pid: 2, ppid: 1, name: 'claude.exe', cmd: 'c:\\ext\\native-binary\\claude', started: iso(1000) },
  { pid: 3, ppid: 2, name: 'bun.exe', cmd: 'C:\\Users\\b\\.bun\\bin\\bun.exe run --cwd C:/Users/b/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4 --shell=bun start', started: iso(2000) },
  { pid: 4, ppid: 3, name: 'bun.exe', cmd: 'C:\\Users\\b\\.bun\\bin\\bun.exe server.ts', started: iso(3000) },
  { pid: 5, ppid: 2, name: 'python.exe', cmd: 'F:\\Python310\\python.exe webapp.py --port 5000', started: iso(4000), ports: [5000] },
  { pid: 6, ppid: 0, name: 'CCXProcess.exe', cmd: 'C:\\Adobe\\CCXProcess.exe', started: iso(0) },
  { pid: 7, ppid: 6, name: 'node.exe', cmd: 'C:\\Program Files\\Adobe\\libs\\node.exe x.js', started: iso(5000), ports: [1234] },
  { pid: 8, ppid: 999, name: 'pythonw.exe', cmd: 'F:\\Python310\\pythonw.exe -m emailproxy', started: iso(6000) },
  { pid: 9, ppid: 10, name: 'python.exe', cmd: 'F:\\Python310\\python.exe old_server.py', started: iso(7000) },
  { pid: 10, ppid: 0, name: 'svchost.exe', cmd: 'svchost', started: iso(99999999) },   // recycled pid: born after its "child"
];

function run(sessions = [], known = []) {
  const out = procs.attribute(TABLE, 424242, sessions, known);
  return Object.fromEntries(out.map((p) => [p.pid, p]));
}

describe('attribute', () => {
  test('plugin runtimes resolve via ancestor cmdline and carry claudePid', () => {
    const by = run();
    assert.equal(by[3].attribution, 'plugin');
    assert.equal(by[3].plugin, 'telegram');
    assert.equal(by[3].claudePid, 2);
    // the server.ts child has no plugin path of its own — chain lookup covers it
    assert.equal(by[4].attribution, 'plugin');
    assert.equal(by[4].plugin, 'telegram');
    assert.equal(by[4].linked, 'plugin of claude.exe 2');
  });
  test('children of a live claude.exe are labeled, with VS Code noted', () => {
    const by = run();
    assert.equal(by[5].attribution, 'claude');
    assert.match(by[5].linked, /child of claude\.exe 2 \(VS Code\)/);
  });
  test('window titles do NOT set project (Electron title = focused window, not owner)', () => {
    const table = TABLE.map((p) => (p.pid === 1 ? { ...p, title: 'server.js — mremail — Visual Studio Code' } : p));
    const out = procs.attribute(table, 424242, [], [{ cwd: 'd:\\files\\sourcecode\\mremail', project: 'mremail', sid: null }]);
    const by = Object.fromEntries(out.map((p) => [p.pid, p]));
    assert.equal(by[5].project, null, 'a focused-window title must not label other sessions');
  });
  test('project resolves from a known path in an ancestor cmdline', () => {
    const table = TABLE.map((p) => (p.pid === 5 ? { ...p, cmd: 'F:\\Python310\\python.exe D:\\files\\sourcecode\\mremail\\webapp.py --port 5000' } : p));
    const out = procs.attribute(table, 424242, [], [{ cwd: 'd:\\files\\sourcecode\\mremail', project: 'mremail', sid: null }]);
    const by = Object.fromEntries(out.map((p) => [p.pid, p]));
    assert.equal(by[5].project, 'mremail');
    assert.equal(by[5].attribution, 'claude', 'attribution stays claude — project is extra info');
  });
  test('unrelated port-holders are "other", never orphan', () => {
    const by = run();
    assert.equal(by[7].attribution, 'other');
    assert.match(by[7].linked, /CCXProcess\.exe 6 — not Claude-spawned/);
  });
  test('orphan means the parent is actually gone (missing or recycled pid)', () => {
    const by = run();
    assert.equal(by[8].attribution, 'orphan', 'missing ppid → orphan');
    assert.equal(by[9].attribution, 'orphan', 'recycled ppid (born after child) → orphan');
  });
  test('descendants of a Gander-launched window win as "session"', () => {
    const by = run([{ sid: 'S1', project: 'proj', set: new Set([5]) }]);
    assert.equal(by[5].attribution, 'session');
    assert.equal(by[5].sessionId, 'S1');
  });
  test('non-interesting, non-claude processes are dropped; the bridge itself never listed', () => {
    const by = run();
    assert.ok(!by[1] && !by[6] && !by[10], 'Code/CCX/svchost are noise');
    const self = procs.attribute([{ pid: 424242, ppid: 0, name: 'node.exe', cmd: 'bridge', started: iso(0) }], 424242, [], []);
    assert.equal(self.length, 0);
  });
  test('compact strips cmd but keeps linkage fields', () => {
    const c = procs.compact(procs.attribute(TABLE, 424242, [], []));
    assert.ok(c.length);
    for (const r of c) { assert.ok(!('cmd' in r)); assert.ok('claudePid' in r && 'attribution' in r); }
  });
});
