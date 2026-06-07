<script>
  let open = $state(false);
  let roots = $state([]);
  let fromId = $state('');
  let toId = $state('');
  let skills = $state([]);
  let skill = $state('');
  let skillsLoading = $state(false);
  let busy = $state(false);
  let result = $state(null); // { ok:true, skill } | { error }

  let pollId = null;
  let inspectSeq = 0;

  let source = $derived(roots.find((r) => r.sessionId === fromId) || null);
  let target = $derived(roots.find((r) => r.sessionId === toId) || null);
  let canCopy = $derived(
    !!source && !!target && !!skill && fromId !== toId && !busy
  );

  function rootLabel(r) {
    return `${r.project || 'unknown'} (${r.name || r.sessionId || '?'})`;
  }

  async function loadState() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const d = await r.json();
      const list = Array.isArray(d?.agents) ? d.agents : [];
      roots = list.filter((a) => a && a.root === true && a.sessionId);
    } catch (_) {
      roots = [];
    }
  }

  async function loadSkills() {
    skill = '';
    skills = [];
    if (!source || !source.sessionId) return;
    const seq = ++inspectSeq;
    skillsLoading = true;
    try {
      const r = await fetch('/api/inspect?session=' + encodeURIComponent(source.sessionId), { cache: 'no-store' });
      const d = await r.json();
      if (seq !== inspectSeq) return; // stale
      skills = Array.isArray(d?.skills) ? d.skills.filter((s) => typeof s === 'string') : [];
    } catch (_) {
      if (seq === inspectSeq) skills = [];
    } finally {
      if (seq === inspectSeq) skillsLoading = false;
    }
  }

  function toggle() {
    open = !open;
    if (open) {
      result = null;
      loadState();
      pollId = setInterval(loadState, 1500);
    } else if (pollId) {
      clearInterval(pollId);
      pollId = null;
    }
  }

  async function onPickFrom(e) {
    fromId = e.target.value;
    result = null;
    await loadSkills();
  }

  async function copy() {
    if (!canCopy || !source || !target) return;
    busy = true;
    result = null;
    const s = skill;
    try {
      const r = await fetch('/api/copy-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromCwd: source.cwd, toCwd: target.cwd, skill: s }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d && d.ok) result = { ok: true, skill: d.copied || s };
      else result = { error: (d && d.error) || 'Copy failed' };
    } catch (_) {
      result = { error: 'Network error' };
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  <button class="select" onclick={toggle} title="Copy a skill from one session to another">Copy skill…</button>
  {#if open}
    <div class="pop">
      <div class="hd">Copy skill <span>(session → session)</span></div>

      <div class="field">
        <label for="cs-from">From</label>
        <select id="cs-from" value={fromId} onchange={onPickFrom}>
          <option value="">Select source…</option>
          {#each roots as r (r.sessionId)}
            <option value={r.sessionId}>{rootLabel(r)}</option>
          {/each}
        </select>
      </div>

      <div class="field">
        <label for="cs-skill">Skill</label>
        <select id="cs-skill" bind:value={skill} disabled={!source || skillsLoading || skills.length === 0}>
          {#if !source}
            <option value="">Select a source first</option>
          {:else if skillsLoading}
            <option value="">Loading…</option>
          {:else if skills.length === 0}
            <option value="">no skills found</option>
          {:else}
            <option value="">Select skill…</option>
            {#each skills as s (s)}
              <option value={s}>{s}</option>
            {/each}
          {/if}
        </select>
      </div>

      <div class="field">
        <label for="cs-to">To</label>
        <select id="cs-to" bind:value={toId}>
          <option value="">Select target…</option>
          {#each roots.filter((r) => r.sessionId !== fromId) as r (r.sessionId)}
            <option value={r.sessionId}>{rootLabel(r)}</option>
          {/each}
        </select>
      </div>

      <div class="actions">
        <button class="mini go" onclick={copy} disabled={!canCopy}>{busy ? 'Copying…' : 'Copy'}</button>
        {#if result?.ok}
          <span class="res ok">Copied {result.skill}</span>
        {:else if result?.error}
          <span class="res err">{result.error}</span>
        {/if}
      </div>
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
  .field { display: flex; align-items: center; gap: 8px; padding: 4px 2px; font-size: 11px; }
  .field label { flex: 0 0 38px; color: var(--color-text-secondary); }
  .field select {
    flex: 1 1 auto; min-width: 0; font-size: 11px; padding: 4px 6px;
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md);
    background: var(--color-background-secondary); color: var(--color-text-primary);
  }
  .field select:disabled { opacity: 0.6; cursor: not-allowed; }
  .actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .mini {
    font-size: 10px; padding: 3px 9px; border-radius: var(--border-radius-md); cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-primary);
  }
  .mini.go:disabled { opacity: 0.5; cursor: not-allowed; }
  .res { font-size: 10px; line-height: 1.3; }
  .res.ok { color: #10B981; }
  .res.err { color: #EF4444; }
</style>
