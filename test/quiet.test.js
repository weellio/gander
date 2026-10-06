'use strict';
// test/quiet.test.js — bridge/quiet.js: quiet hours.
// Dates are built in LOCAL time (new Date(y, m, d, h, min)) because quiet hours
// are wall-clock hours where the user sleeps, whatever the machine's timezone.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../bridge/quiet.js');

// October 2026: the 6th is a Tuesday, so the 9th is a Friday.
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m);
const FRI = 9, SAT = 10, SUN = 11, MON = 12;
const night = { enabled: true, start: '23:00', end: '08:00' };

describe('normalize', () => {
  test('defaults: off, 23:00-08:00, every day, runaway+danger critical, all channels muted', () => {
    const c = Q.normalize({});
    assert.equal(c.enabled, false);
    assert.equal(c.start, '23:00');
    assert.equal(c.end, '08:00');
    assert.deepEqual(c.days, [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(c.critical, ['runaway', 'danger']);
    assert.deepEqual(c.channels, Q.CHANNELS);
  });
  test('bad times fall back to the defaults; H:MM is padded', () => {
    const c = Q.normalize({ start: '25:00', end: '7pm' });
    assert.equal(c.start, '23:00');
    assert.equal(c.end, '08:00');
    assert.equal(Q.normalize({ start: '7:30' }).start, '07:30');
  });
  test('unknown kinds, channels and days are dropped', () => {
    const c = Q.normalize({ critical: ['runaway', 'nope'], channels: ['telegram', 'fax'], days: [1, 9, '2', -1] });
    assert.deepEqual(c.critical, ['runaway']);
    assert.deepEqual(c.channels, ['telegram']);
    assert.deepEqual(c.days, [1, 2]);
  });
  test('null / garbage config does not throw', () => {
    assert.equal(Q.normalize(null).enabled, false);
    assert.equal(Q.isQuiet(undefined, at(FRI, 2)), false);
  });
  test('the exported lists', () => {
    assert.deepEqual(Q.CHANNELS, ['telegram', 'slack', 'desktop', 'ambient']);
    assert.ok(Q.KINDS.includes('collision') && Q.KINDS.includes('danger') && Q.KINDS.length === 9);
  });
});

describe('isQuiet', () => {
  test('a window that wraps midnight: late evening and early morning are quiet', () => {
    assert.equal(Q.isQuiet(night, at(MON, 23, 30)), true);
    assert.equal(Q.isQuiet(night, at(MON, 2)), true);
    assert.equal(Q.isQuiet(night, at(MON, 7, 59)), true);
    assert.equal(Q.isQuiet(night, at(MON, 8, 0)), false, 'end is exclusive');
    assert.equal(Q.isQuiet(night, at(MON, 22, 59)), false);
    assert.equal(Q.isQuiet(night, at(MON, 12)), false);
  });

  test('a same-day window (13:00-15:00)', () => {
    const nap = { enabled: true, start: '13:00', end: '15:00' };
    assert.equal(Q.isQuiet(nap, at(MON, 13)), true);
    assert.equal(Q.isQuiet(nap, at(MON, 14, 59)), true);
    assert.equal(Q.isQuiet(nap, at(MON, 15)), false);
    assert.equal(Q.isQuiet(nap, at(MON, 2)), false);
  });

  test('days are the day the window STARTS: Saturday 02:00 belongs to Friday night', () => {
    const friOnly = { ...night, days: [5] };
    assert.equal(Q.isQuiet(friOnly, at(FRI, 23, 30)), true);
    assert.equal(Q.isQuiet(friOnly, at(SAT, 2)), true, 'Friday night runs into Saturday');
    assert.equal(Q.isQuiet(friOnly, at(SAT, 23, 30)), false, 'Saturday night is not ticked');
    assert.equal(Q.isQuiet(friOnly, at(FRI, 2)), false, 'Friday 02:00 is Thursday night');
    const weeknights = { ...night, days: [0, 1, 2, 3, 4] };
    assert.equal(Q.isQuiet(weeknights, at(SAT, 2)), false);
    assert.equal(Q.isQuiet(weeknights, at(MON, 2)), true, 'Monday 02:00 is Sunday night');
    assert.equal(Q.isQuiet(weeknights, at(SUN, 23, 30)), true);
  });

  test('start == end is never quiet (not "all day")', () => {
    assert.equal(Q.isQuiet({ enabled: true, start: '09:00', end: '09:00' }, at(MON, 9)), false);
    assert.equal(Q.isQuiet({ enabled: true, start: '09:00', end: '09:00' }, at(MON, 3)), false);
  });

  test('disabled is never quiet', () => {
    assert.equal(Q.isQuiet({ ...night, enabled: false }, at(MON, 2)), false);
  });

  test('accepts epoch ms as well as a Date', () => {
    assert.equal(Q.isQuiet(night, at(MON, 2).getTime()), true);
  });
});

describe('shouldDeliver', () => {
  test('outside quiet hours everything goes', () => {
    for (const ch of Q.CHANNELS) assert.equal(Q.shouldDeliver(ch, 'done', night, at(MON, 12)), true);
  });
  test('inside quiet hours a muted channel holds ordinary kinds', () => {
    assert.equal(Q.shouldDeliver('telegram', 'done', night, at(MON, 2)), false);
    assert.equal(Q.shouldDeliver('ambient', 'awaiting', night, at(MON, 2)), false);
  });
  test('critical kinds always get through (runaway bill, blocked danger)', () => {
    assert.equal(Q.shouldDeliver('telegram', 'runaway', night, at(MON, 2)), true);
    assert.equal(Q.shouldDeliver('ambient', 'danger', night, at(MON, 2)), true);
    assert.equal(Q.shouldDeliver('telegram', 'error', { ...night, critical: ['error'] }, at(MON, 2)), true);
    assert.equal(Q.shouldDeliver('telegram', 'runaway', { ...night, critical: [] }, at(MON, 2)), false, 'an explicit empty list means nothing is critical');
  });
  test('a channel the user did not mute still delivers', () => {
    const phoneOnly = { ...night, channels: ['telegram'] };
    assert.equal(Q.shouldDeliver('desktop', 'done', phoneOnly, at(MON, 2)), true);
    assert.equal(Q.shouldDeliver('telegram', 'done', phoneOnly, at(MON, 2)), false);
  });
  test('disabled delivers everything', () => {
    assert.equal(Q.shouldDeliver('telegram', 'done', { ...night, enabled: false }, at(MON, 2)), true);
  });
});
