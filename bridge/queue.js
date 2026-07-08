'use strict';
// Gander task queue — queue goals per project; the bridge starts the next one
// the moment a slot frees. Turns Gander from "watch the agents" into "feed the
// agents": dump five tasks in, walk away, get pinged as they land.
//
// Scheduling rules (deliberately conservative):
//   - at most `maxSlots` queue-started sessions run at once (default 2)
//   - never two queue tasks in the SAME project at once (repo conflicts)
//   - never start a queue task in a project that already has a busy session
//     (yours or another task's) — it would fight over the working tree
//
// Runner: Gander Dispatch when it's enabled (precise completion via the turn
// result; the hosted session is stopped once its task finishes), otherwise the
// classic terminal launch (completion inferred from the session registry: the
// launched session's root tile going idle/closed marks the task done).
//
// The engine is dependency-injected (deps.now/agents/dispatch/start) so the
// scheduling logic is unit-testable without spawning anything.

const fs = require('fs');
const path = require('path');

const QUEUE_FILE = process.env.AOC_QUEUE_FILE || path.join(__dirname, 'aoc-queue.json');
const WORKING = new Set(['thinking', 'coding', 'running', 'reading', 'testing', 'spawning', 'searching', 'awaiting']);
const START_GRACE_MS = 5 * 60 * 1000;    // terminal launch: no session appeared in time -> failed
const MIN_RUN_MS = 20 * 1000;            // ignore idle tiles in the first moments after launch

let items = [];                          // [{ id, cwd, project, prompt, status, createdAt, startedAt, doneAt, sessionId, runner, error }]
let seq = 1;
let cfgState = { enabled: true, maxSlots: 2 };

function projectFromCwd(cwd) {
  const parts = String(cwd || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
}
function keyOf(p) { return path.resolve(String(p || '')).toLowerCase(); }

// ── persistence ──────────────────────────────────────────────────────────────
function save() {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify({ seq, cfg: cfgState, items }, null, 2)); } catch (_) {}
}
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    items = Array.isArray(j.items) ? j.items : [];
    seq = Number(j.seq) || (items.reduce((m, i) => Math.max(m, i.id), 0) + 1);
    if (j.cfg) cfgState = { enabled: j.cfg.enabled !== false, maxSlots: Math.max(1, Math.min(8, Number(j.cfg.maxSlots) || 2)) };
    // a bridge restart orphans anything that was mid-flight — requeue it
    for (const it of items) if (it.status === 'running') { it.status = 'queued'; it.startedAt = null; it.sessionId = null; it.runner = null; }
  } catch (_) {}
}
load();

// ── public API ───────────────────────────────────────────────────────────────
function add({ cwd, prompt }) {
  if (!cwd || !String(prompt || '').trim()) return { error: 'cwd and prompt required' };
  const it = {
    id: seq++, cwd: String(cwd), project: projectFromCwd(cwd), prompt: String(prompt).trim().slice(0, 4000),
    status: 'queued', createdAt: Date.now(), startedAt: null, doneAt: null, sessionId: null, runner: null, error: null,
  };
  items.push(it);
  save();
  return { ok: true, item: it };
}

function action(id, what) {
  const it = items.find((x) => x.id === Number(id));
  if (what === 'clear-done') { items = items.filter((x) => x.status === 'queued' || x.status === 'running'); save(); return { ok: true }; }
  if (!it) return { error: 'no such task' };
  if (what === 'cancel') {
    if (it.status === 'running') return { error: 'already running — stop its session from the tile instead' };
    if (it.status === 'queued') { it.status = 'cancelled'; it.doneAt = Date.now(); save(); }
    return { ok: true, item: it };
  }
  if (what === 'retry') {
    if (it.status === 'running' || it.status === 'queued') return { error: 'task is not finished' };
    it.status = 'queued'; it.startedAt = null; it.doneAt = null; it.sessionId = null; it.runner = null; it.error = null;
    save(); return { ok: true, item: it };
  }
  if (what === 'remove') { items = items.filter((x) => x !== it || x.status === 'running'); save(); return { ok: true }; }
  return { error: 'unknown action' };
}

function list() { return { enabled: cfgState.enabled, maxSlots: cfgState.maxSlots, items: items.slice().sort((a, b) => b.id - a.id) }; }
function setConfig(c) {
  if (c && c.enabled !== undefined) cfgState.enabled = !!c.enabled;
  if (c && c.maxSlots !== undefined) cfgState.maxSlots = Math.max(1, Math.min(8, Number(c.maxSlots) || 2));
  save();
  return { ok: true, enabled: cfgState.enabled, maxSlots: cfgState.maxSlots };
}

// ── the scheduler ────────────────────────────────────────────────────────────
// deps = {
//   now: () => ms,
//   agents: () => [{root, cwd, state, sessionId, closed, createdAt, updatedAt}],  // live registry
//   dispatchEnabled: () => bool,
//   dispatchGet: (sessionId) => { busy, lastResult, exited } | null,
//   dispatchList: () => [{ key, sessionId }],
//   startDispatch: (item) => { ok, key } | { error },
//   startTerminal: (item) => { ok } | { error },
//   onDone: (item) => {},      // notify (feed/ambient/telegram)
//   stopDispatch: (sessionId) => {},
// }
function tick(deps) {
  if (!cfgState.enabled) return { started: 0, finished: 0 };
  const now = deps.now();
  let started = 0, finished = 0;

  // 1) settle running items
  for (const it of items) {
    if (it.status !== 'running') continue;
    if (it.runner === 'dispatch') {
      // resolve the session id once dispatch has seen system/init
      if (!it.sessionId && it.key) {
        const d = (deps.dispatchList() || []).find((s) => s.key === it.key);
        if (d && d.sessionId) it.sessionId = d.sessionId;
      }
      const s = it.sessionId ? deps.dispatchGet(it.sessionId) : (it.key ? { stillStarting: true } : null);
      if (s && s.lastResult && !s.busy) {
        it.status = s.lastResult.ok ? 'done' : 'failed';
        it.error = s.lastResult.ok ? null : 'turn ended with an error';
        it.doneAt = now; finished++;
        try { deps.stopDispatch(it.sessionId); } catch (_) {}
        try { deps.onDone(it); } catch (_) {}
      } else if (!s || s.exited) {
        // process died (or never registered) without a result
        if (!s && it.startedAt && now - it.startedAt > START_GRACE_MS) { it.status = 'failed'; it.error = 'dispatch session ended without a result'; it.doneAt = now; finished++; try { deps.onDone(it); } catch (_) {} }
        else if (s && s.exited && !s.lastResult) { it.status = 'failed'; it.error = 'dispatch session exited early'; it.doneAt = now; finished++; try { deps.onDone(it); } catch (_) {} }
      }
    } else {
      // terminal runner: watch the registry for the session this launch produced
      const mine = (deps.agents() || []).filter((a) => a.root && a.cwd && keyOf(a.cwd) === keyOf(it.cwd) && (a.createdAt || 0) >= (it.startedAt || 0) - 15000);
      if (!mine.length) {
        if (now - (it.startedAt || now) > START_GRACE_MS) { it.status = 'failed'; it.error = 'no session appeared (is claude on PATH? trust prompt?)'; it.doneAt = now; finished++; try { deps.onDone(it); } catch (_) {} }
      } else {
        const active = mine.some((a) => WORKING.has(a.state));
        const settled = now - (it.startedAt || now) > MIN_RUN_MS && !active;
        if (settled) {
          const anyError = mine.some((a) => a.state === 'error');
          it.status = anyError ? 'failed' : 'done';
          it.error = anyError ? 'session ended in error state' : null;
          it.sessionId = it.sessionId || (mine[0] && mine[0].sessionId) || null;
          it.doneAt = now; finished++;
          try { deps.onDone(it); } catch (_) {}
        }
      }
    }
  }

  // 2) fill free slots
  const running = items.filter((it) => it.status === 'running');
  let free = cfgState.maxSlots - running.length;
  if (free <= 0) return { started, finished };
  const busyProjects = new Set(running.map((it) => keyOf(it.cwd)));
  // any busy session in a project blocks queue starts there (don't fight a human's session)
  for (const a of (deps.agents() || [])) {
    if (a.root && a.cwd && WORKING.has(a.state) && !a.closed) busyProjects.add(keyOf(a.cwd));
  }
  for (const it of items) {
    if (free <= 0) break;
    if (it.status !== 'queued') continue;
    const k = keyOf(it.cwd);
    if (busyProjects.has(k)) continue;
    const useDispatch = deps.dispatchEnabled();
    const r = useDispatch ? deps.startDispatch(it) : deps.startTerminal(it);
    if (r && r.ok) {
      it.status = 'running'; it.startedAt = now; it.runner = useDispatch ? 'dispatch' : 'terminal';
      if (useDispatch && r.key) it.key = r.key;
      busyProjects.add(k); free--; started++;
    } else {
      it.status = 'failed'; it.error = (r && r.error) || 'could not start'; it.doneAt = now;
      try { deps.onDone(it); } catch (_) {}
    }
  }
  if (started || finished) save();
  return { started, finished };
}

module.exports = { add, action, list, setConfig, tick, _test: { load, save, items: () => items, reset: () => { items = []; seq = 1; cfgState = { enabled: true, maxSlots: 2 }; } } };
