#!/usr/bin/env node
// Gander — hook emitter (+ operator command return channel + last-message capture).
//
// Forwards each Claude Code hook payload to the bridge's /api/hook. On the Stop
// event it also reads the last assistant message from the transcript and attaches
// it as `_lastMessage` so the dashboard can show what the agent just said (and you
// can reply with context). If the bridge has a queued operator command, prints the
// hook-control JSON so the running agent acts on it.
//
// Never blocks Claude: any failure just exits 0 silently.

const http = require('http');
const fs = require('fs');

function lastAssistantMessage(p) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      const msg = o.message || o;
      const isAssistant = o.type === 'assistant' || (msg && msg.role === 'assistant');
      if (!isAssistant) continue;
      const content = (msg && msg.content) || o.content;
      let text = '';
      if (Array.isArray(content)) text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
      else if (typeof content === 'string') text = content;
      if (text && text.trim()) return text.trim().slice(0, 2000);
    }
  } catch (_) {}
  return '';
}

let data = '';
process.stdin.on('data', (c) => { data += c; if (data.length > 1e6) process.stdin.destroy(); });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let payload = data || '{}';
  try {
    const obj = JSON.parse(payload);
    // Only the root 'Stop' gets a captured message. NOT 'SubagentStop': a sub-agent's
    // transcript_path is the MAIN transcript, which doesn't contain the sub-agent's own
    // output (verified empirically — it returned the PARENT's last message for every
    // sub-agent). Capturing sub-agent text needs the Agent tool result, not this hook.
    if (obj && obj.hook_event_name === 'Stop' && obj.transcript_path) {
      const lm = lastAssistantMessage(obj.transcript_path);
      if (lm) { obj._lastMessage = lm; payload = JSON.stringify(obj); }
    }
  } catch (_) {}

  const port = process.env.AOC_PORT || 3131;
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
              hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.text },
            }));
          }
        } catch (_) {}
        process.exit(0);
      });
    }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(payload);
});
