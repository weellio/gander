'use strict';
// test/fleet.test.js — tests for bridge/fleet.js (all network is
// dependency-injected, so no socket is ever opened; polling is driven by
// calling pollAll directly or by node:test mock timers).

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fleet = require('../bridge/fleet.js');

const PEER_AGENTS = [
  {
    id: 'sess:abc', name: 'volt', state: 'coding', project: 'volt', cwd: 'C:\\p\\volt',
    sessionId: 'abc', root: true, updatedAt: 111, logLines: ['npm test'], lastMessage: 'on it',
  },
  { id: 'agent:sub1', name: 'explorer', state: 'reading', parentId: 'sess:abc', sessionId: 'abc', project: 'volt' },
];

function mkDeps(over = {}) {
  const calls = { fetch: [], post: [] };
  const deps = {
    now: () => (over.nowMs !== undefined ? over.nowMs : 1_000_000),
    fetchJson: over.fetchJson || (async (url, opts) => { calls.fetch.push({ url, opts }); return { agents: PEER_AGENTS }; }),
    postJson: over.postJson || (async (url, body, opts) => { calls.post.push({ url, body, opts }); return { ok: true }; }),
  };
  return { deps, calls };
}

describe('fleet', () => {
  beforeEach(() => fleet._test.reset());
  afterEach(() => fleet.stop());

  // ── configure() ────────────────────────────────────────────────────────────
  describe('configure()', () => {
    test('normalizes peers: trims names, strips trailing slashes, clamps the interval', () => {
      const c = fleet.configure({
        peers: [
          { name: '  Laptop ', url: 'http://192.168.1.20:3131///', token: 't1' },
          { url: 'http://studio.local:3131/' },          // nameless — falls back to the hostname
          { name: 'ghost' },                             // url-less — dropped
          null,                                          // garbage — dropped
        ],
        intervalMs: 100,                                 // below the floor — clamped
      });
      assert.equal(c.peers.length, 2);
      assert.deepEqual(c.peers[0], { name: 'Laptop', url: 'http://192.168.1.20:3131', token: 't1' });
      assert.deepEqual(c.peers[1], { name: 'studio.local', url: 'http://studio.local:3131', token: '' });
      assert.equal(c.intervalMs, 2000, 'intervalMs floor is 2000');
      assert.equal(fleet.configure({ peers: [] }).intervalMs, 5000, 'default interval is 5000');
    });

    test('peer names never carry ":" (it is the fleet-id separator) and dupes fold', () => {
      const c = fleet.configure({ peers: [
        { name: 'work: desk', url: 'http://a:3131' },
        { name: 'work: desk', url: 'http://b:3131' },    // duplicate name — dropped
      ] });
      assert.equal(c.peers.length, 1);
      assert.equal(c.peers[0].name, 'work-desk');
    });

    test('junk config yields an empty fleet, never a throw', () => {
      assert.deepEqual(fleet.configure(null).peers, []);
      assert.deepEqual(fleet.configure({ peers: 'nope' }).peers, []);
      assert.deepEqual(fleet.agents(), []);
      assert.deepEqual(fleet.status(), []);
    });
  });

  // ── agents() merge ─────────────────────────────────────────────────────────
  describe('agents() merge', () => {
    test('prefixes ids, remaps parentId, tags the machine, copies the rest through', async () => {
      fleet.configure({ peers: [{ name: 'laptop', url: 'http://l:3131', token: 'sekrit' }] });
      const { deps, calls } = mkDeps({});
      await fleet._test.pollAll(deps);

      assert.equal(calls.fetch.length, 1);
      assert.equal(calls.fetch[0].url, 'http://l:3131/api/state');
      assert.equal(calls.fetch[0].opts.headers['X-Gander-Token'], 'sekrit', 'poll carries the peer token');

      const list = fleet.agents();
      assert.equal(list.length, 2);
      const root = list.find((a) => a.origId === 'sess:abc');
      assert.equal(root.id, 'fleet:laptop:sess:abc');
      assert.equal(root.machine, 'laptop');
      assert.equal(root.remote, true);
      assert.equal(root.peerUrl, 'http://l:3131');
      assert.equal(root.state, 'coding');
      assert.equal(root.project, 'volt');
      assert.equal(root.sessionId, 'abc');
      assert.equal(root.lastMessage, 'on it');
      assert.equal(root.updatedAt, 111);
      assert.deepEqual(root.logLines, ['npm test']);
      const sub = list.find((a) => a.origId === 'agent:sub1');
      assert.equal(sub.id, 'fleet:laptop:agent:sub1');
      assert.equal(sub.parentId, 'fleet:laptop:sess:abc', 'hierarchy survives the remap');
    });

    test('never leaks the peer token into agents() or status()', async () => {
      fleet.configure({ peers: [{ name: 'laptop', url: 'http://l:3131', token: 'sekrit' }] });
      const { deps } = mkDeps({
        fetchJson: async () => ({ agents: [{ id: 'sess:x', sessionId: 'x', peerToken: 'sekrit', token: 'sekrit' }] }),
      });
      await fleet._test.pollAll(deps);
      assert.ok(!JSON.stringify(fleet.agents()).includes('sekrit'), 'agents() must not contain the token');
      assert.ok(!JSON.stringify(fleet.status()).includes('sekrit'), 'status() must not contain the token');
    });

    test('source snapshots are not mutated (merge clones)', async () => {
      fleet.configure({ peers: [{ name: 'laptop', url: 'http://l:3131' }] });
      const src = [{ id: 'sess:a', sessionId: 'a', parentId: undefined, state: 'idle' }];
      const { deps } = mkDeps({ fetchJson: async () => ({ agents: src }) });
      await fleet._test.pollAll(deps);
      fleet.agents();
      assert.equal(src[0].id, 'sess:a', 'peer snapshot keeps its original id');
      assert.ok(!('machine' in src[0]));
    });
  });

  // ── offline peers ──────────────────────────────────────────────────────────
  describe('offline peer handling', () => {
    test('agents survive 2 missed polls, drop on the 3rd, return on recovery', async () => {
      fleet.configure({ peers: [{ name: 'laptop', url: 'http://l:3131' }] });
      let fail = false;
      const { deps } = mkDeps({
        fetchJson: async (url, opts) => { if (fail) throw new Error('ECONNREFUSED'); return { agents: PEER_AGENTS }; },
      });

      await fleet._test.pollAll(deps);                       // good poll
      assert.equal(fleet.agents().length, 2);
      assert.equal(fleet.status()[0].online, true);
      assert.equal(fleet.status()[0].lastSeenMs, 1_000_000);
      assert.equal(fleet.status()[0].error, null);

      fail = true;
      await fleet._test.pollAll(deps);                       // miss 1
      assert.equal(fleet.agents().length, 2, 'a blip keeps last-known agents');
      assert.equal(fleet.status()[0].online, false);
      assert.match(fleet.status()[0].error, /ECONNREFUSED/);
      await fleet._test.pollAll(deps);                       // miss 2
      assert.equal(fleet.agents().length, 2, 'still showing after two misses');
      await fleet._test.pollAll(deps);                       // miss 3 — dark
      assert.equal(fleet.agents().length, 0, 'gone on the third consecutive miss');
      assert.equal(fleet.status()[0].agentCount, 0);

      fail = false;
      await fleet._test.pollAll(deps);                       // recovery
      assert.equal(fleet.agents().length, 2, 'back on the next good poll');
      assert.equal(fleet.status()[0].online, true);
      assert.equal(fleet.status()[0].error, null);
    });

    test('a never-seen peer contributes nothing and shows offline', async () => {
      fleet.configure({ peers: [{ name: 'laptop', url: 'http://l:3131' }] });
      const { deps } = mkDeps({ fetchJson: async () => { throw new Error('timeout after 4000ms'); } });
      await fleet._test.pollAll(deps);
      assert.deepEqual(fleet.agents(), []);
      const st = fleet.status()[0];
      assert.equal(st.online, false);
      assert.equal(st.lastSeenMs, null);
      assert.match(st.error, /timeout/);
    });

    test('one dead peer never blanks a healthy one', async () => {
      fleet.configure({ peers: [
        { name: 'alive', url: 'http://a:3131' },
        { name: 'dead', url: 'http://d:3131' },
      ] });
      const { deps } = mkDeps({
        fetchJson: async (url) => {
          if (url.startsWith('http://d:')) throw new Error('EHOSTUNREACH');
          return { agents: [{ id: 'sess:ok', sessionId: 'ok', state: 'idle' }] };
        },
      });
      for (let i = 0; i < 4; i++) await fleet._test.pollAll(deps);
      assert.equal(fleet.agents().length, 1);
      assert.equal(fleet.agents()[0].machine, 'alive');
      const byName = Object.fromEntries(fleet.status().map((s) => [s.name, s]));
      assert.equal(byName.alive.online, true);
      assert.equal(byName.dead.online, false);
    });
  });

  // ── forwardCommand() ───────────────────────────────────────────────────────
  describe('forwardCommand()', () => {
    async function seedTwoPeers() {
      fleet.configure({ peers: [
        { name: 'laptop', url: 'http://l:3131', token: 'tok-l' },
        { name: 'studio', url: 'http://s:3131', token: 'tok-s' },
      ] });
      const { deps } = mkDeps({
        fetchJson: async (url) => (url.startsWith('http://l:')
          ? { agents: PEER_AGENTS }
          : { agents: [{ id: 'sess:def', sessionId: 'def', state: 'idle' }] }),
      });
      await fleet._test.pollAll(deps);
    }

    test('routes a fleet id to the owning peer with the token header', async () => {
      await seedTwoPeers();
      const posts = [];
      const postJson = async (url, body, opts) => { posts.push({ url, body, opts }); return { ok: true }; };
      const r = await fleet.forwardCommand('fleet:laptop:sess:abc', { type: 'message', text: 'carry on' }, { postJson });
      assert.deepEqual(r, { ok: true, machine: 'laptop' });
      assert.equal(posts.length, 1);
      assert.equal(posts[0].url, 'http://l:3131/api/command');
      assert.deepEqual(posts[0].body, { sessionId: 'abc', type: 'message', text: 'carry on' });
      assert.equal(posts[0].opts.headers['X-Gander-Token'], 'tok-l');
    });

    test('routes a bare remote sessionId by searching the snapshots', async () => {
      await seedTwoPeers();
      const posts = [];
      const postJson = async (url, body, opts) => { posts.push({ url, body, opts }); return { ok: true }; };
      const r = await fleet.forwardCommand('def', { type: 'stop' }, { postJson });
      assert.deepEqual(r, { ok: true, machine: 'studio' });
      assert.equal(posts[0].url, 'http://s:3131/api/command');
      assert.deepEqual(posts[0].body, { sessionId: 'def', type: 'stop', text: '' });
      assert.equal(posts[0].opts.headers['X-Gander-Token'], 'tok-s');
    });

    test('unknown agents and unknown peers error without posting', async () => {
      await seedTwoPeers();
      const posts = [];
      const postJson = async (...a) => { posts.push(a); return { ok: true }; };
      assert.match((await fleet.forwardCommand('nope-sid', { text: 'x' }, { postJson })).error, /no fleet peer/);
      assert.match((await fleet.forwardCommand('fleet:mars:sess:abc', { text: 'x' }, { postJson })).error, /no fleet peer/);
      assert.equal(posts.length, 0, 'nothing was posted');
    });

    test('a peer error reply or an unreachable peer becomes { error }, never a throw', async () => {
      await seedTwoPeers();
      const refuse = async () => ({ error: 'session gone' });
      assert.match((await fleet.forwardCommand('fleet:laptop:sess:abc', { text: 'x' }, { postJson: refuse })).error, /laptop: session gone/);
      const explode = async () => { throw new Error('ECONNRESET'); };
      assert.match((await fleet.forwardCommand('fleet:laptop:sess:abc', { text: 'x' }, { postJson: explode })).error, /unreachable.*ECONNRESET/);
    });

    test('falls back to the sess:<id> convention when the agent aged out of the snapshot', async () => {
      await seedTwoPeers();
      const posts = [];
      const postJson = async (url, body) => { posts.push({ url, body }); return { ok: true }; };
      const r = await fleet.forwardCommand('fleet:laptop:sess:zzz', { type: 'message', text: 'hi' }, { postJson });
      assert.ok(r.ok);
      assert.equal(posts[0].body.sessionId, 'zzz');
    });
  });

  // ── start()/stop() polling loop ────────────────────────────────────────────
  describe('start()/stop()', () => {
    test('polls immediately, then on the interval; stop() halts it; start() is idempotent', () => {
      mock.timers.enable({ apis: ['setInterval'] });
      try {
        fleet.configure({ peers: [{ name: 'laptop', url: 'http://l:3131' }], intervalMs: 2000 });
        let count = 0;
        const fetchJson = async () => { count++; return { agents: [] }; };
        fleet.start({ fetchJson, now: () => 1 });
        assert.equal(count, 1, 'first poll fires on start');
        mock.timers.tick(2000);
        assert.equal(count, 2);
        fleet.start({ fetchJson, now: () => 1 });            // restart — must not double the timer
        assert.equal(count, 3, 'restart re-polls once');
        mock.timers.tick(2000);
        assert.equal(count, 4, 'one poll per tick after a restart, not two');
        fleet.stop();
        mock.timers.tick(20000);
        assert.equal(count, 4, 'stop() really stops the loop');
      } finally {
        mock.timers.reset();
      }
    });
  });
});
