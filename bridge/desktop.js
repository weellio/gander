'use strict';
// Claude Desktop watcher — puts the Anthropic desktop app on the Gander floor.
//
// Claude Desktop keeps its conversations in the claude.ai cloud (no local
// transcript to read), but it DOES leave verifiable local traces, and this
// module watches exactly those — nothing guessed:
//   1. the app process (Claude.exe / Claude on mac) → tile present + running
//   2. its logs dir (main.log, mcp-server-*.log, cowork_vm_node.log …) —
//      an MCP log that grows means Desktop is actively calling tools
//   3. local-agent-mode-sessions/ — files appearing/growing means its
//      embedded Claude Code agent mode is working
//
// Both install layouts are supported: the classic %APPDATA%\Claude and the
// Microsoft Store (MSIX) build, whose AppData is virtualized under
// %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude (verified on a
// real Store install, v1.19367). macOS: ~/Library/Logs/Claude +
// ~/Library/Application Support/Claude.
//
// The tile is VIEW-ONLY (desktop: true): there is no reply/stop channel into
// the app, so the dashboard hides those controls. If Desktop's agent mode
// runs the embedded Claude Code with your global hooks, those sessions ALSO
// show up as normal Gander tiles — this watcher is the layer for everything
// hooks can't see.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const AGENT_ID = 'desktop:claude';
const IDLE_AFTER_MS = 90 * 1000;     // no log/session growth for this long -> idle

let timer = null;
let lastActivityMs = 0;
let lastRunning = null;              // null = unknown yet
let prevStats = null;                // file -> { size, mtime } from the previous tick
const hooks = { onEvent: () => {}, log: (...a) => console.log(...a) };

// ── discovery ────────────────────────────────────────────────────────────────
function candidates() {
  const home = os.homedir();
  const out = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'Claude'));
    // MSIX (Microsoft Store) build: virtualized AppData under Packages\Claude_*
    const pkgs = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
    try {
      for (const d of fs.readdirSync(pkgs)) {
        if (/^Claude_/i.test(d)) out.push(path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude'));
      }
    } catch (_) {}
  } else if (process.platform === 'darwin') {
    out.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  } else {
    out.push(path.join(home, '.config', 'Claude'));
  }
  return out;
}

function findDataDir() {
  for (const c of candidates()) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

// ── process detection (injectable) ───────────────────────────────────────────
function isRunningReal(cb) {
  if (process.platform === 'win32') {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Claude.exe', '/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      cb(!err && /Claude\.exe/i.test(String(stdout || '')));
    });
  } else {
    execFile('pgrep', ['-x', 'Claude'], { timeout: 8000 }, (err) => cb(!err));
  }
}

// ── log-line classifier (pure, testable) ─────────────────────────────────────
// MCP server logs are line-oriented; a tools/call line names the tool being
// invoked. Best-effort extraction — an unmatched line still counts as activity.
function describeMcpLine(line) {
  const s = String(line || '');
  const method = (/"method"\s*:\s*"([\w/.-]+)"/.exec(s) || [])[1] || '';
  if (method === 'tools/call') {
    const tool = (/"name"\s*:\s*"([\w.-]+)"/.exec(s) || [])[1] || 'tool';
    return { state: 'reading', log: 'MCP tool: ' + tool };
  }
  if (method) return { state: 'reading', log: 'MCP: ' + method };
  return { state: 'reading', log: 'MCP activity' };
}

// ── change scanner (pure given stat snapshots, testable) ─────────────────────
// prev/cur: Map<file, {size, mtime}>. Returns { activity: bool, events: [...] }
// describing what grew. Only mcp logs and agent-mode session files count as
// "working" — main.log churns with UI noise and is ignored on purpose.
function classifyChanges(prev, cur, readTail) {
  const out = { activity: false, events: [] };
  if (!prev) return out;   // first tick = baseline only
  for (const [file, st] of cur) {
    const old = prev.get(file);
    const grew = old ? st.size > old.size : st.size > 0;
    if (!grew) continue;
    const base = path.basename(file).toLowerCase();
    if (/^mcp.*\.log$/.test(base)) {
      out.activity = true;
      const tail = readTail ? readTail(file, old ? old.size : 0) : '';
      const lines = String(tail).split('\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      out.events.push(describeMcpLine(last));
    } else if (file.includes('local-agent-mode-sessions')) {
      out.activity = true;
      out.events.push({ state: 'coding', log: 'agent mode working · ' + path.basename(path.dirname(file)).slice(0, 8) });
    } else if (base === 'cowork_vm_node.log') {
      out.activity = true;
      out.events.push({ state: 'coding', log: 'cowork VM active' });
    }
  }
  // collapse to at most 2 events per tick so a burst doesn't spam the feed
  out.events = out.events.slice(0, 2);
  return out;
}

// ── stat collection ──────────────────────────────────────────────────────────
function snapshotStats(dataDir) {
  const map = new Map();
  const addDir = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) addDir(p, depth + 1); continue; }
      try { const st = fs.statSync(p); map.set(p, { size: st.size, mtime: st.mtimeMs }); } catch (_) {}
    }
  };
  addDir(path.join(dataDir, 'logs'), 0);
  addDir(path.join(dataDir, 'local-agent-mode-sessions'), 0);
  return map;
}

function readTailReal(file, fromByte) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(fromByte, size - 16384);   // never read more than the last 16KB
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

// ── the watcher loop ─────────────────────────────────────────────────────────
function emit(ev) { try { hooks.onEvent({ agentId: AGENT_ID, name: 'Claude Desktop', project: 'Claude Desktop', root: true, desktop: true, ...ev }); } catch (_) {} }

function tick(deps) {
  const dataDir = deps.findDataDir();
  if (!dataDir) return;   // not installed (anymore) — nothing to show
  deps.isRunning((running) => {
    const now = deps.now();
    if (!running) {
      if (lastRunning !== false) { emit({ cwd: dataDir, state: 'idle', closed: true, log: 'Claude Desktop closed' }); lastRunning = false; }
      prevStats = null;
      return;
    }
    const cur = deps.snapshotStats(dataDir);
    const changes = deps.classify(prevStats, cur, deps.readTail);
    prevStats = cur;
    if (lastRunning !== true) {
      emit({ cwd: dataDir, state: 'idle', log: 'Claude Desktop running' });
      lastRunning = true;
      lastActivityMs = 0;
    }
    if (changes.activity) {
      lastActivityMs = now;
      for (const e of changes.events) emit({ cwd: dataDir, ...e });
    } else if (lastActivityMs && now - lastActivityMs > IDLE_AFTER_MS) {
      emit({ cwd: dataDir, state: 'idle', log: 'quiet' });
      lastActivityMs = 0;
    }
  });
}

function defaultDeps() {
  return { findDataDir, isRunning: isRunningReal, snapshotStats, classify: classifyChanges, readTail: readTailReal, now: () => Date.now() };
}

function start(h, deps) {
  Object.assign(hooks, h || {});
  const d = { ...defaultDeps(), ...(deps || {}) };
  stop();
  const dir = d.findDataDir();
  if (!dir) return { started: false, reason: 'Claude Desktop not detected' };
  hooks.log('[desktop] watching Claude Desktop at ' + dir);
  timer = setInterval(() => tick(d), 5000);
  if (timer.unref) timer.unref();
  tick(d);
  return { started: true, dataDir: dir };
}

function stop() { if (timer) { clearInterval(timer); timer = null; } prevStats = null; lastRunning = null; lastActivityMs = 0; }

module.exports = {
  start, stop, findDataDir,
  _test: { classifyChanges, describeMcpLine, candidates, AGENT_ID },
};
