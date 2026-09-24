'use strict';
// bridge/setupcheck.js — lints the USER'S OWN Claude Code setup.
// CommonJS; zero dependencies (node builtins only).
// Usage: const { scan } = require('./setupcheck');  const s = scan();
//
// This is deliberately NOT bridge/health.js. health.js answers "is Gander
// wired in?" and doctorChecks() in server.js answers "are Gander's own
// integrations reachable?". This module answers a third question nobody was
// asking: "is the user's Claude Code install quietly broken?"
//
// Everything checked here fails SILENTLY in Claude Code. A settings.json with
// a trailing comma is ignored whole — every hook and permission in it is off
// and nothing is printed. An agent .md without frontmatter is simply never
// registered. A hook whose binary is missing runs, fails, and is swallowed:
// the event just does nothing, forever, with no error in any log. The only
// way a user finds out is that a feature they configured months ago never
// happened. So: read their config the way Claude Code reads it, and say so.
//
// Every fs call in here is wrapped. A permission error on one stray file in
// ~/.claude must never take down the whole panel — a diagnostic tool that
// throws is worse than no diagnostic tool.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Limits ────────────────────────────────────────────────────────────────
// A user with a vendored node_modules under ~/.claude (it happens — people
// clone agent repos in there) would otherwise make scan() walk a hundred
// thousand files on every panel refresh. scan() is synchronous and runs on
// the bridge's event loop, so it gets a hard budget.
const MAX_FILES   = 300;              // per category (agents / commands / skills)
const MAX_BYTES   = 512 * 1024;       // never read a file bigger than this
const MAX_DEPTH   = 6;                // directory recursion cap
const SKIP_DIRS   = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '__pycache__']);

// Shell builtins have no file on disk, so a PATH lookup for them always
// fails. Hooks like `echo "done" >> ~/log.txt` are perfectly valid and must
// not be reported as broken.
const _shellBuiltins = new Set([
  'echo', 'cd', 'exit', 'true', 'false', 'set', 'export', 'source', '.', ':',
  'test', 'printf', 'pwd',
]);

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.PS1';

// Status ranking — a group is as bad as its worst check.
const RANK = { off: 0, ok: 1, warn: 2, fail: 3 };
const ORDER = ['off', 'ok', 'warn', 'fail'];
function worst(statuses) {
  let r = 0;
  for (const s of statuses) r = Math.max(r, RANK[s] || 0);
  return ORDER[r];
}

// ── Safe fs wrappers ──────────────────────────────────────────────────────
// Broken symlinks, EPERM on a Windows junction, a file deleted between the
// readdir and the stat: all of these are normal, none of them are fatal.
function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}
function safeStat(p) {
  try { return fs.statSync(p); } catch (_) { return null; }
}
function safeExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}
function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}
function rel(root, file) {
  let r;
  try { r = path.relative(root, file); } catch (_) { r = file; }
  return (r || path.basename(file)).split(path.sep).join('/');
}
function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ── frontmatter ───────────────────────────────────────────────────────────
// A deliberately tiny YAML subset. Claude Code itself only needs `name` and
// `description` off the top of an agent/skill file, and a real YAML parser is
// a dependency this repo does not take. Anything nested is skipped rather
// than rejected: `tools:` with an indented list underneath is valid and must
// not be reported as a broken agent.
function splitFrontmatter(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const lines = src.split('\n');
  const isFence = (l) => l != null && l.replace(/\r$/, '') === '---';

  if (!isFence(lines[0])) return { block: null, body: src, ok: false, error: 'no frontmatter' };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) { end = i; break; }
  }
  if (end === -1) return { block: null, body: src, ok: false, error: 'frontmatter block is never closed (no second `---`)' };

  return {
    block: lines.slice(1, end).map((l) => l.replace(/\r$/, '')),
    body: lines.slice(end + 1).join('\n'),
    ok: true,
    error: null,
  };
}

function stripQuotes(v) {
  const t = v.trim();
  if (t.length >= 2) {
    const a = t[0], b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1);
  }
  return t;
}

function frontmatter(text) {
  const split = splitFrontmatter(text);
  if (!split.ok) return { ok: false, data: null, error: split.error };

  const data = {};
  for (const raw of split.block) {
    if (!raw.trim()) continue;                 // blank
    if (/^\s*#/.test(raw)) continue;           // comment
    if (/^\s/.test(raw)) continue;             // indented → belongs to the previous key
    const i = raw.indexOf(':');
    if (i === -1) return { ok: false, data: null, error: `line is not \`key: value\`: ${clip(raw, 40)}` };
    const key = raw.slice(0, i).trim();
    if (!key) return { ok: false, data: null, error: `empty key: ${clip(raw, 40)}` };
    data[key] = stripQuotes(raw.slice(i + 1));
  }
  return { ok: true, data, error: null };
}

// ── resolveExec ───────────────────────────────────────────────────────────
// Tokenize like a shell would, then decide whether the first token names
// something that actually exists. `platform` and `env` are injectable on
// purpose: the Windows branch (PATHEXT) and the posix branch have completely
// different failure modes, and a test that can only exercise the host OS
// would leave half of this function unverified forever.
function tokenize(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of String(cmd == null ? '' : cmd)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

// `${FOO}`, `$FOO` and `%FOO%` are all things Claude Code (or the shell it
// spawns) expands at run time with values we do not have here. Gander's own
// hooks are all `node "${CLAUDE_PLUGIN_ROOT}/hooks/emit.js"` — reporting those
// as broken would make the whole panel noise, so they resolve to "unknown".
function hasUnexpandedVar(s) {
  return /\$\{/.test(s) || /\$[A-Za-z_][A-Za-z0-9_]*/.test(s) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(s);
}

function execCandidates(exe, platform, env) {
  const list = [exe];
  if (platform === 'win32') {
    const exts = String(env.PATHEXT || DEFAULT_PATHEXT).split(';').map((e) => e.trim()).filter(Boolean);
    const lower = exe.toLowerCase();
    const already = exts.some((e) => lower.endsWith(e.toLowerCase()));
    if (!already) for (const e of exts) list.push(exe + e);
  }
  return list;
}

function resolveExec(cmd, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const text = String(cmd == null ? '' : cmd);

  // `opts.argv0` means the caller is handing us an executable, not a shell
  // line. An MCP server's `command` is argv[0] verbatim: "C:\Program
  // Files\nodejs\node.exe" is ONE path, and tokenizing it on the space would
  // report every user with node in Program Files as having a broken server.
  const tokens = o.argv0 ? [text.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')] : tokenize(text);
  const exe = tokens[0] || '';

  if (!exe) return { ok: false, unknown: false, exe: '', reason: 'empty command' };
  if (hasUnexpandedVar(text)) return { ok: false, unknown: true, exe, reason: 'unexpanded variable' };

  if (_shellBuiltins.has(exe)) return { ok: true, unknown: false, exe, reason: 'shell builtin' };

  const isPathy = exe.includes('/') || exe.includes('\\');
  if (isPathy) {
    for (const c of execCandidates(exe, platform, env)) {
      if (safeExists(c)) return { ok: true, unknown: false, exe, reason: `found: ${c}` };
    }
    return { ok: false, unknown: false, exe, reason: 'no such file' };
  }

  // PATH lookup. The delimiter comes from the INJECTED platform, not from
  // path.delimiter — path.delimiter is the host's, and a test driving the
  // other platform would split a fixture PATH on the wrong character.
  const delim = platform === 'win32' ? ';' : ':';
  const dirs = String(env.PATH || env.Path || '').split(delim).filter(Boolean);
  for (const dir of dirs) {
    const base = dir.replace(/^"|"$/g, '');
    if (!base) continue;
    for (const c of execCandidates(exe, platform, env)) {
      // join with the injected platform's separator semantics; path.join on
      // the host is fine here because we only ever feed it back to fs.
      const full = base.endsWith('/') || base.endsWith('\\') ? base + c : base + (platform === 'win32' ? '\\' : '/') + c;
      // Deliberately existsSync and not an X_OK access() check: on a
      // Windows-mounted or network filesystem the exec bit is meaningless
      // and we would report every working hook as broken.
      if (safeExists(full)) return { ok: true, unknown: false, exe, reason: `found: ${full}` };
    }
  }
  return { ok: false, unknown: false, exe, reason: 'not found on PATH' };
}

// ── walking ───────────────────────────────────────────────────────────────
function walkMd(root, limit) {
  const found = [];
  if (!limit || limit <= 0) return found;
  const st = safeStat(root);
  if (!st || !st.isDirectory()) return found;

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    for (const e of safeReaddir(dir)) {
      if (found.length >= limit) return found;
      const full = path.join(dir, e.name);
      let isDir = false, isFile = false;
      try { isDir = e.isDirectory(); isFile = e.isFile(); } catch (_) { continue; }
      if (isDir) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (isFile && /\.md$/i.test(e.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

// ── scan ──────────────────────────────────────────────────────────────────
function scopeName(dir) {
  try { return path.basename(dir) || dir; } catch (_) { return String(dir); }
}

// Run one group's body behind a net. A thrown error inside a single group
// degrades that group to one warn check instead of blanking the panel.
function group(id, label, build) {
  let checks;
  try {
    checks = build() || [];
  } catch (err) {
    checks = [{
      id: `${id}:error`,
      label: `${label} could not be checked`,
      status: 'warn',
      detail: (err && err.message) || String(err),
    }];
  }
  if (!checks.length) checks = [{ id: `${id}:none`, label: 'Nothing to check', status: 'off', detail: 'none found' }];
  return { id, label, status: worst(checks.map((c) => c.status)), checks };
}

function scan(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const projectDirs = Array.isArray(o.projectDirs) ? o.projectDirs.filter((d) => typeof d === 'string' && d) : [];

  // Every root that can hold a .claude directory, in the order Claude Code
  // itself layers them: global first, then each project.
  const roots = [{ dir: home, scope: 'global' }]
    .concat(projectDirs.map((d) => ({ dir: d, scope: scopeName(d) })));

  // Shared between group 1 and group 6: the hooks group lints the exact same
  // settings files the settings group parsed, so a file that failed to parse
  // is never double-reported as "no hooks".
  const parsedSettings = [];

  const groups = [];

  // ── 1. Settings files ───────────────────────────────────────────────────
  groups.push(group('settings', 'Settings files', () => {
    const checks = [];
    for (const { dir, scope } of roots) {
      for (const name of ['settings.json', 'settings.local.json']) {
        const file = path.join(dir, '.claude', name);
        const label = `${name} (${scope})`;
        const id = `settings:${slug(scope)}:${slug(name)}`;

        if (!safeExists(file)) {
          checks.push({ id, label, status: 'off', detail: 'not present' });
          continue;
        }
        const st = safeStat(file);
        if (st && st.size > MAX_BYTES) {
          checks.push({ id, label, status: 'warn', detail: `${Math.round(st.size / 1024)} KB — too large to parse here` });
          continue;
        }
        const raw = safeRead(file);
        if (raw == null) {
          checks.push({ id, label, status: 'warn', detail: 'cannot be read (permissions?)' });
          continue;
        }
        let data;
        try {
          data = JSON.parse(raw);
        } catch (err) {
          checks.push({
            id, label, status: 'fail',
            detail: `invalid JSON: ${(err && err.message) || String(err)}`,
            hint: 'Claude Code ignores a settings file it cannot parse — every hook and permission in it is silently off.',
          });
          continue;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          checks.push({
            id, label, status: 'fail',
            detail: `top level is ${Array.isArray(data) ? 'an array' : typeof data}, expected an object`,
            hint: 'Claude Code ignores a settings file it cannot parse — every hook and permission in it is silently off.',
          });
          continue;
        }
        parsedSettings.push({ file, label, scope, data });
        checks.push({ id, label, status: 'ok', detail: `${Object.keys(data).length} keys` });
      }
    }
    return checks;
  }));

  // ── 2. Agents ───────────────────────────────────────────────────────────
  groups.push(group('agents', 'Agents', () => {
    const checks = [];
    let budget = MAX_FILES;
    let any = false;

    for (const { dir, scope } of roots) {
      const base = path.join(dir, '.claude', 'agents');
      const files = walkMd(base, budget);
      budget -= files.length;
      if (!files.length) continue;
      any = true;

      for (const file of files) {
        const name = rel(base, file);
        const label = `${name} (${scope})`;
        const id = `agent:${slug(scope)}:${slug(name)}`;
        const stem = path.basename(file).replace(/\.md$/i, '');

        const st = safeStat(file);
        if (st && st.size > MAX_BYTES) {
          checks.push({ id, label, status: 'warn', detail: `${Math.round(st.size / 1024)} KB — skipped, too large to lint` });
          continue;
        }
        const text = safeRead(file);
        if (text == null) {
          checks.push({ id, label, status: 'warn', detail: 'cannot be read (permissions?)' });
          continue;
        }
        const fm = frontmatter(text);
        if (!fm.ok) {
          // A README in the agents folder is documentation, not a broken agent.
          // Claude Code ignores a .md with no frontmatter, and the real install
          // has one, so failing it here is pure noise.
          if (/^readme$/i.test(stem)) {
            checks.push({ id, label, status: 'off', detail: 'documentation, not an agent' });
            continue;
          }
          checks.push({
            id, label, status: 'fail', detail: fm.error,
            hint: 'An agent file without `---` frontmatter is not registered as an agent.',
          });
          continue;
        }
        if (!fm.data.name) {
          checks.push({ id, label, status: 'fail', detail: 'frontmatter has no `name`', hint: 'An agent without a `name` is not registered as an agent.' });
          continue;
        }
        if (!fm.data.description) {
          checks.push({
            id, label, status: 'fail', detail: 'frontmatter has no `description`',
            hint: 'Claude Code picks an agent by reading its description — without one it is never delegated to.',
          });
          continue;
        }
        if (fm.data.name !== stem) {
          checks.push({
            id, label, status: 'warn',
            detail: `name is "${fm.data.name}" but the file is ${stem}.md`,
            hint: 'Not fatal, but you will invoke it by one name and find it under the other.',
          });
          continue;
        }
        checks.push({ id, label, status: 'ok', detail: clip(fm.data.description, 80) });
      }
      if (budget <= 0) {
        checks.push({ id: 'agents:capped', label: 'Scan capped', status: 'warn', detail: `stopped after ${MAX_FILES} files` });
        break;
      }
    }

    if (!any) return [{ id: 'agents:none', label: 'Agents', status: 'off', detail: 'no agents' }];
    return checks;
  }));

  // ── 3. Commands ─────────────────────────────────────────────────────────
  groups.push(group('commands', 'Commands', () => {
    const checks = [];
    let budget = MAX_FILES;
    let any = false;

    for (const { dir, scope } of roots) {
      const base = path.join(dir, '.claude', 'commands');
      const files = walkMd(base, budget);
      budget -= files.length;
      if (!files.length) continue;
      any = true;

      for (const file of files) {
        const name = rel(base, file);
        const label = `${name} (${scope})`;
        const id = `command:${slug(scope)}:${slug(name)}`;

        const st = safeStat(file);
        if (st && st.size > MAX_BYTES) {
          checks.push({ id, label, status: 'warn', detail: `${Math.round(st.size / 1024)} KB — skipped, too large to lint` });
          continue;
        }
        const text = safeRead(file);
        if (text == null) {
          checks.push({ id, label, status: 'warn', detail: 'cannot be read (permissions?)' });
          continue;
        }

        // Frontmatter is optional for a command — but a HALF-written block is
        // worse than none: Claude Code swallows the malformed block and the
        // `description`/`allowed-tools` the user thought they set never apply.
        const split = splitFrontmatter(text);
        if (split.ok) {
          const fm = frontmatter(text);
          if (!fm.ok) {
            checks.push({ id, label, status: 'fail', detail: `frontmatter: ${fm.error}`, hint: 'A command with an unparseable `---` block loses its description and tool allowlist.' });
            continue;
          }
        }

        const body = (split.ok ? split.body : text).trim();
        if (!body) {
          checks.push({ id, label, status: 'warn', detail: 'empty — the command would do nothing' });
          continue;
        }
        const args = body.includes('$ARGUMENTS');
        checks.push({ id, label, status: 'ok', detail: `${body.length} chars${args ? ', uses $ARGUMENTS' : ''}` });
      }
      if (budget <= 0) {
        checks.push({ id: 'commands:capped', label: 'Scan capped', status: 'warn', detail: `stopped after ${MAX_FILES} files` });
        break;
      }
    }

    if (!any) return [{ id: 'commands:none', label: 'Commands', status: 'off', detail: 'no commands' }];
    return checks;
  }));

  // A skill folder is one that holds SKILL.md. A folder that holds none but
  // whose children do is a container, not a broken skill — descend into it.
  // Depth-capped, and a folder we cannot resolve is reported as-is so a genuine
  // missing SKILL.md is never swallowed.
  function expandSkillDirs(dirPath, rel, out, depth) {
    const leaf = rel.split('/').pop();
    if (safeExists(path.join(dirPath, 'SKILL.md')) || depth >= 3) { out.push({ path: dirPath, name: leaf, rel }); return; }
    const kids = safeReaddir(dirPath).filter((e) => { try { return e.isDirectory() && !SKIP_DIRS.has(e.name); } catch (_) { return false; } });
    if (!kids.length) { out.push({ path: dirPath, name: leaf, rel }); return; }
    for (const k of kids) expandSkillDirs(path.join(dirPath, k.name), rel + '/' + k.name, out, depth + 1);
  }

  // ── 4. Skills ───────────────────────────────────────────────────────────
  groups.push(group('skills', 'Skills', () => {
    const checks = [];
    let budget = MAX_FILES;
    let any = false;

    for (const { dir, scope } of roots) {
      const base = path.join(dir, '.claude', 'skills');
      const entries = safeReaddir(base);
      const dirs = entries.filter((e) => { try { return e.isDirectory() && !SKIP_DIRS.has(e.name); } catch (_) { return false; } });
      if (!dirs.length) continue;
      any = true;

      // Not every folder under skills/ is itself a skill. Claude Code's own
      // synced skills land in skills/synced/<bucket-uuid>/<name>/SKILL.md, so a
      // strict one-level rule reported the real install's "synced" folder as a
      // broken skill. expandSkillDirs() walks into a folder that holds no
      // SKILL.md but whose children do. A panel that cries wolf gets ignored.
      const work = [];
      for (const e of dirs) expandSkillDirs(path.join(base, e.name), e.name, work, 0);

      for (const item of work) {
        if (budget-- <= 0) {
          checks.push({ id: 'skills:capped', label: 'Scan capped', status: 'warn', detail: `stopped after ${MAX_FILES} skills` });
          break;
        }
        const label = `${item.name} (${scope})`;
        const id = `skill:${slug(scope)}:${slug(item.rel)}`;
        const file = path.join(item.path, 'SKILL.md');

        if (!safeExists(file)) {
          checks.push({ id, label, status: 'fail', detail: 'no SKILL.md', hint: 'A skill folder without SKILL.md is never loaded.' });
          continue;
        }
        const st = safeStat(file);
        if (st && st.size > MAX_BYTES) {
          checks.push({ id, label, status: 'warn', detail: `SKILL.md is ${Math.round(st.size / 1024)} KB — skipped, too large to lint` });
          continue;
        }
        const text = safeRead(file);
        if (text == null) {
          checks.push({ id, label, status: 'warn', detail: 'SKILL.md cannot be read (permissions?)' });
          continue;
        }
        const fm = frontmatter(text);
        if (!fm.ok) {
          checks.push({ id, label, status: 'fail', detail: `SKILL.md ${fm.error}`, hint: 'A SKILL.md without `---` frontmatter is never loaded.' });
          continue;
        }
        if (!fm.data.name || !fm.data.description) {
          checks.push({
            id, label, status: 'fail',
            detail: `SKILL.md frontmatter has no \`${!fm.data.name ? 'name' : 'description'}\``,
            hint: 'Claude Code needs both `name` and `description` to load a skill and to decide when to use it.',
          });
          continue;
        }
        checks.push({ id, label, status: 'ok', detail: clip(fm.data.description, 80) });
      }
    }

    if (!any) return [{ id: 'skills:none', label: 'Skills', status: 'off', detail: 'no skills' }];
    return checks;
  }));

  // ── 5. MCP servers ──────────────────────────────────────────────────────
  groups.push(group('mcp', 'MCP servers', () => {
    const checks = [];
    const sources = [{ file: path.join(home, '.claude.json'), scope: 'global' }]
      .concat(projectDirs.map((d) => ({ file: path.join(d, '.mcp.json'), scope: scopeName(d) })));

    for (const { file, scope } of sources) {
      // A missing source is not a finding — most projects have no .mcp.json.
      if (!safeExists(file)) continue;
      const st = safeStat(file);
      if (st && st.size > MAX_BYTES) {
        checks.push({ id: `mcp:${slug(scope)}:big`, label: `${path.basename(file)} (${scope})`, status: 'warn', detail: `${Math.round(st.size / 1024)} KB — too large to parse here` });
        continue;
      }
      const raw = safeRead(file);
      if (raw == null) {
        checks.push({ id: `mcp:${slug(scope)}:unreadable`, label: `${path.basename(file)} (${scope})`, status: 'warn', detail: 'cannot be read (permissions?)' });
        continue;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        checks.push({
          id: `mcp:${slug(scope)}:json`, label: `${path.basename(file)} (${scope})`, status: 'fail',
          detail: `invalid JSON: ${(err && err.message) || String(err)}`,
          hint: 'An MCP config that will not parse means every server in it is silently absent.',
        });
        continue;
      }
      const servers = data && typeof data === 'object' && !Array.isArray(data) && data.mcpServers;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;

      for (const [name, cfg] of Object.entries(servers)) {
        const label = `${name} (${scope})`;
        const id = `mcp:${slug(scope)}:${slug(name)}`;
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
          checks.push({ id, label, status: 'fail', detail: 'entry is not an object' });
          continue;
        }
        const hasCommand = typeof cfg.command === 'string' && cfg.command.trim();
        const hasUrl = (typeof cfg.url === 'string' && cfg.url.trim()) || cfg.type === 'http' || cfg.type === 'sse';
        if (!hasCommand && !hasUrl) {
          checks.push({ id, label, status: 'fail', detail: 'no command or url', hint: 'Claude Code cannot start a server that says neither how to launch it nor where to reach it.' });
          continue;
        }
        if (cfg.args !== undefined && !Array.isArray(cfg.args)) {
          checks.push({ id, label, status: 'fail', detail: `\`args\` is ${typeof cfg.args}, expected an array`, hint: '`args` must be an array of strings — a string here is not split into arguments.' });
          continue;
        }
        if (cfg.env !== undefined && (!cfg.env || typeof cfg.env !== 'object' || Array.isArray(cfg.env))) {
          checks.push({ id, label, status: 'fail', detail: `\`env\` is ${Array.isArray(cfg.env) ? 'an array' : typeof cfg.env}, expected an object` });
          continue;
        }
        if (hasCommand) {
          const r = resolveExec(cfg.command, { argv0: true });
          if (r.unknown) {
            checks.push({ id, label, status: 'off', detail: 'uses ${VAR} — not verifiable here' });
            continue;
          }
          if (!r.ok) {
            checks.push({
              id, label, status: 'fail', detail: `executable not found: ${r.exe}`,
              hint: 'Claude Code starts this server silently; if the binary is missing the tools just never appear.',
            });
            continue;
          }
          const first = Array.isArray(cfg.args) && cfg.args.length ? ` ${cfg.args[0]}` : '';
          checks.push({ id, label, status: 'ok', detail: clip(cfg.command + first, 80) });
          continue;
        }
        let host = cfg.url || cfg.type;
        try { if (cfg.url) host = new URL(cfg.url).host || cfg.url; } catch (_) {}
        checks.push({ id, label, status: 'ok', detail: String(host) });
      }
    }

    if (!checks.length) return [{ id: 'mcp:none', label: 'MCP servers', status: 'off', detail: 'no MCP servers configured' }];
    return checks;
  }));

  // ── 6. Hook commands ────────────────────────────────────────────────────
  groups.push(group('hooks', 'Hook commands', () => {
    const checks = [];
    let seq = 0;

    for (const { data, scope } of parsedSettings) {
      const hooks = data.hooks;
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) continue;

      for (const [event, groupsForEvent] of Object.entries(hooks)) {
        const list = Array.isArray(groupsForEvent) ? groupsForEvent : [groupsForEvent];
        for (const g of list) {
          if (!g || typeof g !== 'object') continue;
          // Tolerate the older flat shape where the group IS the hook.
          const items = Array.isArray(g.hooks) ? g.hooks : [g];
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (item.type !== undefined && item.type !== 'command') continue;
            if (typeof item.command !== 'string' || !item.command.trim()) continue;

            const cmd = item.command;
            const label = `${event} — ${clip(cmd.slice(0, 40), 40)}`;
            const id = `hook:${slug(scope)}:${slug(event)}:${seq++}`;

            const r = resolveExec(cmd);
            if (r.unknown) {
              // Gander's own hooks are all `node "${CLAUDE_PLUGIN_ROOT}/..."`.
              // Flagging those as failures would make the panel useless on
              // the very machine it ships on.
              checks.push({ id, label, status: 'off', detail: 'uses ${VAR} — not verifiable here' });
              continue;
            }
            if (!r.ok) {
              checks.push({
                id, label, status: 'fail', detail: `executable not found: ${r.exe}`,
                hint: 'Claude Code runs hooks silently: a missing binary means this event does nothing, with no error anywhere.',
              });
              continue;
            }

            // `node C:\tools\notify.js` with notify.js deleted is the other
            // half of the same silent failure — the binary resolves fine and
            // the hook still does nothing every single time it fires.
            const missing = missingScriptArg(cmd);
            if (missing) {
              checks.push({
                id, label, status: 'fail', detail: `script not found: ${missing}`,
                hint: 'Claude Code runs hooks silently: a missing script means this event does nothing, with no error anywhere.',
              });
              continue;
            }
            checks.push({ id, label, status: 'ok', detail: r.reason });
          }
        }
      }
    }

    if (!checks.length) return [{ id: 'hooks:none', label: 'Hook commands', status: 'off', detail: 'no hooks configured' }];
    return checks;
  }));

  // ── score ───────────────────────────────────────────────────────────────
  let passed = 0, total = 0;
  for (const g of groups) {
    for (const c of g.checks) {
      total++;
      if (c.status === 'ok' || c.status === 'off') passed++;
    }
  }
  const pct = total === 0 ? 100 : Math.round((passed / total) * 100);

  return { score: { passed, total, pct }, groups };
}

// Find the first argument that clearly names a file on disk and is clearly
// missing. Deliberately conservative: anything with a variable in it, any
// flag, and anything without an extension is left alone, because a false
// "script not found" is much more corrosive than a missed one.
function missingScriptArg(cmd) {
  const tokens = tokenize(cmd);
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.startsWith('-')) continue;
    if (t.includes('${') || t.includes('$') || t.includes('%')) continue;
    if (!t.includes('/') && !t.includes('\\')) continue;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(t)) continue;
    if (!safeExists(t)) return t;
  }
  return null;
}

module.exports = { scan, resolveExec, frontmatter, _shellBuiltins };
