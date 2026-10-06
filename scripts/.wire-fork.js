// one-off: ⑂ fork a session + fork lineage
const fs = require('fs');
const R = 'D:/Files/sourcecode/Claude_Dashboard/';
function edit(file, pairs) {
  let s = fs.readFileSync(R + file, 'utf8');
  for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(file + ' missing: ' + a.slice(0, 90)); s = s.replace(a, b); }
  fs.writeFileSync(R + file, s); console.log('edited', file);
}

edit('bridge/server.js', [
  ['function launchSession(cwd, resume, prompt) {', 'function launchSession(cwd, resume, prompt, fork) {'],
  ['  const inner = resume ? `${base} --resume ${resume}` : (task ? `${base} "${task}"` : base);',
   '  // ⑂ fork: Claude Code\'s own --fork-session resumes the conversation under a NEW session id,\n  // so the original stays exactly as it was and the two can go different ways\n  const inner = resume ? `${base} --resume ${resume}${fork ? \' --fork-session\' : \'\'}` : (task ? `${base} "${task}"` : base);'],
  ['    const wantDispatch = !!cfg.dispatch && body.mode !== \'terminal\' && String(body.prompt || \'\').trim();',
   '    // a fork is an interactive branch you work in yourself, so it always opens a terminal\n    const wantDispatch = !!cfg.dispatch && body.mode !== \'terminal\' && !body.fork && String(body.prompt || \'\').trim();'],
  ['    const r = launchSession(body.cwd, body.resume, launchPrompt);\n    if (r.ok) captureWin(body.cwd);',
   '    if (body.fork && !body.resume) return sendJson(res, 400, { error: \'fork needs a session to fork from\' });\n    const r = launchSession(body.cwd, body.resume, launchPrompt, !!body.fork);\n    if (r.ok && body.fork) noteForkLaunch(body.resume, body.cwd);\n    if (r.ok) captureWin(body.cwd);'],
  // lineage store + linking from SessionStart
  ['let gpuLowered = [];',
   `// ⑂ Fork lineage. --fork-session gives the branch a brand-new session id that
// nothing announces, so the bridge remembers the fork it launched and links the
// next session to start in that folder within 3 minutes.
const FORKS_FILE = path.join(__dirname, 'aoc-forks.json');
let forks = []; try { forks = JSON.parse(fs.readFileSync(FORKS_FILE, 'utf8')) || []; } catch (_) { forks = []; }
const forksPending = [];   // [{ parent, cwdKey, at }]
function noteForkLaunch(parent, cwd) { forksPending.push({ parent, cwdKey: projKeyOf(cwd), at: Date.now() }); }
function linkFork(body) {
  if (body.hook_event_name !== 'SessionStart' || !body.session_id || !body.cwd) return;
  const key = projKeyOf(body.cwd), now = Date.now();
  const i = forksPending.findIndex((f) => f.cwdKey === key && now - f.at < 3 * 60 * 1000 && f.parent !== body.session_id);
  if (i < 0) return;
  const f = forksPending.splice(i, 1)[0];
  if (forks.some((x) => x.child === body.session_id)) return;
  forks.push({ child: body.session_id, parent: f.parent, at: now });
  if (forks.length > 2000) forks = forks.slice(-2000);
  try { fs.writeFileSync(FORKS_FILE, JSON.stringify(forks)); } catch (_) {}
  console.log('[fork] ' + body.session_id.slice(0, 8) + ' forked from ' + f.parent.slice(0, 8));
}

let gpuLowered = [];`],
  ["    try { noteEdit(body, project); } catch (e) { console.error('[collision]', e && e.message); }",
   "    try { noteEdit(body, project); } catch (e) { console.error('[collision]', e && e.message); }\n    try { linkFork(body); } catch (_) {}"],
  ["    return sendJson(res, 200, await history.list({}));",
   "    const h = await history.list({});\n    // ⑂ lineage: which sessions are forks, and how many branches each has\n    const list = Array.isArray(h) ? h : (h && (h.sessions || h.items)) || [];\n    for (const s of list) {\n      const f = forks.find((x) => x.child === s.sessionId);\n      if (f) s.forkOf = f.parent;\n      const n = forks.filter((x) => x.parent === s.sessionId).length;\n      if (n) s.forkCount = n;\n    }\n    return sendJson(res, 200, h);"],
]);

edit('web/src/lib/HistoryPanel.svelte', [
  ['  async function copyResume(session) {',
   `  // ⑂ branch this session into a new one (Claude Code's --fork-session): the original
  // is left exactly as it was, so you can try a different direction without losing it
  let forked = $state(null);
  async function fork(session) {
    try {
      await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: session.cwd, resume: session.sessionId, fork: true }) });
      forked = session.sessionId;
      setTimeout(() => { if (forked === session.sessionId) forked = null; }, 2500);
    } catch (_) {}
  }

  async function copyResume(session) {`],
  ['              <span class="sid mono">{s.sessionId.slice(0, 8)}</span>',
   '              <span class="sid mono">{s.sessionId.slice(0, 8)}</span>\n              {#if s.forkOf}<span class="fork" title="Forked from session {s.forkOf}">⑂ from {s.forkOf.slice(0, 8)}</span>{/if}\n              {#if s.forkCount}<span class="fork" title="{s.forkCount} branch(es) were forked from this session">⑂ {s.forkCount}</span>{/if}'],
  ['                <button\n                  class="copy-btn"\n                  class:copied-state={copied === s.sessionId}',
   '                <button class="copy-btn" onclick={() => fork(s)} title="Branch this session into a new one. The original stays exactly as it is, so you can try a different direction">\n                  {forked === s.sessionId ? \'forking…\' : \'⑂ Fork\'}\n                </button>\n                <button\n                  class="copy-btn"\n                  class:copied-state={copied === s.sessionId}'],
]);
// style
{
  const f = R + 'web/src/lib/HistoryPanel.svelte';
  let s = fs.readFileSync(f, 'utf8');
  const i = s.lastIndexOf('</style>');
  s = s.slice(0, i) + '  .fork { font-size: 10px; font-family: var(--font-mono); color: var(--color-text-secondary); margin-left: 6px; }\n' + s.slice(i);
  fs.writeFileSync(f, s); console.log('styled HistoryPanel');
}
fs.appendFileSync(R + '.gitignore', 'bridge/aoc-forks.json\n');
console.log('gitignore: aoc-forks.json');
