'use strict';
// bridge/forensics.js — spend forensics. The analysis logic (computeWaste,
// computeProductivity) is pure, so it's tested directly without transcripts/git.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const f = require('../bridge/forensics.js');

describe('forensics — waste scan (SF3)', () => {
  test('flags files a single session re-read past the threshold', () => {
    const perSession = [
      { session: 's1', proj: 'volt', reads: { 'src/step.js': 5, 'README.md': 1 }, mcp: {} },
      { session: 's2', proj: 'nitro', reads: { 'a.js': 2 }, mcp: {} },   // below threshold
    ];
    const w = f.computeWaste(perSession, []);
    assert.equal(w.reReads.length, 1);
    assert.equal(w.reReads[0].file, 'src/step.js');
    assert.equal(w.reReads[0].reads, 5);
    assert.equal(w.reReads[0].project, 'volt');
  });

  test('re-reads are ranked by count, capped', () => {
    const perSession = [{ session: 's', proj: 'p', reads: { a: 3, b: 9, c: 4 }, mcp: {} }];
    const w = f.computeWaste(perSession, []);
    assert.deepEqual(w.reReads.map((r) => r.file), ['b', 'c', 'a']);
  });

  test('dead MCP = declared but never called anywhere', () => {
    const perSession = [
      { session: 's1', proj: 'p', reads: {}, mcp: { telegram: 4 } },
      { session: 's2', proj: 'q', reads: {}, mcp: { telegram: 1 } },
    ];
    const w = f.computeWaste(perSession, ['telegram', 'postgres', 'filesystem']);
    assert.deepEqual(w.deadMcp, ['filesystem', 'postgres'], 'telegram used, the others dead');
    assert.deepEqual(w.usedMcp, ['telegram']);
  });

  test('no declared servers → no dead MCP', () => {
    const w = f.computeWaste([{ session: 's', proj: 'p', reads: {}, mcp: { x: 1 } }], []);
    assert.deepEqual(w.deadMcp, []);
  });
});

describe('forensics — productive vs abandoned (SF1)', () => {
  const T = Date.parse('2026-09-01T12:00:00Z');
  const min = (m) => T + m * 60000;

  test('a session that shipped a commit near its last activity is productive', () => {
    const sessions = [
      { sessionId: 'a', project: 'volt', costUSD: 2.0, lastActive: min(0) },
      { sessionId: 'b', project: 'volt', costUSD: 5.0, lastActive: min(500) },   // no nearby commit
    ];
    const commits = { volt: [min(30)] };   // 30 min after session a's last activity
    const r = f.computeProductivity(sessions, commits, 90);
    assert.equal(r.productive, 1);
    assert.equal(r.abandoned, 1);
    assert.equal(r.productiveCost, 2.0);
    assert.equal(r.abandonedCost, 5.0);
    assert.equal(r.shippedPct, Math.round((2 / 7) * 100));
    assert.equal(r.abandonedTop[0].project, 'volt');
    assert.equal(r.abandonedTop[0].costUSD, 5.0);
  });

  test('zero-cost or timeless sessions are ignored', () => {
    const r = f.computeProductivity([
      { project: 'p', costUSD: 0, lastActive: min(0) },
      { project: 'p', costUSD: 3, lastActive: null },
    ], { p: [min(0)] }, 90);
    assert.equal(r.productive, 0);
    assert.equal(r.abandoned, 0);
    assert.equal(r.shippedPct, null);
  });

  test('commit outside the window does not count as shipped', () => {
    const r = f.computeProductivity([{ project: 'p', costUSD: 1, lastActive: min(0) }], { p: [min(1000)] }, 90);
    assert.equal(r.abandoned, 1);
    assert.equal(r.productive, 0);
  });
});
