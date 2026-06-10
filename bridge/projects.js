// Hivemind — Claude project registry + component manager.
//
// Knows every Claude project (from configured root folders + auto-imported from
// running sessions + the global ~/.claude), lists each one's components
// (skills / agents / commands / hooks / mcp), and copies a component between
// projects. Config persists to bridge/aoc-projects.json.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG = path.join(__dirname, 'aoc-projects.json');
let cfg = (() => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (_) { return {}; } })();
cfg.roots = cfg.roots || [];
cfg.known = cfg.known || [];
function persist() { try { fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2)); } catch (_) {} }

// Case-insensitive identity key for a path (Windows paths differ only by drive-letter case).
function keyOf(p) { try { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; } catch (_) { return String(p || ''); } }

function getConfig() { return cfg; }
function addRoot(p) { p = String(p || '').trim(); if (p && !cfg.roots.includes(p)) { cfg.roots.push(p); persist(); } return cfg; }
function removeRoot(p) { cfg.roots = cfg.roots.filter((r) => r !== p); persist(); return cfg; }
function noteKnown(cwd) {
  if (!cwd) return;
  const k = keyOf(cwd);
  if (!cfg.known.some((x) => keyOf(x) === k)) { cfg.known.push(cwd); persist(); }
}

function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return []; } }
function hasClaude(dir) {
  try { return fs.existsSync(path.join(dir, '.claude')) || fs.existsSync(path.join(dir, '.claude-plugin')); } catch (_) { return false; }
}

// Read components from a given .claude directory.
function componentsOf(claudeDir, projectDir) {
  const out = { skills: [], agents: [], commands: [], hooks: [], mcp: [] };
  for (const d of listDir(path.join(claudeDir, 'skills'))) if (d.isDirectory()) out.skills.push(d.name);
  for (const f of listDir(path.join(claudeDir, 'commands'))) if (f.isFile() && f.name.endsWith('.md')) out.commands.push(f.name.replace(/\.md$/, ''));
  for (const f of listDir(path.join(claudeDir, 'agents'))) if (f.isFile() && f.name.endsWith('.md')) out.agents.push(f.name.replace(/\.md$/, ''));
  try { const s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')); if (s.hooks) out.hooks = Object.keys(s.hooks); } catch (_) {}
  try { const m = JSON.parse(fs.readFileSync(path.join(projectDir || claudeDir, '.mcp.json'), 'utf8')); if (m.mcpServers) out.mcp = Object.keys(m.mcpServers); } catch (_) {}
  return out;
}

function project(dir) {
  const p = path.resolve(dir);
  return { path: p, name: path.basename(p) || p, sources: [], running: false, ...componentsOf(path.join(p, '.claude'), p) };
}

function discover() {
  const seen = new Map(); // resolved path -> project
  const add = (dir, source, requireClaude) => {
    let rp; try { rp = path.resolve(dir); } catch (_) { return; }
    const k = keyOf(rp);
    if (seen.has(k)) { if (source) seen.get(k).sources.push(source); return; }
    if (requireClaude && !hasClaude(rp)) return;
    const pr = project(rp);
    if (source) pr.sources.push(source);
    seen.set(k, pr);
  };

  // Global ~/.claude as a first-class entry.
  const home = os.homedir();
  const globalClaude = path.join(home, '.claude');
  if (fs.existsSync(globalClaude)) {
    // path = home so copyComponent(home) targets <home>/.claude (= ~/.claude)
    seen.set('__global__', { path: home, name: 'Global (user)', sources: ['global'], running: false, ...componentsOf(globalClaude, home) });
  }

  // Configured roots: the root itself, and its immediate children that look like projects.
  for (const root of cfg.roots) {
    add(root, 'root', true);
    for (const d of listDir(root)) if (d.isDirectory()) add(path.join(root, d.name), 'root', true);
  }
  // Auto-imported session cwds (kept even without local .claude — they're live projects).
  for (const k of cfg.known) add(k, 'session', false);

  return Array.from(seen.values());
}

function copyHook(fromDir, toDir, event, overwrite) {
  try {
    const src = JSON.parse(fs.readFileSync(path.join(fromDir, '.claude', 'settings.json'), 'utf8'));
    if (!src.hooks || !src.hooks[event]) return { error: 'source hook not found' };
    const tp = path.join(toDir, '.claude', 'settings.json');
    let tgt = {}; try { tgt = JSON.parse(fs.readFileSync(tp, 'utf8')); } catch (_) {}
    tgt.hooks = tgt.hooks || {};
    if (tgt.hooks[event] && !overwrite) return { exists: true };
    tgt.hooks[event] = src.hooks[event];
    fs.mkdirSync(path.dirname(tp), { recursive: true });
    fs.writeFileSync(tp, JSON.stringify(tgt, null, 2) + '\n');
    return { ok: true, copied: event };
  } catch (e) { return { error: e.message }; }
}

function copyMcp(fromDir, toDir, name, overwrite) {
  try {
    const src = JSON.parse(fs.readFileSync(path.join(fromDir, '.mcp.json'), 'utf8'));
    if (!src.mcpServers || !src.mcpServers[name]) return { error: 'source MCP server not found' };
    const tp = path.join(toDir, '.mcp.json');
    let tgt = {}; try { tgt = JSON.parse(fs.readFileSync(tp, 'utf8')); } catch (_) {}
    tgt.mcpServers = tgt.mcpServers || {};
    if (tgt.mcpServers[name] && !overwrite) return { exists: true };
    tgt.mcpServers[name] = src.mcpServers[name];
    fs.writeFileSync(tp, JSON.stringify(tgt, null, 2) + '\n');
    return { ok: true, copied: name };
  } catch (e) { return { error: e.message }; }
}

function copyComponent(type, name, fromDir, toDir, overwrite) {
  if (!type || !name || !fromDir || !toDir) return { error: 'type, name, fromCwd, toCwd required' };
  if (/[\\/]/.test(name) || name.includes('..')) return { error: 'invalid name' };
  if (type === 'hook') return copyHook(fromDir, toDir, name, overwrite);
  if (type === 'mcp') return copyMcp(fromDir, toDir, name, overwrite);
  const rel = type === 'skill' ? ['skills', name]
    : type === 'agent' ? ['agents', name + '.md']
    : type === 'command' ? ['commands', name + '.md'] : null;
  if (!rel) return { error: 'unknown type' };
  const src = path.join(fromDir, '.claude', ...rel);
  const dst = path.join(toDir, '.claude', ...rel);
  if (!fs.existsSync(src)) return { error: 'source not found' };
  if (fs.existsSync(dst) && !overwrite) return { exists: true };
  try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.cpSync(src, dst, { recursive: true }); return { ok: true, copied: name }; }
  catch (e) { return { error: e.message }; }
}

// ── diff: show how the target would change before an overwrite copy ──
function lineDiff(aText, bText) {
  const a = String(aText).split('\n'), b = String(bText).split('\n');
  const n = a.length, m = b.length;
  if (n > 800 || m > 800) return null; // too big for an O(n*m) diff
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', text: a[i] }); i++; }
    else { out.push({ t: '+', text: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', text: a[i++] });
  while (j < m) out.push({ t: '+', text: b[j++] });
  return out;
}
function capLines(lines) {
  if (!lines) return { lines: null, note: 'File too large to diff — review manually before overwriting.' };
  if (lines.length > 400) return { lines: lines.slice(0, 400), note: `… ${lines.length - 400} more lines` };
  return { lines };
}
function readEntry(dir, type, name) {
  try {
    if (type === 'hook') { const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')); const v = s.hooks && s.hooks[name]; return v ? { found: true, text: JSON.stringify(v, null, 2) } : { found: false, text: '' }; }
    const m = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')); const v = m.mcpServers && m.mcpServers[name]; return v ? { found: true, text: JSON.stringify(v, null, 2) } : { found: false, text: '' };
  } catch (_) { return { found: false, text: '' }; }
}
function diffComponent(type, name, fromDir, toDir) {
  if (!type || !name || /[\\/]/.test(name) || name.includes('..')) return { error: 'invalid' };
  if (type === 'hook' || type === 'mcp') {
    const tgt = readEntry(toDir, type, name);
    if (!tgt.found) return { exists: false };
    const src = readEntry(fromDir, type, name);
    return { exists: true, kind: type, ...capLines(lineDiff(tgt.text, src.text)) };
  }
  if (type === 'skill') {
    const dst = path.join(toDir, '.claude', 'skills', name);
    return fs.existsSync(dst) ? { exists: true, kind: 'skill', note: 'Skill folder already exists — it will be replaced.' } : { exists: false };
  }
  const rel = type === 'agent' ? ['agents', name + '.md'] : type === 'command' ? ['commands', name + '.md'] : null;
  if (!rel) return { error: 'unknown type' };
  const dst = path.join(toDir, '.claude', ...rel);
  if (!fs.existsSync(dst)) return { exists: false };
  let a = '', b = '';
  try { a = fs.readFileSync(dst, 'utf8'); } catch (_) {}
  try { b = fs.readFileSync(path.join(fromDir, '.claude', ...rel), 'utf8'); } catch (_) {}
  return { exists: true, kind: type, ...capLines(lineDiff(a, b)) };
}

// ── read / edit a component's underlying file(s) ──
function readComponent(type, name, dir) {
  if (!type || !name || /[\\/]/.test(name) || name.includes('..')) return { error: 'invalid' };
  if (type === 'hook' || type === 'mcp') {
    try {
      const fp = type === 'hook' ? path.join(dir, '.claude', 'settings.json') : path.join(dir, '.mcp.json');
      const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const v = type === 'hook' ? (obj.hooks && obj.hooks[name]) : (obj.mcpServers && obj.mcpServers[name]);
      if (v === undefined) return { error: 'not found' };
      return { ok: true, type, name, path: fp, lang: 'json', readonly: true, content: JSON.stringify(v, null, 2) };
    } catch (e) { return { error: e.message }; }
  }
  if (type === 'skill') {
    const folder = path.join(dir, '.claude', 'skills', name);
    let files = [];
    try { files = fs.readdirSync(folder).filter((f) => { try { return fs.statSync(path.join(folder, f)).isFile(); } catch (_) { return false; } }); } catch (_) { return { error: 'not found' }; }
    let f = path.join(folder, 'SKILL.md');
    if (!fs.existsSync(f)) { const md = files.find((x) => /\.md$/i.test(x)); if (md) f = path.join(folder, md); else return { error: 'no readable file' }; }
    try { return { ok: true, type, name, path: f, lang: 'markdown', readonly: false, content: fs.readFileSync(f, 'utf8'), files }; } catch (e) { return { error: e.message }; }
  }
  const rel = type === 'agent' ? ['agents', name + '.md'] : type === 'command' ? ['commands', name + '.md'] : null;
  if (!rel) return { error: 'unknown type' };
  const fp = path.join(dir, '.claude', ...rel);
  try { return { ok: true, type, name, path: fp, lang: 'markdown', readonly: false, content: fs.readFileSync(fp, 'utf8') }; } catch (e) { return { error: 'not found' }; }
}

function writeComponent(dir, filePath, content) {
  const root = path.resolve(path.join(dir, '.claude'));
  let fp; try { fp = path.resolve(filePath || ''); } catch (_) { return { error: 'bad path' }; }
  if (!(fp === root || fp.startsWith(root + path.sep))) return { error: 'path outside project .claude' };
  if (!/\.(md|txt)$/i.test(fp)) return { error: 'only .md/.txt are editable here' };
  try { fs.writeFileSync(fp, String(content == null ? '' : content)); return { ok: true, path: fp }; } catch (e) { return { error: e.message }; }
}

// ── create a new component (agent / skill / command) from form fields ──────────
function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}
// Quote a YAML scalar safely so a stray quote/colon can't break the front matter
// (the classic "unclosed quote" footgun) — single line, escaped.
function yamlStr(s) {
  return '"' + String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim() + '"';
}

function buildComponentMd(type, f) {
  const slug = slugify(f.name);
  const fm = ['---'];
  if (type === 'agent' || type === 'skill') {
    fm.push(`name: ${slug}`);
    fm.push(`description: ${yamlStr(f.description)}`);
  }
  if (type === 'agent') {
    if (f.tools && String(f.tools).trim()) fm.push(`tools: ${String(f.tools).trim()}`);
    if (f.model && f.model !== 'inherit') fm.push(`model: ${String(f.model).trim()}`);
    if (f.color && String(f.color).trim()) fm.push(`color: ${String(f.color).trim()}`);
  }
  if (type === 'command') {
    if (f.description) fm.push(`description: ${yamlStr(f.description)}`);
    if (f.argumentHint) fm.push(`argument-hint: ${yamlStr(f.argumentHint)}`);
  }
  // commands with nothing to declare get no front matter — just the body
  const hasFm = fm.length > 1;
  const body = (f.body && f.body.trim()) ? f.body.trim() + '\n' : defaultBody(type, f);
  if (!hasFm && type === 'command') return body;
  fm.push('---', '');
  return fm.join('\n') + body;
}
function defaultBody(type, f) {
  const name = f.name || 'this component';
  if (type === 'agent') return `You are ${name}.\n\nWhen invoked:\n1. Understand the request and gather only the context you need.\n2. Do the work.\n3. Return a concise report to the main session — it never sees your full context, so summarize.\n`;
  if (type === 'skill') return `# ${name}\n\nWhen this skill is invoked:\n\n1. Step one.\n2. Step two.\n3. Step three.\n`;
  return `${f.description || ('Run ' + name + '.')}\n\n$ARGUMENTS\n`;
}

// Lightweight front-matter validator — catches the common footguns from the wild:
// unclosed quotes, missing/weak/bloated descriptions, odd model names.
function validateFrontMatter(content) {
  const errors = [], warnings = [];
  const m = /^---\n([\s\S]*?)\n---/.exec(String(content || ''));
  if (!m) { return { ok: true, errors, warnings: ['No YAML front matter — fine for a plain command, but agents/skills need name + description to be discoverable.'] }; }
  const keys = {};
  for (const ln of m[1].split('\n')) {
    if (!ln.trim()) continue;
    const mm = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(ln);
    if (!mm) { warnings.push(`Front-matter line isn't "key: value" → ${ln.trim()}`); continue; }
    keys[mm[1]] = mm[2];
    const dq = (mm[2].match(/(?<!\\)"/g) || []).length;
    if (dq % 2 !== 0) errors.push(`Unclosed quote in "${mm[1]}" — this breaks the whole front matter.`);
  }
  const desc = (keys.description || '').replace(/^["']|["']$/g, '').trim();
  if (!desc) warnings.push('No description — without it the agent/skill won\'t auto-trigger (it misfires).');
  else if (desc.length < 15) warnings.push('Description is very short — say WHEN to use it (e.g. "use proactively when…") so it triggers reliably.');
  else if (desc.length > 400) warnings.push('Description is long — front matter is read every turn; keep it tight (progressive disclosure).');
  if (keys.model && !/^(opus|sonnet|haiku|inherit|claude-)/i.test(keys.model.trim())) warnings.push(`Unusual model "${keys.model.trim()}" — expected opus / sonnet / haiku / inherit or a model id.`);
  return { ok: errors.length === 0, errors, warnings };
}

// Create a new component file under <dir>/.claude. Returns { ok, path, slug, warnings }
// or { exists } / { error }. dir is a project path (or os.homedir() for global).
function newComponent(opts) {
  const o = opts || {};
  const type = o.type;
  if (!['agent', 'skill', 'command'].includes(type)) return { error: 'type must be agent | skill | command' };
  if (!o.dir) return { error: 'target dir required' };
  const slug = slugify(o.name);
  if (!slug) return { error: 'a name is required' };
  if (type !== 'command' && !String(o.description || '').trim()) return { error: 'a description is required for agents and skills' };

  const rel = type === 'skill' ? ['skills', slug, 'SKILL.md']
    : type === 'agent' ? ['agents', slug + '.md']
    : ['commands', slug + '.md'];
  const base = path.resolve(path.join(o.dir, '.claude'));
  const fp = path.resolve(path.join(base, ...rel));
  if (!(fp === base || fp.startsWith(base + path.sep))) return { error: 'resolved path is outside .claude' };
  if (fs.existsSync(fp) && !o.overwrite) return { exists: true, path: fp };

  const content = buildComponentMd(type, o);
  const v = validateFrontMatter(content);
  try { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, content); }
  catch (e) { return { error: e.message }; }
  return { ok: true, path: fp, slug, warnings: v.warnings, content };
}

module.exports = { getConfig, addRoot, removeRoot, noteKnown, discover, project, copyComponent, keyOf, diffComponent, readComponent, writeComponent, newComponent, validateFrontMatter };
