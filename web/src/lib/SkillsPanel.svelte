<script>
  // Skills index — every skill across all projects (+ global ~/.claude) in one table,
  // with its one-line summary. Copy a skill to another project, or move a useful one to
  // Global so it's available everywhere (and drop redundant per-project duplicates).
  let { open = $bindable(false) } = $props();
  let _w = false;
  $effect(() => { if (open && !_w) load(); _w = open; });

  let loading = $state(false);
  let data = $state(null);
  let flash = $state('');
  let filter = $state('');
  let copyTarget = $state({});

  async function jget(u) { try { return await (await fetch(u)).json(); } catch (_) { return null; } }
  async function jpost(u, b) { try { return await (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(); } catch (_) { return { error: 'request failed' }; } }

  async function load() {
    loading = true;
    const d = await jget('/api/skills');
    data = d || { skills: [], projects: [] };
    loading = false;
  }
  const keyOf = (s) => s.projectPath + '::' + s.name;
  let globalProj = $derived(data && data.projects ? data.projects.find((p) => p.global) : null);
  let rows = $derived.by(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    return data.skills.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.project || '').toLowerCase().includes(q) || (s.summary || '').toLowerCase().includes(q));
  });

  async function copyTo(s) {
    const to = copyTarget[keyOf(s)];
    if (!to) { flash = 'Pick a target project first.'; return; }
    if (to === s.projectPath) { flash = 'That is the same project.'; return; }
    await doCopy(s, to, false);
  }
  async function doCopy(s, toCwd, overwrite) {
    flash = `Copying ${s.name}…`;
    const r = await jpost('/api/copy-component', { type: 'skill', name: s.name, fromCwd: s.projectPath, toCwd, overwrite });
    if (r && r.exists && !overwrite) {
      if (confirm(`"${s.name}" already exists in the target project. Overwrite it?`)) return doCopy(s, toCwd, true);
      flash = 'Cancelled.'; return;
    }
    if (r && (r.ok || r.copied)) { flash = `✓ Copied ${s.name}`; load(); } else flash = `✗ ${(r && r.error) || 'copy failed'}`;
  }
  async function moveToGlobal(s) {
    if (!globalProj) { flash = '✗ No Global (~/.claude) target found.'; return; }
    if (s.global) { flash = 'Already global.'; return; }
    if (!confirm(`Move "${s.name}" to Global (~/.claude)?\n\nIt will be copied there and REMOVED from ${s.project}.`)) return;
    flash = `Moving ${s.name} → Global…`;
    let r = await jpost('/api/component-move', { type: 'skill', name: s.name, fromCwd: s.projectPath, toCwd: globalProj.path });
    if (r && r.exists) {
      if (!confirm(`"${s.name}" already exists in Global. Overwrite it (then remove from ${s.project})?`)) { flash = 'Cancelled.'; return; }
      r = await jpost('/api/component-move', { type: 'skill', name: s.name, fromCwd: s.projectPath, toCwd: globalProj.path, overwrite: true });
    }
    if (r && r.ok) { flash = `✓ Moved ${s.name} → Global${r.note ? ' — ' + r.note : ''}`; load(); } else flash = `✗ ${(r && r.error) || 'move failed'}`;
  }
  function closePanel() { open = false; }
  function onKey(e) { if (e.key === 'Escape') closePanel(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Skills across all projects">
    <div class="hd">
      <strong>Skills <span class="dim">· all projects{#if data}, {data.skills.length}{/if}</span></strong>
      <div class="hdr">
        <button class="select" onclick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>
    <div class="intro">Every skill across your projects and global <code>~/.claude</code>, with what it does. <b>Copy</b> one to another project, or move a broadly-useful one <b>→ Global</b> so it applies everywhere. (A skill that's both global <i>and</i> copied into a project is redundant.)</div>
    <input class="filter" placeholder="filter by skill / project / summary…" bind:value={filter} />
    <div class="body">
      {#if loading && !data}
        <div class="muted">Reading skills…</div>
      {:else if !rows.length}
        <div class="muted">{data && data.skills.length ? 'No match for that filter.' : 'No skills found in any project yet.'}</div>
      {:else}
        <table class="tbl">
          <thead><tr><th>Skill</th><th>Project</th><th>Summary</th><th class="ah">Actions</th></tr></thead>
          <tbody>
            {#each rows as s (keyOf(s))}
              <tr>
                <td class="nm">{s.name}{#if s.global}<span class="gtag">global</span>{/if}</td>
                <td class="pj">{s.project}</td>
                <td class="sm" title={s.summary}>{s.summary || '—'}</td>
                <td class="act">
                  <select class="psel" bind:value={copyTarget[keyOf(s)]} title="copy to project">
                    <option value="">copy to…</option>
                    {#each data.projects.filter((p) => p.path !== s.projectPath) as p (p.path)}<option value={p.path}>{p.name}</option>{/each}
                  </select>
                  <button class="mini" onclick={() => copyTo(s)} title="Copy this skill to the selected project (keeps the original)">Copy</button>
                  {#if !s.global}<button class="mini gl" onclick={() => moveToGlobal(s)} title="Move to ~/.claude so every project gets it (copies there, then removes it from this project)">→ Global</button>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
    {#if flash}<div class="flash" class:err={flash[0] === '✗'}>{flash}</div>{/if}
    <div class="foot"><b>Copy</b> leaves the original in place. <b>→ Global</b> copies the skill to <code>~/.claude</code> then removes it from the source project. Both ask before overwriting an existing skill of the same name.</div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 660px; }
  .dim { color: var(--color-text-tertiary); font-weight: 400; }
  .hdr { display: flex; align-items: center; gap: 8px; }
  .intro { font-size: 11px; color: var(--color-text-secondary); line-height: 1.5; padding: 10px 14px 6px; }
  .intro code { font-family: var(--font-mono); font-size: 10px; }
  .filter { margin: 0 14px 8px; padding: 5px 9px; font-size: 12px; border-radius: 6px;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .body { flex: 1 1 auto; overflow: auto; padding: 0 8px 4px; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 16px 14px; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .tbl th { position: sticky; top: 0; text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--color-text-tertiary); font-weight: 600; padding: 6px; background: var(--color-background-primary); border-bottom: 0.5px solid var(--color-border-tertiary); }
  .tbl td { padding: 6px; border-bottom: 0.5px solid var(--color-border-tertiary); vertical-align: top; }
  .nm { font-weight: 600; color: var(--color-text-primary); white-space: nowrap; }
  .gtag { font-size: 8px; margin-left: 5px; padding: 1px 5px; border-radius: 999px; background: #10B9811f; color: #10B981; text-transform: uppercase; letter-spacing: .04em; vertical-align: middle; }
  .pj { color: var(--color-text-secondary); white-space: nowrap; }
  .sm { color: var(--color-text-secondary); line-height: 1.4; min-width: 200px; }
  .ah { width: 1%; }
  .act { white-space: nowrap; display: flex; gap: 4px; align-items: center; }
  .psel { font-size: 10px; max-width: 110px; padding: 2px 4px; border-radius: 5px; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .mini { font-size: 10px; padding: 2px 7px; border-radius: 5px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-secondary); white-space: nowrap; }
  .mini:hover { border-color: var(--accent, #6366F1); }
  .mini.gl { color: #10B981; border-color: #10B98155; }
  .mini.gl:hover { background: #10B9811a; }
  .flash { font-size: 11px; padding: 8px 14px; color: #10B981; border-top: 0.5px solid var(--color-border-tertiary); }
  .flash.err { color: #EF4444; }
  .foot { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.5; padding: 9px 14px; border-top: 0.5px solid var(--color-border-tertiary); }
  .foot code { font-family: var(--font-mono); font-size: 9.5px; }
</style>
