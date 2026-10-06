'use strict';
// bridge/permlearn.js — "stop asking me" suggestions.
//
// Gander sees every permission prompt (PermissionRequest hook) and whether the
// tool then ran (PostToolUse for the same session + tool). Someone who has
// clicked Allow on `npm test` forty times is not reviewing it any more; they
// are being trained to click Allow without reading — which is exactly how the
// one prompt that mattered gets waved through. So after enough identical
// allows, Gander suggests the Claude Code allow-rule that makes that prompt
// stop coming back, and the remaining prompts mean something again.
//
// Nothing is ever written without the user clicking. And a rule is only ever
// suggested when it is NARROW: a Claude Code rule `Bash(rm:*)` matches every
// rm that will ever run, so "you allowed `rm -rf node_modules` five times"
// must never turn into permission to rm anything. The guard (./guard.js)
// decides what is dangerous; this file refuses to generalise past it.

const fs = require('fs');
const path = require('path');
const { classify, splitSegments } = require('./guard.js');

// ── which rule a prompt would become ─────────────────────────────────────────
// Programs whose first word alone says little: `git status` and `git push` are
// different decisions, so the rule keeps two words.
const MULTI = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'py', 'pip', 'pip3',
  'docker', 'gh', 'cargo', 'go', 'dotnet', 'kubectl', 'terraform', 'make']);

// A prefix rule for any of these is a blank cheque: deleters, disk tools,
// killers, privilege, shells and anything that runs the rest of its line as a
// command. One safe example (rm -rf node_modules) never justifies `rm:*`.
const NEVER = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'ri', 'remove-item', 'rimraf', 'dd', 'mkfs', 'format', 'diskpart',
  'wipefs', 'shred', 'truncate', 'shutdown', 'reboot', 'poweroff', 'halt', 'chmod', 'chown', 'chgrp', 'reg', 'taskkill', 'kill',
  'pkill', 'killall', 'sudo', 'doas', 'su', 'runas', 'env', 'eval', 'exec', 'xargs', 'nohup', 'time', 'watch', 'find', 'source',
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'wsl', 'ssh',
  'psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'dropdb', 'bunx']);

// Interpreters run whatever comes after them, so their first word alone is never a rule.
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'deno', 'bun', 'ruby', 'perl', 'php', 'pwsh']);

// Package runners: `npx tsc` is one tool, but `npx:*` runs any package on the
// registry, and `npx rimraf` is an rm with extra steps.
const RUNNERS = new Set(['npx']);

// Two-word rules that would still cover the dangerous form: `git push:*` also
// matches `git push --force`, `git reset:*` matches `--hard`, and so on.
const NEVER_SUB = {
  git: ['push', 'reset', 'clean', 'checkout', 'restore', 'branch', 'stash', 'rm', 'switch', 'filter-branch', 'filter-repo', 'update-ref', 'reflog', 'gc', 'prune', 'worktree'],
  npm: ['publish', 'unpublish', 'exec', 'x'], pnpm: ['publish', 'dlx', 'exec'], yarn: ['publish', 'dlx', 'npm'],
  docker: ['system', 'volume', 'rm', 'rmi', 'exec', 'run', 'compose', 'container', 'image'],
  kubectl: ['delete', 'exec', 'apply', 'drain', 'replace', 'patch'], terraform: ['destroy', 'apply', 'import', 'state'],
  gh: ['api', 'repo', 'secret', 'auth', 'release'], cargo: ['publish', 'yank', 'owner'],
};

// Interpreters given code on the command line: allowing that allows anything.
const INLINE = {
  node: /^(-e|--eval|-p|--print|-pe|-ep)(=|$)/, bun: /^(-e|--eval|-p|--print)(=|$)/, deno: /^eval$/,
  python: /^-[a-zA-Z]*c$/, python3: /^-[a-zA-Z]*c$/, py: /^-[a-zA-Z]*c$/,
  perl: /^-[a-zA-Z]*[eE]$/, ruby: /^-[a-zA-Z]*e$/, php: /^-r$/, osascript: /^-e$/, lua: /^-e$/,
};

// Claude Code prefix rules match the literal command text, so the words in a
// rule must be literal too: no quotes, variables, globs or substitutions.
const PLAIN = /^[\w.\/\\:@+-]+$/;

function progName(w) {
  let s = String(w).toLowerCase();
  const k = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (k >= 0 && k < s.length - 1) s = s.slice(k + 1);
  return s.replace(/\.(exe|cmd|bat|com)$/, '');
}

function webRule(url) {
  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
    return `WebFetch(domain:${u.hostname})`;
  } catch (_) { return null; }
}

function ruleFor(toolName, toolInput) {
  const tool = String(toolName || '');
  const inp = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (/^mcp__/.test(tool)) return tool;
  if (tool === 'WebFetch') return webRule(inp.url);
  if (tool !== 'Bash') return null;     // Read/Edit/Write/PowerShell/Glob…: a prefix rule there is not "one kind of command"

  const cmd = typeof inp.command === 'string' ? inp.command.trim() : '';
  if (!cmd || cmd.length > 2000 || /[\r\n]/.test(cmd)) return null;
  if (splitSegments(cmd).length !== 1) return null;              // a && b, a | b, $(…): not one kind of command
  if (classify('Bash', { command: cmd })) return null;           // anything the guard flags, at any level

  const words = cmd.split(/\s+/);
  const first = words[0];
  if (!PLAIN.test(first) || /^[A-Za-z_]\w*=/.test(first)) return null;   // FOO=1 npm test: the prefix would be FOO=1
  const prog = progName(first);
  if (NEVER.has(prog) || prog.startsWith('mkfs')) return null;
  const re = INLINE[prog] || (/^python[\d.]+$/.test(prog) ? INLINE.python : null);
  if (re && words.slice(1).some((a) => re.test(a))) return null;

  let n = 1;
  const second = words[1];
  // An interpreter's bare name is a blank cheque: approving `node --test` forty
  // times must not turn into `Bash(node:*)`, which would also allow a later
  // `node -e "<anything>"`. Interpreters always keep their second word, flag or
  // not (`Bash(node --test:*)`), and a bare REPL start gets no rule at all.
  if (INTERPRETERS.has(prog) || /^python[\d.]+$/.test(prog)) {
    if (!second || !PLAIN.test(second)) return null;
    // `python -m <module>` runs ANY module, so the module name belongs in the rule too
    const third = words[2];
    if (/^-(m|-module)$/.test(second)) return third && PLAIN.test(third) ? `Bash(${words.slice(0, 3).join(' ')}:*)` : null;
    return `Bash(${words.slice(0, 2).join(' ')}:*)`;
  }
  if (MULTI.has(prog) && second && !second.startsWith('-')) {
    if (!PLAIN.test(second)) return null;
    if ((NEVER_SUB[prog] || []).includes(second.toLowerCase())) return null;
    if (RUNNERS.has(prog) && (NEVER.has(progName(second)) || MULTI.has(progName(second)))) return null;
    n = 2;
  } else if (RUNNERS.has(prog)) return null;
  return `Bash(${words.slice(0, n).join(' ')}:*)`;
}

// ── the ledger ───────────────────────────────────────────────────────────────
const MAX_RULES = 500;
const MAX_EXAMPLES = 3;
const MAX_PROJECTS = 5;
const MAX_EXAMPLE_LEN = 200;
const MAX_DISMISSED = 1000;

const blank = () => ({ v: 1, rules: {}, dismissed: [] });
const strs = (a, max) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : []).slice(0, max);

function load(file) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  // a missing or corrupt ledger starts fresh: it is a convenience, never a reason to fail a hook
  if (!d || typeof d !== 'object' || !d.rules || typeof d.rules !== 'object' || Array.isArray(d.rules)) return blank();
  const rules = {};
  for (const [rule, r] of Object.entries(d.rules)) {
    if (!r || typeof r !== 'object') continue;
    rules[rule] = {
      tool: String(r.tool || ''), allows: Number(r.allows) || 0, denies: Number(r.denies) || 0,
      firstAt: Number(r.firstAt) || 0, lastAt: Number(r.lastAt) || 0,
      examples: strs(r.examples, MAX_EXAMPLES), projects: strs(r.projects, MAX_PROJECTS),
    };
  }
  return { v: 1, rules, dismissed: strs(d.dismissed, MAX_DISMISSED) };
}

// tmp + rename: a crash or a full disk mid-write leaves the old file, never half a file
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function createLedger(opts) {
  const o = opts || {};
  const file = o.file || null;      // no file: in memory only
  const clock = () => (typeof o.now === 'function' ? o.now() : Number(o.now) || Date.now());
  const state = file ? load(file) : blank();
  const save = () => { if (file) try { writeAtomic(file, JSON.stringify(state)); } catch (_) {} };

  function record(ev) {
    if (!ev || typeof ev.rule !== 'string' || !ev.rule) return false;
    if (ev.kind !== 'allowed' && ev.kind !== 'denied') return false;
    const at = Number(ev.at) || clock();
    let r = state.rules[ev.rule];
    if (!r) {
      const keys = Object.keys(state.rules);
      if (keys.length >= MAX_RULES) {
        // drop the rule touched longest ago — one-off commands, not habits
        let old = keys[0];
        for (const k of keys) if (state.rules[k].lastAt < state.rules[old].lastAt) old = k;
        delete state.rules[old];
      }
      r = state.rules[ev.rule] = { tool: String(ev.tool || ''), allows: 0, denies: 0, firstAt: at, lastAt: at, examples: [], projects: [] };
    }
    if (ev.kind === 'allowed') r.allows++; else r.denies++;
    r.lastAt = Math.max(r.lastAt || 0, at);
    const ex = typeof ev.example === 'string' ? ev.example.trim().slice(0, MAX_EXAMPLE_LEN) : '';
    if (ex) r.examples = [ex, ...r.examples.filter((x) => x !== ex)].slice(0, MAX_EXAMPLES);
    const pj = typeof ev.project === 'string' ? ev.project.trim() : '';
    if (pj) r.projects = [pj, ...r.projects.filter((x) => x !== pj)].slice(0, MAX_PROJECTS);
    save();
    return true;
  }

  function suggestions(q) {
    const qq = q || {};
    const min = Number.isFinite(Number(qq.minAllows)) && qq.minAllows !== null ? Number(qq.minAllows) : 5;
    const have = new Set((Array.isArray(qq.existing) ? qq.existing : []).map(String));
    const gone = new Set(state.dismissed);
    return Object.entries(state.rules)
      // a single Deny means the user does NOT always want this — never ask them to allow it for good
      .filter(([rule, r]) => r.allows >= min && !(r.denies > 0) && !have.has(rule) && !gone.has(rule))
      .map(([rule, r]) => ({ rule, allows: r.allows, denies: r.denies, lastAt: r.lastAt, examples: r.examples.slice(0, MAX_EXAMPLES), projects: r.projects.slice(0, MAX_PROJECTS) }))
      .sort((a, b) => b.allows - a.allows || b.lastAt - a.lastAt || (a.rule < b.rule ? -1 : 1));
  }

  // dismissed is remembered: asking again after "no thanks" is the nagging this exists to remove
  function forget(rule) {
    if (typeof rule !== 'string' || !rule) return false;
    if (!state.dismissed.includes(rule)) {
      state.dismissed.push(rule);
      if (state.dismissed.length > MAX_DISMISSED) state.dismissed.splice(0, state.dismissed.length - MAX_DISMISSED);
    }
    save();
    return true;
  }

  const data = () => JSON.parse(JSON.stringify(state));
  return { record, suggestions, forget, data };
}

// ── writing the rule into Claude Code settings ───────────────────────────────
// The settings file is the user's. Every other key, and its order, survives;
// a file that isn't valid JSON is left alone (rewriting it would destroy what
// the user was halfway through typing); and a backup is written first.
function readSettings(settingsPath) {
  let text = null;
  try { text = fs.readFileSync(settingsPath, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') return { error: `could not read ${settingsPath}: ${e.message}` }; }
  let obj = {};
  if (text !== null && text.trim()) {
    try { obj = JSON.parse(text.replace(/^﻿/, '')); }
    catch (e) { return { error: `${settingsPath} is not valid JSON, so it was not changed: ${e.message}` }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: `${settingsPath} is not a JSON object, so it was not changed` };
  if (obj.permissions != null && (typeof obj.permissions !== 'object' || Array.isArray(obj.permissions))) return { error: 'permissions is not an object, so it was not changed' };
  if (obj.permissions && obj.permissions.allow != null && !Array.isArray(obj.permissions.allow)) return { error: 'permissions.allow is not a list, so it was not changed' };
  return { text, obj };
}

function writeSettings(settingsPath, text, obj) {
  try {
    if (text !== null) fs.writeFileSync(settingsPath + '.gander-bak', text);
    writeAtomic(settingsPath, JSON.stringify(obj, null, 2) + '\n');
    return null;
  } catch (e) { return `could not write ${settingsPath}: ${e.message}`; }
}

function applyRule(settingsPath, rule) {
  if (typeof rule !== 'string' || !rule.trim()) return { error: 'rule required' };
  if (!settingsPath) return { error: 'settings path required' };
  const s = readSettings(settingsPath);
  if (s.error) return s;
  const { text, obj } = s;
  if (!obj.permissions) obj.permissions = {};
  const before = Array.isArray(obj.permissions.allow) ? obj.permissions.allow : [];
  const seen = new Set();
  const next = [];
  for (const r of before) {
    if (typeof r === 'string') { if (seen.has(r)) continue; seen.add(r); }
    next.push(r);
  }
  const added = !seen.has(rule);
  if (added) next.push(rule);
  if (!added && next.length === before.length && text !== null) return { ok: true, added: false };   // nothing to change
  obj.permissions.allow = next;
  const err = writeSettings(settingsPath, text, obj);
  return err ? { error: err } : { ok: true, added };
}

function removeRule(settingsPath, rule) {
  if (typeof rule !== 'string' || !rule) return { error: 'rule required' };
  if (!settingsPath) return { error: 'settings path required' };
  const s = readSettings(settingsPath);
  if (s.error) return s;
  const { text, obj } = s;
  const allow = obj.permissions && Array.isArray(obj.permissions.allow) ? obj.permissions.allow : null;
  if (text === null || !allow || !allow.includes(rule)) return { ok: true, removed: false };
  obj.permissions.allow = allow.filter((r) => r !== rule);
  const err = writeSettings(settingsPath, text, obj);
  return err ? { error: err } : { ok: true, removed: true };
}

module.exports = { ruleFor, createLedger, applyRule, removeRule };
