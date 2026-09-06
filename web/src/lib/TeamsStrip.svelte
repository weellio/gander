<script>
  // Agent teams strip for the Mosaic view — one card per Claude Code agent team
  // (lead + teammates, their shared task list, and the last few inbox messages).
  // Data comes from the bridge, which reads ~/.claude/teams/<team>/config.json
  // and ~/.claude/tasks/<team>/*.json. Agent teams are an EXPERIMENTAL Claude
  // Code feature — the on-disk format may shift, so unknown shapes are flagged
  // (`unparsed`) rather than hidden. Purely read-only; nothing here writes back.
  let { teams = [] } = $props();

  // Expanded state keyed by team name so it survives list re-orders/refreshes.
  let expanded = $state({});
  const isOpen = (name) => !!expanded[name];
  function toggle(name) { expanded[name] = !expanded[name]; }

  const TASK_ICON = { pending: '⏳', in_progress: '▶', completed: '✅' };
  const taskIcon = (s) => TASK_ICON[s] || '•';

  // Last 5 messages across every member inbox, newest first.
  function recentMessages(team) {
    const out = [];
    for (const [member, list] of Object.entries(team.inboxes || {})) {
      for (const m of list || []) out.push({ ...m, to: m.to || member });
    }
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out.slice(0, 5);
  }
  function trunc(s, n = 140) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  function age(ts) {
    if (!ts) return '';
    const n = Number(ts);
    // Accept seconds or milliseconds.
    const ms = n < 1e12 ? n * 1000 : n;
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }
  const memberKey = (m, i) => m.agentId || m.name || i;
</script>

{#if teams.length}
  <div class="strip">
    <div class="sh">👥 Agent teams <span class="dim">· lead + teammates sharing a task list (experimental)</span></div>
    <div class="cards">
      {#each teams as t (t.name)}
        <div class="card" class:ended={t.ended}>
          <div class="ch">
            <b>{t.name}</b>
            {#if t.lead}<span class="leadchip" title="team lead">lead: {t.lead}</span>{/if}
            {#if t.ended}<span class="tag muted" title="the team was cleaned up; its task list is kept on disk">ended — task list kept</span>{/if}
            {#if t.unparsed}<span class="tag warn" title="the bridge could not fully parse this team's config.json">config format unknown</span>{/if}
            {#if t.updatedAt}<span class="when">{age(t.updatedAt)} ago</span>{/if}
            <button class="tog" onclick={() => toggle(t.name)} aria-expanded={isOpen(t.name)}
              title={isOpen(t.name) ? 'Hide tasks and messages' : 'Show tasks and messages'}>
              {isOpen(t.name) ? '▾ less' : '▸ more'}
            </button>
          </div>

          <div class="members">
            {#each (t.members || []) as m, i (memberKey(m, i))}
              <span class="chip" class:lead={m.lead} title={(m.agentId ? 'agent ' + m.agentId : m.name) + (m.status ? ' · ' + m.status : '')}>
                {#if m.lead}<span class="star" aria-label="lead">★</span>{/if}
                {m.name}
                {#if m.agentType}<span class="atype">{m.agentType}</span>{/if}
                {#if m.status}<span class="mstatus">{m.status}</span>{/if}
              </span>
            {/each}
          </div>

          <div class="counts">
            <span title="open tasks">📝 {t.open ?? 0} open</span>
            <span class="sep">·</span>
            <span title="completed tasks">✅ {t.done ?? 0} done</span>
            <span class="sep">·</span>
            <span title="inbox messages">✉ {t.messages ?? 0} messages</span>
          </div>

          {#if isOpen(t.name)}
            <div class="detail">
              <div class="dh">Tasks</div>
              {#if (t.tasks || []).length}
                <ul class="tasks">
                  {#each t.tasks as task (task.id)}
                    <li class="task {task.status}">
                      <span class="tic" aria-hidden="true">{taskIcon(task.status)}</span>
                      <span class="tsub" title={task.description || task.subject}>{task.subject}</span>
                      {#if task.owner}<span class="owner">{task.owner}</span>{/if}
                      {#if task.blockedBy && task.blockedBy.length}<span class="blocked" title="waits on these task ids">⛓ blocked by {task.blockedBy.join(', ')}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <div class="none">no tasks yet</div>
              {/if}

              <div class="dh">Recent messages</div>
              {#if recentMessages(t).length}
                <ul class="msgs">
                  {#each recentMessages(t) as m, i (m.ts + ':' + i)}
                    <li class="msg" class:unread={m.read === false}>
                      <span class="route"><b>{m.from || '?'}</b> → {m.to || '?'}{#if m.type}<span class="mtype">{m.type}</span>{/if}</span>
                      <span class="mtext">{trunc(m.text)}</span>
                      {#if m.ts}<span class="mage">{age(m.ts)}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <div class="none">no messages yet</div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .strip { margin-top: 16px; --tone: var(--accent, #6366F1); }
  .sh { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; color: var(--color-text-tertiary); margin-bottom: 8px; }
  .sh .dim { text-transform: none; letter-spacing: 0; font-weight: 400; }
  .cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  .card { min-width: 0; border: 0.5px solid color-mix(in srgb, var(--tone) 45%, transparent); border-radius: var(--border-radius-md);
    background: color-mix(in srgb, var(--tone) 4%, transparent); padding: 9px 11px; }
  .card.ended { opacity: 0.7; border-style: dashed; }

  .ch { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .ch b { font-size: 12px; color: var(--color-text-primary); }
  .leadchip { font-size: 10px; font-weight: 600; color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent);
    border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
  .tag { font-size: 9.5px; border-radius: 999px; padding: 1px 7px; white-space: nowrap; border: 0.5px solid transparent; }
  .tag.muted { color: var(--color-text-tertiary); border-color: var(--color-border-tertiary); }
  .tag.warn { color: #C9820A; background: #C9820A18; border-color: #C9820A44; }
  .when { font-size: 10px; color: var(--color-text-tertiary); margin-left: auto; white-space: nowrap; }
  .tog { font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer; white-space: nowrap;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .tog:hover { border-color: var(--tone); color: var(--color-text-primary); }

  .members { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--color-text-secondary); max-width: 100%;
    border: 0.5px solid var(--color-border-tertiary); border-radius: 999px; padding: 2px 7px; background: var(--color-background-primary); }
  .chip.lead { border-color: color-mix(in srgb, var(--tone) 60%, transparent); color: var(--color-text-primary);
    background: color-mix(in srgb, var(--tone) 10%, var(--color-background-primary)); }
  .star { color: var(--tone); font-size: 9px; }
  .atype { font-family: var(--font-mono); font-size: 9px; color: var(--color-text-tertiary);
    background: var(--color-background-secondary); border-radius: 4px; padding: 0 4px; }
  .mstatus { font-size: 9.5px; color: #10B981; font-style: italic; }

  .counts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; font-size: 10.5px; color: var(--color-text-secondary); }
  .sep { color: var(--color-text-tertiary); }

  .detail { margin-top: 8px; padding-top: 8px; border-top: 0.5px solid var(--color-border-tertiary); }
  .dh { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); margin: 6px 0 4px; }
  .dh:first-child { margin-top: 0; }
  .none { font-size: 10.5px; color: var(--color-text-tertiary); padding: 2px 0 4px; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }

  .task { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--color-text-secondary); min-width: 0; }
  .task.completed { opacity: 0.65; }
  .task.in_progress .tsub { color: var(--color-text-primary); font-weight: 600; }
  .tic { flex-shrink: 0; font-size: 11px; }
  .tsub { flex: 1 1 140px; min-width: 0; overflow-wrap: anywhere; }
  .owner { font-size: 9.5px; color: var(--color-text-secondary); border: 0.5px solid var(--color-border-tertiary); border-radius: 999px; padding: 0 6px; white-space: nowrap; }
  .blocked { font-size: 9.5px; color: #F59E0B; white-space: nowrap; }

  .msg { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--color-text-secondary); min-width: 0;
    padding: 3px 6px; border-radius: 6px; background: var(--color-background-secondary); }
  .msg.unread { box-shadow: inset 2px 0 0 var(--tone); }
  .route { white-space: nowrap; color: var(--color-text-tertiary); }
  .route b { color: var(--color-text-primary); font-weight: 600; }
  .mtype { font-family: var(--font-mono); font-size: 9px; margin-left: 4px; color: var(--color-text-tertiary); }
  .mtext { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; line-height: 1.4; }
  .mage { font-size: 9.5px; color: var(--color-text-tertiary); margin-left: auto; white-space: nowrap; }
</style>
