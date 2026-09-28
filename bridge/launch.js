#!/usr/bin/env node
// Agent Ops Center — launcher (cross-platform, idempotent).
//
// Invoked by the plugin's SessionStart hook. Starts the bridge server detached
// if it isn't already running, then opens the dashboard in the default browser
// exactly once (subsequent sessions detect the running bridge and do nothing).
//
//   node bridge/launch.js          # auto port 3131 (or $AOC_PORT)
//
// Designed to return immediately so it never blocks Claude Code startup.
//
// Why there is a lock: "ping, and start one if nobody answers" is a race. When
// VS Code reopens several sessions at once they all ping in the same instant,
// all hear nothing, and all start a bridge — six sessions once left nine
// bridges running. The first launcher to create the lock file starts the bridge;
// the rest see the lock and step aside. A lock older than STALE_MS belongs to a
// launcher that died mid-start, so it is broken and taken over.

const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.AOC_PORT || 3131;
const SERVER = path.join(__dirname, 'server.js');
const URL = `http://localhost:${PORT}/`;
const STALE_MS = 20000;
const lockPath = (port) => path.join(os.tmpdir(), `gander-launch-${port}.lock`);

// A bridge that is busy booting (reading transcripts, restoring tiles) can take
// well over half a second to answer; 500ms made a live bridge look dead.
function ping(cb, timeout = 2500) {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout }, (res) => {
    res.resume();
    cb(true);
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

// true = this process owns the start; false = another launcher is on it.
function acquireLock(file, now = Date.now()) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');       // atomic: exactly one creator wins
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true;    // can't lock at all (odd tmp dir): behave as before rather than never start
      let age = Infinity;
      try { age = now - fs.statSync(file).mtimeMs; } catch (_) { continue; }   // vanished between calls: retry
      if (age < STALE_MS) return false;
      try { fs.unlinkSync(file); } catch (_) {}   // stale: the launcher that made it died mid-start
    }
  }
  return false;
}
function releaseLock(file) { try { fs.unlinkSync(file); } catch (_) {} }

function openBrowser(url) {
  if (process.env.GANDER_NO_OPEN) return;   // self-restart from the Settings drawer: the open tab reloads itself
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (_) { /* opening a browser is best-effort */ }
}

function main() {
  ping((up) => {
    if (up) process.exit(0);                  // already running (another session / project started it)
    const lock = lockPath(PORT);
    if (!acquireLock(lock)) process.exit(0);  // another launcher is starting it right now
    const child = spawn(process.execPath, [SERVER, '--port', String(PORT)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDECODE: '' },
    });
    child.unref();
    // Hold the lock until the bridge answers (or we give up), so a session that
    // starts a few seconds later sees either the lock or a live bridge — never a gap.
    const deadline = Date.now() + 15000;
    const wait = () => ping((ok) => {
      if (ok || Date.now() > deadline) { releaseLock(lock); if (ok) openBrowser(URL); process.exit(0); }
      else setTimeout(wait, 400);
    }, 1000);
    setTimeout(wait, 600);
  });
}

if (require.main === module) main();
module.exports = { acquireLock, releaseLock, lockPath, STALE_MS };
