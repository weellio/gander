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
const budget = { daily: Number(cfg.dailyBudget) || 0, session: Number(cfg.sessionBudget) || 0 };
let budgetState = { dailyCost: 0, daily: budget.daily, session: budget.session, overDaily: false, generatedAt: 0 };
const budgetAlerted = { day: '', sessions: new Set() };
function dayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
async function checkBudget() {
  try {
    const u = await usage.summaryAsync();
    const tk = dayKey();
    const day = (u.byDay || []).find((x) => x.date === tk);
    const dailyCost = day ? day.costUSD : 0;
    const overDaily = budget.daily > 0 && dailyCost >= budget.daily;
    budgetState = { dailyCost, daily: budget.daily, session: budget.session, overDaily, generatedAt: Date.now() };
    if (overDaily && budgetAlerted.day !== tk) {
      budgetAlerted.day = tk;
      sendTelegram(`💸 <b>Hivemind budget</b>\nToday's spend $${dailyCost.toFixed(2)} crossed your $${budget.daily} cap.`);
      pushFeed({ ts: Date.now(), agentId: 'budget', agent: 'budget', project: '', state: 'error', log: `Daily spend $${dailyCost.toFixed(2)} over $${budget.daily} cap`, error: true });
    }
    if (budget.session > 0 && u.bySession) {
      for (const [sid, s] of Object.entries(u.bySession)) {
        if (s.costUSD >= budget.session && !budgetAlerted.sessions.has(sid)) {
          budgetAlerted.sessions.add(sid);
          const ag = agents.get('sess:' + sid);
          sendTelegram(`💸 <b>Hivemind</b>\nSession ${ag ? ag.project : sid.slice(0, 8)} hit $${s.costUSD.toFixed(2)} (cap $${budget.session}).`);
        }
      }
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
    `🔔 <b>Hivemind</b>\n<b>${proj}</b> needs your input.\nReply to this message to answer, or open: ${tg.dash}`,
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
  if (ev.parentId !== undefined) existing.parentId = String(ev.parentId);
  if (ev.project !== undefined) existing.project = ev.project;
  if (ev.sessionId !== undefined) existing.sessionId = ev.sessionId;
  if (ev.cwd !== undefined) existing.cwd = ev.cwd;
  if (ev.root !== undefined) existing.root = ev.root;
  if (ev.lastMessage !== undefined && ev.lastMessage) existing.lastMessage = ev.lastMessage;
  if (ev.detail !== undefined) existing.detail = ev.detail;
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
    const c = spawn(cmd, args, Object.assign({ detached: true, stdio: 'ignore' }, opts || {}));
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

// Launch a Claude Code session in a new terminal at cwd (optionally resuming one).
function launchSession(cwd, resume, prompt) {
  if (resume && !/^[\w-]+$/.test(resume)) return { error: 'bad session id' };
  // optional initial task: strip quotes/newlines, cap length, wrap for the shell
  const task = prompt ? String(prompt).replace(/["\r\n]+/g, ' ').trim().slice(0, 1500) : '';
  const inner = resume ? `claude --resume ${resume}` : (task ? `claude "${task}"` : 'claude');
  try {
    if (process.platform === 'win32') {
      spawn(`start "Hivemind: Claude" cmd /k ${inner}`, { cwd, shell: true, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell app "Terminal" to do script "cd '${cwd}' && ${inner}"`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', `bash -c "cd '${cwd}'; ${inner}; exec bash"`], { detached: true, stdio: 'ignore' }).unref();
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
    const msg = (message && String(message).trim()) || 'Update from Hivemind';
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
      if (sub) out.push({ ...base, agentId: id, parentId: rootId, name: p.agent_type || ('sub-' + String(p.agent_id).slice(0, 6)) });
      else out.push({ ...base, agentId: id, root: true, name: project });
      out.push({ ...base, agentId: id, state: toolState(p.tool_name, p.tool_input), log: (p.tool_name || 'tool') + toolDetail(p) });
      return out;
    }
    case 'PostToolUseFailure': {
      const id = sub ? subId : rootId;
      const out = [];
      if (sub) out.push({ ...base, agentId: id, parentId: rootId, name: p.agent_type || ('sub-' + String(p.agent_id).slice(0, 6)) });
      else out.push({ ...base, agentId: id, root: true, name: project });
      out.push({ ...base, agentId: id, state: 'error', log: (p.tool_name || 'tool') + ' failed' });
      return out;
    }
    case 'SubagentStart':
      return [{ ...base, agentId: subId, parentId: rootId, name: p.agent_type || 'subagent', state: 'spawning', log: 'subagent started' }];
    case 'SubagentStop':
      return [{ ...base, agentId: subId, state: 'done', log: 'subagent finished' }];
    case 'Notification': {
      const kind = String(p.message || p.notification_type || p.type || '').toLowerCase();
      if (/auth|success|login/.test(kind)) return [];   // not an input request
      return [{ ...base, agentId: rootId, root: true, name: project, state: 'awaiting', log: (p.message ? String(p.message) : 'awaiting input').slice(0, 80) }];
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
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

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

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
    }
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/inspect' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const sidParam = u.searchParams.get('session') || '';
    const rootId = sidParam.startsWith('sess:') ? sidParam : 'sess:' + sidParam;
    const root = agents.get(rootId) || agents.get(sidParam);
    const cwd = (root && root.cwd) || u.searchParams.get('cwd') || '';
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
      return sendTelegram('✅ Hivemind: Telegram is connected.', (mid) =>
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
    return sendJson(res, 200, configmgr.read(body.cwd));
  }

  if (url === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd) return sendJson(res, 400, { error: 'cwd required' });
    let r;
    if (body.action === 'addMcp') r = configmgr.addMcp(body.cwd, body.server || body);
    else r = configmgr.del(body.cwd, body.action === 'delHook' ? 'hook' : 'mcp', body.name);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/component-diff' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    return sendJson(res, 200, projects.diffComponent(body.type, body.name, body.fromCwd, body.toCwd));
  }

  if (url === '/api/component-read' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd) return sendJson(res, 400, { error: 'cwd required' });
    const r = projects.readComponent(body.type, body.name, body.cwd);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/component-write' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.cwd || !body.path) return sendJson(res, 400, { error: 'cwd and path required' });
    const r = projects.writeComponent(body.cwd, body.path, body.content);
    if (!r.error) console.log(`[edit] ${body.path}`);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/copy-component' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
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

server.listen(argPort, () => {
  console.log(`Agent Ops Center bridge listening on http://localhost:${argPort}`);
  console.log(`Dashboard:  http://localhost:${argPort}/`);
  console.log(`Push event: POST http://localhost:${argPort}/api/event`);
  startIngest();
  startTelegramPolling();
  setInterval(retireSweep, 12000);
  setInterval(checkBudget, 180000); setTimeout(checkBudget, 8000);
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
