'use strict';
// The floor at a glance on a real bridge: /api/floor and the phone payload carry
// every session with its idle time; /api/poke queues text into one; the connector
// lists gander_floor + gander_poke; the phone console may ride the tunnel, token
// required, phone paths only — and proxy headers never count as loopback.
const { test, describe, before, after } = require('node:test');
const { tmpdir } = require('./_tmp.js');
const assert = require('node:assert');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const TOKEN = 'floor-test-token-0123456789abcdef';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function call(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(out || 'null'); } catch (_) {} resolve({ status: res.statusCode, json, text: out }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitUp(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await call(port, 'GET', '/api/state'); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('bridge did not come up');
}

describe('the floor at a glance on a real bridge', () => {
  let child, port, out = '';
  before(async () => {
    port = await freePort();
    const dir = tmpdir('gander-floorb-');
    child = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'server.js'), '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AOC_QUEUE_FILE: path.join(dir, 'q.json'), AOC_REGISTRY_FILE: path.join(dir, 'reg.json'), GANDER_NO_OPEN: '1', GANDER_NO_NUDGE: '1', GANDER_SETTINGS: path.join(dir, 'settings.json'), AOC_CONFIG_FILE: path.join(dir, 'aoc-config.json'), AOC_PROJECTS_FILE: path.join(dir, 'aoc-projects.json'), AOC_TOKEN: TOKEN },
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    await waitUp(port);
    // two root sessions: one idle after a finished turn, one mid-work
    for (const [sid, cwd] of [['floorsess1', 'D:/floor-blog'], ['floorsess2', 'D:/floor-shop']]) {
      const r = await call(port, 'POST', '/api/hook', { hook_event_name: 'SessionStart', session_id: sid, cwd, source: 'startup' });
      assert.equal(r.status, 200, r.text);
    }
    await call(port, 'POST', '/api/hook', { hook_event_name: 'Stop', session_id: 'floorsess1', cwd: 'D:/floor-blog', _lastMessage: 'Done. Tests pass, pushed to main.' });
    await call(port, 'POST', '/api/hook', { hook_event_name: 'PreToolUse', session_id: 'floorsess2', cwd: 'D:/floor-shop', tool_name: 'Edit', tool_input: { file_path: 'cart.js' } });
  });
  after(async () => {
    for (const sid of ['floorsess1', 'floorsess2']) { try { await call(port, 'POST', '/api/event', { agentId: 'sess:' + sid, remove: true, force: true }); } catch (_) {} }
    try { child.kill(); } catch (_) {}
  });

  test('/api/floor: one row per session, idle time and last line, the idle one first', async () => {
    const r = await call(port, 'GET', '/api/floor');
    assert.equal(r.status, 200, r.text);
    const names = r.json.rows.map((x) => x.project);
    assert.ok(names.includes('floor-blog') && names.includes('floor-shop'), names.join(','));
    const blog = r.json.rows.find((x) => x.project === 'floor-blog');
    assert.equal(blog.state, 'idle');
    assert.equal(blog.working, false);
    assert.equal(blog.idleFor, 'now');
    assert.equal(blog.canPoke, true);
    assert.match(blog.last, /Tests pass/);
    const shop = r.json.rows.find((x) => x.project === 'floor-shop');
    assert.equal(shop.working, true, 'an Edit in flight is working: ' + shop.state);
    assert.ok(r.json.rows.indexOf(blog) < r.json.rows.indexOf(shop), 'idle before busy');
    // a dev machine's own live sessions share this floor, so counts are lower bounds
    assert.ok(r.json.summary.working >= 1 && r.json.summary.idle >= 1, JSON.stringify(r.json.summary));
  });

  test('the phone payload carries the floor and its summary', async () => {
    const r = await call(port, 'GET', '/api/phone');
    assert.equal(r.status, 200);
    const mine = (r.json.floor || []).filter((x) => /^floor-/.test(x.project));
    assert.equal(mine.length, 2, JSON.stringify(r.json.floor));
    assert.ok(r.json.floorSummary.total >= 2);
  });

  test('/api/poke by project queues the default "continue" line for the session', async () => {
    const r = await call(port, 'POST', '/api/poke', { project: 'floor-blog' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.via, 'queued', 'no inbox and not hosted: the queued channel + wake sweep');
    const missing = await call(port, 'POST', '/api/poke', { project: 'nope-such' });
    assert.equal(missing.status, 404);
    const bad = await call(port, 'POST', '/api/poke', {});
    assert.equal(bad.status, 400);
    // the queued message is what the session's Stop hook would collect next
    const stop = await call(port, 'POST', '/api/hook', { hook_event_name: 'Stop', session_id: 'floorsess1', cwd: 'D:/floor-blog', _lastMessage: 'ok' });
    assert.equal(stop.status, 200);
    assert.match(JSON.stringify(stop.json), /Continue with the current task/);
  });

  test('the connector lists gander_floor and gander_poke, and poke works through it', async () => {
    const on = await call(port, 'POST', '/api/mcp-config', { enabled: true });
    assert.equal(on.status, 200, on.text);
    const rpc = (msg) => call(port, 'POST', '/mcp', msg, { 'mcp-protocol-version': '2025-06-18' });
    const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = list.json.result.tools.map((t) => t.name);
    assert.ok(names.includes('gander_floor') && names.includes('gander_poke'), names.join(','));
    const fl = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gander_floor', arguments: {} } });
    assert.ok(fl.json.result.structuredContent.summary.total >= 2);
    assert.ok(fl.json.result.structuredContent.rows.some((x) => x.project === 'floor-blog'));
    const pk = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gander_poke', arguments: { project: 'floor-shop', message: 'also run the linter' } } });
    assert.equal(pk.json.result.structuredContent.ok, true, JSON.stringify(pk.json));
    assert.equal(pk.json.result.structuredContent.session, 'floor-shop');
    const none = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gander_poke', arguments: { project: 'zzz' } } });
    assert.match(pk.json.result.structuredContent.sessionId, /floorsess2/);
    assert.match(JSON.stringify(none.json), /No session called/);
  });

  test('proxied calls are never loopback; the phone console rides the tunnel only when asked, with the token, on phone paths', async () => {
    const proxy = { 'cf-connecting-ip': '203.0.113.9', host: 'example.trycloudflare.com' };
    // remote access off, phoneViaTunnel off: a tunnelled call is refused like any foreign Host
    let r = await call(port, 'GET', '/api/floor', undefined, proxy);
    assert.equal(r.status, 403);
    r = await call(port, 'GET', '/phone.html', undefined, { ...proxy, 'x-gander-token': TOKEN });
    assert.equal(r.status, 403, 'not even with the token until the switch is on');
    // switch it on (live, no restart)
    const cfg = await call(port, 'POST', '/api/app-config', { phoneViaTunnel: true });
    assert.equal(cfg.status, 200, cfg.text);
    assert.equal(cfg.json.phoneViaTunnel, true);
    r = await call(port, 'GET', '/api/floor', undefined, proxy);
    assert.equal(r.status, 403, 'token required through the tunnel');
    r = await call(port, 'GET', '/api/floor', undefined, { ...proxy, 'x-gander-token': TOKEN });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.summary.total >= 2);
    r = await call(port, 'GET', '/phone.html?token=' + TOKEN, undefined, proxy);
    assert.equal(r.status, 200, 'first load with ?token= sets the cookie');
    r = await call(port, 'GET', '/api/state', undefined, { ...proxy, 'x-gander-token': TOKEN });
    assert.equal(r.status, 403, 'the full dashboard never passes through the tunnel');
    r = await call(port, 'GET', '/api/phone-link', undefined, { ...proxy, 'x-gander-token': TOKEN });
    assert.equal(r.status, 403, 'the full link with the token is local only');
    // local: the phone link carries the token
    const link = await call(port, 'GET', '/api/phone-link', undefined, { 'x-gander-base': 'https://example.trycloudflare.com/phone' });
    assert.equal(link.status, 200);
    assert.equal(link.json.url, 'https://example.trycloudflare.com/phone?token=' + TOKEN);
    // local stays frictionless
    r = await call(port, 'GET', '/api/floor');
    assert.equal(r.status, 200);
  });

  test('telegram-config carries the idle alert minutes', async () => {
    const set = await call(port, 'POST', '/api/telegram-config', { idleAlertMinutes: 25 });
    assert.equal(set.status, 200, set.text);
    const get = await call(port, 'GET', '/api/telegram-config');
    assert.equal(get.json.idleAlertMinutes, 25);
    const clamp = await call(port, 'POST', '/api/telegram-config', { idleAlertMinutes: -4 });
    assert.equal(clamp.status, 200);
    assert.equal((await call(port, 'GET', '/api/telegram-config')).json.idleAlertMinutes, 0);
  });
});
