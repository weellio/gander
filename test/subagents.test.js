'use strict';
// bridge/subagents.js — reads the sub-agent files Claude Code leaves on disk:
//   <projects>/<slug>/<sessionId>/subagents/agent-<id>.{jsonl,meta.json}
// Points the module at a fresh temp dir so nothing touches ~/.claude.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-subagents-'));
process.env.GANDER_PROJECTS_DIR = PROJECTS;

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sub = require('../bridge/subagents.js');

const SLUG = 'D--proj-alpha';
const dirOf = (sessionId) => path.join(PROJECTS, SLUG, sessionId, 'subagents');
const transcriptOf = (sessionId) => path.join(PROJECTS, SLUG, `${sessionId}.jsonl`);
const usd = (n) => Number(n.toFixed(6));

// one assistant turn: friendly token names -> the wire names Claude Code writes
const turnLine = (t, model) => JSON.stringify({
  type: 'assistant',
  timestamp: t.ts,
  message: {
    model,
    usage: {
      input_tokens: (t.usage && t.usage.input) || 0,
      output_tokens: (t.usage && t.usage.output) || 0,
      cache_creation_input_tokens: (t.usage && t.usage.cacheWrite) || 0,
      cache_read_input_tokens: (t.usage && t.usage.cacheRead) || 0,
    },
    content: Array.from({ length: t.toolUses || 0 }, () => ({ type: 'tool_use', name: 'Bash' }))
      .concat([{ type: 'text', text: 'ok' }]),
  },
});

// Builds a fixture sub-agent (both files) and returns its paths.
function makeAgent(o) {
  const { agentId, description = '', agentType = 'general-purpose', turns = [],
    requestShape, sessionId = 'sess-1', cwd = 'D:\\proj\\alpha', model = 'claude-opus-5' } = o;
  const dir = dirOf(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const m = { agentType, description, toolUseId: `toolu_${agentId}`, spawnDepth: 1 };
  if (requestShape) m.requestShape = requestShape;
  fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(m));
  const jsonl = path.join(dir, `agent-${agentId}.jsonl`);
  const head = JSON.stringify({ type: 'user', timestamp: turns[0] && turns[0].ts, cwd, message: { role: 'user', content: 'go' } });
  fs.writeFileSync(jsonl, [head].concat(turns.map((t) => turnLine(t, model))).join('\n') + '\n');
  return { dir, jsonl, transcriptPath: transcriptOf(sessionId) };
}
const appendTurn = (jsonl, t, model = 'claude-opus-5') => fs.appendFileSync(jsonl, turnLine(t, model) + '\n');
const T = (hhmmss) => `2026-09-18T${hhmmss}.000Z`;

// the user line Claude Code writes back after a tool runs; `content` may be a
// string or an array of text blocks, both shapes appear on disk
const resultLine = (ts, results) => JSON.stringify({
  type: 'user', timestamp: ts,
  message: { role: 'user', content: results.map((r, i) => ({
    type: 'tool_result', tool_use_id: `toolu_${i}`, content: r.content, ...(r.error ? { is_error: true } : {}),
  })) },
});
// the agent's closing answer: text only, no tool call
const finalLine = (ts, text = 'All done.') => JSON.stringify({
  type: 'assistant', timestamp: ts,
  message: { model: 'claude-opus-5', role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text }] },
});
const appendLine = (jsonl, line) => fs.appendFileSync(jsonl, line + '\n');
const REJECT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

// a whole finished-or-not run in one go, for scorecard fixtures
function makeRun({ agentId, agentType, sessionId = 'sess-1', toolUses = 2, errors = 0, input = 1000, output = 100, durS = 10, final = true, endOnError = false }) {
  const { jsonl } = makeAgent({ agentId, agentType, sessionId, description: agentId,
    turns: [{ ts: T('10:00:00'), usage: { input, output }, toolUses }] });
  const results = Array.from({ length: toolUses }, (_, i) => ({ content: i < errors ? 'Exit code 1' : 'ok', error: i < errors }));
  if (results.length) appendLine(jsonl, resultLine(T('10:00:01'), results));
  if (endOnError) {
    appendLine(jsonl, turnLine({ ts: T('10:00:02'), toolUses: 1 }, 'claude-opus-5'));
    appendLine(jsonl, resultLine(T('10:00:03'), [{ content: 'boom', error: true }]));
  }
  if (final) appendLine(jsonl, finalLine(`2026-09-18T10:00:${String(durS).padStart(2, '0')}.000Z`));
  return jsonl;
}

describe('subagents', () => {
  beforeEach(() => {
    for (const n of fs.readdirSync(PROJECTS)) fs.rmSync(path.join(PROJECTS, n), { recursive: true, force: true });
    sub._reset();
  });

  test('dirFor maps a session transcript to its subagents folder', () => {
    assert.equal(sub.dirFor(path.join(PROJECTS, SLUG, 'sess-1.jsonl')), dirOf('sess-1'));
    assert.equal(sub.dirFor(''), '');
  });

  test('meta reads description, agentType and toolUseId; background only for requestShape "background"', () => {
    const { dir } = makeAgent({ agentId: 'a1', description: 'Codex badge + cost section in the UI', requestShape: 'background' });
    makeAgent({ agentId: 'a2', description: 'Foreground work', agentType: 'Explore' });
    const m = sub.meta('a1', dir);
    assert.equal(m.description, 'Codex badge + cost section in the UI');
    assert.equal(m.agentType, 'general-purpose');
    assert.equal(m.toolUseId, 'toolu_a1');
    assert.equal(m.background, true);
    assert.equal(sub.meta('a2', dir).background, false);
    assert.equal(sub.meta('a2', dir).agentType, 'Explore');
  });

  test('meta returns null for an unknown agent and for malformed JSON, without throwing', () => {
    const { dir } = makeAgent({ agentId: 'a1', description: 'real one' });
    assert.equal(sub.meta('nope', dir), null);
    fs.writeFileSync(path.join(dir, 'agent-bad.meta.json'), '{ not json');
    assert.equal(sub.meta('bad', dir), null);
    sub.forget('bad');                      // the miss is retryable after forget()
    assert.equal(sub.meta('bad', dir), null);
  });

  test('stats sums every token field, counts tool uses and turns, and reads model, cwd and duration', () => {
    const { dir } = makeAgent({
      agentId: 'a1', description: 'stats', cwd: 'D:\\proj\\alpha',
      turns: [
        { ts: T('13:30:04'), usage: { input: 2, output: 4, cacheWrite: 39006, cacheRead: 0 }, toolUses: 2 },
        { ts: T('13:30:14'), usage: { input: 5, output: 11, cacheWrite: 0, cacheRead: 1000 }, toolUses: 1 },
      ],
    });
    const s = sub.stats('a1', dir);
    assert.deepEqual(s.tokens, { input: 7, output: 15, cacheWrite: 39006, cacheRead: 1000, total: 40028 });
    assert.equal(s.toolUses, 3);
    assert.equal(s.turns, 2);
    assert.equal(s.model, 'claude-opus-5');
    assert.equal(s.cwd, 'D:\\proj\\alpha');
    assert.equal(s.durationMs, 10000);
    assert.equal(sub.stats('nope', dir), null);
  });

  test('stats is incremental: an appended turn is added once, earlier turns are not recounted', () => {
    const { dir, jsonl } = makeAgent({
      agentId: 'a1', description: 'incremental',
      turns: [{ ts: T('13:30:04'), usage: { input: 100, output: 10 }, toolUses: 1 }],
    });
    assert.equal(sub.stats('a1', dir).tokens.total, 110);
    appendTurn(jsonl, { ts: T('13:30:24'), usage: { input: 5, output: 1, cacheRead: 4 }, toolUses: 2 });
    const s = sub.stats('a1', dir);
    assert.equal(s.tokens.total, 120);          // 110 + 10, not 110 + 110 + 10
    assert.deepEqual(s.tokens, { input: 105, output: 11, cacheWrite: 0, cacheRead: 4, total: 120 });
    assert.equal(s.toolUses, 3);
    assert.equal(s.turns, 2);
    assert.equal(s.durationMs, 20000);
    assert.equal(sub.stats('a1', dir).tokens.total, 120);   // re-reading changes nothing
  });

  test('cost prices cache tiers off input by default and honours explicit overrides', () => {
    const tokens = { input: 1_000_000, output: 100_000, cacheRead: 400_000, cacheWrite: 200_000 };
    assert.equal(usd(sub.cost(tokens, { input: 2, output: 8 })), 3.38);   // 2 + 0.8 + 0.08 + 0.5
    assert.equal(usd(sub.cost({ input: 1_000_000 }, { input: 2, output: 8 })), 2);
    assert.equal(usd(sub.cost({ output: 100_000 }, { input: 2, output: 8 })), 0.8);
    assert.equal(usd(sub.cost({ cacheRead: 400_000 }, { input: 2, output: 8 })), 0.08);
    assert.equal(usd(sub.cost({ cacheWrite: 200_000 }, { input: 2, output: 8 })), 0.5);
    // explicit tiers override the derived defaults
    assert.equal(usd(sub.cost(tokens, { input: 2, output: 8, cacheRead: 1, cacheWrite: 4 })), 2 + 0.8 + 0.4 + 0.8);
    assert.equal(sub.cost(tokens, null), 0);                             // unpriced model = $0
  });

  test('roster spans sessions, sorts newest first, honours limit and totals cost by type', () => {
    makeAgent({
      agentId: 'a1', description: 'older', agentType: 'Explore', sessionId: 'sess-1',
      turns: [{ ts: T('10:00:00'), usage: { input: 1000, output: 100 }, toolUses: 1 }],
    });
    makeAgent({
      agentId: 'a2', description: 'newer', agentType: 'general-purpose', sessionId: 'sess-2',
      turns: [{ ts: T('12:00:00'), usage: { input: 10, output: 5 }, toolUses: 2 }],
    });
    const priceFor = () => ({ input: 2, output: 8 });
    const r = sub.roster({ priceFor });
    assert.deepEqual(r.subagents.map((x) => x.agentId), ['a2', 'a1']);
    assert.deepEqual(r.subagents.map((x) => x.sessionId), ['sess-2', 'sess-1']);
    assert.equal(r.subagents[0].description, 'newer');
    assert.equal(r.subagents[0].project, 'alpha');
    assert.equal(r.totals.count, 2);
    assert.equal(r.totals.tokens, 1115);
    assert.equal(usd(r.totals.costUSD), usd(sub.cost({ input: 1010, output: 105 }, { input: 2, output: 8 })));
    assert.deepEqual(r.byType.map((t) => t.agentType), ['Explore', 'general-purpose']);
    assert.deepEqual(r.byType.map((t) => t.tokens), [1100, 15]);
    assert.deepEqual(sub.roster({ limit: 1 }).subagents.map((x) => x.agentId), ['a2']);
    assert.equal(sub.roster({ limit: 1 }).totals.count, 1);
  });

  test('roster filters by days using the transcript mtime', () => {
    const old = makeAgent({
      agentId: 'a1', description: 'ancient', sessionId: 'sess-1',
      turns: [{ ts: T('10:00:00'), usage: { input: 10, output: 1 } }],
    });
    makeAgent({
      agentId: 'a2', description: 'fresh', sessionId: 'sess-2',
      turns: [{ ts: T('12:00:00'), usage: { input: 10, output: 1 } }],
    });
    const monthAgo = new Date(Date.now() - 30 * 86400e3);
    fs.utimesSync(old.jsonl, monthAgo, monthAgo);
    assert.deepEqual(sub.roster({ days: 14 }).subagents.map((x) => x.agentId), ['a2']);
    assert.deepEqual(sub.roster({ days: 0 }).subagents.map((x) => x.agentId), ['a2', 'a1']);
  });

  test('describe names the tile after the meta description, falling back to agentType', () => {
    const { transcriptPath } = makeAgent({
      agentId: 'a1', description: 'Codex badge + cost section in the UI', agentType: 'general-purpose',
      turns: [{ ts: T('13:30:04'), usage: { input: 1000, output: 100 }, toolUses: 3 }],
    });
    makeAgent({ agentId: 'a2', description: '', agentType: 'Explore', turns: [{ ts: T('13:30:04'), usage: { input: 10 } }] });
    const d = sub.describe('a1', transcriptPath, () => ({ input: 2, output: 8 }));
    assert.equal(d.name, 'Codex badge + cost section in the UI');
    assert.equal(d.agentType, 'general-purpose');
    assert.equal(d.tokens.total, 1100);
    assert.equal(d.model, 'claude-opus-5');
    assert.equal(d.toolUses, 3);
    assert.equal(usd(d.costUSD), usd(sub.cost({ input: 1000, output: 100 }, { input: 2, output: 8 })));
    assert.equal(sub.describe('a2', transcriptPath).name, 'Explore');
    assert.equal(sub.describe('nope', transcriptPath), null);
  });

  test('stats counts a message split over several lines once, at its latest usage', () => {
    const { dir, jsonl } = makeAgent({ agentId: 'a1', turns: [] });
    const part = (ts, output, content) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'req_1',
      message: { id: 'msg_1', model: 'claude-opus-5', role: 'assistant', content,
        usage: { input_tokens: 32, output_tokens: output, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 } } });
    appendLine(jsonl, part(T('10:00:00'), 3, [{ type: 'thinking', thinking: 'hm' }]));
    appendLine(jsonl, part(T('10:00:01'), 40, [{ type: 'text', text: 'Let me look.' }]));
    assert.deepEqual(sub.stats('a1', dir).tokens, { input: 32, output: 40, cacheWrite: 1000, cacheRead: 5000, total: 6072 });
    appendLine(jsonl, part(T('10:00:02'), 255, [{ type: 'tool_use', name: 'Read' }]));   // read incrementally
    const s = sub.stats('a1', dir);
    assert.deepEqual(s.tokens, { input: 32, output: 255, cacheWrite: 1000, cacheRead: 5000, total: 6287 });
    assert.equal(s.turns, 1);
    assert.equal(s.toolUses, 1);
  });

  test('stats counts tool errors (string and block content) but never a user rejection', () => {
    const { dir, jsonl } = makeAgent({ agentId: 'a1', turns: [{ ts: T('10:00:00'), usage: { input: 1 }, toolUses: 5 }] });
    appendLine(jsonl, resultLine(T('10:00:01'), [
      { content: 'Exit code 1\nboom', error: true },
      { content: [{ type: 'text', text: 'File does not exist.' }], error: true },
      { content: REJECT, error: true },                                          // human said no
      { content: [{ type: 'text', text: 'Permission denied: the user denied this tool.' }], error: true }, // also a no
      { content: 'fine' },
    ]));
    appendLine(jsonl, finalLine(T('10:00:05')));
    const s = sub.stats('a1', dir);
    assert.equal(s.toolErrors, 2);
    assert.equal(s.toolUses, 5);
    assert.equal(s.endedOnError, false);       // recovered and answered
    // incremental: a later error is added once, earlier ones are not recounted
    appendLine(jsonl, resultLine(T('10:00:06'), [{ content: 'timeout of 60000ms exceeded', error: true }]));
    assert.equal(sub.stats('a1', dir).toolErrors, 3);
    assert.equal(sub.stats('a1', dir).toolErrors, 3);
  });

  test('endedOnError: no closing answer, or the last tool call failed; a rejection is not a failure', () => {
    // finished cleanly
    const ok = makeAgent({ agentId: 'ok', turns: [{ ts: T('10:00:00'), usage: { input: 1 }, toolUses: 1 }] });
    appendLine(ok.jsonl, resultLine(T('10:00:01'), [{ content: 'ok' }]));
    appendLine(ok.jsonl, finalLine(T('10:00:02')));
    assert.equal(sub.stats('ok', ok.dir).endedOnError, false);
    // cut off after a tool call: no final answer
    const cut = makeAgent({ agentId: 'cut', turns: [{ ts: T('10:00:00'), usage: { input: 1 }, toolUses: 1 }] });
    appendLine(cut.jsonl, resultLine(T('10:00:01'), [{ content: 'ok' }]));
    assert.equal(sub.stats('cut', cut.dir).endedOnError, true);
    // never said anything at all
    const empty = makeAgent({ agentId: 'empty', turns: [] });
    assert.equal(sub.stats('empty', empty.dir).endedOnError, true);
    // answered, but its last tool call was an error
    const bad = makeAgent({ agentId: 'bad', turns: [{ ts: T('10:00:00'), usage: { input: 1 }, toolUses: 1 }] });
    appendLine(bad.jsonl, resultLine(T('10:00:01'), [{ content: 'Exit code 2', error: true }]));
    appendLine(bad.jsonl, finalLine(T('10:00:02'), 'Tests fail, giving up.'));
    assert.equal(sub.stats('bad', bad.dir).endedOnError, true);
    assert.equal(sub.stats('bad', bad.dir).toolErrors, 1);
    // the human rejected the last tool, the agent then answered: not an error ending
    const rej = makeAgent({ agentId: 'rej', turns: [{ ts: T('10:00:00'), usage: { input: 1 }, toolUses: 1 }] });
    appendLine(rej.jsonl, resultLine(T('10:00:01'), [{ content: REJECT, error: true }]));
    appendLine(rej.jsonl, finalLine(T('10:00:02'), 'OK, stopping.'));
    assert.equal(sub.stats('rej', rej.dir).endedOnError, false);
    assert.equal(sub.stats('rej', rej.dir).toolErrors, 0);
    // a cut-off run that later finishes flips back (incremental read)
    appendLine(cut.jsonl, finalLine(T('10:00:09')));
    assert.equal(sub.stats('cut', cut.dir).endedOnError, false);
  });

  test('roster and describe carry toolErrors / endedOnError', () => {
    const { transcriptPath } = makeAgent({ agentId: 'a1', description: 'x', turns: [] });
    const jsonl = makeRun({ agentId: 'a2', agentType: 'Explore', toolUses: 4, errors: 1 });
    assert.ok(fs.existsSync(jsonl));
    const r = sub.roster({}).subagents.find((x) => x.agentId === 'a2');
    assert.equal(r.toolErrors, 1);
    assert.equal(r.endedOnError, false);
    assert.equal(sub.describe('a2', transcriptPath).toolErrors, 1);
  });

  test('scorecard aggregates per agent type, sorted by runs, with error rates', () => {
    const priceFor = () => ({ input: 2, output: 8 });
    // general-purpose x3: 10 tool uses, 2 errors; one ended on error
    makeRun({ agentId: 'g1', agentType: 'general-purpose', toolUses: 4, errors: 1, durS: 10 });
    makeRun({ agentId: 'g2', agentType: 'general-purpose', toolUses: 2, errors: 0, durS: 20 });
    makeRun({ agentId: 'g3', agentType: 'general-purpose', toolUses: 3, errors: 0, durS: 30, endOnError: true }); // +1 use +1 err
    // Explore x1: clean
    makeRun({ agentId: 'e1', agentType: 'Explore', sessionId: 'sess-2', toolUses: 2, durS: 40 });

    const sc = sub.scorecard({ priceFor, days: 0, liveMs: 0 });
    assert.deepEqual(sc.map((x) => x.agentType), ['general-purpose', 'Explore']);
    const [gp, ex] = sc;
    assert.equal(gp.runs, 3);
    assert.equal(gp.avgToolUses, 3.3);                       // (4 + 2 + 4) / 3
    assert.equal(gp.toolErrorRate, 20);                      // 2 errors / 10 uses
    assert.equal(gp.endedOnErrorPct, 33);                    // 1 of 3
    assert.equal(gp.avgDurationMs, 20000);                   // (10 + 20 + 30) / 3 s
    const runCost = sub.cost({ input: 1001, output: 101 }, priceFor());   // turn + final line
    assert.equal(usd(gp.totalCostUSD), usd(runCost * 3));
    assert.equal(usd(gp.avgCostUSD), usd(runCost));
    assert.equal(gp.lastRunAt, Date.parse(T('10:00:30')));
    assert.equal(gp.sample, undefined);                      // 3 runs is enough to judge

    assert.equal(ex.runs, 1);
    assert.equal(ex.sample, 'small');
    assert.equal(ex.toolErrorRate, 0);
    assert.equal(ex.endedOnErrorPct, 0);
    assert.equal(ex.avgDurationMs, 40000);
    assert.deepEqual(Object.keys(gp).sort(), ['agentType', 'avgCostUSD', 'avgDurationMs', 'avgToolUses',
      'endedOnErrorPct', 'lastRunAt', 'runs', 'toolErrorRate', 'totalCostUSD'].sort());
  });

  test('scorecard: small sample under 3 runs, days window, unknown type, in-flight runs skipped', () => {
    makeRun({ agentId: 'p1', agentType: 'Plan' });
    makeRun({ agentId: 'p2', agentType: 'Plan' });
    const old = makeRun({ agentId: 'p3', agentType: 'Plan' });
    makeRun({ agentId: 'u1', agentType: '' });
    makeRun({ agentId: 'live', agentType: 'Plan', final: false });   // fresh mtime, no answer yet
    const monthAgo = new Date(Date.now() - 30 * 86400e3);
    fs.utimesSync(old, monthAgo, monthAgo);

    const recent = sub.scorecard({ days: 14 });              // default liveMs skips 'live'
    const plan = recent.find((x) => x.agentType === 'Plan');
    assert.equal(plan.runs, 2);
    assert.equal(plan.sample, 'small');
    assert.equal(plan.endedOnErrorPct, 0);
    assert.equal(recent.find((x) => x.agentType === 'unknown').runs, 1);
    assert.equal(plan.avgCostUSD, 0);                        // no priceFor = $0, never guessed

    const all = sub.scorecard({ days: 0, liveMs: 0 });       // whole history, count the cut-off run
    const plan2 = all.find((x) => x.agentType === 'Plan');
    assert.equal(plan2.runs, 4);
    assert.equal(plan2.sample, undefined);
    assert.equal(plan2.endedOnErrorPct, 25);
    assert.deepEqual(sub.scorecard({ days: 0, dir: path.join(PROJECTS, 'nope') }), []);
  });

  test('allDirs discovers every session subagents folder under the projects root', () => {
    makeAgent({ agentId: 'a1', sessionId: 'sess-1', turns: [{ ts: T('10:00:00'), usage: { input: 1 } }] });
    makeAgent({ agentId: 'a2', sessionId: 'sess-2', turns: [{ ts: T('10:00:00'), usage: { input: 1 } }] });
    const dirs = sub.allDirs(0).slice().sort();
    assert.deepEqual(dirs, [dirOf('sess-1'), dirOf('sess-2')].sort());
    assert.equal(sub.meta('a1').dir, dirOf('sess-1'));   // found without being told the dir
  });
});
