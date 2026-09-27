'use strict';
// test/lessons.test.js — bridge/lessons.js: the trend + lessons miner.
// Everything runs against throwaway transcripts under os.tmpdir(); the real
// ~/.claude and the real CLAUDE.md are never touched.

const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const L = require('../bridge/lessons.js');

const TEMPS = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-lessons-')); TEMPS.push(d); return d; }
after(() => { for (const d of TEMPS) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });
beforeEach(() => L._reset());

const DAY = 86400e3;
const NOW = Date.parse('2026-09-20T12:00:00');
const iso = (ms) => new Date(ms).toISOString();

let idSeq = 0;
// one tool call + its (optionally failing) result
function call(tool, errText, ts) {
  const id = 'toolu_' + (++idSeq);
  const lines = [JSON.stringify({ type: 'assistant', timestamp: iso(ts), cwd: 'C:\\work\\shop', message: { content: [{ type: 'tool_use', id, name: tool, input: {} }] } })];
  lines.push(JSON.stringify({ type: 'user', timestamp: iso(ts), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: errText || 'fine', ...(errText ? { is_error: true } : {}) }] } }));
  return lines;
}
const prompt = (text, ts) => JSON.stringify({ type: 'user', timestamp: iso(ts), message: { role: 'user', content: text } });

function env() {
  const dir = tmp();
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  return { dir, root, opts: { root, cachePath: path.join(dir, 'cache.json'), storePath: path.join(dir, 'store.json'), now: NOW, days: 30, home: dir } };
}
function session(e, name, lines) {
  const f = path.join(e.root, 'proj', name + '.jsonl');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

describe('picking the line that says what went wrong', () => {
  test('Python: the exception is the LAST line of a traceback, not "Traceback"', () => {
    const t = 'Traceback (most recent call last):\n  File "x.py", line 3, in <module>\n    print("→")\nUnicodeEncodeError: \'charmap\' codec can\'t encode character';
    assert.match(L.keyLine(t), /^UnicodeEncodeError/);
  });
  test('Node: skips the loader location to the actual error', () => {
    const t = "node:internal/modules/cjs/loader:1423\n  throw err;\n  ^\n\nError: Cannot find module 'D:\\x\\y.js'\n    at Module._resolveFilename";
    assert.match(L.keyLine(t), /^Error: Cannot find module/);
  });
  test('Bash: "Exit code 1" is never the signature', () => {
    assert.equal(L.keyLine('Exit code 1\nls: cannot access \'x\': No such file or directory'), "ls: cannot access 'x': No such file or directory");
  });
  test('git CRLF warnings are skipped', () => {
    assert.match(L.keyLine("warning: in the working copy of 'a.js', LF will be replaced by CRLF\nfatal: not a git repository"), /^fatal:/);
  });
});

describe('signatures group the same failure together', () => {
  test('paths, numbers and quoted values are normalised', () => {
    const a = L.signature('Read', 'File does not exist. Note: your current working directory is D:\\Files\\a.');
    const b = L.signature('Read', 'File does not exist. Note: your current working directory is d:\\Other\\b\\c.');
    assert.equal(a.sig, b.sig);
  });
  test('a URL is not mangled into a path (regression: "htt<path>")', () => {
    const s = L.signature('Bash', 'playwright._impl._errors.Error: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3199/phone.html').sig;
    assert.match(s, /<url>/);
    assert.doesNotMatch(s, /htt<path>/);
  });
  test('Bash and PowerShell failures share one signature', () => {
    assert.equal(L.signature('Bash', 'TimeoutError: Timeout 30000ms exceeded.').sig, L.signature('PowerShell', 'TimeoutError: Timeout 30000ms exceeded.').sig);
  });
  test('bash -c and eval quoting errors are one failure', () => {
    assert.equal(
      L.signature('Bash', "/usr/bin/bash: -c: line 106: unexpected EOF while looking for matching `''").sig,
      L.signature('Bash', "/usr/bin/bash: eval: line 1: unexpected EOF while looking for matching `''").sig);
  });
  test('failing tests are counted but never lesson-worthy', () => {
    assert.equal(L.signature('Bash', 'AssertionError: expected 1 to equal 2').errorish, false);
  });
  test('success text on a non-zero exit is not lesson-worthy', () => {
    assert.equal(L.signature('Bash', 'compile OK').errorish, false);
  });
});

describe('scan: trend + candidates', () => {
  test('counts prompts, corrections, tool calls and errors per day', async () => {
    const e = env();
    const d1 = NOW - 2 * DAY;
    session(e, 's1', [
      prompt('build the thing', d1),
      ...call('Edit', null, d1), ...call('Edit', '<tool_use_error>String to replace not found in file.</tool_use_error>', d1),
      prompt("it still doesn't work", d1),
    ]);
    const r = await L.scan(e.opts);
    const day = r.series.find((x) => x.date === r.series[r.series.length - 3].date);
    assert.equal(day.prompts, 2);
    assert.equal(day.corrections, 1);
    assert.equal(day.toolCalls, 2);
    assert.equal(day.toolErrors, 1);
  });

  test('a user rejecting a tool is not counted as an agent error', async () => {
    const e = env();
    session(e, 's1', call('Bash', "The user doesn't want to proceed with this tool use. The tool use was rejected", NOW - DAY));
    const r = await L.scan(e.opts);
    assert.equal(r.totals.toolErrors, 0);
    assert.equal(r.totals.toolCalls, 1);
  });

  test('a candidate needs the minimum count AND more than one session', async () => {
    const e = env();
    const err = '<tool_use_error>String to replace not found in file.</tool_use_error>';
    // 5 hits in ONE flailing session: not a pattern yet
    session(e, 's1', [0, 1, 2, 3, 4].flatMap((i) => call('Edit', err, NOW - DAY + i)));
    let r = await L.scan(e.opts);
    assert.equal(r.candidates.length, 0);
    // a second session repeats it: now it is
    session(e, 's2', call('Edit', err, NOW - DAY));
    L._reset();
    r = await L.scan(e.opts);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].count, 6);
    assert.equal(r.candidates[0].sessions, 2);
    assert.match(r.candidates[0].draft, /Read the exact lines/);
  });

  test('incremental: appended lines add once, and a half-written line is not lost', async () => {
    const e = env();
    const f = session(e, 's1', call('Bash', 'Error: boom', NOW - DAY));
    let r = await L.scan(e.opts);
    assert.equal(r.totals.toolCalls, 1);
    // append a complete call, then HALF of another (no trailing newline yet)
    const more = call('Bash', 'Error: boom', NOW - DAY);
    const half = call('Bash', 'Error: boom', NOW - DAY);
    fs.appendFileSync(f, more.join('\n') + '\n' + half[0].slice(0, 40));
    r = await L.scan(e.opts);
    assert.equal(r.totals.toolCalls, 2, 'the partial line must not be counted yet');
    // finish the line
    fs.appendFileSync(f, half[0].slice(40) + '\n' + half[1] + '\n');
    r = await L.scan(e.opts);
    assert.equal(r.totals.toolCalls, 3);
    assert.equal(r.totals.toolErrors, 3, 'nothing counted twice');
  });

  test('warm scan re-reads nothing', async () => {
    const e = env();
    session(e, 's1', call('Bash', 'Error: boom', NOW - DAY));
    await L.scan(e.opts);
    const r = await L.scan(e.opts);
    assert.equal(r.totals.parsed, 0);
  });
});

describe('promote / retire / dismiss', () => {
  test('promote appends under one marked section and keeps the rest of CLAUDE.md', async () => {
    const e = env();
    const md = path.join(e.dir, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(md), { recursive: true });
    fs.writeFileSync(md, '# Global rules\n\nBe brief.\n');
    const a = L.promote({ sig: 'Edit: x', text: 'Read before editing.', target: 'global' }, e.opts);
    const b = L.promote({ sig: 'Shell: y', text: 'Use absolute paths.', target: 'global' }, e.opts);
    assert.ok(a.ok && b.ok);
    const txt = fs.readFileSync(md, 'utf8');
    assert.ok(txt.startsWith('# Global rules\n\nBe brief.'), 'user content untouched');
    assert.equal(txt.split('## Lessons learned (Gander)').length, 2, 'exactly one section');
    assert.ok(txt.indexOf('Read before editing.') < txt.indexOf('Use absolute paths.'));
  });

  test('promoting the same signature twice is refused', () => {
    const e = env();
    assert.ok(L.promote({ sig: 'Edit: x', text: 'a', target: 'global' }, e.opts).ok);
    assert.match(L.promote({ sig: 'Edit: x', text: 'a', target: 'global' }, e.opts).error, /already/);
  });

  test('retire removes exactly its own line', () => {
    const e = env();
    const a = L.promote({ sig: 'Edit: x', text: 'Rule A.', target: 'global' }, e.opts);
    L.promote({ sig: 'Edit: y', text: 'Rule B.', target: 'global' }, e.opts);
    const r = L.retire({ id: a.lesson.id }, e.opts);
    assert.ok(r.ok && r.removed);
    const txt = fs.readFileSync(a.lesson.file, 'utf8');
    assert.doesNotMatch(txt, /Rule A\./);
    assert.match(txt, /Rule B\./);
  });

  test('a dismissed or promoted signature stops being a candidate', async () => {
    const e = env();
    const err = 'Error: Cannot find module \'x\'';
    session(e, 's1', [0, 1].flatMap((i) => call('Bash', err, NOW - DAY + i)));
    session(e, 's2', call('Bash', err, NOW - DAY));
    let r = await L.scan(e.opts);
    assert.equal(r.candidates.length, 1);
    L.dismiss({ sig: r.candidates[0].sig }, e.opts);
    r = await L.scan(e.opts);
    assert.equal(r.candidates.length, 0);
  });
});

describe('measuring a lesson', () => {
  const series = (n, calls) => Array.from({ length: n }, (_, i) => ({ date: '2026-09-' + String(i + 1).padStart(2, '0'), toolCalls: calls }));
  const lesson = { promotedAt: Date.parse('2026-09-11T12:00:00') };

  test('fewer than 3 active days after → still measuring', () => {
    const s = series(12, 100);
    assert.equal(L.measure(lesson, s, { '2026-09-05': 5 }).verdict, 'measuring');
  });
  test('rate halves or better → working', () => {
    const s = series(25, 100);
    const d = {}; for (let i = 1; i <= 10; i++) d['2026-09-' + String(i).padStart(2, '0')] = 4;
    d['2026-09-15'] = 1;
    const m = L.measure(lesson, s, d);
    assert.equal(m.verdict, 'working');
    assert.match(m.note, /down \d+%/);
  });
  test('same rate for a week after → no effect', () => {
    const s = series(25, 100);
    const d = {}; for (let i = 1; i <= 25; i++) if (i !== 11) d['2026-09-' + String(i).padStart(2, '0')] = 3;
    assert.equal(L.measure(lesson, s, d).verdict, 'no-effect');
  });
  test('a handful of hits is never called a trend (2 before, 0 after is not "down 100%")', () => {
    const s = series(25, 100);
    const m = L.measure(lesson, s, { '2026-09-03': 1, '2026-09-07': 1 });
    assert.equal(m.verdict, 'measuring');
    assert.match(m.note, /too few/);
  });
  test('idle days do not count as evidence of improvement', () => {
    // busy before, then 10 days with no tool calls at all: nothing to judge
    const s = series(25, 100).map((x) => (x.date > '2026-09-11' ? { ...x, toolCalls: 0 } : x));
    const d = { '2026-09-05': 5 };
    assert.equal(L.measure(lesson, s, d).verdict, 'measuring');
  });
});

describe('families: one mistake, many error texts', () => {
  test('four shell-quoting errors become ONE candidate measured across all of them', async () => {
    const e = env();
    session(e, 's1', [
      ...call('Bash', "/usr/bin/bash: -c: line 3: unexpected EOF while looking for matching `''", NOW - DAY),
      ...call('Bash', '/usr/bin/bash: eval: line 1: unexpected EOF while looking for matching `"\'', NOW - DAY),
    ]);
    session(e, 's2', [
      ...call('PowerShell', '  File "<string>", line 2\nSyntaxError: unterminated string literal (detected at line 2)', NOW - DAY),
      ...call('Bash', 'SyntaxError: f-string expression part cannot include a backslash', NOW - DAY),
    ]);
    const r = await L.scan(e.opts);
    assert.equal(r.candidates.length, 1, JSON.stringify(r.candidates.map((c) => c.sig)));
    const c = r.candidates[0];
    assert.equal(c.sig, 'family:shell-inline');
    assert.equal(c.count, 4);
    assert.equal(c.sessions, 2, 'a session counts once per family, not once per member');
    assert.equal(c.members.length, 4);
    assert.match(c.draft, /write it to a file/);
  });

  test('a promoted family is measured against every member', async () => {
    const e = env();
    session(e, 's1', call('Bash', 'UnicodeEncodeError: \'charmap\' codec can\'t encode character', NOW - 3 * DAY));
    session(e, 's2', call('Bash', 'UnicodeDecodeError: \'charmap\' codec can\'t decode byte 0x9d', NOW - 3 * DAY));
    session(e, 's3', call('Bash', 'UnicodeEncodeError: \'charmap\' codec can\'t encode character', NOW - 2 * DAY));
    let r = await L.scan(e.opts);
    const c = r.candidates.find((x) => x.family === 'win-encoding');
    assert.ok(c && c.count === 3);
    L.promote({ sig: c.sig, text: c.draft, target: 'global' }, { ...e.opts, now: NOW - 10 * DAY });
    r = await L.scan(e.opts);
    const l = r.lessons[0];
    assert.equal(l.spark.reduce((a, b) => a + b, 0), 3, 'both Encode and Decode hits count toward the rule');
    assert.ok(!r.candidates.some((x) => x.family === 'win-encoding'), 'promoted family stops being a candidate');
  });
});
