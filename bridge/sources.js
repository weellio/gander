'use strict';
// External sources: every API, website, feed, CDN and service a project talks to,
// found by reading the project's own files. One registry across all projects, so
// "what does X use?" and "who else already talks to this API?" have an answer,
// and the credentials a source needs (the env var NAMES, never values) sit beside it.
//
// Pure where it can be: scanText() and classify() take strings; scanProject()
// walks a folder with async reads and yields so the bridge never stalls; the
// cache file is this module's own. Nothing here changes a project.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const SKIP_DIRS = new Set(['node_modules', '.git', '.gander', 'dist', 'build', 'out', '.next', '.svelte-kit', 'coverage', 'vendor', '__pycache__', '.venv', 'venv', 'env', 'target', '.cache', '.parcel-cache', '.turbo', 'bower_components', '.idea', '.vscode', 'tmp', 'temp', 'logs', 'extras', 'assets', 'public/models']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.svelte', '.vue', '.html', '.htm', '.css', '.scss', '.py', '.php', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.sh', '.ps1', '.bat', '.cmd', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.md', '.txt', '.sql', '.xml', '.plist', '.gradle', '.csproj', '.env', '.example', '.sample', '.template', '.mjml', '.njk', '.ejs', '.hbs']);
const LOCK_FILES = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|poetry\.lock|pipfile\.lock|composer\.lock|gemfile\.lock|bun\.lockb?|flake\.lock)$/i;
// A host in one of these files is something the code TALKS TO. In .md/.txt/.json/.csv it
// is a mention (a link in notes, a row in a data file): kept, but flagged, and hidden by
// default — a research folder with 4,000 links is not 4,000 sources.
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.svelte', '.vue', '.html', '.htm', '.css', '.scss', '.py', '.php', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.sh', '.ps1', '.bat', '.cmd', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.mjml', '.njk', '.ejs', '.hbs', '.gradle', '.csproj']);
const CODE_NAME = /^(dockerfile|makefile|procfile|caddyfile|\.htaccess|\.npmrc|package\.json|\.mcp\.json|settings(\.local)?\.json|[a-z0-9.-]*config\.json|composer\.json|tsconfig\.json|vite\.config\.[a-z]+|wrangler\.toml)$/i;
function isCodeFile(name) { return CODE_EXT.has(path.extname(name).toLowerCase()) || CODE_NAME.test(name) || isEnvFile(name); }
const MAX_FILE = 256 * 1024;        // a code file bigger than this is a bundle or a dump
const MAX_DATA_FILE = 64 * 1024;    // .md/.json/.txt/.csv/.xml above this is a data dump: skipped (it could only ever be a mention)
const MAX_FILES = 6000;
const MAX_DEPTH = 7;

// Hosts that are never a source: namespaces, licenses, placeholders, the loopback.
const NOISE_HOST = /(^|\.)(w3\.org|schema\.org|schemas\.microsoft\.com|schemas\.android\.com|json-schema\.org|purl\.org|xmlns\.com|ns\.adobe\.com|example\.(com|org|net)|spdx\.org|opensource\.org|creativecommons\.org|gnu\.org|apache\.org|choosealicense\.com|mit-license\.org|localhost|127\.0\.0\.1|0\.0\.0\.0|iana\.org|ietf\.org|rfc-editor\.org|xmlsoap\.org|openxmlformats\.org|android\.com|apple\.com\/DTDs)$/i;
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/;

const KIND_RULES = [
  ['cdn', /(^|\.)(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.tailwindcss\.com|code\.jquery\.com|esm\.sh|ga\.jspm\.io|cdn\.skypack\.dev|cloudfront\.net|cdn\.[a-z0-9.-]+|ajax\.googleapis\.com|stackpath\.bootstrapcdn\.com|cdn\.plot\.ly)$/i],
  ['package', /(^|\.)(registry\.npmjs\.org|npmjs\.com|pypi\.org|files\.pythonhosted\.org|crates\.io|rubygems\.org|packagist\.org|nuget\.org|deno\.land|hub\.docker\.com|ghcr\.io|mvnrepository\.com|repo1\.maven\.org|plugins\.gradle\.org|dl\.google\.com|nodejs\.org|python\.org|go\.dev|pkg\.go\.dev|rust-lang\.org|marketplace\.visualstudio\.com)$/i],
  ['docs', /^(docs|developer|developers|learn|help|support|wiki|community|forum|kb)\.|(^|\.)(readthedocs\.io|developer\.mozilla\.org|learn\.microsoft\.com|code\.claude\.com|stackoverflow\.com|medium\.com|dev\.to|wikipedia\.org|wikimedia\.org|svelte\.dev|vitejs\.dev|nodejs\.org\/docs)$/i],
  ['repo', /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|raw\.githubusercontent\.com|gist\.github\.com|codeberg\.org|huggingface\.co)$/i],
  ['api', /^(api|apis|rest|graphql|gateway|ws|wss|hooks|webhook|webhooks|oauth|oauth2|auth|login|accounts|id|sso|ll|data|open|service|services|api-[a-z0-9-]+|[a-z0-9-]+-api)\.|(^|\.)(googleapis\.com|amazonaws\.com|supabase\.co|supabase\.in|fal\.run|fal\.ai|thespacedevs\.com|celestrak\.org|celestrak\.com|telegram\.org|slack\.com|discord\.com|discordapp\.com|stripe\.com|openai\.com|anthropic\.com|deepseek\.com|mouser\.com|mouser\.pl|printify\.com|etsy\.com|cloudflare\.com|resend\.com|sendgrid\.net|mailgun\.net|twilio\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|youtube\.com|youtu\.be|googlevideo\.com|reddit\.com|pullpush\.io|arctic-shift\.photon-reddit\.com|hostinger\.com|n8n\.cloud|ollama\.com|ollama\.ai|openrouter\.ai|together\.ai|replicate\.com|elevenlabs\.io|heygen\.com|artlist\.io|nasa\.gov|noaa\.gov|weather\.gov|sam\.gov|tdlr\.texas\.gov|opencorporates\.com|ipapi\.co|ipinfo\.io|tile\.openstreetmap\.org|nominatim\.openstreetmap\.org|cesium\.com|ion\.cesium\.com|mapbox\.com|maptiler\.com)$/i],
  ['feed', /^(feeds?|rss|atom|news)\./i],
];

function classify(host, urlPath) {
  const h = String(host || '').toLowerCase();
  const p = String(urlPath || '');
  for (const [kind, re] of KIND_RULES) if (re.test(h)) return kind;
  if (/\/(feeds?|rss|atom)(\.|\/|$)|\.(rss|atom)(\?|$)/i.test(p)) return 'feed';
  if (/\/(api|rest|graphql|v\d+|oauth2?|webhooks?|rpc|jsonrpc|\.well-known)(\/|$)/i.test(p) || /\.(json|xml|csv)(\?|$)/i.test(p)) return 'api';
  return 'site';
}

// A URL or host literal with anything secret-looking taken out: no query string,
// no userinfo, no long opaque path segments (bot tokens, keys, signed blobs).
function redactUrl(u) {
  let s = String(u || '').split(/[?#]/)[0];
  s = s.replace(/\/\/[^/@]+@/, '//');
  s = s.replace(/\/[^/]*[A-Za-z0-9_:-]{20,}[^/]*/g, (seg) => (/^\/(v\d+|api|[a-z-]{1,20})$/i.test(seg) ? seg : '/…'));
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
}

const URL_RE = /\bhttps?:\/\/(?:[^\s'"`<>()[\]{}\\,;@]*@)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+|\d{1,3}(?:\.\d{1,3}){3})(?::\d{2,5})?(\/[^\s'"`<>()[\]{}\\,;]*)?/gi;
// Bare host literals in quotes: `host: 'api.telegram.org'`, "ll.thespacedevs.com".
const HOST_LIT_RE = /['"`]((?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|gov|edu|space|tv|me|us|uk|de|fr|eu|cloud|run|sh|xyz|info|biz|live|tech|pl|in|ca|au|nz|site|online|store|shop|news|fm|gg|so|to|cc|ly|ws|ee|is|it|es|nl|be|ch|at|se|no|fi|dk|jp|kr|cn|br|mx|ar|za|ng|ke|id|sg|hk|tw|ru|ua|cz|sk|hu|ro|gr|pt|ie))(?::\d{2,5})?['"`]/gi;
// Credential and endpoint NAMES only: process.env.X, os.environ['X'], os.getenv('X'), $env:X, ${X}, X= in an env file.
const ENV_RE = /process\.env\.([A-Z][A-Z0-9_]{2,})|os\.environ(?:\.get)?\(?\[?['"]([A-Z][A-Z0-9_]{2,})['"]|os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]|\$env:([A-Z][A-Z0-9_]{2,})|\$\{([A-Z][A-Z0-9_]{2,})\}|getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]|import\.meta\.env\.([A-Z][A-Z0-9_]{2,})|Deno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g;
const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/gm;
const CRED_NAME = /(KEY|TOKEN|SECRET|PASS|PASSWORD|PWD|API|AUTH|CLIENT_ID|CLIENT_SECRET|DSN|URL|URI|HOST|WEBHOOK|ENDPOINT|BUCKET|REGION|ACCOUNT|CHAT_ID|BOT|APP_ID|SID|LICENSE|CREDENTIAL)/;

function hostOk(host) {
  const h = String(host || '').toLowerCase();
  if (!h || NOISE_HOST.test(h) || PRIVATE_IP.test(h)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (!/\.[a-z]{2,}$/i.test(h)) return false;
  if (/\.(js|mjs|cjs|ts|tsx|jsx|css|html|svelte|vue|json|md|txt|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map|min|py|php|rb|yml|yaml|toml|lock|d)$/i.test(h)) return false;   // a file name, not a host
  return true;
}

// Scan one file's text. Returns { hosts: Map(host -> { kind, count, urls:Set }), env: Set }.
// `isEnvFile`: an .env-style file: KEY names only, the values are never read for URLs.
function scanText(text, opts = {}) {
  const hosts = new Map();
  const env = new Set();
  const t = String(text || '');
  const add = (host, kind, url) => {
    const h = host.toLowerCase();
    if (!hostOk(h)) return;
    const cur = hosts.get(h) || { kind, count: 0, urls: new Set() };
    cur.count++;
    if (url && cur.urls.size < 3) cur.urls.add(redactUrl(url));
    if (cur.kind === 'site' && kind !== 'site') cur.kind = kind;
    hosts.set(h, cur);
  };
  if (opts.isEnvFile) {
    let m; ENV_LINE_RE.lastIndex = 0;
    while ((m = ENV_LINE_RE.exec(t))) if (CRED_NAME.test(m[1])) env.add(m[1]);
    return { hosts, env };
  }
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(t))) add(m[1], classify(m[1], m[2] || ''), m[0]);
  HOST_LIT_RE.lastIndex = 0;
  while ((m = HOST_LIT_RE.exec(t))) add(m[1], classify(m[1], ''), '');
  ENV_RE.lastIndex = 0;
  while ((m = ENV_RE.exec(t))) { const name = m.slice(1).find(Boolean); if (name && CRED_NAME.test(name)) env.add(name); }
  if (opts.envLines) { ENV_LINE_RE.lastIndex = 0; while ((m = ENV_LINE_RE.exec(t))) if (CRED_NAME.test(m[1])) env.add(m[1]); }
  return { hosts, env };
}

function isEnvFile(name) { return /^\.env(\..+)?$/i.test(name) || /\.env\.(example|sample|template|local|production|development)$/i.test(name); }
function wantFile(name, rel) {
  if (LOCK_FILES.test(name)) return false;
  if (/\.(min\.(js|css)|map|bundle\.js)$/i.test(name)) return false;
  if (/(^|\/)(dist|build|out)\//.test(rel)) return false;
  if (isEnvFile(name)) return true;
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  return /^(dockerfile|makefile|procfile|caddyfile|\.gitignore|\.npmrc|\.htaccess|\.env)$/i.test(name);
}

const yieldNow = () => new Promise((r) => setImmediate(r));

// Walk a project folder and merge every file's findings. Yields between files so
// the bridge's event loop keeps breathing; bounded in depth, count and file size.
async function scanProject(dir, opts = {}) {
  const root = path.resolve(dir);
  const hosts = new Map();   // host -> { kind, count, urls:Set, files:Set, env:Set }
  const env = new Set();
  let files = 0, skipped = 0;
  const walk = async (d, rel, depth) => {
    if (depth > MAX_DEPTH || files >= MAX_FILES) return;
    let ents; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (files >= MAX_FILES) return;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(r) || (e.name.startsWith('.') && e.name !== '.claude' && e.name !== '.github')) continue;
        await walk(path.join(d, e.name), r, depth + 1);
      } else if (e.isFile()) {
        if (!wantFile(e.name, r)) continue;
        let st; try { st = await fs.promises.stat(path.join(d, e.name)); } catch (_) { continue; }
        const code = isCodeFile(e.name);
        if (st.size > (code ? MAX_FILE : MAX_DATA_FILE)) { skipped++; continue; }
        let text; try { text = await fs.promises.readFile(path.join(d, e.name), 'utf8'); } catch (_) { continue; }
        files++;
        const envFile = isEnvFile(e.name);
        const found = scanText(text, { isEnvFile: envFile, envLines: /\.(ya?ml|toml|ini|cfg|conf)$/i.test(e.name) || /^\.env/i.test(e.name) });
        for (const name of found.env) env.add(name);
        for (const [h, v] of found.hosts) {
          const cur = hosts.get(h) || { kind: v.kind, count: 0, urls: new Set(), files: new Set(), env: new Set(), code: false };
          cur.count += v.count;
          if (code) cur.code = true;
          for (const u of v.urls) if (cur.urls.size < 3) cur.urls.add(u);
          if (cur.files.size < 6) cur.files.add(r);
          if (cur.kind === 'site' && v.kind !== 'site') cur.kind = v.kind;
          for (const name of found.env) if (cur.env.size < 8) cur.env.add(name);   // credentials named in the same file
          hosts.set(h, cur);
        }
        if (files % 25 === 0) await yieldNow();
      }
    }
  };
  await walk(root, '', 0);
  const list = Array.from(hosts, ([host, v]) => ({ host, kind: v.kind, code: !!v.code, count: v.count, urls: [...v.urls], files: [...v.files], env: [...v.env].sort() }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  return { path: root, name: opts.name || path.basename(root), scannedAt: Date.now(), files, skipped, hosts: list, env: [...env].sort() };
}

// Which discovered folders are projects worth scanning: anything directly under a
// configured root, or a session folder that looks like a codebase (.git, .claude,
// CLAUDE.md, package.json, pyproject.toml, .mcp.json). Never a temp or scratch
// folder: sessions start there for one-off scripts and those are not sources.
const TEMP_PATH = /[\\/](temp|tmp)[\\/]claude[\\/]|[\\/]scratch(pad)?([\\/]|$)|[\\/](temp|tmp|\.gander|cache)$/i;   // Claude scratchpads, scratch folders, a folder that IS the temp dir
const MARKERS = ['.git', '.claude', 'CLAUDE.md', 'package.json', 'pyproject.toml', '.mcp.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'composer.json'];
function looksLikeProject(dir) {
  try { return MARKERS.some((m) => fs.existsSync(path.join(dir, m))); } catch (_) { return false; }
}
function pickProjects(discovered, homeDir) {
  const keep = (discovered || []).filter((p) => p && p.path && !TEMP_PATH.test(String(p.path)) && ((p.sources || []).includes('root') || looksLikeProject(p.path)));
  return topLevel(keep, homeDir);
}

// Projects nested inside another listed project (web/, web/src/lib) are the same
// codebase: keep the top-most folder only. The home folder ("Global") is skipped.
function topLevel(projects, homeDir) {
  const norm = (p) => path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const home = homeDir ? norm(homeDir) : null;
  const all = (projects || []).filter((p) => p && p.path && norm(p.path) !== home).map((p) => ({ ...p, _n: norm(p.path) }));
  const seen = new Set();
  const out = [];
  for (const p of all.sort((a, b) => a._n.length - b._n.length)) {
    if (seen.has(p._n) || all.some((q) => q._n !== p._n && p._n.startsWith(q._n + '/'))) continue;
    seen.add(p._n);
    out.push({ path: p.path, name: p.name || path.basename(p.path) });
  }
  return out;
}

// Merge per-project scans into one registry: a row per host with every project
// that uses it, so shared sources float up.
function merge(scans, opts = {}) {
  const own = new Set((opts.own || []).map((s) => String(s).toLowerCase()));
  const apex = (h) => { const parts = h.split('.'); return parts.length > 2 && !/^(co|com|org|net|gov|edu|ac)$/.test(parts[parts.length - 2]) ? parts.slice(-2).join('.') : parts.slice(-3).join('.'); };
  const map = new Map();
  for (const s of scans || []) {
    for (const h of s.hosts || []) {
      const cur = map.get(h.host) || { host: h.host, kind: h.kind, own: own.has(h.host) || own.has(apex(h.host)), code: false, total: 0, env: new Set(), projects: [] };
      cur.total += h.count;
      if (h.code !== false) cur.code = true;   // scans from before the flag existed count as code
      if (cur.kind === 'site' && h.kind !== 'site') cur.kind = h.kind;
      for (const n of h.env || []) cur.env.add(n);
      cur.projects.push({ name: s.name, path: s.path, count: h.count, code: h.code !== false, files: h.files || [], urls: h.urls || [], env: h.env || [] });
      map.set(h.host, cur);
    }
  }
  const checks = opts.checks || {};
  return Array.from(map.values())
    .map((r) => ({ ...r, env: [...r.env].sort(), projects: r.projects.sort((a, b) => b.count - a.count), shared: r.projects.length > 1, check: checks[r.host] || null }))
    .sort((a, b) => (b.code - a.code) || b.projects.length - a.projects.length || b.total - a.total || a.host.localeCompare(b.host));
}

// The hosts worth checking for reachability: what the code talks to, APIs and feeds, plus your own domains.
function checkable(rows, cap = 150) {
  return rows.filter((r) => r.own || (r.code && (r.kind === 'api' || r.kind === 'feed'))).map((r) => r.host).slice(0, cap);
}

// Minimal monitoring: is the host answering at all? HEAD https://host/, GET on
// 405, 6 s cap. 401/403/404 count as up (it answered); 5xx, timeouts and DNS
// failures do not.
function checkHost(host, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const done = (status, error, method) => resolve({ host, status: status || 0, ok: !!status && status < 500, ms: Date.now() - t0, at: Date.now(), error: error || '', method: method || 'HEAD' });
    const go = (method, scheme, hops) => {
      const mod = scheme === 'http:' ? http : https;
      const req = mod.request({ host, method, path: '/', timeout: timeoutMs, headers: { 'user-agent': 'gander-sources/1 (+local)' } }, (res) => {
        res.resume();
        if (res.statusCode === 405 && method === 'HEAD') return go('GET', scheme, hops);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 2 && /^https?:\/\//.test(res.headers.location)) {
          try { const u = new URL(res.headers.location); if (u.hostname === host) return go(method, u.protocol, hops + 1); } catch (_) {}
        }
        done(res.statusCode, '', method);
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => { if (scheme === 'https:' && /ECONNREFUSED|EPROTO|CERT|ssl/i.test(e.message) && hops === 0) return go(method, 'http:', 1); done(0, e.code || e.message, method); });
      req.end();
    };
    go('HEAD', 'https:', 0);
  });
}

async function checkMany(hosts, concurrency = 6) {
  const out = {};
  const q = [...hosts];
  const worker = async () => { while (q.length) { const h = q.shift(); out[h] = await checkHost(h); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, q.length) }, worker));
  return out;
}

const KIND_LABEL = { api: 'APIs & services', site: 'Websites', feed: 'Feeds', cdn: 'CDNs & fonts', repo: 'Repos', docs: 'Docs', package: 'Package registries' };
const KIND_ORDER = ['api', 'feed', 'site', 'cdn', 'repo', 'docs', 'package'];

// The whole registry as Markdown, for pasting into another project's notes.
function toMarkdown(allRows, allProjects, opts = {}) {
  const only = opts.project ? path.resolve(String(opts.project)).toLowerCase() : '';
  const projects = only ? allProjects.filter((p) => path.resolve(p.path).toLowerCase() === only) : allProjects;
  const rows = allRows.filter((r) => (opts.mentions || r.code) && (opts.includeNoise || r.kind !== 'package') && (!only || r.projects.some((p) => path.resolve(p.path).toLowerCase() === only)));
  const title = only && projects[0] ? `# External sources · ${projects[0].name}` : '# External sources';
  const lines = [title, '', `${projects.length} project${projects.length === 1 ? '' : 's'} scanned · ${rows.length} hosts the code talks to · ${new Date(opts.at || Date.now()).toISOString().slice(0, 10)}`, ''];
  for (const kind of KIND_ORDER) {
    const rs = rows.filter((r) => r.kind === kind);
    if (!rs.length) continue;
    lines.push(`## ${KIND_LABEL[kind] || kind}`, '', '| Host | Used by | Credentials (env names) | Last check |', '|---|---|---|---|');
    for (const r of rs) {
      const chk = r.check ? (r.check.ok ? `up (${r.check.status})` : `DOWN (${r.check.error || r.check.status})`) : '';
      lines.push(`| ${r.own ? '⭐ ' : ''}${r.host} | ${r.projects.map((p) => p.name).join(', ')} | ${r.env.join(', ')} | ${chk} |`);
    }
    lines.push('');
  }
  if (!only) lines.push('## By project', '');
  for (const p of only ? [] : projects) {
    const mine = rows.filter((r) => r.projects.some((x) => x.path === p.path && x.code));
    if (!mine.length) continue;
    lines.push(`### ${p.name}`, '', mine.map((r) => `- ${r.host} (${r.kind})`).join('\n'), '');
  }
  return lines.join('\n');
}

// ── the registry file ──
function createStore(file) {
  let data = { projects: {}, checks: {}, own: [] };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(data)); } catch (_) {} };
  let scanning = new Set();
  let queue = [];
  let running = false;
  const key = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const pump = async () => {
    if (running) return;
    running = true;
    while (queue.length) {
      const { path: p, name } = queue.shift();
      scanning.add(key(p));
      try { const s = await scanProject(p, { name }); data.projects[key(p)] = s; save(); } catch (_) {}
      scanning.delete(key(p));
    }
    running = false;
  };
  return {
    rescan(list) {
      for (const p of list) if (!queue.some((q) => key(q.path) === key(p.path)) && !scanning.has(key(p.path))) queue.push(p);
      pump();
      return { queued: queue.length + scanning.size };
    },
    // scan what was never scanned (or is older than maxAgeMs), nothing else
    refresh(list, maxAgeMs) {
      const due = list.filter((p) => { const s = data.projects[key(p.path)]; return !s || (maxAgeMs && Date.now() - s.scannedAt > maxAgeMs); });
      return due.length ? this.rescan(due) : { queued: 0 };
    },
    forget(list) {
      const keep = new Set(list.map((p) => key(p.path)));
      for (const k of Object.keys(data.projects)) if (!keep.has(k)) delete data.projects[k];
    },
    view(list) {
      const scans = list.map((p) => data.projects[key(p.path)]).filter(Boolean);
      const rows = merge(scans, { own: data.own, checks: data.checks });
      const projects = list.map((p) => { const s = data.projects[key(p.path)]; return { name: p.name, path: p.path, scannedAt: s ? s.scannedAt : null, files: s ? s.files : 0, hosts: s ? s.hosts.length : 0, env: s ? s.env : [], scanning: scanning.has(key(p.path)) }; });
      return { rows, projects, own: data.own, scanning: scanning.size > 0 || queue.length > 0, lastCheckAt: Object.values(data.checks).reduce((m, c) => Math.max(m, c.at || 0), 0) || null };
    },
    async check(hosts) {
      const r = await checkMany(hosts);
      Object.assign(data.checks, r);
      save();
      return r;
    },
    setOwn(host, on) {
      const h = String(host || '').toLowerCase().trim();
      if (!h) return data.own;
      data.own = data.own.filter((x) => x !== h);
      if (on) data.own.push(h);
      save();
      return data.own;
    },
    checks: () => data.checks,
  };
}

module.exports = { scanText, scanProject, classify, redactUrl, topLevel, pickProjects, looksLikeProject, merge, checkable, checkHost, checkMany, toMarkdown, createStore, hostOk, isCodeFile, KIND_LABEL, KIND_ORDER };
