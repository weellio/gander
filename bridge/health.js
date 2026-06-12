'use strict';
// bridge/health.js — sync diagnostics for the Gander health panel.
// CommonJS; zero dependencies (node builtins only).
// Usage: const { report } = require('./health');  const h = report();

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Events the hook install is expected to wire.
const EXPECTED_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
  'Notification',
];

// A command string is considered "Gander" if it references one of these tokens.
function isGanderCmd(cmd) {
  if (typeof cmd !== 'string') return false;
  return /emit\.js|api[/\\]hook|gander/i.test(cmd);
}

// Walk the hooks entry for one event and decide if any command references Gander.
function eventIsWired(hooks) {
  // hooks is the array value for one event key in settings.hooks.
  // Shape: [ { hooks: [ { type, command }, ... ] }, ... ]   or flat variants.
  if (!Array.isArray(hooks)) return false;
  for (const group of hooks) {
    // Each group may be { hooks: [...] } or, in some older formats, { type, command }.
    const items = Array.isArray(group.hooks) ? group.hooks : [group];
    for (const item of items) {
      if (isGanderCmd(item.command)) return true;
    }
  }
  return false;
}

function report() {
  // ── 1. Read ~/.claude/settings.json ──────────────────────────────────────
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let hookResult = {
    installed: false,
    settingsPath,
    events: EXPECTED_EVENTS.map((event) => ({ event, wired: false })),
  };

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw);
    const hooksMap = (settings && typeof settings.hooks === 'object' && settings.hooks) || {};

    const events = EXPECTED_EVENTS.map((event) => {
      const wired = Object.prototype.hasOwnProperty.call(hooksMap, event)
        ? eventIsWired(hooksMap[event])
        : false;
      return { event, wired };
    });

    const installed = events.some((e) => e.wired);

    hookResult = { installed, settingsPath, events };
  } catch (_) {
    // File missing or invalid JSON — leave defaults (installed:false, all false)
  }

  // ── 2. Plugin check ───────────────────────────────────────────────────────
  let plugin = false;
  try {
    // Claude Code stores enabled plugins in settings.json under "enabledPlugins"
    // and may also have a ~/.claude/plugins directory.
    const settingsRaw = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(settingsRaw);

    // Check enabledPlugins keys
    if (settings && settings.enabledPlugins) {
      plugin = Object.keys(settings.enabledPlugins).some((k) =>
        /gander/i.test(k)
      );
    }

    // Also scan ~/.claude/plugins directory (best-effort)
    if (!plugin) {
      const pluginsDir = path.join(os.homedir(), '.claude', 'plugins');
      try {
        const entries = fs.readdirSync(pluginsDir);
        plugin = entries.some((e) => /gander/i.test(e));
      } catch (_) {}
    }

    // Check .claude-plugin directory in cwd for a plugin.json mentioning gander
    if (!plugin) {
      try {
        const localPlugin = path.join(process.cwd(), '.claude-plugin', 'plugin.json');
        const pj = JSON.parse(fs.readFileSync(localPlugin, 'utf8'));
        plugin = /gander/i.test(JSON.stringify(pj));
      } catch (_) {}
    }
  } catch (_) {}

  // ── 3. Environment ────────────────────────────────────────────────────────
  const env = {
    node: process.version,
    platform: process.platform,
  };

  return { hooks: hookResult, plugin, env };
}

module.exports = { report };
