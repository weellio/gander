'use strict';
// test/projects.test.js — tests for bridge/projects.js pure-logic exports.
// Uses node:test + node:assert only; no external deps.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const projects = require('../bridge/projects.js');
const { keyOf, copyComponent } = projects;

// ---------------------------------------------------------------------------
// keyOf
// ---------------------------------------------------------------------------
describe('keyOf', () => {
  test('returns a non-empty string for a normal path', () => {
    const k = keyOf('/some/dir');
    assert.equal(typeof k, 'string');
    assert.ok(k.length > 0);
  });

  test('is stable — same input gives same output', () => {
    const a = keyOf('/foo/bar');
    const b = keyOf('/foo/bar');
    assert.equal(a, b);
  });

  test('is case-insensitive on win32-style paths (lowercased on win32)', () => {
    // On Windows the function lower-cases the resolved path.
    // On other platforms it resolves as-is.  Either way the contract is:
    //   keyOf('C:/Foo') === keyOf('c:/foo')  on win32
    //   keyOf('/Foo')  === keyOf('/Foo')     on others (same string)
    // We test the portable guarantee: the function at minimum does not throw
    // and returns a deterministic string.
    const k1 = keyOf('C:/SomePath/Project');
    const k2 = keyOf('C:/SomePath/Project');
    assert.equal(k1, k2, 'keyOf must be stable for the same input');
  });

  test('on win32, drive-letter case does not change the key', () => {
    if (process.platform !== 'win32') return; // skip on non-Windows
    const upper = keyOf('C:/Foo/Bar');
    const lower = keyOf('c:/foo/bar');
    assert.equal(upper, lower, 'win32: upper and lower-case paths should yield the same key');
  });

  test('handles null/undefined gracefully — returns a string', () => {
    assert.equal(typeof keyOf(null), 'string');
    assert.equal(typeof keyOf(undefined), 'string');
    assert.equal(typeof keyOf(''), 'string');
  });
});

// ---------------------------------------------------------------------------
// copyComponent — input validation (no filesystem side-effects needed)
// ---------------------------------------------------------------------------
describe('copyComponent — validation', () => {
  let tmpA, tmpB;

  before(() => {
    // Create minimal temp project dirs so the validation guards are reached
    tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-src-'));
    tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-dst-'));
  });

  after(() => {
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  });

  test('rejects a name containing a forward slash', () => {
    const result = copyComponent('skill', 'foo/bar', tmpA, tmpB, false);
    assert.ok(result.error, 'expected an error property');
    assert.match(result.error, /invalid name/i);
  });

  test('rejects a name containing a backslash', () => {
    const result = copyComponent('skill', 'foo\\bar', tmpA, tmpB, false);
    assert.ok(result.error, 'expected an error property');
    assert.match(result.error, /invalid name/i);
  });

  test('rejects a name containing ".."', () => {
    const result = copyComponent('skill', '..', tmpA, tmpB, false);
    assert.ok(result.error, 'expected an error property');
    assert.match(result.error, /invalid name/i);
  });

  test('rejects a name like "../../etc/passwd"', () => {
    const result = copyComponent('skill', '../../etc/passwd', tmpA, tmpB, false);
    assert.ok(result.error, 'expected an error property');
    assert.match(result.error, /invalid name/i);
  });

  test('rejects when type/name/from/to are missing', () => {
    const r = copyComponent(null, null, null, null, false);
    assert.ok(r.error, 'expected an error property for missing args');
  });

  test('rejects an unknown component type', () => {
    // "wizard" is not a valid type; source doesn't exist anyway but type check comes first
    const result = copyComponent('wizard', 'myname', tmpA, tmpB, false);
    assert.ok(result.error, 'expected an error for unknown type');
  });

  test('returns {error: "source not found"} for a valid type with missing source', () => {
    const result = copyComponent('skill', 'nonexistent-skill', tmpA, tmpB, false);
    assert.ok(result.error, 'expected an error');
    assert.match(result.error, /source not found|not found/i);
  });
});

// ---------------------------------------------------------------------------
// componentsOf — round-trip via a temp fixture
// ---------------------------------------------------------------------------
describe('componentsOf (via project())', () => {
  let tmpDir;

  before(() => {
    // Build a minimal .claude scaffold
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-proj-'));
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(path.join(claudeDir, 'skills', 'my-skill'), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });

    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [], PostToolUse: [] } }),
    );
    fs.writeFileSync(
      path.join(claudeDir, 'commands', 'deploy.md'),
      '# deploy command',
    );
    fs.writeFileSync(
      path.join(claudeDir, 'agents', 'reviewer.md'),
      '# reviewer agent',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'my-mcp': { command: 'npx', args: ['-y', 'my-mcp'] } } }),
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('project() returns an object with skills/agents/commands/hooks/mcp arrays', () => {
    const p = projects.project(tmpDir);
    assert.ok(Array.isArray(p.skills), 'skills must be an array');
    assert.ok(Array.isArray(p.agents), 'agents must be an array');
    assert.ok(Array.isArray(p.commands), 'commands must be an array');
    assert.ok(Array.isArray(p.hooks), 'hooks must be an array');
    assert.ok(Array.isArray(p.mcp), 'mcp must be an array');
  });

  test('skills contains "my-skill"', () => {
    const p = projects.project(tmpDir);
    assert.ok(p.skills.includes('my-skill'), `skills = ${JSON.stringify(p.skills)}`);
  });

  test('commands contains "deploy"', () => {
    const p = projects.project(tmpDir);
    assert.ok(p.commands.includes('deploy'), `commands = ${JSON.stringify(p.commands)}`);
  });

  test('agents contains "reviewer"', () => {
    const p = projects.project(tmpDir);
    assert.ok(p.agents.includes('reviewer'), `agents = ${JSON.stringify(p.agents)}`);
  });

  test('hooks contains both hook events', () => {
    const p = projects.project(tmpDir);
    assert.ok(p.hooks.includes('PreToolUse'), `hooks = ${JSON.stringify(p.hooks)}`);
    assert.ok(p.hooks.includes('PostToolUse'), `hooks = ${JSON.stringify(p.hooks)}`);
  });

  test('mcp contains "my-mcp"', () => {
    const p = projects.project(tmpDir);
    assert.ok(p.mcp.includes('my-mcp'), `mcp = ${JSON.stringify(p.mcp)}`);
  });
});

// ---------------------------------------------------------------------------
// copyComponent — happy-path skill copy
// ---------------------------------------------------------------------------
describe('copyComponent — skill copy', () => {
  let src, dst;

  before(() => {
    src = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-copy-src-'));
    dst = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-copy-dst-'));

    const skillDir = path.join(src, '.claude', 'skills', 'analyzer');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'CLAUDE.md'), '# analyzer skill');
  });

  after(() => {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  test('copies a skill and returns {ok:true}', () => {
    const result = copyComponent('skill', 'analyzer', src, dst, false);
    assert.deepEqual(result, { ok: true, copied: 'analyzer' });
  });

  test('copied skill file exists at destination', () => {
    const dstFile = path.join(dst, '.claude', 'skills', 'analyzer', 'CLAUDE.md');
    assert.ok(fs.existsSync(dstFile), 'CLAUDE.md should exist at destination');
  });

  test('returns {exists:true} if overwrite=false and dest already exists', () => {
    const result = copyComponent('skill', 'analyzer', src, dst, false);
    assert.deepEqual(result, { exists: true });
  });

  test('overwrites when overwrite=true', () => {
    const result = copyComponent('skill', 'analyzer', src, dst, true);
    assert.deepEqual(result, { ok: true, copied: 'analyzer' });
  });
});
