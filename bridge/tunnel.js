'use strict';
// A public HTTPS door to the bridge for claude.ai's connector, via a cloudflared
// "quick tunnel" (no account, random *.trycloudflare.com hostname per run).
//
// claude.ai calls connectors from Anthropic's cloud, so a Tailscale address is
// not enough; the tunnel is the zero-config way to get a public URL. The URL
// changes on every start, so the Settings panel shows the current one and the
// MCP token guards it (see mcp.js).

const { spawn } = require('child_process');
const { execFile } = require('child_process');

const WIN = process.platform === 'win32';
let child = null;
let state = { running: false, url: '', startedAt: 0, error: '', log: [] };

function status() { return { running: state.running, url: state.url, startedAt: state.startedAt, error: state.error, bin: binName() }; }
function binName() { return process.env.GANDER_CLOUDFLARED || 'cloudflared'; }

// Is cloudflared on PATH? -> cb(version | '')
function installed(cb) {
  try {
    execFile(binName(), ['--version'], { timeout: 8000, windowsHide: true, shell: WIN }, (err, stdout) => cb(err ? '' : String(stdout || '').trim().split('\n')[0]));
  } catch (_) { cb(''); }
}

function start(port, cb) {
  if (child) return cb(null, status());
  state = { running: true, url: '', startedAt: Date.now(), error: '', log: [] };
  let proc;
  try {
    proc = spawn(binName(), ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: WIN });
  } catch (e) {
    state = { running: false, url: '', startedAt: 0, error: e.message, log: [] };
    return cb(null, status());
  }
  child = proc;
  let answered = false;
  const onLine = (chunk) => {
    const text = String(chunk);
    state.log.push(text); if (state.log.length > 40) state.log.shift();
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
    if (m && !state.url) { state.url = m[0]; if (!answered) { answered = true; cb(null, status()); } }
  };
  proc.stdout.on('data', onLine);
  proc.stderr.on('data', onLine);
  proc.on('error', (e) => { state.error = e.message; state.running = false; child = null; if (!answered) { answered = true; cb(null, status()); } });
  proc.on('exit', (code) => {
    state.running = false; child = null;
    if (!state.url && !state.error) state.error = `cloudflared exited (${code}): ${state.log.slice(-3).join(' ').replace(/\s+/g, ' ').slice(0, 200)}`;
    if (!answered) { answered = true; cb(null, status()); }
  });
  setTimeout(() => { if (!answered) { answered = true; if (!state.url) state.error = 'no tunnel URL after 25 s: ' + state.log.slice(-2).join(' ').replace(/\s+/g, ' ').slice(0, 200); cb(null, status()); } }, 25000);
}

function stop(cb) {
  if (!child) { state.running = false; state.url = ''; return cb && cb(null, status()); }
  const p = child; child = null;
  try { p.kill(); } catch (_) {}
  if (WIN) { try { execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch (_) {} }
  state = { running: false, url: '', startedAt: 0, error: '', log: [] };
  if (cb) cb(null, status());
}

function installHint() {
  if (WIN) return 'winget install Cloudflare.cloudflared   (or: choco install cloudflared)';
  if (process.platform === 'darwin') return 'brew install cloudflared';
  return 'see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

module.exports = { status, installed, start, stop, installHint };
