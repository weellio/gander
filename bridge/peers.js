'use strict';
// Claude Code's local session registry + cross-session inbox.
//
// Every running Claude Code session writes ~/.claude/sessions/<pid>.json
// ({ pid, sessionId, cwd, name, messagingSocketPath, kind, entrypoint, ... })
// and removes it on exit. That's how `/list-agents` finds peers, and it gives
// Gander two things for free: the NAME other sessions use to address a tile
// (e.g. "claude-dashboard-55"), and a direct INBOX to deliver a reply into a
// terminal/VS Code session — no window automation, no waiting for the Stop hook.
//
// Wire format (captured empirically against CLI 2.1.26x on Windows):
//   line 1 (auth, required on Windows): {"type":"auth","token":"<that session's CLAUDE_CODE_MESSAGING_TOKEN>"}
//   line 2: {"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"<cross-session-message from=\"...\" from-name=\"...\">\n<text>\n</cross-session-message>"},"priority":"next","from":"..."}
// The receiver drains its inbox at its next tool round; there is no ack on the wire.
// The token is per-session and only the session's own environment has it —
// Gander learns it from hooks/emit.js, which inherits the env (see sessionTokens).

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

const REG_DIR = process.env.GANDER_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');

// sessionId -> { socket, token } as reported by hooks (the session's own env)
const sessionTokens = new Map();
function learn(sessionId, socket, token) {
  if (!sessionId || !socket) return;
  const prev = sessionTokens.get(sessionId);
  if (prev && prev.socket === socket && (prev.token === token || !token)) return;
  sessionTokens.set(sessionId, { socket, token: token || (prev && prev.token) || '', at: Date.now() });
}

let cache = { at: 0, list: [] };
function readRegistry(maxAgeMs = 3000) {
  if (Date.now() - cache.at < maxAgeMs) return cache.list;
  const out = [];
  try {
    for (const f of fs.readdirSync(REG_DIR)) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(REG_DIR, f), 'utf8'));
        if (!j || !j.sessionId) continue;
        out.push({ pid: j.pid, sessionId: j.sessionId, cwd: j.cwd || '', name: j.name || '', kind: j.kind || '', entrypoint: j.entrypoint || '', socket: j.messagingSocketPath || '', startedAt: j.startedAt || 0, version: j.version || '' });
      } catch (_) {}
    }
  } catch (_) {}
  cache = { at: Date.now(), list: out };
  return out;
}
function bySession(sessionId) { return readRegistry().find((p) => p.sessionId === sessionId) || null; }
function byName(name) { return readRegistry().find((p) => p.name === name) || null; }

// Can Gander deliver into this session's inbox right now?
function canDeliver(sessionId) {
  const t = sessionTokens.get(sessionId);
  const reg = bySession(sessionId);
  return !!((t && t.socket && (t.token || process.platform !== 'win32')) || (reg && reg.socket && process.platform !== 'win32'));
}

function envelope(text, fromName) {
  const from = fromName || 'gander';
  return {
    msgV: 1, msg_id: crypto.randomUUID(), type: 'user',
    message: { role: 'user', content: `<cross-session-message from="${from}" from-name="${from}">\n${String(text)}\n</cross-session-message>` },
    priority: 'next', from,
  };
}

// Deliver a message into a session's inbox. Resolves { ok } or { error }.
function deliver(sessionId, text, opts = {}) {
  return new Promise((resolve) => {
    const t = sessionTokens.get(sessionId) || {};
    const reg = bySession(sessionId);
    const socket = t.socket || (reg && reg.socket);
    if (!socket) return resolve({ error: 'no inbox socket known for this session' });
    if (process.platform === 'win32' && !t.token) return resolve({ error: 'no inbox token for this session yet (it reports one on its next hook event)' });
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { s.destroy(); } catch (_) {} resolve(r); } };
    const s = net.connect(socket);
    const timer = setTimeout(() => finish({ error: 'inbox did not accept the message (timeout)' }), opts.timeoutMs || 4000);
    s.on('connect', () => {
      try {
        if (t.token) s.write(JSON.stringify({ type: 'auth', token: t.token }) + '\n');
        s.write(JSON.stringify(envelope(text, opts.fromName)) + '\n', () => {
          // no ack on the wire: a clean write after auth is delivery
          setTimeout(() => { clearTimeout(timer); s.end(); finish({ ok: true, socket }); }, 150);
        });
      } catch (e) { clearTimeout(timer); finish({ error: e.message }); }
    });
    s.on('error', (e) => { clearTimeout(timer); finish({ error: 'inbox unreachable: ' + e.message }); });
  });
}

module.exports = { readRegistry, bySession, byName, learn, canDeliver, deliver, envelope, sessionTokens, REG_DIR };
