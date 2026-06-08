'use strict';
// test/usage.test.js — tests for bridge/usage.js pure-logic exports.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const usage = require('../bridge/usage.js');

// ---------------------------------------------------------------------------
// Exported surface
// ---------------------------------------------------------------------------
describe('usage exports', () => {
  test('exports PRICING, summary, and summaryAsync', () => {
    assert.ok(usage.PRICING, 'PRICING must be exported');
    assert.equal(typeof usage.summary, 'function', 'summary must be a function');
    assert.equal(typeof usage.summaryAsync, 'function', 'summaryAsync must be a function');
  });
});

// ---------------------------------------------------------------------------
// PRICING table — cost math
// ---------------------------------------------------------------------------
describe('PRICING cost math', () => {
  const P = usage.PRICING;

  test('PRICING has opus, sonnet, haiku tiers', () => {
    assert.ok(P.opus,   'missing opus tier');
    assert.ok(P.sonnet, 'missing sonnet tier');
    assert.ok(P.haiku,  'missing haiku tier');
  });

  test('each tier has input, output, cacheWrite, cacheRead rates', () => {
    for (const tier of ['opus', 'sonnet', 'haiku']) {
      const t = P[tier];
      assert.equal(typeof t.input,      'number', `${tier}.input must be a number`);
      assert.equal(typeof t.output,     'number', `${tier}.output must be a number`);
      assert.equal(typeof t.cacheWrite, 'number', `${tier}.cacheWrite must be a number`);
      assert.equal(typeof t.cacheRead,  'number', `${tier}.cacheRead must be a number`);
    }
  });

  test('sonnet cost math: 1M input tokens = $3.00', () => {
    const r = P.sonnet;
    const cost = (1_000_000 / 1e6) * r.input;
    assert.equal(cost, 3, 'sonnet 1M input tokens should cost $3');
  });

  test('sonnet cost math: 1M output tokens = $15.00', () => {
    const r = P.sonnet;
    const cost = (1_000_000 / 1e6) * r.output;
    assert.equal(cost, 15, 'sonnet 1M output tokens should cost $15');
  });

  test('opus cost math: 1M input tokens = $15.00', () => {
    const r = P.opus;
    const cost = (1_000_000 / 1e6) * r.input;
    assert.equal(cost, 15, 'opus 1M input tokens should cost $15');
  });

  test('haiku cost math: 1M input tokens = $1.00', () => {
    const r = P.haiku;
    const cost = (1_000_000 / 1e6) * r.input;
    assert.equal(cost, 1, 'haiku 1M input tokens should cost $1');
  });

  test('mixed token cost matches manual formula for sonnet', () => {
    // Reproduce the costOf() formula inline from the module source.
    const r = P.sonnet;
    const input = 10_000, output = 5_000, cacheWrite = 2_000, cacheRead = 1_000;
    const expected =
      (input / 1e6) * r.input +
      (output / 1e6) * r.output +
      (cacheWrite / 1e6) * r.cacheWrite +
      (cacheRead / 1e6) * r.cacheRead;

    // Re-run exact same formula to confirm it is algebraically consistent.
    const recomputed =
      (10_000 / 1e6) * 3 +
      (5_000  / 1e6) * 15 +
      (2_000  / 1e6) * 3.75 +
      (1_000  / 1e6) * 0.30;

    assert.ok(Math.abs(expected - recomputed) < 1e-9, 'cost formula must be consistent');
  });

  test('cacheWrite rate is 1.25x input rate for all tiers', () => {
    for (const tier of ['opus', 'sonnet', 'haiku']) {
      const t = P[tier];
      assert.ok(
        Math.abs(t.cacheWrite / t.input - 1.25) < 1e-9,
        `${tier}: cacheWrite should be 1.25x input`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// summaryAsync — shape contract
// ---------------------------------------------------------------------------
describe('summaryAsync shape', () => {
  test('resolves to an object with all documented keys', async () => {
    const result = await usage.summaryAsync();
    assert.equal(typeof result, 'object', 'summaryAsync must resolve to an object');
    assert.ok(result !== null, 'result must not be null');

    const required = ['totals', 'byProject', 'byModel', 'byDay', 'topSessions'];
    for (const key of required) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, key), `missing key: ${key}`);
    }
  });

  test('totals has numeric cost and token fields', async () => {
    const { totals } = await usage.summaryAsync();
    for (const field of ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'totalTokens', 'costUSD']) {
      assert.equal(typeof totals[field], 'number', `totals.${field} must be a number`);
    }
  });

  test('byDay always has exactly 30 entries', async () => {
    const { byDay } = await usage.summaryAsync();
    assert.ok(Array.isArray(byDay), 'byDay must be an array');
    assert.equal(byDay.length, 30, 'byDay must contain exactly 30 entries (last 30 days)');
  });

  test('byDay entries have date, costUSD, tokens fields', async () => {
    const { byDay } = await usage.summaryAsync();
    for (const entry of byDay) {
      assert.equal(typeof entry.date,    'string', 'byDay[].date must be a string');
      assert.equal(typeof entry.costUSD, 'number', 'byDay[].costUSD must be a number');
      assert.equal(typeof entry.tokens,  'number', 'byDay[].tokens must be a number');
    }
  });

  test('byProject, byModel, topSessions are arrays', async () => {
    const result = await usage.summaryAsync();
    assert.ok(Array.isArray(result.byProject),   'byProject must be an array');
    assert.ok(Array.isArray(result.byModel),     'byModel must be an array');
    assert.ok(Array.isArray(result.topSessions), 'topSessions must be an array');
  });
});

// ---------------------------------------------------------------------------
// summary() — synchronous wrapper
// ---------------------------------------------------------------------------
describe('summary() synchronous wrapper', () => {
  test('returns an object immediately (may be empty shell on first call)', () => {
    const result = usage.summary();
    assert.equal(typeof result, 'object');
    assert.ok(result !== null);
    // Must at least have the shape keys
    assert.ok('totals' in result);
    assert.ok('byDay'  in result);
  });
});
