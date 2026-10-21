// Writes the canned API answers the no-install demo serves (web/demo/*.json;
// build-demo.mjs copies them to docs/demo/demo/ — they live outside public/ so
// the real dashboard build never ships them).
//
//   node web/scripts/gen-demo-data.mjs
//
// Everything here is invented: four sessions on made-up projects, a month of
// plausible spend, one pending permission. The shapes mirror what the bridge's
// GET endpoints return (recorded from a scratch bridge, then rewritten with fake
// data so nothing from a real machine ends up on a public page). The demo shim
// (web/src/demo-shim.js) animates state/feed/usage on top of these at runtime;
// timestamps are stored as offsets ("...Ago" ms) that the shim rebases to now.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo');
fs.mkdirSync(OUT, { recursive: true });
const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 1) + '\n');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';
const MIN = 60000;

// ── live swarm (the shim mutates this) ───────────────────────────────────────
const root = (id, sid, name, cwd, state, extra) => ({
  id, name, project: name, sessionId: sid, cwd, root: true, state,
  createdAgo: 38 * MIN, runStartAgo: 38 * MIN, updatedAgo: 20000,
  closed: false, retiring: false, retireAt: 0, runaway: false, burnRate: 1.2, burnStreak: 0, fileCount: 7, artifactCount: 0,
  peerName: name + '-a1', inbox: true, ...extra,
});
const sub = (id, parent, sid, project, cwd, name, state, log, extra) => ({
  id, name, parentId: parent, project, sessionId: sid, cwd, state, logLines: [log],
  createdAgo: 6 * MIN, runStartAgo: 6 * MIN, updatedAgo: 15000, closed: false, retiring: false, retireAt: 0, runaway: false, ...extra,
});
const state = {
  agents: [
    root('demo-s1', S1, 'web-shop', 'D:/code/web-shop', 'coding', {
      title: 'Checkout coupon field', goal: 'Add a checkout coupon field and wire it to the cart total', logLines: ['Edit src/cart/Checkout.svelte', 'Read src/cart/total.js', 'Grep couponCode'],
      costUSD: 4.82, ctxPct: 0.41, fileCount: 12,
      lastMessage: 'Coupon field added to Checkout.svelte; the Reviewer is checking the total math while I run the cart tests.',
    }),
    root('demo-s2', S2, 'api-gateway', 'D:/code/api-gateway', 'awaiting', {
      title: 'Rotate JWT signing key', goal: 'Rotate the JWT signing key and roll it out behind a feature flag', logLines: ['wants to run Bash: npm publish --access public', 'Edit src/auth/keys.js', 'Bash npm test'],
      awaitMsg: 'wants to run Bash: npm publish --access public', costUSD: 2.17, ctxPct: 0.33, updatedAgo: 4 * MIN,
      perm: { requestId: 'demo-perm-1', tool: 'Bash', detail: 'npm publish --access public', hasSuggestions: false, tsAgo: 4 * MIN }, permCount: 1,
      lastMessage: 'Key rotation is written behind the auth.keyRotation flag and the tests pass. Publishing the shared auth package needs your OK.',
    }),
    root('demo-s3', S3, 'docs-site', 'D:/code/docs-site', 'thinking', {
      title: 'Getting Started rewrite', goal: 'Rewrite the Getting Started page from the new CLI flags', logLines: ['reading the CLI reference', 'Read docs/cli.md'],
      costUSD: 1.06, ctxPct: 0.18, fileCount: 3,
      lastMessage: 'Reading the CLI reference first; a Writer sub-agent is drafting the page in parallel.',
    }),
    root('demo-s4', S4, 'mobile-app', 'D:/code/mobile-app', 'idle', {
      title: 'Flaky Android login test', goal: 'Fix the flaky login test on Android', logLines: ['waiting for your next prompt', 'Bash ./gradlew test'],
      costUSD: 0.64, ctxPct: 0.12, runStartAgo: 0, updatedAgo: 9 * MIN, fileCount: 2,
      lastMessage: 'The test raced the splash screen. Added an idling resource; 10 of 10 runs pass. Anything else?',
    }),
    sub('demo-s1-a', 'demo-s1', S1, 'web-shop', 'D:/code/web-shop', 'Reviewer', 'reading', 'Read src/cart/total.js', { costUSD: 0.31 }),
    sub('demo-s1-b', 'demo-s1', S1, 'web-shop', 'D:/code/web-shop', 'TestRunner', 'testing', 'Bash npm test -- cart', { costUSD: 0.22 }),
    sub('demo-s1-c', 'demo-s1', S1, 'web-shop', 'D:/code/web-shop', 'Explore', 'searching', 'Grep couponCode', { costUSD: 0.09, role: 'Explore' }),
    sub('demo-s3-a', 'demo-s3', S3, 'docs-site', 'D:/code/docs-site', 'Writer', 'coding', 'Write docs/getting-started.md', { costUSD: 0.27, role: 'general-purpose' }),
  ],
  procs: [
    { pid: 4242, name: 'node.exe', cmd: 'node vite dev --port 5173', ports: [5173], uptimeMs: 52 * MIN, attribution: 'project', sessionId: S1, project: 'web-shop', linked: null, plugin: null, claudePid: null, codePids: [] },
    { pid: 5151, name: 'python.exe', cmd: 'python -m mkdocs serve', ports: [8000], uptimeMs: 31 * MIN, attribution: 'project', sessionId: S3, project: 'docs-site', linked: null, plugin: null, claudePid: null, codePids: [] },
    { pid: 6161, name: 'node.exe', cmd: 'node scripts/watch-tests.js', ports: [], uptimeMs: 3 * 60 * MIN, attribution: 'orphan', sessionId: null, project: '', linked: null, plugin: null, claudePid: null, codePids: [] },
  ],
  muted: [], pending: {},
  budget: { dailyCost: 8.69, daily: 25, session: 0, enforce: false, overDaily: false, generatedAt: 0 },
  queue: { queued: 2, running: 1 },
  board: [], escalations: [], collisions: [], dangers: [], plans: [], teams: [], planLimits: { fiveHour: { pct: 37, resetsAt: 0 }, sevenDay: { pct: 52 } }, reviews: [], boardPosts: [], fleet: [],
  dispatch: { enabled: false, sessions: 0, permissions: 0, rateLimit: null },
  build: 'demo',
};
write('state.json', state);

// ── feed (newest first; shim prepends live events and rebases ts) ─────────────
const feedLines = [
  ['demo-s3-a', 'Writer', 'docs-site', S3, 'coding', 'Write docs/getting-started.md'],
  ['demo-s1-b', 'TestRunner', 'web-shop', S1, 'testing', 'Bash npm test -- cart'],
  ['demo-s1-a', 'Reviewer', 'web-shop', S1, 'reading', 'Read src/cart/total.js'],
  ['demo-s1-c', 'Explore', 'web-shop', S1, 'searching', 'Grep couponCode'],
  ['demo-s2', 'api-gateway', 'api-gateway', S2, 'awaiting', 'wants to run Bash: npm publish --access public'],
  ['demo-s1', 'web-shop', 'web-shop', S1, 'spawning', 'Agent Reviewer: check the cart total math'],
  ['demo-s2', 'api-gateway', 'api-gateway', S2, 'testing', 'Bash npm test'],
  ['demo-s3', 'docs-site', 'docs-site', S3, 'reading', 'Read docs/cli.md'],
  ['demo-s4', 'mobile-app', 'mobile-app', S4, 'idle', 'waiting for your next prompt'],
  ['demo-s4', 'mobile-app', 'mobile-app', S4, 'running', 'Bash ./gradlew test'],
  ['demo-s2', 'api-gateway', 'api-gateway', S2, 'coding', 'Edit src/auth/keys.js'],
  ['demo-s1', 'web-shop', 'web-shop', S1, 'coding', 'Edit src/cart/Checkout.svelte'],
];
write('feed.json', { events: feedLines.map((l, i) => ({ tsAgo: 20000 + i * 47000, agentId: l[0], agent: l[1], project: l[2], sessionId: l[3], state: l[4], log: l[5], error: false })) });

// ── usage (byDay dates are rebased by the shim so the last entry is "today") ──
const byDay = [];
for (let i = 29; i >= 0; i--) {
  const wk = (i % 7) >= 5 ? 0.35 : 1;
  const cost = +(wk * (6 + 9 * Math.abs(Math.sin(i * 1.7)) + (i % 5))).toFixed(2);
  byDay.push({ dayAgo: i, costUSD: cost, tokens: Math.round(cost * 480000) });
}
byDay[29].costUSD = 8.69; byDay[29].tokens = 4170000;
const sess = (project, cost, tokens, ctxTokens, ctxMax, model, hoursAgo) => ({
  project, lastActiveAgoMs: hoursAgo * 3600000, costUSD: cost, tokens, input: Math.round(tokens * 0.002), output: Math.round(tokens * 0.03), cacheWrite: Math.round(tokens * 0.08), cacheRead: Math.round(tokens * 0.888),
  outShare: 0.03, cacheHit: 0.92, ctxTokens, ctxMax, ctxPct: +(ctxTokens / ctxMax).toFixed(4), model, whatIf: { sonnet: +(cost * 0.3).toFixed(2), haiku: +(cost * 0.1).toFixed(2) },
});
write('usage.json', {
  totals: { inputTokens: 912000, outputTokens: 4310000, cacheWriteTokens: 21400000, cacheReadTokens: 171000000, totalTokens: 197622000, costUSD: 412.37 },
  byProject: [
    { project: 'web-shop', path: 'D:/code/web-shop', tokens: 81000000, costUSD: 168.4, sessions: 31, lastActiveAgoMs: 20000, effRate: 2.1, cacheHit: 0.93 },
    { project: 'api-gateway', path: 'D:/code/api-gateway', tokens: 52000000, costUSD: 112.9, sessions: 19, lastActiveAgoMs: 4 * MIN, effRate: 2.4, cacheHit: 0.91 },
    { project: 'docs-site', path: 'D:/code/docs-site', tokens: 38000000, costUSD: 77.2, sessions: 14, lastActiveAgoMs: 30000, effRate: 1.9, cacheHit: 0.95 },
    { project: 'mobile-app', path: 'D:/code/mobile-app', tokens: 26000000, costUSD: 53.87, sessions: 9, lastActiveAgoMs: 9 * MIN, effRate: 2.0, cacheHit: 0.9 },
  ],
  byModel: [
    { model: 'claude-opus-4-1', tokens: 96000000, costUSD: 231.5 },
    { model: 'claude-sonnet-4-5', tokens: 88000000, costUSD: 164.2 },
    { model: 'claude-haiku-4-5', tokens: 13622000, costUSD: 16.67 },
  ],
  byDay,
  topSessions: [
    { sessionId: S1, project: 'web-shop', costUSD: 4.82, tokens: 2300000, lastActiveAgoMs: 20000 },
    { sessionId: S2, project: 'api-gateway', costUSD: 2.17, tokens: 1050000, lastActiveAgoMs: 4 * MIN },
    { sessionId: S3, project: 'docs-site', costUSD: 1.06, tokens: 510000, lastActiveAgoMs: 30000 },
    { sessionId: S4, project: 'mobile-app', costUSD: 0.64, tokens: 300000, lastActiveAgoMs: 9 * MIN },
  ],
  bySession: {
    [S1]: sess('web-shop', 4.82, 2300000, 82000, 200000, 'claude-opus-4-1', 0),
    [S2]: sess('api-gateway', 2.17, 1050000, 66000, 200000, 'claude-sonnet-4-5', 0),
    [S3]: sess('docs-site', 1.06, 510000, 36000, 200000, 'claude-sonnet-4-5', 0),
    [S4]: sess('mobile-app', 0.64, 300000, 24000, 200000, 'claude-haiku-4-5', 0),
  },
  window5h: { costUSD: 7.41, tokens: 3900000, outputTokens: 91000, messages: 143 },
  generatedAt: 0,
});

// ── projects on disk ──────────────────────────────────────────────────────────
const proj = (name, p, extra) => ({ path: p, name, sources: ['root'], running: true, skills: ['browser-verify', 'ship-it'], agents: ['code-reviewer'], commands: ['deploy'], hooks: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'], mcp: [], ...extra });
write('projects.json', {
  roots: ['D:/code'],
  projects: [
    { path: 'C:/Users/demo', name: 'Global (user)', sources: ['global'], running: false, skills: ['browser-verify', 'ship-it', 'humanize'], agents: ['code-reviewer', 'security-auditor'], commands: ['gander'], hooks: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop'], mcp: ['github'] },
    proj('web-shop', 'D:/code/web-shop', { mcp: ['playwright'] }),
    proj('api-gateway', 'D:/code/api-gateway', { skills: ['ship-it'] }),
    proj('docs-site', 'D:/code/docs-site', { agents: [] }),
    proj('mobile-app', 'D:/code/mobile-app', { commands: [] }),
    proj('old-blog', 'D:/code/old-blog', { running: false, skills: [], agents: [], commands: [], hooks: [] }),
  ],
  muted: [],
});

// ── everything else, keyed by the API path the app asks for ──────────────────
const doctorOk = (id, label, detail) => ({ id, label, status: 'ok', detail, hint: '' });
write('health.json', {
  bridge: { uptimeMs: 3 * 3600000, port: 3131, eventsReceived: 1843, sessions: 4, projectsKnown: 6, version: 'demo' },
  doctor: [doctorOk('cli', 'claude CLI', '2.1.306 installed'), doctorOk('hooks', 'Gander hooks', '27 of 27 events wired'), doctorOk('node', 'Node.js', 'v22'), doctorOk('transcripts', 'Transcripts folder', '~/.claude/projects readable'), doctorOk('port', 'Bridge port', '3131 free'), doctorOk('plugin', 'gander-feed mod', 'installed')],
  setup: { score: { passed: 41, total: 41, pct: 100 }, groups: [
    { id: 'settings', label: 'Settings files', status: 'ok', checks: [{ id: 'settings:global', label: 'settings.json (global)', status: 'ok', detail: '9 keys' }] },
    { id: 'hooks', label: 'Hooks', status: 'ok', checks: [{ id: 'hooks:all', label: 'all events wired', status: 'ok', detail: '27 events' }] },
  ] },
  hooks: { installed: true, settingsPath: 'C:/Users/demo/.claude/settings.json', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PermissionRequest'].map((event) => ({ event, wired: true })) },
  plugin: true,
  env: { node: 'v22.12.0', platform: 'win32' },
});
write('gpu.json', {
  at: 0, game: null,
  nvidia: { available: true, gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 4070', util: 14, memUtil: 9, vramUsedMB: 5120, vramTotalMB: 12288, tempC: 52, powerW: 61, powerLimitW: 200, fanPct: 31, driver: '560.94' }], apps: [{ pid: 7001, name: 'ollama.exe', path: 'C:/Program Files/Ollama/ollama.exe', vramMB: 4600 }], perProcessVram: true, readAt: 0, paused: false },
  ollama: { available: true, url: 'http://127.0.0.1:11434', version: '0.6.2', loaded: [{ name: 'qwen2.5-coder:7b', sizeVram: 4600000000 }], installed: 5 },
  lmstudio: { available: false, url: 'http://127.0.0.1:1234', loaded: [] },
  history: Array.from({ length: 20 }, (_, i) => ({ at: i, util: 8 + Math.round(10 * Math.abs(Math.sin(i))), vramUsedMB: 5100 + i * 3 })), lowered: [],
});
write('queue.json', {
  enabled: true, maxSlots: 2, worktrees: false, testGate: true, review: false, paused: false,
  items: [
    { id: 'q-1', project: 'web-shop', cwd: 'D:/code/web-shop', prompt: 'Add a checkout coupon field and wire it to the cart total', status: 'running', createdAgo: 40 * MIN, startedAgo: 38 * MIN, attempts: 1, runner: 'claude', gate: 'npm test' },
    { id: 'q-2', project: 'api-gateway', cwd: 'D:/code/api-gateway', prompt: 'Add rate limiting to the /login route (sliding window, 20/min)', status: 'queued', createdAgo: 25 * MIN, attempts: 0 },
    { id: 'q-3', project: 'docs-site', cwd: 'D:/code/docs-site', prompt: 'Generate a FAQ page from the last 20 GitHub issues', status: 'queued', createdAgo: 12 * MIN, attempts: 0 },
    { id: 'q-0', project: 'mobile-app', cwd: 'D:/code/mobile-app', prompt: 'Bump the Gradle wrapper and fix the deprecation warnings', status: 'done', createdAgo: 4 * 3600000, startedAgo: 3.8 * 3600000, doneAgo: 3.2 * 3600000, attempts: 1, costUSD: 1.92, doneWhen: 'tests green' },
  ],
});
write('safety.json', {
  guard: {
    mode: 'critical', how: 'hold', holdSeconds: 120, extra: [],
    rules: [
      { id: 'delete-root', level: 'critical', label: 'Deletes a whole drive, your home folder, or the project root' },
      { id: 'git-force-push', level: 'critical', label: 'Force-pushes over a shared branch' },
      { id: 'git-reset-hard', level: 'high', label: 'Discards uncommitted work (git reset --hard / checkout --)' },
      { id: 'db-drop', level: 'critical', label: 'Drops a database or table' },
      { id: 'rm-rf', level: 'high', label: 'Recursive delete outside a temp folder' },
      { id: 'publish', level: 'medium', label: 'Publishes a package or deploys to production' },
    ],
    recent: [{ id: 'g-1', project: 'api-gateway', rule: 'publish', level: 'medium', command: 'npm publish --access public', atAgo: 4 * MIN, outcome: 'held' }],
  },
  suggestions: [{ rule: 'Bash(npm test:*)', allows: 14, projects: ['web-shop', 'api-gateway'], examples: ['npm test', 'npm test -- cart'] }],
  minAllows: 5, allowList: ['Bash(git status:*)', 'Bash(git diff:*)', 'Read(**)'],
});
write('mcp-config.json', { enabled: false, tokenSet: false, token: '', localUrl: 'http://localhost:3131/mcp', remoteUrl: '', tunnel: { stable: false, hostname: '', running: false, url: '', startedAt: 0, error: '', bin: 'cloudflared', installing: false, installError: '', managed: false }, autoTunnel: false, stable: { hostname: '', tokenSet: false }, recent: [], installHint: 'winget install Cloudflare.cloudflared', tools: 14, datasets: 13 });
write('mod-status.json', { plugin: 'gander-feed@gander', minVersion: '2.1.287', ccVersion: '2.1.306', supported: true, reason: '', installed: true, marketplace: true, sessionsFed: 4, live: 3, installLine: '/plugin install gander-feed@gander', marketplaceSource: 'https://github.com/weellio/gander' });
write('datasets.json', { datasets: ['cost_by_day', 'cost_by_project', 'sessions', 'subagents', 'needs_you', 'feed', 'queue', 'lessons', 'skills', 'processes', 'gpu', 'health', 'board'].map((id) => ({ id, title: id.replace(/_/g, ' '), description: 'Demo dataset', kind: 'rows', params: {} })), mcp: { enabled: false, tokenSet: false, token: '', localUrl: 'http://localhost:3131/mcp', remoteUrl: '', tunnel: { stable: false, hostname: '', running: false, url: '', startedAt: 0, error: '', bin: 'cloudflared', installing: false, installError: '', managed: false }, autoTunnel: false, stable: { hostname: '', tokenSet: false }, recent: [], installHint: '', tools: 14, datasets: 13 } });
const briefing = { id: 'b-1', routineId: 'r-brief', name: 'Morning Brief', project: '', tsAgo: 2 * 3600000, ms: 28000, ok: true, error: '', output: '## Morning briefing\n\n- **web-shop**: coupon field is in progress, tests green so far.\n- **api-gateway**: key rotation is written; waiting on you to approve the publish.\n- **docs-site**: Getting Started rewrite drafted, 2 pages left.\n- **mobile-app**: idle since last night, the flaky test is fixed.\n\nSpend yesterday: $11.40 across 6 sessions.' };
write('briefings.json', { briefings: [briefing, { ...briefing, id: 'b-0', tsAgo: 26 * 3600000, output: '## Morning briefing\n\nQuiet day: two sessions, one merge, $6.10.' }] });
write('routines.json', { routines: [{ id: 'r-brief', name: 'Morning Brief', cwd: '', prompt: 'Compile a concise morning briefing of every project: what moved, what is blocked, what it cost.', permMode: 'bypassPermissions', schedule: '0 8 * * 1-5', enabled: true, notify: true, timeoutSec: 600, lastRunAgo: 2 * 3600000 }, { id: 'r-deps', name: 'Weekly dependency audit', cwd: 'D:/code/web-shop', prompt: 'Audit package.json for vulnerable or unmaintained dependencies and open a PR with safe bumps.', permMode: 'bypassPermissions', schedule: '0 7 * * 1', enabled: true, notify: false, timeoutSec: 900, lastRunAgo: 3 * 86400000 }], briefings: [briefing] });
write('board.json', { summary: [{ project: 'web-shop', open: 2, claims: 1, lastAgo: 10 * MIN }], types: ['note', 'claim', 'question', 'decision', 'escalation', 'plan'], entries: [
  { id: 'n-1', project: 'web-shop', type: 'note', author: 'Reviewer', text: 'Cart total already rounds to cents in total.js — do not round again in the coupon math.', atAgo: 10 * MIN },
  { id: 'n-2', project: 'web-shop', type: 'claim', author: 'web-shop', text: 'src/cart/Checkout.svelte', atAgo: 30 * MIN },
], claims: [{ file: 'src/cart/Checkout.svelte', by: 'web-shop', atAgo: 30 * MIN }] });
write('history.json', [
  { sessionId: S1, cwd: 'D:/code/web-shop', project: 'web-shop', startedAgo: 38 * MIN, lastActiveAgo: 20000, firstPrompt: 'Add a checkout coupon field and wire it to the cart total', bytes: 2140000, resumeCmd: 'claude --resume ' + S1 },
  { sessionId: S2, cwd: 'D:/code/api-gateway', project: 'api-gateway', startedAgo: 55 * MIN, lastActiveAgo: 4 * MIN, firstPrompt: 'Rotate the JWT signing key and roll it out behind a feature flag', bytes: 1480000, resumeCmd: 'claude --resume ' + S2 },
  { sessionId: S3, cwd: 'D:/code/docs-site', project: 'docs-site', startedAgo: 22 * MIN, lastActiveAgo: 30000, firstPrompt: 'Rewrite the Getting Started page from the new CLI flags', bytes: 620000, resumeCmd: 'claude --resume ' + S3 },
  { sessionId: S4, cwd: 'D:/code/mobile-app', project: 'mobile-app', startedAgo: 3 * 3600000, lastActiveAgo: 9 * MIN, firstPrompt: 'Fix the flaky login test on Android', bytes: 410000, resumeCmd: 'claude --resume ' + S4 },
  { sessionId: '55555555-5555-4555-8555-555555555555', cwd: 'D:/code/web-shop', project: 'web-shop', startedAgo: 26 * 3600000, lastActiveAgo: 24 * 3600000, firstPrompt: 'Why is the cart page slow on first load?', bytes: 3900000, resumeCmd: 'claude --resume 55555555-5555-4555-8555-555555555555' },
  { sessionId: '66666666-6666-4666-8666-666666666666', cwd: 'D:/code/old-blog', project: 'old-blog', startedAgo: 3 * 86400000, lastActiveAgo: 3 * 86400000, firstPrompt: 'Migrate the posts folder to MDX', bytes: 1200000, resumeCmd: 'claude --resume 66666666-6666-4666-8666-666666666666' },
]);
const sa = (agentId, sid, project, description, agentType, cost, dur, tools, startedAgo, extra) => ({ agentId, sessionId: sid, project, description, agentType, background: true, model: 'claude-sonnet-4-5', tokens: { input: 300, output: 6000, cacheWrite: 90000, cacheRead: 700000, total: 796300 }, costUSD: cost, durationMs: dur, startedAgo, endedAgo: startedAgo - dur, toolUses: tools, turns: 8, toolErrors: 0, endedOnError: false, ...extra });
write('subagents.json', {
  subagents: [
    sa('demo-s1-a', S1, 'web-shop', 'Check the cart total math', 'Reviewer', 0.31, 4 * MIN, 9, 6 * MIN),
    sa('demo-s1-b', S1, 'web-shop', 'Run the cart test suite', 'TestRunner', 0.22, 3 * MIN, 5, 6 * MIN),
    sa('demo-s1-c', S1, 'web-shop', 'Find every couponCode reference', 'Explore', 0.09, 1 * MIN, 4, 6 * MIN),
    sa('demo-s3-a', S3, 'docs-site', 'Draft the Getting Started page', 'general-purpose', 0.27, 5 * MIN, 7, 6 * MIN),
    sa('a-old-1', '55555555-5555-4555-8555-555555555555', 'web-shop', 'Profile the cart page first load', 'Explore', 0.44, 7 * MIN, 12, 25 * 3600000),
    sa('a-old-2', S4, 'mobile-app', 'Reproduce the flaky login test 10 times', 'TestRunner', 0.38, 9 * MIN, 14, 2.5 * 3600000, { toolErrors: 1 }),
  ],
  totals: { count: 6, today: 4, tokens: 4777800, costUSD: 1.71, tokensToday: 3185200, costToday: 0.89, toolUses: 51 },
  byType: [{ agentType: 'Explore', count: 2, tokens: 1592600, costUSD: 0.53 }, { agentType: 'TestRunner', count: 2, tokens: 1592600, costUSD: 0.6 }, { agentType: 'Reviewer', count: 1, tokens: 796300, costUSD: 0.31 }, { agentType: 'general-purpose', count: 1, tokens: 796300, costUSD: 0.27 }],
  scorecard: [
    { agentType: 'Explore', runs: 2, avgCostUSD: 0.27, avgDurationMs: 4 * MIN, avgToolUses: 8, toolErrorRate: 0, endedOnErrorPct: 0, totalCostUSD: 0.53, lastRunAgo: 6 * MIN },
    { agentType: 'TestRunner', runs: 2, avgCostUSD: 0.3, avgDurationMs: 6 * MIN, avgToolUses: 9.5, toolErrorRate: 5.3, endedOnErrorPct: 0, totalCostUSD: 0.6, lastRunAgo: 6 * MIN },
  ],
});
write('digest.json', {
  days: 7, generatedAt: 0,
  totals: { costUSD: 61.4, tokens: 29400000, sessions: 23, commits: 17, projects: 4 },
  byDay: byDay.slice(-7).map((d) => ({ ...d, sessions: 3, commits: 2 })),
  projects: [
    { project: 'web-shop', path: 'D:/code/web-shop', sessions: 9, prompts: 41, commits: 8, costUSD: 27.1, lastCommits: [{ hash: 'a1b2c3d', date: '2 h ago', subject: 'feat(cart): coupon field + total wiring' }, { hash: 'b2c3d4e', date: 'yesterday', subject: 'perf(cart): lazy-load the recommendations rail' }] },
    { project: 'api-gateway', path: 'D:/code/api-gateway', sessions: 6, prompts: 22, commits: 5, costUSD: 18.3, lastCommits: [{ hash: 'c3d4e5f', date: '3 h ago', subject: 'feat(auth): JWT key rotation behind a flag' }] },
    { project: 'docs-site', path: 'D:/code/docs-site', sessions: 5, prompts: 14, commits: 3, costUSD: 9.6, lastCommits: [{ hash: 'd4e5f6a', date: 'today', subject: 'docs: getting started rewrite (draft)' }] },
    { project: 'mobile-app', path: 'D:/code/mobile-app', sessions: 3, prompts: 9, commits: 1, costUSD: 6.4, lastCommits: [{ hash: 'e5f6a7b', date: 'yesterday', subject: 'test: stabilize the Android login test' }] },
  ],
  markdown: '# Ship digest — last 7 days\n\n23 sessions · 17 commits · $61.40\n\n- **web-shop** — 8 commits, $27.10\n- **api-gateway** — 5 commits, $18.30\n- **docs-site** — 3 commits, $9.60\n- **mobile-app** — 1 commit, $6.40\n',
});
const series = byDay.map((d) => ({ dayAgo: d.dayAgo, prompts: 4 + (d.dayAgo % 4), toolCalls: 60 + (d.dayAgo * 7) % 50, toolErrors: d.dayAgo % 3, corrections: d.dayAgo % 2 }));
write('lessons.json', {
  generatedAt: 0, days: 60, minCount: 3, minSessions: 2, series,
  candidates: [
    { sig: 'Bash: npm test (no script)', family: '', label: 'npm test ran in a folder with no test script', tool: 'Bash', members: [], count: 7, sessions: 4, projects: ['docs-site', 'old-blog'], first: '', last: '', samples: ['npm ERR! Missing script: "test"'], draft: 'Before running npm test, check package.json has a test script; docs-site uses `mkdocs build --strict` instead.', spark: series.map((d) => (d.dayAgo % 9 === 0 ? 1 : 0)) },
    { sig: 'Edit: old_string not found', family: '', label: 'Edit failed because the file changed after it was read', tool: 'Edit', members: [], count: 5, sessions: 3, projects: ['web-shop'], first: '', last: '', samples: ['String to replace not found in file'], draft: 'Re-read a file right before editing it when a sub-agent may have touched it.', spark: series.map((d) => (d.dayAgo % 11 === 0 ? 1 : 0)) },
  ],
  lessons: [{ id: 'l-1', sig: 'Bash: gradlew permission denied', text: 'Run ./gradlew through bash, not PowerShell, on this machine.', target: 'project:D:/code/mobile-app', promotedAt: 0, effect: { before: { days: 10, calls: 800, hits: 6, rate: 0.75 }, after: { days: 10, calls: 760, hits: 0, rate: 0 }, verdict: 'better', note: 'no repeats since' }, spark: series.map(() => 0) }],
  totals: { files: 68, parsed: 68, scanMs: 1200, prompts: 161, toolCalls: 2410, toolErrors: 29, corrections: 14 },
});
write('patterns.json', { generatedAt: 0, days: 30, totals: { prompts: 161, sessions: 23, projects: 4, files: 68, parsed: 68, scanMs: 900 }, buckets: [], suggestions: [] });
write('suggestions.json', { scanned: 23, suggestions: [
  { kind: 'command', title: 'Frequent command: `npm test -- cart`', detail: 'Ran 9× across 3 sessions. Consider a /test-cart slash command or an allow rule so it never prompts.', evidence: '9× · web-shop', snippet: 'Bash(npm test:*)' },
  { kind: 'prompt', title: 'Repeated prompt: "run the tests and fix what fails"', detail: 'Typed 5× in 4 sessions — a routine or a skill would save the retyping.', evidence: '5× · web-shop, api-gateway', snippet: null },
  { kind: 'mcp', title: 'playwright MCP is loaded but unused in web-shop', detail: 'Listed in .mcp.json, zero calls in 30 days. Each turn still pays for its tool definitions.', evidence: '0 calls · web-shop', snippet: null },
] });
write('skills.json', {
  skills: [
    { name: 'browser-verify', project: 'Global (user)', projectPath: 'C:/Users/demo', global: true, summary: 'Prove a web change works in a real browser before reporting it done.' },
    { name: 'ship-it', project: 'Global (user)', projectPath: 'C:/Users/demo', global: true, summary: 'Finish-line ritual: docs, build, commit, push, restart.' },
    { name: 'humanize', project: 'Global (user)', projectPath: 'C:/Users/demo', global: true, summary: 'Rewrite prose so it sounds like a person wrote it.' },
    { name: 'deploy', project: 'web-shop', projectPath: 'D:/code/web-shop', global: false, summary: 'Build and deploy the storefront to staging.' },
    { name: 'release-notes', project: 'api-gateway', projectPath: 'D:/code/api-gateway', global: false, summary: 'Draft release notes from merged PRs.' },
  ],
  projects: [{ name: 'Global (user)', path: 'C:/Users/demo', global: true }, { name: 'web-shop', path: 'D:/code/web-shop', global: false }, { name: 'api-gateway', path: 'D:/code/api-gateway', global: false }, { name: 'docs-site', path: 'D:/code/docs-site', global: false }, { name: 'mobile-app', path: 'D:/code/mobile-app', global: false }],
});
write('skill-usage.json', { days: 30, generatedAt: 0, skillUsage: { 'browser-verify': { count: 12, lastUsedAgo: 3600000, projects: ['web-shop', 'docs-site'] }, 'ship-it': { count: 7, lastUsedAgo: 86400000, projects: ['web-shop', 'api-gateway'] }, deploy: { count: 3, lastUsedAgo: 2 * 86400000, projects: ['web-shop'] } } });
write('processes.json', { processes: state.procs.map((p) => ({ ...p, started: '' })), generatedAt: '' });
write('forensics.json', {
  days: 14,
  waste: { reReads: [{ project: 'web-shop', session: S1, file: 'D:/code/web-shop/src/cart/total.js', reads: 6 }, { project: 'docs-site', session: S3, file: 'D:/code/docs-site/docs/cli.md', reads: 4 }], reReadTotal: 10, deadMcp: ['playwright'], usedMcp: ['github'], editQuality: { edits: 212, editedFiles: 61, oneShot: 168, reworked: 19, oneShotRate: 79, costPerEdit: 0.29, reworkedTop: [{ project: 'web-shop', session: S1, file: 'D:/code/web-shop/src/cart/Checkout.svelte', edits: 7 }] }, days: 14, scanMs: 640 },
  productivity: { productive: 18, abandoned: 5, productiveCost: 54.2, abandonedCost: 7.2, shippedPct: 78, abandonedTop: [{ project: 'old-blog', costUSD: 4.1, lastActiveAgo: 3 * 86400000 }] },
  taskTypes: { byType: [{ type: 'coding', label: 'edited files', costUSD: 44.1, sessions: 15, pct: 72 }, { type: 'research', label: 'read-only', costUSD: 11.2, sessions: 6, pct: 18 }, { type: 'ops', label: 'ran commands only', costUSD: 6.1, sessions: 2, pct: 10 }], total: 61.4 },
  generatedAt: 0,
});
write('codex.json', { home: '', sqlite: false, queued: 0, goals: [], sessions: [], totals: { sessions: 0, today: 0, tokensToday: 0, costToday: 0, tokens: 0, costUSD: 0 }, byProject: [] });
write('inspect.json', {
  [S1]: { cwd: 'D:/code/web-shop', subagents: [{ id: 'demo-s1-a', name: 'Reviewer', state: 'reading' }, { id: 'demo-s1-b', name: 'TestRunner', state: 'testing' }, { id: 'demo-s1-c', name: 'Explore', state: 'searching' }], skills: ['browser-verify', 'ship-it', 'deploy'], agents: ['code-reviewer'], hooks: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'] },
  [S2]: { cwd: 'D:/code/api-gateway', subagents: [], skills: ['ship-it', 'release-notes'], agents: ['code-reviewer', 'security-auditor'], hooks: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest'] },
  [S3]: { cwd: 'D:/code/docs-site', subagents: [{ id: 'demo-s3-a', name: 'Writer', state: 'coding' }], skills: ['browser-verify'], agents: [], hooks: ['SessionStart', 'PostToolUse', 'Stop'] },
  [S4]: { cwd: 'D:/code/mobile-app', subagents: [], skills: ['ship-it'], agents: ['code-reviewer'], hooks: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'] },
});
write('session-meta.json', {
  [S1]: { title: 'Checkout coupon field', fileCount: 12, artifacts: ['src/cart/Checkout.svelte', 'src/cart/total.js', 'src/cart/coupon.js', 'tests/cart.test.js'] },
  [S2]: { title: 'Rotate JWT signing key', fileCount: 7, artifacts: ['src/auth/keys.js', 'src/auth/verify.js', 'config/flags.json'] },
  [S3]: { title: 'Getting Started rewrite', fileCount: 3, artifacts: ['docs/getting-started.md', 'docs/cli.md'] },
  [S4]: { title: 'Flaky Android login test', fileCount: 2, artifacts: ['app/src/androidTest/LoginTest.kt'] },
});
const breakdown = (total) => {
  const cat = (key, label, pct) => ({ key, label, pct, tokens: Math.round(total * pct) });
  return { totalTokens: total, ctxMax: 200000, behind: false, compactions: 0,
    categories: [cat('toolResults', 'Tool results', 0.46), cat('toolCalls', 'Tool calls', 0.14), cat('thinking', 'Thinking', 0.09), cat('conversation', 'Conversation', 0.11), cat('injected', 'CLAUDE.md · memory · skills', 0.13), cat('baseline', 'System + tools baseline', 0.07)],
    biggest: [{ tool: 'Read', detail: 'D:/code/web-shop/src/cart/Checkout.svelte', tokens: Math.round(total * 0.08) }, { tool: 'Bash', detail: 'npm test -- cart', tokens: Math.round(total * 0.06) }],
    advice: total > 60000 ? 'Tool results are almost half the window — large file reads are the lever here.' : '',
    note: 'Estimated from the transcript, scaled to the real total.' };
};
write('context-breakdown.json', { [S1]: breakdown(82000), [S2]: breakdown(66000), [S3]: breakdown(36000), [S4]: breakdown(24000) });
const msg = (role, text, tools, minAgo) => ({ role, text, tools: tools || [], tsAgo: minAgo * MIN });
write('transcript.json', {
  [S1]: { messages: [
    msg('user', 'Add a checkout coupon field and wire it to the cart total', [], 38),
    msg('assistant', 'I will look at the cart total logic first, then add the field to Checkout.svelte.', [{ name: 'Read', input: { file_path: 'src/cart/total.js' } }], 37),
    msg('assistant', 'The total already rounds to cents. I will add a coupon reducer and a Reviewer sub-agent to double-check the math while I write the UI.', [{ name: 'Agent', input: { description: 'check the cart total math' } }], 30),
    msg('assistant', 'Coupon field added; running the cart tests now.', [{ name: 'Edit', input: { file_path: 'src/cart/Checkout.svelte' } }, { name: 'Bash', input: { command: 'npm test -- cart' } }], 6),
  ] },
  [S2]: { messages: [
    msg('user', 'Rotate the JWT signing key and roll it out behind a feature flag', [], 55),
    msg('assistant', 'Key rotation is written behind the auth.keyRotation flag and the tests pass. Publishing the shared auth package needs your OK.', [{ name: 'Edit', input: { file_path: 'src/auth/keys.js' } }, { name: 'Bash', input: { command: 'npm test' } }], 5),
  ] },
  [S3]: { messages: [msg('user', 'Rewrite the Getting Started page from the new CLI flags', [], 22), msg('assistant', 'Reading the CLI reference and drafting the page with a Writer sub-agent.', [{ name: 'Read', input: { file_path: 'docs/cli.md' } }], 20)] },
  [S4]: { messages: [msg('user', 'Fix the flaky login test on Android', [], 180), msg('assistant', 'The test raced the splash screen. Added an idling resource; 10 of 10 runs pass. Anything else?', [{ name: 'Bash', input: { command: './gradlew test' } }], 9)] },
});
write('github.json', { url: 'https://github.com/example/web-shop', branch: 'feat/coupon-field', ahead: 2, behind: 0, dirty: 3, prs: [{ number: 142, title: 'feat(cart): coupon field + total wiring', state: 'open', url: 'https://github.com/example/web-shop/pull/142' }] });
write('search.json', { q: '', results: [
  { sessionId: S1, project: 'web-shop', cwd: 'D:/code/web-shop', count: 3, lastActiveAgo: 20000, snippets: [{ tsAgo: 6 * MIN, role: 'assistant', text: 'Coupon field added; running the cart tests now.' }] },
  { sessionId: '55555555-5555-4555-8555-555555555555', project: 'web-shop', cwd: 'D:/code/web-shop', count: 1, lastActiveAgo: 24 * 3600000, snippets: [{ tsAgo: 24 * 3600000, role: 'user', text: 'Why is the cart page slow on first load?' }] },
], total: 2, scanned: 6, projects: ['web-shop'] });
write('replay.json', { ok: true, project: 'web-shop', sessionId: S1, durationMs: 38 * MIN, totalTokens: 2300000, totalCostUSD: 4.82, events: [
  { t: 0, kind: 'prompt', state: 'thinking', label: 'Add a checkout coupon field and wire it to the cart total', tokens: 0, costUSD: 0 },
  { t: 40000, kind: 'tool', state: 'reading', label: 'Read src/cart/total.js', tokens: 90000, costUSD: 0.2 },
  { t: 7 * MIN, kind: 'tool', state: 'spawning', label: 'Agent Reviewer', tokens: 400000, costUSD: 0.9 },
  { t: 12 * MIN, kind: 'tool', state: 'coding', label: 'Edit src/cart/Checkout.svelte', tokens: 900000, costUSD: 1.9 },
  { t: 31 * MIN, kind: 'tool', state: 'testing', label: 'Bash npm test -- cart', tokens: 1900000, costUSD: 3.9 },
  { t: 37 * MIN, kind: 'text', state: 'coding', label: 'Coupon field added; running the cart tests now.', tokens: 2300000, costUSD: 4.82 },
] });
write('away.json', { since: 0, now: 0, minutes: 0, finished: [], failed: [], waiting: [{ project: 'api-gateway', name: 'api-gateway', why: 'wants to run Bash: npm publish --access public' }], queue: { done: 1, failed: 0, review: 0, inReview: 0 }, collisions: 0, dangers: 0, blocked: 0, headline: '1 needs you', quiet: false, held: 1 });
write('configs.json', {
  license: { licensed: true, mode: 'demo' },
  'app-config': { stallMinutes: 3, burnAlert: 5, longRunMinutes: 0, ctxAlertPct: 0.85, usageAlertPct: 90, lessonMinCount: 3, ollamaUrl: '', lmstudioUrl: '', gameNames: '', quietHours: { enabled: false, start: '23:00', end: '08:00', days: [0, 0, 0, 0, 0, 0, 0], critical: ['runaway', 'error'], channels: ['telegram', 'slack', 'desktop', 'sound'] }, autoRetire: true, retireDoneSec: 180, retireClosedSec: 60, retireIdleSec: 1500, retireStaleActiveSec: 1800, testCmd: '', testCmds: {}, codex: false, telegramReplyToken: { set: false, hint: '' }, license: { set: false, hint: '' }, allowRemote: false, accessToken: { set: false, hint: '' }, fleetIntervalMs: 5000, phone: { remote: false, tokenSet: false, urls: ['http://192.168.1.20:3131/phone'], port: 3131 }, restartNeeded: false },
  budget: { dailyCost: 8.69, daily: 25, session: 0, enforce: false, overDaily: false, generatedAt: 0 },
  'dispatch-config': { enabled: false, sessions: [], rateLimit: null, inboxDeliver: true, inboxes: 0 },
  'claude-version': { cmd: 'claude', current: '2.1.306', latest: '2.1.306', behind: false, checkedAt: 0 },
  teams: { teams: [] },
  peers: { peers: [], inboxDeliver: true },
  permissions: { pending: [{ sessionId: S2, requestId: 'demo-perm-1', tool: 'Bash', detail: 'npm publish --access public', ts: 0 }] },
  runbook: { error: 'session required' },
  editor: { cmd: 'code' },
  'claude-config': { cmd: '', permMode: '', flags: '' },
  'telegram-config': { configured: false, hasToken: false, chatId: '', dashboardUrl: 'http://localhost:3131/' },
  'slack-config': { configured: false, url: '', hasAppToken: false, hasBotToken: false, channel: '', inbound: false },
  'nudge-config': { onSend: false, interval: 0 },
  'os-notify-config': { enabled: true },
  'pricing-config': { rows: [], unpriced: [] },
  'ambient-config': { enabled: false, events: ['awaiting', 'error', 'runaway', 'done', 'clear', 'limit'], colors: { awaiting: 'amber', error: 'red', runaway: 'red', done: 'green', clear: 'off', limit: 'orange' }, awaiting: { webhook: '', command: '', color: '', effect: '' }, error: { webhook: '', command: '', color: '', effect: '' }, runaway: { webhook: '', command: '', color: '', effect: '' }, done: { webhook: '', command: '', color: '', effect: '' }, clear: { webhook: '', command: '', color: '', effect: '' }, limit: { webhook: '', command: '', color: '', effect: '' }, lifx: { enabled: false, hasToken: false, selector: 'all' } },
  'board-config': { inject: true, claudeMd: false },
  'fleet-config': { intervalMs: 5000, peers: [], status: [] },
  templates: { templates: [{ id: 't-1', name: 'Tests green', prompt: 'Run the test suite and fix what fails. Stop when green.' }, { id: 't-2', name: 'Release notes', prompt: 'Draft release notes from the commits since the last tag.' }] },
  phone: { needsYou: 1, queued: 2, running: 1, review: 0, paused: false, escalations: 0, plans: 0, permissions: [{ sessionId: S2, project: 'api-gateway', tool: 'Bash', detail: 'npm publish --access public' }], reviews: [], attention: [], plan: null, at: 0 },
  'mod/band': { needsYou: 1, spendUsd: 8.69, ctxPercent: 41, url: 'http://localhost:3131/' },
  'git-status': { branch: 'feat/coupon-field', ahead: 2, behind: 0, dirty: 3, files: ['src/cart/Checkout.svelte', 'src/cart/coupon.js', 'tests/cart.test.js'] },
  'queue/diff': { log: 'a1b2c3d feat(cart): coupon field + total wiring', stat: ' 3 files changed, 84 insertions(+), 6 deletions(-)', patch: '' },
});
console.log('wrote demo fixtures to', OUT);
