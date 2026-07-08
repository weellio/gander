'use strict';
// Gander ship digest — "what did my agents and I actually get done?"
// Deterministic: parsed from ~/.claude transcripts (sessions, spend) and
// git history (commits per project). No model calls, costs nothing.

const { execFile } = require('child_process');
const path = require('path');

function basenameOf(p) { const parts = String(p || '').split(/[\\/]/).filter(Boolean); return parts[parts.length - 1] || 'unknown'; }

function gitLogReal(cwd, days) {
  return new Promise((resolve) => {
    const SEP = '\x1f';   // unit separator - never appears in commit subjects
    execFile('git', ['-C', cwd, 'log', `--since=${days}.days`, '--pretty=format:%h%ad%s', '--date=short', '-n', '40'],
      { timeout: 15000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) return resolve(null);   // not a repo / git missing — fine
        const commits = String(stdout || '').split('\n').filter(Boolean).map((l) => {
          const [hash, date, subject] = l.split('');
          return { hash, date, subject: (subject || '').slice(0, 120) };
        });
        resolve(commits);
      });
  });
}

/**
 * Build the digest. deps are injectable for tests:
 *   usageSummary() -> usage.summaryAsync() shape
 *   sessions()     -> history.list() shape [{project, cwd, lastActive, firstPrompt}]
 *   projectPaths() -> [paths] to check for commits
 *   gitLog(cwd, days) -> [{hash, date, subject}] | null
 */
async function build(opts = {}, deps = {}) {
  const days = Math.max(1, Math.min(31, Number(opts.days) || 7));
  const now = Date.now();
  const cutoff = now - days * 24 * 3600 * 1000;
  const usageSummary = deps.usageSummary || (() => require('./usage.js').summaryAsync());
  const sessionsList = deps.sessions || (() => require('./history.js').list({ limit: 400 }));
  const projectPaths = deps.projectPaths || (() => []);
  const gitLog = deps.gitLog || gitLogReal;

  // 1) spend + tokens in range (byDay covers the last 30 days)
  const u = await usageSummary();
  const daysInRange = (u.byDay || []).slice(-days);
  const costUSD = daysInRange.reduce((s, d) => s + (d.costUSD || 0), 0);
  const tokens = daysInRange.reduce((s, d) => s + (d.tokens || 0), 0);

  // 2) sessions in range, grouped by project (recent prompts = "what was worked on")
  const sess = (await sessionsList()) || [];
  const perProject = new Map();
  let sessionCount = 0;
  for (const s of sess) {
    const t = Date.parse(s.lastActive || '') || 0;
    if (t < cutoff) continue;
    sessionCount++;
    const key = (s.cwd || s.project || 'unknown').toLowerCase();
    let p = perProject.get(key);
    if (!p) { p = { project: s.project || basenameOf(s.cwd), path: s.cwd || '', sessions: 0, prompts: [] }; perProject.set(key, p); }
    p.sessions++;
    const fp = String(s.firstPrompt || '').trim();
    if (fp && p.prompts.length < 4 && !p.prompts.includes(fp)) p.prompts.push(fp.slice(0, 120));
  }

  // 3) commits in range for every project we know about (sessions + configured roots)
  const paths = new Map();
  for (const p of perProject.values()) if (p.path) paths.set(p.path.toLowerCase(), p.path);
  for (const p of projectPaths() || []) if (p) paths.set(String(p).toLowerCase(), String(p));
  let commitTotal = 0;
  await Promise.all(Array.from(paths.values()).map(async (cwd) => {
    const commits = await gitLog(cwd, days);
    if (!commits || !commits.length) return;
    commitTotal += commits.length;
    const key = cwd.toLowerCase();
    let p = perProject.get(key);
    if (!p) { p = { project: basenameOf(cwd), path: cwd, sessions: 0, prompts: [] }; perProject.set(key, p); }
    p.commits = commits.length;
    p.lastCommits = commits.slice(0, 6);
  }));

  const projects = Array.from(perProject.values())
    .filter((p) => p.sessions || p.commits)
    .sort((a, b) => ((b.commits || 0) + b.sessions) - ((a.commits || 0) + a.sessions));

  return {
    days, generatedAt: new Date(now).toISOString(),
    totals: { costUSD, tokens, sessions: sessionCount, commits: commitTotal, projects: projects.length },
    byDay: daysInRange,
    projects,
  };
}

/** Render the digest as shareable markdown (used by the panel's Copy button). */
function toMarkdown(d) {
  const money = (x) => '$' + (Number(x) || 0).toFixed(2);
  const tok = (x) => x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.round(x / 1000) + 'k';
  let out = `# Ship digest — last ${d.days} day${d.days === 1 ? '' : 's'}\n\n`;
  out += `**${d.totals.sessions}** sessions across **${d.totals.projects}** projects · **${d.totals.commits}** commits · ~${money(d.totals.costUSD)} (${tok(d.totals.tokens)} tokens)\n\n`;
  for (const p of d.projects) {
    out += `## ${p.project}\n`;
    out += `${p.sessions} session${p.sessions === 1 ? '' : 's'}${p.commits ? ` · ${p.commits} commit${p.commits === 1 ? '' : 's'}` : ''}\n`;
    if (p.lastCommits && p.lastCommits.length) {
      for (const c of p.lastCommits) out += `- \`${c.hash}\` ${c.subject} (${c.date})\n`;
      if (p.commits > p.lastCommits.length) out += `- …and ${p.commits - p.lastCommits.length} more\n`;
    }
    if (p.prompts && p.prompts.length) {
      out += `\nWorked on: ${p.prompts.map((x) => `“${x}”`).join(' · ')}\n`;
    }
    out += '\n';
  }
  return out;
}

module.exports = { build, toMarkdown };
