'use strict';
// history.js — session-history browser for Gander.
// CommonJS, zero external deps (fs, path, os, readline only).
//
// Each returned object:
//   { sessionId, cwd, project, startedAt, lastActive, firstPrompt, bytes, resumeCmd }
//
// PERF (why this is fast even with hundreds of sessions / huge transcripts):
//   1. The INDEX is built from readdir + stat only — no file contents are read,
//      so listing every session is instant regardless of transcript size.
//   2. Only the rows we actually return (the recent slice you see / filter to) get
//      their first prompt read, and only the HEAD of those files — never the whole
//      file. "Last active" is the file's mtime (from the stat), not a tail read.
//   3. A per-file cache keyed on mtime+size means a head is parsed at most once.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ── Caches ───────────────────────────────────────────────────────────────────
const INDEX_TTL_MS = 30_000;
let _index = null;                 // { ts, sessions } — stat-only index (no prompts)
const _headCache = new Map();      // filePath -> { key, startedAt, cwd, firstPrompt }
const MAX_HEAD_LINES = 200;        // stop scanning a head after this many lines

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Best-effort decode of the encoded dir name back to a cwd path (fallback label). */
function decodeDirName(dirName) {
  return dirName.replace(/^([a-z])--/, '$1:\\').replace(/--/g, '\\');
}
function projectOf(cwd, dirName) {
  return cwd ? (String(cwd).split(/[\\/]/).filter(Boolean).pop() || dirName) : dirName;
}

/** Extract the text of a real user message; '' for tool results / meta / empty. */
function extractUserText(j) {
  if (j.type !== 'user' || !j.message || !j.message.content) return '';
  const c = j.message.content;
  if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) return '';
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) { const t = c.find((x) => x.type === 'text' && x.text); text = t ? t.text : ''; }
  if (!text) return '';
  const skipTags = ['<command-message>', '<ide_opened_file>', '<task-notification>', '<tool_use_id>', '<parameter name="'];
  if (skipTags.some((tag) => text.includes(tag))) return '';
  return text.trim();
}

/** Read only the HEAD of a transcript (startedAt, cwd, first prompt), then stop. */
function parseHead(filePath) {
  return new Promise((resolve) => {
    let startedAt = '', cwd = '', firstPrompt = '', lines = 0, done = false;
    let stream;
    try { stream = fs.createReadStream(filePath, { encoding: 'utf8' }); }
    catch (_) { return resolve({ startedAt, cwd, firstPrompt }); }

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = () => {
      if (done) return; done = true;
      try { rl.close(); } catch (_) {}
      try { stream.destroy(); } catch (_) {}
      resolve({ startedAt, cwd, firstPrompt });
    };
    rl.on('line', (line) => {
      lines++;
      try {
        const j = JSON.parse(line);
        if (!startedAt && j.timestamp) startedAt = j.timestamp;
        if (!cwd && j.cwd) cwd = j.cwd;
        if (!firstPrompt && j.type === 'user') { const t = extractUserText(j); if (t) firstPrompt = t.slice(0, 140); }
      } catch (_) { /* skip malformed line */ }
      if ((startedAt && cwd && firstPrompt) || lines >= MAX_HEAD_LINES) finish();
    });
    rl.on('close', finish);
    stream.on('error', finish);
  });
}

/** Parse (and cache) the head of one file, keyed on mtime+size so it's read once. */
async function headFor(filePath, key) {
  const cached = _headCache.get(filePath);
  if (cached && cached.key === key) return cached;
  const h = await parseHead(filePath);
  const rec = { key, ...h };
  _headCache.set(filePath, rec);
  return rec;
}

/**
 * Build the stat-only index of every resumable session (direct-child .jsonl files;
 * sub-agent transcripts under <session>/subagents/ are excluded). No file reads.
 */
function buildIndex() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (_) { return []; }

  const sessions = [];
  for (const dirName of projectDirs) {
    const dirPath = path.join(projectsDir, dirName);
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, entry.name);
      let st;
      try { st = fs.statSync(filePath); } catch (_) { continue; }
      const decoded = decodeDirName(dirName);
      sessions.push({
        sessionId: entry.name.replace(/\.jsonl$/, ''),
        filePath,
        dirName,
        statKey: st.mtimeMs + '-' + st.size,
        cwd: decoded,                                   // refined from the head on demand
        project: projectOf(decoded, dirName),
        lastActive: new Date(st.mtimeMs).toISOString(), // mtime ≈ last write ≈ last active
        lastActiveMs: st.mtimeMs,
        bytes: st.size,
        startedAt: '',
        firstPrompt: undefined,                          // loaded lazily for shown rows
        resumeCmd: 'claude --resume ' + entry.name.replace(/\.jsonl$/, ''),
      });
    }
  }
  sessions.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return sessions;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * list(opts) — returns array of session objects (most-recent first).
 * Only the returned slice has its first prompt read (lazily, head-only).
 * @param {{ limit?: number, project?: string }} opts
 */
async function list(opts) {
  const { limit = 50, project } = opts || {};

  const now = Date.now();
  if (!_index || now - _index.ts >= INDEX_TTL_MS) _index = { ts: now, sessions: buildIndex() };

  let sessions = _index.sessions;
  if (project) {
    const q = project.toLowerCase();
    sessions = sessions.filter((s) => s.project.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
  }
  const top = sessions.slice(0, limit);

  // fill the first prompt for just these rows (cached head reads, concurrent)
  await Promise.all(top.map(async (s) => {
    if (s.firstPrompt !== undefined) return;
    const h = await headFor(s.filePath, s.statKey);
    s.startedAt = h.startedAt || s.startedAt;
    if (h.cwd) { s.cwd = h.cwd; s.project = projectOf(h.cwd, s.dirName); }
    s.firstPrompt = h.firstPrompt || '';
  }));

  return top.map((s) => ({
    sessionId: s.sessionId, cwd: s.cwd, project: s.project,
    startedAt: s.startedAt, lastActive: s.lastActive,
    firstPrompt: s.firstPrompt || '', bytes: s.bytes, resumeCmd: s.resumeCmd,
  }));
}

module.exports = { list };
