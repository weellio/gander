<script>
  import { drawAgent } from './avatars/pixel.js';
  import { draw as drawAbstract } from './avatars/abstract.js';
  import { avatarMode, images } from './stores.js';
  import { STATE_COLORS, STATE_LABEL } from './states.js';

  let { agent } = $props();
  let canvas = $state(null);

  function hash(id) { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function placeholder(a) {
    const c = (a.shirt || STATE_COLORS[a.state] || '#6B7280');
    const ch = ((a.name || '?').trim()[0] || '?').toUpperCase();
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='100'><rect width='120' height='100' rx='10' fill='${c}'/><text x='60' y='64' font-size='46' font-family='sans-serif' font-weight='600' fill='white' text-anchor='middle'>${ch}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  let isCanvas = $derived($avatarMode === 'pixel' || $avatarMode === 'abstract');
  let color = $derived(STATE_COLORS[agent.state] || '#6B7280');
  let imgSrc = $derived($images.length ? $images[hash(agent.id) % $images.length] : placeholder(agent));

  // Canvas animation loop — runs only in canvas modes, restarts when mode changes.
  $effect(() => {
    const mode = $avatarMode;
    if (mode !== 'pixel' && mode !== 'abstract') return;
    let raf, tick = 0;
    const run = () => {
      tick++;
      const ctx = canvas && canvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = false;
        try { (mode === 'abstract' ? drawAbstract : drawAgent)(ctx, agent, tick); } catch (_) {}
      }
      raf = requestAnimationFrame(run);
    };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  });
</script>

{#if isCanvas}
  <canvas bind:this={canvas} width="240" height="200" class="av-canvas"></canvas>
{:else}
  <div class="img-wrap" class:plain={$avatarMode === 'gif'} data-state={agent.state} style="--c:{color}">
    <img class="img" src={imgSrc} alt="" />
    <div class="fx">
      <div class="badge">{STATE_LABEL[agent.state] || agent.state}</div>
      <div class="m-think">?</div>
      <div class="m-code"><span></span><span></span><span></span></div>
      <div class="m-scan"></div>
      <div class="m-ring"></div>
      <div class="m-bang">!!</div>
      <div class="m-test">✓</div>
      <div class="m-done">✓</div>
      <div class="m-idle">z</div>
    </div>
  </div>
{/if}

<style>
  .av-canvas { display: block; width: 120px; height: 100px; image-rendering: pixelated; }

  .img-wrap { position: relative; width: 120px; height: 100px; border-radius: 10px; overflow: hidden;
    --c: #6B7280; box-shadow: 0 0 0 2px var(--c); animation: pulse 2s ease-in-out infinite; }
  .img-wrap[data-state="error"] { animation: pulse 0.5s ease-in-out infinite, shake 0.3s infinite; }
  .img-wrap[data-state="idle"], .img-wrap[data-state="done"] { animation: pulse 3.5s ease-in-out infinite; }
  .img-wrap.plain { animation: none; box-shadow: 0 0 0 2px var(--c); }
  .img-wrap.plain .fx { display: none; }
  @keyframes pulse { 0%,100%{ box-shadow:0 0 0 2px var(--c);} 50%{ box-shadow:0 0 9px 2px var(--c);} }
  @keyframes shake { 0%,100%{transform:translateX(0);} 25%{transform:translateX(-2px);} 75%{transform:translateX(2px);} }
  .img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .img-wrap[data-state="idle"] .img { filter: grayscale(0.4) brightness(0.9); }
  .fx { position: absolute; inset: 0; pointer-events: none; }
  .fx > * { position: absolute; display: none; }
  .badge { display: flex !important; top: 4px; left: 4px; align-items: center;
    font: 600 9px/1 sans-serif; color: #fff; background: var(--c); padding: 2px 6px; border-radius: 99px; opacity: 0.92; }

  .m-think { top: 4px; right: 5px; width: 18px; height: 16px; border-radius: 6px; background: #fff; color: var(--c);
    font: 700 12px/16px sans-serif; text-align: center; box-shadow: 0 0 0 1.5px var(--c); animation: bob 1.2s ease-in-out infinite; }
  .img-wrap[data-state="thinking"] .m-think { display: block; }
  @keyframes bob { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-3px);} }

  .m-code { bottom: 5px; left: 50%; transform: translateX(-50%); width: 30px; height: 16px; justify-content: space-between; }
  .img-wrap[data-state="coding"] .m-code, .img-wrap[data-state="running"] .m-code { display: flex; }
  .m-code span { width: 5px; background: var(--c); align-self: flex-end; border-radius: 1px; animation: eq 0.7s ease-in-out infinite; }
  .m-code span:nth-child(2){ animation-delay: 0.15s; } .m-code span:nth-child(3){ animation-delay: 0.3s; }
  @keyframes eq { 0%,100%{height:4px;} 50%{height:15px;} }

  .img-wrap[data-state="reading"] .m-scan, .img-wrap[data-state="searching"] .m-scan { display: block; }
  .m-scan { left: 0; right: 0; height: 14px; top: 0; background: linear-gradient(var(--c), transparent); opacity: 0.55; animation: scan 1.6s linear infinite; }
  @keyframes scan { 0%{top:-14px;} 100%{top:100px;} }

  .img-wrap[data-state="spawning"] .m-ring { display: block; }
  .m-ring { top: 50%; left: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid var(--c); animation: ring 1.1s ease-out infinite; }
  @keyframes ring { 0%{transform:scale(0.4);opacity:0.9;} 100%{transform:scale(2.6);opacity:0;} }

  .img-wrap[data-state="error"] .m-bang { display: block; }
  .m-bang { top: 3px; right: 5px; color: #fff; background: #EF4444; font: 800 11px/1 sans-serif; padding: 2px 5px; border-radius: 5px; }

  .img-wrap[data-state="testing"] .m-test { display: block; }
  .m-test { top: 3px; right: 5px; width: 16px; height: 16px; border-radius: 50%; background: #fff; color: var(--c); font: 700 12px/16px sans-serif; text-align: center; }

  .img-wrap[data-state="done"] .m-done { display: block; }
  .m-done { bottom: 4px; right: 5px; width: 16px; height: 16px; border-radius: 50%; background: #10B981; color: #fff; font: 700 12px/16px sans-serif; text-align: center; animation: bob 2s ease-in-out infinite; }

  .img-wrap[data-state="idle"] .m-idle { display: block; }
  .m-idle { top: 6px; right: 8px; color: #fff; font: 700 12px/1 sans-serif; text-shadow: 0 0 2px #000; animation: zfloat 2.4s ease-in-out infinite; }
  @keyframes zfloat { 0%{opacity:0;transform:translateY(4px);} 50%{opacity:1;} 100%{opacity:0;transform:translateY(-8px);} }
</style>
