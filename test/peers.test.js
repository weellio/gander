'use strict';
// bridge/peers.js — Claude Code's session registry + cross-session inbox delivery.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-peers-'));
process.env.GANDER_SESSIONS_DIR = dir;

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const peers = require('../bridge/peers');

const pipeName = () => (process.platform === 'win32' ? '\\\\.\\pipe\\gander-test-' + process.pid + '-' + Date.now() : path.join(dir, 'inbox-' + Date.now() + '.sock'));

describe('peers', () => {
  test('reads the registry (one <pid>.json per running session) and ignores junk', () => {
    fs.writeFileSync(path.join(dir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'S-1', cwd: 'C:\\p\\alpha', name: 'alpha-9f', kind: 'interactive', entrypoint: 'claude-vscode', messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-abc' }));
    fs.writeFileSync(path.join(dir, '4242.deadbeef.key'), '{"peerToken":"x"}');
    fs.writeFileSync(path.join(dir, 'notes.json'), '{"sessionId":"nope"}');
    fs.writeFileSync(path.join(dir, '99.json'), 'not json');
    const list = peers.readRegistry(0);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'alpha-9f');
    assert.equal(list[0].pid, 4242);
    assert.equal(peers.bySession('S-1').cwd, 'C:\\p\\alpha');
    assert.equal(peers.byName('alpha-9f').sessionId, 'S-1');
    assert.equal(peers.bySession('missing'), null);
  });

  test('envelope matches the captured wire format', () => {
    const e = peers.envelope('hello\nworld', 'gander');
    assert.equal(e.msgV, 1);
    assert.equal(e.type, 'user');
    assert.equal(e.priority, 'next');
    assert.equal(e.from, 'gander');
    assert.match(e.msg_id, /^[0-9a-f-]{36}$/);
    assert.equal(e.message.role, 'user');
    assert.equal(e.message.content, '<cross-session-message from="gander" from-name="gander">\nhello\nworld\n</cross-session-message>');
  });

  test('canDeliver needs a socket, and on Windows the session\'s own token', () => {
    assert.equal(peers.canDeliver('S-unknown'), false);
    peers.learn('S-2', '\\\\.\\pipe\\LOCAL\\cc-msg-s2', '');
    assert.equal(peers.canDeliver('S-2'), process.platform !== 'win32');
    peers.learn('S-2', '\\\\.\\pipe\\LOCAL\\cc-msg-s2', 'tok-2');
    assert.equal(peers.canDeliver('S-2'), true);
    // a later hook without the token must not erase the one we have
    peers.learn('S-2', '\\\\.\\pipe\\LOCAL\\cc-msg-s2', '');
    assert.equal(peers.sessionTokens.get('S-2').token, 'tok-2');
  });

  test('deliver: auth line first, then one JSON envelope line, resolves ok', async () => {
    const sock = pipeName();
    let got = '';
    const srv = net.createServer((c) => { c.on('data', (d) => (got += d)); });
    await new Promise((r) => srv.listen(sock, r));
    try {
      peers.learn('S-3', sock, 'tok-3');
      const r = await peers.deliver('S-3', 'reply from the rail', { fromName: 'gander' });
      assert.equal(r.ok, true);
      const lines = got.trim().split('\n');
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]), { type: 'auth', token: 'tok-3' });
      const env = JSON.parse(lines[1]);
      assert.equal(env.type, 'user');
      assert.match(env.message.content, /reply from the rail/);
    } finally { srv.close(); }
  });

  test('deliver: unreachable inbox → error (caller falls back to the queued channel)', async () => {
    peers.learn('S-4', pipeName(), 'tok-4');
    const r = await peers.deliver('S-4', 'x', { timeoutMs: 1500 });
    assert.ok(r.error);
  });

  test('deliver: unknown session → error', async () => {
    const r = await peers.deliver('S-none', 'x');
    assert.match(r.error, /no inbox/);
  });
});
