'use strict';
// scripts/gander-wrap.js — the universal put-anything-on-the-floor adapter.
// The spawning is thin; what must stay correct is the arg contract and the
// lifecycle -> Gander-state mapping (only VALID bridge states, ever).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, eventFor } = require('../scripts/gander-wrap.js');

const VALID = ['idle', 'thinking', 'coding', 'spawning', 'reading', 'error', 'testing', 'done', 'awaiting'];

test('parseArgs: flags + command split on --', () => {
  const o = parseArgs(['--name', 'Codex', '--project', 'shop', '--port', '4141', '--', 'codex', 'exec', 'fix it']);
  assert.equal(o.name, 'Codex');
  assert.equal(o.project, 'shop');
  assert.equal(o.port, 4141);
  assert.deepEqual(o.cmd, ['codex', 'exec', 'fix it']);
});

test('parseArgs: name defaults to the command basename, extension stripped', () => {
  const o = parseArgs(['--', 'C:/tools/gemini.exe', '-p', 'hi']);
  assert.equal(o.name, 'gemini');
});

test('parseArgs: no command -> empty cmd (caller exits with usage)', () => {
  assert.deepEqual(parseArgs(['--name', 'x']).cmd, []);
});

test('eventFor: lifecycle maps only onto valid bridge states', () => {
  const o = { agentId: 'wrap:x:1', name: 'x', project: 'p', cmd: ['tool', 'run'], parent: '' };
  const start = eventFor('start', o);
  assert.equal(start.state, 'thinking');
  assert.equal(start.goal, 'tool run');
  const out = eventFor('output', o, 'compiling...');
  assert.equal(out.state, 'coding');
  assert.equal(out.log, 'compiling...');
  assert.equal(eventFor('exit', o, 0).state, 'done');
  assert.equal(eventFor('exit', o, 3).state, 'error');
  for (const ev of [start, out, eventFor('exit', o, 0), eventFor('exit', o, 1)]) assert.ok(VALID.includes(ev.state), ev.state);
});

test('eventFor: parent flag nests the tile', () => {
  const o = { agentId: 'wrap:sub:2', name: 'sub', project: 'p', cmd: ['t'], parent: 'wrap:root:1' };
  assert.equal(eventFor('start', o).parentId, 'wrap:root:1');
  assert.equal(eventFor('start', { ...o, parent: '' }).parentId, undefined);
});
