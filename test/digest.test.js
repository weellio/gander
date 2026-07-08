'use strict';
// test/digest.test.js — tests for bridge/digest.js (deps injected; no git/fs).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const digest = require('../bridge/digest.js');

const NOW_ISO = new Date().toISOString();
const OLD_ISO = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();

function deps(over = {}) {
  return {
    usageSummary: async () => ({
      byDay: Array.from({ length: 30 }, (_, i) => ({ date: 'd' + i, costUSD: 1, tokens: 1000 })),
    }),
    sessions: async () => [
      { project: 'alpha', cwd: 'C:\\p\\alpha', lastActive: NOW_ISO, firstPrompt: 'build the login page' },
      { project: 'alpha', cwd: 'C:\\p\\alpha', lastActive: NOW_ISO, firstPrompt: 'fix the tests' },
      { project: 'beta', cwd: 'C:\\p\\beta', lastActive: OLD_ISO, firstPrompt: 'too old to count' },
    ],
    projectPaths: () => ['C:\\p\\alpha', 'C:\\p\\gamma'],
    gitLog: async (cwd) => (/alpha/i.test(cwd)
      ? [{ hash: 'abc1234', date: '2026-07-07', subject: 'feat: login' }, { hash: 'def5678', date: '2026-07-06', subject: 'fix: tests' }]
      : null),
    ...over,
  };
}

describe('digest.build()', () => {
  test('aggregates sessions, commits, and spend within the range', async () => {
    const d = await digest.build({ days: 7 }, deps());
    assert.equal(d.days, 7);
    assert.equal(d.totals.sessions, 2, 'old session excluded');
    assert.equal(d.totals.commits, 2);
    assert.equal(d.totals.costUSD, 7, '7 days x $1');
    assert.equal(d.byDay.length, 7);
    const alpha = d.projects.find((p) => p.project === 'alpha');
    assert.ok(alpha, 'alpha present');
    assert.equal(alpha.sessions, 2);
    assert.equal(alpha.commits, 2);
    assert.deepEqual(alpha.prompts, ['build the login page', 'fix the tests']);
    assert.ok(!d.projects.find((p) => p.project === 'beta'), 'stale project dropped');
    assert.ok(!d.projects.find((p) => p.project === 'gamma'), 'no sessions + no commits = not listed');
  });

  test('a project with commits but no sessions still shows up', async () => {
    const d = await digest.build({ days: 7 }, deps({
      sessions: async () => [],
      gitLog: async (cwd) => (/gamma/i.test(cwd) ? [{ hash: 'x', date: '2026-07-07', subject: 'chore' }] : null),
    }));
    assert.equal(d.projects.length, 1);
    assert.equal(d.projects[0].project, 'gamma');
    assert.equal(d.projects[0].commits, 1);
  });

  test('clamps days into [1, 31]', async () => {
    const d = await digest.build({ days: 999 }, deps());
    assert.equal(d.days, 31);
    const d2 = await digest.build({ days: 0 }, deps());
    assert.equal(d2.days, 7, 'falsy -> default 7');
  });
});

describe('digest.toMarkdown()', () => {
  test('renders totals + per-project sections', async () => {
    const d = await digest.build({ days: 7 }, deps());
    const md = digest.toMarkdown(d);
    assert.match(md, /# Ship digest — last 7 days/);
    assert.match(md, /\*\*2\*\* sessions/);
    assert.match(md, /## alpha/);
    assert.match(md, /`abc1234` feat: login/);
    assert.match(md, /Worked on: “build the login page”/);
  });
});
