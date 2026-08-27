#!/usr/bin/env node
'use strict';
// gander-wrap — put ANY agent CLI on the Gander floor. Zero dependencies.
//
//   node scripts/gander-wrap.js --name Codex --project myapp -- codex exec "fix the tests"
//   node scripts/gander-wrap.js --name Gemini -- gemini -p "review this repo"
//   node scripts/gander-wrap.js --name Aider --parent wrap:Codex:123 -- aider --message "add tests"
//
// Claude Code sessions report themselves through hooks; every other tool can
// be wrapped: this spawns the command, passes stdio through untouched, and
// posts live events to the bridge — a tile appears, shows activity while the
// tool prints, celebrates on exit 0, errors on non-zero. If the bridge is
// down the wrapped command still runs exactly as it would have.
//
// Flags (all optional except the command after `--`):
//   --name <label>      tile name             (default: the command's basename)
//   --project <name>    project/room label    (default: current folder name)
//   --parent <agentId>  nest under another wrapped agent (sub-agent tile)
//   --port <n>          bridge port           (default: 3131 or AOC_PORT)

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

function parseArgs(argv) {
  const o = { port: Number(process.env.AOC_PORT) || 3131, name: '', project: '', parent: '', cmd: [] };
  const sep = argv.indexOf('--');
  const flags = sep === -1 ? argv : argv.slice(0, sep);
  o.cmd = sep === -1 ? [] : argv.slice(sep + 1);
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--name') o.name = flags[++i] || '';
    else if (flags[i] === '--project') o.project = flags[++i] || '';
    else if (flags[i] === '--parent') o.parent = flags[++i] || '';
    else if (flags[i] === '--port') o.port = Number(flags[++i]) || o.port;
  }
  if (!o.name && o.cmd.length) o.name = path.basename(o.cmd[0]).replace(/\.(exe|cmd|bat|sh|js|py)$/i, '');
  if (!o.project) o.project = path.basename(process.cwd());
  return o;
}

// Map a run's lifecycle onto Gander's states (no guessing at tool semantics:
// alive+quiet = thinking, alive+printing = coding, exit 0 = done, else error).
function eventFor(phase, o, extra) {
  const base = { agentId: o.agentId, name: o.name, project: o.project, cwd: process.cwd() };
  if (o.parent) base.parentId = o.parent;
  if (phase === 'start') return { ...base, state: 'thinking', goal: o.cmd.join(' ').slice(0, 300) };
  if (phase === 'output') return { ...base, state: 'coding', log: extra };
  if (phase === 'exit') return { ...base, state: extra === 0 ? 'done' : 'error', log: extra === 0 ? 'finished' : `exit code ${extra}` };
  return base;
}

function post(port, body) {
  try {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/event', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 1500 }, (res) => res.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(payload);
  } catch (_) {}
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.cmd.length) {
    console.error('usage: gander-wrap [--name X] [--project Y] [--parent agentId] [--port 3131] -- <command> [args...]');
    process.exit(2);
  }
  o.agentId = `wrap:${o.name}:${process.pid}`;
  post(o.port, eventFor('start', o));

  // Windows needs a shell for npm shims (.cmd) — but node's shell mode
  // concatenates args UNQUOTED, so quote them ourselves ("" escapes a quote
  // inside cmd.exe quotes). Elsewhere spawn directly, no shell games.
  const winQ = (a) => (/[\s"^&|<>]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a);
  const child = process.platform === 'win32'
    ? spawn(o.cmd.map(winQ).join(' '), { stdio: ['inherit', 'pipe', 'pipe'], shell: true })
    : spawn(o.cmd[0], o.cmd.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
  let lastPost = 0, lastLine = '';
  const onChunk = (out) => (d) => {
    out.write(d);                                             // passthrough — the tool behaves as if unwrapped
    const line = String(d).split('\n').filter((l) => l.trim()).pop();
    if (line) lastLine = line.trim().slice(0, 160);
    const now = Date.now();
    if (now - lastPost > 2000 && lastLine) { lastPost = now; post(o.port, eventFor('output', o, lastLine)); }
  };
  child.stdout.on('data', onChunk(process.stdout));
  child.stderr.on('data', onChunk(process.stderr));
  child.on('exit', (code) => { post(o.port, eventFor('exit', o, code == null ? 1 : code)); process.exitCode = code == null ? 1 : code; });
  child.on('error', (e) => { console.error('gander-wrap: could not start command:', e.message); post(o.port, eventFor('exit', o, 127)); process.exitCode = 127; });
  process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch (_) {} });
}

if (require.main === module) main();
module.exports = { parseArgs, eventFor };
