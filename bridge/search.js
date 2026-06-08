'use strict';
// bridge/search.js — CommonJS, zero deps (fs, path, os, readline only)
// module.exports = { search }
// search() returns a Promise.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const rl   = require('readline');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Decode a ~/.claude/projects/<encoded> dir name back to a filesystem path.
 *  Encoding: path separators (/ and \) and colons become hyphens; a leading
 *  drive letter like "d:" becomes "d-". We reverse that best-effort. */
function decodeDirName(name) {
  // "d--Files-sourcecode-Foo" → "d:\Files\sourcecode\Foo"
  // Pattern: starts with single letter + "--"  → drive letter
  const driveMatch = name.match(/^([a-zA-Z])--(.*)$/);
  if (driveMatch) {
    const drive  = driveMatch[1].toUpperCase() + ':';
    const rest   = driveMatch[2].replace(/-/g, path.sep);
    return drive + path.sep + rest;
  }
  // fallback: just swap hyphens → sep
  return name.replace(/-/g, path.sep);
}

/** Extract all searchable text from a parsed JSONL line object. */
function extractText(obj) {
  const parts = [];

  function processContent(content) {
    if (!content) return;
    if (typeof content === 'string') { parts.push(content); return; }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && block.text)            parts.push(block.text);
        if (block.type === 'tool_use') {
          if (block.name)  parts.push(block.name);
          if (block.input) parts.push(JSON.stringify(block.input));
        }
        if (block.type === 'tool_result') {
          // content can be string or array
          processContent(block.content);
        }
      }
    }
  }

  // top-level message
  const msg = obj.message;
  if (msg) {
    processContent(msg.content);
  }
  return parts.join(' ');
}

/** ~160-char window centred on the first match of needle in haystack. */
function snippet(haystack, needle, windowSize = 160) {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return haystack.slice(0, windowSize).trim();
  const half  = Math.floor(windowSize / 2);
  const start = Math.max(0, idx - half);
  const end   = Math.min(haystack.length, start + windowSize);
  let s = haystack.slice(start, end).trim();
  if (start > 0)                    s = '…' + s;
  if (end < haystack.length)        s = s + '…';
  return s;
}

/** Derive a human role label from JSONL line type. */
function roleFromType(type) {
  if (type === 'assistant') return 'assistant';
  if (type === 'user')      return 'user';
  return type || 'system';
}

// ── file-list cache (brief: 10 s) ────────────────────────────────────────────

let _fileCache = null;
let _fileCacheTime = 0;
const FILE_CACHE_TTL = 10_000;

function getProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function listJsonlFiles() {
  const now = Date.now();
  if (_fileCache && now - _fileCacheTime < FILE_CACHE_TTL) return _fileCache;

  const projectsDir = getProjectsDir();
  const files = [];
  try {
    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of projectDirs) {
      if (!d.isDirectory()) continue;
      const dirPath = path.join(projectsDir, d.name);
      let entries;
      try { entries = fs.readdirSync(dirPath); } catch (_) { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        files.push({
          filePath:   path.join(dirPath, f),
          sessionId:  f.replace(/\.jsonl$/, ''),
          encodedDir: d.name,
          cwd:        decodeDirName(d.name),
          project:    path.basename(decodeDirName(d.name)),
        });
      }
    }
  } catch (_) { /* projects dir missing or unreadable */ }

  _fileCache    = files;
  _fileCacheTime = now;
  return files;
}

// ── project-path search (lightweight, synchronous) ───────────────────────────

function matchedProjects(q) {
  const projectsDir = getProjectsDir();
  const matched = [];
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const decoded = decodeDirName(d.name);
      if (decoded.toLowerCase().includes(q.toLowerCase())) {
        matched.push(decoded);
      }
    }
  } catch (_) {}
  return matched;
}

// ── readline-based file scanner ───────────────────────────────────────────────

const MAX_MATCH_LINES  = 5000;  // global cap across all files
const MAX_SESSIONS     = 40;    // cap returned sessions
const MAX_SNIPPETS     = 3;     // snippets per session

function scanFile(fileInfo, qLower, sessionMap, matchCount) {
  return new Promise((resolve) => {
    if (matchCount.value >= MAX_MATCH_LINES) { resolve(); return; }

    let stream;
    try { stream = fs.createReadStream(fileInfo.filePath, { encoding: 'utf8' }); }
    catch (_) { resolve(); return; }

    const iface = rl.createInterface({ input: stream, crlfDelay: Infinity });

    iface.on('line', (rawLine) => {
      if (matchCount.value >= MAX_MATCH_LINES) { iface.close(); return; }
      if (!rawLine.trim()) return;

      let obj;
      try { obj = JSON.parse(rawLine); }
      catch (_) { return; }

      // Only index user/assistant messages (skip queue-operation, attachment, etc.)
      if (obj.type !== 'user' && obj.type !== 'assistant') return;
      if (!obj.message) return;

      const text = extractText(obj);
      if (!text.toLowerCase().includes(qLower)) return;

      matchCount.value++;

      const sid = fileInfo.sessionId;
      if (!sessionMap[sid]) {
        sessionMap[sid] = {
          sessionId:  sid,
          project:    fileInfo.project,
          cwd:        fileInfo.cwd,
          count:      0,
          lastActive: obj.timestamp || '',
          snippets:   [],
        };
      }
      const entry = sessionMap[sid];
      entry.count++;
      if (obj.timestamp && obj.timestamp > entry.lastActive) {
        entry.lastActive = obj.timestamp;
      }
      if (entry.snippets.length < MAX_SNIPPETS) {
        entry.snippets.push({
          ts:   obj.timestamp || '',
          role: roleFromType(obj.type),
          text: snippet(text, qLower),
        });
      }
    });

    iface.on('close', resolve);
    iface.on('error', resolve);
    stream.on('error', resolve);
  });
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * search(q, opts) — async, returns Promise<result>
 *
 * result shape:
 * {
 *   q,
 *   results: [{ sessionId, project, cwd, count, lastActive, snippets: [{ts, role, text}] }],
 *   total,      ← number of distinct sessions matched
 *   scanned,    ← number of JSONL files scanned
 *   projects,   ← string[] of project paths whose name/path contains q
 * }
 */
async function search(q, opts) {
  opts = opts || {};

  if (!q || typeof q !== 'string' || q.trim().length < 2) {
    return { q: q || '', results: [], total: 0, scanned: 0, projects: [] };
  }

  const qLower = q.trim().toLowerCase();
  const files  = listJsonlFiles();

  const sessionMap  = Object.create(null);
  const matchCount  = { value: 0 };

  // Scan files sequentially (readline keeps memory low)
  for (const fileInfo of files) {
    if (matchCount.value >= MAX_MATCH_LINES) break;
    await scanFile(fileInfo, qLower, sessionMap, matchCount);
  }

  // Build results array, sort by lastActive desc, cap to MAX_SESSIONS
  let results = Object.values(sessionMap);
  results.sort((a, b) => (b.lastActive > a.lastActive ? 1 : b.lastActive < a.lastActive ? -1 : 0));
  const total = results.length;
  results = results.slice(0, MAX_SESSIONS);

  const projects = matchedProjects(qLower);

  return {
    q,
    results,
    total,
    scanned:  files.length,
    projects,
  };
}

module.exports = { search };
