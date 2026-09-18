'use strict';
// bridge/version.js — "is the CLI stale?" is pure string math around two shell-outs.
// The rules that matter: numeric (not lexical) version compare, and NEVER nag when
// either side of the comparison is unknown. Nothing here touches the network or a
// real `claude` binary — the async cases run against a path that cannot exist.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const V = require('../bridge/version.js');

const NO_SUCH_CLI = path.join(os.tmpdir(), 'definitely-not-claude-xyz');

// Resolves with the first callback's args, then reports how many times it fired.
// A hung callback rejects instead of hanging the whole suite.
function callbackOnce(invoke, ms = 15000) {
  const calls = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`callback never fired within ${ms}ms`)), ms);
    invoke((...args) => {
      calls.push(args);
      if (calls.length > 1) return;                       // extra fires are counted, not raced
      setTimeout(() => { clearTimeout(timer); resolve({ args, calls }); }, 150).unref?.();
    });
  });
}

test('parseVersion pulls the number out of whatever the CLI prints', () => {
  assert.equal(V.parseVersion('2.1.261 (Claude Code)'), '2.1.261');
  assert.equal(V.parseVersion('2.1.277'), '2.1.277');
  assert.equal(V.parseVersion('2.1.261 (Claude Code)\nsome trailing noise\n'), '2.1.261');
});

test('parseVersion returns "" for garbage, empty and null', () => {
  assert.equal(V.parseVersion('not a version at all'), '');
  assert.equal(V.parseVersion(''), '');
  assert.equal(V.parseVersion(null), '');
  assert.equal(V.parseVersion(undefined), '');
});

test('cmp orders versions numerically', () => {
  assert.equal(V.cmp('2.1.261', '2.1.261'), 0);
  assert.equal(V.cmp('2.1.261', '2.1.277'), -1);
  assert.equal(V.cmp('2.1.277', '2.1.261'), 1);
});

test('cmp compares numbers, not strings: 2.1.9 < 2.1.10', () => {
  assert.equal(V.cmp('2.1.9', '2.1.10'), -1);            // a string compare says "9" > "10"
  assert.equal(V.cmp('2.1.10', '2.1.9'), 1);
  assert.equal(V.cmp('2.2.0', '2.1.999'), 1);
});

test('cmp treats missing parts as zero', () => {
  assert.equal(V.cmp('2.1', '2.1.0'), 0);
  assert.equal(V.cmp('2', '2.0.0'), 0);
  assert.equal(V.cmp('2.1', '2.1.1'), -1);
});

test('isBehind is true only when current is genuinely older', () => {
  assert.equal(V.isBehind('2.1.261', '2.1.277'), true);
  assert.equal(V.isBehind('2.1.9', '2.1.10'), true);
  assert.equal(V.isBehind('2.1.261', '2.1.261'), false);
  assert.equal(V.isBehind('2.1.277', '2.1.261'), false); // somehow ahead: not behind
});

test('isBehind never nags on a failed lookup', () => {
  assert.equal(V.isBehind('', '2.1.277'), false);
  assert.equal(V.isBehind('2.1.261', ''), false);
  assert.equal(V.isBehind('', ''), false);
  assert.equal(V.isBehind(null, null), false);
  assert.equal(V.isBehind('nonsense', '2.1.277'), false);
  assert.equal(V.isBehind('2.1.261', 'nonsense'), false);
});

test('currentVersion yields "" (once) when the cli cannot run', async () => {
  const { args, calls } = await callbackOnce((cb) => V.currentVersion(NO_SUCH_CLI, cb));
  assert.equal(args[1], '');
  assert.equal(calls.length, 1);
});

test('latestVersion calls back exactly once with a string, network or not', { timeout: 30000 }, async () => {
  V._resetCache();
  const cold = await callbackOnce((cb) => V.latestVersion(cb, { ttlMs: 0 }), 20000);
  assert.equal(typeof cold.args[1], 'string');
  assert.equal(cold.calls.length, 1);

  const warm = await callbackOnce((cb) => V.latestVersion(cb, { ttlMs: 60 * 60e3 }), 20000);
  assert.equal(typeof warm.args[1], 'string');
  assert.equal(warm.calls.length, 1);
  V._resetCache();
});

test('check reports a full, non-nagging result when the cli cannot run', { timeout: 30000 }, async () => {
  V._resetCache();
  const before = Date.now();
  const { args, calls } = await callbackOnce((cb) => V.check(NO_SUCH_CLI, cb, { ttlMs: 0 }), 20000);
  const out = args[1];
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(out).sort(), ['behind', 'checkedAt', 'cmd', 'current', 'latest']);
  assert.equal(out.cmd, NO_SUCH_CLI);
  assert.equal(out.current, '');
  assert.equal(out.behind, false);                        // strictly false, never truthy-ish
  assert.equal(typeof out.checkedAt, 'number');
  assert.ok(out.checkedAt >= before && out.checkedAt <= Date.now());
  V._resetCache();
});

test('update reports ok:false (once) when the cli cannot run', { timeout: 30000 }, async () => {
  const { args, calls } = await callbackOnce((cb) => V.update(NO_SUCH_CLI, cb), 20000);
  assert.equal(calls.length, 1);
  assert.equal(args[1].ok, false);
});

// Regression: with shell:true Node does not quote the command, so a CLI path
// containing a space used to split and fail silently — version came back empty,
// isBehind stayed false, and the update button never appeared. Windows-only bug.
test('a CLI path containing a space still reports its version', { skip: process.platform !== 'win32' ? 'win32 only' : false }, async () => {
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-ver-'));
  const dir = path.join(root, 'a dir with spaces');
  fs.mkdirSync(dir, { recursive: true });
  const cli = path.join(dir, 'claude.cmd');
  fs.writeFileSync(cli, '@echo off\r\necho 2.1.261 (Claude Code)\r\n');
  try {
    const got = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('currentVersion never called back')), 15000);
      V.currentVersion(cli, (_e, v) => { clearTimeout(t); resolve(v); });
    });
    assert.equal(got, '2.1.261');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
