<script>
  // Lightweight zero-dep interactive spotlight tour.
  // step: { sel?, title, body, click?, free? }
  //   sel   — CSS selector to spotlight
  //   click — completing the step requires CLICKING the highlighted element
  //           (the page stays interactive; clicking it advances the tour)
  //   free  — no scrim at all; card sits at the bottom so the user can look at /
  //           use whatever the previous click opened. Advance with Next.
  let { open = $bindable(false), steps = [] } = $props();
  let i = $state(0);
  let rect = $state(null);
  let place = $state('bottom');

  const PAD = 8;
  function measure() {
    const s = steps[i];
    if (!s || !s.sel) { rect = null; return; }
    const el = document.querySelector(s.sel);
    if (!el) { rect = null; return; }
    const r = el.getBoundingClientRect();
    rect = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
    place = (window.innerHeight - r.bottom) > 190 ? 'bottom' : 'top';
  }
  $effect(() => { open; i; if (open) requestAnimationFrame(measure); });

  // On a "click" step, advance when the user clicks the highlighted element.
  $effect(() => {
    if (!open) return;
    const s = steps[i];
    if (!s || !s.click || !s.sel) return;
    let el, h;
    const raf = requestAnimationFrame(() => {
      el = document.querySelector(s.sel);
      if (!el) return;
      h = () => setTimeout(() => next(), 90);   // let the button's own handler open its panel first
      el.addEventListener('click', h, { once: true });
    });
    return () => { cancelAnimationFrame(raf); if (el && h) el.removeEventListener('click', h); };
  });

  function next() { if (i < steps.length - 1) i++; else finish(); }
  function back() { if (i > 0) i--; }
  function finish() { try { localStorage.setItem('aoc-toured', '1'); } catch (_) {} open = false; i = 0; }
  function onKey(e) {
    if (!open) return;
    if (e.key === 'Escape') finish();
    else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !steps[i]?.click)) { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') back();
  }

  let tip = $derived.by(() => {
    const s = steps[i] || {};
    const w = 300;
    const W = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const H = typeof window !== 'undefined' ? window.innerHeight : 800;
    if (s.free) return { mode: 'bottom', w };
    if (!rect) return { mode: 'center', w };
    const left = Math.max(12, Math.min(W - w - 12, rect.left + rect.width / 2 - w / 2));
    if (place === 'bottom') return { mode: 'spot', left, top: rect.top + rect.height + 12, w };
    return { mode: 'spot', left, bottom: H - rect.top + 12, w, above: true };
  });
</script>

<svelte:window onkeydown={onKey} onresize={measure} />

{#if open && steps.length}
  {@const s = steps[i]}
  <div class="tour">
    {#if !s.click && !s.free}
      <div class="block"></div>
      {#if rect}<div class="spot" style="top:{rect.top}px;left:{rect.left}px;width:{rect.width}px;height:{rect.height}px"></div>{:else}<div class="dim"></div>{/if}
    {:else if s.click && rect}
      <div class="spot click" style="top:{rect.top}px;left:{rect.left}px;width:{rect.width}px;height:{rect.height}px"></div>
    {/if}

    <div class="card" class:centered={tip.mode === 'center'} class:bottom={tip.mode === 'bottom'}
      style={tip.mode === 'spot' ? `left:${tip.left}px;${tip.above ? `bottom:${tip.bottom}px` : `top:${tip.top}px`};width:${tip.w}px` : `width:${tip.w}px`}>
      <div class="hd"><span class="step">{i + 1} / {steps.length}</span><button class="skip" onclick={finish}>Skip ✕</button></div>
      <h3>{s.title}</h3>
      <p>{s.body}</p>
      <div class="row">
        <div class="dots">{#each steps as _, k (k)}<span class="dot" class:on={k === i}></span>{/each}</div>
        <div class="nav">
          {#if i > 0}<button onclick={back}>Back</button>{/if}
          {#if s.click}<span class="chint">👆 click it</span>
          {:else}<button class="primary" onclick={next}>{i < steps.length - 1 ? 'Next →' : 'Done'}</button>{/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .tour { position: fixed; inset: 0; z-index: 200; pointer-events: none; }
  .tour > * { pointer-events: auto; }
  .block { position: fixed; inset: 0; }
  .dim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); }
  .spot { position: fixed; border-radius: 8px; pointer-events: none;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6), 0 0 0 2px var(--accent, #6366F1);
    animation: spot 1.6s ease-in-out infinite; }
  .spot.click { animation: spotc 1s ease-in-out infinite; }
  @keyframes spot { 0%, 100% { box-shadow: 0 0 0 9999px rgba(0,0,0,0.6), 0 0 0 2px var(--accent, #6366F1); }
                    50% { box-shadow: 0 0 0 9999px rgba(0,0,0,0.6), 0 0 0 4px var(--accent, #6366F1); } }
  @keyframes spotc { 0%, 100% { box-shadow: 0 0 0 9999px rgba(0,0,0,0.55), 0 0 0 3px var(--accent, #6366F1); }
                     50% { box-shadow: 0 0 0 9999px rgba(0,0,0,0.55), 0 0 0 6px color-mix(in srgb, var(--accent, #6366F1) 60%, transparent); } }
  .card { position: fixed; background: var(--color-background-primary); color: var(--color-text-primary);
    border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-lg);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.4); padding: 12px 14px; display: flex; flex-direction: column; gap: 7px; }
  .card.centered { top: 50%; left: 50%; transform: translate(-50%, -50%); }
  .card.bottom { left: 50%; bottom: 22px; transform: translateX(-50%); }
  .hd { display: flex; align-items: center; justify-content: space-between; }
  .step { font-size: 10px; font-family: var(--font-mono); color: var(--color-text-tertiary); }
  .skip { background: none; border: none; cursor: pointer; font-size: 11px; color: var(--color-text-tertiary); }
  h3 { margin: 0; font-size: 14px; }
  p { margin: 0; font-size: 12px; line-height: 1.5; color: var(--color-text-secondary); }
  .row { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
  .dots { display: flex; gap: 4px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-border-secondary); }
  .dot.on { background: var(--accent, #6366F1); }
  .nav { display: flex; gap: 6px; align-items: center; }
  .chint { font-size: 11px; font-weight: 600; color: var(--accent, #6366F1); animation: pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
  .nav button { font-size: 11px; padding: 5px 12px; border-radius: var(--border-radius-md); cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-primary); }
  .nav button.primary { background: var(--accent, #6366F1); color: #fff; border: none; font-weight: 600; }
</style>
