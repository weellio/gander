'use strict';
// bridge/mcp.js — the read-only MCP connector: JSON-RPC handling, the gate
// (Origin + token), and the HTTP envelope (202 for notifications, 405 for GET).
const test = require('node:test');
const assert = require('node:assert');
const mcp = require('../bridge/mcp.js');

const TOOLS = [
  { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { x: { type: 'integer' } } }, run: async (a) => ({ got: a.x }) },
  { name: 'rows', description: 'some rows', run: async () => [{ a: 1 }, { a: 2 }] },
  { name: 'boom', description: 'fails', run: async () => { throw new Error('nope'); } },
];

test('initialize negotiates a known protocol version and advertises tools only', async () => {
  const rpc = mcp.createRpc(TOOLS);
  const r = await rpc.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(Object.keys(r.result.capabilities), ['tools']);
  assert.equal(r.result.serverInfo.name, 'gander');
  const unknown = await rpc.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknown.result.protocolVersion, mcp.LATEST, 'an unknown version gets the latest we speak');
});

test('tools/list and tools/call: rows become structuredContent, errors become isError', async () => {
  const rpc = mcp.createRpc(TOOLS);
  const list = await rpc.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo', 'rows', 'boom']);
  assert.equal(list.result.tools[1].inputSchema.type, 'object', 'a tool without a schema gets an empty object schema');

  const call = await rpc.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { x: 7 } } });
  assert.equal(call.result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(call.result.content[0].text), { got: 7 });
  assert.deepEqual(call.result.structuredContent, { got: 7 });

  const rows = await rpc.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rows' } });
  assert.deepEqual(rows.result.structuredContent, { rows: [{ a: 1 }, { a: 2 }] });

  const bad = await rpc.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /boom failed: nope/);

  const missing = await rpc.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nothing' } });
  assert.equal(missing.error.code, -32602);
});

test('notifications and responses get no answer; bad envelopes get JSON-RPC errors', async () => {
  const rpc = mcp.createRpc(TOOLS);
  assert.equal(await rpc.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await rpc.handle({ jsonrpc: '2.0', id: 9, result: {} }), null);
  assert.equal((await rpc.handle({ jsonrpc: '1.0', id: 1, method: 'ping' })).error.code, -32600);
  assert.equal((await rpc.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).error.code, -32600, 'batches are refused: one message per POST');
  assert.equal((await rpc.handle({ jsonrpc: '2.0', id: 1, method: 'resources/read' })).error.code, -32601);
  assert.deepEqual((await rpc.handle({ jsonrpc: '2.0', id: 1, method: 'ping' })).result, {});
});

test('gate: loopback needs no token; remote needs the exact token by bearer or path; foreign Origin is refused', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz012345';
  assert.equal(mcp.gate({ remoteAddress: '127.0.0.1', token }).ok, true);
  assert.equal(mcp.gate({ remoteAddress: '::1', token: '' }).ok, true, 'local callers work with no token configured');
  const off = mcp.gate({ remoteAddress: '203.0.113.9', token: '' });
  assert.equal(off.ok, false); assert.equal(off.status, 403);
  const bad = mcp.gate({ remoteAddress: '203.0.113.9', token, authHeader: 'Bearer wrong' });
  assert.equal(bad.ok, false); assert.equal(bad.status, 401);
  assert.equal(mcp.gate({ remoteAddress: '203.0.113.9', token, authHeader: `Bearer ${token}` }).via, 'bearer');
  assert.equal(mcp.gate({ remoteAddress: '203.0.113.9', token, pathToken: token }).via, 'path');
  assert.equal(mcp.gate({ remoteAddress: '203.0.113.9', token, pathToken: token.slice(0, -1) + 'X' }).status, 401);
  // Origin: a browser page elsewhere cannot use the endpoint, even from loopback
  assert.equal(mcp.gate({ remoteAddress: '127.0.0.1', token, origin: 'https://evil.example' }).status, 403);
  assert.equal(mcp.gate({ remoteAddress: '127.0.0.1', token, origin: 'http://localhost:3131' }).ok, true);
  assert.equal(mcp.gate({ remoteAddress: '203.0.113.9', token, origin: 'https://claude.ai', authHeader: `Bearer ${token}` }).ok, true);
});

// A tiny fake req/res pair for mount()
function fakeReq({ method = 'POST', url = '/mcp', headers = {}, remoteAddress = '127.0.0.1', body } = {}) {
  return { method, url, headers: { host: 'localhost:3131', ...headers }, socket: { remoteAddress }, _body: body };   // every real client sends Host
}
function fakeRes() {
  const r = { status: 0, headers: {}, body: '' };
  r.writeHead = (s, h) => { r.status = s; Object.assign(r.headers, h || {}); };
  r.end = (b) => { r.body = b === undefined ? '' : String(b); };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const sendJson = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = async (req) => req._body;

test('mount: handles only /mcp paths, 405 on GET, 202 on notifications, 400 on bad protocol header', async () => {
  const handle = mcp.mount({ rpc: mcp.createRpc(TOOLS), getToken: () => 'tok_abcdefghijklmnopqrstuvwxyz', readBody, sendJson });
  assert.equal(await handle(fakeReq({ url: '/api/state' }), fakeRes(), '/api/state'), false, 'not ours');

  let res = fakeRes();
  assert.equal(await handle(fakeReq({ method: 'GET' }), res, '/mcp'), true);
  assert.equal(res.status, 405);

  res = fakeRes();
  await handle(fakeReq({ body: { jsonrpc: '2.0', method: 'notifications/initialized' } }), res, '/mcp');
  assert.equal(res.status, 202); assert.equal(res.body, '');

  res = fakeRes();
  await handle(fakeReq({ headers: { 'mcp-protocol-version': '2020-01-01' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } }), res, '/mcp');
  assert.equal(res.status, 400);

  res = fakeRes();
  await handle(fakeReq({ headers: { 'mcp-protocol-version': '2025-06-18' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }), res, '/mcp');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).result.tools.length, 3);

  res = fakeRes();
  await handle(fakeReq({ remoteAddress: '203.0.113.9', body: { jsonrpc: '2.0', id: 1, method: 'ping' } }), res, '/mcp');
  assert.equal(res.status, 401, 'remote without token');

  res = fakeRes();
  assert.equal(await handle(fakeReq({ remoteAddress: '203.0.113.9', body: { jsonrpc: '2.0', id: 1, method: 'ping' } }), res, '/mcp/tok_abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(res.status, 200, 'remote with the path token');
});

test('mount: a tunnelled call (loopback socket, proxy headers or foreign Host) is treated as remote', async () => {
  const token = 'tok_abcdefghijklmnopqrstuvwxyz';
  const handle = mcp.mount({ rpc: mcp.createRpc(TOOLS), getToken: () => token, readBody, sendJson });
  let res = fakeRes();
  await handle(fakeReq({ headers: { 'cf-connecting-ip': '203.0.113.9' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } }), res, '/mcp');
  assert.equal(res.status, 401, 'cloudflared header without a token');
  res = fakeRes();
  await handle(fakeReq({ headers: { host: 'abc.trycloudflare.com' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } }), res, '/mcp');
  assert.equal(res.status, 401, 'foreign Host without a token');
  res = fakeRes();
  await handle(fakeReq({ headers: { host: 'abc.trycloudflare.com', authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } }), res, '/mcp');
  assert.equal(res.status, 200, 'foreign Host with the bearer token');
  res = fakeRes();
  const off = mcp.mount({ rpc: mcp.createRpc(TOOLS), getToken: () => '', readBody, sendJson });
  await off(fakeReq({ headers: { host: 'abc.trycloudflare.com', authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } }), res, '/mcp');
  assert.equal(res.status, 403, 'connector switched off: remote refused even with a token');
});

test('newToken(): long, URL-safe and different each time', () => {
  const a = mcp.newToken(), b = mcp.newToken();
  assert.match(a, /^[A-Za-z0-9_-]{30,}$/);
  assert.notEqual(a, b);
});
