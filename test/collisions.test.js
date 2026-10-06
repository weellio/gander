'use strict';
// test/collisions.test.js — bridge/collisions.js: two sessions, one file.
// Pure in-memory tracker: no files are read or written, and every edit carries
// its own `at`, so the window is driven by the test, not the wall clock.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { createTracker, normPath } = require('../bridge/collisions.js');

const MIN = 60e3;
const T0 = Date.parse('2026-10-06T21:00:00Z');
const FILE = 'D:\\Files\\sourcecode\\shop\\src\\cart.js';

const edit = (sessionId, at, extra) => ({ file: FILE, sessionId, project: 'shop', name: 'shop-' + sessionId, tool: 'Edit', at, ...extra });

describe('normPath', () => {
  test('backslashes, doubled slashes, ./ and trailing slash are folded', () => {
    assert.equal(normPath('D:\\Files\\\\x\\.\\y\\', 'linux'), 'D:/Files/x/y');
    assert.equal(normPath('/home/b//proj/./a.js/', 'linux'), '/home/b/proj/a.js');
  });
  test('.. is resolved but never climbs above the root', () => {
    assert.equal(normPath('D:/a/b/../c.js', 'win32'), 'd:/a/c.js');
    assert.equal(normPath('/../etc/x', 'linux'), '/etc/x');
  });
  test('win32 lowercases (D:/X and d:/x are one file); linux keeps case', () => {
    assert.equal(normPath('D:\\Files\\README.md', 'win32'), normPath('d:/files/readme.md', 'win32'));
    assert.notEqual(normPath('/srv/README.md', 'linux'), normPath('/srv/readme.md', 'linux'));
  });
  test('Git Bash /d/x is the same file as D:\\x on win32', () => {
    assert.equal(normPath('/d/Files/x.js', 'win32'), normPath('D:\\Files\\x.js', 'win32'));
  });
  test('empty input is empty', () => {
    assert.equal(normPath('', 'linux'), '');
    assert.equal(normPath(null, 'win32'), '');
  });
});

describe('detecting a collision', () => {
  test('a different session editing the same file inside the window collides', () => {
    const t = createTracker({ platform: 'win32' });
    assert.equal(t.record(edit('A', T0)), null);
    const c = t.record(edit('B', T0 + 2 * MIN));
    assert.ok(c);
    assert.equal(c.file, FILE, 'file is reported as first written');
    assert.equal(c.key, normPath(FILE, 'win32'));
    assert.deepEqual(c.sessions.map((s) => s.sessionId), ['A', 'B']);
    assert.equal(c.sessions[0].project, 'shop');
    assert.equal(c.firstAt, T0);
    assert.equal(c.lastAt, T0 + 2 * MIN);
  });

  test('one session editing a file many times never collides with itself', () => {
    const t = createTracker({ platform: 'win32' });
    for (let i = 0; i < 5; i++) assert.equal(t.record(edit('A', T0 + i * MIN)), null);
    assert.deepEqual(t.active(T0 + 5 * MIN), []);
  });

  test('case-insensitive on win32: D:\\X and d:/x collide', () => {
    const t = createTracker({ platform: 'win32' });
    t.record(edit('A', T0, { file: 'D:\\Files\\Shop\\Cart.js' }));
    assert.ok(t.record(edit('B', T0 + MIN, { file: 'd:/files/shop/cart.js' })));
  });

  test('NOT case-insensitive on linux: Cart.js and cart.js are two files', () => {
    const t = createTracker({ platform: 'linux' });
    t.record(edit('A', T0, { file: '/home/b/shop/Cart.js' }));
    assert.equal(t.record(edit('B', T0 + MIN, { file: '/home/b/shop/cart.js' })), null);
  });

  test('a collision is announced once, not on every following edit', () => {
    const t = createTracker({ platform: 'win32' });
    t.record(edit('A', T0));
    assert.ok(t.record(edit('B', T0 + MIN)));
    assert.equal(t.record(edit('A', T0 + 2 * MIN)), null);
    assert.equal(t.record(edit('B', T0 + 3 * MIN)), null);
    // but the rail still sees the latest edit time
    assert.equal(t.active(T0 + 3 * MIN)[0].lastAt, T0 + 3 * MIN);
  });

  test('a third session joining is a NEW collision', () => {
    const t = createTracker({ platform: 'win32' });
    t.record(edit('A', T0));
    t.record(edit('B', T0 + MIN));
    const c = t.record(edit('C', T0 + 2 * MIN));
    assert.ok(c);
    assert.deepEqual(c.sessions.map((s) => s.sessionId), ['A', 'B', 'C']);
    // the rail shows one row per file: the wider overlap
    const rows = t.active(T0 + 2 * MIN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessions.length, 3);
  });

  test('edits further apart than the window do not collide', () => {
    const t = createTracker({ platform: 'win32', windowMs: 15 * MIN });
    t.record(edit('A', T0));
    assert.equal(t.record(edit('B', T0 + 16 * MIN)), null);
  });

  test('after the window passes with no edit from one side, a new overlap is news again', () => {
    const t = createTracker({ platform: 'win32', windowMs: 15 * MIN });
    t.record(edit('A', T0));
    assert.ok(t.record(edit('B', T0 + MIN)));
    // A goes quiet; B keeps editing past A's window
    assert.equal(t.record(edit('B', T0 + 20 * MIN)), null);
    // A comes back: same pair, but the earlier overlap had ended
    assert.ok(t.record(edit('A', T0 + 21 * MIN)));
  });

  test('forget(session) ends its collisions', () => {
    const t = createTracker({ platform: 'win32' });
    t.record(edit('A', T0));
    t.record(edit('B', T0 + MIN));
    t.forget('B');
    assert.deepEqual(t.active(T0 + 2 * MIN), []);
    assert.equal(t.record(edit('A', T0 + 2 * MIN)), null);
  });

  test('edits without a file or session are ignored', () => {
    const t = createTracker({ platform: 'win32' });
    assert.equal(t.record({ sessionId: 'A', at: T0 }), null);
    assert.equal(t.record({ file: FILE, at: T0 }), null);
    assert.equal(t.record(null), null);
  });
});

describe('ignore list', () => {
  const both = (t, file) => { t.record(edit('A', T0, { file })); return t.record(edit('B', T0 + MIN, { file })); };

  test('generated output and logs never collide', () => {
    for (const f of [
      'D:\\p\\node_modules\\x\\index.js', 'D:\\p\\.git\\index', 'D:\\p\\dist\\app.js', 'D:\\p\\build\\out.js',
      'D:\\p\\src\\__pycache__\\a.pyc', 'D:\\p\\.next\\cache\\x', 'D:\\p\\server.log',
    ]) assert.equal(both(createTracker({ platform: 'win32' }), f), null, f);
  });

  test('temp dirs and Claude Code scratchpads never collide', () => {
    assert.equal(both(createTracker({ platform: 'win32' }), 'f:\\Temp\\claude\\proj\\scratchpad\\x.py'), null);
    assert.equal(both(createTracker({ platform: 'linux' }), '/tmp/claude/x.py'), null);
    assert.equal(both(createTracker({ platform: process.platform }), path.join(os.tmpdir(), 'gander-x', 'a.js')), null);
  });

  test('ignore EXTENDS the defaults (strings and RegExps)', () => {
    const t = () => createTracker({ platform: 'win32', ignore: ['/generated/', /\.lock$/] });
    assert.equal(both(t(), 'D:\\p\\generated\\api.ts'), null);
    assert.equal(both(t(), 'D:\\p\\package.lock'), null);
    assert.equal(both(t(), 'D:\\p\\node_modules\\x.js'), null, 'defaults still apply');
    assert.ok(both(t(), 'D:\\p\\src\\real.ts'));
  });

  test('defaultIgnore:false REPLACES the defaults with only your list', () => {
    const t = createTracker({ platform: 'win32', defaultIgnore: false, ignore: ['/generated/'] });
    assert.ok(both(t, 'D:\\p\\dist\\app.js'));
  });
});

describe('active() and memory', () => {
  test('newest first, and expired collisions drop off', () => {
    const t = createTracker({ platform: 'win32', windowMs: 15 * MIN });
    t.record(edit('A', T0, { file: 'D:\\p\\one.js' }));
    t.record(edit('B', T0 + MIN, { file: 'D:\\p\\one.js' }));
    t.record(edit('A', T0 + 5 * MIN, { file: 'D:\\p\\two.js' }));
    t.record(edit('C', T0 + 6 * MIN, { file: 'D:\\p\\two.js' }));
    const rows = t.active(T0 + 7 * MIN);
    assert.deepEqual(rows.map((r) => r.key), ['d:/p/two.js', 'd:/p/one.js']);
    assert.deepEqual(t.active(T0 + 18 * MIN).map((r) => r.key), ['d:/p/two.js']);
    assert.deepEqual(t.active(T0 + 30 * MIN), []);
  });

  test('tracked files are capped', () => {
    const t = createTracker({ platform: 'win32', maxFiles: 50 });
    for (let i = 0; i < 200; i++) t.record(edit('A', T0 + i, { file: 'D:\\p\\f' + i + '.js' }));
    assert.equal(t._size(), 50);
  });

  test('old edits are dropped as time moves on', () => {
    const t = createTracker({ platform: 'win32', windowMs: 15 * MIN });
    for (let i = 0; i < 20; i++) t.record(edit('A', T0, { file: 'D:\\p\\f' + i + '.js' }));
    t.record(edit('A', T0 + 60 * MIN, { file: 'D:\\p\\later.js' }));
    assert.equal(t._size(), 1);
  });

  test('returned collisions are copies: mutating one does not corrupt the tracker', () => {
    const t = createTracker({ platform: 'win32' });
    t.record(edit('A', T0));
    const c = t.record(edit('B', T0 + MIN));
    c.sessions.length = 0;
    assert.equal(t.active(T0 + MIN)[0].sessions.length, 2);
  });
});
