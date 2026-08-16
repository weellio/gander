// Slack Socket Mode — a zero-dependency inbound channel.
//
// The bridge already mirrors alerts OUT to a Slack incoming webhook; this
// module adds the other direction without adding a dependency: a minimal
// WebSocket CLIENT (RFC 6455 over TLS) speaking Slack's Socket Mode.
//
//   apps.connections.open (app-level xapp- token)  ->  one-shot wss:// URL
//   connect, ack every envelope, surface message / slash-command payloads
//
// Frame notes: server->client frames arrive unmasked; client->server frames
// MUST be masked. We only ever send small text frames (<126 bytes is not
// guaranteed — acks are tiny but be correct for 16-bit lengths anyway).

'use strict';

const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

// ── Slack Web API helper (Bearer token) ──────────────────────────────────────
function api(token, method, body, cb) {
  const payload = JSON.stringify(body || {});
  const req = https.request({
    host: 'slack.com', path: '/api/' + method, method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + token, 'Content-Length': Buffer.byteLength(payload) },
    timeout: 8000,
  }, (res) => {
    let b = ''; res.on('data', (d) => (b += d));
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} if (cb) cb(j && j.ok ? null : new Error((j && j.error) || 'bad response'), j); });
  });
  req.on('error', (e) => { if (cb) cb(e); });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.end(payload);
}

// ── WebSocket framing (the parts Socket Mode needs) ──────────────────────────
// Encode one masked client frame. opcode: 1 text, 8 close, 9 ping, 10 pong.
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2); header[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);   // FIN + opcode (no fragmentation outbound)
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// Pull complete frames off an accumulating buffer. Returns { frames, rest }.
// Handles unmasked AND masked payloads (servers send unmasked; be liberal).
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const maskBit = !!(b1 & 0x80);
    let len = b1 & 0x7f, hl = 2;
    if (len === 126) { if (buf.length - off < 4) break; len = buf.readUInt16BE(off + 2); hl = 4; }
    else if (len === 127) { if (buf.length - off < 10) break; len = Number(buf.readBigUInt64BE(off + 2)); hl = 10; }
    const total = hl + (maskBit ? 4 : 0) + len;
    if (buf.length - off < total) break;
    let payload = buf.slice(off + hl + (maskBit ? 4 : 0), off + total);
    if (maskBit) {
      const mask = buf.slice(off + hl, off + hl + 4);
      const un = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i++) un[i] = payload[i] ^ mask[i & 3];
      payload = un;
    }
    frames.push({ opcode, payload, fin: !!(b0 & 0x80) });
    off += total;
  }
  return { frames, rest: buf.slice(off) };
}

// ── Socket Mode connection ───────────────────────────────────────────────────
// startSocket({ appToken, onEvent, log }) -> { stop() }
// onEvent(kind, payload, envelope) — kind: 'message' | 'slash' ; called only
// for real human input (bot echoes and message edits are dropped here).
function startSocket(opts) {
  const log = opts.log || (() => {});
  let sock = null, stopped = false, backoff = 2000, pingTimer = null;

  function reconnect(ms) {
    if (stopped) return;
    clearInterval(pingTimer);
    setTimeout(open, ms);
  }

  function open() {
    if (stopped) return;
    api(opts.appToken, 'apps.connections.open', {}, (err, j) => {
      if (err || !j || !j.url) {
        log('connections.open failed: ' + (err ? err.message : 'no url') + ' — retrying');
        backoff = Math.min(backoff * 2, 60000);
        return reconnect(backoff);
      }
      let u; try { u = new URL(j.url); } catch (_) { return reconnect(5000); }
      const key = crypto.randomBytes(16).toString('base64');
      let buf = Buffer.alloc(0), upgraded = false, headerBuf = '';
      sock = tls.connect({ host: u.hostname, port: 443, servername: u.hostname }, () => {
        sock.write(
          'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
          'Host: ' + u.hostname + '\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      sock.setTimeout(0);
      sock.on('data', (chunk) => {
        if (!upgraded) {
          headerBuf += chunk.toString('latin1');
          const end = headerBuf.indexOf('\r\n\r\n');
          if (end === -1) return;
          if (!/^HTTP\/1\.1 101/.test(headerBuf)) { log('upgrade refused: ' + headerBuf.slice(0, 60)); sock.destroy(); return; }
          upgraded = true; backoff = 2000;
          log('socket connected');
          // the body after the 101 header is already websocket frames
          buf = Buffer.from(headerBuf.slice(end + 4), 'latin1');
          headerBuf = '';
          chunk = Buffer.alloc(0);
          // keepalive: Slack disconnects quiet sockets; ping every 30s
          pingTimer = setInterval(() => { try { sock.write(encodeFrame(9, 'ka')); } catch (_) {} }, 30000);
        }
        buf = Buffer.concat([buf, chunk]);
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          if (f.opcode === 9) { try { sock.write(encodeFrame(10, f.payload)); } catch (_) {} continue; }   // ping -> pong
          if (f.opcode === 8) { try { sock.destroy(); } catch (_) {} continue; }                            // close
          if (f.opcode !== 1) continue;
          let env = null; try { env = JSON.parse(f.payload.toString('utf8')); } catch (_) { continue; }
          handleEnvelope(env);
        }
      });
      sock.on('error', (e) => log('socket error: ' + e.message));
      sock.on('close', () => { clearInterval(pingTimer); if (!stopped) { log('socket closed — reconnecting'); reconnect(backoff); } });
    });
  }

  function ack(envelopeId, responsePayload) {
    const body = responsePayload ? { envelope_id: envelopeId, payload: responsePayload } : { envelope_id: envelopeId };
    try { sock.write(encodeFrame(1, JSON.stringify(body))); } catch (_) {}
  }

  function handleEnvelope(env) {
    if (!env || !env.type) return;
    if (env.type === 'hello') return;
    if (env.type === 'disconnect') { log('server asked to reconnect (' + (env.reason || '') + ')'); try { sock.destroy(); } catch (_) {} return; }
    if (env.envelope_id) ack(env.envelope_id);   // ack FIRST — Slack redelivers unacked envelopes
    if (env.type === 'slash_commands' && env.payload) {
      opts.onEvent('slash', env.payload, env);
    } else if (env.type === 'events_api' && env.payload && env.payload.event) {
      const ev = env.payload.event;
      // only fresh human messages: no bot echoes, no edits/joins/etc.
      if (ev.type === 'message' && !ev.bot_id && !ev.subtype && ev.text) opts.onEvent('message', ev, env);
    }
  }

  open();
  return { stop() { stopped = true; clearInterval(pingTimer); try { sock && sock.destroy(); } catch (_) {} } };
}

module.exports = { api, startSocket, encodeFrame, decodeFrames };
