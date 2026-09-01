'use strict';
// bridge/board.js — the coordination board store. Pure engine (injected clock),
// so nothing here touches a running bridge or the real state file.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.AOC_BOARD_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gander-board-')), 'board.json');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const board = require('../bridge/board.js');

describe('coordination board', () => {
  let t;
  beforeEach(() => { board._test.reset(); t = 1_000_000; board.setClock(() => t); });

  test('add validates project + text, defaults type to note', () => {
    assert.ok(board.add({ text: 'x' }).error, 'no project');
    assert.ok(board.add({ project: 'volt' }).error, 'no text');
    const r = board.add({ project: 'volt', agent: 'Indexer', text: '  found the drift bug  ' });
    assert.ok(r.ok);
    assert.equal(r.entry.type, 'note');
    assert.equal(r.entry.project, 'volt');
    assert.equal(r.entry.agent, 'Indexer');
    assert.equal(r.entry.text, 'found the drift bug', 'trimmed');
  });

  test('only known types are accepted; unknown falls back to note', () => {
    assert.equal(board.add({ project: 'p', type: 'finding', text: 'a' }).entry.type, 'finding');
    assert.equal(board.add({ project: 'p', type: 'bogus', text: 'b' }).entry.type, 'note');
  });

  test('list is per-project, pinned first then newest', () => {
    board.add({ project: 'volt', text: 'first' });  t += 10;
    board.add({ project: 'nitro', text: 'other project' }); t += 10;
    const pinMe = board.add({ project: 'volt', text: 'second' }); t += 10;
    board.add({ project: 'volt', text: 'third' });
    board.action(pinMe.entry.id, 'pin');
    const l = board.list('volt');
    assert.equal(l.length, 3, 'nitro entry excluded');
    assert.equal(l[0].text, 'second', 'pinned floats to top');
    assert.equal(l[1].text, 'third', 'then newest');
    assert.equal(l[2].text, 'first');
  });

  test('list filters by type and honors limit', () => {
    board.add({ project: 'p', type: 'note', text: 'n' });
    board.add({ project: 'p', type: 'finding', text: 'f1' });
    board.add({ project: 'p', type: 'finding', text: 'f2' });
    assert.equal(board.list('p', { type: 'finding' }).length, 2);
    assert.equal(board.list('p', { limit: 1 }).length, 1);
  });

  test('per-project cap drops oldest NON-pinned, keeps pinned', () => {
    const keep = board.add({ project: 'p', text: 'pin me' });
    board.action(keep.entry.id, 'pin');
    for (let i = 0; i < board.MAX_PER_PROJECT + 25; i++) { t += 1; board.add({ project: 'p', text: 'bulk ' + i }); }
    const all = board._test.entries().filter((e) => e.project === 'p');
    assert.ok(all.length <= board.MAX_PER_PROJECT, 'capped');
    assert.ok(all.some((e) => e.id === keep.entry.id), 'pinned survived the cull');
  });

  test('escalations surface via openEscalations until resolved', () => {
    const e = board.add({ project: 'volt', type: 'escalation', agent: 'Auditor', text: 'a human should see this' });
    assert.equal(board.openEscalations().length, 1);
    board.action(e.entry.id, 'resolve');
    assert.equal(board.openEscalations().length, 0, 'resolved drops out');
    board.action(e.entry.id, 'reopen');
    assert.equal(board.openEscalations().length, 1);
  });

  test('summary counts totals, pins, and open escalations per project', () => {
    board.add({ project: 'volt', text: 'a' });
    const p = board.add({ project: 'volt', text: 'b' }); board.action(p.entry.id, 'pin');
    board.add({ project: 'volt', type: 'escalation', text: 'help' });
    board.add({ project: 'nitro', text: 'z' });
    const s = board.summary();
    const volt = s.find((x) => x.project === 'volt');
    assert.equal(volt.total, 3);
    assert.equal(volt.pinned, 1);
    assert.equal(volt.escalations, 1);
    assert.equal(volt.latest, 'help');
    assert.ok(s.find((x) => x.project === 'nitro'));
  });

  test('clear removes a whole project, leaves others', () => {
    board.add({ project: 'volt', text: 'a' });
    board.add({ project: 'nitro', text: 'b' });
    const r = board.clear('volt');
    assert.equal(r.cleared, 1);
    assert.equal(board.list('volt').length, 0);
    assert.equal(board.list('nitro').length, 1);
  });

  test('refs are numeric ids, capped and sanitized', () => {
    const r = board.add({ project: 'p', type: 'finding', text: 'builds on earlier', refs: [1, '2', 'nan', 3] });
    assert.deepEqual(r.entry.refs, [1, 2, 3]);
  });
});
