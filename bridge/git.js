// Gander — lightweight git status for project dirs (source-control awareness)
// + worktree isolation for the task queue. Zero deps; shells out to `git`.
// Never throws — returns { isRepo:false } / { error } on any trouble.

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');

function run(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: 6000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

async function status(dir) {
  const inside = await run(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return { isRepo: false };
  const [branch, porcelain, remote, counts, last] = await Promise.all([
    run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(dir, ['status', '--porcelain']),
    run(dir, ['remote', 'get-url', 'origin']),
    run(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    run(dir, ['log', '-1', '--format=%cr|%s']),
  ]);
  const dirty = porcelain ? porcelain.split('\n').filter((l) => l.trim()).length : 0;
  let ahead = 0, behind = 0;
  if (counts) { const m = counts.trim().split(/\s+/); behind = +m[0] || 0; ahead = +m[1] || 0; }
  let lastWhen = null, lastMsg = null;
  if (last) { const i = last.indexOf('|'); lastWhen = last.slice(0, i).trim(); lastMsg = last.slice(i + 1).trim(); }
  return {
    isRepo: true,
    branch: branch ? branch.trim() : '?',
    dirty,
    ahead,
    behind,
    remote: remote ? remote.trim() : null,
    lastWhen,
    lastMsg,
  };
}

async function statusMany(dirs) {
  const out = {};
  await Promise.all((dirs || []).map(async (d) => { try { out[d] = await status(d); } catch (_) { out[d] = { isRepo: false }; } }));
  return out;
}

// ── worktree isolation for the task queue ────────────────────────────────────
// Munder-Difflin-inspired "single-committer" design: each queue task gets its
// own worktree + branch (sessions can run in the SAME project in parallel
// without fighting over the tree), and only the BRIDGE ever merges back into
// the main tree — sessions never touch it. Sync (execFileSync) because the
// queue scheduler is synchronous; every git op here is sub-second.
function gitSync(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { timeout: 20000, windowsHide: true, maxBuffer: 4 << 20 }).toString();
}
function shortErr(e) {
  const s = String((e && (e.stderr || e.stdout || e.message)) || e).trim();
  return s.split('\n')[0].slice(0, 160);
}

// Create a worktree + branch for queue task `id`. The worktree lives as a
// SIBLING folder (`<repo>__wt<id>`) so it never pollutes the repo's status.
function worktreeStart(cwd, id) {
  try {
    const inside = gitSync(cwd, ['rev-parse', '--is-inside-work-tree']).trim();
    if (inside !== 'true') return { error: 'not a git repo' };
    const branch = `gander/task-${id}`;
    const wtPath = String(cwd).replace(/[\\/]+$/, '') + `__wt${id}`;
    try {
      gitSync(cwd, ['worktree', 'add', '-b', branch, wtPath]);
    } catch (e) {
      // stale leftovers from a crashed run (path or branch already exist) —
      // clear them and retry once
      try { gitSync(cwd, ['worktree', 'remove', '--force', wtPath]); } catch (_) {}
      try { gitSync(cwd, ['worktree', 'prune']); } catch (_) {}
      try { gitSync(cwd, ['branch', '-D', branch]); } catch (_) {}
      gitSync(cwd, ['worktree', 'add', '-b', branch, wtPath]);
    }
    return { ok: true, wtPath, branch };
  } catch (e) { return { error: shortErr(e) }; }
}

// Finish a worktree task: commit any leftovers the session didn't commit (so
// nothing is ever lost), merge the branch into the main tree when it's clean,
// and clean up. Returns a human-readable merge status string.
function worktreeFinish(cwd, wtPath, branch, label) {
  const removeWt = () => {
    try { gitSync(cwd, ['worktree', 'remove', '--force', wtPath]); } catch (_) {}
    try { gitSync(cwd, ['worktree', 'prune']); } catch (_) {}
    // on Windows `worktree remove` silently fails while the task's session still
    // has the folder as its cwd — retry at the filesystem level (best effort;
    // a survivor is cleared by the stale-leftover path on the next start)
    try { if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch (_) {}
  };
  try {
    // 1) preserve uncommitted work inside the worktree
    try {
      const dirty = gitSync(wtPath, ['status', '--porcelain']).trim();
      if (dirty) { gitSync(wtPath, ['add', '-A']); gitSync(wtPath, ['commit', '-m', `queue task leftovers: ${label || branch}`]); }
    } catch (_) {}
    // 2) branch identical to main tree? nothing to merge — clean up silently
    try {
      const ahead = gitSync(cwd, ['rev-list', '--count', `HEAD..${branch}`]).trim();
      if (ahead === '0') { removeWt(); try { gitSync(cwd, ['branch', '-d', branch]); } catch (_) {} return 'no changes'; }
    } catch (_) {}
    // 3) only the bridge merges, and only into a CLEAN main tree
    const mainDirty = gitSync(cwd, ['status', '--porcelain']).trim();
    if (mainDirty) { removeWt(); return `branch ${branch} kept — main tree has uncommitted changes, merge when ready`; }
    try {
      gitSync(cwd, ['merge', '--no-ff', branch, '-m', `merge queue task: ${label || branch}`]);
    } catch (e) {
      try { gitSync(cwd, ['merge', '--abort']); } catch (_) {}
      removeWt();
      return `CONFLICT — branch ${branch} kept, merge manually`;
    }
    removeWt();
    try { gitSync(cwd, ['branch', '-d', branch]); } catch (_) {}
    return 'merged';
  } catch (e) { removeWt(); return `merge error: ${shortErr(e)} — branch ${branch} kept`; }
}

module.exports = { status, statusMany, worktreeStart, worktreeFinish };
