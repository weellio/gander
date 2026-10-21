// No-install demo: the dashboard with no bridge behind it.
//
// Imported first by main.js only when the bundle is built with VITE_DEMO=1
// (npm run build:demo). It replaces window.fetch for /api/... with canned
// answers from web/demo/*.json (served next to the page as demo/*.json), keeps
// a small swarm "alive" (geese change
// state, a sub-agent spawns and finishes, the feed rotates, one session keeps
// waiting on a permission), and turns every write into a friendly toast.
// Nothing here runs in the real build: main.js only imports this file behind
// `import.meta.env.VITE_DEMO === '1'`, and Vite drops the dead branch.

const BASE = import.meta.env.BASE_URL || '/';
const realFetch = window.fetch.bind(window);
const TOAST = 'Demo mode: install Gander to do this for real';
const REPO = 'https://github.com/weellio/gander';
const TICK_MS = 3000;

// ── fixtures ─────────────────────────────────────────────────────────────────
const FILES = ['state', 'feed', 'usage', 'projects', 'health', 'gpu', 'queue', 'safety', 'mcp-config', 'mod-status', 'datasets', 'briefings', 'routines', 'board', 'history', 'subagents', 'digest', 'lessons', 'patterns', 'suggestions', 'skills', 'skill-usage', 'processes', 'forensics', 'codex', 'inspect', 'session-meta', 'context-breakdown', 'transcript', 'github', 'search', 'replay', 'away', 'configs'];
const fx = {};
let ready = null;
function load() {
  if (ready) return ready;
  ready = Promise.all(FILES.map(async (f) => {
    try { fx[f] = await (await realFetch(`${BASE}demo/${f}.json`, { cache: 'no-store' })).json(); }
    catch (e) { console.warn('[demo] fixture missing:', f, e && e.message); fx[f] = {}; }
  })).then(boot);
  return ready;
}

// Fixtures store times as offsets so the page never looks stale:
//   fooAgo   -> foo (epoch ms, or fooAt for created/runStart/updated/done/...)
//   fooAgoMs -> foo (ISO string)
//   dayAgo   -> date "YYYY-MM-DD"
const AT_KEYS = { createdAgo: 'createdAt', runStartAgo: 'runStartAt', updatedAgo: 'updatedAt', startedAgo: 'startedAt', endedAgo: 'endedAt', doneAgo: 'doneAt', lastRunAgo: 'lastRunAt', atAgo: 'at', tsAgo: 'ts', lastAgo: 'lastAt', lastUsedAgo: 'lastUsed', lastActiveAgo: 'lastActive' };
function dayKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function rebase(v, now) {
  if (Array.isArray(v)) return v.map((x) => rebase(x, now));
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === 'dayAgo') { const d = new Date(now); d.setDate(d.getDate() - val); out.date = dayKey(d); }
    else if (k.endsWith('AgoMs')) out[k.slice(0, -5)] = new Date(now - val).toISOString();
    else if (AT_KEYS[k]) out[AT_KEYS[k]] = val === 0 && (k === 'runStartAgo') ? 0 : now - val;
    else if (k.endsWith('Ago')) out[k.slice(0, -3) + 'At'] = now - val;
    else out[k] = rebase(val, now);
  }
  return out;
}

// ── the live swarm ───────────────────────────────────────────────────────────
let agents = [], feed = [], usage = null, procs = [], base = null;
let tick = 0, spawnN = 0;
const WORK = ['coding', 'reading', 'testing', 'searching', 'running', 'thinking'];
const LINES = {
  'web-shop': { coding: ['Edit src/cart/Checkout.svelte', 'Write src/cart/coupon.js', 'Edit tests/cart.test.js'], reading: ['Read src/cart/total.js', 'Read package.json', 'Read src/cart/Checkout.svelte'], testing: ['Bash npm test -- cart', 'Bash npm test'], searching: ['Grep couponCode', 'Glob src/**/*.svelte'], running: ['Bash npm run build', 'Bash git diff --stat'], thinking: ['reading the failing assertion', 'planning the coupon reducer'] },
  'api-gateway': { coding: ['Edit src/auth/keys.js', 'Edit src/auth/verify.js', 'Edit config/flags.json'], reading: ['Read src/auth/keys.js', 'Read config/flags.json'], testing: ['Bash npm test'], searching: ['Grep signingKey', 'WebSearch "jwt key rotation rollout"'], running: ['Bash git status', 'Bash npm run lint'], thinking: ['weighing a dual-key window', 'checking the flag default'] },
  'docs-site': { coding: ['Write docs/getting-started.md', 'Edit docs/cli.md', 'Edit mkdocs.yml'], reading: ['Read docs/cli.md', 'Read README.md', 'Read docs/install.md'], testing: ['Bash mkdocs build --strict'], searching: ['Grep --flag', 'Glob docs/**/*.md'], running: ['Bash mkdocs serve', 'Bash git diff'], thinking: ['ordering the first three steps', 'deciding what to cut'] },
  'mobile-app': { coding: ['Edit app/src/androidTest/LoginTest.kt'], reading: ['Read app/build.gradle'], testing: ['Bash ./gradlew test'], searching: ['Grep IdlingResource'], running: ['Bash ./gradlew assembleDebug'], thinking: ['reading the stack trace'] },
};
const SPAWN_POOL = [
  { parent: 'demo-s1', name: 'Linter', role: 'general-purpose', task: 'lint the cart folder and fix the warnings', first: 'running', line: 'Bash npm run lint -- src/cart' },
  { parent: 'demo-s3', name: 'LinkChecker', role: 'Explore', task: 'find every dead link in docs/', first: 'searching', line: 'Grep https?://' },
  { parent: 'demo-s1', name: 'Benchmarker', role: 'general-purpose', task: 'time the cart total on 1k items', first: 'testing', line: 'Bash node bench/cart.js' },
  { parent: 'demo-s3', name: 'Proofreader', role: 'Reviewer', task: 'read the new page as a first-time user', first: 'reading', line: 'Read docs/getting-started.md' },
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const lineFor = (a, state) => pick((LINES[a.project] || LINES['web-shop'])[state] || ['working…']);
function pushFeed(a, state, log, error) {
  feed.unshift({ ts: Date.now(), agentId: a.id, agent: a.name, project: a.project || '', sessionId: a.sessionId || '', state, log, error: !!error });
  if (feed.length > 200) feed.length = 200;
}
function setState(a, state, log) {
  a.state = state; a.updatedAt = Date.now();
  if (log) { a.logLines = [log, ...(a.logLines || [])].slice(0, 8); pushFeed(a, state, log); }
}
function boot() {
  const now = Date.now();
  base = rebase(fx.state, now);
  agents = base.agents || [];
  procs = base.procs || [];
  feed = (rebase(fx.feed, now).events || []);
  usage = rebase(fx.usage, now);
  for (const k of ['projects', 'history', 'subagents', 'queue', 'safety', 'board', 'briefings', 'routines', 'lessons', 'digest', 'forensics', 'skill-usage', 'search', 'transcript', 'away', 'configs']) fx[k] = rebase(fx[k], now);
  setInterval(step, TICK_MS);
}
function todayRow() { const k = dayKey(new Date()); return (usage.byDay || []).find((d) => d.date === k); }
function step() {
  tick++;
  const now = Date.now();
  // 1. one worker changes what it is doing
  const workers = agents.filter((a) => WORK.includes(a.state) && !a.retiring);
  if (workers.length && Math.random() < 0.85) {
    const a = pick(workers);
    const next = pick(WORK.filter((s) => s !== a.state && (a.root || s !== 'thinking')));
    setState(a, next, lineFor(a, next));
  }
  // 2. a sub-agent spawns (~ every 12 s), works, finishes with a 👍, clocks out
  for (const a of agents) {
    if (!a._demoBorn) continue;
    const age = now - a._demoBorn;
    if (a.state === 'spawning' && age > TICK_MS) setState(a, a._demoFirst, a._demoLine);
    else if (a.state !== 'done' && age > 16000) { setState(a, 'done', 'task complete'); pushFeed(a, 'done', 'task complete'); }
    else if (a.state === 'done' && age > 24000) { a.retiring = true; a.retireAt = now + 4000; }
    if (a.retiring && now > a.retireAt) agents.splice(agents.indexOf(a), 1);
  }
  if (tick % 4 === 0 && !agents.some((a) => a._demoBorn)) {
    const s = SPAWN_POOL[spawnN++ % SPAWN_POOL.length];
    const parent = agents.find((a) => a.id === s.parent);
    if (parent) {
      setState(parent, 'spawning', `Agent ${s.name}: ${s.task}`);
      agents.push({ id: `demo-sp-${spawnN}`, name: s.name, role: s.role, parentId: parent.id, project: parent.project, sessionId: parent.sessionId, cwd: parent.cwd, state: 'spawning', logLines: [s.task], createdAt: now, runStartAt: now, updatedAt: now, closed: false, retiring: false, retireAt: 0, runaway: false, costUSD: 0.02, _demoBorn: now, _demoFirst: s.first, _demoLine: s.line });
      pushFeed(parent, 'spawning', `Agent ${s.name}: ${s.task}`);
    }
  }
  // 3. the idle session wakes up now and then, then parks again
  const idle = agents.find((a) => a.id === 'demo-s4');
  if (idle && tick % 20 === 10 && idle.state === 'idle') setState(idle, 'thinking', 'reading the stack trace');
  else if (idle && tick % 20 === 13 && idle.state !== 'idle') setState(idle, 'idle', 'waiting for your next prompt');
  // 4. money keeps moving (a cent or two per tick across the floor — visible, not silly)
  const row = todayRow();
  const spend = +(0.004 * workers.length).toFixed(3);
  for (const a of agents) if (WORK.includes(a.state) && typeof a.costUSD === 'number') a.costUSD = +(a.costUSD + 0.004).toFixed(3);
  if (row) { row.costUSD = +(row.costUSD + spend).toFixed(3); usage.totals.costUSD = +(usage.totals.costUSD + spend).toFixed(3); }
  if (usage.window5h) usage.window5h.costUSD = +(usage.window5h.costUSD + spend).toFixed(3);
  const s1 = usage.bySession && usage.bySession['11111111-1111-4111-8111-111111111111'];
  if (s1) s1.costUSD = +(s1.costUSD + 0.004).toFixed(3);
}
function snapshot() {
  const list = agents.map((a) => { const { _demoBorn, _demoFirst, _demoLine, ...rest } = a; return rest; });
  const by = {};
  for (const a of list) {
    const pj = a.project || 'unknown';
    by[pj] = by[pj] || { project: pj, total: 0, sessions: new Set(), states: {}, muted: false };
    by[pj].total++; if (a.sessionId) by[pj].sessions.add(a.sessionId); by[pj].states[a.state] = (by[pj].states[a.state] || 0) + 1;
  }
  const row = todayRow();
  const { agents: _a, procs: _p, ...rest } = base;
  return { ...rest, agents: list, procs, projects: Object.values(by).map((p) => ({ ...p, sessions: p.sessions.size })), budget: { ...(base.budget || {}), dailyCost: row ? row.costUSD : 0, generatedAt: Date.now() }, build: 'demo' };
}

// ── routing ──────────────────────────────────────────────────────────────────
const CONFIG_KEYS = ['license', 'app-config', 'budget', 'dispatch-config', 'claude-version', 'teams', 'peers', 'permissions', 'runbook', 'editor', 'claude-config', 'telegram-config', 'slack-config', 'nudge-config', 'os-notify-config', 'pricing-config', 'ambient-config', 'board-config', 'fleet-config', 'templates', 'phone', 'mod/band', 'git-status', 'queue/diff'];
const bySession = (file, sid) => (fx[file] || {})[sid] || { error: 'unknown session' };
function route(p, q, method, body) {
  const sid = q.get('session') || (body && body.sessionId) || '';
  if (method === 'GET' || ['search', 'transcript', 'replay', 'github', 'git-status'].includes(p)) {
    switch (p) {
      case 'state': return snapshot();
      case 'feed': return { events: feed };
      case 'usage': return { ...usage, generatedAt: Date.now() };
      case 'gpu': { const g = JSON.parse(JSON.stringify(fx.gpu)); const now = Date.now(); g.at = now; if (g.nvidia) { g.nvidia.readAt = now; const c = g.nvidia.gpus && g.nvidia.gpus[0]; if (c) c.util = 8 + Math.round(Math.random() * 14); } g.history = (g.history || []).map((h, i, arr) => ({ ...h, at: now - (arr.length - i) * 60000 })); return g; }
      case 'mod/status': return fx['mod-status'];
      case 'board': { const b = fx.board; return q.get('project') ? { project: q.get('project'), entries: (b.entries || []).filter((e) => e.project === q.get('project')), claims: b.claims || [], types: b.types } : { summary: b.summary, types: b.types }; }
      case 'inspect': return bySession('inspect', sid);
      case 'session-meta': return bySession('session-meta', sid);
      case 'context-breakdown': return bySession('context-breakdown', sid);
      case 'transcript': return bySession('transcript', sid);
      case 'replay': return fx.replay;
      case 'github': return fx.github;
      case 'search': { const s = fx.search; return { ...s, q: (body && body.q) || '' }; }
      case 'away': { const since = Number(q.get('since')) || 0; const now = Date.now(); return { ...fx.away, since, now, minutes: since ? Math.round((now - since) / 60000) : 0 }; }
      case 'health': return fx.health;
      case 'briefings': return fx.briefings;
      case 'datasets': return fx.datasets;
      case 'skill-usage': return fx['skill-usage'];
      default:
        if (p.startsWith('datasets/')) return { rows: [], note: 'demo' };
        if (fx[p] !== undefined) return fx[p];
        if (CONFIG_KEYS.includes(p)) return fx.configs[p];
        return { error: 'not in the demo' };
    }
  }
  // any write: pretend it worked, and say so
  toast(TOAST);
  if (p === 'queue') return { ok: true, demo: true, ...fx.queue };
  if (p === 'routines') return { ok: true, demo: true, ...fx.routines };
  if (p === 'templates' || p === 'templates/delete') return { ok: true, demo: true, templates: fx.configs.templates.templates };
  if (p === 'launch') return { ok: true, demo: true, pid: 0, note: 'demo' };
  if (p === 'component-generate') return { ok: true, demo: true, body: '# demo\n\nInstall Gander to generate a real component here.' };
  return { ok: true, demo: true };
}
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
window.fetch = async function demoFetch(input, init) {
  const raw = typeof input === 'string' ? input : (input && input.url) || '';
  let u; try { u = new URL(raw, location.href); } catch (_) { return realFetch(input, init); }
  if (u.origin !== location.origin) return realFetch(input, init);
  let path = u.pathname;
  if (path.startsWith(BASE + 'api/')) path = path.slice(BASE.length - 1);
  if (!path.startsWith('/api/')) return realFetch(input, init);
  await load();
  const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  let body = null;
  try { if (init && typeof init.body === 'string') body = JSON.parse(init.body); } catch (_) {}
  try { return jsonResponse(route(path.slice(5), u.searchParams, method, body)); }
  catch (e) { console.warn('[demo] route failed', path, e); return jsonResponse({ error: 'demo: ' + (e && e.message) }, 500); }
};
// the app never opens a socket, but if a future build does, keep it quiet
const RealWS = window.WebSocket;
window.WebSocket = function DemoSocket(url, protocols) {
  let u; try { u = new URL(url, location.href); } catch (_) { u = null; }
  if (u && u.host !== location.host) return new RealWS(url, protocols);
  const ws = { url: String(url), readyState: 3, send() {}, close() {}, addEventListener() {}, removeEventListener() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
  return ws;
};

// ── chrome: banner + toast, tour off ─────────────────────────────────────────
try { localStorage.setItem('aoc-toured', '1'); localStorage.setItem('aoc-desktop-notify', 'false'); } catch (_) {}
const style = document.createElement('style');
style.textContent = `
  .demo-banner { position: sticky; top: 0; z-index: 250; display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap;
    padding: 6px 14px; font: 500 12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; letter-spacing: 0.01em;
    background: #F59E0B; color: #1a1815; box-shadow: 0 2px 10px rgba(0,0,0,0.25); }
  .demo-banner b { text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; }
  .demo-banner .sep { opacity: 0.6; }
  .demo-banner a { color: #1a1815; font-weight: 700; text-decoration: none; padding: 2px 10px; border-radius: 999px; background: rgba(0,0,0,0.12); border: 1px solid rgba(0,0,0,0.25); }
  .demo-banner a:hover { background: rgba(0,0,0,0.2); }
  .demo-toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 300; max-width: calc(100vw - 32px);
    background: #1a1815; color: #fff; border: 0.5px solid rgba(255,255,255,0.18); border-left: 3px solid #F59E0B; border-radius: 8px;
    padding: 9px 14px; font: 500 12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,0.35);
    animation: demotoast 0.2s ease; }
  .demo-toast a { color: #FCD34D; margin-left: 8px; }
  @keyframes demotoast { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
`;
document.head.appendChild(style);
const banner = document.createElement('div');
banner.className = 'demo-banner';
banner.innerHTML = `<b>Demo</b><span class="sep">·</span><span>nothing here is real — four made-up sessions, canned numbers</span><span class="sep">·</span><a href="${REPO}" target="_blank" rel="noopener">Install Gander →</a>`;
document.body.prepend(banner);
let toastEl = null, toastTimer = 0;
function toast(text) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'demo-toast'; toastEl.setAttribute('role', 'status'); }
  toastEl.innerHTML = `${text}<a href="${REPO}" target="_blank" rel="noopener">github.com/weellio/gander</a>`;
  if (!toastEl.isConnected) document.body.appendChild(toastEl);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl && toastEl.remove(), 3200);
}
// confirm()/prompt() dialogs sit in front of some writes (clear images, request changes) — never block the demo
window.confirm = () => true;
window.prompt = () => 'demo';
window.__ganderDemo = { toast, snapshot: () => snapshot(), agents: () => agents, step };
load();
