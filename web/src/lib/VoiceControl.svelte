<script>
  // "Hey Gander, start a session in WaivePulse and write a report on this."
  //
  // Hands-free control of the floor: an always-listening ear (the browser's own
  // speech recognition, no keys, no server), a wake word, one command, a spoken
  // answer, and the same client calls the buttons use. Anything that starts,
  // sends, stops or costs money is read back and waits for a "yes" first.
  import { onMount, onDestroy } from 'svelte';
  import { voiceAvailable } from './voice.js';
  import { speak as ttsSpeak, stopSpeaking, ttsAvailable } from './tts.js';
  import { soundOn, ttsVoice, ttsRate, voiceOn, voiceWake, voiceConfirm, voiceSpeak } from './stores.js';
  import { parse, stripWake, isYes, isNo, statusSentence, needsSentence, DEFAULT_WAKE } from './voice-intents.js';

  let { agents = [], selectedProject = '', onOpen, onFly, onLayout, onNewTask } = $props();

  let rec = null;                 // the SpeechRecognition instance
  let listening = $state(false);  // mic open
  let paused = false;             // we are speaking: do not hear ourselves
  let heard = $state('');         // interim transcript
  let line = $state('');          // last heard + reply, shown in the pill
  let lineAt = 0;
  let pending = $state(null);     // { mode: 'command'|'confirm'|'goal'|'project'|'text', intent, until }
  let menuOpen = $state(false);
  let wakeIn = $state('');
  let projects = $state([]);      // [{ name, path }] from /api/projects
  let err = $state('');

  const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  const wakeList = () => { const w = String($voiceWake || '').trim(); return w ? [w, ...DEFAULT_WAKE] : DEFAULT_WAKE; };

  // ── what the parser sees ──
  const sessionsCtx = () => agents.filter((a) => a.root).map((a) => ({
    id: a.id, sessionId: a.sessionId || String(a.id).replace(/^sess:/, ''), name: a.name || '', project: a.project || '', state: a.state || 'idle',
    needsYou: a.state === 'awaiting' || a.state === 'error' || !!a.perm, permId: a.perm && a.perm.requestId, awaitMsg: a.awaitMsg || '', cwd: a.cwd || '',
  }));
  const ctx = () => ({ projects, sessions: sessionsCtx(), currentProject: selectedProject || '' });

  async function loadProjects() {
    try { const r = await fetch('/api/projects'); const d = await r.json(); projects = (d.projects || []).map((p) => ({ name: p.name, path: p.path })); } catch (_) {}
  }

  // ── speaking back ──
  function say(text, then) {
    show('', text);
    if (!$voiceSpeak || !ttsAvailable || !text) { then && then(); return; }
    paused = true; stopRec();
    let finished = false;
    const done = () => { if (finished) return; finished = true; paused = false; if ($voiceOn) startRec(); then && then(); };
    const ok = ttsSpeak(text, { voiceName: $ttsVoice, rate: $ttsRate, onend: done, onerror: done });
    if (!ok) done();
    else setTimeout(done, Math.max(2500, text.length * 70));   // a synthesis that never reports its end must not keep the ear shut
  }
  function show(heardText, reply) {
    const parts = []; if (heardText) parts.push('“' + heardText + '”'); if (reply) parts.push(reply);
    line = parts.join('  →  '); lineAt = Date.now();
    setTimeout(() => { if (Date.now() - lineAt >= 7900) line = ''; }, 8000);
  }

  // ── the recognizer ──
  function startRec() {
    if (!SR || rec || paused) return;
    const r = new SR();
    r.lang = 'en-US'; r.continuous = true; r.interimResults = true;
    r.onresult = (e) => {
      let fin = '', interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) fin += t + ' '; else interim += t; }
      heard = interim.trim();
      if (fin.trim()) { heard = ''; onFinal(fin.trim()); }
    };
    r.onend = () => { rec = null; listening = false; if ($voiceOn && !paused) setTimeout(() => startRec(), 250); };   // Chrome stops after silence: keep the ear open
    r.onerror = (ev) => {
      const code = ev && ev.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') { err = 'Microphone blocked: allow it for this site in the address bar.'; $voiceOn = false; }
      else if (code === 'audio-capture') { err = 'No microphone found.'; $voiceOn = false; }
    };
    try { r.start(); rec = r; listening = true; err = ''; } catch (_) { rec = null; listening = false; }
  }
  function stopRec() { const r = rec; rec = null; listening = false; try { r && r.stop(); } catch (_) {} }

  // ── one final phrase ──
  function onFinal(text) {
    const now = Date.now();
    if (pending && now > pending.until) pending = null;
    if (pending) {
      const p = pending; pending = null;
      if (p.mode === 'confirm') {
        if (isYes(text)) return act(p.intent);
        if (isNo(text)) return say('Cancelled.');
        pending = { ...p, until: now + 8000 }; return say('Yes or no?');
      }
      if (p.mode === 'command') return handleCommand(text);
      if (p.mode === 'goal') return handleIntent(parse(`start a session${p.intent.project && !p.intent.project.current ? ' in ' + p.intent.project.name : ''} ${text}`, ctx()), text);
      if (p.mode === 'project') { const i = parse(`${p.intent.kind === 'queue' ? 'queue' : 'start a session'} in ${text} ${p.intent.goal}`, ctx()); return handleIntent(i, text); }
      if (p.mode === 'text') return handleIntent({ ...p.intent, text, needsConfirm: true, say: `Tell ${p.intent.session.name || p.intent.session.project}: ${text}?` }, text);
    }
    const { woke, rest } = stripWake(text, wakeList());
    if (!woke) return;                                   // room noise, not for us
    if (!rest) { pending = { mode: 'command', until: now + 8000 }; show(text, 'Yes?'); return say('Yes?'); }
    handleCommand(rest, text);
  }
  function handleCommand(cmd, raw) { handleIntent(parse(cmd, ctx()), raw || cmd); }

  function handleIntent(intent, raw) {
    show(raw, intent.say);
    if (intent.ask) { pending = { mode: intent.ask, intent, until: Date.now() + 10000 }; return say(intent.say); }
    if (intent.kind === 'none' || intent.kind === 'help') return say(intent.say);
    if (intent.kind === 'status') return say(statusSentence(sessionsCtx()));
    if (intent.kind === 'needs') return say(needsSentence(sessionsCtx()));
    if (intent.needsConfirm && $voiceConfirm) { pending = { mode: 'confirm', intent, until: Date.now() + 8000 }; return say(intent.say); }
    act(intent);
  }

  // ── doing it: the same calls the buttons make ──
  const post = async (path, body) => { try { return await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch (_) { return null; } };
  const cwdFor = (project) => {
    const name = project ? (project.current ? selectedProject : project.name) : selectedProject;
    const p = projects.find((x) => x.name === name) || (project && project.path ? project : null);
    return { name, cwd: p ? p.path : '' };
  };
  async function act(i) {
    switch (i.kind) {
      case 'start': {
        const { name, cwd } = cwdFor(i.project);
        if (!cwd) { if (onNewTask) onNewTask(i.goal); return say(`I could not find the folder for ${name || 'that project'}. I opened the new task form instead.`); }
        const r = await post('/api/launch', { cwd, prompt: i.goal });
        return say(r && (r.ok || r.dispatched) ? `Started in ${name}.` : `Could not start: ${(r && r.error) || 'the bridge did not answer'}.`);
      }
      case 'queue': {
        const { name, cwd } = cwdFor(i.project);
        if (!cwd) return say(`I could not find the folder for ${name || 'that project'}.`);
        const r = await post('/api/queue', { cwd, prompt: i.goal });
        return say(r && !r.error ? `Queued in ${name}.` : `Could not queue: ${(r && r.error) || 'the bridge did not answer'}.`);
      }
      case 'reply': { const r = await post('/api/command', { sessionId: i.session.sessionId, agentId: i.session.id, type: 'message', text: i.text }); return say(r && !r.error ? `Sent to ${i.session.name || i.session.project}.` : 'Could not send.'); }
      case 'stop': { const r = await post('/api/command', { sessionId: i.session.sessionId, agentId: i.session.id, type: 'stop', text: '' }); return say(r && !r.error ? `Stopping ${i.session.name || i.session.project}.` : 'Could not stop it.'); }
      case 'stop-all': {
        const running = sessionsCtx().filter((s) => s.state !== 'idle' && s.state !== 'done');
        await Promise.all(running.map((s) => post('/api/command', { sessionId: s.sessionId, agentId: s.id, type: 'stop', text: '' })));
        return say(running.length ? `Stopping ${running.length} session${running.length === 1 ? '' : 's'}.` : 'Nothing is running.');
      }
      case 'allow': case 'deny': { const r = await post('/api/permissions/answer', { sessionId: i.session.sessionId, requestId: i.session.permId, behavior: i.kind }); return say(r && !r.error ? i.say : 'That prompt is gone already.'); }
      case 'mute': case 'unmute': { const name = i.project.current ? selectedProject : i.project.name; await post('/api/mute', { project: name, muted: i.kind === 'mute' }); return say(i.say); }
      case 'mute-sound': $soundOn = false; return say(i.say);
      case 'unmute-sound': $soundOn = true; return say(i.say);
      case 'panel': onOpen && onOpen(i.panel); return say(i.say);
      case 'view': onLayout && onLayout(i.view); return say(i.say);
      case 'focus': { const a = agents.find((x) => x.id === i.session.id); if (a && onFly) onFly(a); return say(i.say); }
      default: return say(i.say || 'Done.');
    }
  }

  // ── on / off, push-to-talk ──
  function toggle() {
    if (!SR) return;
    if ($voiceOn) { $voiceOn = false; stopRec(); pending = null; stopSpeaking(); show('', 'Voice off.'); return; }
    $voiceOn = true; loadProjects(); startRec();
    show('', `Listening. Say “${wakeList()[0]}” then a command. Say “${wakeList()[0]} help” for the list.`);
  }
  // Hold "v" (outside a text field) to give one command without the wake word.
  function onKey(e) {
    if (e.key !== 'v' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    if (!SR || menuOpen) return;
    e.preventDefault();
    if (!projects.length) loadProjects();
    pending = { mode: 'command', until: Date.now() + 10000 };
    show('', 'Listening for one command…');
    if (!rec) startRec();
  }

  onMount(() => { if ($voiceOn && SR) { loadProjects(); startRec(); } });
  onDestroy(() => stopRec());
</script>

<svelte:window onkeydown={onKey} />

{#if voiceAvailable}
  <div class="vc">
    <button class="select ear" class:on={$voiceOn} class:hot={!!pending || !!heard} onclick={toggle} title={$voiceOn ? 'Voice control is on — click to turn off' : 'Voice control: say “hey Gander” then a command (or hold V)'} aria-pressed={$voiceOn} aria-label="Voice control">
      {$voiceOn ? '👂' : '🎙'}{#if $voiceOn}<span class="dot" class:live={listening}></span>{/if}
    </button>
    <button class="select caret" onclick={() => { menuOpen = !menuOpen; wakeIn = $voiceWake || ''; }} title="Voice settings" aria-label="Voice settings">▾</button>
    {#if menuOpen}
      <div class="menu" role="dialog" aria-label="Voice settings">
        <div class="h">🎙 Voice control</div>
        <label class="row"><input type="checkbox" checked={$voiceOn} onchange={toggle} /> Always listening (wake word)</label>
        <label class="row"><span>Wake word</span><input class="in" placeholder="hey gander" bind:value={wakeIn} onchange={() => ($voiceWake = wakeIn.trim())} /></label>
        <label class="row"><input type="checkbox" bind:checked={$voiceConfirm} /> Ask “yes?” before starting, sending, stopping or allowing</label>
        <label class="row"><input type="checkbox" bind:checked={$voiceSpeak} /> Speak answers aloud</label>
        <div class="hint"><b>Push-to-talk:</b> press <kbd>V</kbd> anywhere on the page and say one command, no wake word.</div>
        <div class="hint"><b>Try:</b> “start a session in WaivePulse and write a report on this” · “queue a task in SEO: audit the top leads” · “tell Moss to use the venv” · “allow” / “deny” · “stop Roy” · “what’s running” · “who needs me” · “open settings” · “show mosaic” · “mute SEO”.</div>
        <div class="hint">Recognition runs in your browser (Chrome and Edge do it in the cloud; Firefox has none). The mic stays open only while the ear is on. Answers use the voice picked under Settings.</div>
        {#if err}<div class="err">{err}</div>{/if}
      </div>
    {/if}
    {#if line || heard}
      <div class="pill" class:wait={!!pending}>{heard ? '… ' + heard : line}{#if pending && !heard}<span class="dim"> · {pending.mode === 'confirm' ? 'say yes or no' : 'listening'}</span>{/if}</div>
    {/if}
  </div>
{/if}

<style>
  .vc { position: relative; display: flex; align-items: center; gap: 2px; }
  .ear { position: relative; padding-right: 10px; }
  .ear.on { border-color: var(--accent, #6366F1); color: var(--color-text-primary); }
  .ear.hot { background: color-mix(in srgb, var(--accent, #6366F1) 18%, transparent); }
  .dot { position: absolute; right: 4px; top: 4px; width: 6px; height: 6px; border-radius: 50%; background: var(--color-text-tertiary); }
  .dot.live { background: #EF4444; animation: vcpulse 1.2s ease-in-out infinite; }
  @keyframes vcpulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); } 50% { box-shadow: 0 0 0 4px rgba(239, 68, 68, 0); } }
  .caret { padding: 4px 6px; }
  .menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 60; width: min(360px, 92vw); background: var(--color-background-primary, #fff); border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; text-align: left; }
  .menu .h { font-weight: 600; }
  .menu .row { display: flex; align-items: center; gap: 8px; }
  .menu .row .in { flex: 1 1 auto; min-width: 0; font: inherit; padding: 4px 6px; border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); background: var(--color-background-secondary, #f6f6f6); color: inherit; }
  .menu .hint { color: var(--color-text-tertiary); font-size: 11px; line-height: 1.4; }
  .menu kbd { border: 0.5px solid var(--color-border-tertiary); border-radius: 3px; padding: 0 4px; font-size: 10px; }
  .menu .err { color: #EF4444; font-size: 11px; }
  .pill { position: fixed; top: 58px; right: 12px; z-index: 55; pointer-events: none; max-width: min(520px, 90vw); background: var(--color-background-primary, #fff); border: 0.5px solid var(--color-border-tertiary); border-radius: 999px; box-shadow: 0 6px 18px rgba(0,0,0,.16); padding: 6px 12px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pill.wait { border-color: var(--accent, #6366F1); }
  .pill .dim { color: var(--color-text-tertiary); }
</style>
