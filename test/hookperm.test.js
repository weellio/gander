// PermissionRequest hook round-trip: emit.js parks on the bridge's long-poll
// and prints Claude's decision JSON once a human answers in the rail.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const EMIT = path.join(__dirname, '..', 'hooks', 'emit.js');

function fakeBridge(script) {
  return new Promise((resolve) => {
    let polls = 0;
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/api/hook') return send({ ok: true, pending: true, requestId: 'toolu_1' });
      if (u.pathname === '/api/hook-permission/wait') { polls++; return send(script(polls, u.searchParams.get('requestId'))); }
      send({});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, polls: () => polls }));
  });
}

function runEmit(port, event) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [EMIT], { env: { ...process.env, AOC_PORT: String(port) } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(event));
  });
}

const EVENT = { session_id: 's1', hook_event_name: 'PermissionRequest', cwd: __dirname, tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'toolu_1' };

test('allow from the rail → emit prints an allow decision for Claude', async () => {
  const b = await fakeBridge((n) => (n < 2 ? { pending: true } : { answered: true, behavior: 'allow', message: 'ok from rail' }));
  try {
    const r = await runEmit(b.port, EVENT);
    assert.strictEqual(r.code, 0);
    const j = JSON.parse(r.out);
    assert.deepStrictEqual(j, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: 'allow', decisionReason: 'ok from rail' } });
    assert.ok(b.polls() >= 2, 're-polls after a pending long-poll');
  } finally { b.srv.close(); }
});

test('deny from the rail → deny decision with a default reason', async () => {
  const b = await fakeBridge(() => ({ answered: true, behavior: 'deny' }));
  try {
    const r = await runEmit(b.port, EVENT);
    const j = JSON.parse(r.out);
    assert.strictEqual(j.hookSpecificOutput.decision, 'deny');
    assert.match(j.hookSpecificOutput.decisionReason, /Gander/);
  } finally { b.srv.close(); }
});

test('request expired on the bridge → prints nothing (Claude falls back to its own prompt)', async () => {
  const b = await fakeBridge(() => ({ gone: true }));
  try {
    const r = await runEmit(b.port, EVENT);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out.trim(), '');
  } finally { b.srv.close(); }
});

test('no bridge at all → exits clean and silent, never blocks Claude', async () => {
  const r = await runEmit(1, EVENT); // nothing listens on port 1
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.trim(), '');
});
