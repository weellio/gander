'use strict';
// bridge/patterns.js — prompt-habit + skill-usage mining from ~/.claude transcripts.
// One streaming pass over the last N days of transcripts produces two things:
//   patterns   — how the USER prompts: approval-only turns ("yes"/"go"), keep-alive
//                pokes ("still going?"), correction turns after a false "done",
//                pasted errors/transcripts, repeated docs/slop/restart asks —
//                plus fix cards (a CLAUDE.md line, a skill, a queue habit).
//   skillUsage — which skills actually get invoked (Skill tool calls + /commands),
//                so the Skills table can show used-N-times / never-used.
// Deterministic — no model calls. Same counts every scan.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ── prompt classification ────────────────────────────────────────────────────
// Order matters: the first matching bucket wins. Everything else is a normal
// work prompt (null). Text arrives trimmed.
const APPROVAL = /^(y(es|ep|up)?|ok(ay)?|sure|k|cool|perfect|sounds good|go|go ahead|go for it|proceed|continue|keep going|do it( all)?|do them all|do all( of)? (them|it|the above)|add it all|all of the above|all of them|both|build both|complete it all|make it so|1|2|3)[\s.,!?…]*$/i;
const KEEPALIVE = /(still (going|working|running|testing)\??|are you (still|there)|you there\??|did you (fall asleep|get stuck|stall)|is it (going|running|still)|everything running|all good\??|how('re| are)? we doing|done yet|why (are you|aren'?t you|do you) (not )?(running|working|using)|you'?ve? been stopped|are you still work|it'?s idle)/i;
const SLOP = /(stop.?slop|de.?slop+ed?|em.?dash|humanize skill)/i;
const RESTART = /(restart (teh |the )?(server|bridge|app|backend)|start the server so)/i;
const DOCS = /((update|create|make|refresh|redo)[^.!?]{0,40}(readme|faq|help (page|modal)|the docs|documentation)|readme[^.!?]{0,30}(update|current|comprehensive)|push(ed)? (it )?to github|upload[^.!?]{0,24}github|deploy to github|update[^.!?]{0,24}github repo|playbook and runbook)/i;
const ERRPASTE = /(uncaught (reference|type)?error|traceback \(most recent|exception on [/[]|failed to load resource|net::err_|err_[a-z_]{3,}|\[winerror|errno \d+|http error (4|5)\d\d|status of (4|5)\d\d|^ps [a-z]:\\)/im;
const CORRECTION = /(i (still )?(don'?t|can'?t|cannot) see|didn'?t (work|change|update)|(is |are )?not working|no worky|still (broken|the same|don'?t see|can'?t see|not (there|working|showing))|that wasn'?t|you (missed|forgot|skipped)|doesn'?t (appear|show|work|do anything|seem to)|nothing (happens|happened|changed)|same (issue|problem|error)|not what i (asked|wanted|meant)|i was (hoping|expecting|referring)|why is (it|there) (still|not))/i;
const TIMESTAMPY = /\[?\b\d{1,2}:\d{2}\b\]?[\s\S]{0,400}\[?\b\d{1,2}:\d{2}\b\]?[\s\S]{0,400}\[?\b\d{1,2}:\d{2}\b\]?/;

function classifyPrompt(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.length <= 40 && APPROVAL.test(t)) return 'approval';
  if (t.length <= 160 && KEEPALIVE.test(t)) return 'keepalive';
  if (SLOP.test(t)) return 'slop';
  if (RESTART.test(t)) return 'restart';
  if (DOCS.test(t)) return 'docs';
  if (t.length > 600 && (TIMESTAMPY.test(t) || /\btranscripts?\b|\bpodcast\b/i.test(t.slice(0, 250)))) return 'paste';
  if (ERRPASTE.test(t)) return 'errpaste';
  if (t.length <= 500 && CORRECTION.test(t)) return 'correction';
  return null;
}

const BUCKET_META = {
  approval:   { label: 'Approval-only turns',   hint: '“yes” / “go” / “do it all” — a whole turn spent granting permission you meant to grant up front.' },
  keepalive:  { label: 'Keep-alive pokes',      hint: '“still going?” — checking on a session that went quiet mid-task.' },
  correction: { label: 'Correction turns',      hint: '“i don’t see the change” — a change was reported done but didn’t survive contact with the app.' },
  errpaste:   { label: 'Pasted errors',         hint: 'Console/terminal output pasted back by hand — the session didn’t catch its own failure.' },
  paste:      { label: 'Pasted transcripts',    hint: 'A video/podcast transcript pasted for idea-mining.' },
  docs:       { label: 'Docs/GitHub asks',      hint: '“update the readme / push to github” — the finish-line ritual, requested manually.' },
  slop:       { label: 'De-slop asks',          hint: 'Asking for stop-slop / em-dash scrubbing on outward-facing copy.' },
  restart:    { label: 'Server-restart asks',   hint: 'Asking for a rebuild/restart just to see the change.' },
};

// Typed-by-a-human filter: drop harness-injected user messages.
function isInjected(t) {
  return t.startsWith('<task-notification') || t.startsWith('<local-command') ||
    t.startsWith('<system-reminder') || t.startsWith('This session is being continued') ||
    t.startsWith('[Request interrupted');
}

// Pull the typed text out of a user message (string or content blocks; never tool_results).
function userText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  return parts.join('\n').trim();
}

const CMD_RE = /<command-name>\/?([\w:-]+)<\/command-name>/;
// CLI built-ins typed as /commands — not skills, so not usage-counted.
const BUILTIN_CMDS = new Set(['model', 'compact', 'clear', 'help', 'hooks', 'mcp', 'agents', 'resume', 'login', 'logout', 'status', 'config', 'cost', 'doctor', 'init', 'memory', 'exit', 'quit', 'context', 'rewind', 'export', 'add-dir', 'bug', 'permissions', 'plugin', 'settings', 'terminal-setup', 'vim', 'workflows', 'fast']);

// ── the scan ─────────────────────────────────────────────────────────────────
// Incremental: per-file results are cached in a small JSON "database"
// (bridge/aoc-patterns.json) keyed by path and validated by mtime+size, so a
// rescan only re-parses transcripts that actually changed — a warm scan over
// hundreds of MB touches a handful of live session files and returns in ms.
// Precision is unchanged: unchanged bytes parse to unchanged counts, so reusing
// them is exact (no vectors, no approximation).
function transcriptFiles(root, sinceMs, cap) {
  const files = [];
  let dirs; try { dirs = fs.readdirSync(root); } catch (_) { return files; }
  for (const d of dirs) {
    let names; try { names = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of names) {
      const p = path.join(root, d, f);
      try { const st = fs.statSync(p); if (st.mtimeMs >= sinceMs) files.push({ p, mtime: st.mtimeMs, size: st.size }); } catch (_) {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, cap);
}

// Parse ONE transcript into its per-file tallies (day-independent, so the entry
// stays valid as the window slides — a file is in or out by its mtime).
async function parseFile(p, mtime) {
  const r = { proj: '', prompts: 0, buckets: {}, samples: {}, skills: {} };
  const hitSkill = (name, ts) => {
    const key = String(name).replace(/^\//, '');
    const e = r.skills[key] || (r.skills[key] = { c: 0, last: 0 });
    e.c++; if (ts > e.last) e.last = ts;
  };
  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  for await (const line of rl) {
    // cheap prefilter: only parse lines that can matter (typed prompts / Skill calls)
    const isUser = line.includes('"type":"user"');
    const isSkillCall = line.includes('"name":"Skill"');
    if (!isUser && !isSkillCall) continue;
    if (line.length > 2_000_000) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (!r.proj && o.cwd) r.proj = path.basename(String(o.cwd));
    const ts = o.timestamp ? Date.parse(o.timestamp) || mtime : mtime;

    if (isSkillCall && o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (b && b.type === 'tool_use' && b.name === 'Skill' && b.input && b.input.skill) hitSkill(b.input.skill, ts);
      }
    }

    if (o.type !== 'user' || !o.message || o.isMeta) continue;
    const t = userText(o.message);
    if (!t || isInjected(t)) continue;
    const cmd = t.match(CMD_RE);
    if (cmd) { if (!BUILTIN_CMDS.has(cmd[1])) hitSkill(cmd[1], ts); continue; }   // slash-command turn → usage, not a habit
    r.prompts++;
    const k = classifyPrompt(t);
    if (k) {
      r.buckets[k] = (r.buckets[k] || 0) + 1;
      const s = r.samples[k] || (r.samples[k] = []);
      if (s.length < 2) s.push(t.replace(/\s+/g, ' ').slice(0, 140));
    }
  }
  return r;
}

// One in-process cache per file path; hydrated from disk on first scan.
const CACHE_VERSION = 1;
const memo = new Map();   // cachePath -> { v, files: { [path]: { mtime, size, ...parseFile result } } }
function loadCache(cachePath) {
  if (memo.has(cachePath)) return memo.get(cachePath);
  let c = null;
  try { c = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (_) {}
  if (!c || c.v !== CACHE_VERSION || !c.files) c = { v: CACHE_VERSION, files: {} };
  memo.set(cachePath, c);
  return c;
}
function saveCache(cachePath, c) {
  try { fs.writeFileSync(cachePath + '.tmp', JSON.stringify(c)); fs.renameSync(cachePath + '.tmp', cachePath); } catch (_) {}
}

async function scan(opts) {
  const t0 = Date.now();
  const days = Math.max(1, Math.min(90, Number(opts && opts.days) || 30));
  const root = (opts && opts.root) || path.join(os.homedir(), '.claude', 'projects');
  const cachePath = (opts && opts.cachePath) || path.join(__dirname, 'aoc-patterns.json');
  const sinceMs = Date.now() - days * 86400e3;
  const files = transcriptFiles(root, sinceMs, 400);
  const cache = loadCache(cachePath);

  let parsed = 0, dirty = false;
  const live = new Set();
  for (const f of files) {
    live.add(f.p);
    const ent = cache.files[f.p];
    if (ent && ent.mtime === f.mtime && ent.size === f.size) continue;   // unchanged bytes → cached counts are exact
    cache.files[f.p] = { mtime: f.mtime, size: f.size, ...(await parseFile(f.p, f.mtime)) };
    parsed++; dirty = true;
  }
  for (const p of Object.keys(cache.files)) {           // drop entries that left the window (or were deleted)
    if (!live.has(p)) { delete cache.files[p]; dirty = true; }
  }
  if (dirty) saveCache(cachePath, cache);

  // aggregate the per-file tallies
  const buckets = {}; for (const k of Object.keys(BUCKET_META)) buckets[k] = { count: 0, samples: [] };
  const skills = new Map();
  const projSet = new Set(), sessSet = new Set();
  let prompts = 0;
  for (const f of files) {
    const e = cache.files[f.p];
    if (!e) continue;
    prompts += e.prompts;
    if (e.prompts) { sessSet.add(f.p); if (e.proj) projSet.add(e.proj); }
    for (const [k, n] of Object.entries(e.buckets || {})) {
      buckets[k].count += n;
      for (const s of e.samples?.[k] || []) if (buckets[k].samples.length < 3) buckets[k].samples.push(s);
    }
    for (const [name, u] of Object.entries(e.skills || {})) {
      const agg = skills.get(name) || { count: 0, lastUsed: 0, projects: new Set() };
      agg.count += u.c; if (u.last > agg.lastUsed) agg.lastUsed = u.last; if (e.proj) agg.projects.add(e.proj);
      skills.set(name, agg);
    }
  }

  const bucketList = Object.entries(buckets)
    .map(([key, b]) => ({ key, label: BUCKET_META[key].label, hint: BUCKET_META[key].hint, count: b.count, pct: prompts ? Math.round((b.count / prompts) * 1000) / 10 : 0, samples: b.samples }))
    .sort((a, b) => b.count - a.count);

  const skillUsage = {};
  for (const [name, e] of skills) skillUsage[name] = { count: e.count, lastUsed: e.lastUsed, projects: [...e.projects].slice(0, 6) };

  return {
    generatedAt: Date.now(), days,
    totals: { prompts, sessions: sessSet.size, projects: projSet.size, files: files.length, parsed, scanMs: Date.now() - t0 },
    buckets: bucketList,
    suggestions: buildFixes(bucketList, prompts),
    skillUsage,
  };
}

// ── fix cards ────────────────────────────────────────────────────────────────
// Each card names the habit, the cost, and the config/skill that removes it.
// Snippets are copy-paste ready (a CLAUDE.md line, not a lecture).
function buildFixes(buckets, prompts) {
  const n = (k) => (buckets.find((b) => b.key === k) || { count: 0 }).count;
  const pct = (k) => (prompts ? Math.round((n(k) / prompts) * 100) : 0);
  const out = [];
  if (n('approval') >= 8 || pct('approval') >= 5) {
    out.push({
      kind: 'claude-md', title: 'Standing authorization — stop paying the “yes” tax',
      detail: `${n('approval')} of your last ${prompts} prompts (${pct('approval')}%) only said “yes/go/do it”. One line in your global CLAUDE.md grants that up front, so sessions keep working instead of stopping to ask.`,
      evidence: `${n('approval')}× · ${pct('approval')}%`,
      snippet: 'When I’ve set a goal, you have blanket approval for all work within its scope: do every recommended item without asking, pick the sensible option yourself, and keep working until it’s complete or I say stop. Never end a turn asking “should I proceed?” for in-scope work. Only stop for genuinely destructive actions or a real scope change.',
    });
  }
  if (n('keepalive') >= 4) {
    out.push({
      kind: 'routine', title: 'Keep-alive pokes → let Gander watch instead',
      detail: `You checked on quiet sessions ${n('keepalive')}× (“still going?”). The 🔔 rail now flags sessions that went quiet mid-goal, and Settings → Wake idle sessions can nudge them automatically. Queue long jobs via 📋 Task queue so “is it done?” becomes a notification.`,
      evidence: `${n('keepalive')}×`, snippet: null,
    });
  }
  if (n('correction') + n('errpaste') >= 6) {
    out.push({
      kind: 'claude-md', title: 'You are the QA loop — make Claude verify in the browser first',
      detail: `${n('correction')} correction turns + ${n('errpaste')} hand-pasted errors. A CLAUDE.md rule (or a verify skill) makes Claude serve the app, check the console, and screenshot BEFORE reporting done — so the browser catches it, not you.`,
      evidence: `${n('correction') + n('errpaste')}×`,
      snippet: 'After changing a web app or game, verify in a real browser before reporting done: serve over http (never file://), check the console for errors, and confirm the change is actually visible — screenshot it. Node tests passing is not verification.',
    });
  }
  if (n('paste') >= 3) {
    out.push({
      kind: 'skill', title: 'Pasted transcripts → a mining skill',
      detail: `You pasted ${n('paste')} long transcripts for idea-mining. A skill can make every paste follow the same drill — extract tactics, dedupe against what the project already has, record source + decision, apply the easy wins (build it with component-builder).`,
      evidence: `${n('paste')}×`, snippet: null,
    });
  }
  if (n('docs') >= 3) {
    out.push({
      kind: 'claude-md', title: 'The finish-line ritual, automated',
      detail: `You asked for readme/FAQ/GitHub updates ${n('docs')}× by hand. Make it the default definition of done.`,
      evidence: `${n('docs')}×`,
      snippet: 'A feature is done only after the finish line: update README + in-app help/FAQ to match reality (remove stale entries too), rebuild what the app serves, and commit + push — without being asked.',
    });
  }
  if (n('slop') >= 3) {
    out.push({
      kind: 'claude-md', title: 'De-slop by default',
      detail: `You manually asked for stop-slop/em-dash scrubbing ${n('slop')}×. Make it automatic for outward-facing copy.`,
      evidence: `${n('slop')}×`,
      snippet: 'Any outward-facing copy (emails, posts, captions, replies to people) goes through the stop-slop skill before I see it. Never use em-dashes in it.',
    });
  }
  if (n('restart') >= 2) {
    out.push({
      kind: 'command', title: 'Restart-to-see → part of done',
      detail: `You asked for a server restart just to see changes ${n('restart')}×. Fold it into the definition of done (see the finish-line card), or keep a dev server with hot reload running while iterating on UI.`,
      evidence: `${n('restart')}×`, snippet: null,
    });
  }
  return out;
}

module.exports = { scan, classifyPrompt, userText, isInjected, BUCKET_META };
