'use strict';
// bridge/floor.js: the floor at a glance for a phone, Telegram or a claude.ai tool.
const test = require('node:test');
const assert = require('node:assert');
const floor = require('../bridge/floor.js');

const NOW = 1_800_000_000_000;
const min = (n) => NOW - n * 60000;
const agents = () => [
  { id: 'sess:a1', sessionId: 'a1', root: true, project: 'shop', name: 'shop', state: 'coding', updatedAt: min(1), costUSD: 1.234, logLines: ['editing cart.js'] },
  { id: 'sess:b2', sessionId: 'b2', root: true, project: 'blog', name: 'blog', state: 'idle', updatedAt: min(25), costUSD: 0.5, lastMessage: 'Done. Tests pass.' },
  { id: 'sess:c3', sessionId: 'c3', root: true, project: 'api', name: 'api', state: 'idle', updatedAt: min(4), goal: 'add auth', lastMessage: 'Should I use JWT or sessions?' },
  { id: 'sess:d4', sessionId: 'd4', root: true, project: 'docs', name: 'docs', state: 'awaiting', updatedAt: min(2), awaitMsg: 'Allow rm -rf dist?' },
  { id: 'sess:e5', sessionId: 'e5', root: true, project: 'old', state: 'idle', updatedAt: min(300), closed: true },
  { id: 'sub:x', sessionId: 'a1', root: false, state: 'running', updatedAt: min(0) },
  { id: 'desk', root: true, desktop: true, name: 'Claude Desktop', state: 'idle', updatedAt: min(90) },
];
const stalled = (a) => a.sessionId === 'c3';

test('rows(): one per open root session, needs-you first, then idle longest-first, then busy', () => {
  const r = floor.rows(agents(), NOW, { isStalled: stalled });
  assert.deepEqual(r.map((x) => x.name), ['docs', 'api', 'Claude Desktop', 'blog', 'shop']);
  const blog = r.find((x) => x.name === 'blog');
  assert.equal(blog.idleFor, '25m');
  assert.equal(blog.idleMs, 25 * 60000);
  assert.equal(blog.last, 'Done. Tests pass.');
  assert.equal(blog.canPoke, true);
  const shop = r.find((x) => x.name === 'shop');
  assert.equal(shop.working, true);
  assert.equal(shop.idleFor, '');
  assert.equal(shop.costUSD, 1.23);
  assert.equal(shop.last, 'editing cart.js');
  assert.equal(r.find((x) => x.name === 'api').stalled, true);
  assert.equal(r.find((x) => x.name === 'Claude Desktop').canPoke, false, 'Desktop is view-only');
  assert.ok(!r.some((x) => x.name === 'old'), 'closed sessions are gone');
});

test('summary(): counts by what matters on the go', () => {
  const s = floor.summary(floor.rows(agents(), NOW, { isStalled: stalled }));
  assert.deepEqual(s, { total: 5, working: 1, idle: 2, waiting: 2, errors: 0, costUSD: 1.73 });
});

test('telegramText(): a header with the counts, one line per session, a nudge hint, under the Telegram cap', () => {
  const r = floor.rows(agents(), NOW, { isStalled: stalled });
  const t = floor.telegramText(r, { dashUrl: 'http://pc:3131/' });
  assert.match(t, /^🦆 <b>Gander floor<\/b> · 1 working · 2 idle · 2 need you · \$1\.73/);
  assert.match(t, /💤 <b>blog<\/b> — idle 25m · \$0\.50/);
  assert.match(t, /🔔 <b>docs<\/b> — waiting on you/);
  assert.match(t, /↳ Allow rm -rf dist\?/);
  assert.match(t, /\/poke project/);
  assert.match(t, /http:\/\/pc:3131\/$/);
  assert.ok(t.length < 4096);
  assert.equal(floor.telegramText([]), '🦆 <b>Gander floor</b> · nothing running');
  const many = floor.rows(Array.from({ length: 80 }, (_, i) => ({ id: 's' + i, sessionId: 's' + i, root: true, project: 'p' + i, state: 'idle', updatedAt: min(i), lastMessage: 'x'.repeat(150) })), NOW);
  assert.ok(floor.telegramText(many).length <= 4000, 'capped');
});

test('parseCommand(): /status, /poke, /help and nothing else', () => {
  assert.deepEqual(floor.parseCommand('/status'), { kind: 'status' });
  assert.deepEqual(floor.parseCommand('/floor'), { kind: 'status' });
  assert.deepEqual(floor.parseCommand('/s'), { kind: 'status' });
  assert.deepEqual(floor.parseCommand('/help'), { kind: 'help' });
  assert.deepEqual(floor.parseCommand('/poke blog'), { kind: 'poke', project: 'blog', message: '' });
  assert.deepEqual(floor.parseCommand('/poke blog finish the tests then push'), { kind: 'poke', project: 'blog', message: 'finish the tests then push' });
  assert.deepEqual(floor.parseCommand('/nudge api'), { kind: 'poke', project: 'api', message: '' });
  assert.deepEqual(floor.parseCommand('/poke'), { kind: 'poke', project: '', message: '' });
  assert.equal(floor.parseCommand('/task blog write a post'), null);
  assert.equal(floor.parseCommand('/stop'), null);
  assert.equal(floor.parseCommand('blog: hello'), null);
  assert.equal(floor.parseCommand('/statusline'), null);
  // bare words from a phone keyboard
  assert.deepEqual(floor.parseCommand('Poke'), { kind: 'poke', project: '', message: '' });
  assert.deepEqual(floor.parseCommand('poke blog'), { kind: 'poke', project: 'blog', message: '' });
  assert.deepEqual(floor.parseCommand('Status'), { kind: 'status' });
  assert.deepEqual(floor.parseCommand('help'), { kind: 'help' });
  assert.equal(floor.parseCommand('go ahead and fix it'), null, 'a plain message, not a poke');
  assert.equal(floor.parseCommand('status report is due'), null);
});

test('idleDue(): once per idle stretch, only pokeable idle sessions, resets when the session works again', () => {
  const seen = new Map();
  const r1 = floor.rows(agents(), NOW, { isStalled: stalled });
  const due = floor.idleDue(r1, 20, seen, NOW);
  assert.deepEqual(due.map((x) => x.name), ['blog'], 'api is 4m idle, docs is awaiting, Desktop cannot be poked');
  assert.deepEqual(floor.idleDue(r1, 20, seen, NOW), [], 'not twice for the same stretch');
  assert.deepEqual(floor.idleDue(r1, 0, seen, NOW), [], '0 = off');
  // blog works, then goes idle again much later
  const later = agents().map((a) => (a.sessionId === 'b2' ? { ...a, updatedAt: min(-60) } : a));
  const r2 = floor.rows(later, NOW + 90 * 60000, { isStalled: stalled });
  assert.deepEqual(floor.idleDue(r2, 20, seen, NOW + 90 * 60000).map((x) => x.name).sort(), ['api', 'blog']);
  // a session that left the floor is forgotten
  assert.ok(seen.has('b2'));
  floor.idleDue(floor.rows([], NOW), 20, seen, NOW);
  assert.equal(seen.size, 0);
});

test('idleAlertText() + findRow()', () => {
  const r = floor.rows(agents(), NOW, { isStalled: stalled });
  const blog = floor.findRow(r, 'BLOG');
  assert.equal(blog.sessionId, 'b2');
  assert.match(floor.idleAlertText(blog, { dashUrl: 'http://pc:3131/' }), /^💤 <b>Gander<\/b>\n<b>blog<\/b> has been idle 25m\.\nLast: Done\. Tests pass\.\n.*\/poke blog/);
  assert.equal(floor.findRow(r, 'shop').sessionId, 'a1', 'exact project name');
  assert.equal(floor.findRow(r, 'a1'), null, 'a session-id prefix needs 4+ characters');
  assert.equal(floor.findRow(r, 'ap').sessionId, 'c3', 'loose contains match');
  assert.equal(floor.findRow(r, 'desktop'), null, 'view-only sessions are never a poke target');
  assert.equal(floor.findRow(r, ''), null);
});

test('ago(): the phone scale', () => {
  assert.equal(floor.ago(10 * 1000), 'now');
  assert.equal(floor.ago(7 * 60000), '7m');
  assert.equal(floor.ago(130 * 60000), '2h 10m');
  assert.equal(floor.ago(50 * 3600000), '2d 2h');
  assert.equal(floor.ago(-5), '');
});
