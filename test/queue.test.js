'use strict';
// test/queue.test.js — tests for bridge/queue.js (the scheduler is
// dependency-injected, so nothing is spawned; state file goes to a temp dir).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.AOC_QUEUE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gander-q-')), 'queue.json');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const queue = require('../bridge/queue.js');

function mkDeps(over = {}) {
  const calls = { dispatch: [], terminal: [], stopped: [], done: [] };
  const deps = {
    now: () => over.nowMs !== undefined ? over.nowMs : 1_000_000,
    agents: () => over.agents || [],
    dispatchEnabled: () => over.dispatchEnabled !== false,
    dispatchGet: over.dispatchGet || (() => null),
    dispatchList: over.dispatchList || (() => []),
    startDispatch: (it) => { calls.dispatch.push(it.id); return over.startResult || { ok: true, key: 'k' + it.id }; },
    startTerminal: (it) => { calls.terminal.push(it.id); return over.startResult || { ok: true }; },
    stopDispatch: (sid) => calls.stopped.push(sid),
    onDone: (it) => calls.done.push({ id: it.id, status: it.status }),
  };
  return { deps, calls };
}

describe('queue', () => {
  beforeEach(() => queue._test.reset());

  test('add validates and enqueues', () => {
    assert.ok(queue.add({}).error);
    assert.ok(queue.add({ cwd: 'C:\\p\\alpha' }).error);
    const r = queue.add({ cwd: 'C:\\p\\alpha', prompt: 'do the thing' });
    assert.ok(r.ok);
    assert.equal(r.item.project, 'alpha');
    assert.equal(r.item.status, 'queued');
    assert.equal(queue.list().items.length, 1);
  });

  test('tick starts up to maxSlots tasks, one per project', () => {
    queue.setConfig({ maxSlots: 2 });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a2' });   // same project — must wait
    queue.add({ cwd: 'C:\\p\\beta', prompt: 'b1' });
    const { deps, calls } = mkDeps({});
    const r = queue.tick(deps);
    assert.equal(r.started, 2, 'two slots filled');
    assert.deepEqual(calls.dispatch.sort(), [1, 3], 'a1 and b1 started; a2 held back (same project as a1)');
    const st = Object.fromEntries(queue.list().items.map((i) => [i.id, i.status]));
    assert.equal(st[1], 'running');
    assert.equal(st[2], 'queued');
    assert.equal(st[3], 'running');
  });

  test('a busy session in the project blocks queue starts there', () => {
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    const { deps, calls } = mkDeps({ agents: [{ root: true, cwd: 'C:\\p\\alpha', state: 'coding', closed: false }] });
    queue.tick(deps);
    assert.equal(calls.dispatch.length, 0, 'held while a session is working in that repo');
    assert.equal(queue.list().items[0].status, 'queued');
  });

  test('dispatch completion: result settles the task and stops the hosted session', () => {
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    const { deps, calls } = mkDeps({
      dispatchList: () => [{ key: 'k1', sessionId: 'sid-1' }],
      dispatchGet: () => ({ busy: false, lastResult: { ok: true }, exited: false }),
    });
    queue.tick(deps);                       // starts it (runner=dispatch, key k1)
    const r2 = queue.tick(deps);            // sees the result
    assert.equal(r2.finished, 1);
    const it = queue.list().items[0];
    assert.equal(it.status, 'done');
    assert.equal(it.sessionId, 'sid-1');
    assert.deepEqual(calls.stopped, ['sid-1'], 'one-shot task session is stopped after finishing');
    assert.deepEqual(calls.done, [{ id: 1, status: 'done' }]);
  });

  test('dispatch failure marks the task failed', () => {
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    const { deps } = mkDeps({
      dispatchList: () => [{ key: 'k1', sessionId: 'sid-1' }],
      dispatchGet: () => ({ busy: false, lastResult: { ok: false }, exited: false }),
    });
    queue.tick(deps); queue.tick(deps);
    assert.equal(queue.list().items[0].status, 'failed');
  });

  test('terminal completion: launched session going idle settles the task', () => {
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    let t = 1_000_000;
    const agents = [];
    const { deps, calls } = mkDeps({ dispatchEnabled: false });
    deps.now = () => t;
    deps.agents = () => agents;
    queue.tick(deps);                                    // starts via terminal
    assert.deepEqual(calls.terminal, [1]);
    agents.push({ root: true, cwd: 'C:\\p\\alpha', state: 'coding', sessionId: 's9', createdAt: t + 5000 });
    t += 30_000; queue.tick(deps);                       // still working
    assert.equal(queue.list().items[0].status, 'running');
    agents[0].state = 'idle';
    t += 30_000; queue.tick(deps);                       // settled
    const it = queue.list().items[0];
    assert.equal(it.status, 'done');
    assert.equal(it.sessionId, 's9');
  });

  test('terminal launch that never produces a session fails after the grace period', () => {
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    let t = 1_000_000;
    const { deps } = mkDeps({ dispatchEnabled: false });
    deps.now = () => t;
    queue.tick(deps);
    t += 6 * 60 * 1000; queue.tick(deps);
    assert.equal(queue.list().items[0].status, 'failed');
    assert.match(queue.list().items[0].error, /no session appeared/);
  });

  test('cancel / retry / remove / clear-done lifecycle', () => {
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    assert.ok(queue.action(1, 'cancel').ok);
    assert.equal(queue.list().items[0].status, 'cancelled');
    assert.ok(queue.action(1, 'retry').ok);
    assert.equal(queue.list().items[0].status, 'queued');
    assert.ok(queue.action(1, 'cancel').ok);
    assert.ok(queue.action(0, 'clear-done').ok);
    assert.equal(queue.list().items.length, 0);
  });

  test('disabled queue starts nothing', () => {
    queue.setConfig({ enabled: false });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    const { deps, calls } = mkDeps({});
    queue.tick(deps);
    assert.equal(calls.dispatch.length + calls.terminal.length, 0);
    queue.setConfig({ enabled: true });
  });
});
