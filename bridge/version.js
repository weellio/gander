'use strict';
// Is the Claude Code CLI that Gander launches out of date?
//
// Gander runs sessions with whatever `claudeCmd` points at. That can drift from
// the copy VS Code ships (which updates itself), and a stale CLI silently misses
// newer hook events — so the dashboard checks and offers a one-click update.
//
//   current(cli)  ->  `claude --version`  ->  "2.1.261 (Claude Code)"  ->  2.1.261
//   latest()      ->  registry.npmjs.org/@anthropic-ai/claude-code/latest
//   update(cli)   ->  `claude update`     (the CLI's own self-updater)
//
// The registry call is cached and fails silently: offline must never break the
// dashboard, it just means "unknown", never a false "you are out of date".

const { execFile } = require('child_process');
const https = require('https');

// With shell:true (needed on Windows for .cmd/.ps1 shims) Node does NOT quote the
// command, so a path like C:\Program Files\...\claude.exe splits at the space and
// the call fails silently — version reads as unknown and the update button never
// appears. Quote it ourselves.
const WIN = process.platform === 'win32';
const shellSafe = (c) => (WIN && /\s/.test(c) && !/^".*"$/.test(c) ? '"' + c + '"' : c);

const REGISTRY = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const LATEST_TTL_MS = 6 * 3600e3;   // the CLI ships a few times a day; 6h is plenty

// "2.1.261 (Claude Code)" -> "2.1.261"   ·  anything unparseable -> ''
function parseVersion(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m[0] : '';
}

// -1 if a < b, 0 if equal, 1 if a > b. Missing parts count as 0.
function cmp(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Only ever true when BOTH versions are known — never nag on a failed lookup.
function isBehind(current, latest) {
  if (!parseVersion(current) || !parseVersion(latest)) return false;
  return cmp(current, latest) < 0;
}

function currentVersion(cli, cb) {
  try {
    execFile(shellSafe(String(cli || 'claude')), ['--version'], { timeout: 8000, windowsHide: true, shell: WIN }, (err, stdout) => {
      if (err) return cb(null, '');
      cb(null, parseVersion(stdout));
    });
  } catch (_) { cb(null, ''); }
}

let latestCache = { at: 0, version: '' };
function latestVersion(cb, opts = {}) {
  const ttl = opts.ttlMs === undefined ? LATEST_TTL_MS : opts.ttlMs;
  if (latestCache.version && Date.now() - latestCache.at < ttl) return cb(null, latestCache.version);
  let done = false;
  const finish = (v) => { if (done) return; done = true; if (v) latestCache = { at: Date.now(), version: v }; cb(null, v || latestCache.version || ''); };
  try {
    const rq = https.get(REGISTRY, { timeout: 6000, headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(''); }
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 400000) rq.destroy(); });
      res.on('end', () => { try { finish(parseVersion(JSON.parse(body).version)); } catch (_) { finish(''); } });
    });
    rq.on('error', () => finish(''));
    rq.on('timeout', () => { rq.destroy(); finish(''); });
  } catch (_) { finish(''); }
}

// { cmd, current, latest, behind, checkedAt } — `behind` drives the update button
function check(cli, cb, opts = {}) {
  currentVersion(cli, (_e, cur) => {
    latestVersion((_e2, lat) => {
      cb(null, { cmd: String(cli || 'claude'), current: cur, latest: lat, behind: isBehind(cur, lat), checkedAt: Date.now() });
    }, opts);
  });
}

// Runs the CLI's own updater. Slow (downloads a build), so give it room.
function update(cli, cb) {
  try {
    execFile(shellSafe(String(cli || 'claude')), ['update'], { timeout: 5 * 60e3, windowsHide: true, shell: WIN, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const output = String(stdout || '') + String(stderr || '');
      latestCache = { at: 0, version: '' };                       // re-check after an update
      if (err && !output.trim()) return cb(null, { ok: false, error: err.message, output: '' });
      cb(null, { ok: !err, output: output.trim().slice(-4000), error: err ? err.message : undefined });
    });
  } catch (e) { cb(null, { ok: false, error: e.message, output: '' }); }
}

module.exports = { parseVersion, cmp, isBehind, currentVersion, latestVersion, check, update, _resetCache: () => { latestCache = { at: 0, version: '' }; } };
