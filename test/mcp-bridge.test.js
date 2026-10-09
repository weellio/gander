'use strict';
// The connector on a real bridge: /mcp speaks JSON-RPC over HTTP, the datasets
// answer as rows and CSV, and /api/mcp-config turns the token on and off.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gander-mcpb-'));
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }

function call(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let out = ''; res.on('data', (d) => (out += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: out, json: (() => { try { return JSON.parse(out); } catch (_) { return null; } })() }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function waitUp(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if ((await call(port, 'GET', '/api/state')).status === 200) return; } catch (_) {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('bridge did not come up');
}
const rpc = (port, msg, headers) => call(port, 'POST', '/mcp', msg, { accept: 'application/json, text/event-stream', ...headers });

describe('Gander as an MCP connector, on a real bridge', () => {
  let child, port, out = '', dir;
  before(async () => {
    port = await freePort(); dir = tmp();
    child = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'server.js'), '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AOC_QUEUE_FILE: path.join(dir, 'q.json'), GANDER_NO_OPEN: '1', GANDER_SETTINGS: path.join(dir, 'settings.json') },
    });
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    await waitUp(port);
  });
  after(async () => {
    try { await call(port, 'POST', '/api/mcp-config', { enabled: false }); } catch (_) {}   // the config file is the real one: leave the connector as it was
    try { child.kill(); } catch (_) {}
  });

  test('initialize, tools/list, a notification, and a tool call that returns rows', async () => {
    const init = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    assert.equal(init.status, 200, init.text);
    assert.equal(init.json.result.protocolVersion, '2025-06-18');
    assert.equal(init.json.result.serverInfo.name, 'gander');

    const note = await rpc(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': '2025-06-18' });
    assert.equal(note.status, 202);

    const list = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
    const names = list.json.result.tools.map((t) => t.name);
    assert.ok(names.includes('gander_datasets') && names.includes('gander_cost_by_day') && names.includes('gander_live_sessions'), names.join(','));

    const got = await rpc(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gander_cost_by_day', arguments: {} } }, { 'mcp-protocol-version': '2025-06-18' });
    assert.equal(got.status, 200, got.text);
    assert.equal(got.json.result.isError, undefined, got.text.slice(0, 300));
    const parsed = JSON.parse(got.json.result.content[0].text);
    assert.equal(parsed.kind, 'rows');
    assert.ok(Array.isArray(parsed.rows));
    assert.ok(parsed.rows.length >= 28, 'byDay always covers the last 30 days: ' + parsed.rows.length);
    assert.match(parsed.rows[0].date, /^\d{4}-\d{2}-\d{2}$/);

    const live = await rpc(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gander_live_sessions', arguments: {} } });
    assert.equal(live.json.result.isError, undefined);
    assert.ok(Array.isArray(JSON.parse(live.json.result.content[0].text).rows));

    const get = await call(port, 'GET', '/mcp');
    assert.equal(get.status, 405, 'no SSE stream is offered');
  });

  test('/api/datasets: the catalog, a dataset as JSON and as CSV, a 404 for an unknown id', async () => {
    const cat = await call(port, 'GET', '/api/datasets');
    assert.ok(cat.json.datasets.some((d) => d.id === 'overview'));
    assert.equal(typeof cat.json.mcp.enabled, 'boolean');

    const j = await call(port, 'GET', '/api/datasets/overview');
    assert.equal(j.status, 200);
    assert.equal(j.json.kind, 'record');
    assert.ok('openSessions' in j.json.record);

    const c = await call(port, 'GET', '/api/datasets/cost_by_day.csv');
    assert.equal(c.status, 200);
    assert.match(c.headers['content-type'], /text\/csv/);
    assert.match(c.text.split('\n')[0], /^date,costUSD,tokens$/);

    const q = await call(port, 'GET', '/api/datasets/sessions?limit=2&format=csv');
    assert.equal(q.status, 200);
    assert.ok(q.text.split('\n').filter(Boolean).length <= 3, 'header + at most two rows');

    const nope = await call(port, 'GET', '/api/datasets/nope');
    assert.equal(nope.status, 404);
  });

  test('/api/mcp-config: enabling mints a token; remote calls need it; disabling hides it', async () => {
    const on = await call(port, 'POST', '/api/mcp-config', { enabled: true });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.enabled, true);
    assert.match(on.json.token, /^[A-Za-z0-9_-]{30,}$/);
    assert.match(on.json.localUrl, new RegExp(`:${port}/mcp$`));
    const token = on.json.token;

    // a call that looks tunnelled (foreign Host) must carry the token
    const noTok = await call(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { host: 'abc.trycloudflare.com' });
    assert.equal(noTok.status, 403);
    const withTok = await call(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { host: 'abc.trycloudflare.com', authorization: `Bearer ${token}` });
    assert.equal(withTok.status, 200);
    const pathTok = await call(port, 'POST', `/mcp/${token}`, { jsonrpc: '2.0', id: 1, method: 'ping' }, { host: 'abc.trycloudflare.com' });
    assert.equal(pathTok.status, 200);

    const regen = await call(port, 'POST', '/api/mcp-config', { regenerate: true });
    assert.notEqual(regen.json.token, token);

    const off = await call(port, 'POST', '/api/mcp-config', { enabled: false });
    assert.equal(off.json.enabled, false);
    assert.equal(off.json.token, '', 'the token is not shown while the connector is off');
    const refused = await call(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { host: 'abc.trycloudflare.com', authorization: `Bearer ${regen.json.token}` });
    assert.equal(refused.status, 403, 'off means off for remote callers');
    const local = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(local.status, 200, 'loopback callers still work');
  });
});
