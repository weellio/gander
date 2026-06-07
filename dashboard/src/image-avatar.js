// Hivemind — "Your image" avatar tier.
//
// Lets users import their own avatar images (PNG / JPG / GIF) and renders them
// with the same kind of animated state cues as the pixel art — but as CSS
// overlays composited on top of the supplied image. Images are auto-downscaled
// and stored in localStorage (a shared pool, assigned to agents by id hash).
//
// Registers window.AOC_AVATARS.image = { dom:true, sync, teardown } and adds an
// "Images…" import button to the top bar.
(function () {
  'use strict';

  const STATE_COLORS = {
    idle: '#6B7280', thinking: '#6366F1', coding: '#10B981', spawning: '#F59E0B',
    reading: '#3B82F6', error: '#EF4444', testing: '#8B5CF6', done: '#10B981',
    running: '#10B981', searching: '#3B82F6',
  };
  const STATE_LABEL = {
    idle: 'Idle', thinking: 'Thinking', coding: 'Coding', spawning: 'Spawning',
    reading: 'Reading', error: 'Error', testing: 'Testing', done: 'Done',
    running: 'Running', searching: 'Searching',
  };
  const LS_KEY = 'aoc-images';

  let pool = [];
  try { pool = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (_) { pool = []; }
  function savePool() { try { localStorage.setItem(LS_KEY, JSON.stringify(pool)); } catch (e) { console.warn('[hivemind] image store full', e); } }

  function hash(id) { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

  function placeholder(agent) {
    const c = agent.shirt || '#6B7280';
    const ch = ((agent.name || '?').trim()[0] || '?').toUpperCase();
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='100'><rect width='120' height='100' rx='10' fill='${c}'/><text x='60' y='64' font-size='46' font-family='sans-serif' font-weight='600' fill='white' text-anchor='middle'>${ch}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  function imageFor(agent) { return pool.length ? pool[hash(agent.id) % pool.length] : placeholder(agent); }

  // ── Styles ──────────────────────────────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById('aoc-image-style')) return;
    const s = document.createElement('style');
    s.id = 'aoc-image-style';
    s.textContent = `
      .aoc-img-wrap { position:relative; width:120px; height:100px; border-radius:10px; overflow:hidden;
        --c:#6B7280; box-shadow:0 0 0 2px var(--c); animation:aocImgPulse 2s ease-in-out infinite; }
      .aoc-img-wrap[data-state="error"] { animation:aocImgPulse 0.5s ease-in-out infinite, aocShake 0.3s infinite; }
      .aoc-img-wrap[data-state="idle"], .aoc-img-wrap[data-state="done"] { animation:aocImgPulse 3.5s ease-in-out infinite; }
      @keyframes aocImgPulse { 0%,100%{ box-shadow:0 0 0 2px var(--c); } 50%{ box-shadow:0 0 9px 2px var(--c); } }
      @keyframes aocShake { 0%,100%{ transform:translateX(0);} 25%{transform:translateX(-2px);} 75%{transform:translateX(2px);} }
      .aoc-img { width:100%; height:100%; object-fit:cover; display:block; }
      .aoc-img-wrap[data-state="idle"] .aoc-img { filter:grayscale(0.4) brightness(0.9); }
      .aoc-fx { position:absolute; inset:0; pointer-events:none; }
      .aoc-fx > * { position:absolute; display:none; }
      .aoc-badge { display:flex !important; top:4px; left:4px; align-items:center; gap:3px;
        font:600 9px/1 var(--font-sans,sans-serif); color:#fff; background:var(--c);
        padding:2px 6px; border-radius:99px; opacity:0.92; }

      /* thinking: ? bubble bobbing */
      .m-think { display:none; top:4px; right:5px; width:18px; height:16px; border-radius:6px;
        background:#fff; color:var(--c); font:700 12px/16px sans-serif; text-align:center;
        box-shadow:0 0 0 1.5px var(--c); animation:aocBob 1.2s ease-in-out infinite; }
      .aoc-img-wrap[data-state="thinking"] .m-think { display:block; }
      @keyframes aocBob { 0%,100%{ transform:translateY(0);} 50%{ transform:translateY(-3px);} }

      /* coding: equalizer bars at bottom */
      .m-code { bottom:5px; left:50%; transform:translateX(-50%); width:30px; height:16px;
        justify-content:space-between; gap:3px; }
      .aoc-img-wrap[data-state="coding"] .m-code,
      .aoc-img-wrap[data-state="running"] .m-code { display:flex; }
      .m-code span { width:5px; background:var(--c); align-self:flex-end; border-radius:1px;
        animation:aocEq 0.7s ease-in-out infinite; }
      .m-code span:nth-child(2){ animation-delay:0.15s; } .m-code span:nth-child(3){ animation-delay:0.3s; }
      @keyframes aocEq { 0%,100%{ height:4px;} 50%{ height:15px;} }

      /* reading/searching: scan line */
      .aoc-img-wrap[data-state="reading"] .m-scan,
      .aoc-img-wrap[data-state="searching"] .m-scan { display:block; }
      .m-scan { left:0; right:0; height:14px; top:0;
        background:linear-gradient(var(--c),transparent); opacity:0.55; animation:aocScan 1.6s linear infinite; }
      @keyframes aocScan { 0%{ top:-14px;} 100%{ top:100px;} }

      /* spawning: expanding rings */
      .aoc-img-wrap[data-state="spawning"] .m-ring { display:block; }
      .m-ring { top:50%; left:50%; width:14px; height:14px; margin:-7px 0 0 -7px; border-radius:50%;
        border:2px solid var(--c); animation:aocRing 1.1s ease-out infinite; }
      @keyframes aocRing { 0%{ transform:scale(0.4); opacity:0.9;} 100%{ transform:scale(2.6); opacity:0;} }

      /* error: !! */
      .aoc-img-wrap[data-state="error"] .m-bang { display:block; }
      .m-bang { top:3px; right:5px; color:#fff; background:#EF4444; font:800 11px/1 sans-serif;
        padding:2px 5px; border-radius:5px; }

      /* testing: check/cross toggle */
      .aoc-img-wrap[data-state="testing"] .m-test { display:block; }
      .m-test { top:3px; right:5px; width:16px; height:16px; border-radius:50%; background:#fff;
        color:var(--c); font:700 12px/16px sans-serif; text-align:center; animation:aocFlip 0.9s steps(1) infinite; }
      @keyframes aocFlip { 0%{ } 50%{ } }

      /* done: steady check */
      .aoc-img-wrap[data-state="done"] .m-done { display:block; }
      .m-done { bottom:4px; right:5px; width:16px; height:16px; border-radius:50%; background:#10B981;
        color:#fff; font:700 12px/16px sans-serif; text-align:center; animation:aocBob 2s ease-in-out infinite; }

      /* idle: drifting z */
      .aoc-img-wrap[data-state="idle"] .m-idle { display:block; }
      .m-idle { top:6px; right:8px; color:#fff; font:700 12px/1 sans-serif; text-shadow:0 0 2px #000;
        animation:aocZ 2.4s ease-in-out infinite; }
      @keyframes aocZ { 0%{ opacity:0; transform:translateY(4px);} 50%{ opacity:1;} 100%{ opacity:0; transform:translateY(-8px);} }

      .aoc-img-import { font-size:12px; }
    `;
    document.head.appendChild(s);
  }

  // ── Import button ─────────────────────────────────────────────────────────
  function downscale(dataUrl, max) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        try { resolve(c.toDataURL('image/png')); } catch (_) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }
  function readFile(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  }
  async function importFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type));
    for (const f of files) {
      const raw = await readFile(f);
      if (!raw) continue;
      // GIFs lose animation if redrawn to canvas, so keep them as-is; downscale stills.
      const stored = /gif/i.test(f.type) ? raw : (await downscale(raw, 160)) || raw;
      pool.push(stored);
    }
    savePool();
  }

  function injectImportButton() {
    const bar = document.querySelector('.top-bar');
    if (!bar || document.querySelector('.aoc-img-import')) return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.style.display = 'none';
    input.addEventListener('change', async () => {
      await importFiles(input.files);
      input.value = '';
      // switch to image mode so the user immediately sees the result
      window.AOC_AVATAR_MODE = 'image';
    });
    const btn = document.createElement('button');
    btn.className = 'spawn-btn aoc-img-import';
    btn.textContent = 'Images…';
    btn.title = 'Import avatar images (PNG/JPG/GIF) for the "Your image" style';
    btn.addEventListener('click', (e) => {
      if (e.shiftKey) { if (confirm('Clear all imported images?')) { pool = []; savePool(); } return; }
      input.click();
    });
    bar.appendChild(input);
    bar.appendChild(btn);
  }

  // ── Renderer ───────────────────────────────────────────────────────────────
  function build(wrap) {
    const w = document.createElement('div');
    w.className = 'aoc-img-wrap';
    w.innerHTML =
      '<img class="aoc-img" alt="">' +
      '<div class="aoc-fx">' +
      '<div class="aoc-badge"></div>' +
      '<div class="m-think">?</div>' +
      '<div class="m-code"><span></span><span></span><span></span></div>' +
      '<div class="m-scan"></div><div class="m-ring"></div>' +
      '<div class="m-bang">!!</div><div class="m-test">✓</div>' +
      '<div class="m-done">✓</div><div class="m-idle">z</div>' +
      '</div>';
    wrap.appendChild(w);
    return w;
  }

  window.AOC_AVATARS = window.AOC_AVATARS || {};
  window.AOC_AVATARS.image = {
    dom: true,
    sync(card, agent) {
      const wrap = card.querySelector('.canvas-wrap');
      if (!wrap) return;
      const canvas = wrap.querySelector('canvas');
      if (canvas && canvas.style.display !== 'none') canvas.style.display = 'none';
      let w = wrap.querySelector('.aoc-img-wrap');
      if (!w) w = build(wrap);

      const state = agent.state || 'idle';
      const color = STATE_COLORS[state] || STATE_COLORS.idle;
      if (w.dataset.state !== state) { w.dataset.state = state; w.style.setProperty('--c', color); }
      const badge = w.querySelector('.aoc-badge');
      if (badge && badge.textContent !== (STATE_LABEL[state] || state)) badge.textContent = STATE_LABEL[state] || state;

      const src = imageFor(agent);
      const img = w.querySelector('.aoc-img');
      if (img && img.getAttribute('src') !== src) img.setAttribute('src', src);
    },
    teardown(card) {
      const wrap = card.querySelector('.canvas-wrap');
      if (!wrap) return;
      const w = wrap.querySelector('.aoc-img-wrap');
      if (w) w.remove();
      const canvas = wrap.querySelector('canvas');
      if (canvas) canvas.style.display = '';
    },
  };

  function start() { injectStyle(); injectImportButton(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
