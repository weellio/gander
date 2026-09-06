#!/usr/bin/env node
'use strict';
// gander-statusline — Gander's signals inside every Claude Code terminal.
//
// Claude Code pipes its session JSON on stdin; this prints one line:
//   [Fable 5.1] gander · ctx 42% · $1.23 · 🔔2 · 📋1▶ 3⏳ · 🙋1 · 💎3
// The Claude-side parts (model, dir, context %, cost) come from stdin; the
// Gander parts (needs-you, queue, escalations, gems for THIS project) come
// from the bridge in one fast local call. If the bridge is down you still
// get the Claude-side line — never a blank status bar.
//
//   node scripts/gander-statusline.js --install     # write statusLine into ~/.claude/settings.json
//   node scripts/gander-statusline.js --uninstall   # remove it (only if it's ours)
//
// Zero dependencies. Must stay FAST: Claude re-runs it often, so the bridge
// call has a short timeout and everything else is synchronous.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.AOC_PORT) || 3131;
const SELF = path.resolve(__filename).replace(/\\/g, '/');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CMD = `node "${SELF}"`;

function install(force) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (_) {}
  if (s.statusLine && !force && !(s.statusLine.command || '').includes('gander-statusline')) {
    console.log('You already have a status line configured:\n  ' + JSON.stringify(s.statusLine) + '\nRe-run with --force to replace it (Gander keeps a copy under ganderPrevStatusLine).');
    process.exit(1);
  }
  if (s.statusLine && !(s.statusLine.command || '').includes('gander-statusline')) s.ganderPrevStatusLine = s.statusLine;
  s.statusLine = { type: 'command', command: CMD };
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
  console.log('Installed. Gander now renders the status line in every Claude Code session (takes effect on the next session or /statusline refresh).');
}
function uninstall() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (_) { console.log('no settings file'); return; }
  if (!s.statusLine || !(s.statusLine.command || '').includes('gander-statusline')) { console.log('Gander status line is not installed.'); return; }
  if (s.ganderPrevStatusLine) { s.statusLine = s.ganderPrevStatusLine; delete s.ganderPrevStatusLine; console.log('Restored your previous status line.'); }
  else { delete s.statusLine; console.log('Removed the Gander status line.'); }
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
}

function ganderBits(cwd) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/statusline?cwd=' + encodeURIComponent(cwd || ''), method: 'GET', timeout: 350 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Compose the line from Claude's stdin JSON + Gander's bits. Exported for tests.
function compose(claude, g) {
  const parts = [];
  const model = claude && claude.model && (claude.model.display_name || claude.model.id);
  const dir = claude && claude.workspace && claude.workspace.current_dir;
  if (model) parts.push(`[${model}]`);
  if (dir) parts.push(path.basename(String(dir)));
  const ctx = claude && claude.context_window && claude.context_window.used_percentage;
  if (ctx != null) parts.push(`ctx ${Math.round(Number(ctx))}%`);
  const cost = claude && claude.cost && claude.cost.total_cost_usd;
  if (cost != null && Number(cost) > 0) parts.push(`$${Number(cost).toFixed(2)}`);
  const rl = claude && claude.rate_limits && claude.rate_limits.five_hour && claude.rate_limits.five_hour.used_percentage;
  if (rl != null && Number(rl) >= 80) parts.push(`⚡${Math.round(Number(rl))}%`);
  if (g) {
    if (g.needsYou) parts.push(`🔔${g.needsYou}`);
    if (g.running || g.queued) parts.push(`📋${g.running || 0}▶ ${g.queued || 0}⏳${g.paused ? '⏸' : ''}`);
    if (g.escalations) parts.push(`🙋${g.escalations}`);
    if (g.gems) parts.push(`💎${g.gems}`);
    if (g.review) parts.push(`👀${g.review}`);
  }
  return parts.join(' · ');
}

async function main() {
  const a = process.argv.slice(2);
  if (a.includes('--install')) return install(a.includes('--force'));
  if (a.includes('--uninstall')) return uninstall();
  let data = '';
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', async () => {
    let claude = null; try { claude = JSON.parse(data); } catch (_) {}
    const cwd = (claude && claude.workspace && claude.workspace.current_dir) || (claude && claude.cwd) || process.cwd();
    const g = await ganderBits(cwd);
    process.stdout.write(compose(claude, g));
  });
  if (process.stdin.isTTY) { process.stdout.write(compose(null, await ganderBits(process.cwd())) + '\n'); process.exit(0); }
}

if (require.main === module) main();
module.exports = { compose };
