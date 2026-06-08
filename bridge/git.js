// Hivemind — lightweight git status for project dirs (source-control awareness).
// Zero deps; shells out to `git`. Never throws — returns { isRepo:false } on any trouble.

const { execFile } = require('child_process');

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

module.exports = { status, statusMany };
