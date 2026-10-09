'use strict';
// The gander-feed mod's HTTP surface on a real bridge: POST /api/mod lands on
// the session's tile at once, GET /api/mod/band answers the band, and
// GET /api/mod/status reports the version gate without ever installing.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gander-modb-'));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function call(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(out || 'null') }); } catch (e) { reject(new Error(`bad json from ${p}: ${out.slice(0, 200)}`)); } });
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

describe('gander-feed mod on a real bridge', () => {
  let child, port, out = '';
  before(async () => {
    port = await freePort();
    const dir = tmp();
    child = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'server.js'), '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AOC_QUEUE_FILE: path.join(dir, 'q.json'), AOC_REGISTRY_FILE: path.join(dir, 'reg.json'), GANDER_NO_OPEN: '1', GANDER_SETTINGS: path.join(dir, 'settings.json'), AOC_CONFIG_FILE: path.join(dir, 'aoc-config.json') },
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    await waitUp(port);
  });
  after(async () => {
    // the registry file is shared with a real bridge on this machine: leave no fake session behind
    try { await call(port, 'POST', '/api/event', { agentId: 'sess:modsess1', remove: true, force: true }); } catch (_) {}
    try { child.kill(); } catch (_) {}
  });

  test('a session tile picks up exact cost and context the moment the mod posts', async () => {
    // a root session as the classic hooks would create it
    const hook = await call(port, 'POST', '/api/hook', { hook_event_name: 'SessionStart', session_id: 'modsess1', cwd: 'D:/proj-a', source: 'startup' });
    assert.equal(hook.status, 200, JSON.stringify(hook.json));

    const bad = await call(port, 'POST', '/api/mod', { kind: 'measure' });
    assert.equal(bad.status, 400);

    const hello = await call(port, 'POST', '/api/mod', { kind: 'hello', session_id: 'modsess1', version: '2.1.294', model: 'claude-fable-5-1', cwd: 'D:/proj-a' });
    assert.equal(hello.status, 200);
    const m = await call(port, 'POST', '/api/mod', { kind: 'measure', session_id: 'modsess1', context: { tokens: 90000, window: 200000, percent: 45 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }], costUsd: 3.21 });
    assert.equal(m.status, 200);

    const st = await call(port, 'GET', '/api/state');
    const a = (st.json.agents || []).find((x) => x.id === 'sess:modsess1');
    assert.ok(a, 'the root agent exists: ' + Object.keys(st.json).join(','));
    assert.equal(a.costUSD, 3.21, 'cost is the engine figure, not an estimate');
    assert.equal(a.costExact, true);
    assert.equal(a.ctxPct, 0.45);
    assert.ok(a.feed && a.feed.live, 'the feed summary rides on the tile');
    assert.equal(a.feed.version, '2.1.294');
    assert.deepEqual(a.feed.rateLimits, [{ kind: 'five_hour', percentUsed: 12, resetsAt: null }]);
  });

  test('the band answers needs-you, spend and context for the asking session', async () => {
    const b = await call(port, 'GET', '/api/mod/band?session_id=modsess1');
    assert.equal(b.status, 200);
    assert.equal(b.json.spendUsd, 3.21);
    assert.equal(b.json.ctxPercent, 45);
    assert.equal(typeof b.json.needsYou, 'number');
    assert.match(b.json.url, new RegExp(`:${port}/$`));
    const none = await call(port, 'GET', '/api/mod/band?session_id=unknown');
    assert.equal(none.json.spendUsd, null);
  });

  test('status reports the gate and never claims support for an unknown CLI', async () => {
    const s = await call(port, 'GET', '/api/mod/status');
    assert.equal(s.status, 200);
    assert.equal(s.json.minVersion, '2.1.287');
    assert.equal(s.json.plugin, 'gander-feed@gander');
    assert.equal(typeof s.json.supported, 'boolean');
    assert.equal(typeof s.json.installed, 'boolean');
    assert.equal(s.json.sessionsFed, 1);
    if (!s.json.ccVersion) assert.equal(s.json.supported, false, 'no CLI, no support claim');
  });

  test('bye ends the feed: the tile keeps the last figures but stops being exact on the next sample', async () => {
    const bye = await call(port, 'POST', '/api/mod', { kind: 'bye', session_id: 'modsess1', reason: 'exit' });
    assert.equal(bye.status, 200);
    const st = await call(port, 'GET', '/api/state');
    const a = st.json.agents.find((x) => x.id === 'sess:modsess1');
    assert.equal(a.feed.live, false);
    assert.equal(a.feed.costUsd, 3.21);
  });
});
