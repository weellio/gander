'use strict';
// bridge/tunnel.js — the pure parts: which release to fetch, where it lands,
// how the tunnel URL is read off cloudflared's log, and status before any start.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const tunnel = require('../bridge/tunnel.js');

test('downloadUrl(): the official release asset per platform and arch', () => {
  assert.deepEqual(tunnel.downloadUrl('win32', 'x64'), { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', archive: 'exe' });
  assert.deepEqual(tunnel.downloadUrl('darwin', 'arm64'), { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz', archive: 'tgz' });
  assert.deepEqual(tunnel.downloadUrl('linux', 'x64'), { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64', archive: 'bin' });
  assert.deepEqual(tunnel.downloadUrl('linux', 'arm64').url.endsWith('cloudflared-linux-arm64'), true);
  assert.equal(tunnel.downloadUrl('freebsd', 'x64'), null);
});

test('managedPath(): inside the bridge\'s own bin folder, never on PATH', () => {
  const p = tunnel.managedPath();
  assert.equal(path.dirname(p), tunnel.BIN_DIR);
  assert.equal(path.basename(tunnel.BIN_DIR), 'bin');
  assert.match(path.basename(p), /^cloudflared(\.exe)?$/);
});

test('parseUrl(): finds the trycloudflare address in a log line, nothing elsewhere', () => {
  assert.equal(tunnel.parseUrl('2026-10-09T03:00:00Z INF |  https://quiet-river-1234.trycloudflare.com  |'), 'https://quiet-river-1234.trycloudflare.com');
  assert.equal(tunnel.parseUrl('INF Registered tunnel connection connIndex=0'), '');
  assert.equal(tunnel.parseUrl('https://evil.example.com/trycloudflare.com'), '');
});

test('status(): idle before anything starts, and stop() is safe to call then', () => {
  const s = tunnel.status();
  assert.equal(s.running, false);
  assert.equal(s.url, '');
  assert.equal(s.installing, false);
  tunnel.stop((_e, after) => { assert.equal(after.running, false); });
});

test('installed(): answers with a path and a version line, or empty strings, never throws', (t, done) => {
  tunnel.installed((bin, v) => {
    assert.equal(typeof bin, 'string');
    assert.equal(typeof v, 'string');
    assert.equal(!!bin, !!v, 'a usable binary always comes with its version line');
    done();
  });
});
