#!/usr/bin/env node
'use strict';
// gander board — leave notes for the other agents on this project, read theirs,
// or flag a human. The coordination board lives in the Gander bridge; this is
// the zero-dependency way any agent (Claude Code or a wrapped CLI) talks to it.
//
//   node scripts/board.js post   --project volt --agent Indexer --text "auth.js uses JWT, not sessions"
//   node scripts/board.js read   --project volt [--type finding] [--limit 20]
//   node scripts/board.js find    --project volt --text "the drift bug is in step()" [--refs 12,15]
//   node scripts/board.js escalate --project volt --text "tests delete prod data — a human should look"
//
// Why post: a note you leave (cheap) saves the next agent from re-deriving it
// (expensive). Read the board before you start exploring — someone may have
// already found what you need. Escalate when something needs a human decision;
// it pings them (desktop / Telegram / Slack) and lands in the Needs-you rail.
//
// Exit 0 on success, 1 on error. If the bridge isn't running it just says so.

const http = require('http');

function parse(argv) {
  const o = { _: [], port: Number(process.env.AOC_PORT) || 3131 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); o[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
    else o._.push(a);
  }
  return o;
}

function req(method, path, port, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}, timeout: 4000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (payload) r.write(payload); r.end();
  });
}

const USAGE = `gander board — shared notes for the agents on a project
  post      --project P --text "…" [--agent NAME]      leave a note
  find      --project P --text "…" [--refs 1,2]        post a finding (builds on refs)
  read      --project P [--type note|finding|escalation] [--limit N]
  escalate  --project P --text "…" [--agent NAME]      flag a human (pings them)
`;

async function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  const project = o.project;
  const fail = (m) => { console.error(m); process.exit(1); };

  try {
    if (cmd === 'read') {
      if (!project) return fail('need --project');
      const q = new URLSearchParams({ project });
      if (o.type) q.set('type', o.type);
      if (o.limit) q.set('limit', String(o.limit));
      const r = await req('GET', '/api/board?' + q, o.port);
      const rows = r.entries || [];
      if (!rows.length) { console.log(`(board empty for ${project})`); return; }
      for (const e of rows) {
        const when = new Date(e.createdAt).toISOString().slice(5, 16).replace('T', ' ');
        const tag = e.type === 'note' ? '' : `[${e.type}] `;
        console.log(`#${e.id}${e.pinned ? ' 📌' : ''} ${when} ${tag}${e.agent ? e.agent + ': ' : ''}${e.text}${e.refs && e.refs.length ? '  (builds on #' + e.refs.join(', #') + ')' : ''}`);
      }
      return;
    }

    const type = cmd === 'find' ? 'finding' : cmd === 'escalate' ? 'escalation' : 'note';
    if (['post', 'find', 'escalate'].includes(cmd)) {
      if (!project) return fail('need --project');
      if (!o.text || o.text === true) return fail('need --text "…"');
      const refs = typeof o.refs === 'string' ? o.refs.split(',').map((x) => Number(x.trim())).filter(Boolean) : undefined;
      const r = await req('POST', '/api/board', o.port, { project, type, text: String(o.text), agent: o.agent && o.agent !== true ? String(o.agent) : undefined, refs });
      if (r.error) return fail('board error: ' + r.error);
      console.log(`posted #${r.entry.id} (${r.entry.type}) to ${project}${type === 'escalation' ? ' — a human has been pinged' : ''}`);
      return;
    }

    process.stdout.write(USAGE);
    process.exit(cmd ? 1 : 0);
  } catch (e) {
    fail(`could not reach the Gander bridge on :${o.port} (${e.message}). Is it running?`);
  }
}

if (require.main === module) main();
module.exports = { parse };
