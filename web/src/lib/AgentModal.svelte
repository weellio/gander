<script>
  import { onMount } from 'svelte';
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import { costAlerts } from './stores.js';
  import { readFile, downscale } from './img.js';
  import TranscriptPanel from './TranscriptPanel.svelte';

  let { id, onClose } = $props();
  let agent = $state(null);
  let info = $state(null);
  let msg = $state('');
  let pendingImage = $state(null);   // { dataUrl, name } — dropped/pasted image to ask about
  let dropActive = $state(false);
  let cost = $state(null);
  let gh = $state(null);
  let txId = $state(null);
  let flash = $state('');
  let busy = $state('');
  let flashTimer;
  let sid = $derived(agent ? (agent.sessionId || String(agent.id).replace(/^sess:/, '')) : '');

  async function refresh() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const d = await r.json();
      const found = (d.agents || []).find((a) => String(a.id) === String(id));
      if (found) agent = found;
    } catch (_) {}
  }
  async function loadInfo() {
    if (!agent || !agent.root) return;
    try {
      const sid = agent.sessionId || String(agent.id).replace(/^sess:/, '');
      const r = await fetch('/api/inspect?session=' + encodeURIComponent(sid));
      info = await r.json();
    } catch (_) {}
  }
  async function loadCost() {
    if (!sid) return;
    try { const r = await fetch('/api/usage'); const j = await r.json(); cost = (j.bySession && j.bySession[sid]) || null; } catch (_) {}
  }
  async function loadGithub() {
    if (!agent || !agent.cwd) return;
    try {
      const r = await fetch('/api/github', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: agent.cwd, kind: 'info' }) });
      const j = await r.json();
      gh = j && !j.error && j.url ? j : null;
    } catch (_) {}
  }
  onMount(() => {
    refresh().then(() => { loadInfo(); loadCost(); loadGithub(); });
    const t = setInterval(refresh, 1200);
    return () => clearInterval(t);
  });

  function showFlash(text) {
    flash = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = ''; }, 2200);
  }
  async function attachImage(f) {
    if (!f || !/^image\//.test(f.type)) return;
    try { const raw = await readFile(f); const ds = (await downscale(raw, 1600)) || raw; pendingImage = { dataUrl: ds, name: f.name || 'pasted.png' }; }
    catch (_) { showFlash('✗ Could not read that image'); }
  }
  function onDrop(e) { e.preventDefault(); dropActive = false; const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) attachImage(f); }
  function onDragOver(e) { if (Array.from((e.dataTransfer && e.dataTransfer.items) || []).some((i) => i.kind === 'file')) { e.preventDefault(); dropActive = true; } }
  function onDragLeave() { dropActive = false; }
  function onPaste(e) {
    for (const it of (e.clipboardData && e.clipboardData.items) || []) {
      if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) { e.preventDefault(); attachImage(f); break; } }
    }
  }

  async function send(type) {
    if (!agent || busy) return;
    const sid = agent.sessionId || String(agent.id).replace(/^sess:/, '');
    if (type === 'message' && pendingImage) {
      busy = type;
      try {
        const r = await fetch('/api/drop-image', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, cwd: agent.cwd, dataUrl: pendingImage.dataUrl, name: pendingImage.name, text: msg }),
        });
        const j = await r.json();
        if (j && j.ok) { showFlash('🖼 Image sent — Claude will Read it on next check-in'); msg = ''; pendingImage = null; }
        else showFlash('✗ ' + ((j && j.error) || 'failed'));
      } catch (_) { showFlash('✗ Failed — is the bridge running?'); }
      finally { busy = ''; }
      return;
    }
    if (type === 'message' && !msg.trim()) { showFlash('⚠ type a message first'); return; }
    busy = type;
    try {
      const r = await fetch('/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, type, text: msg }),
      });
      if (r.ok) { showFlash(type === 'stop' ? '■ Stop sent — halts at next tool' : '✓ Message sent — delivered on next check-in'); if (type === 'message') msg = ''; }
      else showFlash('✗ Failed — is the bridge running?');
    } catch (_) { showFlash('✗ Failed — is the bridge running?'); }
    finally { busy = ''; }
  }
  async function openIn(target) {
    if (!agent || !agent.cwd) return;
    try { await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: agent.cwd, target }) }); } catch (_) {}
  }
  // type a keystroke into the session's terminal window — answers interactive
  // numbered prompts / y-n / arrow menus that the message queue can't reach.
  async function sendKey(keys) {
    if (!agent) return;
    const sid = agent.sessionId || String(agent.id).replace(/^sess:/, '');
    try {
      const r = await fetch('/api/sendkeys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, keys }) });
      const j = await r.json();
      const pretty = keys.replace('{ENTER}', '↵').replace('{ESC}', 'Esc').replace('{UP}', '↑').replace('{DOWN}', '↓');
      showFlash(j && j.ok ? '⌨ sent ' + pretty : '✗ ' + ((j && j.error) || 'failed'));
    } catch (_) { showFlash('✗ Failed — is the bridge running?'); }
  }
  function onKey(e) { if (e.key === 'Escape') onClose(); }
  function onReplyKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send('message'); } }
  function autogrow(e) { const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight) + 'px'; }
  function rel(ts) { if (!ts) return ''; const s = Math.max(0, Math.floor((Date.now() - ts) / 1000)); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); if (h < 24) return h + 'h'; return Math.floor(h / 24) + 'd'; }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" onclick={onClose} role="presentation">
  <div class="modal" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} style="--c:{agent ? (STATE_COLORS[agent.state] || '#6B7280') : '#6B7280'}">
    {#if agent}
      <div class="hd">
        <span class="dot"></span>
        <span class="name" title={agent.name}>{agent.name}</span>
        <span class="badge">{STATE_LABEL[agent.state] || agent.state}</span>
        {#if gh?.url}<a class="ghlink" href={gh.url} target="_blank" rel="noopener" title={'Open ' + gh.repo + ' on GitHub'}>GitHub ↗</a>{/if}
        <button class="x" onclick={onClose} aria-label="Close">✕</button>
      </div>
      <div class="meta">
        {#if agent.project}<span>{agent.project}</span>{/if}
        {#if agent.sessionId}<span class="mono">· {String(agent.sessionId).slice(0, 8)}</span>{/if}
        {#if agent.parentId}<span>· sub-agent</span>{/if}
        {#if agent.role}<span title="Agent type">· {agent.role}</span>{/if}
        {#if agent.model && agent.model !== 'inherit'}<span title="Defined model">· 🧠 {agent.model}</span>{/if}
        {#if agent.updatedAt}<span class="mono" title="Time since last event">· ⏱ {rel(agent.updatedAt)}</span>{/if}
        {#if cost}<span class="mono" title="This session's estimated spend">· 💰 ${cost.costUSD.toFixed(2)}</span>{/if}
        {#if agent.runaway && $costAlerts}<span class="mono burn" title="Burning fast right now — consider Stop">· 💸 ${(agent.burnRate || 0).toFixed(2)}/min</span>{/if}
      </div>
      {#if agent.cwd}<div class="path mono">{agent.cwd}</div>{/if}

      <div class="sec">
        <div class="lbl">Current task / last message</div>
        {#if agent.lastMessage}<div class="lm">{agent.lastMessage}</div>{:else}<div class="dim">No captured message yet (appears after the agent finishes a turn).</div>{/if}
      </div>

      {#if agent.logLines && agent.logLines.length}
        <div class="sec"><div class="lbl">Recent activity</div>
          <ul class="logs">{#each agent.logLines.slice(0, 6) as l, i (i)}<li>{l}</li>{/each}</ul>
        </div>
      {/if}

      {#if info}
        <div class="sec chips">
          <span class="chip">Skills: {info.skills && info.skills.length ? info.skills.join(', ') : '—'}</span>
          <span class="chip">Sub-agents: {(info.subagents && info.subagents.length) || 0}</span>
          <span class="chip">Hooks: {(info.hooks && info.hooks.length) || 0}</span>
        </div>
      {/if}

      {#if agent.cwd || sid}
        <div class="actions">
          {#if sid}<button class="select" onclick={() => (txId = sid)}>📄 Transcript</button>{/if}
          {#if agent.cwd}<button class="select" onclick={() => openIn('folder')}>📂 Open folder</button>{/if}
          {#if agent.cwd}<button class="select" onclick={() => openIn('editor')}>Open in VS Code</button>{/if}
        </div>
      {/if}

      {#if agent.cwd}
        <div class="keys" class:awaiting={agent.state === 'awaiting'} title="Types the key into this session's terminal window — keep the Claude terminal focused there.">
          <span class="klbl">⌨ Answer a prompt{#if agent.state === 'awaiting'} <span class="now">· waiting on you</span>{/if}</span>
          <div class="kbtns">
            <button onclick={() => sendKey('1{ENTER}')}>1</button>
            <button onclick={() => sendKey('2{ENTER}')}>2</button>
            <button onclick={() => sendKey('3{ENTER}')}>3</button>
            <button onclick={() => sendKey('{UP}')} title="Arrow up">↑</button>
            <button onclick={() => sendKey('{DOWN}')} title="Arrow down">↓</button>
            <button onclick={() => sendKey('{ENTER}')} title="Enter">↵</button>
            <button onclick={() => sendKey('y')}>y</button>
            <button onclick={() => sendKey('n')}>n</button>
            <button onclick={() => sendKey('{ESC}')}>Esc</button>
          </div>
        </div>
      {/if}

      {#if pendingImage}
        <div class="attach">
          <img src={pendingImage.dataUrl} alt="attachment" />
          <span class="atxt">{pendingImage.name} — ask about it below, then Send</span>
          <button class="ax" title="Remove" onclick={() => (pendingImage = null)}>✕</button>
        </div>
      {/if}
      <div class="reply" class:drag={dropActive} ondrop={onDrop} ondragover={onDragOver} ondragleave={onDragLeave} role="group">
        <textarea bind:value={msg} rows="1" placeholder="reply / send a task…  (Enter sends · Shift+Enter newline · drop/paste an image)" onkeydown={onReplyKey} oninput={autogrow} onpaste={onPaste}></textarea>
        <div class="rbtns">
          <button class="act" disabled={busy === 'message'} onclick={() => send('message')}>{busy === 'message' ? 'Sending…' : (pendingImage ? 'Send 🖼' : 'Send')}</button>
          <button class="act stop" disabled={busy === 'stop'} onclick={() => send('stop')}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</button>
        </div>
        {#if dropActive}<div class="dropmask">Drop image to ask about it</div>{/if}
      </div>
      {#if flash}<div class="flash" class:err={flash[0] === '✗' || flash[0] === '⚠'}>{flash}</div>{/if}
      <div class="foot">Replies deliver when the agent next checks in. “Stop” halts it at its next tool. Drop/paste an image and Claude saves + Reads it.</div>
    {:else}
      <div class="dim" style="padding:8px 4px">Agent not found — it may have finished.</div>
      <button onclick={onClose}>Close</button>
    {/if}
  </div>
</div>

<TranscriptPanel bind:sessionId={txId} />

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.35); backdrop-filter: blur(1px);
  }
  .modal {
    width: 580px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); overflow: auto;
    background: var(--color-background-primary); color: var(--color-text-primary);
    border: 0.5px solid var(--color-border-secondary); border-left: 3px solid var(--c);
    border-radius: var(--border-radius-lg); padding: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    display: flex; flex-direction: column; gap: 10px;
  }
  .hd { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--c); }
  .name { font-size: 14px; font-weight: 600; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 10px; font-weight: 600; color: #fff; background: var(--c); padding: 2px 8px; border-radius: 99px; }
  .x { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .ghlink { font-size: 10px; padding: 2px 8px; border-radius: 99px; white-space: nowrap; text-decoration: none;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .ghlink:hover { color: var(--color-text-primary); border-color: var(--accent, #6366F1); }
  .meta { font-size: 11px; color: var(--color-text-secondary); display: flex; gap: 4px; flex-wrap: wrap; }
  .path { font-size: 10px; color: var(--color-text-tertiary); word-break: break-all; }
  .mono { font-family: var(--font-mono); }
  .sec { display: flex; flex-direction: column; gap: 5px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  .lm { font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; background: var(--color-background-secondary);
    border-radius: 8px; padding: 10px; max-height: 46vh; overflow: auto; }
  .dim { font-size: 11px; color: var(--color-text-tertiary); }
  .logs { margin: 0; padding-left: 16px; font-family: var(--font-mono); font-size: 10px; color: var(--color-text-secondary); }
  .chips { flex-direction: row; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 10px; background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary);
    border-radius: 99px; padding: 3px 8px; color: var(--color-text-secondary); }
  .attach { display: flex; align-items: center; gap: 8px; padding: 5px; border-radius: 8px;
    background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary); }
  .attach img { width: 40px; height: 40px; object-fit: cover; border-radius: 5px; flex-shrink: 0; }
  .atxt { font-size: 10px; color: var(--color-text-secondary); flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ax { background: none; border: none; cursor: pointer; color: var(--color-text-tertiary); font-size: 12px; }
  .reply { position: relative; display: flex; gap: 6px; align-items: flex-end; border-radius: var(--border-radius-md); }
  .reply.drag { outline: 2px dashed var(--accent, #6366F1); outline-offset: 3px; }
  .dropmask { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none;
    background: color-mix(in srgb, var(--accent, #6366F1) 14%, var(--color-background-primary)); border-radius: var(--border-radius-md);
    font-size: 12px; font-weight: 600; color: var(--accent, #6366F1); }
  .reply textarea { flex: 1 1 auto; min-width: 0; font-size: 12px; padding: 6px 8px; font-family: inherit;
    line-height: 1.4; resize: none; overflow-y: auto; max-height: 160px;
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md);
    background: var(--color-background-secondary); color: var(--color-text-primary); }
  .rbtns { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
  .reply button { font-size: 11px; padding: 6px 10px; border-radius: var(--border-radius-md); cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-primary); }
  .reply button.stop { color: #EF4444; border-color: #EF4444; }
  .reply button.act { transition: transform 0.06s ease, background 0.12s ease, box-shadow 0.12s ease; }
  .reply button.act:hover:not(:disabled) { background: var(--color-background-secondary); }
  .reply button.act:active:not(:disabled) { transform: translateY(1px) scale(0.97); box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.25); }
  .reply button.act:disabled { opacity: 0.6; cursor: default; }
  .flash { font-size: 11px; font-weight: 600; color: #10B981; padding: 2px 2px; animation: flashin 0.18s ease; }
  .flash.err { color: #EF4444; }
  @keyframes flashin { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
  .burn { color: #EF4444; font-weight: 600; }
  .foot { font-size: 10px; color: var(--color-text-tertiary); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .keys { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 9px; border-radius: 8px;
    background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary); }
  .keys.awaiting { border-color: #F59E0B; background: color-mix(in srgb, #F59E0B 10%, var(--color-background-secondary)); }
  .klbl { font-size: 10px; color: var(--color-text-tertiary); }
  .now { color: #F59E0B; font-weight: 600; }
  .kbtns { display: flex; gap: 4px; flex-wrap: wrap; }
  .kbtns button { min-width: 26px; font-size: 11px; padding: 4px 7px; border-radius: var(--border-radius-md); cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-primary); font-family: var(--font-mono); }
  .kbtns button:hover { border-color: var(--accent, #6366F1); }
</style>
