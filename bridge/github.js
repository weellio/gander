// bridge/github.js — GitHub info/PRs/issues via the `gh` CLI.
// CommonJS. Zero external deps — uses only child_process.
// module.exports = { info, prs, issues }   (all return Promises, never throw)

'use strict';

const { execFile } = require('child_process');

const TIMEOUT_MS = 8000;

/**
 * Run `gh` with the given args in the given cwd.
 * Resolves to the parsed JSON stdout, or { error: '<reason>' } on any failure.
 */
function runGh(args, cwd) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };

    let child;
    try {
      child = execFile('gh', args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) {
          const msg = (err.message || '').toLowerCase();
          if (/not a git repo/i.test(msg)) return finish({ error: 'not a git repo' });
          if (/no github remote/i.test(msg) || /no remote/i.test(msg)) return finish({ error: 'no GitHub remote' });
          if (/not authenticated/i.test(msg) || /gh auth/i.test(msg)) return finish({ error: 'gh not authenticated' });
          if (/command not found/i.test(msg) || /cannot find/i.test(msg)) return finish({ error: 'gh CLI not found' });
          if (/timeout/i.test(msg)) return finish({ error: 'gh timed out' });
          // catch "disabled issues" or other API-level messages gracefully
          const short = String(err.message || err).slice(0, 120);
          return finish({ error: short });
        }
        try {
          finish(JSON.parse(stdout));
        } catch (_) {
          finish({ error: 'gh output not JSON' });
        }
      });
    } catch (spawnErr) {
      finish({ error: 'gh CLI not found' });
      return;
    }

    // Belt-and-suspenders timeout in case execFile's timeout doesn't fire.
    const t = setTimeout(() => {
      try { child && child.kill(); } catch (_) {}
      finish({ error: 'gh timed out' });
    }, TIMEOUT_MS + 500);
    if (t.unref) t.unref();
  });
}

/**
 * info(dir) — basic repo metadata.
 * Returns { repo, url, defaultBranch, visibility } or { error }.
 */
async function info(dir) {
  const raw = await runGh(
    ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef,visibility,stargazerCount,forkCount,watchers'],
    dir
  );
  if (raw.error) return raw;
  return {
    repo:          raw.nameWithOwner || '',
    url:           raw.url || '',
    defaultBranch: (raw.defaultBranchRef && raw.defaultBranchRef.name) || 'main',
    visibility:    raw.visibility || '',
    stars:         raw.stargazerCount || 0,
    forks:         raw.forkCount || 0,
    watchers:      (raw.watchers && raw.watchers.totalCount) || 0,
  };
}

/**
 * prs(dir) — open pull requests (up to 20).
 * Returns array of { number, title, state, author, updatedAt, url, isDraft } or { error }.
 */
async function prs(dir) {
  const raw = await runGh(
    ['pr', 'list', '--json', 'number,title,state,author,updatedAt,url,isDraft', '--limit', '20'],
    dir
  );
  if (raw.error) return raw;
  if (!Array.isArray(raw)) return { error: 'unexpected gh output' };
  return raw.map((pr) => ({
    number:    pr.number,
    title:     pr.title || '',
    state:     pr.state || '',
    author:    pr.author && pr.author.login ? pr.author.login : (pr.author || ''),
    updatedAt: pr.updatedAt || '',
    url:       pr.url || '',
    isDraft:   !!pr.isDraft,
  }));
}

/**
 * issues(dir) — open issues (up to 20).
 * Returns array of { number, title, state, author, updatedAt, url } or { error }.
 */
async function issues(dir) {
  const raw = await runGh(
    ['issue', 'list', '--json', 'number,title,state,author,updatedAt,url', '--limit', '20'],
    dir
  );
  if (raw.error) return raw;
  if (!Array.isArray(raw)) return { error: 'unexpected gh output' };
  return raw.map((iss) => ({
    number:    iss.number,
    title:     iss.title || '',
    state:     iss.state || '',
    author:    iss.author && iss.author.login ? iss.author.login : (iss.author || ''),
    updatedAt: iss.updatedAt || '',
    url:       iss.url || '',
  }));
}

/** Run `gh` returning raw stdout text (for commands that don't emit JSON). */
function runGhText(args, cwd) {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ error: String(stderr || err.message || 'gh failed').trim().slice(0, 240) });
      resolve({ text: String(stdout).trim() });
    });
  });
}

/**
 * createPr(dir, { title, body, base }) — open a PR for the current branch.
 * Returns { ok, url } or { error }. Non-interactive (title + body provided).
 */
async function createPr(dir, opts) {
  const title = ((opts && opts.title) || '').trim();
  if (!title) return { error: 'title required' };
  const args = ['pr', 'create', '--title', title, '--body', String((opts && opts.body) || '').slice(0, 4000)];
  if (opts && opts.base) args.push('--base', String(opts.base));
  const r = await runGhText(args, dir);
  if (r.error) return { error: r.error };
  const url = (r.text.match(/https?:\/\/\S+/) || [r.text])[0];
  return { ok: true, url };
}

module.exports = { info, prs, issues, createPr };
