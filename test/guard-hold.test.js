'use strict';
// Danger guard "hold": a blocked command parks the hook until the person decides.
//   Allow once while parked -> the emitter is released with allow (the command runs).
//   Keep blocked while parked -> released with deny.
//   Allow once after the hold -> the session is told to run it again (queued channel).
//   hold 0 -> the old immediate deny.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gander-guard-'));
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function call(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let out = ''; res.on('data', (d) => (out += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(out || 'null'); } catch (_) {} resolve({ status: res.statusCode, json, text: out }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function waitUp(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if ((await call(port, 'GET', '/api/state')).status === 200) return; } catch (_) {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('bridge did not come up');
}
const pretool = (sid, command) => ({ hook_event_name: 'PreToolUse', session_id: sid, cwd: 'D:/proj-g', tool_name: 'Bash', tool_use_id: 'tu-' + Math.random().toString(36).slice(2), tool_input: { command } });

describe('danger guard hold', () => {
  let child, port, out = '';
  before(async () => {
    port = await freePort(); const dir = tmp();
    child = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'server.js'), '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AOC_QUEUE_FILE: path.join(dir, 'q.json'), AOC_CONFIG_FILE: path.join(dir, 'aoc-config.json'), GANDER_SETTINGS: path.join(dir, 'settings.json'), GANDER_NO_OPEN: '1' },
    });
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    await waitUp(port);
    await call(port, 'POST', '/api/hook', { hook_event_name: 'SessionStart', session_id: 'gsess', cwd: 'D:/proj-g', source: 'startup' });
  });
  after(async () => {
    try { await call(port, 'POST', '/api/event', { agentId: 'sess:gsess', remove: true, force: true }); } catch (_) {}
    try { child.kill(); } catch (_) {}
  });

  test('a dangerous command is parked, and Allow once releases it with allow', async () => {
    const r = await call(port, 'POST', '/api/hook', pretool('gsess', 'rm -rf /'));
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.deliver && r.json.deliver.kind === 'pretool-hold', JSON.stringify(r.json.deliver));
    assert.ok(r.json.guardPending && r.json.guardPending.id && r.json.guardPending.holdMs >= 5000, JSON.stringify(r.json.guardPending));
    const gid = r.json.guardPending.id;
    const safety = await call(port, 'GET', '/api/safety');
    assert.equal(safety.json.guard.holdSeconds, 120, 'default hold');
    assert.ok(safety.json.guard.recent.some((g) => g.id === gid && g.holdUntil > Date.now()));

    // the emitter parks on /api/guard/wait; the click answers it
    const waiting = call(port, 'GET', '/api/guard/wait?id=' + gid);
    await new Promise((res) => setTimeout(res, 300));
    const allow = await call(port, 'POST', '/api/guard/allow', { id: gid });
    assert.equal(allow.status, 200);
    assert.equal(allow.json.resumed, true, 'a parked emitter was released');
    assert.equal(allow.json.nudged, '', 'no retry message was needed');
    const w = await waiting;
    assert.deepEqual(w.json, { answered: true, allow: true });
    // a late poll sees the same answer
    assert.deepEqual((await call(port, 'GET', '/api/guard/wait?id=' + gid)).json, { answered: true, allow: true });
  });

  test('Keep blocked while parked releases it with deny', async () => {
    const r = await call(port, 'POST', '/api/hook', pretool('gsess', 'git push --force origin main'));
    const gid = r.json.guardPending && r.json.guardPending.id;
    assert.ok(gid, JSON.stringify(r.json));
    const waiting = call(port, 'GET', '/api/guard/wait?id=' + gid);
    await new Promise((res) => setTimeout(res, 200));
    await call(port, 'POST', '/api/guard/dismiss', { id: gid });
    assert.deepEqual((await waiting).json, { answered: true, allow: false });
  });

  test('Allow once after the hold tells the session to run it again', async () => {
    const r = await call(port, 'POST', '/api/hook', pretool('gsess', 'rm -rf .'));
    const gid = r.json.guardPending.id;
    // nobody is parked (the emitter gave up): the click must reach the session by itself
    const allow = await call(port, 'POST', '/api/guard/allow', { id: gid });
    assert.equal(allow.json.resumed, false);
    assert.equal(allow.json.nudged, 'queued', 'no inbox in a test: the queued channel carries it');
    const st = await call(port, 'GET', '/api/state');
    assert.ok(st.json.pending && st.json.pending.gsess >= 1, 'a message is queued for the session: ' + JSON.stringify(st.json.pending));
    // and the pass is armed, so the retry goes through without a hold
    const again = await call(port, 'POST', '/api/hook', pretool('gsess', 'rm -rf .'));
    assert.equal(again.json.deliver, null, 'allowed once: no hold, no deny');
  });

  test('hold 0 restores the immediate deny; the setting round-trips', async () => {
    const set = await call(port, 'POST', '/api/safety/config', { holdSeconds: 0 });
    assert.equal(set.json.holdSeconds, 0);
    const r = await call(port, 'POST', '/api/hook', pretool('gsess', 'rm -rf /'));
    assert.equal(r.json.deliver.kind, 'pretool-deny');
    assert.equal(r.json.guardPending, undefined);
    const back = await call(port, 'POST', '/api/safety/config', { holdSeconds: 9999 });
    assert.equal(back.json.holdSeconds, 540, 'clamped under the 590 s hook timeout');
  });
});
