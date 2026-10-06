'use strict';
// test/away.test.js — bridge/away.js: the "while you were away" card.
// Plain in-memory inputs shaped like the bridge's feed / agents / queue; `now`
// and `since` are fixed so nothing depends on the wall clock.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../bridge/away.js');

const MIN = 60e3;
const NOW = Date.parse('2026-10-06T08:30:00Z');
const SINCE = NOW - 6 * 60 * MIN;          // left at 02:30
const t = (minAfterSince) => SINCE + minAfterSince * MIN;

const fe = (agentId, state, at, extra) => ({ ts: at, agentId, agent: agentId, project: 'shop', sessionId: agentId.replace(/^\w+:/, ''), state, log: state, error: state === 'error', ...extra });

describe('finished', () => {
  test('explicit done, or idle after real work, counts; idle all along does not', () => {
    const r = summarize({
      since: SINCE, now: NOW,
      agents: [
        { id: 'sess:a', name: 'shop', project: 'shop', root: true, state: 'idle', goal: 'fix the cart' },
        { id: 'sess:b', name: 'blog', project: 'blog', root: true, state: 'done' },
        { id: 'sess:c', name: 'lazy', project: 'lazy', root: true, state: 'idle' },
      ],
      feed: [
        fe('sess:a', 'coding', t(10)), fe('sess:a', 'idle', t(20)),
        fe('sess:b', 'done', t(30), { project: 'blog' }),
        fe('sess:c', 'idle', t(5)), fe('sess:c', 'idle', t(50)),
      ],
    });
    assert.deepEqual(r.finished.map((f) => f.name), ['blog', 'shop'], 'newest first');
    assert.equal(r.finished[1].goal, 'fix the cart');
    assert.equal(r.finished[1].at, t(20));
  });

  test('one row per session (the latest), and sub-agents never count', () => {
    const r = summarize({
      since: SINCE, now: NOW,
      agents: [{ id: 'sess:a', name: 'shop', project: 'shop', root: true }, { id: 'agent:x', name: 'Explore', root: false }],
      feed: [
        fe('sess:a', 'coding', t(1)), fe('sess:a', 'idle', t(2)),
        fe('sess:a', 'reading', t(3)), fe('sess:a', 'idle', t(4)),
        fe('agent:x', 'coding', t(1), { sessionId: 'a' }), fe('agent:x', 'done', t(2), { sessionId: 'a' }),
      ],
    });
    assert.equal(r.finished.length, 1);
    assert.equal(r.finished[0].at, t(4));
  });

  test('error then idle is a failure, not a finish', () => {
    const r = summarize({ since: SINCE, now: NOW, feed: [fe('sess:a', 'coding', t(1)), fe('sess:a', 'error', t(2)), fe('sess:a', 'idle', t(3))] });
    assert.equal(r.finished.length, 0);
    assert.equal(r.failed.length, 1);
  });

  test('capped at 12', () => {
    const feed = [];
    for (let i = 0; i < 20; i++) feed.push(fe('sess:s' + i, 'done', t(i)));
    const r = summarize({ since: SINCE, now: NOW, feed });
    assert.equal(r.finished.length, 12);
    assert.match(r.headline, /^20 finished/, 'the headline counts everything, not just the visible rows');
  });
});

describe('failed', () => {
  test('one row per agent, latest detail wins', () => {
    const r = summarize({
      since: SINCE, now: NOW,
      feed: [
        fe('sess:a', 'error', t(1), { log: 'turn failed: first' }),
        fe('sess:a', 'error', t(2), { log: 'turn failed: second' }),
        { ts: t(3), agentId: 'budget', agent: 'budget', project: '', state: 'error', log: 'Daily spend over cap', error: true },
        fe('sess:b', 'coding', t(4)),
      ],
    });
    assert.equal(r.failed.length, 2);
    assert.equal(r.failed[1].detail, 'turn failed: second');
    assert.equal(r.failed[0].name, 'budget');
  });
});

describe('waiting', () => {
  test('live root agents in awaiting, with their question; closed and sub-agents skipped', () => {
    const r = summarize({
      since: SINCE, now: NOW,
      agents: [
        { id: 'sess:a', name: 'shop', project: 'shop', root: true, state: 'awaiting', awaitMsg: 'Allow rm -rf dist?' },
        { id: 'sess:b', name: 'gone', project: 'gone', root: true, state: 'awaiting', closed: true },
        { id: 'agent:x', name: 'Explore', root: false, state: 'awaiting' },
      ],
    });
    assert.deepEqual(r.waiting, [{ project: 'shop', name: 'shop', why: 'Allow rm -rf dist?' }]);
    assert.match(r.headline, /1 needs you/);
  });
});

describe('queue, collisions, dangers', () => {
  test('counts only what happened since, plus the current review pile', () => {
    const r = summarize({
      since: SINCE, now: NOW,
      queue: { items: [
        { id: 1, status: 'done', doneAt: t(10) },
        { id: 2, status: 'done', doneAt: SINCE - MIN },
        { id: 3, status: 'failed', doneAt: t(20), error: 'boom' },
        { id: 4, status: 'review', startedAt: t(30) },
        { id: 5, status: 'review', startedAt: SINCE - 60 * MIN },
        { id: 6, status: 'queued' },
      ] },
      collisions: [{ file: 'a.js', sessions: [], lastAt: t(5) }, { file: 'b.js', sessions: [], lastAt: SINCE - MIN }],
      dangers: [
        { at: t(1), command: 'rm -rf /', level: 'high', action: 'block' },
        { at: t(2), command: 'git push -f', level: 'medium', action: 'warn' },
        { at: SINCE - MIN, command: 'old', action: 'block' },
      ],
    });
    assert.deepEqual(r.queue, { done: 1, failed: 1, review: 1, inReview: 2 });
    assert.equal(r.collisions, 1);
    assert.equal(r.dangers, 2);
    assert.equal(r.blocked, 1);
    assert.equal(r.headline, '1 queue task done · 1 queue task failed · 2 to review · 1 command blocked · 1 risky command · 1 file collision');
  });
});

describe('since filtering and the headline', () => {
  test('feed entries before since are ignored', () => {
    const r = summarize({ since: SINCE, now: NOW, feed: [fe('sess:a', 'coding', SINCE - 5 * MIN), fe('sess:a', 'done', SINCE - MIN), fe('sess:b', 'error', SINCE - MIN)] });
    assert.equal(r.finished.length, 0);
    assert.equal(r.failed.length, 0);
    assert.equal(r.quiet, true);
  });

  test('ISO timestamps work as well as epoch ms', () => {
    const r = summarize({ since: new Date(SINCE).toISOString(), now: new Date(NOW).toISOString(), feed: [fe('sess:a', 'done', new Date(t(1)).toISOString())] });
    assert.equal(r.finished.length, 1);
    assert.equal(r.minutes, 360);
  });

  test('the example headline shape', () => {
    const r = summarize({
      since: SINCE, now: NOW,
      agents: [{ id: 'sess:w', name: 'w', project: 'w', root: true, state: 'awaiting', awaitMsg: '?' }],
      feed: [fe('sess:a', 'done', t(1)), fe('sess:b', 'done', t(2)), fe('sess:c', 'done', t(3)), fe('sess:d', 'error', t(4))],
    });
    assert.equal(r.headline, '3 finished · 1 needs you · 1 failed');
    assert.equal(r.quiet, false);
  });

  test('nothing happened: the quiet headline', () => {
    const r = summarize({ since: SINCE, now: NOW });
    assert.equal(r.quiet, true);
    assert.equal(r.headline, 'All quiet, nothing happened while you were away.');
    assert.deepEqual([r.finished, r.failed, r.waiting], [[], [], []]);
    assert.equal(r.minutes, 360);
  });

  test('no em-dashes in any user-facing string', () => {
    const r = summarize({
      since: SINCE, now: NOW,
      feed: [fe('sess:a', 'done', t(1)), fe('sess:b', 'error', t(2))],
      dangers: [{ at: t(1), action: 'block' }, { at: t(2), action: 'warn' }],
      collisions: [{ lastAt: t(3) }, { lastAt: t(4) }],
      queue: { items: [{ status: 'done', doneAt: t(1) }, { status: 'done', doneAt: t(2) }] },
    });
    assert.doesNotMatch(r.headline, /—/);
    assert.doesNotMatch(summarize({}).headline, /—/);
  });
});

describe('robustness', () => {
  test('missing or malformed inputs do not throw', () => {
    assert.doesNotThrow(() => summarize());
    assert.doesNotThrow(() => summarize(null));
    assert.doesNotThrow(() => summarize({ feed: 'nope', agents: {}, queue: [], collisions: null, dangers: [null, 1] }));
    assert.doesNotThrow(() => summarize({ feed: [null, {}, { ts: 'garbage' }], queue: { items: [null, {}] } }));
    const r = summarize({ now: NOW });
    assert.equal(r.since, NOW - 8 * 60 * MIN, 'default: a night away');
    assert.equal(r.quiet, true);
  });
});
