'use strict';
// bridge/mod.js — the gander-feed mod's landing spot: version gate, exact
// per-session telemetry, the band payload, install state and commands.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('../bridge/mod.js');

test.beforeEach(() => mod._reset());

// ── version gate ─────────────────────────────────────────────────────────────
test('supports(): the gate opens at 2.1.287 and never for a missing CLI', () => {
  assert.equal(mod.supports('2.1.287').supported, true);
  assert.equal(mod.supports('2.1.294 (Claude Code)').supported, true);
  assert.equal(mod.supports('3.0.0').supported, true);
  const old = mod.supports('2.1.261');
  assert.equal(old.supported, false);
  assert.match(old.reason, /2\.1\.261 is older than 2\.1\.287/);
  const none = mod.supports('');
  assert.equal(none.supported, false);
  assert.match(none.reason, /other providers keep the hook path/);
  assert.equal(mod.supports('codex 0.42').supported, false, 'a non-Claude CLI never passes');
});

test('install(): refuses on an unsupported CLI without running anything', (t, done) => {
  mod.install({ cli: 'definitely-not-a-binary', root: 'D:/x', current: '2.1.261' }, (err, r) => {
    assert.equal(err, null);
    assert.equal(r.ok, false);
    assert.equal(r.gated, true);
    assert.match(r.error, /older than/);
    done();
  });
});

test('installCommands(): adds the checkout as a marketplace, then installs at user scope', () => {
  const cmds = mod.installCommands('D:/gander');
  assert.deepEqual(cmds[0], ['plugin', 'marketplace', 'add', 'D:/gander']);
  assert.deepEqual(cmds[1], ['plugin', 'install', 'gander-feed@gander', '--scope', 'user']);
});

// ── telemetry ────────────────────────────────────────────────────────────────
test('ingest(): rejects a body without session_id or kind', () => {
  assert.equal(mod.ingest(null).error, 'invalid body');
  assert.equal(mod.ingest({ kind: 'hello' }).error, 'session_id required');
  assert.equal(mod.ingest({ session_id: 's1' }).error, 'kind required');
  assert.match(mod.ingest({ session_id: 's1', kind: 'nope' }).error, /unknown kind/);
});

test('ingest(): measure sets context, rate limits and cost; the summary is exact', () => {
  const t0 = 1_000_000;
  mod.ingest({ session_id: 's1', kind: 'hello', version: '2.1.294', model: 'claude-fable-5-1', cwd: 'D:/p' }, t0);
  const r = mod.ingest({
    session_id: 's1', kind: 'measure',
    context: { tokens: 80000, window: 200000, percent: 40 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: null }],
    costUsd: 1.25,
  }, t0 + 10);
  assert.equal(r.ok, true);
  const s = mod.forSession('s1', t0 + 20);
  assert.equal(s.live, true);
  assert.equal(s.costUsd, 1.25);
  assert.equal(s.ctxPct, 0.4);
  assert.equal(s.ctxMax, 200000);
  assert.equal(s.version, '2.1.294');
  assert.deepEqual(s.rateLimits, [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: null }]);
});

test('ingest(): turns add up usage and cache-hit; steps count per model and per sub-agent', () => {
  mod.ingest({ session_id: 's1', kind: 'hello' });
  mod.ingest({ session_id: 's1', kind: 'turn', reason: 'answer', usage: { model: 'claude-fable-5-1', input: 100, output: 50, cacheRead: 300, cacheWrite: 100 } });
  mod.ingest({ session_id: 's1', kind: 'turn', reason: 'answer', usage: { model: 'claude-fable-5-1', input: 100, output: 50, cacheRead: 300, cacheWrite: 100 } });
  mod.ingest({ session_id: 's1', kind: 'step', model: 'claude-fable-5-1', index: 0 });
  mod.ingest({ session_id: 's1', kind: 'spawn', toolUseId: 'tu1', subagentType: 'Explore', description: 'find it', model: 'claude-haiku-4-5', agentId: 'a1' });
  mod.ingest({ session_id: 's1', kind: 'step', model: 'claude-haiku-4-5', index: 0, agentId: 'a1' });
  mod.ingest({ session_id: 's1', kind: 'step', model: 'claude-haiku-4-5', index: 1, agentId: 'a1' });
  const s = mod.forSession('s1');
  assert.equal(s.turns, 2);
  assert.equal(s.input, 200); assert.equal(s.output, 100); assert.equal(s.cacheRead, 600); assert.equal(s.cacheWrite, 200);
  assert.equal(s.tokens, 1100);
  assert.equal(s.cacheHit, 600 / 1000);
  assert.equal(s.steps, 3); assert.equal(s.mainSteps, 1);
  assert.deepEqual(s.byModel, { 'claude-fable-5-1': 1, 'claude-haiku-4-5': 2 });
  assert.equal(s.subagents, 1); assert.equal(s.spawns, 1);
  const subs = mod.subagentsOf('s1');
  assert.equal(subs.a1.type, 'Explore'); assert.equal(subs.a1.steps, 2); assert.equal(subs.a1.model, 'claude-haiku-4-5');
});

test('a feed goes stale after STALE_MS and dead at bye, so the estimate takes over', () => {
  const t0 = 5_000_000;
  mod.ingest({ session_id: 's1', kind: 'hello' }, t0);
  assert.equal(mod.forSession('s1', t0 + mod.STALE_MS - 1).live, true);
  assert.equal(mod.forSession('s1', t0 + mod.STALE_MS + 1).live, false);
  mod.ingest({ session_id: 's1', kind: 'measure', costUsd: 2 }, t0 + 10);
  assert.equal(mod.forSession('s1', t0 + 20).live, true, 'any event refreshes it');
  mod.ingest({ session_id: 's1', kind: 'bye', reason: 'exit' }, t0 + 30);
  assert.equal(mod.forSession('s1', t0 + 31).live, false);
  assert.equal(mod.forSession('s1', t0 + 31).costUsd, 2, 'the last figures stay readable');
  assert.equal(mod.liveCount(t0 + 31), 0);
});

test('band(): rounds spend and context for the one-line band; unknown stays null', () => {
  mod.ingest({ session_id: 's1', kind: 'measure', context: { tokens: 1, window: 200000, percent: 41.6 }, costUsd: 1.2345 });
  assert.deepEqual(mod.band({ sid: 's1', needsYou: 2, url: 'http://127.0.0.1:3131' }),
    { needsYou: 2, spendUsd: 1.23, ctxPercent: 42, url: 'http://127.0.0.1:3131' });
  assert.deepEqual(mod.band({ sid: 'nope', needsYou: 0, url: 'u' }), { needsYou: 0, spendUsd: null, ctxPercent: null, url: 'u' });
});

test('sweep(): forgets feeds whose sessions ended long ago', () => {
  const t0 = 9_000_000;
  mod.ingest({ session_id: 'old', kind: 'bye' }, t0);
  mod.ingest({ session_id: 'new', kind: 'hello' }, t0 + 25 * 3600e3);
  mod.sweep(t0 + 25 * 3600e3);
  assert.equal(mod.forSession('old'), null);
  assert.ok(mod.forSession('new'));
});

// ── install state, read from Claude's plugin files ───────────────────────────
test('installState(): reads installed_plugins.json and known_marketplaces.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-mod-'));
  assert.deepEqual(mod.installState(dir), { installed: false, marketplace: false });
  fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'gander-feed@gander': { scope: 'user' } } }));
  fs.writeFileSync(path.join(dir, 'known_marketplaces.json'), JSON.stringify({ gander: { source: { source: 'directory', path: 'D:/gander' } } }));
  assert.deepEqual(mod.installState(dir), { installed: true, marketplace: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status(): one object the Settings panel can render as-is', () => {
  const s = mod.status({ current: '2.1.261', root: 'D:/gander' });
  assert.equal(s.supported, false);
  assert.equal(s.ccVersion, '2.1.261');
  assert.equal(s.minVersion, '2.1.287');
  assert.equal(s.plugin, 'gander-feed@gander');
  assert.equal(s.installLine, '/plugin install gander-feed@gander');
  assert.equal(typeof s.installed, 'boolean');
});
