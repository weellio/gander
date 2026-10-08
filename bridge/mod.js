'use strict';
// The gander-feed mod's landing spot.
//
// A "mod" is a Claude Code plugin of in-process function hooks (Claude Code
// 2.1.287+). Gander's classic hooks never see per-request usage, cache state,
// context fill or the rate-limit windows, so the bridge reconstructs those from
// transcript files. mods/gander-feed sees them live and POSTs them here; for a
// session with a live feed these figures replace the estimates.
//
// Three rules keep this safe for everyone else:
//   1. Version gate: nothing is installed unless the CLI Gander launches is
//      MIN_VERSION or newer. Older CLIs, and sessions from other providers
//      (Codex, Desktop, fleet peers), keep the classic hook path untouched.
//   2. A feed is only trusted while it is fresh (STALE_MS) and its session is
//      open; after that the transcript estimate takes over again.
//   3. The mod is best-effort: a bridge that is down costs the session nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const version = require('./version');

const MIN_VERSION = '2.1.287';
const PLUGIN = 'gander-feed';
const MARKETPLACE = 'gander';
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
const STALE_MS = 2 * 60 * 1000;
const WIN = process.platform === 'win32';
const shellSafe = (c) => (WIN && /\s/.test(c) && !/^".*"$/.test(c) ? '"' + c + '"' : c);

// ── version gate ─────────────────────────────────────────────────────────────
// `current` is the parsed CLI version ('' when the CLI is missing or not Claude Code).
function supports(current) {
  const cur = version.parseVersion(current);
  if (!cur) return { supported: false, current: '', min: MIN_VERSION, reason: 'Claude Code CLI not found: mods need Claude Code; other providers keep the hook path' };
  if (version.cmp(cur, MIN_VERSION) < 0) return { supported: false, current: cur, min: MIN_VERSION, reason: `Claude Code ${cur} is older than ${MIN_VERSION}; update Claude or keep the hook path` };
  return { supported: true, current: cur, min: MIN_VERSION, reason: '' };
}

// ── per-session store ────────────────────────────────────────────────────────
const feeds = new Map();   // session_id -> record

function fresh(sid) {
  return {
    sessionId: sid, connectedAt: Date.now(), lastAt: Date.now(), closedAt: 0,
    version: '', model: '', cwd: '', surface: null, isInteractive: null, mod: '',
    context: null, rateLimits: [], costUsd: null,
    turns: { count: 0, byReason: {} },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    steps: { count: 0, main: 0, byModel: {} },
    subagents: {},        // agentId -> { type, description, model, toolUseId, spawnedAt, steps, byModel }
    spawns: 0,
  };
}

function bump(map, key) { map[key] = (map[key] || 0) + 1; }

// Returns { ok, summary } or { error }. `summary` is what the server applies to the agent tile.
function ingest(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return { error: 'invalid body' };
  const sid = String(body.session_id || '');
  const kind = String(body.kind || '');
  if (!sid) return { error: 'session_id required' };
  if (!kind) return { error: 'kind required' };
  let rec = feeds.get(sid);
  if (!rec) { rec = fresh(sid); rec.connectedAt = now; feeds.set(sid, rec); }
  rec.lastAt = now;
  if (body.cwd) rec.cwd = String(body.cwd);
  if (body.mod) rec.mod = String(body.mod);

  switch (kind) {
    case 'hello':
      rec.closedAt = 0;
      rec.version = String(body.version || rec.version || '');
      rec.model = String(body.model || rec.model || '');
      rec.surface = body.surface === undefined ? rec.surface : body.surface;
      rec.isInteractive = body.isInteractive === undefined ? rec.isInteractive : !!body.isInteractive;
      break;
    case 'measure': {
      const c = body.context;
      if (c && typeof c === 'object') {
        rec.context = {
          tokens: Number.isFinite(Number(c.tokens)) && c.tokens !== null ? Number(c.tokens) : null,
          window: Number(c.window) || 0,
          percent: Number.isFinite(Number(c.percent)) && c.percent !== null ? Number(c.percent) : null,
        };
      }
      if (Array.isArray(body.rateLimits)) {
        rec.rateLimits = body.rateLimits.map((r) => ({ kind: String(r.kind || ''), percentUsed: Number(r.percentUsed) || 0, resetsAt: r.resetsAt || null }));
      }
      if (body.costUsd !== undefined && body.costUsd !== null) rec.costUsd = Number(body.costUsd) || 0;
      break;
    }
    case 'turn-start':
      break;
    case 'step':
      rec.steps.count++;
      if (body.model) bump(rec.steps.byModel, String(body.model));
      if (body.agentId) {
        const a = rec.subagents[body.agentId] || (rec.subagents[body.agentId] = { type: '', description: '', model: '', toolUseId: '', spawnedAt: now, steps: 0, byModel: {} });
        a.steps++;
        if (body.model) bump(a.byModel, String(body.model));
      } else {
        rec.steps.main++;
      }
      break;
    case 'turn': {
      rec.turns.count++;
      bump(rec.turns.byReason, String(body.reason || 'answer'));
      const u = body.usage;
      if (u && typeof u === 'object') {
        rec.usage.input += Number(u.input) || 0;
        rec.usage.output += Number(u.output) || 0;
        rec.usage.cacheRead += Number(u.cacheRead) || 0;
        rec.usage.cacheWrite += Number(u.cacheWrite) || 0;
        if (u.model) rec.model = String(u.model);
      }
      break;
    }
    case 'spawn': {
      rec.spawns++;
      const id = body.agentId ? String(body.agentId) : `spawn:${body.toolUseId || rec.spawns}`;
      const a = rec.subagents[id] || (rec.subagents[id] = { type: '', description: '', model: '', toolUseId: '', spawnedAt: now, steps: 0, byModel: {} });
      a.type = String(body.subagentType || a.type || '');
      a.description = String(body.description || a.description || '');
      a.model = String(body.model || a.model || '');
      a.toolUseId = String(body.toolUseId || a.toolUseId || '');
      break;
    }
    case 'bye':
      rec.closedAt = now;
      break;
    default:
      return { error: `unknown kind: ${kind}` };
  }
  return { ok: true, summary: summarize(rec, now) };
}

function isLive(rec, now = Date.now()) {
  return !!rec && !rec.closedAt && (now - rec.lastAt) <= STALE_MS;
}

// The public shape: what /api/state carries on the root agent as `feed`.
function summarize(rec, now = Date.now()) {
  if (!rec) return null;
  const u = rec.usage;
  const inputSide = u.input + u.cacheRead + u.cacheWrite;
  const cacheHit = inputSide > 0 ? u.cacheRead / inputSide : null;
  return {
    live: isLive(rec, now),
    lastAt: rec.lastAt,
    version: rec.version,
    model: rec.model,
    mod: rec.mod,
    costUsd: rec.costUsd,
    ctxPct: rec.context && rec.context.percent !== null ? rec.context.percent / 100 : null,
    ctxTokens: rec.context ? rec.context.tokens : null,
    ctxMax: rec.context ? rec.context.window : null,
    rateLimits: rec.rateLimits,
    tokens: inputSide + u.output,
    input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
    cacheHit,
    turns: rec.turns.count,
    steps: rec.steps.count,
    mainSteps: rec.steps.main,
    byModel: rec.steps.byModel,
    subagents: Object.keys(rec.subagents).length,
    spawns: rec.spawns,
  };
}

function forSession(sid, now = Date.now()) {
  const rec = feeds.get(String(sid || ''));
  return rec ? summarize(rec, now) : null;
}

function subagentsOf(sid) {
  const rec = feeds.get(String(sid || ''));
  return rec ? rec.subagents : {};
}

function liveCount(now = Date.now()) {
  let n = 0;
  for (const rec of feeds.values()) if (isLive(rec, now)) n++;
  return n;
}

// What the band above the prompt draws. `needsYou` is the caller's count
// (the needs-you rail's), so this module stays free of the agent registry.
function band({ sid, needsYou, url }, now = Date.now()) {
  const s = forSession(sid, now);
  return {
    needsYou: Number(needsYou) || 0,
    spendUsd: s && s.costUsd !== null ? Math.round(s.costUsd * 100) / 100 : null,
    ctxPercent: s && s.ctxPct !== null ? Math.round(s.ctxPct * 100) : null,
    url: String(url || ''),
  };
}

// Drop feeds whose sessions closed long ago so the map does not grow forever.
function sweep(now = Date.now(), keepMs = 24 * 3600e3) {
  for (const [sid, rec] of feeds) {
    const end = rec.closedAt || rec.lastAt;
    if (now - end > keepMs) feeds.delete(sid);
  }
}

// ── install state (read from Claude's own plugin files; no CLI call) ─────────
function pluginsDir() { return path.join(os.homedir(), '.claude', 'plugins'); }

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } }

function installState(dir = pluginsDir()) {
  const installed = readText(path.join(dir, 'installed_plugins.json'));
  const known = readText(path.join(dir, 'known_marketplaces.json'));
  return {
    installed: installed.includes(`"${PLUGIN_ID}"`) || new RegExp(`"${PLUGIN}@[^"]+"`).test(installed),
    marketplace: new RegExp(`"${MARKETPLACE}"\\s*:`).test(known),
  };
}

// The two commands the one-click install runs, in order. `root` is Gander's
// checkout (it holds .claude-plugin/marketplace.json listing ./mods/gander-feed).
function installCommands(root) {
  return [
    ['plugin', 'marketplace', 'add', root],
    ['plugin', 'install', PLUGIN_ID, '--scope', 'user'],
  ];
}

function run(cli, args, cb) {
  try {
    execFile(shellSafe(String(cli || 'claude')), args, { timeout: 120000, windowsHide: true, shell: WIN, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      cb(err ? (err.message || 'failed') : null, String(stdout || '') + String(stderr || ''));
    });
  } catch (e) { cb(e.message, ''); }
}

// Gate, then run the install commands. Never installs on an unsupported CLI.
function install({ cli, root, current }, cb) {
  const gate = supports(current);
  if (!gate.supported) return cb(null, { ok: false, gated: true, error: gate.reason, output: '' });
  const cmds = installCommands(root);
  let output = '';
  const step = (i) => {
    if (i >= cmds.length) return cb(null, { ok: true, output, installed: installState().installed });
    run(cli, cmds[i], (err, out) => {
      output += `$ claude ${cmds[i].join(' ')}\n${out}\n`;
      // "already added" is fine for the marketplace step; a failed install is not.
      if (err && i === cmds.length - 1) return cb(null, { ok: false, error: err, output });
      step(i + 1);
    });
  };
  step(0);
}

function status({ current, root }) {
  const gate = supports(current);
  const st = installState();
  return {
    plugin: PLUGIN_ID,
    minVersion: MIN_VERSION,
    ccVersion: gate.current,
    supported: gate.supported,
    reason: gate.reason,
    installed: st.installed,
    marketplace: st.marketplace,
    sessionsFed: feeds.size,
    live: liveCount(),
    installLine: `/plugin install ${PLUGIN_ID}`,
    marketplaceSource: root || '',
  };
}

function _reset() { feeds.clear(); }

module.exports = {
  MIN_VERSION, PLUGIN, PLUGIN_ID, STALE_MS,
  supports, ingest, forSession, subagentsOf, liveCount, band, sweep,
  installState, installCommands, install, status, _reset,
};
