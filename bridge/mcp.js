'use strict';
// Gander as a connector: a read-only MCP server (Streamable HTTP, JSON-RPC 2.0)
// served by the bridge at /mcp, so claude.ai, Claude Desktop and Claude Code can
// query the dashboard's data — and a Claude Dashboard can run live queries on it.
//
// Zero dependencies. Every request is one HTTP POST with one JSON-RPC message;
// answers are plain application/json (no SSE stream is offered: GET -> 405).
//
// Security, in the order the MCP spec asks for it:
//   1. Origin is validated: a browser page on another site cannot reach this
//      endpoint (DNS rebinding). Server-to-server calls carry no Origin.
//   2. A token guards every non-loopback call: `Authorization: Bearer <token>`
//      (claude.ai's "fixed credentials") or the path form `/mcp/<token>` for
//      clients that cannot set headers. Loopback callers need no token.
//   3. Tools are read-only: nothing here starts, stops, replies to or edits a
//      session; they read what the bridge already computes.

const crypto = require('crypto');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = PROTOCOL_VERSIONS[0];
const SERVER_INFO = { name: 'gander', version: '0.1.0' };

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
const RECENT = [];   // the last remote calls: what claude.ai actually sent, for the Settings panel
function recent() { return RECENT.slice(); }
function remember(entry) { RECENT.unshift(entry); if (RECENT.length > 20) RECENT.pop(); }
const TRUSTED_ORIGIN = /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/i;

function newToken() { return crypto.randomBytes(24).toString('base64url'); }

// ── JSON-RPC ─────────────────────────────────────────────────────────────────
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: data === undefined ? { code, message } : { code, message, data } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

function toolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 0);
  const out = { content: [{ type: 'text', text }] };
  if (value && typeof value === 'object') out.structuredContent = Array.isArray(value) ? { rows: value } : value;
  return out;
}

// `tools`: [{ name, description, inputSchema?, run(args) -> value | Promise<value> }]
function createRpc(tools, info = SERVER_INFO) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const list = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {}, additionalProperties: false } }));

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request: one JSON-RPC message per POST');
    if (msg.jsonrpc !== '2.0') return rpcError(msg.id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    const isNotification = msg.id === undefined && typeof msg.method === 'string';
    const isResponse = msg.method === undefined && ('result' in msg || 'error' in msg);
    if (isNotification || isResponse) return null;                      // accepted, nothing to say back (HTTP 202)
    if (typeof msg.method !== 'string') return rpcError(msg.id, -32600, 'Invalid Request: method required');
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    switch (msg.method) {
      case 'initialize': {
        const asked = String(params.protocolVersion || '');
        const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST;
        return rpcResult(msg.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: info,
          instructions: 'Read-only view of this machine\'s Gander dashboard: Claude Code sessions, sub-agents, spend, context pressure, queue and scorecards. Every tool returns rows or a record; nothing here changes state.',
        });
      }
      case 'ping': return rpcResult(msg.id, {});
      case 'tools/list': return rpcResult(msg.id, { tools: list });
      case 'tools/call': {
        const name = String(params.name || '');
        const tool = byName.get(name);
        if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        try {
          const value = await tool.run(params.arguments && typeof params.arguments === 'object' ? params.arguments : {});
          return rpcResult(msg.id, toolResult(value));
        } catch (e) {
          return rpcResult(msg.id, { content: [{ type: 'text', text: `${name} failed: ${e && e.message ? e.message : e}` }], isError: true });
        }
      }
      case 'prompts/list': return rpcResult(msg.id, { prompts: [] });
      case 'resources/list': return rpcResult(msg.id, { resources: [] });
      default: return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }
  return { handle, list };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function hostOf(origin) {
  try { return new URL(origin).hostname.toLowerCase(); } catch (_) { return ''; }
}

// Decide whether a request may reach the endpoint: { ok } or { ok:false, status, error }.
function gate({ origin, remoteAddress, pathToken, authHeader, headerToken, token }) {
  if (origin) {
    const h = hostOf(origin);
    if (!LOOPBACK.has(h) && !TRUSTED_ORIGIN.test(h)) return { ok: false, status: 403, error: 'Origin not allowed' };
  }
  const loopback = LOOPBACK.has(String(remoteAddress || '').toLowerCase());
  if (loopback) return { ok: true, via: 'loopback' };
  if (!token) return { ok: false, status: 403, error: 'Remote MCP access is off: no connector token is set' };
  // The token may arrive as `Authorization: Bearer <t>`, a bare `Authorization: <t>`,
  // an `X-Gander-Token: <t>` header, or in the path (/mcp/<t>).
  const auth = String(authHeader || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const given = (bearer && bearer[1].trim()) || (auth && !/\s/.test(auth) ? auth : '') || String(headerToken || '').trim() || pathToken || '';
  // 403, not 401: a 401 makes MCP clients (claude.ai's "Add custom connector")
  // start OAuth discovery, and this server has none. The token rides as a
  // fixed Authorization header or in the path instead.
  if (!given || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
    return { ok: false, status: 403, error: 'Bad or missing connector token: send Authorization: Bearer <token>, or use /mcp/<token>' };
  }
  return { ok: true, via: bearer ? 'bearer' : (auth ? 'authorization' : (headerToken ? 'header' : 'path')) };
}

// Mount on the bridge's request handler. `getToken()` reads the current token.
// Returns true when the request was for the MCP endpoint (handled), false otherwise.
function mount({ rpc, getToken, readBody, sendJson }) {
  return async function handle(req, res, url) {
    const m = /^\/mcp(?:\/([A-Za-z0-9_-]{16,}))?\/?$/.exec(url);
    if (!m) return false;
    const pathToken = m[1] || '';
    // A cloudflared tunnel (or any reverse proxy) hands the call to loopback; the
    // proxy headers and a non-loopback Host say it really came from outside.
    const forwarded = String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0]).trim();
    const hostLoop = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(String(req.headers.host || ''));
    const remoteAddress = forwarded || (hostLoop ? (req.socket && req.socket.remoteAddress) : 'proxied');
    const g = gate({ origin: req.headers.origin, remoteAddress, pathToken, authHeader: req.headers.authorization, headerToken: req.headers['x-gander-token'], token: getToken() });
    const remote = remoteAddress !== (req.socket && req.socket.remoteAddress) || !hostLoop;
    if (remote) {
      const entry = { at: Date.now(), method: req.method, path: url.replace(/\/mcp\/[^/]+/, '/mcp/<token>'), from: remoteAddress, ua: String(req.headers['user-agent'] || '').slice(0, 60), origin: req.headers.origin || '', auth: req.headers.authorization ? (/^Bearer /i.test(req.headers.authorization) ? 'bearer' : 'other') : '', xToken: !!req.headers['x-gander-token'], result: g.ok ? 'ok via ' + g.via : `${g.status} ${g.error}` };
      remember(entry);
      console.log(`[mcp] ${entry.method} ${entry.path} from ${entry.from} ua=${entry.ua.slice(0, 40)} origin=${entry.origin || '-'} auth=${entry.auth || 'no'} x-gander-token=${entry.xToken ? 'yes' : 'no'} -> ${entry.result}`);
    }
    if (!g.ok) { sendJson(res, g.status, rpcError(null, -32000, g.error)); return true; }

    if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST', 'content-type': 'application/json' }); res.end(JSON.stringify(rpcError(null, -32000, 'No SSE stream here: POST one JSON-RPC message'))); return true; }
    if (req.method === 'DELETE') { res.writeHead(405, { Allow: 'POST' }); res.end(); return true; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return true; }

    const pv = req.headers['mcp-protocol-version'];
    if (pv && !PROTOCOL_VERSIONS.includes(String(pv))) { sendJson(res, 400, rpcError(null, -32000, `Unsupported MCP-Protocol-Version: ${pv}`)); return true; }

    const body = await readBody(req);
    if (!body) { sendJson(res, 400, rpcError(null, -32700, 'Parse error')); return true; }
    if (remote && RECENT[0] && body && typeof body === 'object') RECENT[0].rpc = String(body.method || (body.result !== undefined || body.error !== undefined ? 'response' : '?'));
    const answer = await rpc.handle(body);
    if (remote && RECENT[0]) RECENT[0].status = answer === null ? 202 : (answer.error ? 'rpc error ' + answer.error.code : 200);
    if (answer === null) { res.writeHead(202); res.end(); return true; }
    sendJson(res, 200, answer);
    return true;
  };
}

module.exports = { createRpc, mount, gate, newToken, toolResult, recent, PROTOCOL_VERSIONS, LATEST, SERVER_INFO };
