'use strict';
// bridge/datasets.js — row-shaped datasets over the bridge's modules, the CSV
// form, and the MCP tools derived from the catalog. Fake modules stand in for
// usage / subagents / queue / history / digest so the shapes are tested, not the scans.
const test = require('node:test');
const assert = require('node:assert');
const datasets = require('../bridge/datasets.js');

const fakeUsage = {
  summaryAsync: async () => ({
    totals: { costUSD: 123.456, totalTokens: 9000 },
    window5h: { costUSD: 4.5, messages: 12 },
    byDay: [{ date: '2026-10-07', costUSD: 1.234, tokens: 100 }, { date: '2026-10-08', costUSD: 0, tokens: 0 }],
    byProject: [{ project: 'gander', path: 'D:/g', costUSD: 10, tokens: 500, sessions: 3, lastActive: 1759900000000, effRate: 12.3456, cacheHit: 0.87654 }],
    byModel: [{ model: 'claude-fable-5-1', costUSD: 9.999, tokens: 400 }],
    bySession: {
      s1: { project: 'gander', model: 'm', lastActive: '2026-10-08T01:00:00.000Z', costUSD: 1, tokens: 10, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheHit: 0.5, ctxPct: 0.42 },
      s2: { project: 'gander', model: 'm', lastActive: '2026-10-08T02:00:00.000Z', costUSD: 2, tokens: 20, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheHit: null, ctxPct: null },
    },
  }),
};
const fakeSub = {
  roster: ({ days, limit }) => ({ subagents: [{ agentId: 'a1', sessionId: 's1', project: 'gander', agentType: 'Explore', description: 'x'.repeat(300), model: 'h', tokens: { total: 77 }, costUSD: 0.123, durationMs: 1500, startedAt: 1759900000000, endedAt: 1759900001500, toolUses: 3, turns: 2, toolErrors: 0, endedOnError: false }].slice(0, limit), _days: days }),
  scorecard: () => [{ agentType: 'Explore', runs: 2, avgCostUSD: 0.5, avgDurationMs: 1234.5, avgToolUses: 3, toolErrorRate: 0, endedOnErrorPct: 0, totalCostUSD: 1, lastRunAt: 1759900000000, sample: 'small' }],
};
const fakeQueue = { list: () => ({ items: [{ id: 3, project: 'gander', prompt: 'ship it', status: 'done', attempts: 2, costUSD: 1.5, priorCostUSD: 0.5, createdAt: 1, startedAt: 2, doneAt: 3, branch: 'q/3' }] }) };
const fakeHistory = { list: async () => [{ sessionId: 's1', project: 'gander', cwd: 'D:/g', startedAt: '2026-10-08T00:00:00Z', lastActive: '2026-10-08T01:00:00Z', firstPrompt: 'hello' }] };
const fakeDigest = { build: async ({ days }) => ({ days, projects: [{ project: 'gander', path: 'D:/g', sessions: 2, commits: 1, prompts: ['a', 'b'] }] }) };
const agents = [
  { id: 'sess:s1', root: true, sessionId: 's1', project: 'gander', name: 'Moss', state: 'awaiting', goal: 'g', awaitMsg: 'needs a yes', costUSD: 1.234, costExact: true, ctxPct: 0.4567, updatedAt: 1759900000000, feed: { live: true, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }, { kind: 'seven_day', percentUsed: 7 }] } },
  { id: 'agent:x', root: false, state: 'coding' },
  { id: 'sess:s2', root: true, sessionId: 's2', project: 'gander', state: 'idle' },
];

test.before(() => datasets.init({ usage: fakeUsage, subagents: fakeSub, queue: fakeQueue, history: fakeHistory, digest: fakeDigest, projects: { discover: () => [] }, forensics: null, getAgents: () => agents, priceFor: () => 1, feeds: () => null }));

test('catalog(): every dataset has a title, a one-paragraph description and a kind', () => {
  const c = datasets.catalog();
  assert.ok(c.length >= 12);
  for (const d of c) {
    assert.match(d.id, /^[a-z_]+$/);
    assert.ok(d.title.length >= 5 && d.title.length <= 30, d.id + ' title length');
    assert.ok(d.description.length > 40, d.id);
    assert.ok(['rows', 'record'].includes(d.kind));
  }
});

test('cost_by_day / by_project / by_model: rounded money, ISO dates', async () => {
  const d = await datasets.get('cost_by_day');
  assert.equal(d.kind, 'rows');
  assert.deepEqual(d.rows[0], { date: '2026-10-07', costUSD: 1.23, tokens: 100 });
  const p = await datasets.get('cost_by_project');
  assert.equal(p.rows[0].lastActive, '2025-10-08T05:06:40.000Z');
  assert.equal(p.rows[0].cacheHit, 0.877);
  assert.equal(p.rows[0].effRate, 12.35);
  const m = await datasets.get('cost_by_model');
  assert.deepEqual(m.rows, [{ model: 'claude-fable-5-1', costUSD: 10, tokens: 400 }]);
});

test('sessions: newest first, limit honoured, nulls kept as null', async () => {
  const s = await datasets.get('sessions', { limit: '1' });
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].sessionId, 's2');
  assert.equal(s.rows[0].cacheHit, null);
  const all = await datasets.get('sessions');
  assert.equal(all.rows[1].ctxPct, 0.42);
});

test('live_sessions: root agents only, with exactness and waiting flags', async () => {
  const l = await datasets.get('live_sessions');
  assert.equal(l.rows.length, 2);
  assert.equal(l.rows[0].costExact, true);
  assert.equal(l.rows[0].awaitMsg, 'needs a yes');
  assert.equal(l.rows[0].ctxPct, 0.457);
  assert.equal(l.rows[1].costUSD, null);
});

test('subagents / scorecards / queue / history / digest_projects: flat rows, long text cut', async () => {
  const su = await datasets.get('subagents', { days: '7', limit: '10' });
  assert.equal(su.rows[0].description.length, 200);
  assert.equal(su.rows[0].tokens, 77);
  assert.equal(su.rows[0].startedAt, '2025-10-08T05:06:40.000Z');
  const sc = await datasets.get('scorecards');
  assert.equal(sc.rows[0].avgDurationMs, 1235);
  assert.equal(sc.rows[0].sample, 'small');
  const q = await datasets.get('queue');
  assert.deepEqual(Object.keys(q.rows[0]), ['id', 'project', 'goal', 'status', 'attempts', 'costUSD', 'priorCostUSD', 'createdAt', 'startedAt', 'doneAt', 'branch', 'error']);
  const h = await datasets.get('history', { limit: '5' });
  assert.equal(h.rows[0].firstPrompt, 'hello');
  const dg = await datasets.get('digest_projects', { days: '3' });
  assert.equal(dg.rows[0].prompts, 'a | b');
});

test('overview: one record with needs-you and the fed session plan windows', async () => {
  const o = await datasets.get('overview');
  assert.equal(o.kind, 'record');
  assert.equal(o.record.openSessions, 2);
  assert.equal(o.record.needsYou, 1);
  assert.equal(o.record.fedSessions, 1);
  assert.equal(o.record.fiveHourPct, 23.5);
  assert.equal(o.record.sevenDayPct, 7);
  assert.equal(o.record.totalCostUSD, 123.46);
});

test('get(): an unknown id throws', async () => {
  await assert.rejects(() => datasets.get('nope'), /unknown dataset/);
});

test('toCsv(): header from the union of keys, quoting where needed, a record becomes one row', async () => {
  const csv = datasets.toCsv({ rows: [{ a: 1, b: 'x,y' }, { a: 2, c: 'he said "hi"' }] });
  assert.equal(csv, 'a,b,c\n1,"x,y",\n2,,"he said ""hi"""\n');
  const one = datasets.toCsv(await datasets.get('overview'));
  assert.equal(one.split('\n').length, 3, 'header + one row + trailing newline');
  assert.equal(datasets.toCsv({ rows: [] }), '');
});

test('tools(): one MCP tool per dataset plus the catalog, integer params from the catalog', async () => {
  const t = datasets.tools();
  assert.equal(t[0].name, 'gander_datasets');
  assert.equal(t.length, datasets.catalog().length + 1);
  const sub = t.find((x) => x.name === 'gander_subagents');
  assert.deepEqual(Object.keys(sub.inputSchema.properties), ['days', 'limit']);
  assert.equal(sub.inputSchema.properties.days.type, 'integer');
  const r = await sub.run({ days: 7, limit: 1 });
  assert.equal(r.rows.length, 1);
  const cat = await t[0].run({});
  assert.ok(cat.datasets.some((d) => d.id === 'overview'));
});
