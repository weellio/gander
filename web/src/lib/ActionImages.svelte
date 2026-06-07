<script>
  import { imageMap } from './stores.js';
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import { readFile, downscale } from './img.js';

  let open = $state(false);
  const STATES = ['idle', 'thinking', 'coding', 'spawning', 'reading', 'testing', 'error', 'done'];

  async function setFor(state, e) {
    const f = (e.target.files || [])[0];
    if (f && /^image\//.test(f.type)) {
      const raw = await readFile(f);
      const ds = /gif/i.test(f.type) ? raw : (await downscale(raw, 160)) || raw;
      if (ds) imageMap.update((m) => ({ ...m, [`*::${state}`]: ds }));
    }
    e.target.value = '';
  }
  function clearFor(state) {
    imageMap.update((m) => { const n = { ...m }; delete n[`*::${state}`]; return n; });
  }
</script>

<div class="wrap">
  <button class="select" onclick={() => (open = !open)} title="Assign an image to each action (applies to all agents)">Action images…</button>
  {#if open}
    <div class="pop">
      <div class="hd">Image per action <span>(all agents)</span></div>
      {#each STATES as s (s)}
        <div class="row">
          <i style="background:{STATE_COLORS[s]}"></i>
          <span class="lbl">{STATE_LABEL[s]}</span>
          {#if $imageMap[`*::${s}`]}<img class="thumb" src={$imageMap[`*::${s}`]} alt="" />{/if}
          <label class="mini">Set<input type="file" accept="image/*" style="display:none" onchange={(e) => setFor(s, e)} /></label>
          {#if $imageMap[`*::${s}`]}<button class="mini" onclick={() => clearFor(s)}>✕</button>{/if}
        </div>
      {/each}
      <div class="ft">Per-agent: click an avatar in “Your image” mode (Shift-click = that agent + state).</div>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .pop {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 50; width: 270px;
    background: var(--color-background-primary); border: 0.5px solid var(--color-border-secondary);
    border-radius: var(--border-radius-md); padding: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  }
  .hd { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
  .hd span { font-weight: 400; color: var(--color-text-tertiary); }
  .row { display: flex; align-items: center; gap: 8px; padding: 4px 2px; font-size: 11px; }
  .row i { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .lbl { flex: 1 1 auto; color: var(--color-text-secondary); }
  .thumb { width: 22px; height: 22px; object-fit: cover; border-radius: 4px; }
  .mini {
    font-size: 10px; padding: 2px 7px; border-radius: var(--border-radius-md); cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-primary);
  }
  .ft { font-size: 10px; color: var(--color-text-tertiary); margin-top: 6px; line-height: 1.4; }
</style>
