<script>
  import { onMount } from 'svelte';
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import { costAlerts } from './stores.js';
  import { readFile, downscale } from './img.js';
  import MicButton from './MicButton.svelte';
  import TranscriptPanel from './TranscriptPanel.svelte';
  import ClaudeMdAudit from './ClaudeMdAudit.svelte';

  let { id, onClose } = $props();
  let agent = $state(null);
  let info = $state(null);
  let msg = $state('');
  let pendingImage = $state(null);   // { dataUrl, name } — dropped/pasted image to ask about
  let dropActive = $state(false);
  let cost = $state(null);
  let gh = $state(null);
  let txId = $state(null);
  let auditOpen = $state(false);
  let flash = $state('');
  let busy = $state('');
  let flashTimer;
  let convo = $state([]);          // live conversation (from the transcript on disk — free, no model calls)
  let convoOpen = $state(false);
  let convoEl;                     // scroll container
  let sid = $derived(agent ? (agent.sessionId || String(agent.id).replace(/^sess:/, '')) : '');
  // Context-fill gauge: latest turn's context ÷ model limit. Claude Code auto-compacts
  // near the limit, so a high % on a parked session is the moment to compact by hand.
  let ctxPct = $derived(cost && typeof cost.ctxPct === 'number' ? cost.ctxPct : null);
  let parked = $derived(agent && ['idle', 'done', 'awaiting'].includes(agent.state));
  let compactReady = $derived(ctxPct !== null && ctxPct >= 0.7 && parked);
  function pct(x) { return Math.round((x || 0) * 100) + '%'; }
  function ctxColor(p) { return p >= 0.85 ? '#EF4444' : p >= 0.7 ? '#F59E0B' : '#10B981'; }

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
  // Live conversation: read the session's transcript on disk (structured messages) and
  // poll while the pane is open. Pure reads — no model calls, no cost, plan or API alike.
  async function loadConvo() {
    if (!sid) return;
    try {
      const r = await fetch('/api/transcript', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
      const d = await r.json();
      const msgs = (d.messages || []).filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.text || (m.tools && m.tools.length)));
      const atBottom = !convoEl || (convoEl.scrollHeight - convoEl.scrollTop - convoEl.clientHeight < 60);
      convo = msgs.slice(-80);
      if (atBottom) queueMicrotask(() => { if (convoEl) convoEl.scrollTop = convoEl.scrollHeight; });
    } catch (_) {}
  }
  $effect(() => {
    if (!convoOpen || !sid) return;
    loadConvo();
    const t = setInterval(loadConvo, 2500);
    return () => clearInterval(t);
  });

  onMount(() => {
    refresh().then(() => { loadInfo(); loadCost(); loadGithub(); loadProcs(); });
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
  // Explicit, opt-in reply for a session with NO open terminal: resumes it headlessly
  // (a real turn on your own claude login — plan quota, no API key). Warned, because
  // resuming a session whose terminal is still open can corrupt the conversation.
  async function resumeReply() {
    if (!agent || busy) return;
    if (!msg.trim()) { showFlash('⚠ type a message first'); return; }
    if (!confirm('Resume this session with no terminal?\n\nThis runs a real turn headlessly and is perfect for a session that has clocked out. But if a terminal window for it is still open, use Send instead — two processes on one conversation can corrupt it.')) return;
    busy = 'resume';
    try {
      const r = await fetch('/api/resume-reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, cwd: agent.cwd, text: msg }) });
      const j = await r.json();
      if (j && j.ok) { showFlash('✓ Resumed — a new turn is running (no terminal). Watch it in 💬 conversation.'); msg = ''; if (convoOpen) setTimeout(loadConvo, 2000); }
      else if (j && j.busy) showFlash('✗ Session is busy — use Send instead (it queues)');
      else showFlash('✗ ' + ((j && j.error) || 'could not resume'));
    } catch (_) { showFlash('✗ Failed — is the bridge running?'); }
    finally { busy = ''; }
  }
  async function openIn(target) {
    if (!agent || !agent.cwd) return;
    try { await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: agent.cwd, target }) }); } catch (_) {}
  }
  // Bring the running session's terminal window to the front (uses the window PID
  // captured at launch). Different from "Open in VS Code", which opens the folder.
  async function focusWindow() {
    if (!agent) return;
    const sid = agent.sessionId || String(agent.id).replace(/^sess:/, '');
    try {
      const r = await fetch('/api/focus-window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
      const j = await r.json();
      if (j && j.ok && j.found) showFlash('🪟 brought the session window to the front');
      else if (j && j.ok) showFlash("✗ couldn't find this session's window — launch it from Gander (▶ Start / ＋ New task) so the window can be captured.");
      else showFlash('✗ ' + ((j && j.error) || 'failed'));
    } catch (_) { showFlash('✗ Failed — is the bridge running?'); }
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
      if (j && j.ok && j.found) showFlash('⌨ sent ' + pretty);
      else if (j && j.ok) showFlash("✗ couldn't find this session's window — open it. (Bare terminals title as “Claude Code”; quick-keys target by project name, which works for VS Code.)");
      else showFlash('✗ ' + ((j && j.error) || 'failed'));
    } catch (_) { showFlash('✗ Failed — is the bridge running?'); }
  }
  // Type "/compact" into the session's window — summarizes the conversation so far,
  // freeing context (and cutting the cache-read you pay on every later turn). Best
  // run on a parked session between tasks; mid-turn it would interrupt the work.
  async function compactNow() {
    if (!agent) return;
    const s = agent.sessionId || String(agent.id).replace(/^sess:/, '');
    try {
      const r = await fetch('/api/sendkeys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s, keys: '/compact{ENTER}' }) });
      const j = await r.json();
      if (j && j.ok && j.found) showFlash("🗜 /compact sent. If nothing happened, the keys hit the wrong window — click into the Claude terminal and type /compact (a session in VS Code's integrated terminal can't be targeted).");
      else if (j && j.ok) showFlash("✗ couldn't reach this session's window — launch it from Gander (▶ Start / ＋ New task) so it can be targeted.");
      else showFlash('✗ ' + ((j && j.error) || 'failed'));
    } catch (_) { showFlash('✗ Failed — is the bridge running?'); }
  }
  // Processes this session spawned and left running (dev servers, node, python…).
  let procs = $state([]);
  async function loadProcs() {
    if (!agent || !agent.root) return;
    try {
      const r = await fetch('/api/processes');
      const j = await r.json();
      procs = (j.processes || []).filter((p) => p.sessionId && sid && p.sessionId === sid);
    } catch (_) {}
  }
  async function killProc(p) {
    const where = p.ports && p.ports.length ? ` on port ${p.ports.join(', ')}` : '';
    if (!confirm(`Kill ${p.name} (pid ${p.pid})${where}? Force-kills it and its child tree.`)) return;
    try { await fetch('/api/kill-process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: p.pid }) }); showFlash('■ killed pid ' + p.pid); }
    catch (_) { showFlash('✗ kill failed'); }
    setTimeout(loadProcs, 400);
  }
  function upShort(ms) { if (ms == null) return ''; const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60); return h > 0 ? h + 'h' : (m > 0 ? m + 'm' : s + 's'); }
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

      {#if agent.state === 'awaiting'}
        <div class="await">
          <div class="await-h">🔔 Waiting on you</div>
          <div class="await-msg">{agent.awaitMsg || 'Claude is waiting for your input.'}</div>
          <div class="await-note">The exact menu lives in the terminal — Gander can't read it. Open it (<b>Open in VS Code</b>) to see the options, then answer with the keys below (e.g. <b>1</b> = first option, <b>y</b>/<b>n</b>, <b>↵</b>).</div>
        </div>
      {/if}

      <div class="sec">
        <div class="lbl">Current task / last message
          <button class="convo-toggle" onclick={() => (convoOpen = !convoOpen)} title="Read the whole conversation live, from the session's transcript (no model calls)">{convoOpen ? '▾ hide conversation' : '💬 conversation'}</button>
        </div>
        {#if agent.lastMessage}<div class="lm">{agent.lastMessage}</div>{:else}<div class="dim">No captured message yet (fills in as the agent works).</div>{/if}
        {#if convoOpen}
          <div class="convo" bind:this={convoEl}>
            {#each convo as m (m.ts + m.role)}
              <div class="turn {m.role}">
                {#if m.text}<div class="bub">{m.text}</div>{/if}
                {#if m.tools && m.tools.length}<div class="tools">⚙ {m.tools.map((t) => t.name).join(' · ')}</div>{/if}
              </div>
            {/each}
            {#if !convo.length}<div class="dim cempty">No conversation captured yet — it fills in live as the session works.</div>{/if}
          </div>
          <div class="convo-foot">Live from the transcript on disk · reading costs nothing. Reply below ↓</div>
        {/if}
      </div>

      {#if cost && (cost.tokens || ctxPct !== null)}
        <div class="sec">
          <div class="lbl">Analytics <span class="dim2">· estimated from transcript</span></div>
          <div class="gauges">
            {#if cost.tokens}<span class="g" title="Total tokens this session (input + output + cache)">🔢 {cost.tokens >= 1e6 ? (cost.tokens / 1e6).toFixed(1) + 'M' : Math.round(cost.tokens / 1000) + 'k'} tok</span>{/if}
            {#if typeof cost.cacheHit === 'number'}<span class="g" title="Share of input-side tokens served from cache. Higher = more efficient (re-using context instead of re-sending it).">♻️ {pct(cost.cacheHit)} cache-hit</span>{/if}
            {#if typeof cost.outShare === 'number'}<span class="g" title="Output's share of spend. Output costs ~5x input, so a high share means verbose answers — a candidate for a terse/shorthand skill.">🗣 {pct(cost.outShare)} output $</span>{/if}
          </div>
          {#if ctxPct !== null}
            <div class="ctx">
              <div class="ctx-top">
                <span>Context window</span>
                <span class="mono" style="color:{ctxColor(ctxPct)}">{pct(ctxPct)} of {Math.round((cost.ctxMax || 200000) / 1000)}k{ctxPct >= 0.85 ? ' · auto-compact soon' : ''}</span>
              </div>
              <div class="bar"><div class="fill" style="width:{Math.round(ctxPct * 100)}%;background:{ctxColor(ctxPct)}"></div></div>
            </div>
          {/if}
          {#if agent.cwd}<button class="auditbtn" onclick={() => (auditOpen = true)} title="Find CLAUDE.md lines that cost window every turn but are never used">🔍 Audit CLAUDE.md for dead weight</button>{/if}
        </div>
      {/if}

      {#if compactReady && agent.cwd}
        <div class="compact-cta">
          <div class="cc-txt"><b>Good moment to compact.</b> This session is parked at {pct(ctxPct)} context — compacting now summarizes the conversation and frees tokens (cuts the cache-read you pay every later turn) before the next task.</div>
          <button class="cc-btn" onclick={compactNow} title="Types /compact into this session's window">🗜 Compact now</button>
        </div>
      {/if}

      {#if procs.length}
        <div class="sec">
          <div class="lbl">⚙ Left running by this session <span class="dim2">· {procs.length}</span></div>
          {#each procs as p (p.pid)}
            <div class="proc">
              <span class="pn">{p.name}</span>
              <span class="pp mono">pid {p.pid}</span>
              {#each (p.ports || []) as port (port)}<a class="pport" href="http://localhost:{port}" target="_blank" rel="noopener" title="Open http://localhost:{port} in a new tab">:{port} ↗</a>{/each}
              <span class="pu mono">{upShort(p.uptimeMs)}</span>
              <button class="pk" onclick={() => killProc(p)} title={p.cmd}>Kill</button>
            </div>
          {/each}
        </div>
      {/if}

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
          {#if agent.winPid}<button class="select" onclick={focusWindow} title="Bring this session's terminal window to the front (the window Gander captured when it launched)">🪟 Focus window</button>{/if}
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
          <MicButton onappend={(t) => (msg = (msg ? msg.trim() + ' ' : '') + t)} />
          <button class="act" disabled={busy === 'message'} onclick={() => send('message')}>{busy === 'message' ? 'Sending…' : (pendingImage ? 'Send 🖼' : 'Send')}</button>
          {#if parked && !pendingImage}<button class="act resume" disabled={busy === 'resume'} onclick={resumeReply} title="Reply with NO terminal: resume this clocked-out session headlessly (runs a real turn on your own claude login — plan quota, no API key). Use only if no terminal window is open for it.">{busy === 'resume' ? 'Resuming…' : '⤳ Resume'}</button>{/if}
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
<ClaudeMdAudit bind:open={auditOpen} cwd={agent?.cwd || ''} />

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
  .dim2 { color: var(--color-text-tertiary); font-weight: 400; text-transform: none; letter-spacing: 0; }
  .gauges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; }
  .gauges .g { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); color: var(--color-text-secondary); white-space: nowrap; }
  .ctx { margin-top: 8px; }
  .ctx-top { display: flex; justify-content: space-between; font-size: 11px; color: var(--color-text-secondary); margin-bottom: 3px; }
  .bar { height: 6px; border-radius: 3px; background: var(--color-background-secondary); overflow: hidden; }
  .bar .fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
  .auditbtn { margin-top: 8px; width: 100%; padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 11px;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .auditbtn:hover { color: var(--color-text-primary); border-color: var(--color-text-tertiary); }
  .compact-cta { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 9px 11px;
    background: #F59E0B14; border: 0.5px solid #F59E0B55; border-radius: var(--border-radius-md, 8px); }
  .compact-cta .cc-txt { flex: 1; font-size: 11.5px; line-height: 1.45; color: var(--color-text-secondary); }
  .compact-cta .cc-btn { flex-shrink: 0; padding: 6px 12px; border-radius: 6px; cursor: pointer;
    background: #F59E0B; border: none; color: #1a1a1a; font-size: 12px; font-weight: 600; }
  .compact-cta .cc-btn:hover { opacity: 0.88; }
  .proc { display: flex; align-items: center; gap: 7px; margin-top: 5px; }
  .proc .pn { font-size: 12px; font-weight: 600; color: var(--color-text-primary); }
  .proc .pp { font-size: 10px; color: var(--color-text-tertiary); }
  .proc .pport { font-size: 10px; font-family: var(--font-mono); padding: 1px 6px; border-radius: 999px; background: #10B9811a; color: #10B981; text-decoration: none; cursor: pointer; white-space: nowrap; }
  .proc .pport:hover { background: #10B98133; text-decoration: underline; }
  .proc .pu { font-size: 10px; color: var(--color-text-tertiary); margin-left: auto; }
  .proc .pk { flex-shrink: 0; padding: 2px 9px; border-radius: 5px; cursor: pointer; font-size: 11px; font-weight: 600;
    background: #EF44441a; border: 0.5px solid #EF444455; color: #EF4444; }
  .proc .pk:hover { background: #EF4444; color: #fff; }
  .logs { margin: 0; padding-left: 16px; font-family: var(--font-mono); font-size: 10px; color: var(--color-text-secondary); }
  .chips { flex-direction: row; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 10px; background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary);
    border-radius: 99px; padding: 3px 8px; color: var(--color-text-secondary); }
  .attach { display: flex; align-items: center; gap: 8px; padding: 5px; border-radius: 8px;
    background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary); }
  .attach img { width: 40px; height: 40px; object-fit: cover; border-radius: 5px; flex-shrink: 0; }
  .atxt { font-size: 10px; color: var(--color-text-secondary); flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ax { background: none; border: none; cursor: pointer; color: var(--color-text-tertiary); font-size: 12px; }
  .convo-toggle { float: right; font-size: 10px; padding: 1px 7px; border-radius: 5px; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-secondary); }
  .convo-toggle:hover { border-color: var(--accent, #6366F1); }
  .convo { margin-top: 8px; max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;
    padding: 8px; border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); background: var(--color-background-secondary); }
  .turn { display: flex; flex-direction: column; max-width: 88%; }
  .turn.user { align-self: flex-end; align-items: flex-end; }
  .turn.assistant { align-self: flex-start; align-items: flex-start; }
  .turn .bub { font-size: 11.5px; line-height: 1.45; padding: 6px 9px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .turn.user .bub { background: var(--accent, #6366F1); color: #fff; border-bottom-right-radius: 3px; }
  .turn.assistant .bub { background: var(--color-background-primary); color: var(--color-text-primary); border: 0.5px solid var(--color-border-tertiary); border-bottom-left-radius: 3px; }
  .turn .tools { font-size: 9.5px; color: var(--color-text-tertiary); font-family: var(--font-mono); margin-top: 2px; }
  .cempty { padding: 12px; text-align: center; }
  .convo-foot { font-size: 9.5px; color: var(--color-text-tertiary); margin-top: 4px; }

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
  .reply button.act.resume { color: var(--accent, #6366F1); border-color: color-mix(in srgb, var(--accent, #6366F1) 55%, transparent); }
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
  .await { border: 0.5px solid #F59E0B; background: color-mix(in srgb, #F59E0B 10%, var(--color-background-secondary));
    border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
  .await-h { font-size: 11px; font-weight: 700; color: #B7791F; }
  .await-msg { font-size: 12px; color: var(--color-text-primary); white-space: pre-wrap; }
  .await-note { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.45; }
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
