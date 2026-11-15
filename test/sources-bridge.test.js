'use strict';
// The 🌐 Sources registry on a real bridge: the first GET scans the known projects,
// rows merge across them, own-domain and daily toggles persist, Markdown and the
// connector dataset carry the same hosts, and a check marks a dead host down.
const { test, describe, before, after } = require('node:test');
const { tmpdir } = require('./_tmp.js');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function call(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(out || 'null'); } catch (_) {} resolve({ status: res.statusCode, json, text: out }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function waitUp(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await call(port, 'GET', '/api/state'); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('bridge did not come up');
}

describe('the sources registry on a real bridge', () => {
  let child, port, out = '', root;
  before(async () => {
    port = await freePort();
    const dir = tmpdir('gander-srcb-');
    root = path.join(dir, 'code');
    const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
    // two projects under one root (a project = a folder with .claude/), one nested folder that must fold into its parent
    w('blog/.claude/settings.json', '{}');
    w('blog/post.js', "fetch('https://api.telegram.org/bot' + process.env.TG_BOT_TOKEN + '/sendMessage'); fetch('https://ll.thespacedevs.com/2.3.0/launches/');");
    w('blog/web/index.html', '<script src="https://cdnjs.cloudflare.com/ajax/libs/x/1/x.min.js"></script>');
    w('shop/.claude/settings.json', '{}');
    w('shop/pay.py', 'import os\nk = os.environ["STRIPE_SECRET_KEY"]\nr = requests.post("https://api.stripe.com/v1/charges")\nt = "https://api.telegram.org/x"');
    fs.writeFileSync(path.join(dir, 'aoc-projects.json'), JSON.stringify({ roots: [root], known: [path.join(root, 'blog', 'web')] }));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'server.js'), '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AOC_QUEUE_FILE: path.join(dir, 'q.json'), AOC_REGISTRY_FILE: path.join(dir, 'reg.json'), GANDER_NO_OPEN: '1', GANDER_NO_NUDGE: '1', GANDER_SETTINGS: path.join(dir, 'settings.json'), AOC_CONFIG_FILE: path.join(dir, 'aoc-config.json'), AOC_PROJECTS_FILE: path.join(dir, 'aoc-projects.json'), AOC_SOURCES_FILE: path.join(dir, 'sources.json') },
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    await waitUp(port);
  });
  after(() => { try { child.kill(); } catch (_) {} });

  async function settled() {
    let v;
    for (let i = 0; i < 200; i++) {
      v = (await call(port, 'GET', '/api/sources')).json;
      if (v && !v.scanning && v.projects.every((p) => p.scannedAt)) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    return v;
  }

  test('first GET scans the known projects; nested folders fold in; rows merge with shared sources first', async () => {
    const v = await settled();
    const names = v.projects.map((p) => p.name).sort();
    assert.deepEqual(names, ['blog', 'shop'], JSON.stringify(v.projects) + out.slice(-400));
    assert.equal(v.rows[0].host, 'api.telegram.org', v.rows.map((r) => r.host).join(','));
    assert.equal(v.rows[0].shared, true);
    assert.deepEqual(v.rows[0].projects.map((p) => p.name).sort(), ['blog', 'shop']);
    assert.ok(v.rows[0].env.includes('TG_BOT_TOKEN'));
    const stripe = v.rows.find((r) => r.host === 'api.stripe.com');
    assert.ok(stripe && stripe.kind === 'api' && stripe.env.includes('STRIPE_SECRET_KEY'));
    const cdn = v.rows.find((r) => r.host === 'cdnjs.cloudflare.com');
    assert.ok(cdn && cdn.kind === 'cdn' && cdn.projects[0].files.includes('web/index.html'), 'the nested web/ folder scanned as part of blog');
    assert.equal(v.dailyCheck, false);
  });

  test('own-domain and daily toggles persist; Markdown and the connector dataset carry the hosts', async () => {
    let r = await call(port, 'POST', '/api/sources/own', { host: 'api.stripe.com', own: true });
    assert.deepEqual(r.json.own, ['api.stripe.com']);
    const v = (await call(port, 'GET', '/api/sources')).json;
    assert.ok(v.rows.find((x) => x.host === 'api.stripe.com').own);
    r = await call(port, 'POST', '/api/sources/daily', { enabled: true });
    assert.equal(r.json.enabled, true);
    assert.equal((await call(port, 'GET', '/api/sources')).json.dailyCheck, true);
    await call(port, 'POST', '/api/sources/daily', { enabled: false });
    const md = await call(port, 'GET', '/api/sources.md');
    assert.equal(md.status, 200);
    assert.match(md.text, /## APIs & services/);
    assert.match(md.text, /\| api\.telegram\.org \| (blog, shop|shop, blog) \|/);
    assert.match(md.text, /### blog/);
    const ds = await call(port, 'GET', '/api/datasets/sources');
    assert.equal(ds.status, 200, ds.text);
    const rows = ds.json.rows;
    assert.ok(rows.some((x) => x.host === 'api.telegram.org' && x.project === 'blog' && /TG_BOT_TOKEN/.test(x.env)));
    assert.ok(rows.some((x) => x.host === 'api.telegram.org' && x.project === 'shop' && x.shared === true));
    const on = await call(port, 'POST', '/api/mcp-config', { enabled: true });
    assert.equal(on.status, 200);
    const list = await call(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
    assert.ok(list.json.result.tools.some((t) => t.name === 'gander_sources'));
  });

  test('a check marks an unresolvable host down and keeps the result; rescan of an unknown project is a 404', async () => {
    const r = await call(port, 'POST', '/api/sources/check', { host: 'does-not-exist.invalid' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.checked, 1);
    assert.equal(r.json.results['does-not-exist.invalid'].ok, false);
    const bad = await call(port, 'POST', '/api/sources/rescan', { path: 'Z:/nope/nothing' });
    assert.equal(bad.status, 404);
    const ok = await call(port, 'POST', '/api/sources/rescan', { path: path.join(root, 'blog') });
    assert.equal(ok.status, 200);
    const v = await settled();
    assert.ok(v.rows.some((x) => x.host === 'api.telegram.org'));
  });
});
