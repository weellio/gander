'use strict';
// test/configmgr.test.js — tests for bridge/configmgr.js

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const configmgr = require('../bridge/configmgr.js');

// ---------------------------------------------------------------------------
// Exported surface
// ---------------------------------------------------------------------------
describe('configmgr exports', () => {
  test('exports read and del functions', () => {
    assert.equal(typeof configmgr.read, 'function', 'read must be exported');
    assert.equal(typeof configmgr.del,  'function', 'del must be exported');
  });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
function makeTmpProject(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-cfg-'));

  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] },
      ],
      PostToolUse: [
        { hooks: [{ type: 'command', command: 'echo post' }] },
      ],
    },
  };
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));

  const mcp = {
    mcpServers: {
      'test-server': { command: 'npx', args: ['-y', 'test-server'], env: { FOO: 'bar' } },
      'another':     { command: 'node', args: ['server.js'] },
    },
  };
  fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcp, null, 2));

  return tmpDir;
}

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------
describe('configmgr.read()', () => {
  let tmpDir;

  before(() => { tmpDir = makeTmpProject(); });
  after(()  => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns ok:true', () => {
    const r = configmgr.read(tmpDir);
    assert.equal(r.ok, true, 'read() should return ok:true');
  });

  test('hasSettings is true when settings.json exists', () => {
    const r = configmgr.read(tmpDir);
    assert.equal(r.hasSettings, true);
  });

  test('hasMcp is true when .mcp.json exists', () => {
    const r = configmgr.read(tmpDir);
    assert.equal(r.hasMcp, true);
  });

  test('hooks array contains both hook events', () => {
    const r = configmgr.read(tmpDir);
    assert.ok(Array.isArray(r.hooks), 'hooks must be an array');
    const events = r.hooks.map((h) => h.event);
    assert.ok(events.includes('PreToolUse'),  `hooks should include PreToolUse, got: ${JSON.stringify(events)}`);
    assert.ok(events.includes('PostToolUse'), `hooks should include PostToolUse, got: ${JSON.stringify(events)}`);
  });

  test('each hook entry has event, count, commands', () => {
    const r = configmgr.read(tmpDir);
    for (const h of r.hooks) {
      assert.equal(typeof h.event,   'string',  'hook.event must be string');
      assert.equal(typeof h.count,   'number',  'hook.count must be number');
      assert.ok(Array.isArray(h.commands),      'hook.commands must be array');
    }
  });

  test('PreToolUse hook flattens the command string', () => {
    const r = configmgr.read(tmpDir);
    const pre = r.hooks.find((h) => h.event === 'PreToolUse');
    assert.ok(pre, 'PreToolUse hook not found');
    assert.ok(pre.commands.includes('echo pre'), `commands = ${JSON.stringify(pre.commands)}`);
  });

  test('mcp array contains both servers', () => {
    const r = configmgr.read(tmpDir);
    assert.ok(Array.isArray(r.mcp), 'mcp must be an array');
    const names = r.mcp.map((m) => m.name);
    assert.ok(names.includes('test-server'), `mcp should include test-server, got: ${JSON.stringify(names)}`);
    assert.ok(names.includes('another'),     `mcp should include another, got: ${JSON.stringify(names)}`);
  });

  test('mcp entry has command, args, envKeys', () => {
    const r = configmgr.read(tmpDir);
    const srv = r.mcp.find((m) => m.name === 'test-server');
    assert.ok(srv, 'test-server not found in mcp');
    assert.equal(srv.command, 'npx');
    assert.deepEqual(srv.args, ['-y', 'test-server']);
    assert.ok(srv.envKeys.includes('FOO'), `envKeys = ${JSON.stringify(srv.envKeys)}`);
  });

  test('returns ok:true with empty hooks/mcp when .claude/ does not exist', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-empty-'));
    try {
      const r = configmgr.read(emptyDir);
      assert.equal(r.ok, true);
      assert.ok(Array.isArray(r.hooks));
      assert.ok(Array.isArray(r.mcp));
      assert.equal(r.hasSettings, false);
      assert.equal(r.hasMcp, false);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// del() — validation
// ---------------------------------------------------------------------------
describe('configmgr.del() — name validation', () => {
  let tmpDir;

  before(() => { tmpDir = makeTmpProject(); });
  after(()  => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('rejects null name', () => {
    const r = configmgr.del(tmpDir, 'hook', null);
    assert.ok(r.error, 'should return error for null name');
  });

  test('rejects name with path separator "/"', () => {
    const r = configmgr.del(tmpDir, 'hook', 'foo/bar');
    assert.ok(r.error, 'should return error for slash in name');
    assert.match(r.error, /invalid name/i);
  });

  test('rejects name with ".."', () => {
    const r = configmgr.del(tmpDir, 'hook', '..');
    assert.ok(r.error, 'should return error for ".." in name');
    assert.match(r.error, /invalid name/i);
  });

  test('rejects unknown kind', () => {
    const r = configmgr.del(tmpDir, 'wizard', 'PreToolUse');
    assert.ok(r.error, 'should return error for unknown kind');
    assert.match(r.error, /hook or mcp/i);
  });
});

// ---------------------------------------------------------------------------
// del() — hook deletion
// ---------------------------------------------------------------------------
describe('configmgr.del() — hook', () => {
  let tmpDir;

  // Fresh fixture per test to avoid ordering dependencies
  beforeEach(() => { tmpDir = makeTmpProject(); });
  after(()    => { /* last tmpDir cleaned up here isn't guaranteed; use per-test cleanup */ });

  test('deletes an existing hook and returns ok:true', () => {
    const r = configmgr.del(tmpDir, 'hook', 'PreToolUse');
    assert.deepEqual(r, { ok: true });
    // Verify it's actually gone
    const after = configmgr.read(tmpDir);
    const events = after.hooks.map((h) => h.event);
    assert.ok(!events.includes('PreToolUse'), 'PreToolUse should be removed');
    assert.ok( events.includes('PostToolUse'), 'PostToolUse should still be present');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns error when hook event does not exist', () => {
    const r = configmgr.del(tmpDir, 'hook', 'NonExistentEvent');
    assert.ok(r.error, 'should return error for missing hook event');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// del() — mcp deletion
// ---------------------------------------------------------------------------
describe('configmgr.del() — mcp', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpProject(); });

  test('deletes an existing MCP server and returns ok:true', () => {
    const r = configmgr.del(tmpDir, 'mcp', 'test-server');
    assert.deepEqual(r, { ok: true });
    // Verify it's gone
    const after = configmgr.read(tmpDir);
    const names = after.mcp.map((m) => m.name);
    assert.ok(!names.includes('test-server'), 'test-server should be removed');
    assert.ok( names.includes('another'),     'another should still be present');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns error when MCP server does not exist', () => {
    const r = configmgr.del(tmpDir, 'mcp', 'nonexistent-server');
    assert.ok(r.error, 'should return error for missing mcp server');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
