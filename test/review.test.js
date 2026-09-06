// Review-before-merge: a green worktree branch is held for a human 👀 instead
// of auto-merging; Approve lands it, Request changes keeps the branch and
// queues a follow-up that carries the note.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
// state file goes to a temp dir — never the live bridge/aoc-queue.json
process.env.AOC_QUEUE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gander-rv-')), 'queue.json');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const queue = require('../bridge/queue');

function mk(gateResult, over = {}) {
  const calls = { done: [], review: [], finish: [], snap: [] };
  const deps = {
    now: () => 1_000_000,
    agents: () => [],
    dispatchEnabled: () => true,
    dispatchGet: () => ({ busy: false, lastResult: { ok: true } }),
    dispatchList: () => [{ key: 'k1', sessionId: 'S1' }],
    startDispatch: () => ({ ok: true, key: 'k1' }),
    startTerminal: () => ({ ok: true }),
    stopDispatch: () => {},
    onDone: (it) => calls.done.push({ id: it.id, status: it.status }),
    onReview: (it) => calls.review.push(it.id),
    wt: {
      start: (it) => ({ ok: true, wtPath: it.cwd + '__wt' + it.id, branch: 'gander/task-' + it.id }),
      finish: (it, opts) => { calls.finish.push(opts || null); return opts && opts.noMerge ? 'branch kept' : 'merged'; },
      snapshot: (it) => calls.snap.push(it.id),
    },
    gate: gateResult ? (it, cb) => cb(gateResult) : undefined,
    ...over,
  };
  return { deps, calls };
}
const first = () => queue.list().items.slice().sort((a, b) => a.id - b.id)[0];

describe('review before merge', () => {
  beforeEach(() => queue._test.reset());

  test('green branch is held for review: no merge, snapshot taken, onReview fires', () => {
    queue.setConfig({ maxSlots: 1, worktrees: true, testGate: true, review: true });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    const { deps, calls } = mk({ passed: true, cmd: 'npm test' });
    queue.tick(deps); queue.tick(deps);
    const it = first();
    assert.equal(it.status, 'review');
    assert.equal(it.gate, 'passed');
    assert.deepEqual(calls.finish, [], 'nothing merged yet');
    assert.deepEqual(calls.snap, [1]);
    assert.deepEqual(calls.review, [1]);
    assert.deepEqual(calls.done, [], 'not reported as finished');
    assert.equal(queue.list().review, true);
  });

  test('approve → merged + done', () => {
    queue.setConfig({ maxSlots: 1, worktrees: true, testGate: true, review: true });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    const { deps, calls } = mk({ passed: true });
    queue.tick(deps); queue.tick(deps);
    assert.ok(queue.action(1, 'approve').ok);
    queue.tick(deps);
    const it = first();
    assert.equal(it.status, 'done');
    assert.equal(it.merge, 'merged');
    assert.deepEqual(calls.finish, [null]);
    assert.deepEqual(calls.done, [{ id: 1, status: 'done' }]);
  });

  test('request changes → branch kept, task failed with the note, follow-up queued that merges the branch first', () => {
    queue.setConfig({ maxSlots: 1, worktrees: true, testGate: true, review: true });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'add the widget', doneWhen: 'widget renders' });
    const { deps, calls } = mk({ passed: true });
    queue.tick(deps); queue.tick(deps);
    assert.ok(queue.action(1, 'request-changes', { note: 'use tabs not spaces' }).ok);
    queue.tick(deps);
    const it = first();
    assert.equal(it.status, 'failed');
    assert.match(it.error, /changes requested: use tabs not spaces/);
    assert.equal(calls.finish[0] && calls.finish[0].noMerge, true, 'kept unmerged');
    assert.match(it.merge, /kept/);
    const fu = queue.list().items.find((x) => x.id === it.followUpId);
    assert.ok(fu, 'follow-up exists');
    assert.ok(fu.status === 'queued' || fu.status === 'running', 'follow-up is live (the freed slot may start it in the same tick)');
    assert.match(fu.prompt, /git merge gander\/task-1/);
    assert.match(fu.prompt, /use tabs not spaces/);
    assert.equal(fu.doneWhen, 'widget renders', 'definition of done carries over');
  });

  test('review off → green merges straight away (unchanged behaviour)', () => {
    queue.setConfig({ maxSlots: 1, worktrees: true, testGate: true, review: false });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    const { deps, calls } = mk({ passed: true });
    queue.tick(deps); queue.tick(deps);
    assert.equal(first().status, 'done');
    assert.deepEqual(calls.finish, [null]);
    assert.deepEqual(calls.review, []);
  });

  test('no test gate + review on → still held', () => {
    queue.setConfig({ maxSlots: 1, worktrees: true, testGate: false, review: true });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    const { deps, calls } = mk(null);
    queue.tick(deps); queue.tick(deps);
    assert.equal(first().status, 'review');
    assert.deepEqual(calls.finish, []);
  });

  test('a red gate is never held for review — it fails as before', () => {
    queue.setConfig({ maxSlots: 1, worktrees: true, testGate: true, review: true });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    const { deps, calls } = mk({ failed: true, output: 'boom' });
    queue.tick(deps); queue.tick(deps);
    assert.equal(first().status, 'failed');
    assert.deepEqual(calls.review, []);
    assert.equal(calls.finish[0].noMerge, true);
  });

  test('candidates are not held (they keep their branches anyway)', () => {
    queue.setConfig({ maxSlots: 1, worktrees: true, testGate: true, review: true });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1', group: 'g1', candK: 1, candN: 2 });
    const { deps, calls } = mk({ passed: true });
    queue.tick(deps); queue.tick(deps);
    assert.equal(first().status, 'done');
    assert.equal(calls.finish[0].noMerge, true);
    assert.deepEqual(calls.review, []);
  });

  test('decisions only apply to tasks in review; retry/remove refuse a held task', () => {
    queue.setConfig({ maxSlots: 1, worktrees: true, testGate: true, review: true });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    assert.ok(queue.action(1, 'approve').error);
    const { deps } = mk({ passed: true });
    queue.tick(deps); queue.tick(deps);
    assert.ok(queue.action(1, 'retry').error);
    queue.action(1, 'remove');
    assert.equal(queue.list().items.length, 1, 'held task cannot be removed');
  });

  test('a chained task waits behind a held review', () => {
    queue.setConfig({ maxSlots: 2, worktrees: true, testGate: true, review: true });
    queue.add({ cwd: 'C:\\p\\alpha', prompt: 'a1' });
    queue.add({ cwd: 'C:\\p\\beta', prompt: 'b1', afterId: 1 });
    const { deps } = mk({ passed: true });
    queue.tick(deps); queue.tick(deps); queue.tick(deps);
    const b = queue.list().items.find((x) => x.id === 2);
    assert.equal(b.status, 'queued');
    queue.action(1, 'approve'); queue.tick(deps);   // lands #1 and starts #2 in the same tick
    assert.equal(queue.list().items.find((x) => x.id === 1).status, 'done');
    assert.equal(queue.list().items.find((x) => x.id === 2).status, 'running');
  });
});
