#!/usr/bin/env node
// Agent Ops Center — stream-json parser (zero dependencies).
//
// Converts Claude Code's `claude --output-format stream-json --verbose`
// output (newline-delimited JSON, one object per line) into agent lifecycle
// events the dashboard understands, then POSTs them to the bridge server's
// /api/event endpoint.
//
//   claude --output-format stream-json --verbose | node bridge/parser.js
//   claude ... | node bridge/parser.js --port 3131
//
// Event shape (matches server.js upsert contract):
//   { agentId, state?, name?, detail?, log?, parentId? }
//
// Exports (CommonJS):
//   parseLine(line, state)  -> array of events; `state` is a mutable context obj
//   createParser()          -> { parse(line) } closing over its own state
//
// Tool -> dashboard-state mapping:
//   Read/Glob/LS/Grep/WebSearch/WebFetch  -> reading
//   Write/Edit/MultiEdit                  -> coding
//   Bash                                  -> coding (testing if cmd/path smells of tests)
//   Task                                  -> spawning (also emits a child spawn event)
//   assistant text, no tool_use           -> thinking
//   is_error / result error subtype       -> error
//   result success                        -> done

'use strict';

const http = require('http');

// ── Tool → state mapping ─────────────────────────────────────────────────────
const READING_TOOLS = new Set(['Read', 'Glob', 'LS', 'Grep', 'WebSearch', 'WebFetch']);
const CODING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// Heuristic: does a Bash command / path look like it runs tests?
const TEST_RE = /\b(test|tests|jest|pytest|vitest|mocha|spec|unittest|phpunit|go test)\b/i;

/**
 * Pick a dashboard state for a tool_use item.
 * @returns {string} one of the dashboard states
 */
function stateForTool(name, input) {
  if (CODING_TOOLS.has(name)) return 'coding';
  if (READING_TOOLS.has(name)) return 'reading';
  if (name === 'Task') return 'spawning';
  if (name === 'Bash') {
    const cmd = input && (input.command || input.cmd || '');
    if (cmd && TEST_RE.test(String(cmd))) return 'testing';
    return 'coding';
  }
  // Unknown tools default to reading (a benign "looking at something" state).
  return 'reading';
}

// ── Detail / log helpers ─────────────────────────────────────────────────────
function truncate(str, max) {
  if (str == null) return '';
  str = String(str).replace(/\s+/g, ' ').trim();
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

/** Build a short human "detail" string for a tool_use. */
function detailForTool(name, input) {
  input = input || {};
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return `${name} ${truncate(input.file_path || input.path || '', 60)}`.trim();
    case 'Bash':
      return truncate(input.command || input.cmd || 'bash', 80);
    case 'Grep':
      return `grep ${truncate(input.pattern || '', 50)}`.trim();
    case 'Glob':
      return `glob ${truncate(input.pattern || '', 50)}`.trim();
    case 'LS':
      return `ls ${truncate(input.path || '', 50)}`.trim();
    case 'WebSearch':
      return `search ${truncate(input.query || '', 50)}`.trim();
    case 'WebFetch':
      return `fetch ${truncate(input.url || '', 50)}`.trim();
    case 'Task':
      return truncate(input.description || input.prompt || 'sub-agent', 60);
    default:
      return truncate(name, 60);
  }
}

/** Name for a spawned sub-agent from a Task tool_use. */
function taskChildName(input) {
  input = input || {};
  return truncate(
    input.subagent_type || input.description || input.name || 'sub-agent',
    40
  ) || 'sub-agent';
}

// ── Core parser ──────────────────────────────────────────────────────────────
/**
 * Parse one raw stream-json line into an array of dashboard events.
 * Blank or non-JSON lines yield [].
 *
 * @param {string} line  one raw JSON string
 * @param {object} state mutable context: { sessionId, taskSeq, children:{} }
 * @returns {Array<object>} events { agentId, state?, name?, detail?, log?, parentId? }
 */
function parseLine(line, state) {
  if (!state.taskSeq) state.taskSeq = 0;
  if (!state.children) state.children = {};

  if (line == null) return [];
  const trimmed = String(line).trim();
  if (!trimmed) return [];

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (e) {
    return []; // not JSON — ignore (e.g. plain log noise)
  }
  if (!msg || typeof msg !== 'object') return [];

  const sid = msg.session_id || state.sessionId;
  if (msg.session_id) state.sessionId = msg.session_id;

  const events = [];

  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        events.push({
          agentId: sid,
          state: 'idle',
          name: msg.model ? `Claude (${msg.model})` : 'Claude',
          detail: 'session started',
          log: `init ${msg.model || ''}`.trim(),
        });
      }
      break;
    }

    case 'assistant': {
      const content =
        msg.message && Array.isArray(msg.message.content)
          ? msg.message.content
          : [];
      const toolUses = content.filter((c) => c && c.type === 'tool_use');
      const texts = content.filter((c) => c && c.type === 'text' && c.text && c.text.trim());

      if (toolUses.length === 0) {
        // Pure thinking/narration turn.
        if (texts.length) {
          events.push({
            agentId: sid,
            state: 'thinking',
            detail: truncate(texts.map((t) => t.text).join(' '), 80),
            log: truncate(texts.map((t) => t.text).join(' '), 120),
          });
        } else {
          events.push({ agentId: sid, state: 'thinking' });
        }
        break;
      }

      for (const tu of toolUses) {
        const tName = tu.name || 'tool';
        const tInput = tu.input || {};
        const tState = stateForTool(tName, tInput);
        events.push({
          agentId: sid,
          state: tState,
          detail: detailForTool(tName, tInput),
          log: detailForTool(tName, tInput),
        });

        if (tName === 'Task') {
          // Map the tool_use id -> child agent id so we can correlate later.
          state.taskSeq += 1;
          const childId = `${sid}::task${state.taskSeq}`;
          if (tu.id) state.children[tu.id] = childId;
          events.push({
            agentId: childId,
            parentId: sid,
            name: taskChildName(tInput),
            state: 'spawning',
            detail: detailForTool('Task', tInput),
            log: 'spawned by ' + (sid || 'parent'),
          });
        }
      }
      break;
    }

    case 'user': {
      // tool_result(s) coming back — surface errors, otherwise just a log ping.
      const content =
        msg.message && Array.isArray(msg.message.content)
          ? msg.message.content
          : [];
      for (const c of content) {
        if (!c || c.type !== 'tool_result') continue;
        const childId = c.tool_use_id && state.children[c.tool_use_id];
        const targetId = childId || sid;
        if (c.is_error) {
          events.push({
            agentId: targetId,
            state: 'error',
            detail: 'tool failed',
            log: truncate(resultText(c.content), 120) || 'tool error',
          });
        } else {
          events.push({
            agentId: targetId,
            log: truncate(resultText(c.content), 120) || 'tool ok',
          });
        }
      }
      break;
    }

    case 'result': {
      const isError = msg.is_error === true || (msg.subtype && msg.subtype !== 'success');
      events.push({
        agentId: sid,
        state: isError ? 'error' : 'done',
        detail: isError ? (msg.subtype || 'error') : 'complete',
        log: truncate(msg.result || msg.subtype || (isError ? 'error' : 'done'), 120),
      });
      break;
    }

    default:
      // unknown line type — ignore
      break;
  }

  return events;
}

/** Flatten a tool_result `content` field (string or array of blocks) to text. */
function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' ? b.text || '' : String(b)))
      .join(' ');
  }
  if (typeof content === 'object') return content.text || '';
  return String(content);
}

/**
 * Stateful parser. Each call to parse() feeds one line and returns its events.
 * @returns {{ parse: (line: string) => Array<object> }}
 */
function createParser() {
  const state = { sessionId: null, taskSeq: 0, children: {} };
  return {
    parse(line) {
      return parseLine(line, state);
    },
  };
}

module.exports = { parseLine, createParser, stateForTool, detailForTool };

// ── CLI mode ─────────────────────────────────────────────────────────────────
function getPort() {
  const i = process.argv.indexOf('--port');
  if (i !== -1) {
    const p = parseInt(process.argv[i + 1], 10);
    if (!Number.isNaN(p)) return p;
  }
  return 3131;
}

function postEvent(port, ev) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(ev));
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: '/api/event',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        res.resume(); // drain
        res.on('end', resolve);
      }
    );
    req.on('error', (err) => {
      // Don't crash the pipe if the bridge isn't up; just warn once-ish.
      process.stderr.write(`[parser] POST failed: ${err.message}\n`);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

function runCli() {
  const port = getPort();
  const parser = createParser();
  let buf = '';

  process.stderr.write(`[parser] piping events -> http://localhost:${port}/api/event\n`);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const events = parser.parse(line);
      for (const ev of events) postEvent(port, ev);
    }
  });

  process.stdin.on('end', () => {
    if (buf.trim()) {
      const events = parser.parse(buf);
      for (const ev of events) postEvent(port, ev);
    }
  });
}

if (require.main === module) {
  runCli();
}
