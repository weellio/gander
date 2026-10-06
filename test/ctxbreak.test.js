'use strict';
// test/ctxbreak.test.js — tests for bridge/ctxbreak.js
//
// ctxbreak reads a transcript (.jsonl) and says WHAT is filling the context
// window: conversation, thinking, tool calls, tool results (per tool), injected
// context, the compact summary, and the part the transcript never shows.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ctxbreak = require('../bridge/ctxbreak.js');

// --- helpers ---------------------------------------------------------------
function writeTranscript(entries, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-ctxbreak-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, entries.map(toLine).join('') + ((opts && opts.raw) || ''), 'utf8');
  return file;
}
function appendRaw(file, s) { fs.appendFileSync(file, s, 'utf8'); }
function toLine(e) { return (typeof e === 'string' ? e : JSON.stringify(e)) + '\n'; }

let n = 0;
const uid = () => 'u' + (++n);
const ts = (m) => '2026-10-06T10:' + String(m).padStart(2, '0') + ':00.000Z';

const userText = (text, extra) => ({ type: 'user', uuid: uid(), timestamp: ts(1), message: { role: 'user', content: text }, ...extra });
const assistant = (blocks, usage, id) => ({
  type: 'assistant', uuid: uid(), timestamp: ts(2),
  message: { id: id || 'msg_' + uid(), model: 'claude-opus-5-5', role: 'assistant', content: blocks, usage },
});
const usage = (input, cw, cr) => ({ input_tokens: input, output_tokens: 50, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });
const toolUse = (id, name, input) => assistant([{ type: 'tool_use', id, name, input }], usage(1, 0, 1000));
const toolResult = (id, content) => ({ type: 'user', uuid: uid(), timestamp: ts(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const boundary = (extra) => ({ type: 'system', subtype: 'compact_boundary', uuid: uid(), timestamp: '2026-10-06T12:00:00.000Z', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 190000, ...extra } });
const summary = (text) => ({ type: 'user', uuid: uid(), isCompactSummary: true, timestamp: '2026-10-06T12:00:01.000Z', message: { role: 'user', content: text } });

const sumTokens = (b) => b.categories.reduce((a, c) => a + c.tokens, 0);
const cat = (b, key) => (b.categories.find((c) => c.key === key) || { tokens: 0 }).tokens;

beforeEach(() => { ctxbreak._reset(); });

// ---------------------------------------------------------------------------
describe('ctxbreak.breakdown() totals', () => {
  test('categories (incl. baseline) sum exactly to the real context size', () => {
    const file = writeTranscript([
      userText('please fix the parser '.repeat(50)),
      assistant([{ type: 'thinking', thinking: 'hmm '.repeat(200), signature: 'x' }, { type: 'text', text: 'On it.' }], usage(3, 2000, 15000)),
      toolUse('t1', 'Read', { file_path: 'D:/a/parser.js' }),
      toolResult('t1', 'line\n'.repeat(4000)),
      assistant([{ type: 'text', text: 'Done.' }], usage(5, 1000, 17003)),
    ]);
    const b = ctxbreak.breakdown(file);
    assert.equal(b.totalTokens, 18008, 'latest turn: input + cache write + cache read');
    assert.equal(sumTokens(b), b.totalTokens);
    assert.equal(b.maxTokens, 200000);
    assert.equal(b.pct, Math.round((18008 / 200000) * 1000) / 1000);
    assert.equal(b.estimated, true);
    assert.match(b.note, /about 4 characters per token/);
    assert.ok(cat(b, 'baseline') > 0, 'system prompt + tools make up the rest');
    assert.ok(cat(b, 'thinking') > 0);
    assert.ok(cat(b, 'conversation') > 0);
    assert.equal(b.behind, 0);
  });

  test('baseline is never negative: an overshooting estimate is scaled down to the real total', () => {
    const file = writeTranscript([
      userText('word '.repeat(20000)),                                   // ~25k tokens visible
      assistant([{ type: 'text', text: 'ok' }], usage(10, 0, 990)),      // but the API says 1000
    ]);
    const b = ctxbreak.breakdown(file);
    assert.equal(b.totalTokens, 1000);
    assert.equal(sumTokens(b), 1000);
    assert.equal(cat(b, 'baseline'), 0);
    for (const c of b.categories) assert.ok(c.tokens >= 0, c.key + ' is not negative');
  });

  test('model / maxTokens mapping', () => {
    const file = writeTranscript([assistant([{ type: 'text', text: 'hi' }], usage(1, 0, 100))]);
    assert.equal(ctxbreak.breakdown(file, { model: 'claude-opus-5-5[1m]' }).maxTokens, 1000000);
    assert.equal(ctxbreak.breakdown(file, { model: 'claude-sonnet-4-5-1m' }).maxTokens, 1000000);
    assert.equal(ctxbreak.breakdown(file, { model: 'claude-haiku-4-5' }).maxTokens, 200000);
    assert.equal(ctxbreak.breakdown(file, { maxTokens: 50000 }).maxTokens, 50000);
    assert.equal(ctxbreak.breakdown(file).maxTokens, 200000);
  });

  test('the [1m] model id from the model attachment sets a 1M window', () => {
    const file = writeTranscript([
      { type: 'attachment', uuid: uid(), timestamp: ts(0), attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } },
        rendered: [{ content: '<system-reminder>\nYou are powered by Opus.\n</system-reminder>' }] },
      assistant([{ type: 'text', text: 'hi' }], usage(1, 0, 100)),
    ]);
    assert.equal(ctxbreak.breakdown(file).maxTokens, 1000000);
  });

  test('duplicate usage lines sharing one message.id are not double counted', () => {
    const u = usage(2, 300, 9698);
    const file = writeTranscript([
      userText('go'),
      assistant([{ type: 'thinking', thinking: 'plan', signature: '' }], u, 'msg_same'),
      assistant([{ type: 'text', text: 'Here.' }], u, 'msg_same'),
      assistant([{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }], u, 'msg_same'),
    ]);
    const b = ctxbreak.breakdown(file);
    assert.equal(b.totalTokens, 10000, 'one turn of 10k, not 30k');
    assert.equal(sumTokens(b), 10000);
  });
});

// ---------------------------------------------------------------------------
describe('ctxbreak.breakdown() attribution', () => {
  test('a tool result is attributed to the right tool through tool_use_id', () => {
    const file = writeTranscript([
      assistant([
        { type: 'tool_use', id: 'tA', name: 'Grep', input: { pattern: 'foo' } },
        { type: 'tool_use', id: 'tB', name: 'Bash', input: { command: 'npm test' } },
      ], usage(1, 0, 100)),
      toolResult('tB', 'x'.repeat(8000)),
      toolResult('tA', 'y'.repeat(400)),
      toolResult('tZ', 'z'.repeat(40)),                       // no matching tool_use
      assistant([{ type: 'text', text: 'ok' }], usage(1, 0, 50000)),
    ]);
    const b = ctxbreak.breakdown(file);
    const tools = Object.fromEntries(b.byTool.map((t) => [t.tool, t.tokens]));
    assert.equal(tools.Bash, 2000);
    assert.equal(tools.Grep, 100);
    assert.equal(tools.unknown, 10);
    assert.deepEqual(b.byTool.map((t) => t.tool), ['Bash', 'Grep', 'unknown'], 'sorted biggest first');
    assert.equal(cat(b, 'toolResults'), 2110);
    assert.ok(cat(b, 'toolCalls') > 0, 'tool_use inputs count as tool calls');
  });

  test('images in tool results count as 1600 tokens each', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(500000) } };
    const file = writeTranscript([
      toolUse('s1', 'mcp__playwright__browser_take_screenshot', {}),
      toolResult('s1', [{ type: 'text', text: 'abcd' }, img, img]),
      assistant([{ type: 'text', text: 'ok' }], usage(1, 0, 100000)),
    ]);
    const b = ctxbreak.breakdown(file);
    assert.equal(b.byTool[0].tool, 'mcp__playwright__browser_take_screenshot');
    assert.equal(b.byTool[0].tokens, 3201, 'two images + 4 chars, not the base64 length');
  });

  test('biggest list is ordered biggest first, capped at 8, with details from the tool_use input', () => {
    const entries = [];
    for (let i = 1; i <= 10; i++) {
      entries.push(toolUse('r' + i, i % 2 ? 'Read' : 'Bash', i % 2 ? { file_path: 'D:/src/file' + i + '.js' } : { command: 'echo ' + i + ' '.repeat(300) + 'end' }));
      entries.push(toolResult('r' + i, 'q'.repeat(i * 400)));
    }
    entries.push(assistant([{ type: 'text', text: 'ok' }], usage(1, 0, 150000)));
    const b = ctxbreak.breakdown(writeTranscript(entries));
    assert.equal(b.biggest.length, 8);
    assert.deepEqual(b.biggest.map((x) => x.tokens), [1000, 900, 800, 700, 600, 500, 400, 300]);
    assert.deepEqual(b.biggest[0], { tool: 'Bash', detail: 'echo 10 end', tokens: 1000 }, 'whitespace collapsed');
    assert.equal(b.biggest[1].detail, 'D:/src/file9.js');
    for (const x of b.biggest) assert.ok(x.detail.length <= 120);
  });

  test('system-reminder blocks, isMeta lines and rendered attachments count as injected', () => {
    const reminder = '<system-reminder>\n' + 'CLAUDE.md rules '.repeat(100) + '\n</system-reminder>';
    const file = writeTranscript([
      userText(reminder + 'hello there'),
      { type: 'user', uuid: uid(), isMeta: true, timestamp: ts(1), message: { role: 'user', content: 'Caveat: local command output follows'.repeat(10) } },
      { type: 'attachment', uuid: uid(), timestamp: ts(1), attachment: { type: 'instructions' }, rendered: [{ content: 'M'.repeat(4000) }] },
      { type: 'attachment', uuid: uid(), timestamp: ts(1), attachment: { type: 'prompt_snapshot', systemPrompt: ['S'.repeat(90000)] } },   // never sent: not counted
      toolUse('t1', 'Read', { file_path: 'x' }),
      toolResult('t1', 'file body' + '<system-reminder>watch out</system-reminder>'),
      assistant([{ type: 'text', text: 'ok' }], usage(1, 0, 100000)),
    ]);
    const b = ctxbreak.breakdown(file);
    const expect = Math.round((reminder.length + 'Caveat: local command output follows'.length * 10 + 4000 + '<system-reminder>watch out</system-reminder>'.length) / 4);
    assert.equal(cat(b, 'injected'), expect);
    assert.equal(cat(b, 'conversation'), Math.round(('hello there'.length + 2) / 4));
    assert.equal(b.byTool[0].tokens, Math.round('file body'.length / 4), 'the reminder inside a result is not charged to the tool');
  });
});

// ---------------------------------------------------------------------------
describe('ctxbreak compaction', () => {
  test('a compact boundary resets everything before it; the summary counts as summary', () => {
    const file = writeTranscript([
      userText('old talk '.repeat(1000)),
      toolUse('old', 'Read', { file_path: 'D:/old.js' }),
      toolResult('old', 'o'.repeat(40000)),
      assistant([{ type: 'text', text: 'old answer' }], usage(1, 0, 180000)),
      boundary(),
      summary('S'.repeat(8000)),
      userText('new question'),
      assistant([{ type: 'text', text: 'new answer' }], usage(1, 4000, 20000)),
    ]);
    const b = ctxbreak.breakdown(file);
    assert.equal(b.compactions, 1);
    assert.equal(b.since, '2026-10-06T12:00:00.000Z');
    assert.equal(b.totalTokens, 24001);
    assert.equal(cat(b, 'summary'), 2000);
    assert.equal(cat(b, 'toolResults'), 0, 'the old Read result is gone');
    assert.deepEqual(b.biggest, []);
    assert.equal(sumTokens(b), b.totalTokens);
  });

  test('messages listed in preservedMessages survive the boundary', () => {
    const keepUse = toolUse('kept', 'Bash', { command: 'git log' });
    const keepRes = toolResult('kept', 'k'.repeat(4000));
    const file = writeTranscript([
      toolUse('gone', 'Read', { file_path: 'a' }),
      toolResult('gone', 'g'.repeat(9000)),
      keepUse, keepRes,
      boundary({ preservedMessages: { uuids: [keepUse.uuid, keepRes.uuid] } }),
      summary('short summary'),
      assistant([{ type: 'text', text: 'x' }], usage(1, 0, 30000)),
    ]);
    const b = ctxbreak.breakdown(file);
    assert.deepEqual(b.byTool.map((t) => [t.tool, t.tokens]), [['Bash', 1000]]);
  });

  test('before the first turn after a compaction, postTokens is the provisional total', () => {
    const file = writeTranscript([
      assistant([{ type: 'text', text: 'x' }], usage(1, 0, 190000)),
      boundary({ postTokens: 21000 }),
      summary('S'.repeat(4000)),
    ]);
    const b = ctxbreak.breakdown(file);
    assert.equal(b.totalTokens, 21000);
    assert.equal(sumTokens(b), 21000);
  });

  test('a big file skips straight to the last compaction and still counts all of them', async () => {
    // ~2 MB, boundary #1, ~18 MB, boundary #2: the parse starts 16 MB before #2,
    // so #1 is only ever seen by the byte scan
    const pad = 'p'.repeat(20000);
    const entries = [];
    for (let i = 0; i < 100; i++) { entries.push(toolUse('a' + i, 'Read', { file_path: 'f' + i })); entries.push(toolResult('a' + i, pad)); }
    entries.push(boundary());
    for (let i = 0; i < 900; i++) { entries.push(toolUse('b' + i, 'Read', { file_path: 'f' + i })); entries.push(toolResult('b' + i, pad)); }
    const last = boundary();
    last.timestamp = '2026-10-06T13:00:00.000Z';
    entries.push(last);
    entries.push(summary('S'.repeat(400)));
    entries.push(toolUse('c1', 'Grep', { pattern: 'needle' }));
    entries.push(toolResult('c1', 'n'.repeat(800)));
    entries.push(assistant([{ type: 'text', text: 'ok' }], usage(1, 0, 40000)));
    const file = writeTranscript(entries);
    assert.ok(fs.statSync(file).size > 19 * 1024 * 1024);

    const first = ctxbreak.read(file);
    assert.ok(first.behind > 0, 'a cold read of a big file is handed to the background');
    await ctxbreak.readFull(file);
    const b = ctxbreak.breakdown(file);
    assert.equal(b.behind, 0);
    assert.equal(b.compactions, 2);
    assert.equal(b.since, '2026-10-06T13:00:00.000Z');
    assert.deepEqual(b.byTool.map((t) => [t.tool, t.tokens]), [['Grep', 200]]);
    assert.equal(sumTokens(b), 40001);
  });
});

// ---------------------------------------------------------------------------
describe('ctxbreak incremental reads', () => {
  test('appending lines adds only the new content', () => {
    const file = writeTranscript([
      toolUse('i1', 'Read', { file_path: 'a' }),
      toolResult('i1', 'a'.repeat(4000)),
      assistant([{ type: 'text', text: 'ok' }], usage(1, 0, 10000)),
    ]);
    assert.equal(ctxbreak.breakdown(file).byTool[0].tokens, 1000);
    appendRaw(file, [toolUse('i2', 'Read', { file_path: 'b' }), toolResult('i2', 'b'.repeat(2000)),
      assistant([{ type: 'text', text: 'ok' }], usage(1, 0, 12000))].map(toLine).join(''));
    const b = ctxbreak.breakdown(file);
    assert.equal(b.byTool[0].tokens, 1500, 'old 1000 + new 500, the first result not re-added');
    assert.equal(b.totalTokens, 12001);
    assert.equal(b.biggest.length, 2);
  });

  test('a half-written last line is not lost, and a complete unterminated one is not double counted', () => {
    const tail = JSON.stringify(toolResult('h1', 'h'.repeat(4000)));
    const file = writeTranscript([toolUse('h1', 'Bash', { command: 'build' }), assistant([{ type: 'text', text: 'k' }], usage(1, 0, 9000))],
      { raw: tail.slice(0, 1000) });
    assert.equal(ctxbreak.breakdown(file).byTool.length, 0, 'torn line is not counted yet');
    appendRaw(file, tail.slice(1000));                      // complete, but no newline yet
    assert.equal(ctxbreak.breakdown(file).byTool[0].tokens, 1000, 'complete JSON counts already');
    assert.equal(ctxbreak.breakdown(file).byTool[0].tokens, 1000, 'reading again does not double it');
    appendRaw(file, '\n');
    assert.equal(ctxbreak.breakdown(file).byTool[0].tokens, 1000, 'its newline arriving does not double it');
  });
});

// ---------------------------------------------------------------------------
describe('ctxbreak robustness + advice', () => {
  test('an empty or missing file gives a zero breakdown without throwing', async () => {
    const empty = writeTranscript([]);
    const missing = path.join(os.tmpdir(), 'gander-ctxbreak-nope', 'missing.jsonl');
    for (const f of [empty, missing, '', null]) {
      const b = ctxbreak.breakdown(f);
      assert.equal(b.totalTokens, 0);
      assert.equal(b.pct, 0);
      assert.deepEqual(b.categories, []);
      assert.deepEqual(b.byTool, []);
      assert.deepEqual(b.biggest, []);
      assert.equal(b.advice, '');
      assert.equal(b.behind, 0);
    }
    assert.equal(ctxbreak.read(missing), null);
    assert.equal(await ctxbreak.readFull(missing), null);
  });

  test('advice names tool-result bloat, a single huge result, and a nearly full window; no em-dashes', () => {
    const file = writeTranscript([
      userText('hi'),
      toolUse('big', 'Read', { file_path: 'D:/huge \u2014 file.log' }),
      toolResult('big', 'L'.repeat(240000)),                     // 60k tokens
      toolUse('b2', 'Bash', { command: 'npm test' }),
      toolResult('b2', 'T'.repeat(80000)),
      assistant([{ type: 'text', text: 'ok' }], usage(1, 5000, 170000)),
    ]);
    const b = ctxbreak.breakdown(file);
    assert.equal(b.pct, 0.875);
    assert.match(b.advice, /^Nearly full: Claude will auto-compact soon\./);
    assert.match(b.advice, /One Read result is 34% of the context/);
    assert.ok(!/[\u2014\u2013]/.test(b.advice), 'no em or en dashes');
    for (const c of b.categories) assert.ok(!/[\u2014\u2013]/.test(c.label));
    assert.ok(!/[\u2014\u2013]/.test(b.note));

    ctxbreak._reset();
    const file2 = writeTranscript([
      toolUse('m1', 'Read', { file_path: 'a' }), toolResult('m1', 'a'.repeat(30000)),
      toolUse('m2', 'Read', { file_path: 'b' }), toolResult('m2', 'b'.repeat(30000)),
      toolUse('m3', 'Bash', { command: 'c' }), toolResult('m3', 'c'.repeat(30000)),
      toolUse('m4', 'Bash', { command: 'd' }), toolResult('m4', 'd'.repeat(30000)),
      assistant([{ type: 'text', text: 'ok' }], usage(1, 0, 90000)),
    ]);
    const b2 = ctxbreak.breakdown(file2);
    assert.match(b2.advice, /^Tool results are most of it: 4 big file reads and command outputs\. \/compact now and ask it to keep only the conclusions\.$/);
    assert.ok(!/[\u2014\u2013]/.test(b2.advice));
  });

  test('no advice when the window is still mostly empty', () => {
    const file = writeTranscript([
      toolUse('e1', 'Read', { file_path: 'a' }), toolResult('e1', 'a'.repeat(30000)),
      assistant([{ type: 'text', text: 'ok' }], usage(1, 0, 20000)),
    ]);
    assert.equal(ctxbreak.breakdown(file).advice, '');
  });
});
