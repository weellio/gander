'use strict';
// bridge/away.js — "while you were away".
//
// The user steps out for hours (work, homework with the kids, sleep) while
// sessions keep running. Coming back, the activity feed is 300 lines of
// "coding · reading · coding" with the three things that matter buried in it:
// what finished, what failed, and what has been sitting there waiting for an
// answer. This folds all of it into one card.
//
// Pure: every input is a plain value (the bridge passes its feed, agents, queue
// file, collision rail and danger log), every one may be missing, and `now` is
// injectable. Nothing here reads a file or a clock it was not given.

const MAX_ROWS = 12;
const DEFAULT_AWAY_MS = 8 * 3600e3;   // no `since` given: assume a night's sleep

// States that mean the session was doing work, as opposed to resting
// (idle/done), waiting on the user (awaiting) or broken (error).
const RESTING = new Set(['idle', 'done', 'awaiting', 'error']);

function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && v.trim()) return /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
  return NaN;
}
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? '' : String(v));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

// The bridge names a session root 'sess:<id>' (Codex 'codex:<id>', Claude
// Desktop 'desktop:…'); sub-agents are 'agent:<id>'. The agents list is the
// source of truth when it has the agent; the prefix covers one that already
// clocked out of the grid while the user was away.
function isRoot(id, byId) {
  const a = byId.get(id);
  if (a) return a.root === true;
  return /^(sess|codex|desktop):/.test(str(id));
}

function summarize(input) {
  const o = input && typeof input === 'object' ? input : {};
  let now = toMs(o.now);
  if (!Number.isFinite(now)) now = Date.now();
  let since = toMs(o.since);
  if (!Number.isFinite(since)) since = now - DEFAULT_AWAY_MS;

  const agents = arr(o.agents).filter((a) => a && typeof a === 'object');
  const byId = new Map(agents.map((a) => [str(a.id), a]));
  const nameOf = (id, e) => {
    const a = byId.get(id);
    return str((a && (a.name || a.project)) || (e && (e.agent || e.project)) || id);
  };

  // oldest first: "idle after work" is a statement about order
  const feed = arr(o.feed)
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ e, ts: toMs(e.ts) }))
    .filter((x) => Number.isFinite(x.ts) && x.ts >= since && x.ts <= now)
    .sort((a, b) => a.ts - b.ts);

  // ── finished ──
  // A session reports 'done' rarely; the usual end of a turn is Stop -> idle.
  // So "finished" is either an explicit done, or an idle that came AFTER real
  // work inside the window. A session that was idle the whole time did nothing,
  // and one that went error -> idle failed rather than finished (it shows under
  // failed), so an error resets the "was working" flag.
  const finishedBy = new Map();     // sessionId (or agentId) -> row, latest wins
  const working = new Map();
  for (const { e, ts } of feed) {
    const id = str(e.agentId);
    if (!isRoot(id, byId)) continue;
    const key = str(e.sessionId) || id;
    const st = str(e.state);
    if (st === 'error' || e.error === true) { working.set(key, false); continue; }
    if (st && !RESTING.has(st)) { working.set(key, true); continue; }
    if (st === 'done' || (st === 'idle' && working.get(key))) {
      const a = byId.get(id);
      finishedBy.set(key, { project: str((a && a.project) || e.project), name: nameOf(id, e), goal: str(a && a.goal), at: ts });
      working.set(key, false);
    }
  }
  const finishedAll = [...finishedBy.values()].sort((a, b) => b.at - a.at);

  // ── failed ──
  // One row per agent: a session that hit the same wall twelve times is one
  // problem, and it should not push every other failure off the card.
  const failedBy = new Map();
  for (const { e, ts } of feed) {
    if (!(e.error === true || str(e.state) === 'error')) continue;
    const id = str(e.agentId) || str(e.sessionId) || str(e.agent);
    const a = byId.get(id);
    failedBy.set(id, { project: str((a && a.project) || e.project), name: nameOf(id, e), detail: str(e.log).slice(0, 200), at: ts });
  }
  const failedAll = [...failedBy.values()].sort((a, b) => b.at - a.at);

  // ── waiting ──
  // Current state, not filtered by `since`: a question asked before the user
  // left is still unanswered, and that is the most important line on the card.
  const waiting = agents
    .filter((a) => a.root === true && !a.closed && str(a.state) === 'awaiting')
    .map((a) => ({ project: str(a.project), name: str(a.name || a.project || a.id), why: str(a.awaitMsg) }));

  // ── queue ──
  const items = arr(o.queue && o.queue.items).filter((it) => it && typeof it === 'object');
  const after = (v) => { const t = toMs(v); return Number.isFinite(t) && t >= since; };
  const queue = {
    done: items.filter((it) => it.status === 'done' && after(it.doneAt)).length,
    failed: items.filter((it) => it.status === 'failed' && after(it.doneAt)).length,
    review: items.filter((it) => it.status === 'review' && after(it.doneAt != null ? it.doneAt : it.startedAt)).length,
    // a branch waiting on review needs the user however long ago it got there
    inReview: items.filter((it) => it.status === 'review').length,
  };

  // ── risk ──
  const collisions = arr(o.collisions).filter((c) => c && after(c.lastAt)).length;
  const dangerList = arr(o.dangers).filter((d) => d && after(d.at));
  const dangers = dangerList.length;
  const blocked = dangerList.filter((d) => str(d.action) === 'block').length;

  // ── headline ──
  // Plain words, most actionable first after the wins. No em-dashes: the same
  // string goes to Telegram and the lamp's TTS, and the user reads short chunks.
  const parts = [];
  if (finishedAll.length) parts.push(finishedAll.length + ' finished');
  if (waiting.length) parts.push(waiting.length + (waiting.length === 1 ? ' needs you' : ' need you'));
  if (failedAll.length) parts.push(failedAll.length + ' failed');
  if (queue.done) parts.push(plural(queue.done, 'queue task done', 'queue tasks done'));
  if (queue.failed) parts.push(plural(queue.failed, 'queue task failed', 'queue tasks failed'));
  if (queue.inReview) parts.push(queue.inReview + ' to review');
  if (blocked) parts.push(plural(blocked, 'command blocked', 'commands blocked'));
  if (dangers - blocked > 0) parts.push(plural(dangers - blocked, 'risky command', 'risky commands'));
  if (collisions) parts.push(plural(collisions, 'file collision', 'file collisions'));

  // queue.review is covered: an item reviewed-since is also in inReview
  const quiet = parts.length === 0;
  const headline = quiet ? 'All quiet, nothing happened while you were away.' : parts.join(' · ');

  return {
    since, now,
    minutes: Math.max(0, Math.round((now - since) / 60000)),
    finished: finishedAll.slice(0, MAX_ROWS).map(({ project, name, goal, at }) => ({ project, name, goal, at })),
    failed: failedAll.slice(0, MAX_ROWS),
    waiting,
    queue,
    collisions, dangers, blocked,
    headline,
    quiet,
  };
}

module.exports = { summarize };
