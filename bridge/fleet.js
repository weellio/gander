'use strict';
// Gander Fleet — one dashboard for EVERY machine (zero dependencies).
//
// A HUB bridge polls the /api/state of PEER bridges (other machines running
// Gander with remote access + an access token enabled) and merges their agents
// into its own floor, tagged with the machine name. Remote agents get
// namespaced ids ('fleet:<peer>:<origId>') so they can never collide with
// local tiles — and parentId is remapped the same way so sub-agent hierarchies
// still render. Commands (reply/stop) aimed at a remote agent are forwarded to
// the owning peer's /api/command with the shared X-Gander-Token header.
//
// Failure posture: a peer that stops answering keeps its last-known agents on
// the floor for two missed polls (a wifi blip shouldn't blank a machine), goes
// dark on the third consecutive miss, and comes straight back on the next good
// poll. The poll loop never throws. Peer tokens never ride in merged agent
// snapshots.
//
// All network is dependency-injected (fetchJson / postJson / now) so the merge
// and routing logic is unit-testable without opening a socket; the default
// implementations use plain node http/https with a 4s timeout.

const http = require('http');
const https = require('https');

const DEFAULT_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 2000;
const MAX_MISSES = 3;                 // consecutive failed polls before a peer's agents drop
const TIMEOUT_MS = 4000;

// ── module state ─────────────────────────────────────────────────────────────
let peers = [];                       // [{ name, url, token, snapshot, lastSeenMs, misses, error }]
let intervalMs = DEFAULT_INTERVAL_MS;
let timer = null;
let liveDeps = null;                  // deps captured by start() for the poll loop

function fleetId(peerName, id) { return 'fleet:' + peerName + ':' + id; }

// ── configuration ────────────────────────────────────────────────────────────
function normalizePeer(p) {
  if (!p || typeof p !== 'object') return null;
  const url = String(p.url || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  let name = String(p.name || '').trim();
  if (!name) { try { name = new URL(url).hostname; } catch (_) {} }
  if (!name) return null;
  // the name rides inside 'fleet:<name>:<id>' ids — it must never contain ':'
  name = name.replace(/[:\s/\\]+/g, '-');
  return { name, url, token: p.token ? String(p.token) : '', snapshot: [], lastSeenMs: null, misses: 0, error: null };
}

/** Normalize + store the fleet config. Returns the normalized config. */
function configure(cfg) {
  const c = cfg || {};
  const next = [];
  const seen = new Set();
  for (const raw of (Array.isArray(c.peers) ? c.peers : [])) {
    const p = normalizePeer(raw);
    if (!p || seen.has(p.name)) continue;
    seen.add(p.name);
    // same machine re-configured: carry its runtime state so agents() doesn't flicker
    const prev = peers.find((q) => q.name === p.name && q.url === p.url);
    if (prev) { p.snapshot = prev.snapshot; p.lastSeenMs = prev.lastSeenMs; p.misses = prev.misses; p.error = prev.error; }
    next.push(p);
  }
  peers = next;
  intervalMs = Math.max(MIN_INTERVAL_MS, Number(c.intervalMs) || DEFAULT_INTERVAL_MS);
  return { peers: peers.map((p) => ({ name: p.name, url: p.url, token: p.token })), intervalMs };
}

// ── default network (node http/https, no deps) ───────────────────────────────
function requestJson(method, url, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('bad url: ' + url)); }
    const data = o.body === undefined ? null : JSON.stringify(o.body);
    const req = (u.protocol === 'https:' ? https : http).request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      timeout: o.timeoutMs || TIMEOUT_MS,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(o.headers || {}),
      },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + (buf ? ': ' + buf.slice(0, 120) : '')));
        try { resolve(JSON.parse(buf)); } catch (_) { reject(new Error('peer sent non-JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout after ' + (o.timeoutMs || TIMEOUT_MS) + 'ms')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function defaultFetchJson(url, opts) { return requestJson('GET', url, opts); }
function defaultPostJson(url, body, opts) { return requestJson('POST', url, { ...(opts || {}), body }); }

function headersFor(peer) { return peer.token ? { 'X-Gander-Token': peer.token } : {}; }

// ── the merge (pure) ─────────────────────────────────────────────────────────
// Shallow-clone a peer's agents into hub-namespaced remote agents. Tokens are
// stripped defensively — a snapshot must never leak a credential.
function mergeSnapshot(peer, list) {
  const out = [];
  for (const a of (Array.isArray(list) ? list : [])) {
    if (!a || typeof a !== 'object' || a.id == null) continue;
    const c = { ...a };
    delete c.peerToken;
    delete c.token;
    c.origId = a.id;
    c.id = fleetId(peer.name, a.id);
    if (a.parentId) c.parentId = fleetId(peer.name, a.parentId);
    c.machine = peer.name;
    c.remote = true;
    c.peerUrl = peer.url;
    out.push(c);
  }
  return out;
}

// ── polling ──────────────────────────────────────────────────────────────────
async function pollPeer(peer, d) {
  try {
    const j = await d.fetchJson(peer.url + '/api/state', { headers: headersFor(peer), timeoutMs: TIMEOUT_MS });
    peer.snapshot = Array.isArray(j && j.agents) ? j.agents : [];
    peer.lastSeenMs = d.now();
    peer.misses = 0;
    peer.error = null;
  } catch (e) {
    peer.misses++;
    peer.error = (e && e.message) || String(e);
  }
}

// One poll round across every peer. pollPeer never rejects, but the loop still
// wears a belt AND braces — nothing may ever throw out of the interval tick.
function pollAll(d) {
  return Promise.all(peers.map((p) => pollPeer(p, d))).catch(() => {});
}

/**
 * Start polling every intervalMs. Idempotent — call again after configure()
 * to restart with the new config. deps = { fetchJson, postJson, now }.
 */
function start(deps) {
  stop();
  liveDeps = { fetchJson: defaultFetchJson, postJson: defaultPostJson, now: Date.now, ...(deps || {}) };
  pollAll(liveDeps);                                     // first snapshot right away
  timer = setInterval(() => pollAll(liveDeps), intervalMs);
  if (timer.unref) timer.unref();                        // never keep the process alive
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

// ── read side (for snapshot() / /api/state on the hub) ───────────────────────
/** Merged REMOTE agents from the last successful poll of each online peer. */
function agents() {
  const out = [];
  for (const p of peers) {
    if (!p.lastSeenMs || p.misses >= MAX_MISSES) continue;   // never seen, or 3 strikes → dark
    out.push(...mergeSnapshot(p, p.snapshot));
  }
  return out;
}

/** Per-peer health for the dashboard. Never includes tokens. */
function status() {
  return peers.map((p) => ({
    name: p.name,
    url: p.url,
    online: p.misses === 0 && !!p.lastSeenMs,
    lastSeenMs: p.lastSeenMs || null,
    agentCount: (p.lastSeenMs && p.misses < MAX_MISSES) ? p.snapshot.length : 0,
    error: p.error,
  }));
}

// ── command forwarding ───────────────────────────────────────────────────────
// Find the peer that owns a fleet agent — by 'fleet:<peer>:<origId>' prefix,
// or by searching the last snapshots for a matching sessionId.
function resolveTarget(idOrSid) {
  const s = String(idOrSid || '');
  if (s.startsWith('fleet:')) {
    const rest = s.slice('fleet:'.length);
    const cut = rest.indexOf(':');
    if (cut < 1) return null;
    const name = rest.slice(0, cut);
    const origId = rest.slice(cut + 1);
    const peer = peers.find((p) => p.name === name);
    if (!peer) return null;
    const a = (peer.snapshot || []).find((x) => x && x.id === origId);
    // registry root ids are 'sess:<sessionId>' — usable even if the agent aged out
    const sessionId = (a && a.sessionId) || (origId.startsWith('sess:') ? origId.slice(5) : null);
    return { peer, sessionId };
  }
  for (const peer of peers) {
    if ((peer.snapshot || []).some((x) => x && x.sessionId === s)) return { peer, sessionId: s };
  }
  return null;
}

/**
 * Forward a reply/stop to the peer that owns the agent.
 * @param {string} idOrSid  'fleet:<peer>:<origId>' or a remote sessionId
 * @param {object} cmd      { type, text }
 * @returns {Promise<{ok:true, machine:string}|{error:string}>}
 */
async function forwardCommand(idOrSid, cmd, deps) {
  const d = { postJson: defaultPostJson, ...(deps || {}) };
  const target = resolveTarget(idOrSid);
  if (!target) return { error: 'no fleet peer owns agent ' + String(idOrSid || '') };
  if (!target.sessionId) return { error: 'remote agent has no session id to command' };
  const { peer, sessionId } = target;
  const body = { sessionId, type: (cmd && cmd.type) || 'message', text: String((cmd && cmd.text) || '') };
  try {
    const r = await d.postJson(peer.url + '/api/command', body, { headers: headersFor(peer), timeoutMs: TIMEOUT_MS });
    if (r && r.error) return { error: peer.name + ': ' + r.error };
    return { ok: true, machine: peer.name };
  } catch (e) {
    return { error: peer.name + ' unreachable: ' + ((e && e.message) || String(e)) };
  }
}

module.exports = {
  configure, start, stop, agents, status, forwardCommand,
  // exposed for unit tests (no network needed)
  _test: {
    mergeSnapshot, fleetId, normalizePeer, resolveTarget, pollAll,
    peers: () => peers,
    reset: () => { stop(); peers = []; intervalMs = DEFAULT_INTERVAL_MS; liveDeps = null; },
  },
};
