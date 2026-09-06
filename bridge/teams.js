'use strict';
// Agent Teams (Claude Code, experimental) — read what Claude writes to disk:
//   ~/.claude/teams/<team>/config.json         { members: [{ name, agentId, agentType }] }  (lead = agentType "team-lead")
//   ~/.claude/teams/<team>/inboxes/<name>.json  teammate mailboxes (messages)
//   ~/.claude/tasks/<team>/*.json               the shared task list
// The exact schemas are only partly documented and still moving, so every
// reader here is TOLERANT: unknown shapes degrade to "present but unparsed",
// never to a crash. Team dirs exist only while the lead session runs.

const fs = require('fs');
const path = require('path');
const os = require('os');

const TEAMS_DIR = () => process.env.GANDER_TEAMS_DIR || path.join(os.homedir(), '.claude', 'teams');
const TASKS_DIR = () => process.env.GANDER_TASKS_DIR || path.join(os.homedir(), '.claude', 'tasks');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function listDirs(p) { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { return []; } }
function listJson(p) { try { return fs.readdirSync(p).filter((f) => f.endsWith('.json')); } catch (_) { return []; } }
const str = (v, n = 200) => (v === undefined || v === null ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v)).slice(0, n);

function parseMembers(cfg) {
  const raw = Array.isArray(cfg) ? cfg : (cfg && (Array.isArray(cfg.members) ? cfg.members : Array.isArray(cfg.teammates) ? cfg.teammates : null));
  if (!raw) return [];
  return raw.map((m) => (typeof m === 'string' ? { name: m } : m || {})).map((m) => ({
    name: str(m.name || m.id || m.agentId || 'teammate', 80),
    agentId: str(m.agentId || m.id || '', 120) || undefined,
    agentType: str(m.agentType || m.type || m.role || '', 80) || undefined,
    lead: /team-?lead/i.test(String(m.agentType || m.type || m.role || '')) || m.lead === true,
    sessionId: str(m.sessionId || m.session_id || '', 80) || undefined,
    status: str(m.status || m.state || '', 40) || undefined,
  }));
}

function parseMessages(j) {
  const raw = Array.isArray(j) ? j : (j && (Array.isArray(j.messages) ? j.messages : Array.isArray(j.inbox) ? j.inbox : null));
  if (!raw) return [];
  return raw.slice(-50).map((m) => (typeof m === 'string' ? { text: m } : m || {})).map((m) => ({
    from: str(m.from || m.sender || m.author || '', 80),
    to: str(m.to || m.recipient || '', 80) || undefined,
    text: str(m.text || m.content || m.message || m.body || (m.message && m.message.content) || '', 500),
    type: str(m.type || m.kind || '', 40) || undefined,
    ts: Number(m.timestamp || m.ts || m.time || m.createdAt || 0) || (Date.parse(m.timestamp || m.createdAt || '') || 0),
    read: m.read === true || m.unread === false ? true : (m.read === false || m.unread === true ? false : undefined),
  }));
}

function parseTask(j, fallbackId) {
  if (!j || typeof j !== 'object') return null;
  const st = String(j.status || j.state || '').toLowerCase();
  return {
    id: str(j.id || j.taskId || fallbackId, 80),
    subject: str(j.subject || j.title || j.name || j.description || '', 200),
    description: str(j.description || j.body || '', 1000) || undefined,
    status: st === 'completed' || st === 'done' ? 'completed' : st === 'in_progress' || st === 'in-progress' || st === 'active' || st === 'claimed' ? 'in_progress' : st || 'pending',
    owner: str(j.owner || j.assignee || j.assigned_to || j.claimedBy || '', 80) || undefined,
    blockedBy: Array.isArray(j.blockedBy) ? j.blockedBy.map((x) => str(x, 80)) : (Array.isArray(j.blocked_by) ? j.blocked_by.map((x) => str(x, 80)) : undefined),
    createdAt: Number(j.createdAt || j.created_at || 0) || undefined,
    completedAt: Number(j.completedAt || j.completed_at || 0) || undefined,
  };
}

function readTasks(team) {
  const dir = path.join(TASKS_DIR(), team);
  const out = [];
  for (const f of listJson(dir)) {
    const j = readJson(path.join(dir, f));
    if (Array.isArray(j)) { for (let i = 0; i < j.length; i++) { const t = parseTask(j[i], `${f}#${i}`); if (t) out.push(t); } continue; }
    if (j && Array.isArray(j.tasks)) { for (let i = 0; i < j.tasks.length; i++) { const t = parseTask(j.tasks[i], `${f}#${i}`); if (t) out.push(t); } continue; }
    const t = parseTask(j, f.replace(/\.json$/, ''));
    if (t) out.push(t);
  }
  return out;
}

let cache = { at: 0, list: [] };
function readTeams(maxAgeMs = 4000) {
  if (Date.now() - cache.at < maxAgeMs) return cache.list;
  const out = [];
  const seen = new Set();
  for (const name of listDirs(TEAMS_DIR())) {
    seen.add(name);
    const base = path.join(TEAMS_DIR(), name);
    const cfg = readJson(path.join(base, 'config.json'));
    const members = parseMembers(cfg);
    const inboxes = {};
    for (const f of listJson(path.join(base, 'inboxes'))) inboxes[f.replace(/\.json$/, '')] = parseMessages(readJson(path.join(base, 'inboxes', f)));
    const tasks = readTasks(name);
    const lead = members.find((m) => m.lead) || null;
    let mtime = 0; try { mtime = fs.statSync(path.join(base, 'config.json')).mtimeMs; } catch (_) {}
    out.push({
      name, lead: lead ? lead.name : undefined, members, inboxes, tasks,
      open: tasks.filter((t) => t.status !== 'completed').length, done: tasks.filter((t) => t.status === 'completed').length,
      messages: Object.values(inboxes).reduce((n, a) => n + a.length, 0),
      unparsed: !!cfg && !members.length, updatedAt: mtime || undefined,
    });
  }
  // task lists that outlive their team dir (tasks persist; team config is removed on exit)
  for (const name of listDirs(TASKS_DIR())) {
    if (seen.has(name)) continue;
    const tasks = readTasks(name);
    if (!tasks.length) continue;
    out.push({ name, members: [], inboxes: {}, tasks, open: tasks.filter((t) => t.status !== 'completed').length, done: tasks.filter((t) => t.status === 'completed').length, messages: 0, ended: true });
  }
  cache = { at: Date.now(), list: out };
  return out;
}

module.exports = { readTeams, readTasks, parseMembers, parseMessages, parseTask, _reset: () => { cache = { at: 0, list: [] }; } };
