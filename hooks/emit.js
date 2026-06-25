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
const path = require('path');

// Find the last assistant text block in transcript lines (newest first).
function lastAssistantInLines(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }   // a partial tail line just fails → skip
    const msg = o.message || o;
    const isAssistant = o.type === 'assistant' || (msg && msg.role === 'assistant');
    if (!isAssistant) continue;
    const content = (msg && msg.content) || o.content;
    let text = '';
    if (Array.isArray(content)) text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
    else if (typeof content === 'string') text = content;
    if (text && text.trim()) return text.trim().slice(0, 2000);
  }
  return '';
}
function lastAssistantMessage(p) {
  try { return lastAssistantInLines(fs.readFileSync(p, 'utf8').split(/\r?\n/)); } catch (_) { return ''; }
}
// Tail-read only the last maxBytes — for the live sub-agent path, called per tool call.
function lastAssistantFromTail(p, maxBytes) {
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - (maxBytes || 200000));
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return lastAssistantInLines(buf.toString('utf8').split(/\r?\n/));
  } catch (_) { return ''; }
}
// A sub-agent writes to its own transcript: <main>.jsonl → <main>/subagents/agent-<id>.jsonl
function subAgentTranscript(mainPath, agentId) {
  return path.join(mainPath.replace(/\.jsonl$/i, ''), 'subagents', 'agent-' + agentId + '.jsonl');
}

let data = '';
process.stdin.on('data', (c) => { data += c; if (data.length > 1e6) process.stdin.destroy(); });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let payload = data || '{}';
  try {
    const obj = JSON.parse(payload);
    const ev = obj && obj.hook_event_name;
    const isSub = obj && obj.agent_id && obj.agent_id !== obj.session_id;
    if (ev === 'Stop' && obj.transcript_path) {
      // root turn end: last message from the main transcript
      const lm = lastAssistantMessage(obj.transcript_path);
      if (lm) { obj._lastMessage = lm; payload = JSON.stringify(obj); }
    } else if (isSub && (ev === 'PostToolUse' || ev === 'PostToolUseFailure') && obj.transcript_path) {
      // LIVE sub-agent capture: each sub-agent writes its own transcript, so tail THAT
      // file (derived from the main path + agent_id) for its latest narration. Per-agent
      // file = correct attribution even across a parallel swarm. (SubagentStop already
      // carries last_assistant_message directly, so it's handled bridge-side.)
      const lm = lastAssistantFromTail(subAgentTranscript(obj.transcript_path, obj.agent_id));
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
