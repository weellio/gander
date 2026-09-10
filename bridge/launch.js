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

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.AOC_PORT || 3131;
const SERVER = path.join(__dirname, 'server.js');
const URL = `http://localhost:${PORT}/`;

function ping(cb) {
  const req = http.get({ host: 'localhost', port: PORT, path: '/api/state', timeout: 500 }, (res) => {
    res.resume();
    cb(true);
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

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

ping((up) => {
  if (up) {
    // Bridge already running (another session / project started it). Done.
    process.exit(0);
  }
  const child = spawn(process.execPath, [SERVER, '--port', String(PORT)], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CLAUDECODE: '' },
  });
  child.unref();
  // Give the server a beat to bind the port, then open the dashboard once.
  setTimeout(() => { openBrowser(URL); process.exit(0); }, 900);
});
