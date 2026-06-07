// Hivemind — operator control panel.
//
// Adds a command bar to each SESSION (root) tile so you can talk to a running
// Claude Code agent from the dashboard:
//   • Send  -> queues a 'message' delivered when the agent next finishes a turn
//              (via its Stop hook return channel) — use it to give instructions
//              or ask a question.
//   • Stop  -> queues a 'stop' that denies the agent's next tool call, pausing it.
//
// Self-contained: polls /api/state, injects its own <style>, re-attaches across
// grid re-renders, and never throws into the page.
(function () {
  'use strict';

  function injectStyle() {
    if (document.getElementById('aoc-control-style')) return;
    const s = document.createElement('style');
    s.id = 'aoc-control-style';
    s.textContent = `
      .aoc-ctl { display:flex; gap:4px; width:100%; margin-top:6px; align-items:center; }
      .aoc-ctl-input {
        flex:1 1 auto; min-width:0; font-size:10px; padding:3px 6px;
        border:0.5px solid var(--color-border-tertiary); border-radius:var(--border-radius-md);
        background:var(--color-background-secondary); color:var(--color-text-primary);
        font-family:var(--font-sans);
      }
      .aoc-ctl-btn {
        font-size:10px; padding:3px 7px; border-radius:var(--border-radius-md);
        border:0.5px solid var(--color-border-secondary); cursor:pointer;
        background:var(--color-background-primary); color:var(--color-text-primary);
        white-space:nowrap;
      }
      .aoc-ctl-btn:hover { background:var(--color-background-secondary); }
      .aoc-ctl-btn.stop { color:#EF4444; border-color:#EF4444; }
      .aoc-ctl-pending {
        position:absolute; top:6px; left:8px; font-size:9px; font-weight:600;
        color:#92400E; background:#FFFBEB; border:0.5px solid #F59E0B;
        border-radius:99px; padding:1px 6px;
      }
      .aoc-ctl-flash { outline:2px solid #10B981 !important; }
    `;
    document.head.appendChild(s);
  }

  async function post(path, body) {
    try {
      const r = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await r.json();
    } catch (_) { return null; }
  }

  function attach(card, sessionId, label) {
    if (card.querySelector('.aoc-ctl')) { card._aocSid = sessionId; return; }
    card._aocSid = sessionId;

    const bar = document.createElement('div');
    bar.className = 'aoc-ctl';

    const input = document.createElement('input');
    input.className = 'aoc-ctl-input';
    input.type = 'text';
    input.placeholder = 'message / question…';

    const send = document.createElement('button');
    send.className = 'aoc-ctl-btn';
    send.textContent = 'Send';

    const stop = document.createElement('button');
    stop.className = 'aoc-ctl-btn stop';
    stop.textContent = 'Stop';

    const doSend = async () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      const sid = card._aocSid;
      const res = await post('/api/command', { sessionId: sid, type: 'message', text });
      if (res && res.ok) { input.value = ''; flash(card); }
    };

    send.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
    stop.addEventListener('click', async () => {
      const sid = card._aocSid;
      const res = await post('/api/command', { sessionId: sid, type: 'stop', text: input.value.trim() });
      if (res && res.ok) { input.value = ''; flash(card); }
    });

    bar.appendChild(input);
    bar.appendChild(send);
    bar.appendChild(stop);
    card.appendChild(bar);
  }

  function flash(card) {
    card.classList.add('aoc-ctl-flash');
    setTimeout(() => card.classList.remove('aoc-ctl-flash'), 600);
  }

  function setPending(card, n) {
    let pill = card.querySelector('.aoc-ctl-pending');
    if (n > 0) {
      if (!pill) {
        pill = document.createElement('div');
        pill.className = 'aoc-ctl-pending';
        card.appendChild(pill);
      }
      pill.textContent = n + ' queued';
    } else if (pill) {
      pill.remove();
    }
  }

  async function poll() {
    let data;
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      data = await r.json();
    } catch (_) { return; }
    const pending = (data && data.pending) || {};
    const agents = (data && data.agents) || [];
    for (const a of agents) {
      if (!a.root) continue;                       // only session roots are controllable
      const card = document.getElementById('card-' + a.id);
      if (!card) continue;
      const sid = a.sessionId || String(a.id).replace(/^sess:/, '');
      try {
        attach(card, sid, a.name);
        setPending(card, pending[sid] || 0);
      } catch (_) { /* never break the page */ }
    }
  }

  function start() {
    injectStyle();
    poll();
    setInterval(poll, 800);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
