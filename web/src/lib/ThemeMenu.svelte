<script>
  import { theme, PRESETS, BACKGROUNDS } from './theme.js';
  import { readFile, downscale } from './img.js';

  let open = $state(false);
  let fileInput = $state();

  function setPreset(e) { theme.update((t) => ({ ...t, preset: e.target.value })); }
  function setAccent(e) { theme.update((t) => ({ ...t, accent: e.target.value })); }
  function setBg(e) { theme.update((t) => ({ ...t, bg: e.target.value, bgImage: '' })); }
  async function onBgImage(e) {
    const f = (e.target.files || [])[0];
    if (f && /^image\//.test(f.type)) {
      const raw = await readFile(f);
      const ds = (await downscale(raw, 1600)) || raw;
      if (ds) theme.update((t) => ({ ...t, bgImage: ds, bg: 'none' }));
    }
    e.target.value = '';
  }
  function clearBgImage() { theme.update((t) => ({ ...t, bgImage: '' })); }
</script>

<div class="wrap">
  <button class="select" onclick={() => (open = !open)} title="Theme & appearance">Theme…</button>
  {#if open}
    <div class="pop">
      <label class="row"><span>Theme</span>
        <select value={$theme.preset} onchange={setPreset}>
          {#each Object.entries(PRESETS) as [k, p] (k)}<option value={k}>{p.label}</option>{/each}
        </select>
      </label>
      <label class="row"><span>Accent</span>
        <input type="color" value={$theme.accent} oninput={setAccent} />
      </label>
      <label class="row"><span>Background</span>
        <select value={$theme.bgImage ? '__img' : $theme.bg} onchange={setBg} disabled={!!$theme.bgImage}>
          {#each Object.entries(BACKGROUNDS) as [k, b] (k)}<option value={k}>{b.label}</option>{/each}
          {#if $theme.bgImage}<option value="__img">Custom image</option>{/if}
        </select>
      </label>
      <div class="row">
        <span>Image</span>
        <span class="imgctl">
          <button class="mini" onclick={() => fileInput.click()}>Upload…</button>
          {#if $theme.bgImage}<button class="mini" onclick={clearBgImage}>✕</button>{/if}
          <input bind:this={fileInput} type="file" accept="image/*" style="display:none" onchange={onBgImage} />
        </span>
      </div>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .pop {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 50; width: 240px;
    background: var(--color-background-primary); border: 0.5px solid var(--color-border-secondary);
    border-radius: var(--border-radius-md); padding: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    display: flex; flex-direction: column; gap: 8px;
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--color-text-secondary); }
  .row select, .row input[type="color"] { font-size: 12px; }
  .row input[type="color"] { width: 36px; height: 22px; padding: 0; border: 0.5px solid var(--color-border-secondary); border-radius: 4px; background: none; }
  .imgctl { display: flex; gap: 4px; align-items: center; }
  .mini { font-size: 10px; padding: 2px 7px; border-radius: var(--border-radius-md); cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-primary); }
</style>
