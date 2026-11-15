'use strict';
// The external-sources registry: what a project's files say it talks to, with
// credentials named (never valued), secrets redacted, noise dropped, nested
// folders folded into their project, and the whole thing as Markdown.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./_tmp.js');
const sources = require('../bridge/sources.js');

function fixture() {
  const dir = tmpdir('gander-sources-');
  const w = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  w('bridge/server.js', `
    const https = require('https');
    const req = https.request({ host: 'api.telegram.org', path: '/bot' + process.env.TG_BOT_TOKEN + '/sendMessage' });
    fetch('https://ll.thespacedevs.com/2.3.0/launches/upcoming/?search=starship&limit=5');
    fetch('https://api.telegram.org/bot123:FAKE_TOKEN_FOR_TESTS_ONLY_0000000000/sendMessage');
    const cfg = { chat: process.env.TG_CHAT_ID, mode: process.env.NODE_ENV };
    // https://www.w3.org/TR/css-grid-1/ and http://localhost:3131/ are not sources
  `);
  w('web/index.html', `<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">
    <a href="https://github.com/weellio/gander">repo</a> <a href="https://aiworkernow.com/tools/">site</a>`);
  w('scripts/brief.py', `import os
url = "https://api.deepseek.com/v1/chat/completions"
key = os.environ["DEEPSEEK_API_KEY"]
r = requests.get("https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json")
feed = "https://feeds.example.net/rss"  # example hosts are placeholders
`);
  w('.env', 'STRIPE_SECRET_KEY=FAKEVALUE_not_a_real_key_000\nDATABASE_URL=postgres://user:hunter2@db.supersecret-host.com:5432/app\nPORT=3131\n');
  w('package-lock.json', JSON.stringify({ packages: { 'node_modules/x': { resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz' } } }));
  w('node_modules/dep/index.js', 'fetch("https://evil-dependency-host.com/x")');
  w('dist/app.js', 'fetch("https://built-output-host.com/x")');
  w('README.md', 'Docs at https://docs.github.com/en/rest and the LICENSE at https://opensource.org/license/mit');
  return dir;
}

test('scanProject(): hosts with kinds, counts, files; credentials by NAME only; noise, lock files and build output skipped', async () => {
  const dir = fixture();
  const s = await sources.scanProject(dir, { name: 'fixture' });
  const by = Object.fromEntries(s.hosts.map((h) => [h.host, h]));
  assert.ok(by['api.telegram.org'], Object.keys(by).join(','));
  assert.equal(by['api.telegram.org'].kind, 'api');
  assert.equal(by['api.telegram.org'].count, 2, 'the host literal and the URL both count');
  assert.ok(by['api.telegram.org'].files.includes('bridge/server.js'));
  assert.deepEqual(by['api.telegram.org'].env, ['TG_BOT_TOKEN', 'TG_CHAT_ID'], 'NODE_ENV is not a credential');
  assert.equal(by['ll.thespacedevs.com'].kind, 'api');
  assert.equal(by['cdnjs.cloudflare.com'].kind, 'cdn');
  assert.equal(by['fonts.googleapis.com'].kind, 'cdn');
  assert.equal(by['github.com'].kind, 'repo');
  assert.equal(by['docs.github.com'].kind, 'docs');
  assert.equal(by['docs.github.com'].code, false, 'a link in the README is a mention');
  assert.equal(by['api.telegram.org'].code, true, 'code talks to it');
  assert.equal(by['cdnjs.cloudflare.com'].code, true, 'a script tag in HTML is code');
  assert.equal(by['aiworkernow.com'].kind, 'site');
  assert.equal(by['api.deepseek.com'].kind, 'api');
  assert.deepEqual(by['api.deepseek.com'].env, ['DEEPSEEK_API_KEY']);
  assert.equal(by['celestrak.org'].kind, 'api');
  for (const noise of ['www.w3.org', 'localhost', 'feeds.example.net', 'registry.npmjs.org', 'evil-dependency-host.com', 'built-output-host.com', 'opensource.org', 'db.supersecret-host.com']) assert.ok(!by[noise], noise + ' should not be listed');
  // the .env file contributes key names, never values or the hosts in values
  assert.ok(s.env.includes('STRIPE_SECRET_KEY') && s.env.includes('DATABASE_URL'));
  assert.ok(!s.env.includes('PORT'), 'PORT is not a credential');
  const all = JSON.stringify(s);
  assert.ok(!/FAKEVALUE|hunter2|FAKE_TOKEN/.test(all), 'no secret value anywhere in the scan');
  // the bot token in the URL path is redacted in the example URL
  const ex = by['api.telegram.org'].urls.join(' ');
  assert.ok(/api\.telegram\.org\/…/.test(ex) || !/FAKE_TOKEN_FOR/.test(ex), ex);
  assert.ok(s.files >= 5 && s.files < 12, 'files read: ' + s.files);
});

test('scanText(): query strings and userinfo never survive; a file name is not a host', () => {
  const r = sources.scanText("fetch('https://api.example-service.io/v2/items?token=SECRETTOKENVALUE123&x=1'); import x from './vendor/lib.min.js'; const u = 'https://user:pw@private.example-service.io/'");
  const api = r.hosts.get('api.example-service.io');
  assert.ok(api && api.kind === 'api');
  assert.ok(!/SECRETTOKENVALUE/.test([...api.urls].join()), [...api.urls].join());
  assert.ok(r.hosts.has('private.example-service.io'), 'userinfo stripped, host kept');
  assert.ok(![...r.hosts.keys()].some((h) => /\.js$/.test(h)));
  assert.equal(sources.redactUrl('https://h.io/bot123:FAKE_TOKEN_FOR_TESTS_ONLY_0000000000/sendMessage?chat=1'), 'https://h.io/…/sendMessage');
});

test('classify(): by host first, then by path shape', () => {
  assert.equal(sources.classify('api.stripe.com', ''), 'api');
  assert.equal(sources.classify('hooks.slack.com', '/services/x'), 'api');
  assert.equal(sources.classify('cdn.jsdelivr.net', ''), 'cdn');
  assert.equal(sources.classify('unpkg.com', ''), 'cdn');
  assert.equal(sources.classify('pypi.org', ''), 'package');
  assert.equal(sources.classify('developer.mozilla.org', ''), 'docs');
  assert.equal(sources.classify('plumetail.com', '/api/launches'), 'api');
  assert.equal(sources.classify('plumetail.com', '/feed.xml'), 'feed');
  assert.equal(sources.classify('plumetail.com', '/rss'), 'feed');
  assert.equal(sources.classify('plumetail.com', '/about'), 'site');
});

test('topLevel(): nested folders fold into their project; the home folder is dropped', () => {
  const list = sources.topLevel([
    { path: 'D:\\Files\\sourcecode\\Claude_Dashboard\\web\\src\\lib', name: 'lib' },
    { path: 'D:\\Files\\sourcecode\\Claude_Dashboard', name: 'Claude_Dashboard' },
    { path: 'd:\\files\\sourcecode\\claude_dashboard\\web', name: 'web' },
    { path: 'D:\\Files\\sourcecode\\plumetail', name: 'plumetail' },
    { path: 'C:\\Users\\b', name: 'Global (user)' },
  ], 'C:\\Users\\b');
  assert.deepEqual(list.map((p) => p.name).sort(), ['Claude_Dashboard', 'plumetail']);
});

test('pickProjects(): root children always; session folders only with project markers; never temp or scratch folders', () => {
  const base = tmpdir('gander-sources-pick-');
  const mk = (rel, marker) => { const d = path.join(base, rel); fs.mkdirSync(d, { recursive: true }); if (marker) fs.writeFileSync(path.join(d, marker), ''); return d; };
  const rootChild = mk('code/alpha');
  const withGit = mk('elsewhere/beta', '.git');
  const withClaude = mk('elsewhere/gamma', 'CLAUDE.md');
  const bare = mk('elsewhere/x');
  const temp = mk('Temp/claude/abc/scratchpad', 'package.json');
  const list = sources.pickProjects([
    { path: rootChild, name: 'alpha', sources: ['root'] },
    { path: withGit, name: 'beta', sources: ['session'] },
    { path: withClaude, name: 'gamma', sources: ['session'] },
    { path: bare, name: 'x', sources: ['session'] },
    { path: temp, name: 'scratchpad', sources: ['session'] },
    { path: path.join(withGit, 'web'), name: 'web', sources: ['session'] },
  ], 'C:\\Users\\nobody');
  assert.deepEqual(list.map((p) => p.name).sort(), ['alpha', 'beta', 'gamma']);
});

test('merge(): one row per host across projects, shared first, own flag by apex, checks attached', () => {
  const scans = [
    { name: 'a', path: '/a', hosts: [{ host: 'api.telegram.org', kind: 'api', count: 3, files: ['x.js'], urls: [], env: ['TG_BOT_TOKEN'] }, { host: 'aiworkernow.com', kind: 'site', count: 1, files: [], urls: [], env: [] }] },
    { name: 'b', path: '/b', hosts: [{ host: 'api.telegram.org', kind: 'api', count: 1, files: ['y.py'], urls: [], env: ['TELEGRAM_TOKEN'] }, { host: 'www.aiworkernow.com', kind: 'site', count: 9, files: [], urls: [], env: [] }] },
  ];
  const rows = sources.merge(scans, { own: ['aiworkernow.com'], checks: { 'api.telegram.org': { ok: true, status: 200, ms: 90, at: 1 } } });
  assert.equal(rows[0].host, 'api.telegram.org');
  assert.equal(rows[0].shared, true);
  assert.deepEqual(rows[0].projects.map((p) => p.name), ['a', 'b']);
  assert.deepEqual(rows[0].env, ['TELEGRAM_TOKEN', 'TG_BOT_TOKEN']);
  assert.equal(rows[0].check.ok, true);
  assert.ok(rows.find((r) => r.host === 'www.aiworkernow.com').own, 'apex match marks the subdomain as own');
  assert.ok(rows.find((r) => r.host === 'aiworkernow.com').own);
});

test('toMarkdown(): a table per kind, package registries left out, then a by-project list', () => {
  const rows = sources.merge([{ name: 'a', path: '/a', hosts: [{ host: 'api.deepseek.com', kind: 'api', code: true, count: 1, files: [], urls: [], env: ['DEEPSEEK_API_KEY'] }, { host: 'pypi.org', kind: 'package', code: true, count: 1, files: [], urls: [], env: [] }, { host: 'blog.example-notes.io', kind: 'site', code: false, count: 40, files: ['notes.md'], urls: [], env: [] }] }]);
  const md = sources.toMarkdown(rows, [{ name: 'a', path: '/a' }]);
  assert.ok(!/example-notes/.test(md), 'a docs-only mention stays out of the Markdown');
  assert.match(sources.toMarkdown(rows, [{ name: 'a', path: '/a' }], { mentions: true }), /example-notes/);
  assert.deepEqual(sources.checkable(rows), ['api.deepseek.com']);
  const one = sources.toMarkdown(sources.merge([{ name: 'a', path: '/a', hosts: [{ host: 'api.one.io', kind: 'api', code: true, count: 1, files: [], urls: [], env: [] }] }, { name: 'b', path: '/b', hosts: [{ host: 'api.two.io', kind: 'api', code: true, count: 1, files: [], urls: [], env: [] }] }]), [{ name: 'a', path: '/a' }, { name: 'b', path: '/b' }], { project: '/b' });
  assert.match(one, /^# External sources · b\n/);
  assert.ok(/api\.two\.io/.test(one) && !/api\.one\.io/.test(one) && !/## By project/.test(one), one);
  assert.equal(rows[rows.length - 1].host, 'blog.example-notes.io', 'mentions sort last');
  assert.match(md, /## APIs & services/);
  assert.match(md, /\| api\.deepseek\.com \| a \| DEEPSEEK_API_KEY \|/);
  assert.ok(!/pypi/.test(md));
  assert.match(md, /### a\n\n- api\.deepseek\.com \(api\)/);
});

test('createStore(): rescan, view with shared rows, own toggle, forget', async () => {
  const dir = fixture();
  const other = tmpdir('gander-sources-b-');
  fs.writeFileSync(path.join(other, 'app.js'), "fetch('https://api.telegram.org/x'); fetch('https://api.mouser.com/api/v1/search')");
  const store = sources.createStore(path.join(tmpdir('gander-sources-store-'), 'sources.json'));
  const list = [{ path: dir, name: 'fixture' }, { path: other, name: 'other' }];
  store.rescan(list);
  for (let i = 0; i < 100 && store.view(list).scanning; i++) await new Promise((r) => setTimeout(r, 50));
  const v = store.view(list);
  assert.equal(v.scanning, false);
  assert.equal(v.projects.length, 2);
  assert.ok(v.projects.every((p) => p.scannedAt && p.hosts > 0));
  const tg = v.rows.find((r) => r.host === 'api.telegram.org');
  assert.ok(tg && tg.shared && tg.projects.length === 2, JSON.stringify(tg));
  assert.equal(v.rows[0].host, 'api.telegram.org', 'shared sources first');
  store.setOwn('aiworkernow.com', true);
  assert.ok(store.view(list).rows.find((r) => r.host === 'aiworkernow.com').own);
  store.setOwn('aiworkernow.com', false);
  assert.ok(!store.view(list).rows.find((r) => r.host === 'aiworkernow.com').own);
  store.forget([list[0]]);
  assert.equal(store.view(list).projects.find((p) => p.name === 'other').scannedAt, null);
});
