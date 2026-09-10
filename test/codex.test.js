'use strict';
// bridge/codex.js — reads OpenAI Codex rollouts (sessions/YYYY/MM/DD/rollout-*.jsonl)
// from GANDER_CODEX_HOME. Fixtures are real JSONL files in a temp dir; extras:false
// keeps node:sqlite out of every tick/summary.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-codex-'));
process.env.GANDER_CODEX_HOME = HOME_DIR;

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const codex = require('../bridge/codex.js');

// ── fixtures ────────────────────────────────────────────────────────────────
const BASE = Date.parse('2026-09-10T05:48:50.081Z');           // first line's timestamp
const NOW = Date.parse('2026-09-10T06:00:00.000Z');            // "wall clock" for tick/summary
const CWD_ALPHA = path.join('D:', 'proj', 'alpha');
const CWD_BETA = path.join('D:', 'proj', 'beta');
const E = {
  meta: (id, cwd = CWD_ALPHA) => ({ type: 'session_meta', payload: { id, cwd, originator: 'Codex Desktop', cli_version: '0.153.0', source: 'vscode' } }),
  started: (turn = 't1') => ({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn } }),
  user: (text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }),
  exec: (cmd) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}))` } }),
  patch: () => ({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: '{"patch":"*** Begin Patch"}' } }),
  tokens: (input, cached, output) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } } }),
  approval: (command) => ({ type: 'event_msg', payload: { type: 'exec_approval_request', command } }),
  complete: (msg, turn = 't1') => ({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: msg } }),
  aborted: () => ({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }),
  error: (message) => ({ type: 'event_msg', payload: { type: 'error', message } }),
};
const stamp = (events, baseMs = BASE) => events.map((e, i) => ({ timestamp: new Date(baseMs + i * 1000).toISOString(), ...e }));
const lines = (events, baseMs) => stamp(events, baseMs).map((o) => JSON.stringify(o));
const FULL_TURN = [E.meta('T1'), E.started(), E.user('fix the tests'), E.exec('npm test'), E.exec('Get-Content -Raw src/a.js'), E.patch(), E.tokens(28558, 18944, 92), E.complete('Done, all green.')];

let home;                                                      // fresh per test, under HOME_DIR
function writeRollout(id, events, { mtimeMs = NOW, baseMs = BASE } = {}) {
  const dir = path.join(home, 'sessions', '2026', '09', '10');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-10T00-48-31-${id}.jsonl`);
  fs.writeFileSync(file, lines(events, baseMs).join('\n') + '\n');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}
let n = 0;
beforeEach(() => { codex._reset(); home = path.join(HOME_DIR, 'h' + (++n)); fs.mkdirSync(home, { recursive: true }); });

// ── parse state machine ─────────────────────────────────────────────────────
describe('parseLines state machine', () => {
  test('tool calls drive the state; task_complete lands on idle with counters filled', () => {
    const upTo = (k) => codex.parseLines(lines(FULL_TURN.slice(0, k)));
    assert.equal(upTo(2).state, 'thinking');                   // task_started
    assert.equal(upTo(4).state, 'testing');                    // exec npm test
    assert.equal(upTo(5).state, 'reading');                    // exec Get-Content
    assert.equal(upTo(6).state, 'coding');                     // apply_patch
    const s = upTo(FULL_TURN.length);
    assert.equal(s.state, 'idle');
    assert.equal(s.lastMessage, 'Done, all green.');
    assert.equal(s.log, 'Done, all green.');
    assert.equal(s.firstUser, 'fix the tests');
    assert.deepEqual(s.tokens, { input: 28558, cached: 18944, output: 92, total: 28650 });
    assert.deepEqual([s.turns, s.completedTurns, s.toolCalls], [1, 1, 3]);
    assert.equal(s.cwd, CWD_ALPHA);
    assert.equal(s.originator, 'Codex Desktop');
    assert.equal(s.cliVersion, '0.153.0');
    assert.equal(s.startedAt, BASE);
    assert.equal(s.lastAt, BASE + (FULL_TURN.length - 1) * 1000);
  });

  test('exec_approval_request → awaiting with the command in awaitMsg', () => {
    const s = codex.parseLines(lines([E.meta('T1'), E.started(), E.approval(['rm', '-rf', 'build'])]));
    assert.equal(s.state, 'awaiting');
    assert.match(s.awaitMsg, /rm -rf build/);
    assert.equal(s.log, s.awaitMsg);
  });

  test('error event → error state; turn_aborted → idle with an interrupted log', () => {
    const err = codex.parseLines(lines([E.meta('T1'), E.started(), E.exec('npm test'), E.error('rate limited')]));
    assert.equal(err.state, 'error');
    assert.equal(err.errors, 1);
    assert.equal(err.log, 'rate limited');
    const ab = codex.parseLines(lines([E.meta('T1'), E.started(), E.exec('npm test'), E.aborted()]));
    assert.equal(ab.state, 'idle');
    assert.equal(ab.aborted, 1);
    assert.match(ab.log, /^interrupted/);
    assert.equal(ab.completedTurns, 0);
  });
});

// ── classifyTool / cost ─────────────────────────────────────────────────────
describe('classifyTool + cost', () => {
  test('classifyTool table', () => {
    const table = [
      ['exec', 'npm test', 'testing'], ['exec', 'cat x', 'reading'], ['exec', 'curl https://example.com', 'searching'],
      ['exec', 'echo hi > f', 'coding'], ['wait', '', 'thinking'], ['apply_patch', '{}', 'coding'], ['spawn_agent', '{}', 'spawning'],
    ];
    for (const [name, arg, want] of table) assert.equal(codex.classifyTool(name, arg), want, `${name} ${arg}`);
  });

  test('cost: cached tokens billed at cacheRead (default 0.1 × input); null price is free', () => {
    const tokens = { input: 1_000_000, cached: 400_000, output: 100_000 };
    assert.ok(Math.abs(codex.cost(tokens, { input: 2, output: 8 }) - 2.08) < 1e-9);
    assert.ok(Math.abs(codex.cost(tokens, { input: 2, output: 8, cacheRead: 1 }) - 2.4) < 1e-9);
    assert.equal(codex.cost(tokens, null), 0);
    assert.equal(codex.cost(null, { input: 2, output: 8 }), 0);
  });
});

// ── discovery ───────────────────────────────────────────────────────────────
describe('listRollouts', () => {
  test('finds rollouts, parses ids, honours sinceMs, ignores stray files', () => {
    writeRollout('AAA', FULL_TURN);
    writeRollout('BBB', FULL_TURN, { mtimeMs: NOW - 3600e3 });
    const dir = path.join(home, 'sessions', '2026', '09', '10');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'rollout-2026-09-10T00-00-00-ZZZ.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'other-2026-09-10T00-00-00-ZZZ.jsonl'), 'x');
    const all = codex.listRollouts(home);
    assert.deepEqual(all.map((r) => r.id), ['AAA', 'BBB']);   // newest mtime first
    assert.ok(all.every((r) => r.size > 0 && r.path.endsWith('.jsonl')));
    assert.deepEqual(codex.listRollouts(home, NOW - 60e3).map((r) => r.id), ['AAA']);
    assert.deepEqual(codex.listRollouts(path.join(home, 'nope')), []);
  });
});

// ── tick ────────────────────────────────────────────────────────────────────
describe('tick', () => {
  const opts = (extra) => ({ home, now: NOW, priceFor: () => ({ input: 2, output: 8 }), liveWindowMs: 6 * 3600e3, idleAfterMs: 90e3, extras: false, ...extra });

  test('a live rollout becomes one codex agent event', () => {
    const open = FULL_TURN.slice(0, 7);                        // ends on token_count, turn still open, state coding
    writeRollout('T1', open, { baseMs: NOW - open.length * 1000 });
    const out = codex.tick(opts());
    assert.equal(out.events.length, 1);
    assert.equal(out.sqlite, false);
    const ev = out.events[0];
    assert.equal(ev.agentId, 'codex:T1');
    assert.equal(ev.tool, 'codex');
    assert.equal(ev.project, 'alpha');
    assert.equal(ev.root, true);
    assert.equal(ev.state, 'coding');
    assert.equal(ev.goal, 'fix the tests');
    assert.ok(Math.abs(ev.costUSD - codex.cost({ input: 28558, cached: 18944, output: 92 }, { input: 2, output: 8 })) < 1e-12);
    assert.ok(ev.costUSD > 0);
    assert.equal(ev.codex.toolCalls, 3);
  });

  test('an open turn that went quiet past idleAfterMs reports idle', () => {
    writeRollout('T1', FULL_TURN.slice(0, 7));                 // lastAt ≈ 05:48:56, now = 06:00 → 11 min quiet
    assert.equal(codex.tick(opts()).events[0].state, 'idle');
    assert.equal(codex.tick(opts({ idleAfterMs: 3600e3 })).events[0].state, 'coding');
  });

  test('rollouts older than liveWindowMs are excluded', () => {
    writeRollout('OLD', FULL_TURN, { mtimeMs: NOW - 7 * 3600e3 });
    writeRollout('NEW', FULL_TURN);
    assert.deepEqual(codex.tick(opts()).events.map((e) => e.agentId), ['codex:NEW']);
  });
});

// ── incremental reader ──────────────────────────────────────────────────────
describe('readSession', () => {
  test('appended lines are folded in without re-parsing from zero', () => {
    const file = writeRollout('T1', FULL_TURN.slice(0, 7));
    const first = codex.readSession(file);
    assert.equal(first.toolCalls, 3);
    assert.equal(first.turns, 1);
    fs.appendFileSync(file, JSON.stringify(stamp([E.exec('npm test')], BASE + 7000)[0]) + '\n');
    const second = codex.readSession(file);
    assert.equal(second, first, 'same cached session object');
    assert.equal(second.toolCalls, 4);
    assert.equal(second.turns, 1, 'earlier lines were not replayed');
    assert.equal(second.state, 'testing');
    assert.equal(codex.readSession(path.join(home, 'missing.jsonl')), null);
  });
});

// ── summary ─────────────────────────────────────────────────────────────────
describe('summary', () => {
  test('totals, byProject grouping, cost sums and the live flag', () => {
    writeRollout('A1', FULL_TURN);
    writeRollout('A2', [E.meta('A2'), E.started(), E.exec('npm test'), E.tokens(1000, 0, 100), E.complete('ok')], { mtimeMs: NOW - 7 * 3600e3 });
    writeRollout('B1', [E.meta('B1', CWD_BETA), E.started(), E.tokens(500, 0, 50), E.complete('ok')]);
    const r = codex.summary({ home, now: NOW, days: 7, priceFor: () => ({ input: 2, output: 8 }), extras: false });
    assert.equal(r.totals.sessions, 3);
    assert.equal(r.totals.tokens, 28650 + 1100 + 550);
    assert.ok(Math.abs(r.totals.costUSD - r.sessions.reduce((n, s) => n + s.costUSD, 0)) < 1e-12);
    assert.ok(r.totals.costUSD > 0);
    assert.deepEqual(r.byProject.map((p) => [p.project, p.sessions, p.tokens]), [['alpha', 2, 28650 + 1100], ['beta', 1, 550]]);
    const live = Object.fromEntries(r.sessions.map((s) => [s.id, s.live]));
    assert.deepEqual(live, { A1: true, A2: false, B1: true });
    assert.equal(r.sessions.find((s) => s.id === 'A1').title, 'fix the tests');
    assert.equal(r.sqlite, false);
  });
});
