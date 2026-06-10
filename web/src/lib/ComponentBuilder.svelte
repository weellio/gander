<script>
  import { TEMPLATES } from './componentTemplates.js';
  let { open = $bindable(false), defaultCwd = '', onCreated = () => {} } = $props();

  let type = $state('agent');          // agent | skill | command
  let name = $state('');
  let description = $state('');
  let model = $state('inherit');
  let color = $state('blue');
  let tools = $state('');
  let argumentHint = $state('');
  let body = $state('');
  let overwrite = $state(false);
  let projects = $state([]);
  let targets = $state({});            // path -> true ; 'global' -> true
  let busy = $state(false);
  let results = $state(null);          // array from server

  const COLORS = ['blue', 'green', 'red', 'purple', 'pink', 'orange', 'cyan', 'yellow'];
  const READONLY = 'Read, Grep, Glob, WebFetch, WebSearch';
  let template = $state('blank');

  let slug = $derived(String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64));
  let descLen = $derived(description.replace(/\s+/g, ' ').trim().length);
  let chosenTargets = $derived(Object.keys(targets).filter((k) => targets[k]));

  async function openPanel() {
    results = null; busy = false;
    try { const r = await fetch('/api/projects'); const d = await r.json(); projects = (d.projects || []).filter((p) => p.sources?.[0] !== 'global'); } catch (_) { projects = []; }
    const t = {};
    if (defaultCwd) t[defaultCwd] = true; else t['global'] = true;
    targets = t;
  }
  $effect(() => { if (open) openPanel(); });

  function applyTemplate(id) {
    template = id;
    const tpl = (TEMPLATES[type] || []).find((x) => x.id === id);
    if (!tpl || !tpl.f) return;
    const f = tpl.f;
    if (f.name !== undefined) name = f.name;
    if (f.description !== undefined) description = f.description;
    if (f.tools !== undefined) tools = f.tools;
    if (f.model !== undefined) model = f.model;
    if (f.color !== undefined) color = f.color;
    if (f.body !== undefined) body = f.body;
  }
  function onTypeChange() { template = 'blank'; }
  function makeReadonly() { tools = READONLY; }

  // ── generate from a description by handing it to your LIVE Claude session ──
  let genPrompt = $state('');
  let genMsg = $state('');
  let genBusy = $state(false);
  async function generate() {
    if (!genPrompt.trim() || genBusy) return;
    genBusy = true; genMsg = '';
    try {
      const r = await fetch('/api/component-generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, prompt: genPrompt, targets: chosenTargets.length ? chosenTargets : ['global'] }),
      });
      const j = await r.json();
      genMsg = j.ok ? `✓ Sent to your “${j.session}” session — it’ll build it (watch the dashboard).` : `✗ ${j.error || 'failed'}`;
    } catch (e) { genMsg = '✗ ' + e; }
    genBusy = false;
  }

  function close() { open = false; }

  async function create() {
    if (!slug || (type !== 'command' && !description.trim()) || !chosenTargets.length) return;
    busy = true; results = null;
    try {
      const r = await fetch('/api/component-new', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, name, description, model, color, tools, argumentHint, body, overwrite, targets: chosenTargets }),
      });
      const j = await r.json();
      results = j.results || [{ error: 'no response' }];
      if (results.some((x) => x.ok)) onCreated();
    } catch (e) { results = [{ error: String(e) }]; }
    busy = false;
  }
</script>

{#if open}
  <div class="ov" onclick={close} role="presentation"></div>
  <div class="modal" role="dialog" aria-label="New component">
    <div class="hd">
      <strong>New component</strong>
      <button class="x" onclick={close} aria-label="Close">✕</button>
    </div>

    <div class="body">
      <div class="seg">
        {#each ['agent', 'skill', 'command'] as t}
          <button class="segb" class:on={type === t} onclick={() => { type = t; onTypeChange(); }}>{t}</button>
        {/each}
      </div>

      <div class="gen">
        <label class="lbl">✨ Describe it — your Claude builds it <span class="sub">(no typing front matter)</span></label>
        <div class="genrow">
          <input class="in" bind:value={genPrompt} placeholder={'e.g. a ' + type + ' that reviews my SQL migrations for unsafe changes'} onkeydown={(e) => e.key === 'Enter' && generate()} />
          <button class="genbtn" disabled={genBusy || !genPrompt.trim()} onclick={generate}>{genBusy ? '…' : 'Send'}</button>
        </div>
        {#if genMsg}<div class="genmsg" class:err={genMsg[0] === '✗'}>{genMsg}</div>{:else}<div class="hint">Hands the request to a running session via the component-builder skill. Or fill the fields below by hand.</div>{/if}
      </div>

      <label class="lbl">Template</label>
      <div class="tpls">
        {#each (TEMPLATES[type] || []) as tpl (tpl.id)}
          <button class="tpl" class:on={template === tpl.id} onclick={() => applyTemplate(tpl.id)}>{tpl.label}</button>
        {/each}
      </div>

      <label class="lbl">Name</label>
      <input class="in" bind:value={name} placeholder={type === 'command' ? 'e.g. ship-it' : 'e.g. Security Auditor'} />
      {#if slug}<div class="hint">file: <code>.claude/{type === 'skill' ? 'skills/' + slug + '/SKILL.md' : (type === 'agent' ? 'agents/' : 'commands/') + slug + (type === 'agent' || type === 'command' ? '.md' : '')}</code></div>{/if}

      {#if type !== 'command'}
        <label class="lbl">Description <span class="sub">— the trigger. Be specific about WHEN to use it.</span></label>
      {:else}
        <label class="lbl">Description <span class="sub">— optional, shown in the slash menu.</span></label>
      {/if}
      <textarea class="in ta" bind:value={description} placeholder={type === 'agent' ? 'Use proactively when… / Use when the user asks to…' : 'What this does and when to use it.'}></textarea>
      {#if type !== 'command'}
        <div class="hint" class:warn={descLen > 0 && descLen < 15} class:warn2={descLen > 400}>
          {descLen} chars{#if descLen > 0 && descLen < 15} · too short — it may not trigger{:else if descLen > 400} · long — front matter is read every turn{/if}
        </div>
      {/if}

      {#if type === 'agent'}
        <div class="row2">
          <div>
            <label class="lbl">Model</label>
            <select class="in" bind:value={model}>
              <option value="inherit">inherit (parent)</option>
              <option value="haiku">haiku (cheapest)</option>
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
            </select>
          </div>
          <div>
            <label class="lbl">Color</label>
            <select class="in" bind:value={color}>{#each COLORS as c}<option value={c}>{c}</option>{/each}</select>
          </div>
        </div>
        <label class="lbl">Tools <span class="sub">— blank = inherit all</span> <button class="ro" onclick={makeReadonly}>make read-only</button></label>
        <input class="in" bind:value={tools} placeholder="blank = all · or e.g. Read, Grep, Glob" />
      {/if}

      {#if type === 'command'}
        <label class="lbl">Argument hint <span class="sub">— optional</span></label>
        <input class="in" bind:value={argumentHint} placeholder="e.g. [pr-number]" />
      {/if}

      <label class="lbl">Body <span class="sub">— instructions (a template fills a starter)</span></label>
      <textarea class="in ta tall" bind:value={body} placeholder="Leave blank to use a sensible starter."></textarea>

      <label class="lbl">Deploy to</label>
      <div class="targets">
        <label class="tg"><input type="checkbox" checked={!!targets['global']} onchange={(e) => (targets = { ...targets, global: e.target.checked })} /> Global (~/.claude — all projects)</label>
        {#each projects as p (p.path)}
          <label class="tg"><input type="checkbox" checked={!!targets[p.path]} onchange={(e) => (targets = { ...targets, [p.path]: e.target.checked })} /> {p.name}</label>
        {/each}
      </div>

      <label class="tg ow"><input type="checkbox" bind:checked={overwrite} /> Overwrite if it already exists</label>

      {#if results}
        <div class="results">
          {#each results as r (r.target)}
            <div class="res" class:ok={r.ok} class:bad={r.error} class:exists={r.exists}>
              <b>{r.target === 'global' ? 'Global' : (r.target || '').split(/[\\/]/).pop()}</b>
              {#if r.ok}✓ created{#if r.warnings?.length}<ul class="warn-list">{#each r.warnings as w}<li>⚠ {w}</li>{/each}</ul>{/if}
              {:else if r.exists}already exists — tick "overwrite" to replace
              {:else}✗ {r.error}{/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="ft">
      <span class="ftnote">{chosenTargets.length} target{chosenTargets.length === 1 ? '' : 's'}</span>
      <button class="create" disabled={busy || !slug || (type !== 'command' && !description.trim()) || !chosenTargets.length} onclick={create}>
        {busy ? 'Creating…' : 'Create'}
      </button>
    </div>
  </div>
{/if}

<style>
  .ov { position: fixed; inset: 0; z-index: 120; background: rgba(0, 0, 0, 0.4); }
  .modal { position: fixed; z-index: 121; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: 460px; max-width: calc(100vw - 28px); max-height: calc(100vh - 60px); display: flex; flex-direction: column;
    background: var(--color-background-primary); color: var(--color-text-primary);
    border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-lg); box-shadow: 0 24px 70px rgba(0, 0, 0, 0.4); }
  .hd { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .x { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .body { padding: 12px 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
  .seg { display: flex; gap: 4px; background: var(--color-background-secondary); padding: 3px; border-radius: 8px; }
  .segb { flex: 1; text-transform: capitalize; font-size: 12px; padding: 5px; border: none; border-radius: 6px; cursor: pointer; background: none; color: var(--color-text-secondary); }
  .segb.on { background: var(--color-background-primary); color: var(--color-text-primary); box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
  .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); margin-top: 6px; }
  .sub { text-transform: none; letter-spacing: 0; color: var(--color-text-tertiary); font-weight: 400; }
  .tpls { display: flex; flex-wrap: wrap; gap: 5px; }
  .tpl { font-size: 10px; padding: 3px 8px; border-radius: 99px; cursor: pointer; border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .tpl.on { border-color: var(--accent, #6366F1); color: var(--color-text-primary); }
  .in { font-size: 12px; padding: 6px 8px; border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); box-sizing: border-box; width: 100%; }
  .ta { min-height: 48px; resize: vertical; font-family: inherit; }
  .tall { min-height: 90px; font-family: var(--font-mono); font-size: 11px; }
  .row2 { display: flex; gap: 8px; }
  .row2 > div { flex: 1; }
  .hint { font-size: 10px; color: var(--color-text-tertiary); }
  .gen { background: color-mix(in srgb, var(--accent, #6366F1) 8%, transparent); border: 0.5px solid color-mix(in srgb, var(--accent, #6366F1) 30%, transparent); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 5px; }
  .genrow { display: flex; gap: 6px; }
  .genbtn { font-size: 11px; font-weight: 600; padding: 5px 12px; border-radius: var(--border-radius-md); cursor: pointer; border: none; background: var(--accent, #6366F1); color: #fff; white-space: nowrap; }
  .genbtn:disabled { opacity: 0.5; cursor: default; }
  .genmsg { font-size: 10px; font-weight: 500; color: #10B981; }
  .genmsg.err { color: #EF4444; }
  .hint code { font-family: var(--font-mono); }
  .hint.warn { color: #d08700; }
  .hint.warn2 { color: #d08700; }
  .ro { font-size: 9px; padding: 1px 6px; border-radius: 99px; cursor: pointer; border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-secondary); margin-left: 6px; }
  .targets { display: flex; flex-direction: column; gap: 3px; max-height: 130px; overflow-y: auto; border: 0.5px solid var(--color-border-tertiary); border-radius: 8px; padding: 6px 8px; }
  .tg { font-size: 11px; color: var(--color-text-secondary); display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .ow { margin-top: 6px; }
  .results { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .res { font-size: 11px; padding: 5px 8px; border-radius: 6px; background: var(--color-background-secondary); border-left: 3px solid var(--color-border-tertiary); }
  .res.ok { border-left-color: #10B981; }
  .res.bad { border-left-color: #EF4444; }
  .res.exists { border-left-color: #F59E0B; }
  .warn-list { margin: 4px 0 0; padding-left: 16px; color: #b7791f; }
  .ft { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-top: 0.5px solid var(--color-border-tertiary); }
  .ftnote { font-size: 10px; color: var(--color-text-tertiary); }
  .create { font-size: 12px; font-weight: 600; padding: 6px 16px; border-radius: var(--border-radius-md); cursor: pointer; border: none; background: var(--accent, #6366F1); color: #fff; }
  .create:disabled { opacity: 0.5; cursor: default; }
</style>
