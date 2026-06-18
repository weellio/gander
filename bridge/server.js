#!/usr/bin/env node
// Agent Ops Center — minimal bridge server (zero dependencies).
//
// Serves the dashboard and exposes a tiny event API so an orchestrator
// (Claude Code, a script, or a human) can push agent lifecycle events that
// the dashboard renders live. The stream-json auto-parser (parser.js) will
// later POST to the same /api/event endpoint; for now events are pushed by hand.
//
//   node bridge/server.js --port 3131
//
// API:
//   GET  /api/state           -> { agents: [...] }   (dashboard polls this)
//   POST /api/event           -> upsert/remove an agent, body is JSON:
//        { agentId, name?, shirt?, state?, detail?, parentId?, log?, remove? }
//   POST /api/reset           -> clear the registry
//
// Static files are served from ../dashboard.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const readline = require('readline');
const { createParser } = require('./parser.js');
const https = require('https');
const license = require('./license.js');
const projects = require('./projects.js');
const git = require('./git.js');
const usage = require('./usage.js');
const github = require('./github.js');
const configmgr = require('./configmgr.js');
const history = require('./history.js');
const routines = require('./routines.js');
const projKeyOf = projects.keyOf;   // module ref (snapshot() has a local `projects` that shadows it)
const health = require('./health.js');
const transcript = require('./transcript.js');
const search = require('./search.js');
const STARTED = Date.now();
let eventsReceived = 0;

const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : 3131;
})();

const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
const DIST_DIR = path.join(DASHBOARD_DIR, 'dist');
// Serve the built Svelte app from dashboard/dist when present; otherwise fall
// back to the legacy static dashboard. Lets the migration land incrementally.
function webRoot() {
  try { return fs.existsSync(path.join(DIST_DIR, 'index.html')) ? DIST_DIR : DASHBOARD_DIR; } catch (_) { return DASHBOARD_DIR; }
}

// ── In-memory agent registry ────────────────────────────────────────────────
/** @type {Map<string, object>} */
const agents = new Map();
const VALID_STATES = ['idle', 'thinking', 'coding', 'spawning', 'reading', 'error', 'testing', 'done', 'awaiting'];

// Hurricane-style naming: nameless "general-purpose" workers get a friendly name,
// cycling A→Z (Andy, Bo, Cleo … Xander, Yogesh, Zephyr) then wrapping around.
const HNAMES = [
  ['Andy', 'Amara', 'Aaron'], ['Bo', 'Bianca', 'Ben'], ['Cleo', 'Cody', 'Cara'],
  ['Dana', 'Dmitri', 'Dee'], ['Eve', 'Eli', 'Esme'], ['Fay', 'Felix', 'Fern'],
  ['Gina', 'Gus', 'Greta'], ['Hank', 'Hana', 'Hugo'], ['Iris', 'Ivan', 'Ines'],
  ['Joe', 'Jada', 'Jonah'], ['Kit', 'Kira', 'Karl'], ['Leon', 'Lila', 'Larry'],
  ['Mae', 'Milo', 'Mara'], ['Nina', 'Ned', 'Noor'], ['Omar', 'Olive', 'Otis'],
  ['Pia', 'Pete', 'Priya'], ['Quinn', 'Quincy', 'Qadir'], ['Rosa', 'Ray', 'Remy'],
  ['Sue', 'Sami', 'Sage'], ['Tom', 'Tara', 'Theo'], ['Uma', 'Uri', 'Una'],
  ['Vera', 'Vince', 'Vida'], ['Wendy', 'Walt', 'Wren'], ['Xander', 'Xia', 'Xavi'],
  ['Yogesh', 'Yara', 'Yusuf'], ['Zephyr', 'Zoe', 'Zane'],
];
let hurricaneIdx = 0;
function isGeneric(name) { return !name || /^(general[-\s]?purpose|subagent|sub-|agent-)/i.test(String(name)); }
function nextHurricane() { const list = HNAMES[hurricaneIdx % 26]; hurricaneIdx++; return list[Math.floor(Math.random() * list.length)]; }

// Rolling activity feed (newest-first ring buffer) for the event ticker / error spotlight.
const feed = [];
function pushFeed(e) { feed.unshift(e); if (feed.length > 300) feed.length = 300; }

// Persist the registry so a bridge restart doesn't lose the picture. Entries
// older than 12h are dropped on load (stale sessions from long-gone runs).
const REG_FILE = path.join(__dirname, 'aoc-registry.json');
let saveTimer = null;
function saveRegistry() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(REG_FILE, JSON.stringify(Array.from(agents.values()))); } catch (_) {}
  }, 500);
}
(function loadRegistry() {
  try {
    const arr = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
    const cutoff = Date.now() - 12 * 3600 * 1000;
    for (const a of arr) if ((a.updatedAt || 0) >= cutoff) agents.set(String(a.id), a);
  } catch (_) {}
})();

// Per-project mute list (the per-project "opt-in" control): hook events from a
// muted project are dropped. Persisted so the choice survives bridge restarts.
const MUTE_FILE = path.join(__dirname, 'aoc-mutes.json');
let muted = new Set();
try { muted = new Set(JSON.parse(fs.readFileSync(MUTE_FILE, 'utf8'))); } catch (_) {}
function saveMutes() { try { fs.writeFileSync(MUTE_FILE, JSON.stringify([...muted])); } catch (_) {} }

// Derive a friendly project name from a session's working directory.
function projectFromCwd(cwd) {
  if (!cwd) return 'unknown';
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
}

// ── Operator command queue ───────────────────────────────────────────────────
// The dashboard queues commands for a running session; they're delivered through
// the Claude Code hook RETURN CHANNEL: a 'message' is injected when the agent's
// Stop hook fires (decision:block), a 'stop' denies the next tool (PreToolUse).
const commands = new Map(); // sessionId -> [{ id, type, text, ts }]
let cmdSeq = 1;
function queueCommand(sessionId, type, text) {
  if (!sessionId) return { error: 'sessionId required' };
  if (!['message', 'stop'].includes(type)) return { error: 'type must be message|stop' };
  const q = commands.get(sessionId) || [];
  const cmd = { id: cmdSeq++, type, text: String(text || ''), ts: Date.now() };
  q.push(cmd);
  commands.set(sessionId, q);
  return { ok: true, queued: cmd };
}
function takeCommand(sessionId, predicate) {
  const q = commands.get(sessionId);
  if (!q || !q.length) return null;
  const i = q.findIndex(predicate);
  if (i === -1) return null;
  const [cmd] = q.splice(i, 1);
  if (!q.length) commands.delete(sessionId);
  return cmd;
}

// ── Telegram alerts (optional) ───────────────────────────────────────────────
// When a session enters the "awaiting" state (Claude needs your input), ping
// Telegram so you can reply from the dashboard while away. Configure via env
// AOC_TG_TOKEN / AOC_TG_CHAT / AOC_DASH_URL, or bridge/aoc-config.json:
//   { "telegramToken": "...", "telegramChatId": "...", "dashboardUrl": "https://..." }
const CFG_FILE = path.join(__dirname, 'aoc-config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (_) {}
// Live-updatable Telegram config (settable from the dashboard via /api/telegram-config).
const tg = {
  token: process.env.AOC_TG_TOKEN || cfg.telegramToken || '',
  chat: process.env.AOC_TG_CHAT || cfg.telegramChatId || '',
  dash: process.env.AOC_DASH_URL || cfg.dashboardUrl || `http://localhost:${argPort}/`,
};
function saveConfig() { try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); } catch (_) {} }

// Wake parked/idle sessions so queued replies deliver. The bridge runs the nudge
// script itself (it's a local process with desktop access) — no external Windows
// scheduled task or cron entry needed. Windows uses the hidden VBS launcher (no
// console flash); macOS/Linux uses the shell twin.
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
function runNudgeSweep() {
  try {
    if (process.platform === 'win32') {
      spawnSafe('wscript.exe', [path.join(SCRIPTS_DIR, 'nudge-idle-hidden.vbs'), '-OnlyPending'], { windowsHide: true });
    } else {
      spawnSafe('bash', [path.join(SCRIPTS_DIR, 'nudge-idle.sh'), '--only-pending'], {});
    }
  } catch (_) {}
}
// Fired right after a reply is queued (when "Wake on send" is on).
function maybeNudge() { if (cfg.nudgeOnSend) runNudgeSweep(); }
// Periodic sweep — interval in minutes (cfg.nudgeInterval; 0 = off). Reschedulable.
let nudgeTimer = null;
function rescheduleNudge() {
  if (nudgeTimer) { clearInterval(nudgeTimer); nudgeTimer = null; }
  const mins = Number(cfg.nudgeInterval) || 0;
  if (mins > 0) nudgeTimer = setInterval(runNudgeSweep, Math.max(1, mins) * 60000);
}

// ── auto-retire ("clock out") — prune stale tiles so the floor reflects reality.
// Only idle/done ever retire; active states never do. Tunable via aoc-config.json.
const RETIRE = {
  done: (cfg.retireDoneSec || 180) * 1000,            // finished sub-agents: 3 min
  closed: (cfg.retireClosedSec || 60) * 1000,         // SessionEnd (truly closed): 1 min
  idle: (cfg.retireIdleSec || 1500) * 1000,           // idle session (resting): 25 min
  staleActive: (cfg.retireStaleActiveSec || 1800) * 1000, // orphaned "active" tile (no terminal event): 30 min
  grace: 6000,                                         // animation window before deletion
  enabled: cfg.autoRetire !== false,
};
function retireSweep() {
  if (!RETIRE.enabled) return;
  const now = Date.now();
  let changed = false;
  for (const [id, a] of agents) {
    // active tiles get a long stale leash (catches orphans whose Stop never fired);
    // idle/done retire on their normal timers.
    const ttl = a.state === 'done' ? RETIRE.done
      : a.state === 'idle' ? (a.closed ? RETIRE.closed : RETIRE.idle)
      : RETIRE.staleActive;
    if (!a.retiring) {
      if (now - (a.updatedAt || 0) > ttl) { a.retiring = true; a.retireAt = now; changed = true; }
    } else if (now - (a.retireAt || now) > RETIRE.grace) {
      agents.delete(id); changed = true;
    }
  }
  if (changed) saveRegistry();
}

// ── cost budget alerts — warn (Telegram + dashboard) when spend crosses a cap. ──
const budget = { daily: Number(cfg.dailyBudget) || 0, session: Number(cfg.sessionBudget) || 0, enforce: !!cfg.budgetEnforce };
let budgetState = { dailyCost: 0, daily: budget.daily, session: budget.session, enforce: budget.enforce, overDaily: false, generatedAt: 0 };
const budgetAlerted = { day: '', sessions: new Set() };
function dayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
async function checkBudget() {
  try {
    const u = await usage.summaryAsync();
    const tk = dayKey();
    const day = (u.byDay || []).find((x) => x.date === tk);
    const dailyCost = day ? day.costUSD : 0;
    const overDaily = budget.daily > 0 && dailyCost >= budget.daily;
    budgetState = { dailyCost, daily: budget.daily, session: budget.session, enforce: budget.enforce, overDaily, generatedAt: Date.now() };
    if (overDaily && budgetAlerted.day !== tk) {
      budgetAlerted.day = tk;
      const act = budget.enforce ? ' — stopping active sessions' : '';
      sendTelegram(`💸 <b>Gander budget</b>\nToday's spend $${dailyCost.toFixed(2)} crossed your $${budget.daily} cap${act}.`);
      pushFeed({ ts: Date.now(), agentId: 'budget', agent: 'budget', project: '', state: 'error', log: `Daily spend $${dailyCost.toFixed(2)} over $${budget.daily} cap${act}`, error: true });
      if (budget.enforce) {
        for (const a of agents.values()) {
          if (a.root && !a.closed && a.state !== 'idle' && a.state !== 'done') {
            const s2 = sidOf(a); if (s2) queueCommand(s2, 'stop', `Daily budget cap ($${budget.daily}) reached — stopping.`);
          }
        }
        maybeNudge();
      }
    }
    if (budget.session > 0 && u.bySession) {
      for (const [sid, s] of Object.entries(u.bySession)) {
        if (s.costUSD >= budget.session && !budgetAlerted.sessions.has(sid)) {
          budgetAlerted.sessions.add(sid);
          const ag = agents.get('sess:' + sid);
          const name = ag ? ag.project : sid.slice(0, 8);
          if (budget.enforce) {
            queueCommand(sid, 'stop', `Session budget cap ($${budget.session}) reached — stopping.`);
            pushFeed({ ts: Date.now(), agentId: 'budget', agent: 'budget', project: ag ? ag.project : '', state: 'error', log: `${name} hit $${s.costUSD.toFixed(2)} (cap $${budget.session}) — stopped`, error: true });
            sendTelegram(`🛑 <b>Gander</b>\nStopped ${name}: $${s.costUSD.toFixed(2)} hit the $${budget.session} cap.`);
            maybeNudge();
          } else {
            sendTelegram(`💸 <b>Gander</b>\nSession ${name} hit $${s.costUSD.toFixed(2)} (cap $${budget.session}).`);
          }
        }
      }
    }
  } catch (_) {}
}

// ── live burn-rate ($/min) — flag agents that are spending money fast. ──────────
// The budget alerts above are about TOTAL spend. This samples each live session's
// cost over time so a stuck/looping agent shows a red "runaway" highlight on its
// tile in real time. Threshold is $/min; demo/manual agents can set it directly.
const BURN_ALERT = Number(cfg.burnAlert) > 0 ? Number(cfg.burnAlert) : 5.0; // $/min (sustained)
const costSamples = new Map();   // sessionId -> { cost, ts, ema, streak }
function sidOf(a) { return a.sessionId || (String(a.id).startsWith('sess:') ? String(a.id).slice(5) : null); }
async function sampleBurn() {
  try {
    const u = await usage.summaryAsync();
    if (!u || !u.bySession) return;
    const now = Date.now();
    for (const a of agents.values()) {
      if (a.costManual) continue;                       // explicit override (e.g. demo) wins
      // Cost is tracked per SESSION (one transcript). A sub-agent's sessionId is its
      // parent's, so attributing the session total to each sub-agent shows the same
      // number on all of them — only the root session should carry the cost.
      if (!a.root) { if (a.costUSD != null || a.burnRate) { a.costUSD = null; a.burnRate = 0; a.burnStreak = 0; } continue; }
      const sid = sidOf(a);
      if (!sid) continue;
      const s = u.bySession[sid];
      if (!s) continue;
      a.costUSD = s.costUSD;
      let rec = costSamples.get(sid);
      if (!rec) { costSamples.set(sid, { cost: s.costUSD, ts: now, ema: 0, streak: 0 }); a.burnRate = 0; a.burnStreak = 0; continue; }
      // The usage summary is cached (60s TTL) while we sample every 30s, so equal
      // snapshots carry no new info — measure the rate over the REAL window since the
      // cost last changed (not the sample gap), then smooth it (EMA) so one big turn
      // doesn't spike a believable number into the hundreds.
      if (s.costUSD > rec.cost + 1e-9) {
        const mins = (now - rec.ts) / 60000;
        const inst = mins > 0.08 ? (s.costUSD - rec.cost) / mins : 0;   // ignore <5s windows
        rec.ema = rec.ema > 0 ? rec.ema * 0.6 + inst * 0.4 : inst;
        rec.cost = s.costUSD; rec.ts = now;
        rec.streak = rec.ema >= BURN_ALERT ? rec.streak + 1 : 0;
      } else if ((now - rec.ts) / 60000 > 1.5) {        // spend stalled → decay toward 0, clear the flag
        rec.ema *= 0.5; rec.streak = 0;
      }
      a.burnRate = Math.round(rec.ema * 100) / 100;
      a.burnStreak = rec.streak;
    }
  } catch (_) {}
}

const LICENSE_KEY = process.env.AOC_LICENSE || cfg.license || '';
let licenseState = { licensed: true, mode: 'pending' };
const alertedAt = new Map();        // sessionId -> ts (throttle)
const alertMsgMap = new Map();       // telegram message_id -> sessionId (for reply routing)
let lastAwaitingSession = null;
let lastActiveSession = null;
const awaitTimers = new Map();       // rootKey -> delayed-nudge timeout (Telegram after 30s unanswered)

function sendTelegram(text, cb) {
  if (!tg.token || !tg.chat) { if (cb) cb(null); return; }
  const payload = JSON.stringify({ chat_id: tg.chat, text, parse_mode: 'HTML', disable_web_page_preview: true });
  const req = https.request({
    host: 'api.telegram.org', path: `/bot${tg.token}/sendMessage`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 4000,
  }, (res) => {
    let b = ''; res.on('data', (d) => (b += d));
    res.on('end', () => { if (cb) { try { const j = JSON.parse(b); cb(j.ok ? j.result.message_id : null); } catch (_) { cb(null); } } });
  });
  req.on('error', (e) => { console.error('[telegram]', e.message); if (cb) cb(null); });
  req.on('timeout', () => { req.destroy(); if (cb) cb(null); });
  req.end(payload);
}

function maybeAlert(root) {
  const sid = root.sessionId || root.id;
  const now = Date.now();
  if (alertedAt.get(sid) && now - alertedAt.get(sid) < 60000) return; // throttle 60s/session
  alertedAt.set(sid, now);
  lastAwaitingSession = sid;
  const proj = root.project || 'a session';
  console.log(`[alert] ${proj} awaiting input`);
  sendTelegram(
    `🔔 <b>Gander</b>\n<b>${proj}</b> needs your input.\nReply to this message to answer, or open: ${tg.dash}`,
    (mid) => { if (mid) alertMsgMap.set(mid, sid); }
  );
}

function sessionByProject(name) {
  for (const a of agents.values()) if (a.root && (a.project || '') === name && a.sessionId) return a.sessionId;
  return null;
}

// Inbound Telegram replies -> operator commands (two-way control).
// Needs a bot WITHOUT a webhook (getUpdates 409s otherwise) — set telegramReplyToken
// in aoc-config.json to a dedicated bot if your main bot has a webhook.
function handleTgMessage(m) {
  if (!m || !m.text || String(m.chat.id) !== String(tg.chat)) return;
  const text = m.text.trim();
  let sessionId = null;
  const replyId = m.reply_to_message && m.reply_to_message.message_id;
  if (replyId && alertMsgMap.has(replyId)) sessionId = alertMsgMap.get(replyId);
  let type = 'message', payload = text;
  if (/^\/stop\b/i.test(text)) { type = 'stop'; payload = ''; }
  const tagged = text.match(/^@?([\w.-]+)\s*:\s*([\s\S]+)$/);
  if (!sessionId && tagged) { const s = sessionByProject(tagged[1]); if (s) { sessionId = s; payload = tagged[2]; } }
  if (!sessionId) sessionId = lastAwaitingSession || lastActiveSession;
  if (!sessionId) { sendTelegram('No active session to send to. Use “project: your message”.'); return; }
  queueCommand(sessionId, type, payload);
  maybeNudge();
  const root = agents.get('sess:' + sessionId);
  sendTelegram(`→ ${type === 'stop' ? 'STOP' : 'message'} queued for <b>${root ? root.project : sessionId}</b>`);
}

let tgPollStarted = false;
function startTelegramPolling() {
  if (!tg.token || !tg.chat || tgPollStarted) return;
  tgPollStarted = true;
  let offset = 0, warned = false;
  const poll = () => {
    const token = cfg.telegramReplyToken || tg.token;
    const req = https.request(
      { host: 'api.telegram.org', path: `/bot${token}/getUpdates?timeout=30&offset=${offset}`, method: 'GET', timeout: 40000 },
      (res) => {
        let b = ''; res.on('data', (d) => (b += d));
        res.on('end', () => {
          try {
            const j = JSON.parse(b);
            if (!j.ok && /webhook/i.test(j.description || '') && !warned) {
              warned = true;
              console.error('[telegram] reply polling blocked: this bot has a webhook. Set "telegramReplyToken" in aoc-config.json to a dedicated bot to enable Telegram replies.');
            } else if (j.ok) {
              for (const u of j.result) { offset = u.update_id + 1; try { handleTgMessage(u.message); } catch (_) {} }
            }
          } catch (_) {}
          setTimeout(poll, 800);
        });
      }
    );
    req.on('error', () => setTimeout(poll, 3000));
    req.on('timeout', () => { req.destroy(); setTimeout(poll, 500); });
    req.end();
  };
  poll();
  console.log('[telegram] reply polling started');
}

function upsert(ev) {
  const id = String(ev.agentId);
  if (!id || id === 'undefined') return { error: 'agentId required' };

  if (ev.remove) {
    const cur = agents.get(id);
    if (cur && cur.root) {           // keep session roots; just return them to idle
      cur.state = 'idle'; cur.updatedAt = Date.now();
      saveRegistry();
      return { ok: true, kept: id };
    }
    agents.delete(id);
    saveRegistry();
    return { ok: true, removed: id };
  }

  const existing = agents.get(id) || { id, logLines: [], createdAt: Date.now() };
  if (ev.name !== undefined) {
    if (isGeneric(ev.name)) {
      if (!existing.name) existing.name = nextHurricane();   // friendly name for a nameless worker
      if (!existing.role) existing.role = String(ev.name);   // keep the real type for reference
    } else {
      existing.name = ev.name;
    }
  }
  if (ev.shirt !== undefined) existing.shirt = ev.shirt;
  if (ev.color !== undefined) existing.color = ev.color;   // agent's defined front-matter color
  if (ev.model !== undefined) existing.model = ev.model;   // agent's defined model
  if (ev.awaitMsg !== undefined) existing.awaitMsg = ev.awaitMsg;   // why it's waiting on you
  if (ev.parentId !== undefined) existing.parentId = String(ev.parentId);
  if (ev.project !== undefined) existing.project = ev.project;
  if (ev.sessionId !== undefined) existing.sessionId = ev.sessionId;
  if (ev.cwd !== undefined) existing.cwd = ev.cwd;
  if (ev.root !== undefined) existing.root = ev.root;
  if (ev.lastMessage !== undefined && ev.lastMessage) existing.lastMessage = ev.lastMessage;
  if (ev.detail !== undefined) existing.detail = ev.detail;
  if (ev.costUSD !== undefined) { existing.costUSD = Number(ev.costUSD) || 0; existing.costManual = true; }
  if (ev.burnRate !== undefined) { existing.burnRate = Number(ev.burnRate) || 0; existing.costManual = true; }
  if (ev.runaway !== undefined) existing.runawayManual = !!ev.runaway;
  if (ev.state !== undefined) {
    if (!VALID_STATES.includes(ev.state)) return { error: `invalid state: ${ev.state}` };
    existing.state = ev.state;
  }
  if (!existing.state) existing.state = 'idle';
  if (ev.log) {
    existing.logLines.unshift(String(ev.log));
    if (existing.logLines.length > 8) existing.logLines.pop();
  }
  existing.closed = !!ev.closed;                      // SessionEnd marks a truly-closed session
  existing.retiring = false; existing.retireAt = 0;   // any event = activity → cancel clock-out
  existing.updatedAt = Date.now();
  agents.set(id, existing);
  if (ev.state !== undefined || ev.log) {
    pushFeed({ ts: Date.now(), agentId: id, agent: existing.name || id, project: existing.project || '', sessionId: existing.sessionId || '', state: existing.state, log: ev.log ? String(ev.log) : '', error: existing.state === 'error' });
  }
  saveRegistry();
  return { ok: true, agent: existing };
}

// ── Project inspection (.claude contents) + skill copy ───────────────────────
function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return []; } }
function inspectProject(cwd) {
  const out = { skills: [], agents: [], hooks: [] };
  if (!cwd) return out;
  const cd = path.join(cwd, '.claude');
  for (const d of listDir(path.join(cd, 'skills'))) if (d.isDirectory()) out.skills.push(d.name);
  for (const f of listDir(path.join(cd, 'commands'))) if (f.isFile() && f.name.endsWith('.md')) out.skills.push(f.name.replace(/\.md$/, ''));
  for (const f of listDir(path.join(cd, 'agents'))) if (f.isFile() && f.name.endsWith('.md')) out.agents.push(f.name.replace(/\.md$/, ''));
  try { const s = JSON.parse(fs.readFileSync(path.join(cd, 'settings.json'), 'utf8')); if (s.hooks) out.hooks = Object.keys(s.hooks); } catch (_) {}
  return out;
}
function copySkill(fromCwd, toCwd, skill) {
  if (!fromCwd || !toCwd || !skill) return { error: 'fromCwd, toCwd, skill required' };
  if (/[\\/]/.test(skill) || skill.includes('..')) return { error: 'invalid skill name' };
  const src = path.join(fromCwd, '.claude', 'skills', skill);
  const dst = path.join(toCwd, '.claude', 'skills', skill);
  if (!fs.existsSync(src)) return { error: 'source skill not found' };
  try { fs.cpSync(src, dst, { recursive: true }); return { ok: true, copied: skill, to: dst }; }
  catch (e) { return { error: e.message }; }
}

// Open a path in the OS file manager or in VS Code (local bridge → real action).
// Spawn a detached process, swallowing the async 'error' event so a missing
// binary can't crash the bridge.
function spawnSafe(cmd, args, opts, onError) {
  try {
    const c = spawn(cmd, args, Object.assign({ detached: true, stdio: 'ignore', windowsHide: true }, opts || {}));
    c.on('error', (e) => { if (onError) onError(e); });
    c.unref();
    return c;
  } catch (e) { if (onError) onError(e); return null; }
}

// Locate VS Code's executable (PATH `code` is often unavailable to a hook-spawned bridge).
function findVSCode() {
  const env = process.env;
  const cands = process.platform === 'win32' ? [
    path.join(env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
    path.join(env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
  ] : [];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

// The `code` CLI (not Code.exe) reliably opens a single FILE in the running instance.
function findVSCodeCli() {
  const env = process.env;
  const cands = process.platform === 'win32' ? [
    path.join(env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
    path.join(env.ProgramFiles || '', 'Microsoft VS Code', 'bin', 'code.cmd'),
  ] : [];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

function openPath(p, target) {
  try {
    const win = process.platform === 'win32';
    const norm = win ? path.normalize(p) : p;
    if (target === 'editor') {
      // user override (aoc-config.json editorCmd or set from the Config panel) — e.g. a full
      // path to Code.exe / code.cmd, or another editor command like "codium" / "subl".
      const custom = cfg && cfg.editorCmd ? String(cfg.editorCmd).trim() : '';
      if (custom) { spawnSafe(`"${custom}" "${norm}"`, [], { shell: true, windowsHide: true }); return; }
      if (win) {
        const cli = findVSCodeCli();
        if (cli) { spawnSafe(`"${cli}" "${norm}"`, [], { shell: true, windowsHide: true }); return; }  // opens files + folders in the running instance
        const exe = findVSCode();
        if (exe) { spawnSafe(exe, [norm]); return; }
        spawnSafe('code.cmd', [norm], { shell: true }, () => spawnSafe('explorer.exe', [norm]));
        return;
      }
      if (process.platform === 'darwin') { spawnSafe('open', ['-a', 'Visual Studio Code', norm], {}, () => spawnSafe('code', [norm], { shell: true })); return; }
      spawnSafe('code', [norm], { shell: true });
      return;
    }
    if (win) spawnSafe('explorer.exe', [norm]);
    else if (process.platform === 'darwin') spawnSafe('open', [norm]);
    else spawnSafe('xdg-open', [norm]);
  } catch (_) {}
}

// ── Claude memory: CLAUDE.md + .claude/memory/*.md fact files ────────────────
// scope 'global' = ~/.claude · scope 'project' = a project's cwd. Writes are
// constrained to .md files inside the chosen root (no path traversal).
function memCtx(body) {
  const home = os.homedir();
  const scope = body && body.scope === 'project' && body.cwd ? 'project' : 'global';
  const root = scope === 'project' ? path.resolve(String(body.cwd)) : home;
  const memoryDir = path.join(scope === 'project' ? root : home, '.claude', 'memory');
  return { scope, root, memoryDir, home };
}
function readTextSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }
function claudeMdFor(scope, root, home) {
  if (scope === 'global') return path.join(home, '.claude', 'CLAUDE.md');
  const a = path.join(root, 'CLAUDE.md'), b = path.join(root, '.claude', 'CLAUDE.md');
  if (fs.existsSync(a)) return a;
  if (fs.existsSync(b)) return b;
  return a;   // default to project-root CLAUDE.md when neither exists yet
}
function factMeta(content) {
  const out = { name: '', description: '', type: '' };
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content || '');
  if (m) {
    const fm = m[1];
    let x;
    if ((x = /(?:^|\n)name:\s*(.+)/.exec(fm))) out.name = x[1].trim();
    if ((x = /(?:^|\n)description:\s*(.+)/.exec(fm))) out.description = x[1].trim();
    if ((x = /(?:^|\n)\s*type:\s*(.+)/.exec(fm))) out.type = x[1].trim();
  }
  return out;
}
function memPathAllowed(target, scope, root, home) {
  const okRoot = path.resolve(scope === 'global' ? home : root);
  return path.resolve(target).startsWith(okRoot) && /\.md$/i.test(target);
}

// ── CLAUDE.md dead-weight audit ──────────────────────────────────────────────
// Flag lines that reference a file/command/tool which never shows up in the
// project's actual transcript activity — likely window real-estate spent for
// nothing. Conservative: never flags guardrails or pure prose (unmeasurable).
function projTranscriptDir(cwd) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const target = String(cwd).toLowerCase();
  // Claude Code encodes the cwd as a dir name, replacing path separators AND other
  // punctuation (incl. underscores) with '-'. Try a few encodings before scanning.
  for (const g of [String(cwd).replace(/[\\/:]/g, '-'), String(cwd).replace(/[^a-zA-Z0-9]/g, '-')]) {
    const p = path.join(root, g);
    if (fs.existsSync(p)) return p;
  }
  try {
    for (const d of fs.readdirSync(root)) {                              // fallback: match by recorded cwd
      const dir = path.join(root, d);
      let files; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
      for (const f of files.slice(0, 3)) {
        let head; try { head = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(0, 40); } catch (_) { continue; }
        for (const ln of head) {
          if (ln.indexOf('"cwd"') < 0) continue;
          let o; try { o = JSON.parse(ln); } catch (_) { continue; }
          if (o && o.cwd && String(o.cwd).toLowerCase() === target) return dir;
        }
      }
    }
  } catch (_) {}
  return null;
}
function activityCorpus(dir) {
  let corpus = '', files = 0, list;
  try { list = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return { corpus: '', files: 0 }; }
  for (const f of list) {
    files++;
    let lines; try { lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n'); } catch (_) { continue; }
    for (const ln of lines) {
      if (!ln || ln.indexOf('tool_use') < 0) continue;
      let o; try { o = JSON.parse(ln); } catch (_) { continue; }
      const blocks = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
      for (const b of blocks) {
        if (!b || b.type !== 'tool_use') continue;
        corpus += ' ' + (b.name || '');
        const inp = b.input || {};
        for (const k of ['command', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'old_string', 'new_string', 'prompt']) {
          if (inp[k]) corpus += ' ' + String(inp[k]).slice(0, 2000);
        }
      }
      if (corpus.length > 4e6) return { corpus: corpus.toLowerCase(), files };
    }
  }
  return { corpus: corpus.toLowerCase(), files };
}
// Index the project's files (repo-relative paths + basenames, lowercased) so the audit
// can tell a *dead* reference (a file that doesn't exist) from one that's merely unused
// this session. This is the compact-proof signal: transcript activity gets wiped by
// /compact, but the files on disk don't. Bounded walk; skips heavy / ignored dirs.
function projectFileIndex(root) {
  const set = new Set();
  const SKIP = new Set(['node_modules', '.git', '.gander', 'dist', 'build', 'out', '.next', '.svelte-kit', 'coverage', 'vendor', '__pycache__', '.venv', 'target']);
  let count = 0;
  const walk = (dir, rel, depth) => {
    if (depth > 6 || count > 8000) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (count > 8000) return;
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.claude')) continue;
        walk(path.join(dir, e.name), rel ? rel + '/' + e.name : e.name, depth + 1);
      } else if (e.isFile()) {
        count++;
        const relPath = (rel ? rel + '/' + e.name : e.name).toLowerCase();
        set.add(relPath);
        set.add(e.name.toLowerCase());
      }
    }
  };
  walk(root, '', 0);
  return set;
}
// Flag a CLAUDE.md line ONLY when it points at a file that doesn't exist in the project
// (and wasn't used in recent activity, and isn't a guardrail). Bare commands / prose are
// never cut. `fileset` is the on-disk index; `corpus` is recent transcript activity.
function auditClaudeMd(text, fileset, projectRoot) {
  const GUARD = /\b(never|don'?t|do ?not|must|avoid|always|only|ensure|require|forbid|prefer|should|need to)\b/i;
  const FILEISH = /\.(?:js|ts|tsx|jsx|mjs|cjs|md|json|py|sh|ps1|bat|cmd|svelte|vue|css|scss|html|yml|yaml|toml|go|rs|java|rb|php|sql|c|cpp|h|hpp|txt|cfg|ini|xml)\b/i;
  // Tokens that look like a `.js` file but are really a runtime/library name in prose.
  const DENY = new Set(['node.js', 'next.js', 'nuxt.js', 'vue.js', 'three.js', 'd3.js', 'express.js', 'react.js', 'ember.js', 'backbone.js', 'jquery.js', 'angular.js', 'p5.js']);
  const hasIndex = !!(fileset && fileset.size);
  const norm = (r) => r.toLowerCase().replace(/^[.~]?[\\/]/, '').replace(/\\/g, '/').replace(/\/+$/, '');
  // H4: distinguish "this exact path exists" from "only the basename exists elsewhere"
  // (the file moved / the doc's path is stale). exact = keep; moved = amber review.
  const existsExact = (r) => {
    const lr = norm(r);
    if (projectRoot && lr) { try { if (fs.existsSync(path.join(projectRoot, lr))) return true; } catch (_) {} }
    return hasIndex && fileset.has(lr);
  };
  const basenameElsewhere = (r) => {
    if (!hasIndex) return null;
    const base = norm(r).split('/').pop();
    if (!base || base.length < 4 || !fileset.has(base)) return null;
    for (const f of fileset) if (f.includes('/') && f.split('/').pop() === base) return f;   // suggest a real path
    return base;
  };

  // H1: pasted live secrets — a security flag, not just dead weight.
  const SECRET_RES = [
    [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/, 'a JWT / API token'],
    [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, 'a Telegram bot token'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'a GitHub token'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
    [/\bsk-[A-Za-z0-9]{20,}\b/, 'an API secret key'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/\bftp[.:@][^\s]*\s*[\/|]\s*\S+\s*[\/|]\s*\S{6,}/i, 'FTP credentials'],
  ];
  const SECRET_KV = /(?:api[_-]?key|secret|password|passwd|pwd|anon[_-]?key|service[_-]?role|access[_-]?key|client[_-]?secret|auth[_-]?token|bearer)["'`]?\s*[:=]\s*["'`]?([^\s"'`]{12,})/i;
  const PLACEHOLDER = /^(your|my|the|<|\{|\$|x{3,}|example|changeme|placeholder|todo|none|null|test|abc|123|\.\.\.|\*{3,})/i;
  const secretIn = (line) => {
    for (const [re, label] of SECRET_RES) if (re.test(line)) return label;
    const m = SECRET_KV.exec(line);
    if (m) { const v = m[1]; if (!PLACEHOLDER.test(v) && v.length >= 16 && /[A-Za-z]/.test(v) && /\d/.test(v)) return 'a credential'; }
    return null;
  };

  // H2: generic boilerplate present verbatim in most projects — no project-specific value.
  const BOILERPLATE = new Set([
    'this file provides guidance to claude code (claude.ai/code) when working with code in this repository.',
    'this file provides guidance to claude code when working with code in this repository.',
  ]);
  // H3: date-stamped change/status markers — strong staleness signal, worth re-confirming.
  const DATED = /\b(added|updated|fixed|resolved|spec'?(?:ed|c?d)|decided|implemented|scaffolded|as of|last updated)\b[^.]{0,40}?\b20\d\d(?:[-/]\d{1,2}){0,2}\b/i;
  const DATE_PAREN = /\(\s*20\d\d-\d{1,2}-\d{1,2}\s*\)/;

  // Amber "review" lens: unchecked to-dos + anything under a "planning / open questions" heading.
  const STALE_HEAD = /^#{1,6}\s*(open questions?|decisions? needed|to ?-?do|wip|work in progress|draft|roadmap|future(\s+work)?|someday|ideas|brainstorm|backlog|scratch|notes? to self)\b/i;
  const UNCHECKED = /^[-*]\s*\[ \]\s/;
  const lines = String(text).split('\n');
  const out = [];
  let cutTokens = 0, staleSection = false;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    const tokens = Math.round((raw.length + 1) / 4);
    const isHeader = /^#{1,6}\s/.test(t);
    if (isHeader) staleSection = STALE_HEAD.test(t);    // entering / leaving a planning section
    let status = 'keep', reason = '';
    if (!t) status = 'blank';
    else if (BOILERPLATE.has(t.toLowerCase().replace(/\s+/g, ' '))) { status = 'cut'; reason = 'generic boilerplate — identical across projects, no project value'; cutTokens += tokens; }
    else if (isHeader || /^[-=*_]{3,}$/.test(t)) status = 'structural';
    else {
      const refs = [];
      let m;
      const bt = /`([^`]+)`/g; while ((m = bt.exec(t))) refs.push(m[1]);
      const pathRe = /(?:\.{0,2}[\\/]|~[\\/])?[\w.-]+[\\/][\w./\\-]+|\b[\w-]+\.(?:js|ts|tsx|jsx|md|json|py|sh|ps1|svelte|css|html|yml|yaml|toml|go|rs|java|rb|php|sql)\b/g;
      while ((m = pathRe.exec(t))) refs.push(m[0]);
      // strip trailing sentence punctuation the path regex may have grabbed ("src/app.js." → "src/app.js")
      const fileRefs = refs.map((r) => r.replace(/[.,;:!?)\]}>'"`]+$/, '')).filter((r) => FILEISH.test(r) && !DENY.has(r.toLowerCase()));
      if (!refs.length) { status = 'prose'; reason = 'no concrete reference to measure'; }
      else if (!fileRefs.length) {
        if (GUARD.test(t)) { status = 'guard'; reason = 'guardrail / constraint — kept'; }
        else { status = 'prose'; reason = 'no file reference to measure'; }
      } else {
        const hasSep = (r) => /[\\/]/.test(r);
        // bare-name refs match by basename (lenient); path refs must hit the exact path.
        let used = null, moved = null;
        for (const r of fileRefs) {
          if (existsExact(r) || (!hasSep(r) && hasIndex && fileset.has(norm(r).split('/').pop()))) { used = r; break; }
          if (!moved && hasSep(r) && basenameElsewhere(r)) moved = r;
        }
        if (used) { status = 'used'; reason = `\`${used}\` exists in the project`; }
        else if (moved) { status = 'review'; reason = `\`${moved}\` not found — but \`${basenameElsewhere(moved)}\` exists; path may have moved`; }
        else if (GUARD.test(t)) { status = 'guard'; reason = 'guardrail / constraint — kept even if unused'; }
        else if (hasIndex) { status = 'cut'; reason = `\`${fileRefs[0]}\` — no such file in the project`; cutTokens += tokens; }
        else { status = 'prose'; reason = 'could not index the project to verify'; }
      }
    }
    // Amber overlay (H3 + planning) — never overrides a confirmed 'cut' or a real 'used' file.
    if (UNCHECKED.test(t)) { status = 'review'; reason = 'unchecked to-do — likely unfinished or stale'; }
    else if (staleSection && (status === 'prose' || status === 'structural')) {
      status = 'review';
      reason = isHeader ? 'a “planning / open questions” heading — review whether the section is still needed' : 'under a planning / open-questions heading — review';
    } else if ((status === 'prose' || status === 'structural' || status === 'guard') && (DATED.test(t) || DATE_PAREN.test(t))) {
      status = 'review'; reason = 'dated note — re-confirm it still matches the current code';
    }
    // H1 secrets override everything (security takes precedence over any other verdict).
    const secret = secretIn(raw);
    if (secret) { status = 'secret'; reason = `looks like ${secret} — remove it from CLAUDE.md AND rotate the key`; }
    out.push({ n: i + 1, text: raw, tokens, status, reason });
  });
  return { lines: out, cutTokens };
}
// Claude Code loads CLAUDE.md by walking UP the tree, so a session in a subdir
// (e.g. <repo>/bridge) still uses <repo>/CLAUDE.md. Resolve the nearest one.
function nearestClaudeMd(cwd, home) {
  let dir = path.resolve(cwd);
  const homeR = path.resolve(home);
  for (let i = 0; i < 15; i++) {
    if (path.resolve(dir) === homeR) break;   // ~/.claude global is audited separately, not as a project file
    const a = path.join(dir, 'CLAUDE.md'), b = path.join(dir, '.claude', 'CLAUDE.md');
    if (fs.existsSync(a)) return a;
    if (fs.existsSync(b)) return b;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
// Green side of the audit: things the project clearly uses but CLAUDE.md doesn't mention.
// Deterministic — driven by what's on disk (package.json scripts/deps, key config files,
// a tests dir), NOT by transcript activity. Advisory only — not auto-applied.
function suggestAdditions(projectRoot, text) {
  const out = [];
  const lc = String(text).toLowerCase();
  const mentioned = (s) => lc.includes(String(s).toLowerCase());
  const add = (t, reason) => { if (out.length < 12 && !out.some((o) => o.text === t)) out.push({ text: t, reason }); };
  const exists = (rel) => { try { return fs.existsSync(path.join(projectRoot, rel)); } catch (_) { return false; } };

  // 1) package.json — undocumented scripts + notable frameworks/runtimes
  const KNOWN = { svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', react: 'React', vue: 'Vue', next: 'Next.js',
    nuxt: 'Nuxt', '@angular/core': 'Angular', express: 'Express', fastify: 'Fastify', koa: 'Koa', vite: 'Vite',
    typescript: 'TypeScript', tailwindcss: 'Tailwind CSS', vitest: 'Vitest', jest: 'Jest', mocha: 'Mocha',
    electron: 'Electron', prisma: 'Prisma', drizzle: 'Drizzle', webpack: 'webpack', rollup: 'Rollup' };
  const frameworks = new Set();
  for (const d of ['', 'web', 'bridge', 'app', 'client', 'server', 'frontend', 'backend']) {
    let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, d, 'package.json'), 'utf8')); } catch (_) { continue; }
    if (pkg.scripts) for (const name of Object.keys(pkg.scripts)) {
      if (/^(pre|post)/.test(name)) continue;
      const cmd = `npm run ${name}`;
      if (!mentioned(cmd) && !mentioned(`run ${name}`)) add(d ? `${cmd}   (in ${d}/)` : cmd, `package.json defines the "${name}" script — document how to run it`);
    }
    for (const k of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) if (KNOWN[k]) frameworks.add(KNOWN[k]);
  }
  for (const fw of frameworks) if (!mentioned(fw)) add(`note the stack: ${fw}`, 'a key dependency — name it so Claude knows the conventions');

  // 2) key config / infra files that exist but aren't documented
  for (const [f, why] of [
    ['Dockerfile', 'containerized — document how to build/run the image'],
    ['docker-compose.yml', 'document the compose services'],
    ['Makefile', 'document the make targets'],
    ['.env.example', 'document the required environment variables'],
    ['.github/workflows', 'CI is configured here — note what it runs'],
    ['prisma/schema.prisma', 'the database schema lives here'],
    ['pyproject.toml', 'Python project config — note setup/run'],
    ['requirements.txt', 'document the Python dependencies / setup'],
    ['go.mod', 'Go module — note build/run'],
    ['Cargo.toml', 'Rust crate — note build/run'],
  ]) {
    const base = f.split('/').pop().toLowerCase();
    if (exists(f) && !mentioned(base) && !mentioned(f)) add(f, why);
  }

  // 3) tests exist but testing isn't mentioned anywhere
  if ((exists('test') || exists('tests') || exists('__tests__')) && !/\btest(s|ing)?\b/.test(lc)) add('how to run the tests', "a tests directory exists but CLAUDE.md doesn't mention testing");

  return out.slice(0, 12);
}
// Shared audit pass — used by both the report (/api/claudemd-audit) and apply
// (/api/claudemd-apply), so the server writes exactly what it measured (never client text).
function runClaudeMdAudit(rawCwd) {
  const cwd = path.resolve(String(rawCwd));
  const cmPath = nearestClaudeMd(cwd, os.homedir());
  if (!cmPath) return { exists: false, path: claudeMdFor('project', cwd, os.homedir()) };
  const text = readTextSafe(cmPath) || '';
  const cmDir = path.dirname(cmPath);
  const projectRoot = path.basename(cmDir).toLowerCase() === '.claude' ? path.dirname(cmDir) : cmDir;
  const fileset = projectFileIndex(projectRoot);
  const { lines, cutTokens } = auditClaudeMd(text, fileset, projectRoot);
  const additions = suggestAdditions(projectRoot, text);
  return {
    exists: true, path: cmPath, text, lines, cutTokens, additions,
    totalTokens: Math.round((text.length + 1) / 4), windowMax: 200000,
    measured: fileset.size > 0, indexed: fileset.size,
  };
}

// Launch a Claude Code session in a new terminal at cwd (optionally resuming one).
// Flags appended to `claude` for ▶ Start / ＋ New task, from the Config panel.
// permMode: '' (ask, default) | 'acceptEdits' | 'plan' | 'bypass' (skip all prompts).
function buildLaunchFlags() {
  const parts = [];
  if (cfg.launchPermMode === 'bypass') parts.push('--dangerously-skip-permissions');
  else if (cfg.launchPermMode === 'acceptEdits') parts.push('--permission-mode acceptEdits');
  else if (cfg.launchPermMode === 'plan') parts.push('--permission-mode plan');
  const extra = cfg.launchFlags ? String(cfg.launchFlags).replace(/[\r\n]+/g, ' ').trim() : '';
  if (extra) parts.push(extra);
  return parts.join(' ');
}

// ── routines / briefings ─────────────────────────────────────────────────────
function claudeCliRaw() { return (cfg.claudeCmd && String(cfg.claudeCmd).trim()) || 'claude'; }
function onBriefing(b) {
  pushFeed({ ts: Date.now(), agentId: 'routine', agent: b.name, project: b.project || '', sessionId: '', state: b.ok ? 'done' : 'error', log: b.ok ? `briefing ready (${Math.round(b.ms / 1000)}s)` : ('briefing failed: ' + b.error), error: !b.ok });
  const r = routines.listRoutines().find((x) => x.id === b.routineId);
  if (r && r.notify) sendTelegram(`📋 <b>${b.name}</b> ${b.ok ? 'ready' : 'failed'}\n${String(b.ok ? b.output : b.error).slice(0, 700)}`);
}
function runRoutineOpts() { return { cli: claudeCliRaw(), onDone: onBriefing }; }

// The (brief) window title we set at launch, before Claude renames the terminal to
// "Claude Code". capture-window.ps1 finds the window by this so we can target by PID.
function launchTitle(cwd) { return 'Gander: ' + (path.basename(cwd || '') || 'Claude'); }

// cwd-keyed map of captured session window PIDs (so quick-keys / nudge can target the
// window even after Claude renames its title). Windows only.
const sessionWindows = new Map();
function captureWin(cwd) {
  if (process.platform !== 'win32' || !cwd) return;
  const title = launchTitle(cwd);
  try {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS_DIR, 'capture-window.ps1'), '-Title', title, '-TimeoutMs', '6000'],
      { timeout: 8000, windowsHide: true }, (err, stdout) => {
        const pid = parseInt(String(stdout || '').trim(), 10);
        if (pid > 0) { sessionWindows.set(projKeyOf(cwd), { pid, ts: Date.now() }); console.log(`[capture] window pid ${pid} for ${title}`); }
      });
  } catch (_) {}
}

function launchSession(cwd, resume, prompt) {
  if (resume && !/^[\w-]+$/.test(resume)) return { error: 'bad session id' };
  // cwd is interpolated into the shell command lines below (inside single quotes on
  // macOS/Linux, and the window title on Windows). Reject break-out chars — real
  // directory paths never contain them — so a crafted path can't inject a command.
  if (cwd && /["'`$\r\n]/.test(String(cwd))) return { error: 'unsupported characters in path' };
  // optional initial task: it rides inside double quotes in the launched command, so
  // neutralize quote break-out ("), cmd %var% expansion, and bash $()/backtick command
  // substitution; then cap length. (A launch "seed task" rarely needs those chars.)
  const task = prompt ? String(prompt).replace(/["'`$%\r\n]+/g, ' ').trim().slice(0, 1500) : '';
  // the launcher uses `claude` on PATH by default; let users point at a full path
  // (aoc-config.json claudeCmd or the Config panel) if `claude` isn't on PATH.
  const rawCli = (cfg.claudeCmd && String(cfg.claudeCmd).trim()) || 'claude';
  const cli = (/\s/.test(rawCli) && !/^["']/.test(rawCli)) ? `"${rawCli}"` : rawCli;
  const flags = buildLaunchFlags();
  const base = flags ? `${cli} ${flags}` : cli;
  const inner = resume ? `${base} --resume ${resume}` : (task ? `${base} "${task}"` : base);
  // The bridge is usually started by a Claude session, so it carries CLAUDECODE /
  // CLAUDE_CODE_* — a child terminal would inherit them and Claude refuses to launch
  // ("cannot be launched inside another Claude Code session"). Strip them so the new
  // session starts as an independent top-level session.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE_?CODE/i.test(k)) delete env[k];
  try {
    if (process.platform === 'win32') {
      spawn(`start "${launchTitle(cwd)}" cmd /k ${inner}`, { cwd, shell: true, detached: true, stdio: 'ignore', env }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell app "Terminal" to do script "cd '${cwd}' && unset CLAUDECODE CLAUDE_CODE_SSE_PORT CLAUDE_CODE_ENTRYPOINT && ${inner}"`], { detached: true, stdio: 'ignore', env }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', `bash -c "cd '${cwd}'; unset CLAUDECODE CLAUDE_CODE_SSE_PORT CLAUDE_CODE_ENTRYPOINT; ${inner}; exec bash"`], { detached: true, stdio: 'ignore', env }).unref();
    }
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

function execGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 60000, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, out: ((stdout || '') + (stderr || '')).trim() });
    });
  });
}

// Safe-ish source-control helpers, invoked explicitly from the dashboard.
async function gitAction(cwd, action, message, arg) {
  if (action === 'pull') { const r = await execGit(cwd, ['pull']); return { ok: r.code === 0, output: r.out }; }
  if (action === 'fetch') { const r = await execGit(cwd, ['fetch', '--all', '--prune']); return { ok: r.code === 0, output: r.out }; }
  if (action === 'commit-push') {
    const msg = (message && String(message).trim()) || 'Update from Gander';
    let out = '';
    let r = await execGit(cwd, ['add', '-A']); out += r.out;
    r = await execGit(cwd, ['commit', '-m', msg]); out += (out ? '\n' : '') + r.out;
    if (r.code !== 0) { return { ok: false, output: out }; } // e.g. nothing to commit
    r = await execGit(cwd, ['push']); out += '\n' + r.out;
    return { ok: r.code === 0, output: out.trim() };
  }
  if (action === 'diff') {
    const stat = await execGit(cwd, ['diff', '--stat']);
    const full = await execGit(cwd, ['diff']);
    return { ok: true, stat: stat.out, diff: full.out.slice(0, 20000) || '(no unstaged changes)' };
  }
  if (action === 'branches') {
    const cur = await execGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const all = await execGit(cwd, ['branch', '--format=%(refname:short)']);
    return { ok: true, current: (cur.out || '').trim(), branches: all.out ? all.out.split('\n').map((s) => s.trim()).filter(Boolean) : [] };
  }
  if (action === 'checkout' || action === 'newbranch') {
    const br = String(arg || '').trim();
    if (!br || !/^[\w./-]+$/.test(br)) return { error: 'invalid branch name' };
    const r = await execGit(cwd, action === 'newbranch' ? ['checkout', '-b', br] : ['checkout', br]);
    return { ok: r.code === 0, output: r.out };
  }
  return { error: 'unknown action' };
}

function snapshot() {
  const list = Array.from(agents.values());
  for (const a of list) {
    const active = a.state !== 'idle' && a.state !== 'done';
    a.runaway = active && (a.runawayManual || ((Number(a.burnRate) || 0) >= BURN_ALERT && (a.burnStreak || 0) >= 2));
    if (a.root && a.cwd) { const w = sessionWindows.get(projKeyOf(a.cwd)); a.winPid = w ? w.pid : undefined; }
  }
  const byProject = {};
  for (const a of list) {
    const pj = a.project || 'unknown';
    if (!byProject[pj]) byProject[pj] = { project: pj, total: 0, sessions: new Set(), states: {} };
    byProject[pj].total++;
    if (a.sessionId) byProject[pj].sessions.add(a.sessionId);
    byProject[pj].states[a.state] = (byProject[pj].states[a.state] || 0) + 1;
  }
  const projects = Object.values(byProject).map((p) => ({
    project: p.project, total: p.total, sessions: p.sessions.size, states: p.states, muted: muted.has(p.project),
  }));
  const pending = {};
  for (const [sid, q] of commands) if (q.length) pending[sid] = q.length;
  return { agents: list, projects, muted: [...muted], pending, budget: budgetState };
}

// ── Claude Code hook payload → registry events ───────────────────────────────
// Maps the raw JSON a Claude Code hook POSTs to /api/hook into agent updates,
// so the dashboard is driven automatically by real tool activity (no piping).
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function toolDetail(p) {
  const i = p.tool_input || {};
  if (i.file_path) return ' ' + String(i.file_path).split(/[\\/]/).pop();
  if (i.command) return ' ' + String(i.command).slice(0, 40);
  if (i.pattern) return ' /' + i.pattern + '/';
  if (i.description) return ' ' + String(i.description).slice(0, 40);
  return '';
}

function toolState(name, input) {
  if (!name) return 'thinking';
  if (/^(Read|Glob|LS|NotebookRead)$/.test(name)) return 'reading';
  if (/^(Grep|WebSearch|WebFetch)$/.test(name)) return 'reading';
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return 'coding';
  if (name === 'Bash') {
    const c = ((input && input.command) || '').toLowerCase();
    return /\b(test|jest|pytest|vitest|mocha|go test|cargo test)\b/.test(c) ? 'testing' : 'coding';
  }
  if (name === 'Task') return 'spawning';
  if (/^mcp__/.test(name)) return 'reading';
  return 'thinking';
}

function mapHookToEvents(p) {
  const project = projectFromCwd(p.cwd);
  const sessionId = p.session_id || 'unknown';
  const rootId = 'sess:' + sessionId;              // each session is its own root node
  const sub = p.agent_id && p.agent_id !== p.session_id;
  const subId = 'agent:' + p.agent_id;
  const base = { project, sessionId, cwd: p.cwd };
  switch (p.hook_event_name) {
    case 'SessionStart':
      return [{ ...base, agentId: rootId, name: project, root: true, state: 'thinking', log: 'session started · ' + project }];
    case 'UserPromptSubmit':
      return [{ ...base, agentId: rootId, name: project, root: true, state: 'thinking', log: (p.prompt || 'new prompt').slice(0, 60) }];
    case 'PostToolUse': {
      const id = sub ? subId : rootId;
      const out = [];
      if (sub) out.push({ ...base, agentId: id, parentId: rootId, name: p.agent_type || ('sub-' + String(p.agent_id).slice(0, 6)), ...projects.agentMeta(p.cwd, p.agent_type) });
      else out.push({ ...base, agentId: id, root: true, name: project });
      out.push({ ...base, agentId: id, state: toolState(p.tool_name, p.tool_input), log: (p.tool_name || 'tool') + toolDetail(p) });
      return out;
    }
    case 'PostToolUseFailure': {
      const id = sub ? subId : rootId;
      const out = [];
      if (sub) out.push({ ...base, agentId: id, parentId: rootId, name: p.agent_type || ('sub-' + String(p.agent_id).slice(0, 6)), ...projects.agentMeta(p.cwd, p.agent_type) });
      else out.push({ ...base, agentId: id, root: true, name: project });
      out.push({ ...base, agentId: id, state: 'error', log: (p.tool_name || 'tool') + ' failed' });
      return out;
    }
    case 'SubagentStart':
      return [{ ...base, agentId: subId, parentId: rootId, name: p.agent_type || 'subagent', state: 'spawning', log: 'subagent started', ...projects.agentMeta(p.cwd, p.agent_type) }];
    case 'SubagentStop':
      return [{ ...base, agentId: subId, state: 'done', log: 'subagent finished' }];
    case 'Notification': {
      const kind = String(p.message || p.notification_type || p.type || '').toLowerCase();
      if (/auth|success|login/.test(kind)) return [];   // not an input request
      const reason = p.message ? String(p.message) : 'Claude is waiting for your input';
      return [{ ...base, agentId: rootId, root: true, name: project, state: 'awaiting', log: reason.slice(0, 80), awaitMsg: reason.slice(0, 200) }];
    }
    case 'Stop':
      return [{ ...base, agentId: rootId, root: true, name: project, state: 'idle', log: 'turn complete', lastMessage: p._lastMessage }];
    case 'SessionEnd':
      return [{ ...base, agentId: rootId, root: true, name: project, state: 'idle', closed: true, log: 'session ended' }];
    default:
      return [];
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
// C1: operator-set command strings (editor / claude CLI / launch flags) get
// interpolated into shell:true command lines, so reject shell metacharacters that
// could break out and execute. Apostrophes and parens are allowed (real Windows
// paths: "C:\Users\O'Brien", "Program Files (x86)").
const SHELL_META = /["`$&|;<>^%\r\n]/;
function badCliString(v) { return SHELL_META.test(String(v == null ? '' : v)); }

// C3: confine cwd-taking endpoints to directories the user actually manages —
// configured project roots (and anything under them), known session cwds, live
// agent cwds, or ~/.claude (global). Blocks a crafted cwd from rooting a write or
// read elsewhere on disk. The literal 'global' maps to the user home.
function isAllowedCwd(cwd) {
  if (!cwd) return false;
  if (cwd === 'global') return true;
  let k; try { k = projects.keyOf(cwd); } catch (_) { return false; }
  if (k === projects.keyOf(os.homedir())) return true;
  const under = (base) => {
    let b; try { b = projects.keyOf(base); } catch (_) { return false; }
    return !!b && (k === b || k.startsWith(b + path.sep));
  };
  const pc = projects.getConfig();
  if ((pc.roots || []).some(under)) return true;
  if ((pc.known || []).some(under)) return true;
  for (const a of agents.values()) if (a && a.cwd && under(a.cwd)) return true;
  return false;
}
function assertCwd(res, cwd) {
  if (isAllowedCwd(cwd)) return true;
  sendJson(res, 403, { error: "that folder isn't a known project — add it under Manage → Projects first" });
  return false;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  const base = webRoot();
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(base, path.normalize(rel));
  // prevent path traversal outside the web root
  if (!filePath.startsWith(base)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' };
    // index.html points at content-hashed bundles, so it must never be cached or a new
    // build won't load. The hashed assets themselves are safe to cache forever.
    if (/(^|[\\/])index\.html$/.test(filePath)) headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    else if (/[\\/]assets[\\/]/.test(filePath)) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    res.writeHead(200, headers);
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve(null); }
    });
  });
}
// Larger-limit reader for image uploads (base64 data URLs are big).
function readBodyLarge(req, maxBytes = 14e6) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > maxBytes) { try { req.destroy(); } catch (_) {} resolve(null); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // Localhost-only guard (unless remote access is explicitly enabled): reject a
  // non-loopback Host header (defeats DNS-rebinding) and any cross-origin request
  // (defeats a malicious web page CSRFing the bridge). No Origin = server-side hook
  // POSTs, which are allowed.
  if (!ALLOW_REMOTE) {
    const host = String(req.headers.host || '');
    if (!/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(host)) { res.writeHead(403); res.end('forbidden'); return; }
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(origin)) { res.writeHead(403); res.end('forbidden'); return; }
  }

  if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

  if (url === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, snapshot());
  }

  if (url === '/api/feed' && req.method === 'GET') {
    return sendJson(res, 200, { events: feed.slice(0, 200) });
  }

  if (url === '/api/search' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await search.search(body && body.q, body || {}));
  }

  if (url === '/api/budget' && req.method === 'GET') {
    return sendJson(res, 200, budgetState);
  }
  if (url === '/api/budget' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    if (body.daily !== undefined) { budget.daily = Number(body.daily) || 0; cfg.dailyBudget = budget.daily; }
    if (body.session !== undefined) { budget.session = Number(body.session) || 0; cfg.sessionBudget = budget.session; }
    if (body.enforce !== undefined) { budget.enforce = !!body.enforce; cfg.budgetEnforce = budget.enforce; }
    saveConfig();
    await checkBudget();
    return sendJson(res, 200, budgetState);
  }

  if (url === '/api/license' && req.method === 'GET') {
    return sendJson(res, 200, licenseState);
  }

  if (url === '/api/event' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    const result = upsert(body);
    const code = result.error ? 400 : 200;
    if (!result.error) {
      console.log(`[event] ${body.agentId} -> ${body.state || '(meta)'}${body.log ? '  «' + body.log + '»' : ''}`);
    }
    return sendJson(res, code, result);
  }

  if (url === '/api/hook' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    eventsReceived++;
    const project = projectFromCwd(body.cwd);
    if (body.session_id) lastActiveSession = body.session_id;
    if (body.cwd) projects.noteKnown(body.cwd);   // auto-import the project
    if (muted.has(project)) return sendJson(res, 200, { ok: true, muted: project, applied: 0 });
    const rootKey = 'sess:' + (body.session_id || 'unknown');
    const prevState = agents.get(rootKey) && agents.get(rootKey).state;
    const evs = mapHookToEvents(body);
    for (const ev of evs) upsert(ev);
    const rootNow = agents.get(rootKey);
    if (rootNow) {
      if (rootNow.state === 'awaiting' && prevState !== 'awaiting') {
        // entered "awaiting": nudge Telegram only if still unanswered after 30s
        clearTimeout(awaitTimers.get(rootKey));
        awaitTimers.set(rootKey, setTimeout(() => {
          const r = agents.get(rootKey);
          if (r && r.state === 'awaiting') maybeAlert(r);
          awaitTimers.delete(rootKey);
        }, 30000));
      } else if (rootNow.state !== 'awaiting' && awaitTimers.has(rootKey)) {
        clearTimeout(awaitTimers.get(rootKey)); awaitTimers.delete(rootKey);
      }
    }
    if (evs.length) console.log(`[hook] ${body.hook_event_name} (${project}) -> ${evs.map(e => e.agentId + ':' + (e.state || '')).join(', ')}`);

    // Deliver any queued operator command through the hook return channel.
    let deliver = null;
    const sid = body.session_id;
    if (sid) {
      if (body.hook_event_name === 'Stop') {
        const c = takeCommand(sid, (x) => x.type === 'message');
        if (c) deliver = { kind: 'stop-block', text: c.text };
      } else if (body.hook_event_name === 'PreToolUse') {
        const c = takeCommand(sid, (x) => x.type === 'stop');
        if (c) deliver = { kind: 'pretool-deny', text: c.text || 'The operator requested STOP. Stop running tools, end your turn, and wait for further instructions.' };
      }
    }
    if (deliver) console.log(`[deliver] ${sid} <- ${deliver.kind}`);
    return sendJson(res, 200, { ok: true, applied: evs.length, deliver });
  }

  if (url === '/api/mute' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.project) return sendJson(res, 400, { error: 'project required' });
    const unmute = body.muted === false;
    if (unmute) muted.delete(body.project); else muted.add(body.project);
    saveMutes();
    // When muting, drop that project's existing tiles so it leaves the grid immediately.
    if (!unmute) { for (const [k, a] of agents) if ((a.project || 'unknown') === body.project) agents.delete(k); saveRegistry(); }
    console.log(`[mute] ${body.project} -> ${unmute ? 'unmuted' : 'muted'}`);
    return sendJson(res, 200, { ok: true, muted: [...muted] });
  }

  if (url === '/api/command' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    const r = queueCommand(body.sessionId, body.type || 'message', body.text);
    if (!r.error) {
      console.log(`[command] ${body.sessionId} <- ${body.type || 'message'}: ${String(body.text || '').slice(0, 60)}`);
      const k = 'sess:' + body.sessionId;                 // you replied → cancel the pending Telegram nudge
      if (awaitTimers.has(k)) { clearTimeout(awaitTimers.get(k)); awaitTimers.delete(k); }
      maybeNudge();                                        // wake a parked session right away
    }
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/inspect' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const sidParam = u.searchParams.get('session') || '';
    const rootId = sidParam.startsWith('sess:') ? sidParam : 'sess:' + sidParam;
    const root = agents.get(rootId) || agents.get(sidParam);
    const cwd = (root && root.cwd) || u.searchParams.get('cwd') || '';
    if (cwd && !isAllowedCwd(cwd)) return sendJson(res, 403, { error: 'cwd not in an allowed project' });
    const subagents = Array.from(agents.values())
      .filter((a) => root && a.parentId === root.id)
      .map((a) => ({ id: a.id, name: a.name, state: a.state }));
    return sendJson(res, 200, { cwd, subagents, ...inspectProject(cwd) });
  }

  if (url === '/api/copy-skill' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    const r = copySkill(body.fromCwd, body.toCwd, body.skill);
    if (!r.error) console.log(`[copy-skill] ${body.skill}: ${body.fromCwd} -> ${body.toCwd}`);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/projects' && req.method === 'GET') {
    const list = projects.discover();
    const byPath = new Map(list.map((p) => [projects.keyOf(p.path), p]));
    for (const a of agents.values()) {
      if (!a.root || !a.cwd) continue;
      const rp = projects.keyOf(a.cwd);
      if (byPath.has(rp)) byPath.get(rp).running = true;
      else { const pr = projects.project(a.cwd); pr.running = true; pr.sources = ['session']; byPath.set(rp, pr); list.push(pr); }
    }
    return sendJson(res, 200, { roots: projects.getConfig().roots, projects: list, muted: [...muted] });
  }

  if (url === '/api/projects/roots' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.path) return sendJson(res, 400, { error: 'path required' });
    const c = body.action === 'remove' ? projects.removeRoot(body.path) : projects.addRoot(body.path);
    return sendJson(res, 200, { ok: true, roots: c.roots });
  }

  if (url === '/api/pick-folder' && req.method === 'POST') {
    if (process.platform !== 'win32') return sendJson(res, 200, { cancelled: true, error: 'native picker is Windows-only — type a path instead' });
    const ps = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Select a folder that holds Claude projects'; $d.ShowNewFolderButton=$false; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::Out.Write($d.SelectedPath) }";
    let out = '';
    let done = false;
    const finish = (obj) => { if (done) return; done = true; sendJson(res, 200, obj); };
    try {
      const child = spawn('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: false });
      child.stdout.on('data', (c) => (out += c));
      child.on('error', () => finish({ cancelled: true, error: 'picker failed' }));
      child.on('close', () => {
        const p = out.trim();
        if (!p) return finish({ cancelled: true });
        projects.addRoot(p);
        console.log(`[projects] added root via picker: ${p}`);
        finish({ ok: true, path: p, roots: projects.getConfig().roots });
      });
    } catch (_) { finish({ cancelled: true, error: 'picker failed' }); }
    return;
  }

  if (url === '/api/git-status' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await git.statusMany((body && body.paths) || []));
  }

  if (url === '/api/git-action' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd || !body.action) return sendJson(res, 400, { error: 'cwd and action required' });
    if (!fs.existsSync(body.cwd)) return sendJson(res, 400, { error: 'path not found' });
    const r = await gitAction(body.cwd, body.action, body.message, body.arg);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/launch' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd) return sendJson(res, 400, { error: 'cwd required' });
    if (!fs.existsSync(body.cwd)) return sendJson(res, 400, { error: 'path not found' });
    const r = launchSession(body.cwd, body.resume, body.prompt);
    if (r.ok) captureWin(body.cwd);   // remember the window's PID so quick-keys/nudge can reach it
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/usage' && req.method === 'GET') {
    return sendJson(res, 200, await usage.summaryAsync());
  }

  if (url === '/api/history' && req.method === 'GET') {
    return sendJson(res, 200, await history.list({}));
  }

  if (url === '/api/transcript' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await transcript.read(body && body.sessionId));
  }

  if (url === '/api/health' && req.method === 'GET') {
    let version = 'dev';
    try { version = require('../package.json').version || 'dev'; } catch (_) {}
    const sessions = new Set(Array.from(agents.values()).map((a) => a.sessionId).filter(Boolean)).size;
    const bridge = {
      uptimeMs: Date.now() - STARTED,
      port: argPort,
      eventsReceived,
      sessions,
      projectsKnown: projects.discover().length,
      version,
    };
    return sendJson(res, 200, { bridge, ...health.report() });
  }

  if (url === '/api/editor' && req.method === 'GET') {
    return sendJson(res, 200, { cmd: cfg.editorCmd || '' });
  }
  if (url === '/api/editor' && req.method === 'POST') {
    const body = await readBody(req);
    const val = body && body.cmd ? String(body.cmd).trim() : '';
    if (badCliString(val)) return sendJson(res, 400, { error: 'editor command can\'t contain shell metacharacters (" ` $ & | ; < > ^ %)' });
    cfg.editorCmd = val;
    saveConfig();
    return sendJson(res, 200, { ok: true, cmd: cfg.editorCmd });
  }

  if (url === '/api/claude-config' && req.method === 'GET') {
    return sendJson(res, 200, { cmd: cfg.claudeCmd || '', permMode: cfg.launchPermMode || '', flags: cfg.launchFlags || '' });
  }
  if (url === '/api/claude-config' && req.method === 'POST') {
    const body = await readBody(req);
    if (body && body.cmd !== undefined) {
      const v = String(body.cmd).trim();
      if (badCliString(v)) return sendJson(res, 400, { error: 'claude command can\'t contain shell metacharacters' });
      cfg.claudeCmd = v;
    }
    if (body && body.permMode !== undefined) cfg.launchPermMode = ['acceptEdits', 'plan', 'bypass'].includes(body.permMode) ? body.permMode : '';
    if (body && body.flags !== undefined) {
      const v = String(body.flags).replace(/[\r\n]+/g, ' ').trim();
      if (badCliString(v)) return sendJson(res, 400, { error: 'launch flags can\'t contain shell metacharacters' });
      cfg.launchFlags = v;
    }
    saveConfig();
    return sendJson(res, 200, { ok: true, cmd: cfg.claudeCmd || '', permMode: cfg.launchPermMode || '', flags: cfg.launchFlags || '' });
  }

  if (url === '/api/nudge-config' && req.method === 'GET') {
    return sendJson(res, 200, { onSend: !!cfg.nudgeOnSend, interval: Number(cfg.nudgeInterval) || 0 });
  }
  if (url === '/api/nudge-config' && req.method === 'POST') {
    const body = await readBody(req);
    if (body) {
      if (body.onSend !== undefined) cfg.nudgeOnSend = !!body.onSend;
      if (body.interval !== undefined) { cfg.nudgeInterval = Math.max(0, Math.min(1440, Number(body.interval) || 0)); rescheduleNudge(); }
      saveConfig();
    }
    return sendJson(res, 200, { ok: true, onSend: !!cfg.nudgeOnSend, interval: Number(cfg.nudgeInterval) || 0 });
  }

  if (url === '/api/telegram-config' && req.method === 'GET') {
    return sendJson(res, 200, { configured: !!(tg.token && tg.chat), hasToken: !!tg.token, chatId: tg.chat, dashboardUrl: tg.dash });
  }

  if (url === '/api/telegram-config' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    if (body.token !== undefined) { cfg.telegramToken = String(body.token).trim(); tg.token = cfg.telegramToken; }
    if (body.chatId !== undefined) { cfg.telegramChatId = String(body.chatId).trim(); tg.chat = cfg.telegramChatId; }
    if (body.dashboardUrl !== undefined) { cfg.dashboardUrl = String(body.dashboardUrl).trim(); tg.dash = cfg.dashboardUrl || tg.dash; }
    saveConfig();
    startTelegramPolling();
    if (body.test && tg.token && tg.chat) {
      return sendTelegram('✅ Gander: Telegram is connected.', (mid) =>
        sendJson(res, 200, { ok: true, configured: true, test: mid ? 'sent' : 'failed (check token/chat id)' }));
    }
    return sendJson(res, 200, { ok: true, configured: !!(tg.token && tg.chat) });
  }

  if (url === '/api/github' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd) return sendJson(res, 400, { error: 'cwd required' });
    if (body.kind === 'createPr') return sendJson(res, 200, await github.createPr(body.cwd, body));
    if (!github[body.kind]) return sendJson(res, 400, { error: 'kind must be info|prs|issues|createPr' });
    return sendJson(res, 200, await github[body.kind](body.cwd));
  }

  if (url === '/api/config-read' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd) return sendJson(res, 400, { error: 'cwd required' });
    if (!assertCwd(res, body.cwd)) return;
    return sendJson(res, 200, configmgr.read(body.cwd));
  }

  if (url === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd) return sendJson(res, 400, { error: 'cwd required' });
    if (!assertCwd(res, body.cwd)) return;
    let r;
    if (body.action === 'addMcp') r = configmgr.addMcp(body.cwd, body.server || body);
    else r = configmgr.del(body.cwd, body.action === 'delHook' ? 'hook' : 'mcp', body.name);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/component-diff' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    if (!assertCwd(res, body.fromCwd)) return;
    if (!assertCwd(res, body.toCwd)) return;
    return sendJson(res, 200, projects.diffComponent(body.type, body.name, body.fromCwd, body.toCwd));
  }

  if (url === '/api/component-read' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd) return sendJson(res, 400, { error: 'cwd required' });
    if (!assertCwd(res, body.cwd)) return;
    const r = projects.readComponent(body.type, body.name, body.cwd);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/component-write' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd || !body.path) return sendJson(res, 400, { error: 'cwd and path required' });
    if (!assertCwd(res, body.cwd)) return;
    const r = projects.writeComponent(body.cwd, body.path, body.content);
    if (!r.error) console.log(`[edit] ${body.path}`);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/routines' && req.method === 'GET') {
    return sendJson(res, 200, { routines: routines.listRoutines(), briefings: routines.listBriefings(60) });
  }
  if (url === '/api/routines' && req.method === 'POST') {
    const body = await readBody(req);
    const r = routines.upsertRoutine(body || {});
    return sendJson(res, r.error ? 400 : 200, r);
  }
  if (url === '/api/routines/delete' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, routines.deleteRoutine(body && body.id));
  }
  if (url === '/api/routines/run' && req.method === 'POST') {
    const body = await readBody(req);
    const r = routines.runRoutine(body && body.id, runRoutineOpts());
    return sendJson(res, r.error ? 400 : 200, r);
  }
  if (url === '/api/briefings' && req.method === 'GET') {
    return sendJson(res, 200, { briefings: routines.listBriefings(80) });
  }
  if (url === '/api/briefings/delete' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.id) return sendJson(res, 400, { error: 'id required' });
    return sendJson(res, 200, routines.deleteBriefing(body.id));
  }
  if (url === '/api/briefings/clear' && req.method === 'POST') {
    return sendJson(res, 200, routines.clearBriefings());
  }

  if (url === '/api/sendkeys' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.sessionId || !body.keys) return sendJson(res, 400, { error: 'sessionId and keys required' });
    // type a keystroke into the session's window (to answer interactive prompts).
    const root = agents.get('sess:' + body.sessionId) || Array.from(agents.values()).find((a) => a.sessionId === body.sessionId);
    const match = (root && root.project) || String(body.sessionId);
    const keys = String(body.keys).slice(0, 40);
    // Prefer the PID captured at launch (survives Claude renaming the title); fall back
    // to matching the window by project name (works for VS Code-hosted sessions).
    const win = root && root.cwd ? sessionWindows.get(projKeyOf(root.cwd)) : null;
    const cmd = process.platform === 'win32' ? 'powershell' : 'bash';
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS_DIR, 'sendkeys.ps1'), '-Match', match, '-Keys', keys, ...(win ? ['-WinPid', String(win.pid)] : [])]
      : [path.join(SCRIPTS_DIR, 'sendkeys.sh'), '--match', match, '--keys', keys];
    execFile(cmd, args, { timeout: 9000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '');
      const found = !/no open window|no window matched|install xdotool/i.test(out);
      sendJson(res, 200, { ok: true, found, match });
    });
    return;
  }

  if (url === '/api/focus-window' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.sessionId) return sendJson(res, 400, { error: 'sessionId required' });
    if (process.platform !== 'win32') return sendJson(res, 200, { ok: false, found: false, error: 'bringing a session window to the front is Windows-only for now' });
    // Raise the running session's terminal — different from "Open in VS Code" (which
    // opens the project folder): this jumps to the live window captured at launch.
    const root = agents.get('sess:' + body.sessionId) || Array.from(agents.values()).find((a) => a.sessionId === body.sessionId);
    const match = (root && root.project) || String(body.sessionId);
    const win = root && root.cwd ? sessionWindows.get(projKeyOf(root.cwd)) : null;
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS_DIR, 'focus-window.ps1'), '-Match', match, ...(win ? ['-WinPid', String(win.pid)] : [])];
    execFile('powershell', args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      const found = !/no window for/i.test(String(stdout || ''));
      sendJson(res, 200, { ok: true, found, hadPid: !!win });
    });
    return;
  }

  if (url === '/api/processes' && req.method === 'GET') {
    if (process.platform !== 'win32') return sendJson(res, 200, { processes: [], note: 'process inspection is Windows-only for now' });
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS_DIR, 'list-procs.ps1')],
      { timeout: 12000, windowsHide: true, maxBuffer: 12e6 }, (err, stdout) => {
        let data = { procs: [] };
        try { data = JSON.parse(String(stdout || '{}')); } catch (_) {}
        const all = Array.isArray(data.procs) ? data.procs : [];

        // child adjacency, for walking a session window's descendant tree
        const children = new Map();
        for (const p of all) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(p.pid); }
        const descendants = (root) => {
          const out = new Set(); const stack = [root];
          while (stack.length) { const x = stack.pop(); for (const ch of (children.get(x) || [])) { if (!out.has(ch)) { out.add(ch); stack.push(ch); } } }
          return out;
        };
        // each launched session's window pid → its descendant pids
        const sess = [];
        for (const a of agents.values()) {
          if (!a.root || !a.cwd) continue;
          const w = sessionWindows.get(projKeyOf(a.cwd));
          if (w) sess.push({ sid: a.sessionId || String(a.id).replace(/^sess:/, ''), project: a.project, set: descendants(w.pid) });
        }
        const knownProjects = [];
        for (const a of agents.values()) if (a.cwd) knownProjects.push({ cwd: String(a.cwd).toLowerCase(), project: a.project, sid: a.sessionId || String(a.id).replace(/^sess:/, '') });

        // "interesting" = the kind of thing Claude spawns from Bash and leaves open
        const INTERESTING = /^(node|python\d?|pythonw|py|deno|bun|npm|pnpm|yarn|vite|nodemon|next|ts-node|tsx|electron|webpack|esbuild|rollup|jest|vitest|gunicorn|uvicorn|flask|rails|ruby|go|dotnet|java|php|cargo|http-server|serve|ngrok)(\.exe)?$/i;
        const now = Date.now();
        const out = [];
        for (const p of all) {
          if (p.pid === process.pid) continue;                          // never list Gander's own bridge
          const name = String(p.name || '');
          const interesting = INTERESTING.test(name);
          let attribution = 'orphan', sid = null, project = null;
          for (const s of sess) { if (s.set.has(p.pid)) { attribution = 'session'; sid = s.sid; project = s.project; break; } }
          if (attribution !== 'session' && interesting) {
            const cmd = String(p.cmd || '').toLowerCase();
            const hit = knownProjects.find((k) => k.cwd && cmd.includes(k.cwd));
            if (hit) { attribution = 'project'; sid = hit.sid; project = hit.project; }
          }
          // drop system/service noise: a non-interesting process only shows if it's
          // provably a descendant of a Claude session window.
          if (!interesting && attribution !== 'session') continue;
          // PowerShell's ConvertTo-Json unwraps a single-element array to a scalar and
          // an empty one to {} — coerce both back to a clean array.
          const ports = Array.isArray(p.ports) ? p.ports : (p.ports != null && typeof p.ports !== 'object' ? [p.ports] : []);
          out.push({
            pid: p.pid, name, cmd: p.cmd, ports,
            started: p.started, uptimeMs: p.started ? Math.max(0, now - Date.parse(p.started)) : null,
            attribution, sessionId: sid, project,
          });
        }
        out.sort((a, b) => (b.ports.length - a.ports.length) || ((b.uptimeMs || 0) - (a.uptimeMs || 0)));
        sendJson(res, 200, { processes: out, generatedAt: new Date().toISOString() });
      });
    return;
  }

  if (url === '/api/kill-process' && req.method === 'POST') {
    const body = await readBody(req);
    const pid = Number(body && body.pid);
    if (!Number.isInteger(pid) || pid <= 4) return sendJson(res, 400, { error: 'invalid pid' });
    if (pid === process.pid) return sendJson(res, 400, { error: "refusing to kill Gander's own bridge process" });
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
        const out = (String(stdout || '') + String(stderr || '')).trim();
        const ok = /SUCCESS/i.test(out) || (!err && !/not found|no running/i.test(out));
        console.log(`[kill] pid ${pid} -> ${ok ? 'ok' : 'fail'}`);
        sendJson(res, 200, { ok, output: out });
      });
    } else {
      execFile('kill', ['-TERM', String(pid)], { timeout: 8000 }, (err, stdout, stderr) => {
        sendJson(res, 200, { ok: !err, output: (String(stdout || '') + String(stderr || '')).trim() });
      });
    }
    return;
  }

  if (url === '/api/memory-read' && req.method === 'POST') {
    const body = await readBody(req);
    const { scope, root, memoryDir, home } = memCtx(body);
    if (scope === 'project' && !assertCwd(res, root)) return;
    if (scope === 'project' && !fs.existsSync(root)) return sendJson(res, 400, { error: 'project path not found' });
    const cmPath = claudeMdFor(scope, root, home);
    const claudeMd = { path: cmPath, exists: fs.existsSync(cmPath), content: readTextSafe(cmPath) || '' };
    const indexPath = path.join(memoryDir, 'MEMORY.md');
    const index = { path: indexPath, exists: fs.existsSync(indexPath), content: readTextSafe(indexPath) || '' };
    const facts = [];
    try {
      for (const f of fs.readdirSync(memoryDir)) {
        if (!/\.md$/i.test(f) || f.toLowerCase() === 'memory.md') continue;
        const fp = path.join(memoryDir, f);
        const content = readTextSafe(fp) || '';
        facts.push({ file: f, path: fp, content, ...factMeta(content) });
      }
    } catch (_) {}
    facts.sort((a, b) => (a.name || a.file).localeCompare(b.name || b.file));
    return sendJson(res, 200, { ok: true, scope, root, memoryDir, claudeMd, index, facts });
  }

  if (url === '/api/memory-write' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body.content !== 'string') return sendJson(res, 400, { error: 'content required' });
    if (body.content.length > 2e6) return sendJson(res, 400, { error: 'content too large' });
    const { scope, root, memoryDir, home } = memCtx(body);
    if (scope === 'project' && !assertCwd(res, root)) return;
    let target;
    if (body.target === 'claudemd') target = claudeMdFor(scope, root, home);
    else if (body.target === 'index') target = path.join(memoryDir, 'MEMORY.md');
    else if (body.target === 'fact') {
      const file = String(body.file || '').replace(/[\\/]/g, '').trim();
      if (!/^[\w.-]+\.md$/i.test(file)) return sendJson(res, 400, { error: 'bad fact filename' });
      target = path.join(memoryDir, file);
    } else return sendJson(res, 400, { error: 'bad target' });
    if (!memPathAllowed(target, scope, root, home)) return sendJson(res, 400, { error: 'path not allowed' });
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body.content);
      console.log(`[memory] wrote ${target}`);
      return sendJson(res, 200, { ok: true, path: target });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  if (url === '/api/claudemd-audit' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd) return sendJson(res, 400, { error: 'cwd required' });
    if (!assertCwd(res, body.cwd)) return;
    const r = runClaudeMdAudit(body.cwd);
    const { text, ...rest } = r;        // don't echo the full file back; the lines carry it
    return sendJson(res, 200, { ok: true, ...rest });
  }

  // Apply the audit: write the trimmed CLAUDE.md (flagged lines removed) back to disk,
  // backing up the original to CLAUDE.md.bak first. The server recomputes the trim itself
  // (never trusts client-supplied content), so it only ever writes the audited result.
  if (url === '/api/claudemd-apply' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd) return sendJson(res, 400, { error: 'cwd required' });
    if (!assertCwd(res, body.cwd)) return;
    const r = runClaudeMdAudit(body.cwd);
    if (!r.exists) return sendJson(res, 400, { error: 'no CLAUDE.md to apply' });
    // Only lines the server itself currently flags as 'cut' are removable — so the client
    // can never delete a non-flagged line. If the client sent a selection, honour it
    // (matching line number AND text); otherwise remove all flagged lines.
    const removable = (s) => s === 'cut' || s === 'review' || s === 'secret';
    const flagged = new Map(r.lines.filter((l) => removable(l.status)).map((l) => [l.n, l.text]));
    let removeNs;
    if (Array.isArray(body.cuts)) {
      removeNs = new Set(body.cuts
        .filter((c) => c && flagged.has(c.n) && flagged.get(c.n) === c.text)
        .map((c) => c.n));
    } else {
      // default (no explicit selection): remove confident cuts + secrets, not amber review lines
      removeNs = new Set(r.lines.filter((l) => l.status === 'cut' || l.status === 'secret').map((l) => l.n));
    }
    if (!removeNs.size) return sendJson(res, 200, { ok: true, applied: 0, path: r.path, note: 'nothing to remove — file unchanged' });
    const removedTokens = r.lines.filter((l) => removeNs.has(l.n)).reduce((s, l) => s + (l.tokens || 0), 0);
    const trimmed = r.lines.filter((l) => !removeNs.has(l.n)).map((l) => l.text).join('\n');
    try {
      const bak = r.path + '.bak';
      fs.copyFileSync(r.path, bak);
      fs.writeFileSync(r.path, trimmed);
      console.log(`[claudemd] applied audit: -${removeNs.size} line(s), ~${removedTokens} tok · ${r.path} (backup ${bak})`);
      return sendJson(res, 200, { ok: true, applied: removeNs.size, cutTokens: removedTokens, path: r.path, backup: bak });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  if (url === '/api/memory-delete' && req.method === 'POST') {
    const body = await readBody(req);
    const { scope, root, memoryDir, home } = memCtx(body);
    if (scope === 'project' && !assertCwd(res, root)) return;
    const file = String((body && body.file) || '').replace(/[\\/]/g, '').trim();
    if (!/^[\w.-]+\.md$/i.test(file) || file.toLowerCase() === 'memory.md') return sendJson(res, 400, { error: 'bad fact filename' });
    const target = path.join(memoryDir, file);
    if (!memPathAllowed(target, scope, root, home)) return sendJson(res, 400, { error: 'path not allowed' });
    try { if (fs.existsSync(target)) fs.rmSync(target); console.log(`[memory] deleted ${target}`); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  if (url === '/api/drop-image' && req.method === 'POST') {
    const body = await readBodyLarge(req);
    if (!body || !body.dataUrl || !body.sessionId) return sendJson(res, 400, { error: 'sessionId and dataUrl required' });
    const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(body.dataUrl));
    if (!m) return sendJson(res, 400, { error: 'not a base64 image data URL' });
    const ext = ({ 'jpeg': 'jpg', 'svg+xml': 'svg' }[m[1].toLowerCase()] || m[1].toLowerCase()).replace(/[^a-z0-9]/g, '') || 'png';
    let buf; try { buf = Buffer.from(m[2], 'base64'); } catch (_) { return sendJson(res, 400, { error: 'bad base64' }); }
    if (buf.length > 16e6) return sendJson(res, 400, { error: 'image too large' });
    if (body.cwd && !assertCwd(res, body.cwd)) return;
    const cwd = body.cwd && fs.existsSync(body.cwd) ? body.cwd : null;
    const dir = cwd ? path.join(cwd, '.gander', 'drops') : path.join(os.tmpdir(), 'gander-drops');
    if (cwd) { const safeRoot = path.resolve(path.join(cwd, '.gander')); if (!path.resolve(dir).startsWith(safeRoot)) return sendJson(res, 400, { error: 'bad path' }); }
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (cwd) { const gi = path.join(cwd, '.gander', '.gitignore'); if (!fs.existsSync(gi)) { try { fs.writeFileSync(gi, '*\n'); } catch (_) {} } }   // keep drops out of git
      const safe = String(body.name || 'image').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'image';
      const file = path.join(dir, `${Date.now()}-${safe}.${ext}`);
      fs.writeFileSync(file, buf);
      const q = String(body.text || '').trim();
      const instr = `${q ? q + '\n\n' : ''}[Image attached via Gander] Open and look at this image with your Read tool:\n${file}`;
      queueCommand(body.sessionId, 'message', instr);
      maybeNudge();
      return sendJson(res, 200, { ok: true, path: file });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  if (url === '/api/component-generate' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.type || !body.prompt) return sendJson(res, 400, { error: 'type and prompt required' });
    // hand the request to a LIVE Claude session (no nested `claude -p`): queue an
    // instruction to use the component-builder skill, then nudge it awake.
    const roots = Array.from(agents.values()).filter((a) => a.root && !a.closed);
    const tcwds = (Array.isArray(body.targets) ? body.targets : []).filter((t) => t && t !== 'global').map((x) => String(x).toLowerCase());
    let sess = roots.find((a) => a.cwd && tcwds.includes(String(a.cwd).toLowerCase()));
    if (!sess) sess = roots.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (!sess) return sendJson(res, 200, { error: 'No running Claude session to hand off to — open one and try again.' });
    const sid = sess.sessionId || String(sess.id).replace(/^sess:/, '');
    const tg = (Array.isArray(body.targets) && body.targets.length ? body.targets : ['global']).map((t) => (t === 'global' ? 'global (~/.claude)' : t)).join(', ');
    const text = `Use the component-builder skill to create a ${body.type} from this request: "${String(body.prompt).replace(/"/g, "'").slice(0, 600)}". Deploy it to: ${tg}. Prefer the Gander bridge (POST http://localhost:3131/api/component-new) so it is validated, then tell me where it landed.`;
    queueCommand(sid, 'message', text);
    maybeNudge();
    return sendJson(res, 200, { ok: true, session: sess.project || sid.slice(0, 8), sid });
  }

  if (url === '/api/component-new' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.type || !body.name) return sendJson(res, 400, { error: 'type and name required' });
    const targets = Array.isArray(body.targets) && body.targets.length ? body.targets : [body.cwd];
    const results = [];
    for (const t of targets) {
      const dir = (t === 'global' || !t) ? os.homedir() : t;
      if (!isAllowedCwd(dir)) { results.push({ target: t === 'global' ? 'global' : dir, error: "not a known project — add it under Manage → Projects first" }); continue; }
      const r = projects.newComponent({
        type: body.type, dir, overwrite: !!body.overwrite,
        name: body.name, description: body.description, model: body.model,
        color: body.color, tools: body.tools, argumentHint: body.argumentHint, body: body.body,
      });
      results.push({ target: t === 'global' ? 'global' : dir, ...r });
      if (r.ok) console.log(`[new ${body.type}] ${r.path}`);
    }
    return sendJson(res, 200, { results });
  }

  if (url === '/api/copy-component' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    if (!assertCwd(res, body.fromCwd)) return;
    if (!assertCwd(res, body.toCwd)) return;
    const r = projects.copyComponent(body.type, body.name, body.fromCwd, body.toCwd, body.overwrite === true);
    if (!r.error) console.log(`[copy] ${body.type} ${body.name}: ${body.fromCwd} -> ${body.toCwd}`);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/open' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd) return sendJson(res, 400, { error: 'cwd required' });
    if (!fs.existsSync(body.cwd)) return sendJson(res, 400, { error: 'path not found' });
    openPath(body.cwd, body.target);
    console.log(`[open] ${body.target || 'folder'}: ${body.cwd}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/reset' && req.method === 'POST') {
    agents.clear();
    saveRegistry();
    console.log('[reset] registry cleared');
    return sendJson(res, 200, { ok: true });
  }

  return serveStatic(req, res);
});

// Security: bind to loopback only by default so the bridge (which can spawn
// processes, write hooks/MCP config, and kill PIDs) isn't exposed to the LAN.
// Opt into LAN access with AOC_ALLOW_REMOTE=1 / { "allowRemote": true } — trusted
// networks only. The in-handler guard below additionally blocks DNS-rebinding/CSRF.
const ALLOW_REMOTE = !!(process.env.AOC_ALLOW_REMOTE || cfg.allowRemote);
const BIND_HOST = ALLOW_REMOTE ? '0.0.0.0' : '127.0.0.1';

server.listen(argPort, BIND_HOST, () => {
  console.log(`Gander bridge listening on http://localhost:${argPort}${ALLOW_REMOTE ? '  (⚠ remote access enabled — trusted networks only)' : ''}`);
  console.log(`Dashboard:  http://localhost:${argPort}/`);
  console.log(`Push event: POST http://localhost:${argPort}/api/event`);
  startIngest();
  startTelegramPolling();
  setInterval(retireSweep, 12000);
  setInterval(checkBudget, 180000); setTimeout(checkBudget, 8000);
  setInterval(sampleBurn, 30000); setTimeout(sampleBurn, 6000);
  rescheduleNudge();   // periodic idle-session nudge (cfg.nudgeInterval minutes; 0 = off)
  setInterval(() => routines.tick(runRoutineOpts()), 30000);   // run scheduled routines (HH:MM)
  license.verify(LICENSE_KEY, cfg.gumroadProduct).then((s) => { licenseState = s; console.log(`[license] ${s.mode}`); });
});

// ── Optional inline ingest ───────────────────────────────────────────────────
// Feed Claude Code stream-json straight into the registry (no HTTP round-trip),
// so a single process both serves the dashboard AND ingests live events:
//   node bridge/server.js --run "claude -p '...' --output-format stream-json --verbose"
//   claude ... --output-format stream-json --verbose | node bridge/server.js --stdin
function startIngest() {
  const runIdx = process.argv.indexOf('--run');
  const useStdin = process.argv.includes('--stdin');
  if (runIdx === -1 && !useStdin) return;

  const parser = createParser();
  const feed = (line) => {
    let events = [];
    try { events = parser.parse(line); } catch (e) { console.error('[ingest] parse error:', e.message); }
    for (const ev of events) {
      const r = upsert(ev);
      if (!r.error) console.log(`[ingest] ${ev.agentId} -> ${ev.state || '(meta)'}`);
    }
  };

  let source;
  if (runIdx !== -1) {
    const cmd = process.argv[runIdx + 1];
    if (!cmd) { console.error('[ingest] --run needs a command string'); return; }
    console.log(`[ingest] spawning: ${cmd}`);
    const child = spawn(cmd, { shell: true, env: { ...process.env, CLAUDECODE: '' } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => console.log(`[ingest] child exited (code ${code})`));
    source = child.stdout;
  } else {
    console.log('[ingest] reading stream-json from stdin');
    source = process.stdin;
  }

  readline.createInterface({ input: source }).on('line', feed);
}
