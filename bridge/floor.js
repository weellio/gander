'use strict';
// The floor at a glance, away from the desk: one row per open session with how
// long it has been idle and what it last said, shaped for a phone page, one
// Telegram message, or a claude.ai tool. Pure functions over the bridge's agent
// map; nothing here talks to anything.
//
// The question these answer is always the same: "is anything sitting there
// doing nothing, and what do I say to make it go?"

const WORKING = new Set(['thinking', 'coding', 'running', 'reading', 'testing', 'spawning', 'searching']);
const EMOJI = { awaiting: '🔔', error: '❗', idle: '💤', done: '✅', thinking: '💭', coding: '⌨️', running: '▶', reading: '📖', testing: '🧪', spawning: '🐣', searching: '🔎' };

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// "3m", "2h 10m", "1d 4h" — the same scale the phone page uses.
function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  return Math.floor(h / 24) + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
}

// One row per root session that is still on the floor (closed/retiring ones are
// gone). `isStalled(a, now)` is the bridge's own predicate, passed in.
function rows(agents, now = Date.now(), opts = {}) {
  const isStalled = typeof opts.isStalled === 'function' ? opts.isStalled : () => false;
  const out = [];
  for (const a of agents) {
    if (!a || !a.root || a.closed || a.retiring) continue;
    const state = a.state || 'idle';
    const working = WORKING.has(state);
    const sinceMs = Math.max(0, now - (a.updatedAt || now));
    const stalled = state === 'idle' && !!isStalled(a, now);
    const needsYou = state === 'awaiting' || state === 'error' || stalled;
    const subs = Number(a.children || a.subagents || 0) || 0;
    out.push({
      sessionId: a.sessionId || String(a.id || '').replace(/^sess:/, ''),
      project: a.project || '', name: a.name || a.project || 'session',
      state, working, needsYou, stalled,
      idleMs: working ? 0 : sinceMs, idleFor: working ? '' : ago(sinceMs), sinceMs,
      costUSD: a.costUSD == null ? null : Math.round(Number(a.costUSD) * 100) / 100, costExact: !!a.costExact,
      ctxPct: a.ctxPct == null ? null : Math.round(Number(a.ctxPct) * 100),
      goal: clip(a.goal, 160),
      last: clip(a.awaitMsg || a.lastMessage || (a.logLines && a.logLines[0]) || a.detail || '', 160),
      canPoke: !!(a.sessionId) && !a.desktop && !a.remote,
      machine: a.remote ? String(a.machine || a.peer || 'remote') : '',
      desktop: !!a.desktop, subagents: subs,
      updatedAt: a.updatedAt || 0,
    });
  }
  // what needs you first, then the idle ones longest-idle first, then the busy ones
  const rank = (r) => (r.needsYou ? 0 : r.working ? 2 : 1);
  out.sort((x, y) => rank(x) - rank(y) || (rank(x) === 1 ? y.idleMs - x.idleMs : y.updatedAt - x.updatedAt));
  return out;
}

function summary(list) {
  const s = { total: list.length, working: 0, idle: 0, waiting: 0, errors: 0, costUSD: 0 };
  for (const r of list) {
    if (r.state === 'error') s.errors++;
    else if (r.state === 'awaiting' || r.stalled) s.waiting++;
    else if (r.working) s.working++;
    else s.idle++;
    s.costUSD += Number(r.costUSD) || 0;
  }
  s.costUSD = Math.round(s.costUSD * 100) / 100;
  return s;
}

// The /status message. Telegram HTML; capped under its 4096-character limit.
function telegramText(list, opts = {}) {
  const s = summary(list);
  const head = list.length
    ? `🦆 <b>Gander floor</b> · ${s.working} working · ${s.idle} idle · ${s.waiting + s.errors} need you${s.costUSD ? ` · $${s.costUSD.toFixed(2)}` : ''}`
    : '🦆 <b>Gander floor</b> · nothing running';
  const lines = [head];
  for (const r of list) {
    const em = EMOJI[r.state] || '•';
    const what = r.working ? r.state : r.state === 'awaiting' ? 'waiting on you' : r.state === 'error' ? 'error' : r.stalled ? `asked you something · idle ${r.idleFor}` : `idle ${r.idleFor}`;
    const cost = r.costUSD != null ? ` · $${r.costUSD.toFixed(2)}` : '';
    const mach = r.machine ? ` · 🖥 ${esc(r.machine)}` : '';
    lines.push(`${em} <b>${esc(r.name)}</b> — ${esc(what)}${cost}${mach}`);
    if (r.last) lines.push(`   ↳ ${esc(clip(r.last, 110))}`);
  }
  if (list.some((r) => !r.working && r.canPoke)) lines.push('', 'Nudge one: <code>/poke project</code> or <code>project: your message</code>');
  if (opts.dashUrl) lines.push(esc(opts.dashUrl));
  let text = lines.join('\n');
  if (text.length > 3900) text = text.slice(0, 3880) + '\n…';
  return text;
}

// The chat commands this module owns. Everything else (replies, /task, /queue,
// /stop) stays with the bridge's handler.
// Slash forms always; the bare words `status`, `floor`, `help`, `poke`, `nudge` too
// (a phone keyboard capitalises them, and nobody sends a session the single word
// "status"). `/go` keeps its slash: "go ahead and fix it" is a message, not a poke.
function parseCommand(text) {
  const t = String(text || '').trim();
  if (/^\/(status|floor|snap|s)\b/i.test(t) || /^(status|floor)\s*$/i.test(t)) return { kind: 'status' };
  if (/^\/(help|start)\b/i.test(t) || /^help\s*$/i.test(t)) return { kind: 'help' };
  const m = /^(?:\/(?:poke|nudge|go)|poke|nudge)(?:\s+(\S+)(?:\s+([\s\S]+))?)?\s*$/i.exec(t);
  if (m) return { kind: 'poke', project: m[1] || '', message: (m[2] || '').trim() };
  return null;
}

const DEFAULT_POKE = 'Continue with the current task. If it is finished, say what is left to do and what you need from me.';

const HELP = [
  '🦆 <b>Gander</b> from your phone',
  '<code>/status</code> — every session: state, idle time, last line',
  '<code>/poke project</code> — wake an idle session (add your own words after the name)',
  '<code>project: your message</code> — send text to that session',
  '<code>/task project goal</code> — queue new work',
  '<code>/queue</code> — what is queued or running',
  '<code>/stop</code> — stop the session you last replied to',
  'Reply to any alert to answer that session.',
].join('\n');

// Idle alerts: which rows have been idle at least `minutes` and were not yet
// announced for THIS idle stretch. `seen` is a Map(sessionId -> updatedAt) the
// caller keeps; a session that works again and goes idle later alerts again.
function idleDue(list, minutes, seen, now = Date.now()) {
  const min = Number(minutes) || 0;
  if (min <= 0) return [];
  const due = [];
  const live = new Set();
  for (const r of list) {
    live.add(r.sessionId);
    if (r.working || !r.canPoke || r.state === 'awaiting' || r.state === 'error' || r.desktop) continue;
    if (r.idleMs < min * 60000) continue;
    if (seen.get(r.sessionId) === r.updatedAt) continue;
    seen.set(r.sessionId, r.updatedAt);
    due.push(r);
  }
  for (const k of [...seen.keys()]) if (!live.has(k)) seen.delete(k);
  return due;
}

function idleAlertText(r, opts = {}) {
  const lines = [`💤 <b>Gander</b>\n<b>${esc(r.name)}</b> has been idle ${r.idleFor}.`];
  if (r.last) lines.push(`Last: ${esc(clip(r.last, 200))}`);
  lines.push(`Reply to this message to give it work, or <code>/poke ${esc(r.project || r.name)}</code>.`);
  if (opts.dashUrl) lines.push(esc(opts.dashUrl));
  return lines.join('\n');
}

// Find a session by the name a person types: project folder name, tile name,
// or a session id prefix; case-insensitive, then a loose contains match.
function findRow(list, query) {
  const q = String(query || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return null;
  const pool = list.filter((r) => r.canPoke);
  return pool.find((r) => r.project.toLowerCase() === q || r.name.toLowerCase() === q)
    || pool.find((r) => r.sessionId.toLowerCase().startsWith(q) && q.length >= 4)
    || pool.find((r) => r.project.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
    || null;
}

module.exports = { rows, summary, telegramText, parseCommand, idleDue, idleAlertText, findRow, ago, HELP, DEFAULT_POKE, WORKING, EMOJI };
