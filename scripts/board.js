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

const USAGE = `gander board — coordinate with the other agents on a project
  read      --project P [--type note|finding|claim|plan|assignment] [--limit N]
  gems      --project P                                 the durable findings — read these FIRST
  promote   --id N                                      mark a finding a gem (carries forward)
  lineage   --project P                                 findings as a build-on tree
  post      --project P --text "…" [--agent NAME]       leave a note
  find      --project P --text "…" [--refs 1,2]         a finding (builds on refs)
  escalate  --project P --text "…" [--agent NAME]       flag a human (pings them)
  claim     --project P --resource path [--agent NAME] [--minutes N]   advisory hold
  release   --id N                                      let a claim go
  plan      --project P --text "…" [--agent NAME] [--wait]   ask a human to approve
  assign    --project P --text "…" [--agent NAME]        (coordinator) post a task
  take      --id N --agent NAME                          claim an assignment
  report    --id N                                       mark an assignment done
`;

function print(e) {
  const when = new Date(e.createdAt).toISOString().slice(5, 16).replace('T', ' ');
  const tag = e.type === 'note' ? '' : `[${e.type}] `;
  const st = e.meta && e.meta.status ? ` <${e.meta.status}>` : '';
  console.log(`#${e.id}${e.pinned ? ' 📌' : ''} ${when} ${tag}${e.agent ? e.agent + ': ' : ''}${e.text}${st}${e.refs && e.refs.length ? '  (builds on #' + e.refs.join(', #') + ')' : ''}`);
}
function printTree(nodes, depth) {
  for (const n of nodes || []) { console.log('  '.repeat(depth) + `#${n.id} ${n.agent ? n.agent + ': ' : ''}${n.text}`); printTree(n.children, depth + 1); }
}

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
      for (const e of rows) print(e);
      return;
    }

    if (cmd === 'lineage') {
      if (!project) return fail('need --project');
      const r = await req('GET', '/api/board?' + new URLSearchParams({ project, view: 'lineage' }), o.port);
      if (!r.lineage || !r.lineage.length) { console.log(`(no findings for ${project})`); return; }
      printTree(r.lineage, 0);
      return;
    }

    // gems — the durable lane the next session should start from
    if (cmd === 'gems') {
      if (!project) return fail('need --project');
      const r = await req('GET', '/api/board?' + new URLSearchParams({ project, view: 'gems' }), o.port);
      if (!r.gems || !r.gems.length) { console.log(`(no gems for ${project} — promote a key finding with: board.js promote --id N)`); return; }
      for (const e of r.gems) console.log(`💎 #${e.id} ${e.agent ? e.agent + ': ' : ''}${e.text}`);
      return;
    }
    if (cmd === 'promote' || cmd === 'demote') {
      if (!o.id || o.id === true) return fail('need --id N');
      const r = await req('POST', '/api/board/action', o.port, { id: Number(o.id), action: cmd });
      if (r.error) return fail('board error: ' + r.error);
      console.log(`${cmd} #${o.id} ok`);
      return;
    }

    const agent = o.agent && o.agent !== true ? String(o.agent) : undefined;

    // claims
    if (cmd === 'claim') {
      if (!project) return fail('need --project');
      const resource = o.resource && o.resource !== true ? String(o.resource) : (o.text && o.text !== true ? String(o.text) : null);
      if (!resource) return fail('need --resource path');
      const mins = Number(o.minutes) || 30;
      const r = await req('POST', '/api/board', o.port, { project, type: 'claim', agent, text: 'holds ' + resource, meta: { resource, expiresAt: Date.now() + mins * 60000 } });
      if (r.error) return fail('board error: ' + r.error);
      console.log(`claimed ${resource} (#${r.entry.id}) for ${mins}m — release with: board.js release --id ${r.entry.id}`);
      return;
    }

    // simple id-actions: release / take / report
    if (cmd === 'release' || cmd === 'take' || cmd === 'report') {
      if (!o.id || o.id === true) return fail('need --id N');
      const action = cmd === 'release' ? 'release' : cmd === 'take' ? 'claim-task' : 'complete';
      const r = await req('POST', '/api/board/action', o.port, { id: Number(o.id), action, agent });
      if (r.error) return fail('board error: ' + r.error);
      console.log(`${cmd} #${o.id} ok`);
      return;
    }

    // plan (optionally block until a human approves/vetoes)
    if (cmd === 'plan') {
      if (!project) return fail('need --project');
      if (!o.text || o.text === true) return fail('need --text "…"');
      const r = await req('POST', '/api/board', o.port, { project, type: 'plan', agent, text: String(o.text), meta: { status: 'pending' } });
      if (r.error) return fail('board error: ' + r.error);
      console.log(`plan #${r.entry.id} posted — a human was asked to approve`);
      if (o.wait) {
        const id = r.entry.id;
        for (let i = 0; i < 600; i++) {   // poll up to ~30 min
          await new Promise((s) => setTimeout(s, 3000));
          const g = await req('GET', '/api/board?' + new URLSearchParams({ project, all: '1' }), o.port);
          const e = (g.entries || []).find((x) => x.id === id);
          const status = e && e.meta && e.meta.status;
          if (status === 'approved') { console.log('APPROVED — go'); return; }
          if (status === 'vetoed') { console.log('VETOED — do not proceed'); process.exit(2); }
        }
        console.log('(no verdict yet — still pending)');
      }
      return;
    }

    const type = cmd === 'find' ? 'finding' : cmd === 'escalate' ? 'escalation' : cmd === 'assign' ? 'assignment' : 'note';
    if (['post', 'find', 'escalate', 'assign'].includes(cmd)) {
      if (!project) return fail('need --project');
      if (!o.text || o.text === true) return fail('need --text "…"');
      const refs = typeof o.refs === 'string' ? o.refs.split(',').map((x) => Number(x.trim())).filter(Boolean) : undefined;
      const meta = type === 'assignment' ? { status: 'open' } : undefined;
      const r = await req('POST', '/api/board', o.port, { project, type, text: String(o.text), agent, refs, meta });
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
