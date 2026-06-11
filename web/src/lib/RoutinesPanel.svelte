<script>
  import { ttsAvailable, speak, stopSpeaking } from './tts.js';
  import { ttsVoice, ttsRate } from './stores.js';
  import MicButton from './MicButton.svelte';
  let { open = $bindable(false) } = $props();
  let speakingId = $state(null);
  function listen(b) {
    if (speakingId === b.id) { stopSpeaking(); speakingId = null; return; }
    const ok = speak(b.output, { voiceName: $ttsVoice, rate: $ttsRate, onend: () => { if (speakingId === b.id) speakingId = null; } });
    speakingId = ok ? b.id : null;
  }
  let _was = false;
  $effect(() => { if (open && !_was) openPanel(); _was = open; });

  let routines = $state([]);
  let briefings = $state([]);
  let projects = $state([]);
  let status = $state('');
  let expanded = $state({});        // briefing id -> open
  let editing = $state(null);       // routine being added/edited (form object) or null
  let timer = null;

  async function load() {
    try { const r = await fetch('/api/routines'); const j = await r.json(); routines = j.routines || []; briefings = j.briefings || []; } catch (_) {}
  }
  async function loadProjects() {
    try { const r = await fetch('/api/projects'); const j = await r.json(); projects = (j.projects || []); } catch (_) {}
  }
  function openPanel() { open = true; status = ''; editing = null; load(); loadProjects(); clearInterval(timer); timer = setInterval(load, 4000); }
  function closePanel() { open = false; clearInterval(timer); }
  function onKey(e) { if (e.key === 'Escape') { if (editing) editing = null; else closePanel(); } }

  function blank() { return { id: '', name: '', cwd: '', prompt: '', permMode: 'bypassPermissions', schedule: '', enabled: false, notify: false }; }
  function newRoutine() { editing = blank(); }
  function edit(r) { editing = { ...r }; }
  async function save() {
    if (!editing.name.trim() || !editing.prompt.trim()) { status = '✗ name + prompt required'; return; }
    status = 'Saving…';
    const r = await (await fetch('/api/routines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editing) })).json();
    if (r && r.ok) { editing = null; status = '✓ saved'; load(); } else status = '✗ ' + ((r && r.error) || 'failed');
  }
  async function del(id) {
    await fetch('/api/routines/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    editing = null; load();
  }
  let runningIds = $state({});
  async function run(r) {
    runningIds = { ...runningIds, [r.id]: true };
    status = '⚙ compiling “' + r.name + '” — headless, this can take a bit…';
    const j = await (await fetch('/api/routines/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.id }) })).json();
    if (!(j && j.ok)) { status = '✗ ' + ((j && j.error) || 'could not start'); runningIds = { ...runningIds, [r.id]: false }; return; }
    // poll for the new briefing
    const before = briefings.length;
    const t0 = Date.now();
    const poll = setInterval(async () => {
      await load();
      if (briefings.length > before || Date.now() - t0 > (10 * 60 * 1000)) {
        clearInterval(poll); runningIds = { ...runningIds, [r.id]: false };
        status = briefings.length > before ? '✓ briefing ready' : '⌛ still running…';
      }
    }, 3000);
  }

  function rel(ts) { if (!ts) return ''; const s = Math.floor((Date.now() - ts) / 1000); if (s < 60) return s + 's ago'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; return new Date(ts).toLocaleDateString(); }
  function dur(ms) { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60) + 's'; }

  function runAll() { status = '⚙ compiling all routines headlessly…'; for (const r of routines) run(r); }

  let scheduled = $derived(routines.filter((r) => r.enabled && r.schedule).length);
  let lastBrief = $derived(briefings[0]);
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Routines and briefings">
    <div class="hd">
      <strong>Routines &amp; Briefings</strong>
      <div class="hd-actions">
        {#if routines.length > 1}<button class="mini" onclick={runAll} title="Run every routine now">Compile all</button>{/if}
        <button class="mini" onclick={newRoutine}>＋ New routine</button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="digest">
      {routines.length} routine{routines.length === 1 ? '' : 's'} · {scheduled} scheduled · {briefings.length} briefing{briefings.length === 1 ? '' : 's'}
      {#if lastBrief}<span class="dim"> · latest “{lastBrief.name}” {rel(lastBrief.ts)}</span>{/if}
    </div>
    {#if status}<div class="status">{status}</div>{/if}

    <div class="body">
      {#if editing}
        <div class="form">
          <div class="form-h">{editing.id ? 'Edit routine' : 'New routine'}</div>
          <input class="in" placeholder="name (e.g. Morning Brief)" bind:value={editing.name} />
          <select class="in" bind:value={editing.cwd}>
            <option value="">Project: (current dir / none)</option>
            {#each projects as p (p.path)}<option value={p.path}>{p.name}</option>{/each}
          </select>
          <textarea class="in ta" placeholder="prompt — what should Claude do? It can use skills & MCP, e.g. 'use my news skill + Gmail/Calendar MCP and compile a morning briefing'" bind:value={editing.prompt}></textarea>
          <div class="microw"><MicButton onappend={(t) => (editing.prompt = (editing.prompt ? editing.prompt.trim() + ' ' : '') + t)} /> <span class="dim">dictate the prompt</span></div>
          <div class="frow">
            <label>Schedule <input class="in sm" placeholder="HH:MM or blank" bind:value={editing.schedule} /></label>
            <label>Permissions
              <select class="in" bind:value={editing.permMode}>
                <option value="bypassPermissions">skip all (headless)</option>
                <option value="acceptEdits">accept edits</option>
                <option value="plan">plan (read-only)</option>
                <option value="default">ask (may hang headless)</option>
              </select>
            </label>
          </div>
          <div class="frow">
            <label class="cb"><input type="checkbox" bind:checked={editing.enabled} /> Enabled (run on schedule)</label>
            <label class="cb"><input type="checkbox" bind:checked={editing.notify} /> Telegram me when ready</label>
          </div>
          <div class="fbtns">
            <button class="primary" onclick={save}>Save</button>
            <button onclick={() => (editing = null)}>Cancel</button>
            {#if editing.id}<button class="danger" onclick={() => del(editing.id)}>Delete</button>{/if}
          </div>
          <div class="hint">Runs <code>claude -p</code> headlessly in the project (skills/MCP load as usual). Keep briefing routines read-only. Scheduled runs use your local time; interactively-authenticated MCP (e.g. claude.ai connectors) may not work unattended.</div>
        </div>
      {/if}

      <div class="sec-h">Routines</div>
      {#if routines.length === 0}<div class="empty">No routines yet — ＋ New routine.</div>{/if}
      {#each routines as r (r.id)}
        <div class="rt">
          <div class="rt-top">
            <span class="rt-name">{r.name}</span>
            {#if r.schedule && r.enabled}<span class="badge sch">⏰ {r.schedule}</span>{:else if r.schedule}<span class="badge off">⏰ {r.schedule} (off)</span>{/if}
            {#if r.cwd}<span class="rt-proj">{r.cwd.split(/[\\/]/).filter(Boolean).pop()}</span>{/if}
          </div>
          <div class="rt-prompt">{r.prompt}</div>
          <div class="rt-actions">
            <button class="run" disabled={runningIds[r.id]} onclick={() => run(r)}>{runningIds[r.id] ? 'compiling…' : 'Compile now'}</button>
            <button class="mini" onclick={() => edit(r)}>Edit</button>
          </div>
        </div>
      {/each}

      <div class="sec-h">Briefings</div>
      {#if briefings.length === 0}<div class="empty">No briefings yet — run a routine.</div>{/if}
      {#each briefings as b (b.id)}
        <div class="bf" class:bad={!b.ok}>
          <div class="bf-top">
            <button class="bf-exp" onclick={() => (expanded = { ...expanded, [b.id]: !expanded[b.id] })}>
              <span class="bf-name">{b.ok ? '📋' : '⚠'} {b.name}</span>
              <span class="bf-meta">{b.project ? b.project + ' · ' : ''}{rel(b.ts)} · {dur(b.ms)}</span>
            </button>
            {#if b.ok && ttsAvailable}<button class="bf-listen" class:on={speakingId === b.id} onclick={() => listen(b)} title="Read aloud">{speakingId === b.id ? '⏹' : '🔊'}</button>{/if}
          </div>
          {#if expanded[b.id]}
            <pre class="bf-out">{b.ok ? b.output : (b.error || '(no output)')}</pre>
          {/if}
        </div>
      {/each}
    </div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 460px; }   /* shell (.ov/.drawer/.hd/.x) is shared in app.css */
  .hd-actions { display: flex; align-items: center; gap: 8px; }
  .mini { font-size: 10px; padding: 3px 9px; border-radius: 6px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .digest { padding: 7px 14px; font-size: 11px; color: var(--color-text-secondary); border-bottom: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); }
  .dim { color: var(--color-text-tertiary); }
  .status { padding: 6px 14px; font-size: 11px; color: var(--accent, #6366F1); }
  .body { flex: 1 1 auto; overflow-y: auto; padding: 8px 12px; }
  .sec-h { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent, #6366F1); font-weight: 600; margin: 12px 2px 6px; }
  .empty { font-size: 11px; color: var(--color-text-tertiary); padding: 4px 2px; }

  .form { background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .form-h { font-size: 11px; font-weight: 600; }
  .in { font-size: 12px; padding: 6px 8px; border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-primary); color: var(--color-text-primary); box-sizing: border-box; width: 100%; font-family: inherit; }
  .ta { min-height: 80px; resize: vertical; line-height: 1.4; }
  .microw { display: flex; align-items: center; gap: 7px; font-size: 10px; color: var(--color-text-tertiary); }
  .sm { width: 90px; }
  .frow { display: flex; gap: 10px; flex-wrap: wrap; }
  .frow label { font-size: 10px; color: var(--color-text-tertiary); display: flex; flex-direction: column; gap: 3px; }
  .cb { flex-direction: row !important; align-items: center; gap: 5px; font-size: 11px; color: var(--color-text-secondary); }
  .fbtns { display: flex; gap: 6px; }
  .fbtns button { font-size: 11px; padding: 5px 12px; border-radius: var(--border-radius-md); cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-primary); }
  .fbtns button.primary { background: var(--accent, #6366F1); color: #fff; border: none; font-weight: 600; }
  .fbtns button.danger { color: #EF4444; border-color: #EF4444; margin-left: auto; }
  .hint { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.45; }

  .rt { border: 0.5px solid var(--color-border-tertiary); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; display: flex; flex-direction: column; gap: 4px; }
  .rt-top { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .rt-name { font-size: 12px; font-weight: 600; }
  .rt-proj { font-size: 9px; color: var(--color-text-tertiary); font-family: var(--font-mono); }
  .badge { font-size: 9px; padding: 1px 6px; border-radius: 99px; }
  .badge.sch { background: #16803322; color: #168033; }
  .badge.off { background: var(--color-background-secondary); color: var(--color-text-tertiary); border: 0.5px solid var(--color-border-tertiary); }
  .rt-prompt { font-size: 10px; color: var(--color-text-secondary); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .rt-actions { display: flex; gap: 6px; margin-top: 2px; }
  .run { font-size: 11px; padding: 4px 11px; border-radius: var(--border-radius-md); cursor: pointer; border: none; background: var(--accent, #6366F1); color: #fff; font-weight: 600; }
  .run:disabled { opacity: 0.55; cursor: default; }

  .bf { border: 0.5px solid var(--color-border-tertiary); border-radius: 8px; margin-bottom: 6px; overflow: hidden; }
  .bf.bad { border-color: #EF444455; }
  .bf-top { display: flex; align-items: center; gap: 4px; }
  .bf-exp { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; background: none; border: none; cursor: pointer; padding: 8px 10px; text-align: left; color: var(--color-text-primary); }
  .bf-exp:hover { background: var(--color-background-secondary); }
  .bf-listen { background: none; border: none; cursor: pointer; font-size: 13px; padding: 6px 9px; color: var(--color-text-tertiary); }
  .bf-listen:hover, .bf-listen.on { color: var(--accent, #6366F1); }
  .bf-name { font-size: 12px; font-weight: 500; }
  .bf-meta { font-size: 9px; color: var(--color-text-tertiary); white-space: nowrap; font-family: var(--font-mono); }
  .bf-out { margin: 0; padding: 10px; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    background: var(--color-background-secondary); border-top: 0.5px solid var(--color-border-tertiary); max-height: 50vh; overflow: auto; font-family: inherit; }
</style>
