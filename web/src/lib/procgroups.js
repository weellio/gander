// Shared server-room grouping for background processes — used by the Office
// floor (canvas robots) and the Mosaic view's server-room strip, so the two
// views can never disagree about the triage verdicts.

export const TONE_COL = { close: '#10B981', work: '#06B6D4', dim: '#8b93a2', warn: '#F59E0B' };
const TONE_ORD = { close: 0, work: 1, dim: 2, warn: 3 };

export function fmtUp(ms) {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

// Group processes by owner and stamp a verdict on each group:
//   claude.exe cluster, sidecars only, parked >24h → "safe to close" (green)
//   claude.exe cluster with real children           → "has live work" (cyan)
//   young sidecar-only cluster                      → neutral (likely the window in use)
//   project leftovers whose tile clocked out        → keep their project name
//   no owner at all                                 → orphaned (amber, careful)
export function buildClusters(procs) {
  const byKey = new Map();
  for (const p of procs || []) {
    const key = p.claudePid ? 'c' + p.claudePid
      : p.attribution === 'orphan' ? 'orphan'
      : (p.attribution === 'session' || p.attribution === 'project') && p.project ? 'proj:' + p.project
      : 'other';
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  const clusters = [];
  for (const [key, bots] of byKey) {
    bots.sort((a, b) => a.pid - b.pid);
    if (key[0] === 'c' && key !== 'other') {
      const pid = bots[0].claudePid;
      const work = bots.filter((b) => b.attribution !== 'plugin');
      const up = Math.max(...bots.map((b) => b.uptimeMs || 0));
      const days = Math.floor(up / 86400e3);
      clusters.push({
        key, claudePid: pid, bots,
        title: `claude.exe ${pid}`, sub: `Claude session · up ~${fmtUp(up)}`,
        verdict: work.length
          ? 'has live work: ' + work.map((b) => b.name.replace(/\.exe$/i, '') + (b.ports?.[0] ? ' :' + b.ports[0] : '')).join(', ')
          : (up > 86400e3 ? `parked ~${days}d — only plugin sidecars · safe to close` : 'only plugin sidecars — exits with its window'),
        tone: work.length ? 'work' : (up > 86400e3 ? 'close' : 'dim'),
      });
    } else if (key.startsWith('proj:')) {
      clusters.push({
        key, bots, title: key.slice(5), sub: 'left running by a Claude session',
        verdict: bots.map((b) => b.name.replace(/\.exe$/i, '') + (b.ports?.[0] ? ' :' + b.ports[0] : '')).join(', '),
        tone: 'work',
      });
    } else if (key === 'other') {
      clusters.push({ key, bots, title: 'NOT CLAUDE-SPAWNED', sub: '', verdict: 'listed for their ports only', tone: 'dim' });
    } else {
      clusters.push({ key, bots, title: 'ORPHANED', sub: 'no owning session', verdict: 'may still be a service you rely on — kill only what you recognize', tone: 'warn' });
    }
  }
  clusters.sort((a, b) => (TONE_ORD[a.tone] ?? 9) - (TONE_ORD[b.tone] ?? 9) || (a.claudePid || 0) - (b.claudePid || 0));
  return clusters;
}
