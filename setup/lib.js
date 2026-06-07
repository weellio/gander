// Hivemind — install/uninstall core.
//
// Computes its own absolute paths (no hardcoding) and merges the Hivemind hooks
// into a Claude Code settings.json, idempotently and without clobbering other
// hooks. Pure Node so it runs the same on Windows/macOS/Linux.

const fs = require('fs');
const path = require('path');
const os = require('os');

// repo root = parent of this setup/ dir
const ROOT = path.resolve(__dirname, '..');
const fwd = (p) => p.replace(/\\/g, '/');

// The hooks Hivemind installs. emit.js forwards events (and carries the command
// return channel); launch.js starts the bridge + opens the dashboard once.
function buildHooks() {
  const r = fwd(ROOT);
  const emit = () => ({ type: 'command', command: `node "${r}/hooks/emit.js"`, timeout: 5 });
  const evt = () => ({ hooks: [emit()] });
  const evtAll = () => ({ matcher: '*', hooks: [emit()] });
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: `node "${r}/bridge/launch.js"`, async: true, timeout: 10, statusMessage: 'Starting Hivemind' }] }],
    UserPromptSubmit: [evt()],
    PreToolUse: [evtAll()],
    PostToolUse: [evtAll()],
    PostToolUseFailure: [evtAll()],
    SubagentStart: [evt()],
    SubagentStop: [evt()],
    Stop: [evt()],
    SessionEnd: [evt()],
  };
}

// A hook group is "ours" if any of its commands points at this repo's emit/launch.
function isOurs(group) {
  const r = fwd(ROOT);
  return ((group && group.hooks) || []).some(
    (h) => typeof h.command === 'string' && h.command.includes(r) && /(emit|launch)\.js/.test(h.command)
  );
}

function settingsPath(opts) {
  if (process.env.HIVEMIND_SETTINGS) return process.env.HIVEMIND_SETTINGS;
  const base = opts.project ? process.cwd() : os.homedir();
  return path.join(base, '.claude', 'settings.json');
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function backup(p) {
  if (fs.existsSync(p)) { try { fs.copyFileSync(p, p + '.hivemind-bak'); } catch (_) {} }
}

function install(opts) {
  const sp = settingsPath(opts);
  const settings = readJson(sp) || {};
  if (readJson(sp) === null && fs.existsSync(sp)) {
    console.error(`! ${sp} exists but isn't valid JSON — fix it first; aborting.`);
    process.exitCode = 1;
    return;
  }
  settings.hooks = settings.hooks || {};
  const ours = buildHooks();
  for (const [event, groups] of Object.entries(ours)) {
    const kept = (settings.hooks[event] || []).filter((g) => !isOurs(g)); // drop prior Hivemind entries (idempotent)
    settings.hooks[event] = kept.concat(groups);
  }
  if (opts.dryRun) {
    console.log(`[dry-run] would update ${sp} with hooks:`);
    console.log(JSON.stringify(settings.hooks, null, 2));
    return;
  }
  backup(sp);
  writeJson(sp, settings);
  console.log(`✓ Installed Hivemind hooks into ${sp}`);
  console.log(`  scope: ${opts.project ? 'this project' : 'global (all sessions on this machine)'}`);
}

function uninstall(opts) {
  const sp = settingsPath(opts);
  const settings = readJson(sp);
  if (!settings || !settings.hooks) { console.log(`Nothing to remove at ${sp}`); return; }
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const kept = settings.hooks[event].filter((g) => { const o = isOurs(g); if (o) removed++; return !o; });
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (opts.dryRun) { console.log(`[dry-run] would remove ${removed} Hivemind hook group(s) from ${sp}`); return; }
  backup(sp);
  writeJson(sp, settings);
  console.log(`✓ Removed ${removed} Hivemind hook group(s) from ${sp}`);
}

module.exports = { install, uninstall, settingsPath, ROOT };
