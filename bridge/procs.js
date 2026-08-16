'use strict';
// bridge/procs.js — process attribution for the Processes panel + the Office
// floor's robots. Pure logic over a process snapshot (pid/ppid/name/cmd/started/
// ports): walks each process's REAL parent chain (with PID-reuse guards) so a
// process is only "orphan" when its parent is actually gone, and everything
// Claude-related says exactly what it's linked to.

// "interesting" = the kind of thing Claude spawns from Bash and leaves open
const INTERESTING = /^(node|python\d?|pythonw|py|deno|bun|npm|pnpm|yarn|vite|nodemon|next|ts-node|tsx|electron|webpack|esbuild|rollup|jest|vitest|gunicorn|uvicorn|flask|rails|ruby|go|dotnet|java|php|cargo|http-server|serve|ngrok)(\.exe)?$/i;
// a plugin runtime's path, e.g. ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4
const PLUGIN_RE = /[\\/]\.claude[\\/]plugins[\\/](?:cache[\\/])?[^\\/]*[\\/]?([^\\/\s]+)[\\/][\d.]+/i;

const startOf = (p) => (p && p.started ? Date.parse(p.started) || 0 : 0);

// Walk up the parent chain. PID-reuse guard: a "parent" that started AFTER its
// child is a recycled pid — the real parent is dead, so the chain stops there.
function ancestry(p, byPid) {
  const chain = []; const seen = new Set([p.pid]); let cur = p;
  for (let i = 0; i < 25; i++) {
    const par = byPid.get(cur.ppid);
    if (!par || seen.has(par.pid)) break;
    if (startOf(par) > startOf(cur) + 1000) break;   // recycled pid ≠ real parent
    chain.push(par); seen.add(par.pid); cur = par;
  }
  return chain;
}

/**
 * @param all           full process snapshot [{pid,ppid,name,cmd,started,ports}]
 * @param selfPid       the bridge's own pid (never listed)
 * @param sessions      [{sid, project, set:Set<pid>}] — descendants of Gander-launched windows
 * @param knownProjects [{cwd(lower), project, sid}]
 */
function attribute(all, selfPid, sessions, knownProjects) {
  const byPid = new Map(); for (const p of all) byPid.set(p.pid, p);
  const now = Date.now();
  const out = [];
  for (const p of all) {
    if (p.pid === selfPid) continue;
    const name = String(p.name || '');
    const interesting = INTERESTING.test(name);
    let attribution = 'orphan', sid = null, project = null, linked = null, plugin = null, claudePid = null;
    for (const s of sessions) { if (s.set.has(p.pid)) { attribution = 'session'; sid = s.sid; project = s.project; break; } }
    const chain = ancestry(p, byPid);
    const claudeAnc = chain.find((a) => /^claude(\.exe)?$/i.test(String(a.name || '')));
    if (claudeAnc) claudePid = claudeAnc.pid;
    // the raisable WINDOW for a claude-child belongs to the VS Code MAIN process —
    // the chain often hits the windowless extension host first, so keep every
    // Code.exe ancestor (child→root order; the last one is the main process)
    const codePids = chain.filter((a) => /^code(\.exe)?$/i.test(String(a.name || ''))).map((a) => a.pid);
    // the plugin path shows in the launcher's cmdline, not its children's —
    // so check the whole ancestor chain, not just the process itself
    let pluginHit = null;
    for (const q of [p, ...chain]) { pluginHit = String(q.cmd || '').match(PLUGIN_RE); if (pluginHit) break; }
    // Name the project when the machine TRULY knows it: a known project path in
    // the cmdline (self or ancestors). Window titles are deliberately NOT used —
    // VS Code is Electron, so one main process carries a single MainWindowTitle
    // that reflects whichever window is FOCUSED; matching on it confidently
    // labels every parked session with the project you happen to be looking at.
    const resolveProject = () => {
      for (const q of [p, ...chain]) {
        const cmd = String(q.cmd || '').toLowerCase();
        const hit = knownProjects.find((k) => k.cwd && cmd.includes(k.cwd));
        if (hit) return hit.project;
      }
      return null;
    };
    if (attribution !== 'session') {
      if (pluginHit) {
        attribution = 'plugin'; plugin = pluginHit[1];
        project = resolveProject();
        linked = (claudeAnc ? `plugin of claude.exe ${claudeAnc.pid}` : 'Claude plugin runtime') + (project ? ` · ${project}` : '');
      } else if (claudeAnc) {
        attribution = 'claude';
        const viaCode = chain.some((a) => /^code(\.exe)?$/i.test(String(a.name || '')));
        project = resolveProject();
        linked = `child of claude.exe ${claudeAnc.pid}${viaCode ? ' (VS Code)' : ''}${project ? ` · ${project}` : ''}`;
      } else if (interesting) {
        const cmd = String(p.cmd || '').toLowerCase();
        const hit = knownProjects.find((k) => k.cwd && cmd.includes(k.cwd));
        if (hit) { attribution = 'project'; sid = hit.sid; project = hit.project; }
      }
    }
    if (attribution === 'orphan') {
      const par = byPid.get(p.ppid);
      const parentAlive = par && startOf(par) <= startOf(p) + 1000;
      if (parentAlive) { attribution = 'other'; linked = `child of ${par.name} ${par.pid} — not Claude-spawned`; }
    }
    // drop system/service noise: a non-interesting process only shows if it's
    // provably tied to Claude (session descendant or plugin runtime).
    if (!interesting && attribution !== 'session' && attribution !== 'plugin') continue;
    // PowerShell's ConvertTo-Json unwraps a single-element array to a scalar and
    // an empty one to {} — coerce both back to a clean array.
    const ports = Array.isArray(p.ports) ? p.ports : (p.ports != null && typeof p.ports !== 'object' ? [p.ports] : []);
    out.push({
      pid: p.pid, name, cmd: p.cmd, ports,
      started: p.started, uptimeMs: p.started ? Math.max(0, now - Date.parse(p.started)) : null,
      attribution, sessionId: sid, project, linked, plugin, claudePid, codePids,
    });
  }
  out.sort((a, b) => (b.ports.length - a.ports.length) || ((b.uptimeMs || 0) - (a.uptimeMs || 0)));
  return out;
}

// Slim rows for the /api/state snapshot (the floor's robots) — no cmd payload.
function compact(list) {
  return list.map((p) => ({
    pid: p.pid, name: p.name, ports: p.ports, uptimeMs: p.uptimeMs,
    attribution: p.attribution, sessionId: p.sessionId, project: p.project,
    linked: p.linked, plugin: p.plugin, claudePid: p.claudePid, codePids: p.codePids,
  }));
}

module.exports = { attribute, compact, ancestry, INTERESTING, PLUGIN_RE };
