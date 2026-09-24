'use strict';
// test/setupcheck.test.js — tests for bridge/setupcheck.js
//
// Everything here runs against a throwaway home built under os.tmpdir().
// The real ~/.claude is never read and never written: this module's whole job
// is to lint a user's live config, and a test that touched it could just as
// easily report on (or damage) the developer's own machine.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const setupcheck = require('../bridge/setupcheck.js');
const { scan, resolveExec, frontmatter, _shellBuiltins } = setupcheck;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
const TEMPS = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-setup-'));
  TEMPS.push(d);
  return d;
}
function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}
function json(file, obj) {
  return write(file, JSON.stringify(obj, null, 2));
}

after(() => {
  for (const d of TEMPS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

// Lookups into the scan() result.
const groupOf = (r, id) => r.groups.find((g) => g.id === id);
const checksOf = (r, id) => (groupOf(r, id) || { checks: [] }).checks;
const statuses = (r, id) => checksOf(r, id).map((c) => c.status);
const anyFail = (r) => r.groups.some((g) => g.checks.some((c) => c.status === 'fail'));

// A home that should lint completely clean: valid settings, a well-formed
// agent, command and skill, an MCP server pointing at a binary that really
// exists (this node), and hooks that either resolve or are honestly unknown.
function cleanHome() {
  const home = tmp();
  json(path.join(home, '.claude', 'settings.json'), {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo started' }] }],
      PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/emit.js"' }] }],
    },
  });
  write(path.join(home, '.claude', 'agents', 'foo.md'), '---\nname: foo\ndescription: Does the foo thing.\n---\n\nYou are foo.\n');
  write(path.join(home, '.claude', 'commands', 'bar.md'), '---\ndescription: bar it\n---\n\nDo bar with $ARGUMENTS.\n');
  write(path.join(home, '.claude', 'skills', 'baz', 'SKILL.md'), '---\nname: baz\ndescription: Bazzes things.\n---\n\nHow to baz.\n');
  json(path.join(home, '.claude.json'), {
    mcpServers: { local: { command: process.execPath, args: ['server.js'], env: { FOO: 'bar' } } },
  });
  return home;
}

// ---------------------------------------------------------------------------
// Exported surface
// ---------------------------------------------------------------------------
describe('setupcheck exports', () => {
  test('exports scan, resolveExec, frontmatter and the builtin list', () => {
    assert.equal(typeof scan, 'function');
    assert.equal(typeof resolveExec, 'function');
    assert.equal(typeof frontmatter, 'function');
    assert.ok(_shellBuiltins.has('echo'), 'echo is a known shell builtin');
    assert.ok(_shellBuiltins.has(':'), ': is a known shell builtin');
  });
});

// ---------------------------------------------------------------------------
// 1. Clean setup
// ---------------------------------------------------------------------------
describe('scan — clean setup', () => {
  test('a well-formed home scores 100% with no failures', () => {
    const r = scan({ home: cleanHome() });
    assert.equal(anyFail(r), false, 'no check fails on a clean home:\n' + JSON.stringify(r, null, 2));
    assert.equal(r.score.pct, 100);
    assert.equal(r.score.passed, r.score.total);
    assert.ok(r.score.total > 0, 'something was actually checked');
  });

  test('groups come back in the documented order with a worst-of status', () => {
    const r = scan({ home: cleanHome() });
    assert.deepEqual(r.groups.map((g) => g.id), ['settings', 'agents', 'commands', 'skills', 'mcp', 'hooks']);
    for (const g of r.groups) {
      const rank = { off: 0, ok: 1, warn: 2, fail: 3 };
      const w = g.checks.reduce((m, c) => Math.max(m, rank[c.status]), 0);
      assert.equal(rank[g.status], w, `${g.id} status is the worst of its checks`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 + 16. Settings files
// ---------------------------------------------------------------------------
describe('scan — settings files', () => {
  test('malformed settings.json fails and drags the score below 100', () => {
    const home = cleanHome();
    write(path.join(home, '.claude', 'settings.json'), '{ "hooks": { , }');
    const r = scan({ home });
    const bad = checksOf(r, 'settings').find((c) => c.status === 'fail');
    assert.ok(bad, 'the broken settings file is reported as a failure');
    assert.match(bad.detail, /invalid JSON/i);
    assert.match(bad.hint, /silently off/);
    assert.equal(groupOf(r, 'settings').status, 'fail');
    assert.ok(r.score.pct < 100, 'the score reflects it');
  });

  test('a settings file whose top level is an array fails', () => {
    const home = tmp();
    json(path.join(home, '.claude', 'settings.json'), [{ hooks: {} }]);
    const r = scan({ home });
    const bad = checksOf(r, 'settings').find((c) => c.status === 'fail');
    assert.ok(bad, 'an array top level is a failure');
    assert.match(bad.detail, /array/i);
  });

  test('a missing settings file is off, not a failure', () => {
    const r = scan({ home: tmp() });
    assert.deepEqual(new Set(statuses(r, 'settings')), new Set(['off']));
    assert.equal(checksOf(r, 'settings')[0].detail, 'not present');
  });

  test('project settings files are labelled by project name', () => {
    const home = tmp();
    const proj = tmp();
    json(path.join(proj, '.claude', 'settings.json'), { permissions: { allow: [] } });
    const r = scan({ home, projectDirs: [proj] });
    const labels = checksOf(r, 'settings').map((c) => c.label);
    assert.ok(labels.includes('settings.json (global)'), labels.join(', '));
    assert.ok(labels.some((l) => l === `settings.json (${path.basename(proj)})`), labels.join(', '));
  });
});

// ---------------------------------------------------------------------------
// 3 + 4 + 5. Agents
// ---------------------------------------------------------------------------
describe('scan — agents', () => {
  test('an agent file with no frontmatter fails', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'agents', 'ghost.md'), 'You are a helpful agent.\n');
    const r = scan({ home });
    const c = checksOf(r, 'agents')[0];
    assert.equal(c.status, 'fail');
    assert.match(c.hint, /not registered as an agent/);
  });

  test('an agent missing `description` fails', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'agents', 'nodesc.md'), '---\nname: nodesc\n---\n\nbody\n');
    const r = scan({ home });
    const c = checksOf(r, 'agents')[0];
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /description/);
  });

  test('an agent missing `name` fails', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'agents', 'noname.md'), '---\ndescription: something\n---\n\nbody\n');
    const r = scan({ home });
    assert.equal(checksOf(r, 'agents')[0].status, 'fail');
  });

  test('a name that disagrees with the filename warns, it does not fail', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'agents', 'onfile.md'), '---\nname: in-frontmatter\ndescription: mismatched\n---\n\nbody\n');
    const r = scan({ home });
    const c = checksOf(r, 'agents')[0];
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /in-frontmatter/);
    assert.match(c.detail, /onfile\.md/);
  });

  test('agents are found recursively and an empty dir reports off', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'agents', 'team', 'deep.md'), '---\nname: deep\ndescription: nested agent\n---\n\nbody\n');
    const r = scan({ home });
    assert.equal(checksOf(r, 'agents').length, 1);
    assert.equal(checksOf(r, 'agents')[0].status, 'ok');

    const empty = scan({ home: tmp() });
    assert.equal(checksOf(empty, 'agents')[0].status, 'off');
    assert.equal(checksOf(empty, 'agents')[0].detail, 'no agents');
  });
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
describe('scan — commands', () => {
  test('frontmatter is optional but an empty body warns', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'commands', 'plain.md'), 'Just do the thing.\n');
    write(path.join(home, '.claude', 'commands', 'blank.md'), '---\ndescription: nothing\n---\n\n   \n');
    const r = scan({ home });
    const byLabel = Object.fromEntries(checksOf(r, 'commands').map((c) => [c.label.split(' ')[0], c]));
    assert.equal(byLabel['plain.md'].status, 'ok');
    assert.equal(byLabel['blank.md'].status, 'warn');
    assert.match(byLabel['blank.md'].detail, /do nothing/);
  });

  test('a present-but-unparseable frontmatter block fails, and $ARGUMENTS is noted', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'commands', 'broken.md'), '---\nthis line has no colon\n---\n\nbody\n');
    write(path.join(home, '.claude', 'commands', 'args.md'), 'Run with $ARGUMENTS please.\n');
    const r = scan({ home });
    const byLabel = Object.fromEntries(checksOf(r, 'commands').map((c) => [c.label.split(' ')[0], c]));
    assert.equal(byLabel['broken.md'].status, 'fail');
    assert.equal(byLabel['args.md'].status, 'ok');
    assert.match(byLabel['args.md'].detail, /\$ARGUMENTS/);
  });
});

// ---------------------------------------------------------------------------
// 6. Skills
// ---------------------------------------------------------------------------
describe('scan — skills', () => {
  test('a skill folder with no SKILL.md fails', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'orphan'), { recursive: true });
    write(path.join(home, '.claude', 'skills', 'orphan', 'README.md'), '# not a skill\n');
    const r = scan({ home });
    const c = checksOf(r, 'skills')[0];
    assert.equal(c.status, 'fail');
    assert.equal(c.detail, 'no SKILL.md');
    assert.match(c.hint, /never loaded/);
  });

  test('a SKILL.md without a description fails', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'skills', 'half', 'SKILL.md'), '---\nname: half\n---\n\nbody\n');
    const r = scan({ home });
    assert.equal(checksOf(r, 'skills')[0].status, 'fail');
    assert.match(checksOf(r, 'skills')[0].detail, /description/);
  });
});

// ---------------------------------------------------------------------------
// 7 + 8. MCP servers
// ---------------------------------------------------------------------------
describe('scan — MCP servers', () => {
  test('a server with neither command nor url fails', () => {
    const home = tmp();
    const proj = tmp();
    json(path.join(proj, '.mcp.json'), { mcpServers: { broken: { args: ['x'] } } });
    const r = scan({ home, projectDirs: [proj] });
    const c = checksOf(r, 'mcp')[0];
    assert.equal(c.status, 'fail');
    assert.equal(c.detail, 'no command or url');
  });

  test('a non-array `args` fails', () => {
    const home = tmp();
    const proj = tmp();
    json(path.join(proj, '.mcp.json'), { mcpServers: { s: { command: process.execPath, args: '-y thing' } } });
    const r = scan({ home, projectDirs: [proj] });
    const c = checksOf(r, 'mcp')[0];
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /args/);
  });

  test('a non-object `env` fails and an http server passes on its host', () => {
    const home = tmp();
    const proj = tmp();
    json(path.join(proj, '.mcp.json'), {
      mcpServers: {
        badenv: { command: process.execPath, env: ['A=1'] },
        remote: { type: 'http', url: 'https://mcp.example.com/v1' },
      },
    });
    const r = scan({ home, projectDirs: [proj] });
    const by = Object.fromEntries(checksOf(r, 'mcp').map((c) => [c.label.split(' ')[0], c]));
    assert.equal(by.badenv.status, 'fail');
    assert.match(by.badenv.detail, /env/);
    assert.equal(by.remote.status, 'ok');
    assert.equal(by.remote.detail, 'mcp.example.com');
  });

  test('a server whose binary does not exist fails with a hint', () => {
    const home = tmp();
    json(path.join(home, '.claude.json'), { mcpServers: { gone: { command: 'definitely-not-installed-gander-xyz' } } });
    const r = scan({ home });
    const c = checksOf(r, 'mcp')[0];
    assert.equal(c.status, 'fail');
    assert.match(c.hint, /tools just never appear/);
  });

  test('no MCP source anywhere reports a single off check', () => {
    const r = scan({ home: tmp(), projectDirs: [tmp()] });
    assert.equal(checksOf(r, 'mcp').length, 1);
    assert.equal(checksOf(r, 'mcp')[0].status, 'off');
    assert.equal(checksOf(r, 'mcp')[0].detail, 'no MCP servers configured');
  });
});

// ---------------------------------------------------------------------------
// 9 + 10 + 11. Hook commands
// ---------------------------------------------------------------------------
describe('scan — hook commands', () => {
  test('a hook pointing at a missing binary fails', () => {
    const home = tmp();
    json(path.join(home, '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'definitely-not-a-real-binary-gander-xyz --go' }] }] },
    });
    const r = scan({ home });
    const c = checksOf(r, 'hooks')[0];
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /definitely-not-a-real-binary-gander-xyz/);
    assert.match(c.hint, /no error anywhere/);
    assert.match(c.label, /^Stop — /);
  });

  test('${CLAUDE_PLUGIN_ROOT} is off, not fail — Gander\'s own hooks all use it', () => {
    const home = tmp();
    json(path.join(home, '.claude', 'settings.json'), {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/launch.js"', timeout: 10 }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "%USERPROFILE%\\\\hooks\\\\emit.js"' }] }],
      },
    });
    const r = scan({ home });
    assert.deepEqual(new Set(statuses(r, 'hooks')), new Set(['off']));
    assert.equal(groupOf(r, 'hooks').status, 'off');
    assert.equal(checksOf(r, 'hooks')[0].detail, 'uses ${VAR} — not verifiable here');
    assert.equal(anyFail(r), false);
  });

  test('a resolvable binary with a missing script argument still fails, naming the path', () => {
    const home = tmp();
    const missing = path.join(home, 'nope', 'missing-script.js');
    json(path.join(home, '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${missing}"` }] }] },
    });
    const r = scan({ home });
    const c = checksOf(r, 'hooks')[0];
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /^script not found: /);
    assert.ok(c.detail.includes('missing-script.js'), c.detail);
  });

  test('a script argument that exists passes', () => {
    const home = tmp();
    const script = write(path.join(home, 'hooks', 'real.js'), '// noop\n');
    json(path.join(home, '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${script}"` }] }] },
    });
    const r = scan({ home });
    assert.equal(checksOf(r, 'hooks')[0].status, 'ok');
  });

  test('the flat { type, command } group shape is tolerated', () => {
    const home = tmp();
    json(path.join(home, '.claude', 'settings.json'), {
      hooks: { Notification: [{ type: 'command', command: 'echo hi' }] },
    });
    const r = scan({ home });
    assert.equal(checksOf(r, 'hooks').length, 1);
    assert.equal(checksOf(r, 'hooks')[0].status, 'ok');
  });

  test('a settings file that never parsed contributes no hook checks', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'settings.json'), '{ nope');
    const r = scan({ home });
    assert.equal(checksOf(r, 'hooks')[0].status, 'off');
    assert.equal(checksOf(r, 'hooks')[0].detail, 'no hooks configured');
  });
});

// ---------------------------------------------------------------------------
// 12 + 13. resolveExec, both platforms
// ---------------------------------------------------------------------------
describe('resolveExec', () => {
  test('win32: PATHEXT finds `foo` for a file named foo.cmd', () => {
    const dir = tmp();
    write(path.join(dir, 'foo.cmd'), '@echo off\n');
    const r = resolveExec('foo --flag', { platform: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.unknown, false);
    assert.equal(r.exe, 'foo');
    // PATHEXT entries are conventionally upper case and Windows' filesystem
    // does not care, so match without regard to case.
    assert.match(r.reason, /foo\.cmd$/i);
  });

  test('win32: PATHEXT defaults when the env does not set it', () => {
    const dir = tmp();
    write(path.join(dir, 'tool.ps1'), '# noop\n');
    const r = resolveExec('tool', { platform: 'win32', env: { PATH: dir } });
    assert.equal(r.ok, true, r.reason);
  });

  test('posix: does NOT append .exe — win32 on the same file does', () => {
    const dir = tmp();
    write(path.join(dir, 'foo.exe'), 'x');
    const bare = path.join(dir, 'foo');

    const posix = resolveExec(bare, { platform: 'linux', env: { PATH: '' } });
    assert.equal(posix.ok, false, 'foo must not resolve to foo.exe on posix');
    assert.equal(posix.unknown, false);
    assert.equal(posix.reason, 'no such file');

    const win = resolveExec(bare, { platform: 'win32', env: { PATH: '', PATHEXT: '.EXE' } });
    assert.equal(win.ok, true, win.reason);
    assert.match(win.reason, /foo\.exe$/i);

    // The posix PATH branch reports the posix-shaped reason, not a win32 one.
    const onPath = resolveExec('foo', { platform: 'linux', env: { PATH: '/no/such/bin:/also/missing' } });
    assert.equal(onPath.ok, false);
    assert.equal(onPath.reason, 'not found on PATH');
  });

  test('shell builtins resolve without touching the filesystem', () => {
    const r = resolveExec('echo hello world', { platform: 'linux', env: { PATH: '' } });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'shell builtin');
  });

  test('unexpanded variables report unknown, never a failure', () => {
    for (const cmd of ['node "${CLAUDE_PLUGIN_ROOT}/x.js"', 'node "$HOME/x.js"', '%USERPROFILE%\\x.exe']) {
      const r = resolveExec(cmd, { platform: 'win32', env: { PATH: '' } });
      assert.equal(r.unknown, true, cmd);
      assert.equal(r.ok, false, cmd);
      assert.equal(r.reason, 'unexpanded variable');
    }
  });

  test('an explicit path is checked directly, quotes and all', () => {
    const dir = tmp();
    const exe = write(path.join(dir, 'my tool.sh'), '#!/bin/sh\n');
    const hit = resolveExec(`"${exe}" --go`, { platform: 'linux', env: { PATH: '' } });
    assert.equal(hit.ok, true, hit.reason);
    const miss = resolveExec(`"${path.join(dir, 'absent.sh')}"`, { platform: 'linux', env: { PATH: '' } });
    assert.equal(miss.ok, false);
    assert.equal(miss.reason, 'no such file');
  });

  test('argv0 mode does not split an executable path on its spaces', () => {
    const dir = tmp();
    const exe = write(path.join(dir, 'Program Files', 'tool.exe'), 'x');
    // As a shell line this is two tokens and the first one does not exist.
    assert.equal(resolveExec(exe, { platform: 'win32', env: { PATH: '' } }).ok, false);
    // As argv[0] — which is what an MCP server's `command` is — it is one path.
    assert.equal(resolveExec(exe, { platform: 'win32', env: { PATH: '' }, argv0: true }).ok, true);
  });

  test('an empty command is a failure, not a throw', () => {
    assert.equal(resolveExec('').ok, false);
    assert.equal(resolveExec(null).ok, false);
    assert.equal(resolveExec(undefined).ok, false);
  });
});

// ---------------------------------------------------------------------------
// 14. frontmatter
// ---------------------------------------------------------------------------
describe('frontmatter', () => {
  test('parses quoted values and ignores indented continuation lines', () => {
    const fm = frontmatter([
      '---',
      'name: "my agent"',
      "description: 'does a thing'",
      '# a comment',
      'tools:',
      '  - Read',
      '  - Write',
      '',
      'model: sonnet',
      '---',
      '',
      'Body text.',
    ].join('\n'));
    assert.equal(fm.ok, true, fm.error);
    assert.equal(fm.data.name, 'my agent');
    assert.equal(fm.data.description, 'does a thing');
    assert.equal(fm.data.model, 'sonnet');
    assert.equal(fm.data.tools, '');
    assert.equal(fm.data['- Read'], undefined, 'indented list items are not keys');
  });

  test('no block at all returns the `no frontmatter` error', () => {
    const fm = frontmatter('Just a body.\n');
    assert.deepEqual(fm, { ok: false, data: null, error: 'no frontmatter' });
  });

  test('a BOM and CRLF line endings still parse', () => {
    const fm = frontmatter('﻿---\r\nname: crlf\r\ndescription: windows\r\n---\r\nbody\r\n');
    assert.equal(fm.ok, true, fm.error);
    assert.equal(fm.data.name, 'crlf');
    assert.equal(fm.data.description, 'windows');
  });

  test('an unterminated block and a colon-less line are both errors', () => {
    assert.equal(frontmatter('---\nname: x\n').ok, false);
    const bad = frontmatter('---\njust some words\n---\nbody\n');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /key: value/);
  });
});

// ---------------------------------------------------------------------------
// 15. Robustness
// ---------------------------------------------------------------------------
describe('scan — robustness', () => {
  test('a completely empty home does not throw: every group off, 100%', () => {
    const r = scan({ home: tmp() });
    assert.deepEqual(r.groups.map((g) => g.status), ['off', 'off', 'off', 'off', 'off', 'off']);
    assert.equal(r.score.pct, 100);
    assert.equal(r.score.passed, r.score.total);
  });

  test('a home that does not exist at all still returns a shaped result', () => {
    const r = scan({ home: path.join(tmp(), 'does', 'not', 'exist') });
    assert.equal(typeof r.score.pct, 'number');
    assert.equal(r.groups.length, 6);
    for (const g of r.groups) assert.ok(g.checks.length >= 1, `${g.id} always has at least one check`);
  });

  // `home` is always injected, never omitted: scan() with no opts would read
  // the developer's real ~/.claude, and a test suite has no business linting
  // (or being slowed down by) the machine it happens to run on.
  test('bad opts are tolerated', () => {
    for (const opts of [{ home: tmp() }, { home: tmp(), projectDirs: null }, { home: tmp(), projectDirs: [null, '', 7] }]) {
      const r = scan(opts);
      assert.equal(r.groups.length, 6);
      assert.ok(Number.isFinite(r.score.pct));
    }
  });

  test('node_modules under .claude is not walked', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'agents', 'real.md'), '---\nname: real\ndescription: yes\n---\n\nbody\n');
    write(path.join(home, '.claude', 'agents', 'node_modules', 'pkg', 'README.md'), 'not an agent\n');
    const r = scan({ home });
    assert.equal(checksOf(r, 'agents').length, 1, 'only the real agent is linted');
  });

  test('an oversized agent file warns instead of being read', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'agents', 'huge.md'), 'x'.repeat(520 * 1024));
    const r = scan({ home });
    const c = checksOf(r, 'agents')[0];
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /too large/);
  });
});

// ---------------------------------------------------------------------------
// Regressions found by running the scanner against a REAL ~/.claude.
// Both of these were reported as problems on a perfectly healthy install, and
// a panel that cries wolf is a panel nobody reads.
// ---------------------------------------------------------------------------
describe('false positives found on a real install', () => {
  test('a synced-skill bucket is a container, not a skill with no SKILL.md', () => {
    // Claude Code syncs skills to skills/synced/<bucket-uuid>/<name>/SKILL.md.
    // A strict one-level rule called "synced" a broken skill.
    const home = tmp();
    const bucket = path.join(home, '.claude', 'skills', 'synced', 'b1b2-uuid');
    write(path.join(bucket, 'docx', 'SKILL.md'), '---\nname: docx\ndescription: Word files.\n---\nbody\n');
    write(path.join(bucket, 'import-memory', 'SKILL.md'), '---\nname: import-memory\ndescription: Memory.\n---\nbody\n');

    const r = scan({ home });
    const skills = checksOf(r, 'skills');
    assert.equal(skills.filter((c) => c.status === 'fail').length, 0,
      'nested synced skills must not be reported as broken: ' + JSON.stringify(skills));
    const names = skills.map((c) => c.label);
    assert.ok(names.some((n) => n.startsWith('docx')), 'expected the nested docx skill: ' + names.join(', '));
    assert.ok(names.some((n) => n.startsWith('import-memory')), 'expected the nested import-memory skill: ' + names.join(', '));
    assert.ok(!names.some((n) => n.startsWith('synced')), 'the container itself must not be a check: ' + names.join(', '));
  });

  test('a skill folder that genuinely has no SKILL.md anywhere still fails', () => {
    // The container carve-out must not swallow the real fault it was hiding.
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'broken'), { recursive: true });
    write(path.join(home, '.claude', 'skills', 'broken', 'notes.md'), 'no skill here');

    const r = scan({ home });
    const bad = checksOf(r, 'skills').filter((c) => c.status === 'fail');
    assert.equal(bad.length, 1);
    assert.match(bad[0].detail, /no SKILL\.md/);
  });

  test('README.md in the agents folder is documentation, not a broken agent', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'agents', 'README.md'), '# The roster\n\nHow these agents fit together.\n');
    write(path.join(home, '.claude', 'agents', 'real.md'), '---\nname: real\ndescription: A real agent.\n---\nbody\n');

    const r = scan({ home });
    const agents = checksOf(r, 'agents');
    const readme = agents.find((c) => c.label.startsWith('README.md'));
    assert.ok(readme, 'README.md should still appear: ' + agents.map((c) => c.label).join(', '));
    assert.equal(readme.status, 'off');
    assert.equal(agents.filter((c) => c.status === 'fail').length, 0);
    assert.equal(r.score.pct, 100, 'a README must not cost the install its score');
  });

  test('a non-README agent with no frontmatter still fails', () => {
    const home = tmp();
    write(path.join(home, '.claude', 'agents', 'oops.md'), '# no frontmatter here\n');
    const r = scan({ home });
    const bad = checksOf(r, 'agents').filter((c) => c.status === 'fail');
    assert.equal(bad.length, 1);
    assert.ok(bad[0].label.startsWith('oops.md'));
  });
});
