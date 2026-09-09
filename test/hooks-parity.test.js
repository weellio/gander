'use strict';
// The three places that must agree on WHICH hook events Gander wires:
//   setup/lib.js buildHooks()   — what `node install.js` writes into settings.json
//   hooks/hooks.json            — what the plugin install declares
//   bridge/health.js            — what the health panel verifies
// PR #2 found Notification in the manifest + health but not the installer;
// nothing caught it. This test does.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { buildHooks } = require('../setup/lib.js');
const health = require('../bridge/health.js');

const installer = Object.keys(buildHooks()).sort();
const manifest = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks).sort();

describe('hook wiring parity', () => {
  test('plugin manifest declares exactly the events the installer wires', () => {
    assert.deepEqual(manifest, installer);
  });

  test('health check verifies every installer event (derived, not a copy)', () => {
    const rep = health.report();
    const list = rep.events || (rep.hooks && rep.hooks.events) || [];
    assert.ok(list.length, 'health report lists hook events');
    const verified = list.map((e) => e.event).sort();
    assert.deepEqual(verified, installer);
  });

  test('every installer entry runs emit.js or launch.js with a valid shape', () => {
    for (const [event, groups] of Object.entries(buildHooks())) {
      assert.ok(Array.isArray(groups) && groups.length, `${event} has hook groups`);
      for (const g of groups) for (const h of g.hooks) {
        assert.equal(h.type, 'command', `${event} hook type`);
        assert.match(h.command, /(emit|launch)\.js"$/, `${event} points at emit.js/launch.js`);
        assert.ok(Number.isFinite(h.timeout) && h.timeout > 0, `${event} has a timeout`);
      }
    }
  });

  test('the bridge maps every state-carrying event (PreToolUse is the stop channel only)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bridge', 'server.js'), 'utf8');
    const m = src.indexOf('function mapHookToEvents');
    const body = src.slice(m, src.indexOf('\nfunction ', m + 10));
    const mapped = new Set([...body.matchAll(/case '([A-Z][A-Za-z]+)'/g)].map((x) => x[1]));
    const expectUnmapped = new Set(['PreToolUse']);
    for (const ev of installer) {
      if (expectUnmapped.has(ev)) continue;
      assert.ok(mapped.has(ev), `mapHookToEvents handles ${ev}`);
    }
  });
});
