'use strict';
// test/replay.test.js — tests for bridge/replay.js (fixture .jsonl in a temp
// dir passed via opts.file; never touches the real ~/.claude).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const replay = require('../bridge/replay.js');

const T0 = Date.parse('2026-07-08T10:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

// Sonnet pricing (usage.js PRICING): input $3/M, output $15/M, cacheWrite $3.75/M, cacheRead $0.30/M
const MODEL = 'claude-sonnet-4-20250514';
const COST_MSG1 = (1000 / 1e6) * 3 + (500 / 1e6) * 15;                                        // 0.0105
const COST_MSG2 = (2000 / 1e6) * 3 + (100 / 1e6) * 15 + (500 / 1e6) * 3.75 + (1000 / 1e6) * 0.30; // 0.009675

function fixtureLines() {
  const asst1 = {
    type: 'assistant',
    timestamp: iso(10_000),
    cwd: 'C:\\proj\\demo',
    message: {
      id: 'msg_001',
      role: 'assistant',
      model: MODEL,
      content: [
        { type: 'text', text: 'I will write the file now.' },
        { type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: 'C:\\proj\\demo\\a.js', content: 'x' } },
      ],
      usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  return [
    { type: 'user', timestamp: iso(0), cwd: 'C:\\proj\\demo', message: { role: 'user', content: 'build the thing please' } },
    asst1,
    // duplicate streaming line — same message id, must not double-count or re-emit
    { ...asst1, timestamp: iso(11_000) },
    {
      type: 'user', timestamp: iso(20_000), cwd: 'C:\\proj\\demo',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'EACCES: permission denied' }] },
    },
    {
      type: 'assistant', timestamp: iso(30_000), cwd: 'C:\\proj\\demo',
      message: {
        id: 'msg_002', role: 'assistant', model: MODEL,
        content: [{ type: 'text', text: 'That write failed — permissions.' }],
        usage: { input_tokens: 2000, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000 },
      },
    },
  ];
}

function writeFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-replay-'));
  const file = path.join(dir, 'fixture-session.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('replay.build()', () => {
  test('builds a chronological timeline with cumulative tokens/cost', async () => {
    const file = writeFixture(fixtureLines());
    const r = await replay.build('fixture-session', { file });

    assert.equal(r.ok, true);
    assert.equal(r.sessionId, 'fixture-session');
    assert.equal(r.project, 'demo');
    assert.equal(r.cwd, 'C:\\proj\\demo');
    assert.equal(r.startedAt, iso(0));
    assert.equal(r.endedAt, iso(30_000));
    assert.equal(r.durationMs, 30_000);

    // duplicate assistant line (same message id) counted exactly once
    assert.equal(r.totalTokens, 1500 + 3600, 'tokens not double-counted');
    assert.ok(Math.abs(r.totalCostUSD - (COST_MSG1 + COST_MSG2)) < 1e-9, 'cost not double-counted');

    // event order + kinds (dup line emits nothing)
    assert.deepEqual(r.events.map((e) => e.kind), ['prompt', 'text', 'tool', 'error', 'text']);

    // t monotonic non-decreasing, in ms since session start
    const ts = r.events.map((e) => e.t);
    assert.deepEqual(ts, [0, 10_000, 10_000, 20_000, 30_000]);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1], 't monotonic');

    // prompt
    assert.equal(r.events[0].label, 'build the thing please');
    assert.equal(r.events[0].tokens, 0);
    assert.equal(r.events[0].costUSD, 0);

    // assistant text -> thinking, carries msg_001's usage cumulatively
    assert.equal(r.events[1].state, 'thinking');
    assert.equal(r.events[1].tokens, 1500);
    assert.ok(Math.abs(r.events[1].costUSD - COST_MSG1) < 1e-9);

    // tool_use Write -> coding (via parser.stateForTool), label via detailForTool
    assert.equal(r.events[2].kind, 'tool');
    assert.equal(r.events[2].state, 'coding', 'Write maps to coding');
    assert.match(r.events[2].label, /^Write .*a\.js/);
    assert.equal(r.events[2].tokens, 1500, 'dup line did not add tokens');

    // is_error tool_result -> error event; successful ones are skipped entirely
    assert.equal(r.events[3].state, 'error');
    assert.match(r.events[3].label, /EACCES/);
    assert.equal(r.events[3].tokens, 1500);

    // final text carries the full cumulative totals
    assert.equal(r.events[4].tokens, 5100);
    assert.ok(Math.abs(r.events[4].costUSD - (COST_MSG1 + COST_MSG2)) < 1e-9);
  });

  test('ignores successful tool_result user lines', async () => {
    const lines = fixtureLines();
    lines.splice(3, 0, {
      type: 'user', timestamp: iso(15_000), cwd: 'C:\\proj\\demo',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok, 12 lines written' }] },
    });
    const r = await replay.build('fixture-session', { file: writeFixture(lines) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.events.map((e) => e.kind), ['prompt', 'text', 'tool', 'error', 'text']);
  });

  test('unknown models cost 0 but still count tokens', async () => {
    const lines = fixtureLines().slice(0, 2);
    lines[1].message.model = 'deepseek-chat';
    const r = await replay.build('fixture-session', { file: writeFixture(lines) });
    assert.equal(r.ok, true);
    assert.equal(r.totalTokens, 1500);
    assert.equal(r.totalCostUSD, 0);
  });

  test('caps events at 2000 and appends a synthetic truncation note', async () => {
    const lines = [];
    for (let i = 0; i < 2100; i++) {
      lines.push({ type: 'user', timestamp: iso(i * 1000), cwd: 'C:\\proj\\demo', message: { role: 'user', content: 'prompt ' + i } });
    }
    const r = await replay.build('fixture-session', { file: writeFixture(lines) });
    assert.equal(r.ok, true);
    assert.equal(r.events.length, 2001, 'first 2000 + 1 truncation note');
    assert.equal(r.events[1999].label, 'prompt 1999');
    const last = r.events[2000];
    assert.equal(last.kind, 'done');
    assert.equal(last.state, 'idle');
    assert.match(last.label, /truncated: 100 more events/);
    assert.equal(last.t, 2099 * 1000, 'note sits at the end of the timeline');
  });

  test('ok:false on missing file and invalid session id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-replay-'));
    const missing = await replay.build('fixture-session', { file: path.join(dir, 'nope.jsonl') });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'session not found');

    const bad = await replay.build('../../etc/passwd');
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'invalid session id');
  });
});
