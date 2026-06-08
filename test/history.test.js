'use strict';
// test/history.test.js — tests for bridge/history.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const history = require('../bridge/history.js');

// ---------------------------------------------------------------------------
// Exported surface
// ---------------------------------------------------------------------------
describe('history exports', () => {
  test('exports a list function', () => {
    assert.equal(typeof history.list, 'function', 'list must be exported as a function');
  });
});

// ---------------------------------------------------------------------------
// list() — contract (reads real ~/.claude/projects; content is not asserted)
// ---------------------------------------------------------------------------
describe('history.list()', () => {
  test('resolves to an array without throwing', async () => {
    const sessions = await history.list({});
    assert.ok(Array.isArray(sessions), 'list() must resolve to an array');
  });

  test('respects the limit option', async () => {
    const sessions = await history.list({ limit: 3 });
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length <= 3, `expected at most 3 sessions, got ${sessions.length}`);
  });

  test('each session object has the expected shape keys when sessions exist', async () => {
    const sessions = await history.list({ limit: 5 });
    const required = ['sessionId', 'cwd', 'project', 'startedAt', 'lastActive', 'firstPrompt', 'messageCount', 'resumeCmd'];
    for (const s of sessions) {
      for (const key of required) {
        assert.ok(Object.prototype.hasOwnProperty.call(s, key), `session missing key: ${key}`);
      }
    }
  });

  test('resumeCmd contains "claude --resume"', async () => {
    const sessions = await history.list({ limit: 5 });
    for (const s of sessions) {
      assert.ok(
        typeof s.resumeCmd === 'string' && s.resumeCmd.includes('claude --resume'),
        `resumeCmd should include 'claude --resume', got: ${s.resumeCmd}`,
      );
    }
  });

  test('project filter returns only matching sessions', async () => {
    // We don't know what projects exist, so filter by an empty string (should match all)
    // and verify count <= unfiltered count.
    const all = await history.list({ limit: 50 });
    const filtered = await history.list({ limit: 50, project: '__no_such_project_xyz__' });
    assert.ok(filtered.length === 0, 'filter by non-existent project should return empty array');
    // Empty string filter matches everything
    const unfiltered = await history.list({ limit: 50, project: '' });
    assert.equal(unfiltered.length, all.length, 'empty project filter should match all sessions');
  });
});
