'use strict';
// scripts/gander-statusline.js — the line is composed from Claude's stdin JSON
// plus Gander's bits; it must degrade gracefully when either side is missing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compose } = require('../scripts/gander-statusline.js');

test('full line: model · dir · ctx · cost · gander bits', () => {
  const line = compose(
    { model: { display_name: 'Fable 5.1' }, workspace: { current_dir: 'D:/x/gander' }, context_window: { used_percentage: 41.7 }, cost: { total_cost_usd: 1.234 } },
    { needsYou: 2, running: 1, queued: 3, escalations: 1, gems: 3, review: 1 }
  );
  assert.equal(line, '[Fable 5.1] · gander · ctx 42% · $1.23 · 🔔2 · 📋1▶ 3⏳ · 🙋1 · 💎3 · 👀1');
});

test('bridge down: still renders the Claude-side line', () => {
  const line = compose({ model: { display_name: 'Sonnet 5' }, workspace: { current_dir: '/p/volt' }, context_window: { used_percentage: 5 } }, null);
  assert.equal(line, '[Sonnet 5] · volt · ctx 5%');
});

test('zero counts are omitted; paused queue shows ⏸; rate limit only when hot', () => {
  const quiet = compose({ model: { display_name: 'M' } }, { needsYou: 0, running: 0, queued: 0, escalations: 0, gems: 0 });
  assert.equal(quiet, '[M]');
  const paused = compose({ model: { display_name: 'M' }, rate_limits: { five_hour: { used_percentage: 91 } } }, { queued: 2, paused: true });
  assert.equal(paused, '[M] · ⚡91% · 📋0▶ 2⏳⏸');
  const cool = compose({ model: { display_name: 'M' }, rate_limits: { five_hour: { used_percentage: 20 } } }, null);
  assert.equal(cool, '[M]');
});

test('garbage stdin yields an empty (never crashing) line', () => {
  assert.equal(compose(null, null), '');
});
