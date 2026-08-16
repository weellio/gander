// Slack Socket Mode — websocket frame codec (bridge/slack.js).
// The codec is what keeps the zero-dep socket honest: client frames must be
// masked, server frames arrive unmasked (but we accept both), and frames can
// arrive split across TCP chunks or several-per-chunk.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { encodeFrame, decodeFrames } = require('../bridge/slack.js');

test('text frame roundtrip (masked client frame decodes)', () => {
  const buf = encodeFrame(1, '{"envelope_id":"abc"}');
  const { frames, rest } = decodeFrames(buf);
  assert.equal(frames.length, 1);
  assert.equal(rest.length, 0);
  assert.equal(frames[0].opcode, 1);
  assert.equal(frames[0].fin, true);
  assert.equal(frames[0].payload.toString('utf8'), '{"envelope_id":"abc"}');
});

test('16-bit length frames roundtrip (>=126 bytes)', () => {
  const big = JSON.stringify({ envelope_id: 'x'.repeat(400) });
  const { frames } = decodeFrames(encodeFrame(1, big));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString('utf8'), big);
});

test('unmasked server frame decodes', () => {
  const payload = Buffer.from('{"type":"hello"}', 'utf8');
  const header = Buffer.from([0x81, payload.length]);   // FIN+text, no mask bit
  const { frames } = decodeFrames(Buffer.concat([header, payload]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString('utf8'), '{"type":"hello"}');
});

test('partial frames wait for the rest of the buffer', () => {
  const whole = encodeFrame(1, '{"type":"disconnect"}');
  const first = decodeFrames(whole.slice(0, 5));
  assert.equal(first.frames.length, 0);
  assert.equal(first.rest.length, 5);   // keeps what it has
  const second = decodeFrames(Buffer.concat([first.rest, whole.slice(5)]));
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].payload.toString('utf8'), '{"type":"disconnect"}');
});

test('multiple frames in one chunk all decode in order', () => {
  const buf = Buffer.concat([encodeFrame(1, 'one'), encodeFrame(9, 'ka'), encodeFrame(1, 'two')]);
  const { frames, rest } = decodeFrames(buf);
  assert.equal(rest.length, 0);
  assert.deepEqual(frames.map((f) => f.opcode), [1, 9, 1]);
  assert.equal(frames[0].payload.toString('utf8'), 'one');
  assert.equal(frames[2].payload.toString('utf8'), 'two');
});

test('close and ping opcodes are preserved', () => {
  assert.equal(decodeFrames(encodeFrame(8, '')).frames[0].opcode, 8);
  assert.equal(decodeFrames(encodeFrame(9, 'ka')).frames[0].opcode, 9);
  assert.equal(decodeFrames(encodeFrame(10, 'ka')).frames[0].opcode, 10);
});
