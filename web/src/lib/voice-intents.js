// "Hey Gander, start a session in WaivePulse and write a report on this."
//
// The hands-free layer's grammar: a wake word, then one command. Pure functions,
// no DOM, so they are unit-tested with node. The component (VoiceControl.svelte)
// listens, calls parse(), speaks back, and runs the action through the same
// client calls the buttons use.
//
// Mishearings are the norm with a made-up word, so the wake list carries what
// browsers actually produce for "Gander" (gander, ganda, gandor, candor, gender).

export const DEFAULT_WAKE = ['hey gander', 'ok gander', 'okay gander', 'yo gander', 'hi gander', 'gander'];
const WAKE_VARIANTS = /\b(gander|ganda|gandor|gandah|candor|gender|gandr|ganders)\b/g;

export function normalize(s) {
  return String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Was the wake word said at the start? -> { woke, rest }
export function stripWake(text, wake = DEFAULT_WAKE) {
  const t = normalize(text).replace(WAKE_VARIANTS, 'gander');
  const list = (wake && wake.length ? wake : DEFAULT_WAKE).map(normalize).sort((a, b) => b.length - a.length);
  for (const w of list) {
    if (t === w) return { woke: true, rest: '' };
    if (t.startsWith(w + ' ')) return { woke: true, rest: t.slice(w.length + 1).replace(/^(please|can you|could you|would you|go ahead and)\s+/, '').trim() };
  }
  return { woke: false, rest: t };
}

const squash = (s) => normalize(s).replace(/[\s_-]+/g, '');

// Edit-distance similarity, 0..1: "wavepulse" vs "waivepulse" is 0.9.
export function similarity(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// How well a spoken phrase names a candidate: 4 exact, 3 prefix, 2 contains
// (only for short phrases, so a whole sentence never "contains" a project),
// 1 close in spelling (a mishearing). 0 otherwise.
function nameScore(spoken, name) {
  const q = squash(spoken), n = squash(name);
  if (!q || !n) return 0;
  if (n === q) return 4;
  if (n.startsWith(q) || (q.startsWith(n) && q.length <= n.length + 2)) return 3;   // a long phrase that merely begins with the name is not the name
  const words = normalize(spoken).split(' ').length;
  if (words <= 3 && (n.includes(q) || q.includes(n))) return 2;
  if (similarity(q, n) >= 0.8) return 1;
  return 0;
}

// The best project for what was said; null when nothing fits.
export function matchProject(spoken, projects = [], { strict = false } = {}) {   // strict: containment does not count (a span inside a sentence)
  const q = squash(spoken);
  if (!q) return null;
  if (/^(this|current|the current|selected|the selected)(project)?$/.test(q)) return { current: true };
  let best = null, score = 0;
  for (const p of projects) {
    const name = p.name || p.project || '';
    let s = nameScore(spoken, name);
    if (strict && s === 2) s = 0;
    if (s > score || (s === score && s && squash(name).length < squash(best.name || best.project || '').length)) { score = s; best = p; }
  }
  return score ? best : null;
}

// A session by spoken name or project: "waivepulse", "moss", "the waivepulse one".
export function matchSession(spoken, sessions = []) {
  const q = squash(String(spoken || '').replace(/\b(the|one|session|agent)\b/g, ' '));
  if (!q) return null;
  let best = null, score = 0;
  for (const s of sessions) {
    for (const cand of [s.name, s.project]) {
      const sc = nameScore(q, cand || '');
      if (sc > score) { score = sc; best = s; }
    }
  }
  return score ? best : null;
}

export const PANELS = {
  settings: 'config', config: 'config', configuration: 'config', usage: 'usage', cost: 'usage', costs: 'usage', spend: 'usage',
  queue: 'queue', 'task queue': 'queue', history: 'history', feed: 'feed', activity: 'feed', safety: 'safety', gpu: 'gpu',
  digest: 'digest', routines: 'routines', github: 'github', search: 'search', health: 'health', subagents: 'subagents',
  'sub agents': 'subagents', projects: 'projects', lessons: 'lessons', improvement: 'lessons',
};

const YES = /^(yes|yeah|yep|yup|go|go ahead|do it|confirm|confirmed|ok|okay|sure|correct|right|affirmative)( please)?$/;
const NO = /^(no|nope|cancel|never ?mind|stop|don'?t|negative|abort|forget it)( it| that)?$/;

export function isYes(text) { return YES.test(normalize(text)); }
export function isNo(text) { return NO.test(normalize(text)); }

const GOAL_LEAD = /^(and|to|that|then|with(?: the goal(?: of)?)?|about|on|for|saying|:)\s+/;

function splitProjectAndGoal(rest, projects) {
  // "in waivepulse and write a report" | "in wave pulse write a report" | "write a report in waivepulse"
  let m = /^(?:in|on|for|inside|at)\s+(.+)$/.exec(rest);
  if (m) {
    const words = m[1].split(' ');
    const stop = words.findIndex((w) => /^(and|to|that|then|with|about|saying|please|:)$/.test(w));
    for (let k = Math.min(4, stop > 0 ? stop : words.length); k >= 1; k--) {   // the longest leading span (before any connector) that names a project wins
      const p = matchProject(words.slice(0, k).join(' '), projects, { strict: k < words.length });
      if (p) return { project: p, goal: words.slice(k).join(' ').replace(GOAL_LEAD, '').trim() };
    }
  }
  const tail = /^(.+?)\s+(?:in|on|for)\s+(?:the\s+)?([a-z0-9 _-]{2,40})$/.exec(rest);
  if (tail) { const p = matchProject(tail[2], projects); if (p) return { project: p, goal: tail[1].replace(GOAL_LEAD, '').trim() }; }
  return { project: null, goal: rest.replace(GOAL_LEAD, '').trim() };
}

// One spoken command -> an intent the component can act on and speak back.
// ctx: { projects: [{name, cwd}], sessions: [{id, name, project, state, needsYou, permId}], currentProject: name|'' }
export function parse(command, ctx = {}) {
  const t = normalize(command);
  const projects = ctx.projects || [];
  const sessions = ctx.sessions || [];
  if (!t) return { kind: 'none', say: 'I did not catch a command.' };

  let m;
  // ── start a session ──
  if ((m = /^(?:start|launch|open|spin up|kick off|begin|create|make)(?: me)?(?: a| another| up a)?(?: new)?(?: claude)? (?:session|task|agent|job)(?:\s+(.*))?$/.exec(t)) || (m = /^new (?:session|task)(?:\s+(.*))?$/.exec(t))) {
    const { project, goal } = splitProjectAndGoal((m[1] || '').trim(), projects);
    if (!goal) return { kind: 'start', project, goal: '', needsConfirm: false, say: project && !project.current ? `What should the ${project.name} session do?` : 'What should the session do?', ask: 'goal' };
    const pname = project ? (project.current ? (ctx.currentProject || 'the current project') : project.name) : (ctx.currentProject || '');
    if (!pname) return { kind: 'start', project: null, goal, needsConfirm: false, ask: 'project', say: `Which project? You said: ${goal}` };
    return { kind: 'start', project, goal, needsConfirm: true, say: `Start a session in ${pname} to ${goal}?` };
  }
  // ── queue a task ──
  if ((m = /^(?:queue|cue|line up|add)(?: up)?(?: a)?(?: task| job)?(?:\s+(.*))$/.exec(t))) {
    const { project, goal } = splitProjectAndGoal(m[1].trim(), projects);
    const pname = project ? (project.current ? ctx.currentProject : project.name) : ctx.currentProject;
    if (!goal) return { kind: 'none', say: 'Queue what?' };
    if (!pname) return { kind: 'queue', project: null, goal, ask: 'project', say: `Which project should queue: ${goal}?` };
    return { kind: 'queue', project, goal, needsConfirm: true, say: `Queue in ${pname}: ${goal}?` };
  }
  // ── allow / deny the pending permission ──
  if (/^(?:allow|approve|permit|accept|let it|go ahead)(?: it| that| this| the (?:request|prompt|permission))?(?: once)?$/.test(t)) {
    const s = sessions.find((x) => x.permId);
    return s ? { kind: 'allow', session: s, needsConfirm: false, say: `Allowed for ${s.name || s.project}.` } : { kind: 'none', say: 'Nothing is waiting for permission.' };
  }
  if (/^(?:deny|reject|block|refuse|decline)(?: it| that| this| the (?:request|prompt|permission))?$/.test(t)) {
    const s = sessions.find((x) => x.permId);
    return s ? { kind: 'deny', session: s, needsConfirm: false, say: `Denied for ${s.name || s.project}.` } : { kind: 'none', say: 'Nothing is waiting for permission.' };
  }
  // ── stop ──
  if ((m = /^(?:stop|halt|cancel|kill|interrupt)(?:\s+(.*))?$/.exec(t))) {
    const who = (m[1] || '').replace(/^(the|session|agent)\s+/, '').trim();
    if (!who || /^(everything|all|all sessions|them all)$/.test(who)) return { kind: 'stop-all', needsConfirm: true, say: `Stop every running session?` };
    const s = matchSession(who, sessions);
    return s ? { kind: 'stop', session: s, needsConfirm: true, say: `Stop ${s.name || s.project}?` } : { kind: 'none', say: `I do not see a session called ${who}.` };
  }
  // ── reply / tell ──
  if ((m = /^(?:reply|respond|answer)(?: to)?(?:\s+(.*))?$/.exec(t)) || (m = /^(?:tell|say to|message)\s+(.*)$/.exec(t))) {
    let rest = (m[1] || '').trim();
    let session = null;
    // "tell waivepulse to use the venv" | "reply to moss yes do it" | "reply yes"
    const parts = /^(.+?)\s+(?:to|that|saying|with|:)\s+(.+)$/.exec(rest);
    if (parts) { const s = matchSession(parts[1], sessions); if (s) { session = s; rest = parts[2]; } }
    if (!session) { const w = /^([a-z0-9 _-]{2,30}?)\s+(.+)$/.exec(rest); if (w) { const s = matchSession(w[1], sessions); if (s && squash(w[1]).length >= 3) { session = s; rest = w[2]; } } }
    if (!session) { const waiting = sessions.filter((x) => x.needsYou); if (waiting.length === 1) session = waiting[0]; else if (sessions.length === 1) session = sessions[0]; }
    if (!session) return { kind: 'none', say: waitingList(sessions) ? `Who should I tell? ${waitingList(sessions)}` : 'Which session?' };
    if (!rest) return { kind: 'reply', session, text: '', ask: 'text', say: `What should I tell ${session.name || session.project}?` };
    return { kind: 'reply', session, text: rest, needsConfirm: true, say: `Tell ${session.name || session.project}: ${rest}?` };
  }
  // ── status ──
  if (/^(?:status|what'?s (?:running|happening|going on|up)|how (?:are|is) (?:we|things|it) (?:doing|going)|report|give me a status|sitrep|summary)$/.test(t)) return { kind: 'status', say: '' };
  if (/^(?:who needs me|what needs me|anything (?:need|waiting|needs) ?(?:me|attention)?|who'?s waiting|what'?s waiting|needs you|what'?s blocked)$/.test(t)) return { kind: 'needs', say: '' };
  // ── mute ──
  if ((m = /^(un)?mute(?:\s+(.*))?$/.exec(t))) {
    const who = (m[2] || '').replace(/^(the|project)\s+/, '').trim();
    if (!who) return { kind: m[1] ? 'unmute-sound' : 'mute-sound', say: m[1] ? 'Alert sound on.' : 'Alert sound off.' };
    const p = matchProject(who, projects);
    return p ? { kind: m[1] ? 'unmute' : 'mute', project: p, say: `${m[1] ? 'Unmuted' : 'Muted'} ${p.current ? ctx.currentProject : p.name}.` } : { kind: 'none', say: `I do not see a project called ${who}.` };
  }
  // ── open a panel / view ──
  if ((m = /^(?:open|show|go to|bring up|display)(?: me)?(?: the)?\s+(.+?)(?: panel| view| page| tab)?$/.exec(t))) {
    const what = m[1].trim();
    if (/^(?:office|floor|office floor)$/.test(what)) return { kind: 'view', view: 'office', say: 'Office floor.' };
    if (/^mosaic$/.test(what)) return { kind: 'view', view: 'mosaic', say: 'Mosaic.' };
    if (/^(?:new task|task dialog)$/.test(what)) return { kind: 'start', project: null, goal: '', ask: 'goal', say: 'What should the session do?' };
    const key = Object.keys(PANELS).sort((a, b) => b.length - a.length).find((k) => what === k || what.startsWith(k + ' ') || what.endsWith(' ' + k));
    if (key) return { kind: 'panel', panel: PANELS[key], say: `Opening ${key}.` };
    const s = matchSession(what, sessions);
    if (s) return { kind: 'focus', session: s, say: `Showing ${s.name || s.project}.` };
    return { kind: 'none', say: `I do not know how to open ${what}.` };
  }
  if (/^(?:help|what can (?:i|you) (?:say|do))$/.test(t)) return { kind: 'help', say: 'Try: start a session in a project and a goal. Queue a task. Reply to a session. Allow or deny. Stop a session. Status. Who needs me. Open settings.' };
  return { kind: 'none', say: `I did not understand: ${t}. Say help for what I know.` };
}

function waitingList(sessions) {
  const w = sessions.filter((x) => x.needsYou).map((x) => x.name || x.project).filter(Boolean);
  return w.length ? w.join(', ') : '';
}

// What to say for a status request.
export function statusSentence(sessions = []) {
  const open = sessions.length;
  if (!open) return 'No sessions are open.';
  const by = {};
  for (const s of sessions) by[s.state || 'idle'] = (by[s.state || 'idle'] || 0) + 1;
  const parts = Object.entries(by).map(([k, n]) => `${n} ${k}`);
  const waiting = sessions.filter((x) => x.needsYou);
  return `${open} session${open === 1 ? '' : 's'} open: ${parts.join(', ')}.` + (waiting.length ? ` ${waiting.length} need${waiting.length === 1 ? 's' : ''} you: ${waiting.map((x) => x.name || x.project).join(', ')}.` : ' Nothing is waiting on you.');
}

export function needsSentence(sessions = []) {
  const w = sessions.filter((x) => x.needsYou);
  if (!w.length) return 'Nothing needs you right now.';
  return w.map((x) => `${x.name || x.project}${x.awaitMsg ? ': ' + String(x.awaitMsg).slice(0, 80) : ''}`).join('. ') + '.';
}
