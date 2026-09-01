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

function action(id, what) {
  if (what === 'clear') return { error: 'clear needs a project, not an id' };
  const e = get(id);
  if (!e) return { error: 'no such entry' };
  if (what === 'pin') e.pinned = true;
  else if (what === 'unpin') e.pinned = false;
  else if (what === 'resolve') e.resolved = true;      // for escalations: acknowledged
  else if (what === 'reopen') e.resolved = false;
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

// Open (unresolved) escalations across all projects — fed into the Needs-you rail.
function openEscalations() {
  return entries.filter((e) => e.type === 'escalation' && !e.resolved)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((e) => ({ id: e.id, project: e.project, agent: e.agent, text: e.text, createdAt: e.createdAt }));
}

module.exports = {
  add, list, get, action, clear, summary, openEscalations, setClock,
  TYPES, TEXT_MAX, MAX_PER_PROJECT,
  _test: { reset: () => { entries = []; seq = 1; }, entries: () => entries, load, save },
};
