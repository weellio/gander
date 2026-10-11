'use strict';
// web/src/lib/voice-intents.js — the hands-free grammar: wake word, project and
// session matching, and one spoken command -> an intent with what to say back.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let V;
test.before(async () => { V = await import(pathToFileURL(path.join(__dirname, '..', 'web', 'src', 'lib', 'voice-intents.js')).href); });

const projects = [{ name: 'Claude_Dashboard', path: 'D:/g' }, { name: 'WaivePulse', path: 'D:/w' }, { name: 'SEO', path: 'D:/s' }];
const sessions = [
  { id: 'sess:1', sessionId: '1', name: 'Moss', project: 'WaivePulse', state: 'awaiting', needsYou: true, awaitMsg: 'Use the venv?' },
  { id: 'sess:2', sessionId: '2', name: 'Roy', project: 'Claude_Dashboard', state: 'coding', needsYou: false },
  { id: 'sess:3', sessionId: '3', name: 'Jen', project: 'SEO', state: 'awaiting', needsYou: true, permId: 'p9' },
];
const ctx = { projects, sessions, currentProject: 'Claude_Dashboard' };

test('stripWake(): the wake word in its spellings, with and without a command', () => {
  assert.deepEqual(V.stripWake('Hey Gander, start a session'), { woke: true, rest: 'start a session' });
  assert.deepEqual(V.stripWake('hey ganda please open settings'), { woke: true, rest: 'open settings' });
  assert.deepEqual(V.stripWake('Yo gender status'), { woke: true, rest: 'status' });
  assert.deepEqual(V.stripWake('ok gander'), { woke: true, rest: '' });
  assert.equal(V.stripWake('start a session').woke, false, 'no wake word, no wake');
  assert.equal(V.stripWake('the gander is a goose').woke, false, 'wake word must lead');
  assert.deepEqual(V.stripWake('computer status', ['computer']), { woke: true, rest: 'status' }, 'a custom wake word');
});

test('matchProject(): spoken names map to project folders, "this project" means the current one', () => {
  assert.equal(V.matchProject('claude dashboard', projects).name, 'Claude_Dashboard');
  assert.equal(V.matchProject('wave pulse', projects).name, 'WaivePulse');
  assert.equal(V.matchProject('the dashboard', projects), null, 'a word inside a name is not a match on its own... unless unique');
  assert.equal(V.matchProject('dashboard', projects).name, 'Claude_Dashboard', 'a contained word matches when nothing better exists');
  assert.deepEqual(V.matchProject('this project', projects), { current: true });
  assert.equal(V.matchProject('nothing like it', projects), null);
});

test('start: project and goal come out of the sentence in either order', () => {
  let i = V.parse('start a new session in waivepulse and make a report of this', ctx);
  assert.equal(i.kind, 'start'); assert.equal(i.project.name, 'WaivePulse'); assert.equal(i.goal, 'make a report of this'); assert.equal(i.needsConfirm, true);
  assert.match(i.say, /Start a session in WaivePulse to make a report of this\?/);
  i = V.parse('start a session to fix the failing tests in claude dashboard', ctx);
  assert.equal(i.project.name, 'Claude_Dashboard'); assert.equal(i.goal, 'fix the failing tests');
  i = V.parse('new session write the release notes', ctx);
  assert.equal(i.project, null); assert.equal(i.goal, 'write the release notes'); assert.match(i.say, /Claude_Dashboard/, 'falls back to the current project');
  i = V.parse('start a session', ctx);
  assert.equal(i.ask, 'goal');
  i = V.parse('launch a session in this project and tidy the readme', ctx);
  assert.deepEqual(i.project, { current: true }); assert.equal(i.goal, 'tidy the readme');
});

test('queue, reply, stop, allow, deny', () => {
  let i = V.parse('queue a task in seo audit the top ten leads', ctx);
  assert.equal(i.kind, 'queue'); assert.equal(i.project.name, 'SEO'); assert.equal(i.goal, 'audit the top ten leads');
  i = V.parse('tell moss to use the venv', ctx);
  assert.equal(i.kind, 'reply'); assert.equal(i.session.name, 'Moss'); assert.equal(i.text, 'use the venv');
  i = V.parse('reply to waivepulse yes go ahead', ctx);
  assert.equal(i.session.name, 'Moss'); assert.equal(i.text, 'yes go ahead');
  i = V.parse('reply yes', ctx);
  assert.equal(i.kind, 'none', 'two sessions are waiting: it must ask who');
  assert.match(i.say, /Moss, Jen/);
  i = V.parse('stop roy', ctx);
  assert.equal(i.kind, 'stop'); assert.equal(i.session.name, 'Roy'); assert.equal(i.needsConfirm, true);
  i = V.parse('stop everything', ctx);
  assert.equal(i.kind, 'stop-all');
  i = V.parse('allow it', ctx);
  assert.equal(i.kind, 'allow'); assert.equal(i.session.name, 'Jen', 'the one with a pending permission');
  i = V.parse('deny', ctx);
  assert.equal(i.kind, 'deny');
  i = V.parse('allow', { ...ctx, sessions: sessions.filter((s) => !s.permId) });
  assert.equal(i.kind, 'none');
});

test('status, needs, panels, views, mute, help, unknown', () => {
  assert.equal(V.parse("what's running", ctx).kind, 'status');
  assert.equal(V.parse('who needs me', ctx).kind, 'needs');
  let i = V.parse('open settings', ctx); assert.equal(i.kind, 'panel'); assert.equal(i.panel, 'config');
  i = V.parse('show me the task queue', ctx); assert.equal(i.panel, 'queue');
  i = V.parse('open the usage panel', ctx); assert.equal(i.panel, 'usage');
  i = V.parse('show mosaic', ctx); assert.equal(i.kind, 'view'); assert.equal(i.view, 'mosaic');
  i = V.parse('show me roy', ctx); assert.equal(i.kind, 'focus'); assert.equal(i.session.name, 'Roy');
  i = V.parse('mute seo', ctx); assert.equal(i.kind, 'mute'); assert.equal(i.project.name, 'SEO');
  i = V.parse('mute', ctx); assert.equal(i.kind, 'mute-sound');
  assert.equal(V.parse('help', ctx).kind, 'help');
  i = V.parse('make me a sandwich', ctx); assert.equal(i.kind, 'none'); assert.match(i.say, /did not understand/);
});

test('isYes / isNo and the spoken summaries', () => {
  assert.equal(V.isYes('yes please'), true); assert.equal(V.isYes('go ahead'), true); assert.equal(V.isYes('nope'), false);
  assert.equal(V.isNo('never mind'), true); assert.equal(V.isNo('cancel'), true);
  assert.match(V.statusSentence(sessions), /3 sessions open: 2 awaiting, 1 coding\. 2 need you: Moss, Jen\./);
  assert.equal(V.statusSentence([]), 'No sessions are open.');
  assert.match(V.needsSentence(sessions), /Moss: Use the venv\?\. Jen\./);
  assert.equal(V.needsSentence([sessions[1]]), 'Nothing needs you right now.');
});
