'use strict';
// bridge/collisions.js — two sessions editing the same file.
//
// The user runs several Claude Code sessions at once, often on the same
// project. When two of them edit the same file, the second Write lands on top
// of the first and nothing complains: each session believes its own version is
// on disk. The bridge already sees every Edit / Write / MultiEdit / NotebookEdit
// through PostToolUse (tool_input.file_path), so it can notice the overlap the
// moment it happens and warn before a whole afternoon of changes is lost.
//
// Pure: no timers, no I/O. Every edit carries its own `at`, and active() takes
// `now`, so the tests (and replay) drive the clock.

const os = require('os');

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FILES = 5000;

// ── paths ────────────────────────────────────────────────────────────────────
// The same file arrives spelled several ways: `D:\Files\x.js` from one session,
// `d:/Files/x.js` from another, `/d/Files/x.js` from a Git Bash tool. Windows
// paths are case-insensitive, so on win32 all of those are one file; on Linux
// and macOS `Readme.md` and `README.md` really are two files, so case is kept.
//
// "Absolute-ish": Claude Code always hands hooks an absolute file_path, so a
// relative one is normalised as written and never resolved against the
// BRIDGE's cwd, which is not the session's cwd and would invent a wrong path.
function normPath(p, platform = process.platform) {
  let s = String(p == null ? '' : p).trim();
  if (!s) return '';
  const win = platform === 'win32';
  s = s.replace(/\\/g, '/');
  if (win) {
    s = s.replace(/^\/\/\?\//, '');                                // \\?\D:\x long-path prefix
    s = s.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/');                  // Git Bash /d/x -> d:/x
  }
  const unc = /^\/\/[^/]/.test(s);                                // //server/share keeps its two slashes
  const out = [];
  const parts = s.split('/');
  const absolute = s.startsWith('/');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // never climb above a drive root or the filesystem root
      if (out.length && out[out.length - 1] !== '..' && !/^[a-zA-Z]:$/.test(out[out.length - 1])) out.pop();
      else if (!absolute && !(out.length && /^[a-zA-Z]:$/.test(out[0]))) out.push('..');
      continue;
    }
    out.push(seg);
  }
  let r = out.join('/');
  if (unc) r = '//' + r;
  else if (absolute) r = '/' + r;
  if (/^[a-zA-Z]:$/.test(r)) r += '/';                            // bare "D:" is the drive root
  return win ? r.toLowerCase() : r;
}

// ── what is not worth warning about ──────────────────────────────────────────
// Generated output and scratch files are rewritten by every session (and every
// build) by design; a warning there would fire all day and teach the user to
// ignore the rail. Claude Code's per-session scratchpads live under the temp
// dir (on this machine f:\Temp\claude\...), so anything under a temp folder is
// also skipped: it is one session's private working space, never shared work.
const DEFAULT_IGNORE = [
  '/node_modules/', '/.git/', '/dist/', '/build/', '/__pycache__/', '/.next/',
  /\.log$/i,
  '/temp/', '/tmp/',
];

function tmpRoots() {
  const out = [];
  try {
    const t = normPath(os.tmpdir(), 'win32');   // case-folded: matching below is case-insensitive
    if (t) out.push(t.endsWith('/') ? t : t + '/');
  } catch (_) {}
  return out;
}

// Matching is case-insensitive on every platform: `/Node_Modules/` is still
// generated output on Linux, and an ignore list is about intent, not identity.
function makeIgnore(opts) {
  const extra = Array.isArray(opts.ignore) ? opts.ignore : (opts.ignore ? [opts.ignore] : []);
  const rules = (opts.defaultIgnore === false ? [] : DEFAULT_IGNORE.concat(tmpRoots())).concat(extra);
  const subs = [], res = [];
  for (const r of rules) {
    if (r instanceof RegExp) res.push(r);
    else if (typeof r === 'string' && r) subs.push(r.replace(/\\/g, '/').toLowerCase());
  }
  return (key) => {
    // a leading '/' lets '/tmp/' match a path that starts with tmp/ too
    const lower = '/' + key.toLowerCase().replace(/^\/+/, '');
    if (subs.some((s) => lower.includes(s) || (s.endsWith('/') && (lower + '/').endsWith(s)))) return true;
    return res.some((re) => { re.lastIndex = 0; return re.test(key); });
  };
}

// Times arrive as epoch ms from hooks, as ISO strings from replayed feeds, or
// not at all from a hand-fed test; only the last one falls back to the clock.
function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.getTime();
  if (typeof v === 'string' && v.trim()) {
    const n = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

// ── tracker ──────────────────────────────────────────────────────────────────
// opts.windowMs   how long an edit keeps "holding" a file (default 15 min).
// opts.ignore     array of substrings and/or RegExps. It EXTENDS the default
//                 list (adding one project folder should not silently stop
//                 ignoring node_modules). Pass opts.defaultIgnore = false to
//                 REPLACE the defaults with only your list.
// opts.platform   for normPath; defaults to process.platform.
// opts.maxFiles   cap on tracked files (default 5000).
function createTracker(opts = {}) {
  const windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : DEFAULT_WINDOW_MS;
  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : MAX_FILES;
  const platform = opts.platform || process.platform;
  const ignored = makeIgnore(opts);

  // key -> { file, sessions: Map<sessionId, {sessionId, project, name, at, first}>,
  //          reported: Map<signature, collision> }
  // Map insertion order doubles as LRU: a touched file is re-inserted at the end.
  const files = new Map();

  const sigOf = (ids) => ids.slice().sort().join('\u0000');

  function snapshot(c) {
    return { key: c.key, file: c.file, sessions: c.sessions.map((s) => ({ ...s })), firstAt: c.firstAt, lastAt: c.lastAt };
  }

  // Forget edits that left the window. A session dropping out of a file also
  // retires every collision it was part of: once the window has passed with no
  // edit from one of them, the overlap is over, and a later overlap is news.
  function prune(now) {
    const cutoff = now - windowMs;
    for (const [key, f] of files) {
      for (const [sid, s] of f.sessions) {
        if (s.at < cutoff) dropSession(f, sid);
      }
      if (!f.sessions.size) files.delete(key);
    }
  }

  function dropSession(f, sid) {
    f.sessions.delete(sid);
    for (const [sig, c] of f.reported) if (c.sessions.some((s) => s.sessionId === sid)) f.reported.delete(sig);
  }

  function record(edit) {
    const e = edit || {};
    const sessionId = e.sessionId ? String(e.sessionId) : '';
    const key = normPath(e.file, platform);
    if (!sessionId || !key) return null;
    if (ignored(key)) return null;
    const at = toMs(e.at);

    prune(at);

    let f = files.get(key);
    if (f) files.delete(key);                           // re-insert below: most recently touched last
    else f = { file: String(e.file), sessions: new Map(), reported: new Map() };
    files.set(key, f);

    const prev = f.sessions.get(sessionId);
    const cur = {
      sessionId,
      project: e.project != null ? String(e.project) : (prev ? prev.project : ''),
      name: e.name != null ? String(e.name) : (prev ? prev.name : ''),
      at: prev ? Math.max(prev.at, at) : at,
      first: prev ? Math.min(prev.first, at) : at,
    };
    f.sessions.set(sessionId, cur);

    // keep every already-reported collision this session belongs to current,
    // so the rail shows the latest edit time without re-announcing it
    for (const c of f.reported.values()) {
      const s = c.sessions.find((x) => x.sessionId === sessionId);
      if (!s) continue;
      s.at = cur.at; s.project = cur.project; s.name = cur.name;
      c.lastAt = Math.max(c.lastAt, cur.at);
    }

    while (files.size > maxFiles) files.delete(files.keys().next().value);

    if (f.sessions.size < 2) return null;              // only this session holds the file
    const live = [...f.sessions.values()];
    const sig = sigOf(live.map((s) => s.sessionId));
    if (f.reported.has(sig)) return null;              // already told the user about exactly this overlap

    const c = {
      key,
      file: f.file,
      sessions: live.slice().sort((a, b) => a.at - b.at).map((s) => ({ sessionId: s.sessionId, project: s.project, name: s.name, at: s.at })),
      firstAt: Math.min(...live.map((s) => s.first)),
      lastAt: Math.max(...live.map((s) => s.at)),
    };
    f.reported.set(sig, c);
    return snapshot(c);
  }

  // For the dashboard rail. One row per file: when a third session joined, the
  // wider overlap is the one worth showing, not both the pair and the trio.
  function active(now) {
    const t = toMs(now);
    const cutoff = t - windowMs;
    const out = [];
    for (const f of files.values()) {
      let best = null;
      for (const c of f.reported.values()) {
        if (c.lastAt < cutoff) continue;
        if (!best || c.sessions.length > best.sessions.length || (c.sessions.length === best.sessions.length && c.lastAt > best.lastAt)) best = c;
      }
      if (best) out.push(snapshot(best));
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  // A session that ended (SessionEnd) can no longer overwrite anything.
  function forget(sessionId) {
    const sid = String(sessionId || '');
    if (!sid) return;
    for (const [key, f] of files) {
      if (f.sessions.has(sid)) dropSession(f, sid);
      if (!f.sessions.size) files.delete(key);
    }
  }

  return { record, active, forget, _size: () => files.size };
}

module.exports = { createTracker, normPath };
