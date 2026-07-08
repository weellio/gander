'use strict';
// test/dispatch.test.js — tests for bridge/dispatch.js (pure line-classifier;
// no CLI is spawned). The stream shapes here are copied from a real
// claude 2.1.66 run (see the dispatch probe documented in the README).

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const dispatch = require('../bridge/dispatch.js');
const { handleLine, buildArgs, projectFromCwd } = dispatch._test;

function mkSess(over = {}) {
  return {
    key: 'dispatch-1', sessionId: null, cwd: 'C:\\proj\\demo', project: 'demo',
    proc: null, buf: '', pending: new Map(), busy: true, announced: false,
    startedAt: Date.now(), model: null, lastResult: null, exited: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Exported surface
// ---------------------------------------------------------------------------
describe('dispatch exports', () => {
  test('exports the hosted-session API', () => {
    for (const fn of ['init', 'start', 'send', 'interrupt', 'stop', 'answerPermission', 'get', 'isHosted', 'pendingList', 'list', 'rateLimit']) {
      assert.equal(typeof dispatch[fn], 'function', fn + ' must be exported');
    }
  });
});

// ---------------------------------------------------------------------------
// buildArgs — bidirectional stream-json + stdio permission prompting
// ---------------------------------------------------------------------------
describe('buildArgs()', () => {
  test('always requests bidirectional stream-json with the stdio permission tool', () => {
    const a = buildArgs({});
    assert.ok(a.includes('-p'));
    assert.deepEqual(a.slice(a.indexOf('--input-format'), a.indexOf('--input-format') + 2), ['--input-format', 'stream-json']);
    assert.deepEqual(a.slice(a.indexOf('--output-format'), a.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
    assert.deepEqual(a.slice(a.indexOf('--permission-prompt-tool'), a.indexOf('--permission-prompt-tool') + 2), ['--permission-prompt-tool', 'stdio']);
  });
  test('maps permission modes', () => {
    assert.ok(buildArgs({ permMode: 'bypass' }).includes('--dangerously-skip-permissions'));
    const ae = buildArgs({ permMode: 'acceptEdits' });
    assert.equal(ae[ae.indexOf('--permission-mode') + 1], 'acceptEdits');
    const pl = buildArgs({ permMode: 'plan' });
    assert.equal(pl[pl.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(!buildArgs({}).includes('--permission-mode'), 'default mode adds no flag');
  });
  test('adds --resume only for a safe session id', () => {
    const r = buildArgs({ resume: 'abc-123' });
    assert.equal(r[r.indexOf('--resume') + 1], 'abc-123');
    assert.ok(!buildArgs({ resume: 'x; rm -rf /' }).includes('--resume'), 'unsafe resume id is dropped');
  });
});

// ---------------------------------------------------------------------------
// handleLine — the stream classifier (shapes from a real 2.1.66 run)
// ---------------------------------------------------------------------------
describe('handleLine()', () => {
  let sess;
  beforeEach(() => { sess = mkSess(); });

  test('system/init captures the session id and announces the root once', () => {
    const out = handleLine(sess, { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'claude-haiku' });
    assert.equal(sess.sessionId, 'sid-1');
    assert.equal(sess.model, 'claude-haiku');
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0].agentId, 'sess:sid-1');
    assert.equal(out.events[0].state, 'thinking');
    assert.equal(out.events[0].dispatch, true);
    assert.equal(out.events[0].root, true);
    // init re-arrives at each turn start — must not re-announce
    const again = handleLine(sess, { type: 'system', subtype: 'init', session_id: 'sid-1' });
    assert.equal(again.events.length, 0);
  });

  test('assistant tool_use maps to a dashboard state with detail', () => {
    handleLine(sess, { type: 'system', subtype: 'init', session_id: 'sid-1' });
    const out = handleLine(sess, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a/b.js', content: 'x' } }] } });
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0].state, 'coding');
    assert.match(out.events[0].log, /b\.js/);
  });

  test('assistant text becomes the live lastMessage', () => {
    handleLine(sess, { type: 'system', subtype: 'init', session_id: 'sid-1' });
    const out = handleLine(sess, { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it now.' }] } });
    assert.equal(out.events[0].lastMessage, 'Working on it now.');
  });

  test('can_use_tool control request registers a pending permission and flips to awaiting', () => {
    handleLine(sess, { type: 'system', subtype: 'init', session_id: 'sid-1' });
    const out = handleLine(sess, {
      type: 'control_request', request_id: 'req-9',
      request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'probe.txt', content: 'hi' }, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], tool_use_id: 'toolu_1' },
    });
    assert.ok(out.permission, 'permission signal returned');
    assert.equal(out.permission.requestId, 'req-9');
    assert.equal(out.permission.tool, 'Write');
    assert.equal(out.permission.suggestions.length, 1);
    assert.ok(sess.pending.has('req-9'), 'pending map holds the request');
    const ev = out.events.find((e) => e.state === 'awaiting');
    assert.ok(ev, 'awaiting event emitted');
    assert.match(ev.awaitMsg, /needs permission: Write/);
  });

  test('unknown control requests are answered with an error (never left hanging)', () => {
    const out = handleLine(sess, { type: 'control_request', request_id: 'req-x', request: { subtype: 'something_new' } });
    assert.equal(out.responses.length, 1);
    assert.equal(out.responses[0].type, 'control_response');
    assert.equal(out.responses[0].response.subtype, 'error');
    assert.equal(out.responses[0].response.request_id, 'req-x');
  });

  test('rate_limit_event is surfaced and cached', () => {
    const info = { status: 'allowed', resetsAt: 1783561200, rateLimitType: 'five_hour' };
    const out = handleLine(sess, { type: 'rate_limit_event', rate_limit_info: info });
    assert.equal(out.rateLimit.rateLimitType, 'five_hour');
    assert.equal(dispatch.rateLimit().resetsAt, 1783561200);
    assert.ok(dispatch.rateLimit().at > 0, 'stamped with a local time');
  });

  test('result marks the turn done and parks the tile idle with the final message', () => {
    handleLine(sess, { type: 'system', subtype: 'init', session_id: 'sid-1' });
    const out = handleLine(sess, { type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 7848, total_cost_usd: 0.03, result: 'Done! All good.' });
    assert.equal(sess.busy, false);
    assert.equal(sess.lastResult.ok, true);
    assert.equal(out.events[0].state, 'idle');
    assert.equal(out.events[0].lastMessage, 'Done! All good.');
  });

  test('error result flips the tile to error', () => {
    handleLine(sess, { type: 'system', subtype: 'init', session_id: 'sid-1' });
    const out = handleLine(sess, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' });
    assert.equal(out.events[0].state, 'error');
  });

  test('tool_result errors surface as error state', () => {
    handleLine(sess, { type: 'system', subtype: 'init', session_id: 'sid-1' });
    const out = handleLine(sess, { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Denied by operator' }] } });
    assert.equal(out.events[0].state, 'error');
    assert.match(out.events[0].log, /Denied/);
  });

  test('garbage lines are ignored', () => {
    assert.deepEqual(handleLine(sess, null).events, []);
    assert.deepEqual(handleLine(sess, 'nope').events, []);
    assert.deepEqual(handleLine(sess, { type: 'mystery' }).events, []);
  });
});

// ---------------------------------------------------------------------------
// helpers + guardrails on the public API when nothing is hosted
// ---------------------------------------------------------------------------
describe('module behavior without live sessions', () => {
  test('projectFromCwd basename', () => {
    assert.equal(projectFromCwd('C:\\a\\b\\myproj'), 'myproj');
    assert.equal(projectFromCwd('/x/y/z'), 'z');
    assert.equal(projectFromCwd(''), 'unknown');
  });
  test('send/interrupt/answerPermission refuse unknown sessions', () => {
    assert.ok(dispatch.send('nope', 'hi').error);
    assert.ok(dispatch.interrupt('nope').error);
    assert.ok(dispatch.answerPermission('nope', 'r1', { behavior: 'allow' }).error);
    assert.equal(dispatch.isHosted('nope'), false);
  });
  test('start() requires a cwd and a goal', () => {
    assert.ok(dispatch.start({}).error);
    assert.ok(dispatch.start({ cwd: 'C:\\x' }).error, 'goal-less dispatch is refused (terminal is the right tool there)');
  });
  test('pendingList/list are arrays', () => {
    assert.ok(Array.isArray(dispatch.pendingList()));
    assert.ok(Array.isArray(dispatch.list()));
  });
});
