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

let items = [];                          // [{ id, cwd, project, prompt, status, createdAt, startedAt, doneAt, sessionId, runner, error, wtPath, branch, merge, afterId, gate, gateCmd, testOut }]
let seq = 1;
let cfgState = { enabled: true, maxSlots: 2, worktrees: false, testGate: true };

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
    if (j.cfg) cfgState = { enabled: j.cfg.enabled !== false, maxSlots: Math.max(1, Math.min(8, Number(j.cfg.maxSlots) || 2)), worktrees: !!j.cfg.worktrees, testGate: j.cfg.testGate !== false };
    // a bridge restart orphans anything that was mid-flight — requeue it
    // ('gating' items keep their status: tick restarts the test run, since the
    // started flag lives only in memory)
    for (const it of items) if (it.status === 'running') { it.status = 'queued'; it.startedAt = null; it.sessionId = null; it.runner = null; }
  } catch (_) {}
}
load();

// ── public API ───────────────────────────────────────────────────────────────
function add({ cwd, prompt, afterId }) {
  if (!cwd || !String(prompt || '').trim()) return { error: 'cwd and prompt required' };
  const it = {
    id: seq++, cwd: String(cwd), project: projectFromCwd(cwd), prompt: String(prompt).trim().slice(0, 4000),
    status: 'queued', createdAt: Date.now(), startedAt: null, doneAt: null, sessionId: null, runner: null, error: null,
  };
  if (afterId) it.afterId = Number(afterId);   // chain: don't start until #afterId lands
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
    if (it.status === 'running' || it.status === 'queued' || it.status === 'gating') return { error: 'task is not finished' };
    it.status = 'queued'; it.startedAt = null; it.doneAt = null; it.sessionId = null; it.runner = null; it.error = null;
    it.gate = null; it.gateCmd = null; it.testOut = null; it.wtPath = null; it.branch = null; it.merge = null;
    save(); return { ok: true, item: it };
  }
  if (what === 'retry-context') {
    // re-queue as a NEW task with the failure baked into the prompt, so the
    // second attempt starts knowing what sank the first one
    if (it.status === 'running' || it.status === 'queued' || it.status === 'gating') return { error: 'task is not finished' };
    const ctx = [
      it.error ? `It failed with: ${it.error}` : null,
      it.testOut ? `Test output (tail):\n${it.testOut.slice(-1500)}` : null,
      it.merge && /CONFLICT|kept/i.test(it.merge) ? `Merge status: ${it.merge}` : null,
    ].filter(Boolean).join('\n\n');
    return add({ cwd: it.cwd, prompt: `${it.prompt}\n\n(Retry — a previous attempt did not land.${ctx ? '\n' + ctx : ''}\nFix the cause this time.)` });
  }
  if (what === 'remove') { items = items.filter((x) => x !== it || x.status === 'running'); save(); return { ok: true }; }
  return { error: 'unknown action' };
}

function list() { return { enabled: cfgState.enabled, maxSlots: cfgState.maxSlots, worktrees: cfgState.worktrees, testGate: cfgState.testGate, items: items.slice().sort((a, b) => b.id - a.id) }; }
function setConfig(c) {
  if (c && c.enabled !== undefined) cfgState.enabled = !!c.enabled;
  if (c && c.maxSlots !== undefined) cfgState.maxSlots = Math.max(1, Math.min(8, Number(c.maxSlots) || 2));
  if (c && c.worktrees !== undefined) cfgState.worktrees = !!c.worktrees;
  if (c && c.testGate !== undefined) cfgState.testGate = !!c.testGate;
  save();
  return { ok: true, enabled: cfgState.enabled, maxSlots: cfgState.maxSlots, worktrees: cfgState.worktrees, testGate: cfgState.testGate };
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
  // worktree tasks: on any completion, the BRIDGE merges the task branch back
  // into the main tree (single-committer) and records the human-readable result
  const finishWt = (it, opts) => {
    if (it.wtPath && deps.wt) { try { it.merge = deps.wt.finish(it, opts); } catch (e) { it.merge = 'merge error: ' + (e.message || e); } }
  };
  // Settle a task. A SUCCESSFUL worktree task first passes through the test
  // gate ('gating'): the bridge runs the project's tests inside the worktree
  // before merging — green merges, red keeps the branch. Failed tasks skip the
  // gate (their leftovers still merge so no work is ever lost).
  const settle = (it, ok, errMsg) => {
    if (ok && it.wtPath && cfgState.testGate && deps.gate) { it.status = 'gating'; it.error = null; return; }
    it.status = ok ? 'done' : 'failed';
    it.error = ok ? null : errMsg;
    it.doneAt = now; finished++;
    finishWt(it);
    try { deps.onDone(it); } catch (_) {}
  };

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
        try { deps.stopDispatch(it.sessionId); } catch (_) {}
        settle(it, !!s.lastResult.ok, 'turn ended with an error');
      } else if (!s || s.exited) {
        // process died (or never registered) without a result
        if (!s && it.startedAt && now - it.startedAt > START_GRACE_MS) settle(it, false, 'dispatch session ended without a result');
        else if (s && s.exited && !s.lastResult) settle(it, false, 'dispatch session exited early');
      }
    } else {
      // terminal runner: watch the registry for the session this launch produced
      // (a worktree task's session reports the WORKTREE path as its cwd)
      const runKey = keyOf(it.wtPath || it.cwd);
      const mine = (deps.agents() || []).filter((a) => a.root && a.cwd && keyOf(a.cwd) === runKey && (a.createdAt || 0) >= (it.startedAt || 0) - 15000);
      if (!mine.length) {
        if (now - (it.startedAt || now) > START_GRACE_MS) settle(it, false, 'no session appeared (is claude on PATH? trust prompt?)');
      } else {
        const active = mine.some((a) => WORKING.has(a.state));
        const settled = now - (it.startedAt || now) > MIN_RUN_MS && !active;
        if (settled) {
          const anyError = mine.some((a) => a.state === 'error');
          it.sessionId = it.sessionId || (mine[0] && mine[0].sessionId) || null;
          settle(it, !anyError, 'session ended in error state');
        }
      }
    }
  }

  // 1b) start test gates for freshly-settled items (also re-fires after a
  // bridge restart, since _gateStarted lives only in memory)
  for (const it of items) {
    if (it.status !== 'gating' || it._gateStarted || !deps.gate) continue;
    it._gateStarted = true;
    try {
      deps.gate(it, (g) => {
        g = g || { skipped: true };
        it.gateCmd = g.cmd || null;
        if (g.failed) {
          it.gate = 'failed';
          it.status = 'failed';
          it.error = 'tests failed in the worktree' + (g.cmd ? ` (${g.cmd})` : '');
          it.testOut = String(g.output || '').slice(-3000);
          it.doneAt = deps.now();
          finishWt(it, { noMerge: true });   // keep the branch — nothing broken lands
        } else {
          it.gate = g.skipped ? 'skipped' : 'passed';
          it.status = 'done'; it.error = null; it.doneAt = deps.now();
          finishWt(it);
        }
        save();
        try { deps.onDone(it); } catch (_) {}
      });
    } catch (e) {
      // a broken gate never blocks the merge
      it.gate = 'skipped'; it.status = 'done'; it.doneAt = now; finished++;
      finishWt(it);
      try { deps.onDone(it); } catch (_) {}
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
    // chained task: wait for its dependency to land; a dead dependency fails it
    if (it.afterId) {
      const dep = items.find((x) => x.id === it.afterId);
      if (dep && (dep.status === 'queued' || dep.status === 'running' || dep.status === 'gating')) continue;
      if (dep && dep.status !== 'done') {
        it.status = 'failed'; it.error = `dependency #${dep.id} ${dep.status}`; it.doneAt = now; finished++;
        try { deps.onDone(it); } catch (_) {}
        continue;
      }
    }
    const k = keyOf(it.cwd);
    // worktree mode: each task gets its own tree, so the one-per-project rule
    // (and the don't-fight-a-human rule) don't apply — the trees can't collide.
    let usedWt = false;
    if (cfgState.worktrees && deps.wt) {
      const w = deps.wt.start(it);
      if (w && w.ok) { it.wtPath = w.wtPath; it.branch = w.branch; usedWt = true; }
      else { it.merge = null; it.wtNote = (w && w.error) || 'worktree unavailable'; }   // not a repo etc. → shared-tree rules below
    }
    if (!usedWt && busyProjects.has(k)) continue;
    const useDispatch = deps.dispatchEnabled();
    const r = useDispatch ? deps.startDispatch(it) : deps.startTerminal(it);
    if (r && r.ok) {
      it.status = 'running'; it.startedAt = now; it.runner = useDispatch ? 'dispatch' : 'terminal';
      if (useDispatch && r.key) it.key = r.key;
      if (!usedWt) busyProjects.add(k);
      free--; started++;
    } else {
      it.status = 'failed'; it.error = (r && r.error) || 'could not start'; it.doneAt = now;
      finishWt(it);   // clean up the worktree we just created
      try { deps.onDone(it); } catch (_) {}
    }
  }
  if (started || finished) save();
  return { started, finished };
}

module.exports = { add, action, list, setConfig, tick, _test: { load, save, items: () => items, reset: () => { items = []; seq = 1; cfgState = { enabled: true, maxSlots: 2, worktrees: false, testGate: true }; } } };
