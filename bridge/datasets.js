'use strict';
// Row-shaped datasets over what the bridge already computes.
//
// One catalog feeds three consumers: GET /api/datasets/<id> (JSON rows, or CSV
// with ?format=csv), the MCP connector's tools (one per dataset), and the
// "dashboard data pack" a person attaches to a Claude Dashboard. Every dataset
// is either `rows` (an array of flat objects, first row names the columns) or
// a `record` (one flat object). Nothing here changes state.

let deps = null;   // injected by init(): the bridge's modules and getters

function init(d) { deps = d; }
function need() { if (!deps) throw new Error('datasets not initialised'); return deps; }

const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const iso = (v) => (typeof v === 'number' ? new Date(v).toISOString() : (v ? String(v) : null));
const r2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : (v == null ? null : Number(v) || 0));

// ── the catalog ──────────────────────────────────────────────────────────────
// id -> { title, description, kind, params, get(params) }
const CATALOG = {
  cost_by_day: {
    title: 'Spend by day', kind: 'rows',
    description: 'Claude Code spend and tokens per calendar day for the last 30 days, every day present (zero when idle). Estimated from transcripts at API list prices. Columns: date (YYYY-MM-DD), costUSD, tokens.',
    params: {},
    async get() {
      const s = await need().usage.summaryAsync();
      return (s.byDay || []).map((d) => ({ date: d.date, costUSD: r2(d.costUSD), tokens: Number(d.tokens) || 0 }));
    },
  },
  cost_by_project: {
    title: 'Spend by project', kind: 'rows',
    description: 'Per project: spend, tokens, session count, last activity, dollars per million tokens and cache-hit rate (0-1). Columns: project, path, costUSD, tokens, sessions, lastActive, effRate, cacheHit.',
    params: {},
    async get() {
      const s = await need().usage.summaryAsync();
      return (s.byProject || []).map((p) => ({ project: p.project, path: p.path || '', costUSD: r2(p.costUSD), tokens: Number(p.tokens) || 0, sessions: Number(p.sessions) || 0, lastActive: iso(p.lastActive), effRate: r2(p.effRate), cacheHit: p.cacheHit == null ? null : Math.round(p.cacheHit * 1000) / 1000 }));
    },
  },
  cost_by_model: {
    title: 'Spend by model', kind: 'rows',
    description: 'Per model id: spend and tokens across every session on this machine. Columns: model, costUSD, tokens.',
    params: {},
    async get() {
      const s = await need().usage.summaryAsync();
      return (s.byModel || []).map((m) => ({ model: m.model, costUSD: r2(m.costUSD), tokens: Number(m.tokens) || 0 }));
    },
  },
  sessions: {
    title: 'Sessions', kind: 'rows',
    description: 'One row per Claude Code session with its project, model, spend, token split, cache-hit rate and context fill (0-1), newest first. Columns: sessionId, project, model, lastActive, costUSD, tokens, input, output, cacheRead, cacheWrite, cacheHit, ctxPct.',
    params: { limit: 'rows to return, 1-2000, default 200' },
    async get(p) {
      const s = await need().usage.summaryAsync();
      const limit = clampInt(p.limit, 1, 2000, 200);
      return Object.entries(s.bySession || {})
        .map(([sessionId, x]) => ({ sessionId, project: x.project || '', model: x.model || '', lastActive: iso(x.lastActive), costUSD: r2(x.costUSD), tokens: Number(x.tokens) || 0, input: Number(x.input) || 0, output: Number(x.output) || 0, cacheRead: Number(x.cacheRead) || 0, cacheWrite: Number(x.cacheWrite) || 0, cacheHit: x.cacheHit == null ? null : Math.round(x.cacheHit * 1000) / 1000, ctxPct: x.ctxPct == null ? null : Math.round(x.ctxPct * 1000) / 1000 }))
        .sort((a, b) => String(b.lastActive).localeCompare(String(a.lastActive)))
        .slice(0, limit);
    },
  },
  live_sessions: {
    title: 'Sessions on the floor', kind: 'rows',
    description: 'What the dashboard shows right now: every open session with its state, project, current goal, spend (exact when the gander-feed mod is live), context fill and whether it is waiting on a person. Columns: sessionId, project, name, state, goal, awaitMsg, costUSD, costExact, ctxPct, updatedAt, dispatch.',
    params: {},
    async get() {
      const list = need().getAgents();
      return list.filter((a) => a.root).map((a) => ({
        sessionId: a.sessionId || String(a.id).replace(/^sess:/, ''), project: a.project || '', name: a.name || '', state: a.state || 'idle',
        goal: a.goal ? String(a.goal).slice(0, 200) : '', awaitMsg: a.awaitMsg ? String(a.awaitMsg).slice(0, 200) : '',
        costUSD: a.costUSD == null ? null : r2(a.costUSD), costExact: !!a.costExact, ctxPct: a.ctxPct == null ? null : Math.round(a.ctxPct * 1000) / 1000,
        updatedAt: iso(a.updatedAt), dispatch: !!a.dispatch,
      }));
    },
  },
  subagents: {
    title: 'Sub-agent runs', kind: 'rows',
    description: 'Every sub-agent run on this machine in the window: type, task description, model, tokens, spend, duration, tool uses and errors. Columns: agentId, sessionId, project, agentType, description, model, tokens, costUSD, durationMs, startedAt, endedAt, toolUses, turns, toolErrors, endedOnError.',
    params: { days: 'window in days, 0 = all, default 14', limit: 'rows, default 400, max 2000' },
    async get(p) {
      const { subagents, priceFor } = need();
      const out = subagents.roster({ days: clampInt(p.days, 0, 365, 14), limit: clampInt(p.limit, 1, 2000, 400), priceFor });
      return (out.subagents || []).map((x) => ({ agentId: x.agentId, sessionId: x.sessionId, project: x.project || '', agentType: x.agentType || '', description: String(x.description || '').slice(0, 200), model: x.model || '', tokens: (x.tokens && x.tokens.total) || 0, costUSD: r2(x.costUSD), durationMs: Number(x.durationMs) || 0, startedAt: iso(x.startedAt), endedAt: iso(x.endedAt), toolUses: Number(x.toolUses) || 0, turns: Number(x.turns) || 0, toolErrors: Number(x.toolErrors) || 0, endedOnError: !!x.endedOnError }));
    },
  },
  scorecards: {
    title: 'Agent scorecards', kind: 'rows',
    description: 'Per sub-agent type over the window: runs, average spend, average duration, average tool uses, tool-error rate (errors per 100 tool uses) and share of runs that ended on an error. Columns: agentType, runs, avgCostUSD, avgDurationMs, avgToolUses, toolErrorRate, endedOnErrorPct, totalCostUSD, lastRunAt, sample.',
    params: { days: 'window in days, 0 = all, default 14' },
    async get(p) {
      const { subagents, priceFor } = need();
      return (subagents.scorecard({ days: clampInt(p.days, 0, 365, 14), priceFor }) || []).map((x) => ({ agentType: x.agentType, runs: Number(x.runs) || 0, avgCostUSD: r2(x.avgCostUSD), avgDurationMs: Math.round(Number(x.avgDurationMs) || 0), avgToolUses: r2(x.avgToolUses), toolErrorRate: r2(x.toolErrorRate), endedOnErrorPct: r2(x.endedOnErrorPct), totalCostUSD: r2(x.totalCostUSD), lastRunAt: iso(x.lastRunAt), sample: x.sample || 'ok' }));
    },
  },
  queue: {
    title: 'Task queue', kind: 'rows',
    description: 'The task queue: each goal with its project, status (queued / running / gating / review / done / failed / cancelled), spend across attempts and timestamps. Columns: id, project, goal, status, attempts, costUSD, priorCostUSD, createdAt, startedAt, doneAt, branch, error.',
    params: {},
    async get() {
      const q = need().queue.list();
      return (q.items || []).map((t) => ({ id: t.id, project: t.project || '', goal: String(t.prompt || '').slice(0, 200), status: t.status, attempts: Number(t.attempts) || 1, costUSD: r2(t.costUSD), priorCostUSD: r2(t.priorCostUSD), createdAt: iso(t.createdAt), startedAt: iso(t.startedAt), doneAt: iso(t.doneAt), branch: t.branch || '', error: t.error ? String(t.error).slice(0, 200) : '' }));
    },
  },
  spend_by_activity: {
    title: 'Spend by activity', kind: 'rows',
    description: 'Where the spend went in the window, by what sessions mostly did: coding, exploring, running, searching, orchestrating. Columns: type, label, costUSD, sessions, pct.',
    params: { days: 'window in days, 1-90, default 30' },
    async get(p) { const f = await forensicsReport(clampInt(p.days, 1, 90, 30)); return ((f.taskTypes && f.taskTypes.byType) || []).map((t) => ({ type: t.type, label: t.label, costUSD: r2(t.costUSD), sessions: Number(t.sessions) || 0, pct: r2(t.pct) })); },
  },
  forensics: {
    title: 'Spend forensics', kind: 'record',
    description: 'One record for the window: shipped percent (spend whose session landed a commit), productive vs abandoned spend, edit one-shot rate, cost per edit and how many file re-reads were wasted. Fields: days, shippedPct, productiveCost, abandonedCost, productiveSessions, abandonedSessions, oneShotRate, costPerEdit, edits, reReadTotal.',
    params: { days: 'window in days, 1-90, default 30' },
    async get(p) {
      const days = clampInt(p.days, 1, 90, 30);
      const f = await forensicsReport(days);
      const pr = f.productivity || {}, eq = (f.waste && f.waste.editQuality) || {};
      return { days, shippedPct: r2(pr.shippedPct), productiveCost: r2(pr.productiveCost), abandonedCost: r2(pr.abandonedCost), productiveSessions: Number(pr.productive) || 0, abandonedSessions: Number(pr.abandoned) || 0, oneShotRate: r2(eq.oneShotRate), costPerEdit: r2(eq.costPerEdit), edits: Number(eq.edits) || 0, reReadTotal: Number(f.waste && f.waste.reReadTotal) || 0 };
    },
  },
  digest_projects: {
    title: 'Ship digest', kind: 'rows',
    description: 'Per project over the window: sessions, commits and the first prompts of recent sessions. Columns: project, path, sessions, commits, prompts (joined with " | ").',
    params: { days: 'window in days, 1-31, default 7' },
    async get(p) {
      const { digest, projects } = need();
      const d = await digest.build({ days: clampInt(p.days, 1, 31, 7) }, { projectPaths: () => projects.discover().map((x) => x.path) });
      return (d.projects || []).map((x) => ({ project: x.project, path: x.path || '', sessions: Number(x.sessions) || 0, commits: Number(x.commits) || 0, prompts: (x.prompts || []).join(' | ') }));
    },
  },
  history: {
    title: 'Session history', kind: 'rows',
    description: 'Recent sessions across all projects with their first prompt and when they ran. Columns: sessionId, project, cwd, startedAt, lastActive, firstPrompt.',
    params: { limit: 'rows, default 50, max 500' },
    async get(p) {
      const h = await need().history.list({});
      const list = Array.isArray(h) ? h : (h && (h.sessions || h.items)) || [];
      return list.slice(0, clampInt(p.limit, 1, 500, 50)).map((s) => ({ sessionId: s.sessionId, project: s.project || '', cwd: s.cwd || '', startedAt: iso(s.startedAt), lastActive: iso(s.lastActive), firstPrompt: String(s.firstPrompt || '').slice(0, 140) }));
    },
  },
  overview: {
    title: 'Overview', kind: 'record',
    description: 'One record: totals across the machine (spend, tokens), spend in the rolling 5-hour plan window, sessions open now and how many are waiting on a person, and plan-window percentages from any session running the gander-feed mod. Fields: totalCostUSD, totalTokens, window5hCostUSD, window5hMessages, openSessions, needsYou, fedSessions, fiveHourPct, sevenDayPct, generatedAt.',
    params: {},
    async get() {
      const { usage, getAgents, feeds } = need();
      const s = await usage.summaryAsync();
      const roots = getAgents().filter((a) => a.root);
      const needsYou = roots.filter((a) => a.state === 'awaiting' || a.state === 'error' || a.perm).length;
      let five = null, seven = null, fed = 0;
      for (const a of roots) {
        const f = a.feed || (feeds ? feeds(a.sessionId) : null);
        if (!f || !f.live) continue;
        fed++;
        for (const r of f.rateLimits || []) { if (r.kind === 'five_hour') five = r.percentUsed; if (r.kind === 'seven_day') seven = r.percentUsed; }
      }
      return { totalCostUSD: r2(s.totals && s.totals.costUSD), totalTokens: Number(s.totals && s.totals.totalTokens) || 0, window5hCostUSD: r2(s.window5h && s.window5h.costUSD), window5hMessages: Number(s.window5h && s.window5h.messages) || 0, openSessions: roots.length, needsYou, fedSessions: fed, fiveHourPct: five, sevenDayPct: seven, generatedAt: new Date().toISOString() };
    },
  },
};

// The /api/forensics computation, shared so the connector and the panel agree.
async function forensicsReport(days) {
  const { usage, forensics } = need();
  const s = await usage.summaryAsync();
  const byProject = s.byProject || [];
  const projectPaths = byProject.map((p) => p.path).filter(Boolean);
  const commitsByProject = {};
  await Promise.all(byProject.map(async (p) => { if (!p.path) return; commitsByProject[p.project] = await forensics.commitTimes(p.path, days).catch(() => []); }));
  const sinceMs = Date.now() - days * 86400e3;
  const sessions = Object.values(s.bySession || {}).filter((x) => { const la = typeof x.lastActive === 'number' ? x.lastActive : Date.parse(x.lastActive); return la && la >= sinceMs; });
  const productivity = forensics.computeProductivity(sessions, commitsByProject);
  const windowCost = sessions.reduce((sum, x) => sum + (Number(x.costUSD) || 0), 0);
  const waste = await forensics.scanWaste({ days, projectPaths, totalCostUSD: windowCost });
  const costBySession = s.bySession || {};
  const sessionsWithCost = (waste._perSession || []).map((ps) => ({ ...ps, costUSD: (costBySession[ps.session] || {}).costUSD || 0 }));
  const taskTypes = forensics.computeTaskTypes(sessionsWithCost);
  delete waste._perSession;
  return { days, waste, productivity, taskTypes };
}

function catalog() {
  return Object.entries(CATALOG).map(([id, d]) => ({ id, title: d.title, description: d.description, kind: d.kind, params: d.params }));
}

async function get(id, params = {}) {
  const d = CATALOG[id];
  if (!d) throw new Error(`unknown dataset: ${id}`);
  const data = await d.get(params || {});
  return { id, title: d.title, kind: d.kind, generatedAt: new Date().toISOString(), [d.kind === 'rows' ? 'rows' : 'record']: data };
}

// CSV for a rows dataset: the first row names the columns; a record becomes one row.
function toCsv(result) {
  const rows = result.rows || (result.record ? [result.record] : []);
  if (!rows.length) return '';
  const cols = Array.from(rows.reduce((set, r) => { Object.keys(r).forEach((k) => set.add(k)); return set; }, new Set()));
  const cell = (v) => { if (v === null || v === undefined) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => cell(r[c])).join(','))).join('\n') + '\n';
}

// MCP tools: one per dataset, plus the catalog itself.
function tools() {
  const list = catalog().map((d) => ({
    name: `gander_${d.id}`,
    description: `${d.title}: ${d.description}`,
    inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(d.params).map(([k, v]) => [k, { type: 'integer', description: v }])), additionalProperties: false },
    run: async (args) => get(d.id, args),
  }));
  list.unshift({
    name: 'gander_datasets',
    description: 'List every dataset this Gander bridge offers (id, what it holds, parameters). Call gander_<id> to read one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ datasets: catalog() }),
  });
  return list;
}

module.exports = { init, catalog, get, toCsv, tools, forensicsReport, _ids: () => Object.keys(CATALOG) };
