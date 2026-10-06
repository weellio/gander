'use strict';
// test/permlearn.test.js — bridge/permlearn.js: "stop asking me" suggestions.
// Every ledger and settings file lives under os.tmpdir(); the real
// ~/.claude/settings.json is never read or written.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const P = require('../bridge/permlearn.js');

const TEMPS = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-permlearn-')); TEMPS.push(d); return d; }
after(() => { for (const d of TEMPS) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });

const NOW = Date.parse('2026-10-01T12:00:00');

describe('ruleFor: which allow-rule a prompt would become', () => {
  const rows = [
    // positives
    ['Bash', { command: 'git status -s' }, 'Bash(git status:*)'],
    ['Bash', { command: 'git log --oneline -5' }, 'Bash(git log:*)'],
    ['Bash', { command: 'npm test' }, 'Bash(npm test:*)'],
    ['Bash', { command: 'npm run build' }, 'Bash(npm run:*)'],
    ['Bash', { command: 'node --test' }, 'Bash(node --test:*)'],   // never the bare interpreter: Bash(node:*) would also allow node -e
    ['Bash', { command: 'node bridge/server.js --port 3131' }, 'Bash(node bridge/server.js:*)'],
    ['Bash', { command: 'ls -la' }, 'Bash(ls:*)'],
    ['Bash', { command: 'docker ps -a' }, 'Bash(docker ps:*)'],
    ['Bash', { command: 'python -m pytest -q' }, 'Bash(python -m pytest:*)'],   // -m runs any module, so the module name is part of the rule
    ['Bash', { command: 'npx tsc --noEmit' }, 'Bash(npx tsc:*)'],
    ['Bash', { command: 'cargo build --release' }, 'Bash(cargo build:*)'],
    ['WebFetch', { url: 'https://docs.python.org/3/library/os.html' }, 'WebFetch(domain:docs.python.org)'],
    ['mcp__github__create_issue', { title: 'x' }, 'mcp__github__create_issue'],
    // dangerous, or a prefix that would cover the dangerous form
    ['Bash', { command: 'rm -rf node_modules' }, null],
    ['Bash', { command: 'rm file.txt' }, null],
    ['Bash', { command: 'git push --force origin main' }, null],
    ['Bash', { command: 'git push origin feature-x' }, null],
    ['Bash', { command: 'git reset HEAD file.js' }, null],
    ['Bash', { command: 'git checkout main' }, null],
    ['Bash', { command: 'npm publish' }, null],
    ['Bash', { command: 'npx rimraf dist' }, null],
    ['Bash', { command: 'npx -y create-vite' }, null],
    ['Bash', { command: 'sudo apt update' }, null],
    ['Bash', { command: 'chmod +x run.sh' }, null],
    // interpreters with inline code
    ['Bash', { command: 'node -e "console.log(1)"' }, null],
    ['Bash', { command: 'python -c "print(1)"' }, null],
    ['Bash', { command: 'python3.12 -c "print(1)"' }, null],
    ['Bash', { command: 'bash -c "ls"' }, null],
    ['Bash', { command: 'powershell -Command Get-Date' }, null],
    // compound or not literal
    ['Bash', { command: 'git status && npm test' }, null],
    ['Bash', { command: 'ls | grep x' }, null],
    ['Bash', { command: 'echo $(whoami)' }, null],
    ['Bash', { command: 'FOO=1 npm test' }, null],
    ['Bash', { command: '"C:/Program Files/nodejs/node.exe" x.js' }, null],
    ['Bash', { command: 'cat <<EOF\nhi\nEOF' }, null],
    ['Bash', { command: '' }, null],
    // other tools
    ['Read', { file_path: 'x' }, null],
    ['Edit', { file_path: 'x' }, null],
    ['Write', { file_path: 'x' }, null],
    ['PowerShell', { command: 'Get-ChildItem' }, null],
    ['Glob', { pattern: '**/*.js' }, null],
    ['WebFetch', { url: 'not a url' }, null],
    ['WebFetch', { url: 'file:///etc/passwd' }, null],
  ];
  for (const [tool, input, want] of rows) {
    test(`${tool} ${JSON.stringify(input)} -> ${want}`, () => assert.equal(P.ruleFor(tool, input), want));
  }
});

describe('ledger', () => {
  const ev = (rule, kind, extra) => ({ kind, rule, tool: 'Bash', example: 'npm test', at: NOW, project: 'shop', ...extra });

  test('a suggestion appears only at the threshold', () => {
    const L = P.createLedger({ file: path.join(tmp(), 'ledger.json'), now: NOW });
    for (let i = 0; i < 4; i++) L.record(ev('Bash(npm test:*)', 'allowed'));
    assert.equal(L.suggestions().length, 0, '4 allows is not 5');
    L.record(ev('Bash(npm test:*)', 'allowed'));
    const s = L.suggestions();
    assert.equal(s.length, 1);
    assert.deepEqual(s[0], { rule: 'Bash(npm test:*)', allows: 5, denies: 0, lastAt: NOW, examples: ['npm test'], projects: ['shop'] });
    assert.equal(L.suggestions({ minAllows: 6 }).length, 0);
  });

  test('one deny excludes the rule for good', () => {
    const L = P.createLedger({ now: NOW });
    for (let i = 0; i < 9; i++) L.record(ev('Bash(git status:*)', 'allowed'));
    L.record(ev('Bash(git status:*)', 'denied'));
    assert.equal(L.suggestions().length, 0);
    assert.equal(L.data().rules['Bash(git status:*)'].denies, 1);
  });

  test('a rule already in settings is not suggested again', () => {
    const L = P.createLedger({ now: NOW });
    for (let i = 0; i < 5; i++) L.record(ev('Bash(ls:*)', 'allowed'));
    assert.equal(L.suggestions({ existing: ['Bash(ls:*)'] }).length, 0);
    assert.equal(L.suggestions({ existing: ['Bash(ls -la:*)'] }).length, 1, 'exact string match only');
  });

  test('dismissed survives a new ledger on the same file', () => {
    const file = path.join(tmp(), 'nested', 'ledger.json');
    const a = P.createLedger({ file, now: NOW });
    for (let i = 0; i < 6; i++) a.record(ev('Bash(npm test:*)', 'allowed'));
    for (let i = 0; i < 5; i++) a.record(ev('Bash(ls:*)', 'allowed'));
    assert.equal(a.suggestions().length, 2);
    a.forget('Bash(npm test:*)');
    const b = P.createLedger({ file, now: NOW });
    assert.deepEqual(b.suggestions().map((x) => x.rule), ['Bash(ls:*)']);
    assert.ok(b.data().dismissed.includes('Bash(npm test:*)'));
    assert.equal(b.data().rules['Bash(npm test:*)'].allows, 6, 'counts persisted too');
  });

  test('sorted by allows, examples capped at 3 and projects at 5', () => {
    const L = P.createLedger({ now: NOW });
    for (let i = 0; i < 10; i++) L.record(ev('Bash(npm test:*)', 'allowed', { example: 'npm test -- ' + i, project: 'p' + i }));
    for (let i = 0; i < 7; i++) L.record(ev('Bash(ls:*)', 'allowed'));
    const s = L.suggestions();
    assert.deepEqual(s.map((x) => x.rule), ['Bash(npm test:*)', 'Bash(ls:*)']);
    assert.equal(s[0].examples.length, 3);
    assert.equal(s[0].examples[0], 'npm test -- 9', 'newest first');
    assert.equal(s[0].projects.length, 5);
  });

  test('record ignores junk', () => {
    const L = P.createLedger({ now: NOW });
    assert.equal(L.record(null), false);
    assert.equal(L.record({ kind: 'allowed' }), false);
    assert.equal(L.record({ kind: 'maybe', rule: 'x' }), false);
    assert.deepEqual(L.data().rules, {});
  });

  test('written atomically, no temp file left; a corrupt file starts fresh', () => {
    const dir = tmp();
    const file = path.join(dir, 'ledger.json');
    P.createLedger({ file, now: NOW }).record(ev('Bash(ls:*)', 'allowed'));
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).rules['Bash(ls:*)']);
    assert.deepEqual(fs.readdirSync(dir), ['ledger.json']);
    fs.writeFileSync(file, '{ not json');
    const L = P.createLedger({ file, now: NOW });
    assert.deepEqual(L.data().rules, {});
    assert.doesNotThrow(() => L.record(ev('Bash(ls:*)', 'allowed')));
  });

  test('rule count is capped at 500, oldest dropped first', () => {
    const L = P.createLedger({ now: NOW });
    for (let i = 0; i < 505; i++) L.record(ev('Bash(tool' + i + ':*)', 'allowed', { at: NOW + i }));
    const rules = Object.keys(L.data().rules);
    assert.equal(rules.length, 500);
    assert.ok(!rules.includes('Bash(tool0:*)'));
    assert.ok(rules.includes('Bash(tool504:*)'));
  });
});

describe('applyRule / removeRule', () => {
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

  test('creates a missing settings file (and its folder)', () => {
    const f = path.join(tmp(), '.claude', 'settings.json');
    const r = P.applyRule(f, 'Bash(npm test:*)');
    assert.deepEqual(r, { ok: true, added: true });
    const text = fs.readFileSync(f, 'utf8');
    assert.equal(text, '{\n  "permissions": {\n    "allow": [\n      "Bash(npm test:*)"\n    ]\n  }\n}\n');
    assert.ok(!fs.existsSync(f + '.gander-bak'), 'nothing to back up');
  });

  test('preserves every other key and its order, and backs up first', () => {
    const f = path.join(tmp(), 'settings.json');
    const orig = JSON.stringify({ model: 'opus', permissions: { deny: ['Bash(rm:*)'], allow: ['Bash(ls:*)'], defaultMode: 'default' }, hooks: { Stop: [] }, env: { A: '1' } }, null, 4);
    fs.writeFileSync(f, orig);
    assert.deepEqual(P.applyRule(f, 'Bash(npm test:*)'), { ok: true, added: true });
    const o = read(f);
    assert.deepEqual(Object.keys(o), ['model', 'permissions', 'hooks', 'env']);
    assert.deepEqual(Object.keys(o.permissions), ['deny', 'allow', 'defaultMode']);
    assert.deepEqual(o.permissions.allow, ['Bash(ls:*)', 'Bash(npm test:*)']);
    assert.deepEqual(o.permissions.deny, ['Bash(rm:*)']);
    assert.deepEqual(o.hooks, { Stop: [] });
    assert.equal(fs.readFileSync(f + '.gander-bak', 'utf8'), orig);
    assert.ok(fs.readFileSync(f, 'utf8').endsWith('}\n'));
  });

  test('dedupes: applying twice adds once, and existing duplicates collapse', () => {
    const f = path.join(tmp(), 'settings.json');
    fs.writeFileSync(f, JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 'Bash(ls:*)'] } }));
    assert.deepEqual(P.applyRule(f, 'Bash(git status:*)'), { ok: true, added: true });
    assert.deepEqual(P.applyRule(f, 'Bash(git status:*)'), { ok: true, added: false });
    assert.deepEqual(read(f).permissions.allow, ['Bash(ls:*)', 'Bash(git status:*)']);
  });

  test('adds permissions/allow when the file has neither', () => {
    const f = path.join(tmp(), 'settings.json');
    fs.writeFileSync(f, '{"model":"sonnet"}');
    P.applyRule(f, 'WebFetch(domain:example.com)');
    assert.deepEqual(read(f), { model: 'sonnet', permissions: { allow: ['WebFetch(domain:example.com)'] } });
  });

  test('refuses invalid JSON and leaves the file exactly as it was', () => {
    const f = path.join(tmp(), 'settings.json');
    const broken = '{ "model": "opus", }';
    fs.writeFileSync(f, broken);
    const r = P.applyRule(f, 'Bash(ls:*)');
    assert.ok(r.error && /not valid JSON/.test(r.error), JSON.stringify(r));
    assert.equal(fs.readFileSync(f, 'utf8'), broken);
    assert.ok(!fs.existsSync(f + '.gander-bak'));
  });

  test('refuses a permissions.allow that is not a list', () => {
    const f = path.join(tmp(), 'settings.json');
    fs.writeFileSync(f, '{"permissions":{"allow":"Bash(ls:*)"}}');
    assert.ok(P.applyRule(f, 'Bash(npm test:*)').error);
  });

  test('removeRule takes out only that rule', () => {
    const f = path.join(tmp(), 'settings.json');
    fs.writeFileSync(f, JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 'Bash(npm test:*)'] }, model: 'opus' }));
    assert.deepEqual(P.removeRule(f, 'Bash(npm test:*)'), { ok: true, removed: true });
    assert.deepEqual(read(f), { permissions: { allow: ['Bash(ls:*)'] }, model: 'opus' });
    assert.ok(fs.existsSync(f + '.gander-bak'));
    assert.deepEqual(P.removeRule(f, 'Bash(npm test:*)'), { ok: true, removed: false });
  });

  test('removeRule on a missing file is a no-op; on invalid JSON an error', () => {
    const dir = tmp();
    assert.deepEqual(P.removeRule(path.join(dir, 'nope.json'), 'Bash(ls:*)'), { ok: true, removed: false });
    assert.ok(!fs.existsSync(path.join(dir, 'nope.json')));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    assert.ok(P.removeRule(path.join(dir, 'bad.json'), 'Bash(ls:*)').error);
  });
});

describe('interpreters never become a blank cheque', () => {
  const { ruleFor } = require('../bridge/permlearn.js');
  test('approving `node --test` must not allow `node -e` later', () => {
    const r = ruleFor('Bash', { command: 'node --test' });
    assert.equal(r, 'Bash(node --test:*)');
    assert.notEqual(r, 'Bash(node:*)');
  });
  test('a bare interpreter (REPL) gets no rule', () => {
    assert.equal(ruleFor('Bash', { command: 'node' }), null);
    assert.equal(ruleFor('Bash', { command: 'python' }), null);
  });
  test('python -m keeps the module name, and -m alone gets nothing', () => {
    assert.equal(ruleFor('Bash', { command: 'python -m pytest -q' }), 'Bash(python -m pytest:*)');
    assert.equal(ruleFor('Bash', { command: 'python -m' }), null);
  });
  test('a specific script is fine', () => {
    assert.equal(ruleFor('Bash', { command: 'node scripts/build.js --prod' }), 'Bash(node scripts/build.js:*)');
  });
});
