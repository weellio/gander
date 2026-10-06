'use strict';
// test/replayclip.test.js — tests for bridge/replayclip.js (pure: feeds
// hand-built replay.build()-shaped objects, never touches ~/.claude).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { renderClip, _test } = require('../bridge/replayclip.js');

const T0 = Date.parse('2026-07-08T10:00:00.000Z');

function ev(t, kind, state, label, tokens = 0, costUSD = 0) {
  return { t, ts: new Date(T0 + t).toISOString(), kind, state, label, tokens, costUSD };
}

function sampleReplay(extra = {}) {
  const events = [
    ev(0, 'prompt', 'thinking', 'build the parser please'),
    ev(5_000, 'text', 'thinking', 'I will read the file first.', 1200, 0.01),
    ev(9_000, 'tool', 'reading', 'Read C:\\proj\\demo\\parser.js', 2400, 0.02),
    ev(14_000, 'tool', 'reading', 'grep EVENT_PATTERNS', 3600, 0.03),
    ev(20_000, 'tool', 'coding', 'Edit C:\\proj\\demo\\parser.js', 5000, 0.05),
    ev(26_000, 'tool', 'testing', 'node --test test/parser.test.js', 6500, 0.07),
    ev(27_000, 'error', 'error', '1 test failed', 6500, 0.07),
    ev(40_000, 'tool', 'coding', 'Write C:\\proj\\demo\\fix.js', 8000, 0.09),
    ev(400_000, 'tool', 'spawning', 'review the diff', 9000, 0.1), // long idle gap before this one
    ev(410_000, 'tool', 'reading', 'TodoWrite', 9500, 0.11),
  ];
  return {
    ok: true,
    sessionId: 'abc-123',
    project: 'demo',
    cwd: 'C:\\proj\\demo',
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + 410_000).toISOString(),
    durationMs: 410_000,
    totalTokens: 9500,
    totalCostUSD: 0.11,
    events,
    ...extra,
  };
}

/** Pull the embedded data JSON back out of a rendered page. */
function dataOf(html) {
  const m = /<script type="application\/json" id="clip-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'data block present');
  return JSON.parse(m[1]);
}

describe('replayclip.renderClip()', () => {
  test('returns a complete HTML document', () => {
    const html = renderClip(sampleReplay(), { title: 'Parser rewrite', seconds: 20 });
    assert.equal(typeof html, 'string');
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html[^>]*>/);
    assert.match(html, /<head>[\s\S]*<\/head>/);
    assert.match(html, /<body>[\s\S]*<\/body>\s*<\/html>\s*$/);
    assert.match(html, /<title>Parser rewrite · Gander replay<\/title>/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /default-src 'none'/);
  });

  test('references no external http(s) resources', () => {
    const html = renderClip(sampleReplay(), { title: 'x' });
    assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i);
    assert.doesNotMatch(html, /url\(\s*["']?\s*(?:https?:)?\/\//i);
    assert.doesNotMatch(html, /@import/i);
    assert.doesNotMatch(html, /<link\b/i);
  });

  test('session text cannot break out of the page', () => {
    const evil = '</script><script>alert(1)</script><!-- x';
    const r = sampleReplay();
    r.events.push(ev(420_000, 'tool', 'coding', 'echo "' + evil + '"', 9600, 0.12));
    r.events.push(ev(421_000, 'prompt', 'thinking', '<img src=x onerror=alert(2)>'));
    const html = renderClip(r, { title: evil, project: '<b>proj</b>' });

    assert.ok(!html.includes('<script>alert(1)'), 'no injected script tag');
    assert.ok(!html.includes('<img src=x'), 'no injected img tag');
    assert.ok(!html.includes('<!--'), 'no comment opener anywhere');
    assert.ok(!html.includes('<b>proj</b>'), 'project escaped');
    // exactly our two script elements open and close
    assert.equal((html.match(/<script\b/gi) || []).length, 2);
    assert.equal((html.match(/<\/script/gi) || []).length, 2);
    // the escaped title is in <title>/<h1>, and the raw text survives in the data
    assert.ok(html.includes('&lt;/script&gt;&lt;script&gt;alert(1)'));
    const data = dataOf(html);
    assert.equal(data.title, evil);
    assert.ok(data.ev.some((e) => e[4].includes(evil)), 'detail round-trips intact');
  });

  test('data JSON parses back with the expected shape', () => {
    const html = renderClip(sampleReplay(), { title: 'Parser rewrite', theme: 'light' });
    const d = dataOf(html);
    assert.equal(d.empty, false);
    assert.equal(d.title, 'Parser rewrite');
    assert.equal(d.project, 'demo');
    assert.equal(d.theme, 'light');
    assert.match(html, /<html lang="en" data-theme="light">/);
    assert.equal(d.durationMs, 410_000);
    assert.equal(d.ev.length, 10);
    assert.equal(d.totals.tools, 7);
    assert.equal(d.totals.errors, 1);
    assert.equal(d.totals.prompts, 1);
    assert.equal(d.totals.files, 2);        // parser.js + fix.js
    assert.equal(d.totals.filesEdited, 2);
    assert.equal(d.totals.tokens, 9500);
    assert.equal(d.totals.cost, 0.11);
    // positions are monotonic in [0,1]; segments tile the whole reel and end on "done"
    for (let i = 1; i < d.ev.length; i++) assert.ok(d.ev[i][0] >= d.ev[i - 1][0]);
    assert.ok(d.ev.every((e) => e[0] >= 0 && e[0] <= 1));
    assert.equal(d.segs[0][0], 0);
    assert.equal(d.segs[d.segs.length - 1][1], 1);
    assert.equal(d.states[d.segs[d.segs.length - 1][2]], 'done');
    // the 6-minute gap became an idle segment; grep became "searching"
    const segStates = d.segs.map((s) => d.states[s[2]]);
    assert.ok(segStates.includes('idle'));
    assert.ok(segStates.includes('searching'));
    assert.ok(d.activeMs < d.durationMs);
    // tool names are recovered from labels
    const tools = d.ev.map((e) => e[3]);
    assert.deepEqual(tools, ['Prompt', 'Claude', 'Read', 'Grep', 'Edit', 'Bash', 'Error', 'Write', 'Task', 'TodoWrite']);
    assert.equal(d.ev[2][4], 'parser.js', 'paths under the session cwd are shown relative');
  });

  test('empty, failed and tiny timelines render a clean frame', () => {
    for (const r of [
      { ok: true, project: 'p', events: [], durationMs: 0, totalTokens: 0, totalCostUSD: 0 },
      { ok: false, error: 'session not found' },
      null,
      undefined,
    ]) {
      const html = renderClip(r);
      assert.match(html, /^<!doctype html>/i);
      assert.match(html, /Nothing to replay/);
      const d = dataOf(html);
      assert.equal(d.empty, true);
      assert.deepEqual(d.ev, []);
    }
    assert.equal(dataOf(renderClip({ ok: false, error: 'session not found' })).reason, 'session not found');

    const one = dataOf(renderClip({ ok: true, events: [ev(0, 'prompt', 'thinking', 'hi')], durationMs: 0 }));
    assert.equal(one.empty, false);
    assert.equal(one.ev.length, 1);
    assert.ok(one.segs.length >= 2 && one.segs[one.segs.length - 1][1] === 1);

    // identical timestamps: still spread across the reel
    const same = dataOf(renderClip({ ok: true, events: [ev(0, 'tool', 'coding', 'ls'), ev(0, 'tool', 'reading', 'Read a'), ev(0, 'tool', 'coding', 'Edit a')] }));
    assert.ok(same.ev[2][0] > same.ev[0][0]);
  });

  test('event cap is respected and every state change is kept', () => {
    const events = [];
    for (let i = 0; i < 6000; i++) {
      // state changes only every 10 events → 600 changes, all must survive
      const st = Math.floor(i / 10) % 2 ? 'coding' : 'reading';
      events.push(ev(i * 1000, 'tool', st, st === 'coding' ? 'Edit f' + i : 'Read f' + i, i * 10, i / 1000));
    }
    const d = dataOf(renderClip({ ok: true, events, durationMs: 6_000_000, totalTokens: 60000, totalCostUSD: 6 }));
    assert.ok(d.ev.length <= 2000, 'capped at 2000, got ' + d.ev.length);
    assert.ok(d.ev.length >= 1900, 'uses the budget');
    const changes = d.ev.filter((e, i) => i > 0 && e[1] !== d.ev[i - 1][1]).length;
    assert.equal(changes, 599);
    assert.equal(d.totals.tools, 6000, 'totals count the full list');
    assert.ok(d.segs.length <= 900);

    const small = dataOf(renderClip({ ok: true, events }, { maxEvents: 50 }));
    assert.ok(small.ev.length <= 50);
  });

  test('long details are truncated to 140 chars', () => {
    const r = sampleReplay();
    r.events.push(ev(500_000, 'tool', 'coding', 'x'.repeat(1000)));
    const d = dataOf(renderClip(r, { title: 'y'.repeat(500) }));
    assert.ok(d.ev.every((e) => e[4].length <= 140));
    assert.ok(d.title.length <= 160);
  });

  test('seconds option is embedded (default 30, clamped)', () => {
    assert.equal(dataOf(renderClip(sampleReplay(), { seconds: 45 })).seconds, 45);
    assert.equal(dataOf(renderClip(sampleReplay())).seconds, 30);
    assert.equal(dataOf(renderClip(sampleReplay(), { seconds: 'abc' })).seconds, 30);
    assert.equal(dataOf(renderClip(sampleReplay(), { seconds: 99999 })).seconds, 3600);
    // the client honours ?seconds= and ?t= overrides
    const html = renderClip(sampleReplay());
    assert.match(html, /q\.get\('seconds'\)/);
    assert.match(html, /q\.get\('t'\)/);
  });

  test('client script parses as valid JavaScript', () => {
    const html = renderClip(sampleReplay());
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m);
    assert.doesNotThrow(() => new Function(m[1]));
  });
});

describe('replayclip internals', () => {
  test('safeJson escapes markup characters and line separators', () => {
    const s = _test.safeJson({ a: '</script><!--&\u2028' });
    assert.ok(!/[<>&\u2028]/.test(s));
    assert.deepEqual(JSON.parse(s), { a: '</script><!--&\u2028' });
  });

  test('makeShortener relativizes cwd paths and drops a leading cd', () => {
    const sh = _test.makeShortener('D:\\Files\\src\\Gander');
    assert.equal(sh('D:\\Files\\src\\Gander\\bridge\\x.js'), 'bridge\\x.js');
    assert.equal(sh('d:/files/src/gander/web/app.js'), 'web/app.js');
    assert.equal(sh('cd "D:\\Files\\src\\Gander" && node --test'), 'node --test');
    assert.equal(sh('cd /d/Files/src/Gander; git status'), 'git status');
    assert.equal(sh('cat D:\\Other\\file.txt'), 'cat D:\\Other\\file.txt');
    assert.equal(sh('D:\\Files\\src\\Gander'), 'D:\\Files\\src\\Gander', 'never empties a detail');
    assert.equal(_test.makeShortener(null)('cd x && git log'), 'git log');
    // a pre-truncated label keeps its cd rather than collapsing to "p…"
    assert.equal(_test.makeShortener(null)('cd "D:\\x" && p…'), 'cd "D:\\x" && p…');
  });

  test('sampleIndices keeps ends and fits the budget even when changes overflow it', () => {
    const states = Array.from({ length: 5000 }, (_, i) => (i % 2 ? 'a' : 'b'));
    const idx = _test.sampleIndices(states, 100);
    assert.ok(idx.length <= 100);
    assert.equal(idx[0], 0);
    assert.equal(idx[idx.length - 1], 4999);
  });
});
