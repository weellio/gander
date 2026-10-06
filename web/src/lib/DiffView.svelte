<script>
  // Before/after preview of an Edit / MultiEdit / Write / NotebookEdit tool call,
  // so a permission prompt shows what you are allowing instead of raw JSON.
  // Text interpolation only (never {@html}); the +/− gutter is always shown so
  // color is never the only signal.
  import { previewFor } from './diff.js';

  let { tool, input, maxHeight = 260 } = $props();

  let p = $derived(previewFor(tool, input));
  const shortPath = (f) => String(f || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-3).join('/');
  const SIGN = { '+': '+', '-': '−', ' ': ' ', '…': '⋯' };
  const CLS = { '+': 'add', '-': 'del', ' ': 'ctx', '…': 'gap' };
  const SR = { '+': 'added', '-': 'removed' };
</script>

{#if p.kind !== 'none'}
  <div class="dv">
    <div class="dv-h">
      <span class="dv-file" title={p.file}>{shortPath(p.file) || '(no file path)'}</span>
      <span class="dv-stat"><span class="dv-plus">+{p.added}</span> <span class="dv-minus">−{p.removed}</span></span>
    </div>
    <div class="dv-scroll" style="max-height:{maxHeight}px">
      <div class="dv-inner">
        {#each p.blocks as b, bi (bi)}
          <div class="dv-title">{b.title}</div>
          {#each b.hunks as h}
            {#each h.lines as ln}
              <div class="dv-ln {CLS[ln.op] || 'ctx'}"><span class="dv-g" title={SR[ln.op]}>{SIGN[ln.op] ?? ln.op}</span><span class="dv-t">{ln.text}</span></div>
            {/each}
          {/each}
          {#if !b.hunks.length}<div class="dv-ln gap"><span class="dv-g">⋯</span><span class="dv-t">(nothing to show)</span></div>{/if}
          {#if b.truncated}<div class="dv-ln gap"><span class="dv-g">⋯</span><span class="dv-t">{b.hidden ? b.hidden + ' more line' + (b.hidden === 1 ? '' : 's') + ' not shown' : 'preview truncated'}</span></div>{/if}
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .dv { margin: 4px 0; min-width: 0; max-width: 100%; border: 0.5px solid var(--color-border-tertiary); border-radius: 6px;
    background: var(--color-background-secondary); color: var(--color-text-primary); overflow: hidden; }
  .dv-h { display: flex; align-items: baseline; gap: 8px; padding: 4px 7px; font-size: 11px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .dv-file { font-family: var(--font-mono); color: var(--color-text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
  .dv-stat { font-family: var(--font-mono); flex-shrink: 0; }
  .dv-plus { color: var(--hm-ok); }
  .dv-minus { color: var(--hm-err); }
  .dv-scroll { overflow: auto; max-width: 100%; }
  .dv-inner { display: inline-block; min-width: 100%; vertical-align: top; font-family: var(--font-mono); font-size: 10.5px; line-height: 1.4; }
  .dv-title { padding: 3px 7px 2px; font-size: 10px; color: var(--color-text-tertiary); font-family: var(--font-sans, inherit); position: sticky; left: 0; width: max-content; }
  .dv-ln { display: flex; white-space: pre; word-break: normal; overflow-wrap: normal; }
  .dv-g { flex-shrink: 0; width: 1.6em; text-align: center; user-select: none; color: var(--color-text-tertiary); }
  .dv-t { padding-right: 8px; }
  .dv-ln.add { background: color-mix(in srgb, var(--hm-ok) 14%, transparent); }
  .dv-ln.add .dv-g { color: var(--hm-ok); font-weight: 700; }
  .dv-ln.del { background: color-mix(in srgb, var(--hm-err) 14%, transparent); }
  .dv-ln.del .dv-g { color: var(--hm-err); font-weight: 700; }
  .dv-ln.gap { color: var(--color-text-tertiary); opacity: 0.75; font-style: italic; }
</style>
