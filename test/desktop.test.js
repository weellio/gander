'use strict';
// test/desktop.test.js — tests for bridge/desktop.js (pure classifier; no
// processes, no real Claude Desktop needed).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const desktop = require('../bridge/desktop.js');
const { classifyChanges, describeMcpLine, candidates, AGENT_ID } = desktop._test;

const LOGS = 'C:\\data\\Claude\\logs';
const SESS = 'C:\\data\\Claude\\local-agent-mode-sessions\\1ff9664c-abcd\\x.json';
function stats(entries) { return new Map(entries); }

describe('desktop exports', () => {
  test('exports start/stop/findDataDir and a stable agent id', () => {
    assert.equal(typeof desktop.start, 'function');
    assert.equal(typeof desktop.stop, 'function');
    assert.equal(typeof desktop.findDataDir, 'function');
    assert.equal(AGENT_ID, 'desktop:claude');
  });
  test('candidates cover the classic and MSIX layouts on Windows', () => {
    if (process.platform !== 'win32') return;
    const c = candidates();
    assert.ok(c.some((p) => /AppData[\\/]Roaming[\\/]Claude$/i.test(p)), 'classic %APPDATA%\\Claude');
    // MSIX entries only appear when a Claude_* package exists — shape-checked, not required
    for (const p of c) assert.ok(p.endsWith('Claude'), p);
  });
});

describe('describeMcpLine()', () => {
  test('names the tool on tools/call lines', () => {
    const r = describeMcpLine('2026-07-08T18:00:00Z [gmail] [info] Message from client: {"method":"tools/call","params":{"name":"search_emails","arguments":{}}}');
    assert.equal(r.state, 'reading');
    assert.equal(r.log, 'MCP tool: search_emails');
  });
  test('falls back to the method, then to generic activity', () => {
    assert.equal(describeMcpLine('{"method":"tools/list"}').log, 'MCP: tools/list');
    assert.equal(describeMcpLine('garbage line').log, 'MCP activity');
  });
});

describe('classifyChanges()', () => {
  test('first tick is baseline only — no activity', () => {
    const cur = stats([[path.join(LOGS, 'mcp-server-gmail.log'), { size: 100, mtime: 1 }]]);
    const r = classifyChanges(null, cur);
    assert.equal(r.activity, false);
    assert.equal(r.events.length, 0);
  });

  test('a growing mcp log is tool activity, described from its tail', () => {
    const f = path.join(LOGS, 'mcp-server-gmail.log');
    const prev = stats([[f, { size: 100, mtime: 1 }]]);
    const cur = stats([[f, { size: 260, mtime: 2 }]]);
    const r = classifyChanges(prev, cur, () => '{"method":"tools/call","params":{"name":"archive_email"}}\n');
    assert.equal(r.activity, true);
    assert.deepEqual(r.events, [{ state: 'reading', log: 'MCP tool: archive_email' }]);
  });

  test('a NEW mcp log (no prev entry) with content counts as activity', () => {
    const f = path.join(LOGS, 'mcp-server-drive.log');
    const r = classifyChanges(stats([]), stats([[f, { size: 50, mtime: 2 }]]), () => 'x');
    assert.equal(r.activity, true);
  });

  test('agent-mode session growth maps to coding', () => {
    const prev = stats([]);
    const cur = stats([[SESS, { size: 10, mtime: 2 }]]);
    const r = classifyChanges(prev, cur);
    assert.equal(r.activity, true);
    assert.equal(r.events[0].state, 'coding');
    assert.match(r.events[0].log, /agent mode working/);
  });

  test('main.log churn is ignored (UI noise, not work)', () => {
    const f = path.join(LOGS, 'main.log');
    const prev = stats([[f, { size: 100, mtime: 1 }]]);
    const cur = stats([[f, { size: 900, mtime: 2 }]]);
    const r = classifyChanges(prev, cur);
    assert.equal(r.activity, false);
  });

  test('unchanged files produce nothing; bursts cap at 2 events', () => {
    const f1 = path.join(LOGS, 'mcp-a.log'), f2 = path.join(LOGS, 'mcp-b.log'), f3 = path.join(LOGS, 'mcp-c.log');
    const prev = stats([[f1, { size: 1, mtime: 1 }], [f2, { size: 1, mtime: 1 }], [f3, { size: 1, mtime: 1 }]]);
    const same = classifyChanges(prev, prev);
    assert.equal(same.activity, false);
    const cur = stats([[f1, { size: 9, mtime: 2 }], [f2, { size: 9, mtime: 2 }], [f3, { size: 9, mtime: 2 }]]);
    const burst = classifyChanges(prev, cur, () => '');
    assert.equal(burst.events.length, 2);
  });
});

describe('start() without Claude Desktop', () => {
  test('declines cleanly when no data dir is found', () => {
    const r = desktop.start({ onEvent: () => {}, log: () => {} }, { findDataDir: () => null });
    assert.equal(r.started, false);
    desktop.stop();
  });
  test('starts and baselines when a dir exists (injected deps, no timers fire)', () => {
    let events = [];
    const r = desktop.start(
      { onEvent: (e) => events.push(e), log: () => {} },
      {
        findDataDir: () => 'C:\\data\\Claude',
        isRunning: (cb) => cb(true),
        snapshotStats: () => stats([]),
        now: () => 1000,
      }
    );
    assert.equal(r.started, true);
    desktop.stop();
    // the immediate tick announced the running app as an idle root tile
    const root = events.find((e) => e.agentId === 'desktop:claude');
    assert.ok(root, 'desktop tile emitted');
    assert.equal(root.desktop, true);
    assert.equal(root.root, true);
    assert.equal(root.state, 'idle');
  });
});
