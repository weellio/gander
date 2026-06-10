'use strict';
// routines.js — saved, repeatable Claude prompts ("routines") that run headlessly
// (claude -p) and leave their output on the dashboard as "briefings". A routine can
// invoke skills/MCP — e.g. a morning brief that checks mail/calendar/news.
//
// Headless run requirements (validated): strip CLAUDECODE* from env, close stdin,
// and pass --permission-mode (no one is there to answer prompts).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RFILE = path.join(__dirname, 'aoc-routines.json');
const BFILE = path.join(__dirname, 'aoc-briefings.json');

function load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
let routines = load(RFILE, null);
let briefings = load(BFILE, []);
function saveR() { try { fs.writeFileSync(RFILE, JSON.stringify(routines, null, 2)); } catch (_) {} }
function saveB() { try { fs.writeFileSync(BFILE, JSON.stringify(briefings.slice(0, 200), null, 2)); } catch (_) {} }

// Seed a sample read-only "Morning Brief" the first time, so the panel isn't empty.
if (routines === null) {
  routines = [{
    id: 'r-sample-brief',
    name: 'Morning Brief',
    cwd: '',
    prompt: "Compile a concise morning briefing. If I have a news / research skill, use it for AI + markets headlines. If Gmail/Calendar MCP tools are available, summarize important unread mail since yesterday evening and list today's meetings. Keep it tight and skimmable. If a tool isn't available, just say so and skip it.",
    permMode: 'bypassPermissions',
    schedule: '',        // '' = manual; 'HH:MM' = daily at that local time
    enabled: false,
    notify: false,
    timeoutSec: 600,
    lastRunAt: 0,
  }];
  saveR();
}

const genId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function listRoutines() { return routines; }
function listBriefings(limit) { return briefings.slice(0, limit || 60); }

function upsertRoutine(r) {
  if (!r || !String(r.name || '').trim() || !String(r.prompt || '').trim()) return { error: 'name and prompt are required' };
  const clean = {
    id: r.id || genId(),
    name: String(r.name).trim().slice(0, 80),
    cwd: String(r.cwd || '').trim(),
    prompt: String(r.prompt).trim().slice(0, 8000),
    permMode: ['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(r.permMode) ? r.permMode : 'bypassPermissions',
    schedule: /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(r.schedule || '')) ? String(r.schedule) : '',
    enabled: !!r.enabled,
    notify: !!r.notify,
    timeoutSec: Math.max(30, Math.min(3600, Number(r.timeoutSec) || 600)),
    lastRunAt: 0,
  };
  const i = routines.findIndex((x) => x.id === clean.id);
  if (i >= 0) { clean.lastRunAt = routines[i].lastRunAt || 0; routines[i] = clean; } else routines.push(clean);
  saveR();
  return { ok: true, routine: clean };
}
function deleteRoutine(id) { routines = routines.filter((x) => x.id !== id); saveR(); return { ok: true }; }

const running = new Set();   // routine ids currently running (avoid overlap)
function isRunning(id) { return running.has(id); }

// Run a routine headlessly; stores a briefing and calls onDone(briefing).
function runRoutine(id, opts) {
  opts = opts || {};
  const r = routines.find((x) => x.id === id);
  if (!r) return { error: 'routine not found' };
  if (running.has(id)) return { error: 'already running' };

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE_?CODE/i.test(k)) delete env[k];
  const cli = opts.cli || 'claude';
  const perm = r.permMode || 'bypassPermissions';
  const args = ['-p', r.prompt, '--permission-mode', perm, '--output-format', 'text'];
  const cwd = r.cwd && fs.existsSync(r.cwd) ? r.cwd : process.cwd();
  const t = Date.now();

  const finish = (ok, output, error) => {
    running.delete(id);
    const b = { id: genId(), routineId: r.id, name: r.name, project: r.cwd ? path.basename(r.cwd) : '', ts: Date.now(), ms: Date.now() - t, ok: !!ok, output: String(output || '').slice(0, 200000), error: String(error || '') };
    briefings.unshift(b); saveB();
    if (opts.onDone) try { opts.onDone(b); } catch (_) {}
    return b;
  };

  let child;
  try { child = spawn(cli, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
  catch (e) { finish(false, '', 'could not start claude: ' + e.message); return { error: 'spawn failed' }; }

  running.add(id);
  r.lastRunAt = t; saveR();
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; if (out.length > 300000) out = out.slice(-300000); });
  child.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
  const to = setTimeout(() => { try { child.kill(); } catch (_) {} }, (r.timeoutSec || 600) * 1000);
  child.on('error', (e) => { clearTimeout(to); finish(false, out.trim(), 'claude error: ' + e.message); });
  child.on('close', (code) => {
    clearTimeout(to);
    const text = out.trim();
    const ok = code === 0 && text.length > 0;
    finish(ok, text, ok ? '' : (err.trim() || (code === null ? 'timed out' : 'exit ' + code)));
  });
  return { ok: true, started: true };
}

// Scheduler tick — call ~every 30s. Runs enabled routines whose HH:MM matches now.
function tick(opts) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const r of routines) {
    if (!r.enabled || !r.schedule) continue;
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(r.schedule);
    if (!m) continue;
    if ((+m[1]) * 60 + (+m[2]) !== cur) continue;
    if (r.lastRunAt && (Date.now() - r.lastRunAt) < 90000) continue;   // already ran this minute
    runRoutine(r.id, opts);
  }
}

module.exports = { listRoutines, listBriefings, upsertRoutine, deleteRoutine, runRoutine, tick, isRunning };
