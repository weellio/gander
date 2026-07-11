'use strict';
// test/patterns.test.js — tests for bridge/patterns.js (prompt-habit buckets +
// skill usage). Fixture transcripts are written to a temp dir passed via
// opts.root; never touches the real ~/.claude.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const patterns = require('../bridge/patterns.js');

// ---------------------------------------------------------------------------
// classifyPrompt — bucket rules (samples straight from real sessions)
// ---------------------------------------------------------------------------
describe('classifyPrompt', () => {
  test('approval-only turns', () => {
    for (const t of ['yes', 'yes.', 'Yup', 'go', 'go for it', 'do it all.', 'sure', 'ok', 'proceed', 'keep going', 'all of the above', 'build both', 'make it so', '2']) {
      assert.equal(patterns.classifyPrompt(t), 'approval', `"${t}" should be approval`);
    }
  });
  test('keep-alive pokes', () => {
    for (const t of ['still going?', 'did you fall asleep?', 'you there?', 'everything running smoothly?', 'why are you not using multiple agents?', "it's idle, not running,..."]) {
      assert.equal(patterns.classifyPrompt(t), 'keepalive', `"${t}" should be keepalive`);
    }
  });
  test('correction turns', () => {
    for (const t of ["i don't see the change", 'no worky', "i refreshed and opened another browser and still don't see the additions.", "that wasn't run against the stop slop. i can see several emdashes."]) {
      const k = patterns.classifyPrompt(t);
      assert.ok(k === 'correction' || k === 'slop', `"${t}" should be correction-ish, got ${k}`);
    }
  });
  test('pasted errors', () => {
    assert.equal(patterns.classifyPrompt('mazegen.js:13 Uncaught ReferenceError: root is not defined'), 'errpaste');
    assert.equal(patterns.classifyPrompt('PS D:\\Files\\sourcecode\\SEO> run_web.bat : The term is not recognized'), 'errpaste');
    assert.equal(patterns.classifyPrompt('index.html:1 Failed to load resource: net::ERR_FAILED'), 'errpaste');
  });
  test('pasted transcripts (long + timestamped)', () => {
    const long = 'anything useful here? ' + '[0:00] intro stuff [0:05] more stuff [0:12] and more '.repeat(30);
    assert.equal(patterns.classifyPrompt(long), 'paste');
  });
  test('docs / github asks', () => {
    assert.equal(patterns.classifyPrompt('did you update the readme and help modals? and upload to github'), 'docs');
    assert.equal(patterns.classifyPrompt('has it been pushed to github?'), 'docs');
    assert.equal(patterns.classifyPrompt('can you update the FAQ as to why we didn\'t integrate these'), 'docs');
  });
  test('slop + restart asks', () => {
    assert.equal(patterns.classifyPrompt('run your replies through stop slop skill'), 'slop');
    assert.equal(patterns.classifyPrompt('restart the server so i can see the new updates'), 'restart');
  });
  test('normal work prompts are unclassified', () => {
    for (const t of ['make the side bars grow and shrink.', 'level 14 doesn\'t seem right, add a hint button', 'add a suprise me button in the sandbox']) {
      assert.equal(patterns.classifyPrompt(t), null, `"${t}" should be null`);
    }
  });
  test('a long goal prompt starting with yes is not approval', () => {
    assert.equal(patterns.classifyPrompt('yes lets run some tests and find a solution that will make this a useful addition'), null);
  });
});

// ---------------------------------------------------------------------------
// userText / isInjected — typed-by-a-human filtering
// ---------------------------------------------------------------------------
describe('typed-prompt filtering', () => {
  test('userText reads string and block content, ignores tool_result blocks', () => {
    assert.equal(patterns.userText({ content: ' hi ' }), 'hi');
    assert.equal(patterns.userText({ content: [{ type: 'text', text: 'a' }, { type: 'tool_result', content: 'noise' }] }), 'a');
    assert.equal(patterns.userText({ content: [{ type: 'tool_result', content: 'noise' }] }), '');
  });
  test('isInjected drops harness messages', () => {
    for (const t of ['<task-notification> x', '<system-reminder>y', 'This session is being continued from a previous conversation', '[Request interrupted by user]']) {
      assert.ok(patterns.isInjected(t), t);
    }
    assert.ok(!patterns.isInjected('normal prompt'));
  });
});

// ---------------------------------------------------------------------------
// scan — end-to-end over a fixture transcript tree
// ---------------------------------------------------------------------------
describe('scan', () => {
  let root;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-patterns-'));
    const dir = path.join(root, 'd--proj-alpha');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const L = (o) => JSON.stringify(o);
    const lines = [
      L({ type: 'user', cwd: 'D:/proj/alpha', timestamp: now, message: { role: 'user', content: 'build me a parser for the config' } }),
      L({ type: 'user', timestamp: now, message: { role: 'user', content: 'yes' } }),
      L({ type: 'user', timestamp: now, message: { role: 'user', content: 'still going?' } }),
      L({ type: 'user', timestamp: now, message: { role: 'user', content: "i don't see the change" } }),
      L({ type: 'user', timestamp: now, message: { role: 'user', content: '<task-notification> agent done </task-notification>' } }),
      L({ type: 'user', timestamp: now, isMeta: true, message: { role: 'user', content: 'meta noise' } }),
      L({ type: 'user', timestamp: now, message: { role: 'user', content: '<command-name>/stop-slop</command-name> <command-args>x</command-args>' } }),
      L({ type: 'assistant', timestamp: now, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'make-game' } }] } }),
      L({ type: 'assistant', timestamp: now, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    ];
    fs.writeFileSync(path.join(dir, 'sess1.jsonl'), lines.join('\n') + '\n');
  });
  after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });

  test('counts typed prompts only and buckets them', async () => {
    const r = await patterns.scan({ days: 30, root });
    assert.equal(r.totals.prompts, 4, 'typed prompts: goal + yes + poke + correction');
    const by = Object.fromEntries(r.buckets.map((b) => [b.key, b.count]));
    assert.equal(by.approval, 1);
    assert.equal(by.keepalive, 1);
    assert.equal(by.correction, 1);
  });
  test('skill usage counts Skill tool calls and /commands, with lastUsed', async () => {
    const r = await patterns.scan({ days: 30, root });
    assert.equal(r.skillUsage['make-game'].count, 1);
    assert.equal(r.skillUsage['stop-slop'].count, 1);
    assert.ok(r.skillUsage['make-game'].lastUsed > 0);
    assert.ok(!r.skillUsage['ls'], 'plain Bash tool calls are not skills');
  });
  test('buckets carry pct + samples; suggestions stay quiet on tiny data', async () => {
    const r = await patterns.scan({ days: 30, root });
    const ap = r.buckets.find((b) => b.key === 'approval');
    assert.equal(ap.pct, 25);
    assert.equal(ap.samples.length, 1);
    assert.ok(Array.isArray(r.suggestions));
  });
  test('ignores files older than the window', async () => {
    const old = path.join(root, 'd--proj-old');
    fs.mkdirSync(old, { recursive: true });
    const p = path.join(old, 'old.jsonl');
    fs.writeFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: 'yes' } }) + '\n');
    const past = new Date(Date.now() - 90 * 86400e3);
    fs.utimesSync(p, past, past);
    const r = await patterns.scan({ days: 30, root });
    assert.equal(r.totals.prompts, 4, 'old transcript must not be scanned');
  });
});
