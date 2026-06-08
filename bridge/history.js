'use strict';
// history.js — session-history browser for Hivemind.
// CommonJS, zero external deps (fs, path, os, readline only).
//
// Usage:
//   const history = require('./history.js');
//   const sessions = await history.list({ limit: 20, project: 'Claude-job3' });
//
// Each returned object:
//   { sessionId, cwd, project, startedAt, lastActive,
//     firstPrompt, messageCount, resumeCmd }

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ── Cache ────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 30_000;
let _cache = null;   // { ts: number, sessions: object[] }

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Best-effort decode of the encoded dir name back to a cwd path.
 * Claude encodes the cwd by replacing path separators + special chars with '-'.
 * Example: "d--Files-sourcecode-Claude-job3" → "d:\Files\sourcecode\Claude-job3"
 * The actual cwd from file content is ALWAYS preferred; this is just a fallback label.
 */
function decodeDirName(dirName) {
  // The dir name starts with the drive letter on Windows: d--Files-...
  // Replace the first "--" with ":\" and subsequent "--" with "\" then remaining "-" stays
  // (single hyphens that were real hyphens in folder names are ambiguous — best effort).
  const win = dirName.replace(/^([a-z])--/, '$1:\\').replace(/--/g, '\\');
  return win;
}

/**
 * Extract the text of a user message from a JSONL line's parsed object.
 * Returns '' if this is a tool result, a meta/system message, or empty.
 */
function extractUserText(j) {
  if (j.type !== 'user' || !j.message || !j.message.content) return '';
  const c = j.message.content;
  // Skip tool_result arrays
  if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) return '';
  let text = '';
  if (typeof c === 'string') {
    text = c;
  } else if (Array.isArray(c)) {
    const t = c.find((x) => x.type === 'text' && x.text);
    text = t ? t.text : '';
  }
  if (!text) return '';
  // Skip Claude Code meta/system injection tags
  const skipTags = [
    '<command-message>',
    '<ide_opened_file>',
    '<task-notification>',
    '<tool_use_id>',
    '<parameter name="', // tool call XML
  ];
  if (skipTags.some((tag) => text.includes(tag))) return '';
  return text.trim();
}

/**
 * Stream-parse one .jsonl file and return session metadata.
 * Never throws — any per-line error is silently skipped.
 */
function parseSession(filePath, sessionId) {
  return new Promise((resolve) => {
    let startedAt = '';
    let lastActive = '';
    let cwd = '';
    let firstPrompt = '';
    let messageCount = 0;

    let stream;
    try {
      stream = fs.createReadStream(filePath);
    } catch (_) {
      return resolve(null);
    }

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        const j = JSON.parse(line);
        // Track timestamps
        if (!startedAt && j.timestamp) startedAt = j.timestamp;
        if (j.timestamp) lastActive = j.timestamp;
        // Prefer cwd from content
        if (!cwd && j.cwd) cwd = j.cwd;
        // Count user + assistant turns
        if (j.type === 'user' || j.type === 'assistant') messageCount++;
        // First real user prompt
        if (!firstPrompt && j.type === 'user') {
          const text = extractUserText(j);
          if (text) firstPrompt = text.slice(0, 140);
        }
      } catch (_) {
        // skip malformed line
      }
    });

    rl.on('close', () => {
      resolve({ startedAt, lastActive, cwd, firstPrompt, messageCount });
    });

    stream.on('error', () => {
      rl.close();
      resolve(null);
    });
  });
}

/**
 * Scan ~/.claude/projects/ and return all resumable sessions (direct-child .jsonl files only).
 * Sub-agent transcripts live at <encoded-cwd>/<session-id>/subagents/agent-*.jsonl and are excluded.
 */
async function buildCache() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (_) {
    return [];
  }

  const sessions = [];

  for (const dirName of projectDirs) {
    const dirPath = path.join(projectsDir, dirName);
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    // Only direct-child .jsonl files — not nested sub-agent transcripts
    const jsonlFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));

    for (const entry of jsonlFiles) {
      const sessionId = entry.name.replace(/\.jsonl$/, '');
      const filePath = path.join(dirPath, entry.name);
      const parsed = await parseSession(filePath, sessionId);
      if (!parsed) continue;

      const { startedAt, lastActive, firstPrompt, messageCount } = parsed;
      // Prefer cwd from file content; fall back to decoding the dir name
      const cwd = parsed.cwd || decodeDirName(dirName);
      const project = cwd
        ? String(cwd).split(/[\\/]/).filter(Boolean).pop() || dirName
        : dirName;

      sessions.push({
        sessionId,
        cwd,
        project,
        startedAt,
        lastActive,
        firstPrompt,
        messageCount,
        resumeCmd: 'claude --resume ' + sessionId,
      });
    }
  }

  // Sort by lastActive descending (most recently active first)
  sessions.sort((a, b) => {
    if (!a.lastActive && !b.lastActive) return 0;
    if (!a.lastActive) return 1;
    if (!b.lastActive) return -1;
    return b.lastActive.localeCompare(a.lastActive);
  });

  return sessions;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * list(opts) — returns array of session objects.
 *
 * @param {{ limit?: number, project?: string }} opts
 * @returns {Promise<object[]>}
 */
async function list(opts) {
  const { limit = 50, project } = opts || {};

  // Return cache if fresh
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL_MS) {
    let sessions = _cache.sessions;
    if (project) {
      const q = project.toLowerCase();
      sessions = sessions.filter(
        (s) =>
          s.project.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q)
      );
    }
    return sessions.slice(0, limit);
  }

  // Build fresh cache
  const all = await buildCache();
  _cache = { ts: now, sessions: all };

  let sessions = all;
  if (project) {
    const q = project.toLowerCase();
    sessions = sessions.filter(
      (s) =>
        s.project.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q)
    );
  }
  return sessions.slice(0, limit);
}

module.exports = { list };
