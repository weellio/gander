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
    title: '', mode: '', artifacts: [], files: [],
    _seenUrl: new Set(), _seenFile: new Set(),
  };
}

function foldLine(s, line) {
  // cheap pre-filter: these four types are a tiny fraction of a transcript
  if (line.indexOf('"ai-title"') < 0 && line.indexOf('"mode"') < 0
      && line.indexOf('"frame-link"') < 0 && line.indexOf('"file-history-delta"') < 0) return;
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
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

const cache = new Map();   // transcriptPath -> { offset, tail, s }

// { title, mode, artifacts:[{title,url,at}], files:[…], fileCount, artifactCount }
function read(transcriptPath) {
  const file = String(transcriptPath || '');
  if (!file) return null;
  let st; try { st = fs.statSync(file); } catch (_) { return null; }

  let c = cache.get(file);
  if (c && st.size < c.offset) c = null;                    // truncated/rotated → start over
  if (!c) { c = { offset: 0, tail: '', s: blank() }; cache.set(file, c); }

  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size - c.offset, 8 * 1024 * 1024));
      let pos = c.offset, left = st.size - c.offset;
      while (left > 0) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
        if (n <= 0) break;
        pos += n; left -= n;
        const chunk = c.tail + buf.toString('utf8', 0, n);
        const lines = chunk.split('\n');
        c.tail = lines.pop();
        for (const l of lines) { if (l) foldLine(c.s, l); }
      }
      c.offset = pos;
    } finally { fs.closeSync(fd); }
  }

  // A finished transcript's last line may lack a trailing newline, so it would sit
  // in `tail` forever. Folding it WITHOUT consuming it is safe here because every
  // fold is idempotent: title/mode are last-wins, artifacts/files dedupe by key.
  if (c.tail) foldLine(c.s, c.tail);

  const s = c.s;
  return {
    title: s.title,
    mode: s.mode,
    artifacts: s.artifacts.slice().sort((a, b) => (b.at || 0) - (a.at || 0)),
    artifactCount: s.artifacts.length,
    files: s.files.slice(),
    fileCount: s.files.length,
  };
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
  return out;
}

module.exports = { read, forTile, _reset: () => cache.clear() };
