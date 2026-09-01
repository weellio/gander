'use strict';
// Gander coordination board — a per-project shared store agents post to so a
// swarm builds on each other's work instead of re-deriving it in every sandbox.
//
// This is the KEYSTONE the coordination features ride on: notes/findings agents
// leave for their siblings and the next task, escalations that flag a human,
// and (later) claims, plans, and assignments. Every one is just a typed entry
// here — the panels and rules are lenses on this one store.
//
// The one rule: human-visible by default. Entries are per-project, capped, and
// persisted like the task queue; the human can read, inject, pin, and clear
// them from the Board panel. Nothing is a hidden side-channel.
//
// Zero dependencies; the engine is pure (dependency-injected time) so it's
// unit-testable without a bridge running.

const fs = require('fs');
const path = require('path');

const BOARD_FILE = process.env.AOC_BOARD_FILE || path.join(__dirname, 'aoc-board.json');
const TYPES = ['note', 'finding', 'escalation', 'claim', 'plan', 'assignment'];
const TEXT_MAX = 4000;
const MAX_PER_PROJECT = 300;      // oldest NON-pinned entries drop beyond this
const LIST_MAX = 200;

let entries = [];   // [{ id, project, type, agent, text, refs, meta, pinned, resolved, createdAt }]
let seq = 1;
let now = () => Date.now();        // swappable for tests

function setClock(fn) { now = fn || (() => Date.now()); }

function save() {
  try { fs.writeFileSync(BOARD_FILE, JSON.stringify({ seq, entries }, null, 1)); } catch (_) {}
}
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    entries = Array.isArray(j.entries) ? j.entries : [];
    seq = Number(j.seq) || (entries.reduce((m, e) => Math.max(m, e.id), 0) + 1);
  } catch (_) { entries = []; seq = 1; }
}
load();

function cleanProject(p) { return String(p || '').trim().slice(0, 80); }

// Enforce the per-project cap: keep all pinned + the newest non-pinned.
function trim(project) {
  const mine = entries.filter((e) => e.project === project);
  if (mine.length <= MAX_PER_PROJECT) return;
  const drop = mine.filter((e) => !e.pinned).sort((a, b) => a.createdAt - b.createdAt);
  const excess = mine.length - MAX_PER_PROJECT;
  const kill = new Set(drop.slice(0, excess).map((e) => e.id));
  if (kill.size) entries = entries.filter((e) => !kill.has(e.id));
}

// ── public API ───────────────────────────────────────────────────────────────
// add({ project, type?, agent?, text, refs?, meta? }) -> { ok, entry } | { error }
function add(o) {
  const project = cleanProject(o && o.project);
  if (!project) return { error: 'project required' };
  const text = String((o && o.text) || '').trim();
  if (!text) return { error: 'text required' };
  const type = TYPES.includes(o && o.type) ? o.type : 'note';
  const entry = {
    id: seq++, project, type,
    agent: o.agent ? String(o.agent).slice(0, 80) : '',
    text: text.slice(0, TEXT_MAX),
    refs: Array.isArray(o.refs) ? o.refs.map((r) => Number(r)).filter((n) => Number.isFinite(n)).slice(0, 20) : [],
    meta: o.meta && typeof o.meta === 'object' ? o.meta : undefined,
    pinned: false,
    resolved: false,
    createdAt: now(),
  };
  entries.push(entry);
  trim(project);
  save();
  return { ok: true, entry };
}

// list(project, { type?, limit?, includeResolved? }) -> pinned first, then newest
function list(project, opts = {}) {
  const p = cleanProject(project);
  let mine = entries.filter((e) => e.project === p);
  if (opts.type) mine = mine.filter((e) => e.type === opts.type);
  if (!opts.includeResolved) mine = mine.filter((e) => !e.resolved || e.type !== 'escalation');
  mine.sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
  const limit = Math.max(1, Math.min(LIST_MAX, Number(opts.limit) || 50));
  return mine.slice(0, limit);
}

function get(id) { return entries.find((e) => e.id === Number(id)) || null; }

function action(id, what, opts = {}) {
  if (what === 'clear') return { error: 'clear needs a project, not an id' };
  const e = get(id);
  if (!e) return { error: 'no such entry' };
  const meta = () => (e.meta || (e.meta = {}));
  if (what === 'pin') e.pinned = true;
  else if (what === 'unpin') e.pinned = false;
  else if (what === 'resolve') e.resolved = true;      // for escalations: acknowledged
  else if (what === 'reopen') e.resolved = false;
  else if (what === 'approve') { meta().status = 'approved'; e.resolved = true; }   // plan: go
  else if (what === 'veto') { meta().status = 'vetoed'; e.resolved = true; }         // plan: stop
  else if (what === 'release') { meta().released = true; e.resolved = true; }         // claim: let go
  else if (what === 'claim-task') { meta().status = 'claimed'; if (opts.agent) meta().assignee = String(opts.agent).slice(0, 80); }
  else if (what === 'complete') { meta().status = 'done'; e.resolved = true; }        // assignment: reported done
  else if (what === 'remove') { entries = entries.filter((x) => x.id !== e.id); save(); return { ok: true, removed: e.id }; }
  else return { error: 'unknown action' };
  save();
  return { ok: true, entry: e };
}

// clear(project) -> drop every entry for one project (a human housekeeping action)
function clear(project) {
  const p = cleanProject(project);
  const before = entries.length;
  entries = entries.filter((e) => e.project !== p);
  save();
  return { ok: true, cleared: before - entries.length };
}

// Compact per-project summary for the snapshot: what the floor bulletin board
// and Needs-you rail need without shipping every entry every poll.
function summary() {
  const by = {};
  for (const e of entries) {
    const s = by[e.project] || (by[e.project] = { project: e.project, total: 0, pinned: 0, escalations: 0, latestAt: 0, latest: '' });
    s.total++;
    if (e.pinned) s.pinned++;
    if (e.type === 'escalation' && !e.resolved) s.escalations++;
    if (e.createdAt >= s.latestAt) { s.latestAt = e.createdAt; s.latest = e.text.slice(0, 80); }
  }
  return Object.values(by);
}

// Lineage: findings as a build-on forest. A finding's `refs` point at the
// entries it built on; this returns root findings (refs point nowhere in the
// set) with their descendants nested, so the R&D arc reads at a glance — the
// exact cross-reference that let investigators understand the incident swarm.
function lineage(project) {
  const p = cleanProject(project);
  const mine = entries.filter((e) => e.project === p && (e.type === 'finding' || e.type === 'note'));
  const byId = new Map(mine.map((e) => [e.id, e]));
  const childrenOf = new Map();   // parentId -> [entry]
  const hasParent = new Set();
  for (const e of mine) {
    for (const r of e.refs || []) {
      if (byId.has(r)) { (childrenOf.get(r) || childrenOf.set(r, []).get(r)).push(e); hasParent.add(e.id); }
    }
  }
  const node = (e, seen) => {
    if (seen.has(e.id)) return null;            // cycle guard
    seen.add(e.id);
    const kids = (childrenOf.get(e.id) || []).sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => node(c, seen)).filter(Boolean);
    return { id: e.id, type: e.type, agent: e.agent, text: e.text, createdAt: e.createdAt, pinned: e.pinned, children: kids };
  };
  const seen = new Set();
  return mine.filter((e) => !hasParent.has(e.id)).sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => node(e, seen)).filter(Boolean);
}

// Active (unreleased, unexpired) claims for a project — advisory holds so
// parallel agents don't step on the same file. meta.expiresAt is a ms epoch.
function activeClaims(project) {
  const p = cleanProject(project), t = now();
  return entries.filter((e) => e.project === p && e.type === 'claim' && !e.resolved && !(e.meta && e.meta.released)
    && !(e.meta && e.meta.expiresAt && e.meta.expiresAt < t))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((e) => ({ id: e.id, agent: e.agent, resource: (e.meta && e.meta.resource) || e.text, text: e.text, createdAt: e.createdAt, expiresAt: e.meta && e.meta.expiresAt }));
}

// Pending plans awaiting a human's go/veto — fed into the Needs-you rail.
function pendingPlans() {
  return entries.filter((e) => e.type === 'plan' && !e.resolved && (!e.meta || !e.meta.status || e.meta.status === 'pending'))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((e) => ({ id: e.id, project: e.project, agent: e.agent, text: e.text, createdAt: e.createdAt }));
}

// Open (unresolved) escalations across all projects — fed into the Needs-you rail.
function openEscalations() {
  return entries.filter((e) => e.type === 'escalation' && !e.resolved)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((e) => ({ id: e.id, project: e.project, agent: e.agent, text: e.text, createdAt: e.createdAt }));
}

module.exports = {
  add, list, get, action, clear, summary, openEscalations, lineage, activeClaims, pendingPlans, setClock,
  TYPES, TEXT_MAX, MAX_PER_PROJECT,
  _test: { reset: () => { entries = []; seq = 1; }, entries: () => entries, load, save },
};
