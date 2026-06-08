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
    ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef,visibility'],
    dir
  );
  if (raw.error) return raw;
  return {
    repo:          raw.nameWithOwner || '',
    url:           raw.url || '',
    defaultBranch: (raw.defaultBranchRef && raw.defaultBranchRef.name) || 'main',
    visibility:    raw.visibility || '',
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

module.exports = { info, prs, issues };
