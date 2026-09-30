'use strict';
// bridge/gpu.js — what's on the GPU, and which local models are sitting in it.
//
// Local models are the one part of an agent setup that competes with everything
// else on the machine for the same card. The failure is quiet: a model loaded
// by some background job holds 5–8 GB of VRAM until its keep-alive runs out,
// and the game, the render or the next model just gets slower — or dies with
// Windows' out-of-video-memory code (3221226356) — with nothing saying why.
//
// Sources, all local, all optional (each reports available:false when absent):
//   nvidia-smi               utilisation, VRAM, temperature, power, GPU processes
//   Ollama  /api/ps /tags    loaded models (+ VRAM, keep-alive expiry), installed names
//   LM Studio /api/v0/models loaded models
//
// Zero dependencies. Everything is cached a few seconds, and a short history
// ring feeds the panel's charts.

const http = require('http');
const { execFile } = require('child_process');

const CACHE_MS = 3500;
const HISTORY = 300;                 // ~20 min at one sample per 4 s

// ── parsers (pure — tested) ──────────────────────────────────────────────────
// Number('') is 0, so "[N/A]" stripped to "" read as 0 MB — an empty field is unknown, not zero
const num = (v) => { const s = String(v == null ? '' : v).trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

// --query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,
//             temperature.gpu,power.draw,power.limit,fan.speed,driver_version
function parseSmi(csv) {
  return String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const c = l.split(',').map((s) => s.trim());
    return {
      index: num(c[0]), name: c[1] || 'GPU', util: num(c[2]), memUtil: num(c[3]),
      vramUsedMB: num(c[4]), vramTotalMB: num(c[5]), tempC: num(c[6]),
      powerW: num(c[7]), powerLimitW: num(c[8]), fanPct: num(c[9]), driver: c[10] || '',
    };
  }).filter((g) => g.vramTotalMB);
}

// --query-compute-apps=pid,process_name,used_memory   (Windows reports memory as [N/A]:
// WDDM does not expose per-process VRAM, so we keep the names and say so)
function parseApps(csv) {
  return String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(','), j = l.lastIndexOf(',');
    const pid = num(l.slice(0, i));
    const full = l.slice(i + 1, j).trim();
    const name = full.replace(/^.*[\\/]/, '') || full;
    return { pid, name, path: full, vramMB: num(l.slice(j + 1).replace(/[^\d.]/g, '')) };
  }).filter((a) => a.pid && !/insufficient permissions/i.test(a.path));
}

function parseOllamaPs(j) {
  const models = (j && Array.isArray(j.models)) ? j.models : [];
  return models.map((m) => ({
    name: m.name || m.model, sizeMB: Math.round((m.size || 0) / 1048576), vramMB: Math.round((m.size_vram || 0) / 1048576),
    params: (m.details && m.details.parameter_size) || '', quant: (m.details && m.details.quantization_level) || '',
    family: (m.details && m.details.family) || '', context: m.context_length || null,
    expiresAt: Date.parse(m.expires_at || '') || null,
  }));
}

function parseLmStudio(j) {
  const data = (j && Array.isArray(j.data)) ? j.data : [];
  return data.filter((m) => m.state === 'loaded').map((m) => ({
    name: m.id, params: '', quant: m.quantization || '', family: m.arch || '', context: m.loaded_context_length || m.max_context_length || null,
    vramMB: null, sizeMB: null, expiresAt: null,
  }));
}

// Is this agent's model a local one? Claude Code routed through
// claude-code-router records names like "ollama,qwen2.5-coder:7b"; other tools
// write "ollama/…" or the bare tag. Match against what the runtimes say is
// installed, plus the provider prefixes themselves.
function normModel(s) {
  return String(s || '').trim().toLowerCase().replace(/^(ollama|lmstudio|lm[-_ ]?studio|local)[,/:]/, '').replace(/:latest$/, '');
}
function isLocalModel(model, installed) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return false;
  if (/^(ollama|lmstudio|lm[-_ ]?studio)[,/:]/.test(raw)) return true;
  const n = normModel(raw);
  for (const name of installed || []) if (normModel(name) === n) return true;
  return false;
}

// ── fetchers ─────────────────────────────────────────────────────────────────
function getJson(base, path, timeout = 2000) {
  return new Promise((resolve) => {
    let u; try { u = new URL(path, base); } catch (_) { return resolve(null); }
    const req = http.get({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout }, (r) => {
      let b = ''; r.on('data', (d) => (b += d));
      r.on('end', () => { if ((r.statusCode || 0) >= 400) return resolve(null); try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function postJson(base, path, body, timeout = 8000) {
  return new Promise((resolve) => {
    let u; try { u = new URL(path, base); } catch (_) { return resolve({ error: 'bad url' }); }
    const data = JSON.stringify(body);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
      let b = ''; r.on('data', (d) => (b += d));
      r.on('end', () => resolve((r.statusCode || 0) < 400 ? { ok: true } : { error: 'HTTP ' + r.statusCode + ' ' + b.slice(0, 160) }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timed out' }); });
    req.end(data);
  });
}
function smi(args) {
  return new Promise((resolve) => {
    execFile('nvidia-smi', args, { timeout: 4000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

function ollamaBase(o) {
  let h = (o && o.ollamaUrl) || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  if (!/^https?:\/\//.test(h)) h = 'http://' + h;
  return h.replace(/\/+$/, '').replace('//0.0.0.0', '//127.0.0.1');
}
function lmBase(o) { return ((o && o.lmstudioUrl) || 'http://127.0.0.1:1234').replace(/\/+$/, ''); }

// ── snapshot (cached) + history ──────────────────────────────────────────────
let cache = { at: 0, data: null, inflight: null };
const history = [];
let installedCache = { at: 0, names: [] };

// ── when to touch the graphics driver ────────────────────────────────────────
// nvidia-smi is not free: each call initialises NVML and holds the driver for
// ~150–190 ms (measured on an RTX 3060 with a game running). The first version
// of this module sampled it every 20 s in the background AND on every chip poll
// — two calls every ~6 s while a dashboard was open — and a game on the same
// card froze on a regular beat. So:
//   - the driver is only queried when someone is looking: the GPU panel (full,
//     including the per-program list) or the top-bar chip (stats only, at most
//     once a minute);
//   - while a game is running it is never queried at all — the panel shows the
//     last reading and says why it is paused. Ollama / LM Studio are plain HTTP
//     and keep working, so Unload and Free the GPU still do.
const CHIP_DRIVER_MS = 60000;

// Games are recognised by process name — no driver call needed. Unreal Engine
// games all ship as "<Name>-Win64-Shipping.exe" (Fortnite, Valorant, and many
// more); the rest is a short list of big titles, plus whatever the user adds.
const GAME_DEFAULTS = [
  /-win64-shipping\.exe$/i, /^cs2\.exe$/i, /^dota2\.exe$/i, /^rocketleague\.exe$/i, /^r5apex(_dx12)?\.exe$/i,
  /^gta5\.exe$/i, /^gta5_enhanced\.exe$/i, /^eldenring\.exe$/i, /^overwatch\.exe$/i, /^league of legends\.exe$/i,
  /^cod\.exe$/i, /^destiny2\.exe$/i, /^minecraft\.windows\.exe$/i, /^rdr2\.exe$/i, /^cyberpunk2077\.exe$/i,
  /^starfield\.exe$/i, /^witcher3\.exe$/i, /^bg3(_dx11)?\.exe$/i, /^helldivers2\.exe$/i, /^robloxplayerbeta\.exe$/i,
];
// Launcher and overlay helpers built with Unreal share the "-Win64-Shipping"
// suffix but run whenever the launcher is open, game or no game — Epic's
// overlay (EOSOverlayRenderer) was the first thing the pattern matched, with
// Fortnite closed. Treating them as games would pause Gander all day.
const NOT_GAMES = /^(eosoverlayrenderer|epiconlineservices|unrealcefsubprocess|crashreportclient|epicwebhelper|epicgameslauncher)/i;
function isGame(name, extra) {
  const n = String(name || '').trim();
  if (!n) return false;
  const low = n.toLowerCase();
  if ((extra || []).some((e) => { const x = String(e || '').trim().toLowerCase(); return x && (low === x || low === x + '.exe'); })) return true;
  if (NOT_GAMES.test(n)) return false;
  return GAME_DEFAULTS.some((re) => re.test(n));
}
// "FortniteClient-Win64-Shipping.exe" → "Fortnite"
function gameLabel(name) {
  return String(name || '').replace(/\.exe$/i, '').replace(/-Win64-Shipping$/i, '').replace(/Client$/, '') || String(name || '');
}
// tasklist is a plain process listing (no driver involved); cached 10 s.
let gameCache = { at: 0, name: null, inflight: null };
function runningGame(extra) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (Date.now() - gameCache.at < 10000) return Promise.resolve(gameCache.name);
  if (gameCache.inflight) return gameCache.inflight;
  gameCache.inflight = new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      let found = null;
      if (!err) for (const line of String(stdout || '').split(/\r?\n/)) {
        const name = (/^"([^"]+)"/.exec(line) || [])[1];
        if (name && isGame(name, extra)) { found = name; break; }
      }
      gameCache = { at: Date.now(), name: found, inflight: null };
      resolve(found);
    });
  });
  return gameCache.inflight;
}

let lastDriver = { at: 0, gpus: [], apps: [], appsAt: 0, available: null };

async function refreshInstalled(o) {
  if (Date.now() - installedCache.at < 60000) return;
  const tags = await getJson(ollamaBase(o), '/api/tags');
  installedCache = { at: Date.now(), names: tags && Array.isArray(tags.models) ? tags.models.map((m) => m.name) : installedCache.names };
}

// opts.panel: the GPU panel is open (full picture, incl. per-program list).
// Otherwise: the top-bar chip (stats at most once per CHIP_DRIVER_MS).
async function collect(o, opts) {
  const panel = !!(opts && opts.panel);
  const game = await runningGame(o && o.gameNames);
  const now = Date.now();
  const driverDue = !game && (panel || now - lastDriver.at >= CHIP_DRIVER_MS);
  const [gq, aq, ops, ov, lm] = await Promise.all([
    driverDue ? smi(['--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,driver_version', '--format=csv,noheader,nounits']) : Promise.resolve(undefined),
    driverDue && panel ? smi(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader']) : Promise.resolve(undefined),
    getJson(ollamaBase(o), '/api/ps'),
    getJson(ollamaBase(o), '/api/version'),
    getJson(lmBase(o), '/api/v0/models', 1200),
  ]);
  await refreshInstalled(o);
  if (gq !== undefined) {
    const gpus = gq == null ? [] : parseSmi(gq);
    lastDriver = { ...lastDriver, at: now, gpus, available: gq != null && gpus.length > 0 };
    const g0 = gpus[0];
    if (g0) {
      history.push({ at: now, util: g0.util, vramUsedMB: g0.vramUsedMB });
      if (history.length > HISTORY) history.splice(0, history.length - HISTORY);
    }
  }
  if (aq !== undefined) lastDriver = { ...lastDriver, apps: aq == null ? [] : parseApps(aq), appsAt: now };
  const apps = lastDriver.apps;
  return {
    at: now,
    game: game ? { running: true, name: game, label: gameLabel(game) } : null,
    nvidia: {
      available: !!lastDriver.available, gpus: lastDriver.gpus, apps, perProcessVram: apps.some((a) => a.vramMB != null),
      readAt: lastDriver.at || null, paused: !!game,
    },
    ollama: { available: !!ov, url: ollamaBase(o), version: ov && ov.version, loaded: ops ? parseOllamaPs(ops) : [], installed: installedCache.names.length },
    lmstudio: { available: !!lm, url: lmBase(o), loaded: lm ? parseLmStudio(lm) : [] },
    history: history.slice(),
  };
}

function snapshot(o, opts) {
  const panel = !!(opts && opts.panel);
  // a cached chip-grade picture can't answer a panel request (it lacks the program list)
  if (cache.data && Date.now() - cache.at < CACHE_MS && (!panel || cache.panel)) return Promise.resolve(cache.data);
  if (cache.inflight && (!panel || cache.inflightPanel)) return cache.inflight;
  const p = collect(o, opts).then((d) => { cache = { at: Date.now(), data: d, inflight: null, panel }; return d; })
    .catch((e) => { cache.inflight = null; throw e; });
  cache.inflight = p; cache.inflightPanel = panel;
  return p;
}

// The last known picture without doing any work — for annotating tiles.
function installedNames() { return installedCache.names.slice(); }
function lastLoaded() { const d = cache.data; return d ? d.ollama.loaded.map((m) => m.name).concat(d.lmstudio.loaded.map((m) => m.name)) : []; }

// Unload = a zero-length request with keep_alive 0 — Ollama's documented way.
async function unloadOllama(name, o) {
  if (!name) return { error: 'model name required' };
  const r = await postJson(ollamaBase(o), '/api/generate', { model: name, keep_alive: 0 });
  if (r.error) return r;
  // Ollama answers before the model has actually left the card, so a refresh
  // right after still listed it — the panel said "unloaded" while showing it
  // loaded. Wait (briefly) until /api/ps agrees, then drop the cached picture.
  for (let i = 0; i < 20; i++) {
    const ps = await getJson(ollamaBase(o), '/api/ps', 1000);
    if (!ps || !parseOllamaPs(ps).some((m) => m.name === name)) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  cache = { at: 0, data: null, inflight: null };
  return { ok: true, model: name };
}
async function unloadAll(o) {
  const d = await snapshot(o);
  const names = d.ollama.loaded.map((m) => m.name);
  const results = [];
  for (const n of names) results.push({ model: n, ...(await unloadOllama(n, o)) });
  return results;
}

module.exports = {
  snapshot, unloadOllama, unloadAll, installedNames, lastLoaded, refreshInstalled, runningGame, isGame, gameLabel,
  parseSmi, parseApps, parseOllamaPs, parseLmStudio, isLocalModel, normModel,
  _reset: () => { cache = { at: 0, data: null, inflight: null }; history.length = 0; installedCache = { at: 0, names: [] }; lastDriver = { at: 0, gpus: [], apps: [], appsAt: 0, available: null }; gameCache = { at: 0, name: null, inflight: null }; },
};
