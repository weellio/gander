#!/usr/bin/env node
// Hivemind — hook emitter (+ operator command return channel).
//
// Reads a Claude Code hook payload from stdin, forwards it to the bridge's
// /api/hook endpoint, and — if the bridge has a queued operator command for
// this session — prints the corresponding hook-control JSON to stdout so the
// running agent acts on it:
//   • Stop event + queued 'message' -> {"decision":"block","reason": "<text>"}
//       (the agent doesn't stop; it continues with the operator's instruction)
//   • PreToolUse event + queued 'stop' -> permissionDecision "deny"
//       (halts the next tool so a busy agent pauses)
//
// Never blocks Claude: if the bridge is down/slow it just exits 0 silently.

const http = require('http');

let data = '';
process.stdin.on('data', (c) => { data += c; if (data.length > 1e6) process.stdin.destroy(); });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  const port = process.env.AOC_PORT || 3131;
  const payload = data || '{}';
  const req = http.request(
    {
      host: 'localhost', port, path: '/api/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 1500,
    },
    (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          const d = j && j.deliver;
          if (d && d.kind === 'stop-block') {
            process.stdout.write(JSON.stringify({ decision: 'block', reason: d.text }));
          } else if (d && d.kind === 'pretool-deny') {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: d.text,
              },
            }));
          }
        } catch (_) { /* ignore */ }
        process.exit(0);
      });
    }
  );
  req.on('error', () => process.exit(0));   // bridge down → no-op
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(payload);
});
