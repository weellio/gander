'use strict';
// Things Claude Code already records about a session that Gander was throwing away.
//
// Alongside the conversation, a transcript carries bookkeeping lines that never
// reach the model but are exactly what a dashboard wants:
//
//   { type:"ai-title",            aiTitle:"Analyze Claude session patterns…" }
//   { type:"mode",                mode:"normal" }                       (or bypassPermissions…)
//   { type:"frame-link",          title:"Ambient Lamp Wiring", frameUrl:"https://…", timestamp }
//   { type:"file-history-delta",  trackingPath:".gitignore", backup:{…}, timestamp }
//   { …, quotaLimits:{ status:"rejected", rateLimitType:"five_hour", resetsAt } }
//
// quotaLimits is written ONLY when the API rejects a turn, so it is a "you are
// blocked until X" fact, not a percentage gauge. Claude Code's own /usage panel
// gets the 47%/100% figures from the server; they are not on disk anywhere.
//
// So: a real session NAME instead of a folder name, which permission mode it is
// actually running in, every artifact it published (with titles), and which files
// it has touched. All of it free — no extra hooks, no model calls.
//
// Read incrementally by byte offset: a 118 MB transcript costs one pass, then only
// the bytes appended since.

const fs = require('fs');

const MAX_ARTIFACTS = 60;
const MAX_FILES = 400;

function blank() {
  return {
    title: '', mode: '', artifacts: [], files: [], quota: null,
    _seenUrl: new Set(), _seenFile: new Set(),
  };
}

function foldLine(s, line) {
  // cheap pre-filter: these four types are a tiny fraction of a transcript
  if (line.indexOf('"ai-title"') < 0 && line.indexOf('"mode"') < 0 && line.indexOf('"quotaLimits"') < 0
      && line.indexOf('"frame-link"') < 0 && line.indexOf('"file-history-delta"') < 0) return;
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  // a rejected turn carries the quota detail; keep the newest one seen
  const q = j.quotaLimits || (j.message && j.message.quotaLimits);
  if (q && typeof q === 'object' && q.status) {
    const at = Date.parse(j.timestamp || '') || 0;
    if (!s.quota || at >= (s.quota.at || 0)) {
      s.quota = { status: String(q.status).slice(0, 30), type: String(q.rateLimitType || '').slice(0, 30), resetsAt: Number(q.resetsAt) || 0, overage: !!q.isUsingOverage, at };
    }
  }
  switch (j.type) {
    case 'ai-title':
      if (j.aiTitle) s.title = String(j.aiTitle).slice(0, 200);      // last one wins
      return;
    case 'mode':
      if (j.mode) s.mode = String(j.mode).slice(0, 40);              // last one wins
      return;
    case 'frame-link': {
      const url = j.frameUrl;
      if (!url || typeof url !== 'string') return;                   // placeholder rows carry nulls
      if (s._seenUrl.has(url)) {                                     // republished: keep the newest title
        const hit = s.artifacts.find((a) => a.url === url);
        if (hit) { if (j.title) hit.title = String(j.title).slice(0, 140); hit.at = Date.parse(j.timestamp || '') || hit.at; }
        return;
      }
      if (s.artifacts.length >= MAX_ARTIFACTS) return;
      s._seenUrl.add(url);
      s.artifacts.push({ title: String(j.title || '').slice(0, 140), url, at: Date.parse(j.timestamp || '') || 0 });
      return;
    }
    case 'file-history-delta': {
      const f = j.trackingPath;
      if (!f || typeof f !== 'string' || s._seenFile.has(f)) return;
      if (s.files.length >= MAX_FILES) return;
      s._seenFile.add(f);
      s.files.push(f);
      return;
    }
    default: return;
  }
}

const cache = new Map();   // transcriptPath -> { offset, tail, s, catching }

// Every tile asks for its metadata on every snapshot, on the bridge's one
// thread. A cold read of a big transcript used to happen right there, all at
// once: a 489 MB session took 5.8 s, the biggest eight 9.6 s, and while it ran
// the bridge answered nothing — dashboards stalled 8–17 s after every restart
// and hook POSTs (5 s timeout) were silently dropped. So a read is now bounded:
// the normal live case (a few KB appended) is still done inline, and anything
// bigger is caught up in the background, 1 MB at a time, yielding in between.
const STEP = 1024 * 1024;

function entry(file, st) {
  let c = cache.get(file);
  if (c && st.size < c.offset) c = null;                    // truncated/rotated → start over
  if (!c) { c = { offset: 0, tail: '', s: blank(), catching: null }; cache.set(file, c); }
  return c;
}

// Fold at most `maxBytes` new bytes. Returns true when caught up to `size`.
function advance(file, c, size, maxBytes) {
  if (size <= c.offset) return true;
  const fd = fs.openSync(file, 'r');
  try {
    const want = Math.min(size - c.offset, maxBytes);
    const buf = Buffer.alloc(Math.min(want, STEP));
    let pos = c.offset, left = want;
    while (left > 0) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
      if (n <= 0) break;
      pos += n; left -= n;
      const lines = (c.tail + buf.toString('utf8', 0, n)).split('\n');
      c.tail = lines.pop();
      for (const l of lines) { if (l) foldLine(c.s, l); }
    }
    c.offset = pos;
  } finally { fs.closeSync(fd); }
  return c.offset >= size;
}

// Background catch-up: one pass at a time per file, yielding between steps.
function catchUp(file, c) {
  if (c.catching) return c.catching;
  c.catching = (async () => {
    try {
      for (;;) {
        let st; try { st = fs.statSync(file); } catch (_) { return; }
        if (advance(file, c, st.size, STEP)) return;
        await new Promise((r) => setImmediate(r));
      }
    } catch (_) { /* unreadable mid-way: keep what we have */ }
    finally { c.catching = null; }
  })();
  return c.catching;
}

function view(c) {
  // A finished transcript's last line may lack a trailing newline, so it would sit
  // in `tail` forever. Folding it WITHOUT consuming it is safe here because every
  // fold is idempotent: title/mode are last-wins, artifacts/files dedupe by key.
  if (c.tail) foldLine(c.s, c.tail);
  const s = c.s;
  return {
    title: s.title,
    mode: s.mode,
    quota: s.quota,
    artifacts: s.artifacts.slice().sort((a, b) => (b.at || 0) - (a.at || 0)),
    artifactCount: s.artifacts.length,
    files: s.files.slice(),
    fileCount: s.files.length,
  };
}

// Bounded, synchronous: the live case (a little appended) is read inline; a big
// backlog is handed to the background and the current partial picture returned.
// `behind` says how many bytes are still to come.
function read(transcriptPath) {
  const file = String(transcriptPath || '');
  if (!file) return null;
  let st; try { st = fs.statSync(file); } catch (_) { return null; }
  const c = entry(file, st);
  if (st.size - c.offset <= STEP) advance(file, c, st.size, STEP);
  else catchUp(file, c);
  return { ...view(c), behind: Math.max(0, st.size - c.offset) };
}

// Complete, without blocking: for the session modal, which wants the whole list.
async function readFull(transcriptPath) {
  const file = String(transcriptPath || '');
  if (!file) return null;
  let st; try { st = fs.statSync(file); } catch (_) { return null; }
  const c = entry(file, st);
  await catchUp(file, c);
  return { ...view(c), behind: 0 };
}

// What a live tile should carry. Kept small: the full file list stays behind the API.
function forTile(transcriptPath) {
  const m = read(transcriptPath);
  if (!m) return {};
  const out = {};
  if (m.title) out.title = m.title;
  // "normal" is the default and says nothing; a non-default mode is worth flagging
  if (m.mode && m.mode !== 'normal') out.permMode = m.mode;
  if (m.artifactCount) out.artifactCount = m.artifactCount;
  if (m.fileCount) out.fileCount = m.fileCount;
  // only surface a block that is still in force — a spent reset time is history
  if (m.quota && m.quota.status && m.quota.status !== 'allowed' && m.quota.resetsAt * 1000 > Date.now()) {
    out.limited = { type: m.quota.type, resetsAt: m.quota.resetsAt };
  }
  return out;
}

module.exports = { read, readFull, forTile, _reset: () => cache.clear() };
