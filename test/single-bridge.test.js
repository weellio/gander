'use strict';
// One bridge, however many sessions start at once.
//
// Regression for a real incident: six VS Code sessions reopened together left
// NINE duplicate bridges running for two days (~400 MB). Three bugs stacked:
//   1. launch.js pinged, heard nothing, and started a bridge — a race when
//      several sessions ping in the same instant;
//   2. the installer compared hook paths case-sensitively, so "d:/…" and "D:/…"
//      were both installed and every event fired its hook twice;
//   3. a duplicate bridge that lost the port never exited — the crash guard
//      swallowed EADDRINUSE.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const TEMPS = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-one-')); TEMPS.push(d); return d; };
after(() => { for (const d of TEMPS) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });

describe('launch lock', () => {
  const { acquireLock, releaseLock, STALE_MS } = require('../bridge/launch.js');

  test('exactly one of many simultaneous launchers wins', () => {
    const f = path.join(tmp(), 'l.lock');
    const wins = Array.from({ length: 9 }, () => acquireLock(f)).filter(Boolean).length;
    assert.equal(wins, 1);
  });

  test('released lock can be taken again', () => {
    const f = path.join(tmp(), 'l.lock');
    assert.equal(acquireLock(f), true);
    releaseLock(f);
    assert.equal(acquireLock(f), true);
  });

  test('a lock left by a launcher that died is broken after STALE_MS', () => {
    const f = path.join(tmp(), 'l.lock');
    assert.equal(acquireLock(f), true);
    assert.equal(acquireLock(f, Date.now() + STALE_MS - 1000), false, 'still fresh');
    assert.equal(acquireLock(f, Date.now() + STALE_MS + 1000), true, 'stale: taken over');
  });
});

describe('installer recognises its own hooks whatever the drive-letter case', () => {
  const lib = require('../setup/lib.js');
  const flip = (s) => s.replace(/^([a-z]):/i, (m, d) => (d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase()) + ':');

  test('isOurs matches the same repo with the other drive-letter case (Windows)', { skip: process.platform !== 'win32' }, () => {
    const root = lib.ROOT.replace(/\\/g, '/');
    const g = { hooks: [{ type: 'command', command: `node "${flip(root)}/hooks/emit.js"` }] };
    assert.equal(lib.isOurs(g), true);
  });

  test('re-running install collapses a double install to one entry per event (Windows)', { skip: process.platform !== 'win32' }, () => {
    const dir = tmp();
    const sp = path.join(dir, 'settings.json');
    const root = lib.ROOT.replace(/\\/g, '/');
    const cmd = (r) => ({ hooks: [{ type: 'command', command: `node "${r}/hooks/emit.js"` }] });
    fs.writeFileSync(sp, JSON.stringify({ hooks: {
      PreToolUse: [cmd(root), cmd(flip(root)), { hooks: [{ type: 'command', command: 'echo keep-me' }] }],
    } }));
    const prev = process.env.GANDER_SETTINGS;
    process.env.GANDER_SETTINGS = sp;
    const log = console.log; console.log = () => {};
    try { lib.install({ dryRun: false, skipComponents: true }); } finally { console.log = log; if (prev === undefined) delete process.env.GANDER_SETTINGS; else process.env.GANDER_SETTINGS = prev; }
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    const cmds = s.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    assert.equal(cmds.filter((c) => /emit\.js/.test(c)).length, 1, JSON.stringify(cmds));
    assert.ok(cmds.includes('echo keep-me'), 'other hooks are never touched');
  });
});

describe('a duplicate bridge exits instead of lingering', () => {
  test('bridge started on a port that is already taken exits promptly', async () => {
    const holder = net.createServer();
    await new Promise((r) => holder.listen(0, '127.0.0.1', r));
    const port = holder.address().port;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'server.js'), '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AOC_QUEUE_FILE: path.join(tmp(), 'q.json'), GANDER_NO_OPEN: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill(); resolve('still running after 20s'); }, 20000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    holder.close();
    assert.equal(code, 0, 'expected a clean exit; output:\n' + out.slice(-600));
    assert.match(out, /already in use/);
  });
});

describe('the launcher itself', () => {
  // Regression: Claude Code kills a SessionStart hook after 10 s and takes its
  // children with it. A launcher that waited for the bridge to answer was killed
  // mid-boot — the new bridge died with it and no bridge ran at all.
  test('exits well inside the hook timeout and leaves the bridge running', async () => {
    const dir = tmp();
    const pidFile = path.join(dir, 'fake.pid');
    const fake = path.join(dir, 'fake-server.js');
    // a stand-in bridge: answers /api/state after a slow 6 s "boot" (the old launcher waited for it and took 6.6 s; it must not wait), records its pid
    fs.writeFileSync(fake, `
      const http = require('http'); const fs = require('fs');
      const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setTimeout(() => http.createServer((q, s) => s.end('{}')).listen(port, '127.0.0.1'), 6000);
    `);
    const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const t0 = Date.now();
    const launcher = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'launch.js')], {
      stdio: 'ignore', env: { ...process.env, AOC_PORT: String(port), GANDER_NO_OPEN: '1', GANDER_SERVER_JS: fake },
    });
    const code = await new Promise((r) => launcher.on('exit', r));
    const took = Date.now() - t0;
    assert.equal(code, 0);
    assert.ok(took < 5000, `launcher took ${took} ms; Claude Code kills the hook at 10 s`);
    // the bridge it started must still come up after the launcher is gone
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = await new Promise((r) => { const q = require('http').get({ host: '127.0.0.1', port, path: '/api/state', timeout: 500 }, (s) => { s.resume(); r(true); }); q.on('error', () => r(false)); q.on('timeout', () => { q.destroy(); r(false); }); });
      if (!up) await new Promise((r) => setTimeout(r, 300));
    }
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch (_) {}
    try { fs.unlinkSync(require('../bridge/launch.js').lockPath(port)); } catch (_) {}
    assert.equal(up, true, 'the bridge started by the launcher never answered');
  });
});
