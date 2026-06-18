// Gander — per-project config manager (CommonJS, zero deps).
//
// Reads .claude/settings.json (hooks) and .mcp.json (MCP servers) from a
// project directory; can safely delete a single hook event or MCP server entry.
//
// API:
//   read(dir) → { ok, settingsRaw, hooks:[{event,count,commands}], mcp:[{name,command,args,envKeys}], hasSettings, hasMcp }
//   del(dir, kind, name) → { ok:true } | { error }
//     kind: 'hook' | 'mcp'

'use strict';

const fs   = require('fs');
const path = require('path');

// ── helpers ──────────────────────────────────────────────────────────────────

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return null; }
}

function safeParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function validateName(name) {
  if (!name || typeof name !== 'string') return 'name required';
  if (/[\\/]/.test(name) || name.includes('..')) return 'invalid name';
  // reject prototype-pollution keys (this name is used as an object key + a file path)
  if (['__proto__', 'prototype', 'constructor'].includes(name)) return 'invalid name';
  return null;
}

// Flatten the command strings out of a hooks event value.
// hooks[event] is an array of matcher groups:
//   [ { matcher?: '...', hooks: [ { type:'command', command:'...', ... }, ... ] }, ... ]
function flattenCommands(groups) {
  if (!Array.isArray(groups)) return [];
  const cmds = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const inner = Array.isArray(group.hooks) ? group.hooks : [];
    for (const h of inner) {
      if (h && h.command) cmds.push(String(h.command));
    }
  }
  return cmds;
}

// ── read ─────────────────────────────────────────────────────────────────────

function read(dir) {
  dir = String(dir || '');

  // ---- settings.json ----
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  const settingsText = safeRead(settingsPath);
  const settingsObj  = safeParse(settingsText);
  const hasSettings  = settingsText !== null;
  const settingsRaw  = hasSettings ? JSON.stringify(settingsObj ?? {}, null, 2) : '';

  const hooks = [];
  if (settingsObj && settingsObj.hooks && typeof settingsObj.hooks === 'object') {
    for (const [event, groups] of Object.entries(settingsObj.hooks)) {
      const commands = flattenCommands(groups);
      hooks.push({ event, count: Array.isArray(groups) ? groups.length : 0, commands });
    }
  }

  // ---- .mcp.json ----
  const mcpPath = path.join(dir, '.mcp.json');
  const mcpText = safeRead(mcpPath);
  const mcpObj  = safeParse(mcpText);
  const hasMcp  = mcpText !== null;

  const mcp = [];
  if (mcpObj && mcpObj.mcpServers && typeof mcpObj.mcpServers === 'object') {
    for (const [name, srv] of Object.entries(mcpObj.mcpServers)) {
      mcp.push({
        name,
        command: srv.command || '',
        args:    Array.isArray(srv.args) ? srv.args : [],
        envKeys: Object.keys(srv.env || {}),
      });
    }
  }

  return { ok: true, settingsRaw, hooks, mcp, hasSettings, hasMcp };
}

// ── del ──────────────────────────────────────────────────────────────────────

function del(dir, kind, name) {
  dir = String(dir || '');

  const nameErr = validateName(name);
  if (nameErr) return { error: nameErr };

  if (kind === 'hook') {
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const text = safeRead(settingsPath);
    if (text === null) return { error: 'not found' };
    const obj = safeParse(text);
    if (!obj) return { error: 'could not parse settings.json' };
    if (!obj.hooks || !Object.prototype.hasOwnProperty.call(obj.hooks, name)) return { error: 'not found' };
    delete obj.hooks[name];
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    } catch (e) {
      return { error: 'write failed: ' + e.message };
    }
    return { ok: true };
  }

  if (kind === 'mcp') {
    const mcpPath = path.join(dir, '.mcp.json');
    const text = safeRead(mcpPath);
    if (text === null) return { error: 'not found' };
    const obj = safeParse(text);
    if (!obj) return { error: 'could not parse .mcp.json' };
    if (!obj.mcpServers || !Object.prototype.hasOwnProperty.call(obj.mcpServers, name)) return { error: 'not found' };
    delete obj.mcpServers[name];
    try {
      fs.writeFileSync(mcpPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    } catch (e) {
      return { error: 'write failed: ' + e.message };
    }
    return { ok: true };
  }

  return { error: 'kind must be hook or mcp' };
}

// ── addMcp ───────────────────────────────────────────────────────────────────
// Add (or overwrite) an MCP server entry in <dir>/.mcp.json.
//   server: { name, command, args?, env? }   args is a space-separated string or array.
function addMcp(dir, server) {
  const name = (server && server.name || '').trim();
  const nameErr = validateName(name);
  if (nameErr) return { error: nameErr };
  const command = (server && server.command || '').trim();
  if (!command) return { error: 'command required' };
  try {
    const mcpPath = path.join(dir, '.mcp.json');
    let obj = {};
    const raw = safeRead(mcpPath);
    if (raw) { try { obj = JSON.parse(raw); } catch (_) { obj = {}; } }
    obj.mcpServers = obj.mcpServers || {};
    const entry = { command };
    if (server.args) entry.args = Array.isArray(server.args) ? server.args : String(server.args).split(/\s+/).filter(Boolean);
    if (server.env && typeof server.env === 'object') entry.env = server.env;
    obj.mcpServers[name] = entry;
    fs.writeFileSync(mcpPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

module.exports = { read, del, addMcp };
