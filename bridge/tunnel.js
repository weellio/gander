'use strict';
// A public HTTPS door to the bridge for claude.ai's connector, via a cloudflared
// "quick tunnel" (free, no account, a random *.trycloudflare.com hostname per run).
//
// claude.ai calls connectors from Anthropic's cloud, so a Tailscale address is
// not enough; the tunnel is the zero-config way to a public URL. Everything
// here is automatic: if cloudflared is not on PATH, the bridge downloads the
// official binary into its own bin/ folder (no package manager, no prompt),
// starts the tunnel, restarts it if it dies, and reports the current URL.
// The URL changes on every start, so the caller is told when it does.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, execFile } = require('child_process');

const WIN = process.platform === 'win32';
const BIN_DIR = path.join(__dirname, 'bin');
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

let child = null;
let state = { running: false, url: '', startedAt: 0, error: '', log: [], bin: '', installing: false, installError: '' };
let keepAlive = null;        // { port, onUrl } while auto-restart is wanted
let named = null;            // { token, hostname }: a Cloudflare named tunnel = a fixed address
let restartTimer = null;

function status() {
  return { stable: !!named, hostname: named ? named.hostname : '', running: state.running, url: state.url, startedAt: state.startedAt, error: state.error, bin: state.bin || binName(), installing: state.installing, installError: state.installError, managed: !!state.bin && state.bin.startsWith(BIN_DIR) };
}
function binName() { return process.env.GANDER_CLOUDFLARED || 'cloudflared'; }
function managedPath() { return path.join(BIN_DIR, WIN ? 'cloudflared.exe' : 'cloudflared'); }

// Which official release asset fits this machine. -> { url, archive: 'exe'|'bin'|'tgz' } or null
function downloadUrl(platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : (arch === 'x64' ? 'amd64' : (arch === 'arm' ? 'arm' : '386'));
  if (platform === 'win32') return { url: `${RELEASES}cloudflared-windows-${a}.exe`, archive: 'exe' };
  if (platform === 'darwin') return { url: `${RELEASES}cloudflared-darwin-${a}.tgz`, archive: 'tgz' };
  if (platform === 'linux') return { url: `${RELEASES}cloudflared-linux-${a}`, archive: 'bin' };
  return null;
}

// What to run: a quick tunnel (random hostname) or a named one (fixed hostname, Cloudflare token).
function spawnArgs(port, n) {
  return n && n.token ? ['tunnel', '--no-autoupdate', 'run', '--token', String(n.token)] : ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'];
}

// The URL a cloudflared log line announces, or ''.
function parseUrl(text) { const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(String(text)); return m ? m[0] : ''; }

function version(bin, cb) {
  try {
    execFile(bin, ['--version'], { timeout: 8000, windowsHide: true, shell: WIN && !/[\\/]/.test(bin) }, (err, stdout) => cb(err ? '' : String(stdout || '').trim().split('\n')[0]));
  } catch (_) { cb(''); }
}

// Is cloudflared usable? PATH first, then the bridge's own copy. -> cb(binPathOrName, versionLine)
function installed(cb) {
  version(binName(), (v) => {
    if (v) return cb(binName(), v);
    const mp = managedPath();
    if (!fs.existsSync(mp)) return cb('', '');
    version(mp, (v2) => cb(v2 ? mp : '', v2));
  });
}

function fetchTo(url, dest, cb, hops = 0) {
  if (hops > 6) return cb(new Error('too many redirects'));
  const req = https.get(url, { headers: { 'user-agent': 'gander-bridge' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return fetchTo(new URL(res.headers.location, url).toString(), dest, cb, hops + 1); }
    if (res.statusCode !== 200) { res.resume(); return cb(new Error(`download failed: HTTP ${res.statusCode}`)); }
    const out = fs.createWriteStream(dest);
    res.pipe(out);
    out.on('finish', () => out.close(() => cb(null)));
    out.on('error', cb);
  });
  req.on('error', cb);
  req.setTimeout(120000, () => { req.destroy(new Error('download timed out')); });
}

// Download the official binary into bin/ (about 40 MB). -> cb(err, binPath)
function install(cb) {
  const pick = downloadUrl();
  if (!pick) return cb(new Error(`no cloudflared build for ${process.platform}/${process.arch}`));
  state.installing = true; state.installError = '';
  try { fs.mkdirSync(BIN_DIR, { recursive: true }); } catch (_) {}
  const finalPath = managedPath();
  const tmp = finalPath + '.download';
  const done = (err) => {
    state.installing = false;
    if (err) { state.installError = err.message; try { fs.unlinkSync(tmp); } catch (_) {} return cb(err); }
    version(finalPath, (v) => {
      if (!v) { state.installError = 'downloaded file does not run'; return cb(new Error(state.installError)); }
      state.bin = finalPath;
      cb(null, finalPath, v);
    });
  };
  fetchTo(pick.url, tmp, (err) => {
    if (err) return done(err);
    try {
      if (pick.archive === 'tgz') {
        execFile('tar', ['-xzf', tmp, '-C', BIN_DIR], { windowsHide: true }, (e) => {
          try { fs.unlinkSync(tmp); } catch (_) {}
          if (e) return done(new Error('could not unpack cloudflared: ' + e.message));
          try { fs.chmodSync(finalPath, 0o755); } catch (_) {}
          done(null);
        });
        return;
      }
      fs.renameSync(tmp, finalPath);
      if (!WIN) fs.chmodSync(finalPath, 0o755);
      done(null);
    } catch (e) { done(e); }
  });
}

// Make sure a cloudflared exists, installing if needed. -> cb(err, binPath, versionLine)
function ensureInstalled(cb) {
  installed((bin, v) => {
    if (bin) { state.bin = bin; return cb(null, bin, v); }
    install(cb);
  });
}

function start(port, cb) {
  if (child) return cb(null, status());
  const bin = state.bin || binName();
  state = { ...state, running: true, url: '', startedAt: Date.now(), error: '', log: [] };
  let proc;
  const n = named && named.token && named.hostname ? named : null;
  try {
    proc = spawn(bin, spawnArgs(port, n), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: WIN && !/[\\/]/.test(bin) });
  } catch (e) {
    state.running = false; state.error = e.message;
    return cb(null, status());
  }
  child = proc;
  let answered = false;
  const answer = () => { if (!answered) { answered = true; cb(null, status()); } };
  const onLine = (chunk) => {
    const text = String(chunk);
    state.log.push(text); if (state.log.length > 40) state.log.shift();
    // a quick tunnel prints its random URL; a named one only says it registered, and its URL is the fixed hostname
    const u = n ? (/Registered tunnel connection|Connection .* registered/i.test(text) ? 'https://' + n.hostname : '') : parseUrl(text);
    if (u && !state.url) { state.url = u; if (keepAlive && keepAlive.onUrl) { try { keepAlive.onUrl(u); } catch (_) {} } answer(); }
    if (n && !state.url && /error|failed|invalid|unauthorized/i.test(text)) state.error = text.replace(/\s+/g, ' ').slice(0, 200);
  };
  proc.stdout.on('data', onLine);
  proc.stderr.on('data', onLine);
  proc.on('error', (e) => { state.error = e.message; state.running = false; child = null; answer(); scheduleRestart(); });
  proc.on('exit', (code) => {
    state.running = false; child = null;
    if (!state.url && !state.error) state.error = `cloudflared exited (${code}): ${state.log.slice(-3).join(' ').replace(/\s+/g, ' ').slice(0, 200)}`;
    state.url = '';
    answer();
    scheduleRestart();
  });
  setTimeout(() => { if (!answered) { if (!state.url) state.error = 'no tunnel URL after 25 s: ' + state.log.slice(-2).join(' ').replace(/\s+/g, ' ').slice(0, 200); answer(); } }, 25000);
}

function scheduleRestart() {
  if (!keepAlive || restartTimer) return;
  restartTimer = setTimeout(() => { restartTimer = null; if (keepAlive && !child) start(keepAlive.port, () => {}); }, 5000);
}

function stop(cb) {
  keepAlive = null;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (!child) { state.running = false; state.url = ''; return cb && cb(null, status()); }
  const p = child; child = null;
  try { p.kill(); } catch (_) {}
  if (WIN) { try { execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch (_) {} }
  state = { ...state, running: false, url: '', startedAt: 0, error: '', log: [] };
  if (cb) cb(null, status());
}

// The one-call path: install if needed, start, keep alive, report each URL. -> cb(err, status)
function connect(port, { onUrl, named: n } = {}, cb) {
  ensureInstalled((err) => {
    if (err) return cb(err, status());
    const want = n && n.token && n.hostname ? { token: String(n.token), hostname: String(n.hostname).replace(/^https?:\/\//, '').replace(/\/.*$/, '') } : null;
    const changed = JSON.stringify(want) !== JSON.stringify(named);
    named = want;
    keepAlive = { port, onUrl: onUrl || null };
    if (child && changed) {   // the kind of tunnel changed: drop the running one, start() below brings up the other
      const p = child; child = null; try { p.kill(); } catch (_) {}
      if (WIN) { try { execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch (_) {} }
      state = { ...state, running: false, url: '', error: '', log: [] };
    }
    if (child) return cb(null, status());
    start(port, (_e, st) => cb(st.url ? null : new Error(st.error || 'tunnel did not come up'), st));
  });
}

function installHint() {
  if (WIN) return 'winget install Cloudflare.cloudflared';
  if (process.platform === 'darwin') return 'brew install cloudflared';
  return 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

module.exports = { status, installed, install, ensureInstalled, start, stop, connect, installHint, downloadUrl, parseUrl, spawnArgs, managedPath, BIN_DIR };
