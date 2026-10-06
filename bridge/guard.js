'use strict';
// bridge/guard.js — the danger guard.
//
// Gander's PreToolUse hook sees every shell command BEFORE it runs. A lot of
// people run Claude Code in bypass mode (no permission prompts at all), so a
// destructive command runs with nobody watching. The well-known agent accident
// is a routine cleanup with one stray target on the end:
//
//     rm -rf tests/ patches/ plan/ ~/
//
// Three harmless folders and then the whole home directory. So EVERY target is
// checked, not the first one. classify() names what a command would do; the
// bridge decides (policy()) whether to flag it on the tile or block it.
//
// FALSE POSITIVES ARE THE MAIN RISK. A guard that cries wolf gets switched off,
// and then it guards nothing. Agents grep for "rm -rf", echo "git reset --hard"
// into docs, and Select-String "DROP TABLE" across migrations all day — this
// repo's own source is full of those strings. So nothing here regex-matches the
// raw command line. The command is lexed like a shell would (quotes, escapes,
// comments, heredocs, $( ) substitution), cut into segments on && || ; | & and
// newlines, and a segment only matches when its FIRST real command word is the
// dangerous program. `grep -n "rm -rf" x` is a grep. Full stop.
//
// Zero dependencies, deterministic, and it never throws: a bug in the guard
// must not break the hook that every tool call goes through (fail open, null).

const MAX_DEPTH = 4;          // bash -c "sh -c '...'" nesting / $( $( ) ) — deeper is not a real command
const MAX_LEN = 200000;

// ── rules ────────────────────────────────────────────────────────────────────
const RULES = [
  // critical: the bridge blocks these by default
  { id: 'delete-root', level: 'critical', label: 'Deletes a whole drive, your home folder, or everything in this folder' },
  { id: 'git-force-push', level: 'critical', label: 'Force-pushes over (or deletes) main/master, rewriting shared history' },
  { id: 'git-reset-hard', level: 'critical', label: 'Throws away all uncommitted changes (git reset --hard)' },
  { id: 'git-clean', level: 'critical', label: 'Permanently deletes untracked files and folders (git clean)' },
  { id: 'git-discard', level: 'critical', label: 'Discards every uncommitted change in the repo' },
  { id: 'sql-drop', level: 'critical', label: 'Drops or empties a database, schema or table' },
  { id: 'disk-format', level: 'critical', label: 'Formats or wipes a disk' },
  { id: 'disk-overwrite', level: 'critical', label: 'Writes raw data straight over a disk device (dd)' },
  { id: 'shutdown', level: 'critical', label: 'Shuts down or restarts the computer' },
  { id: 'reg-delete-hklm', level: 'critical', label: 'Deletes machine-wide Windows registry keys (HKLM)' },
  { id: 'chmod-root', level: 'critical', label: 'Changes permissions or ownership across the whole system' },
  { id: 'user', level: 'critical', label: 'On your guarded list' },
  // warn: flagged on the tile, allowed by default
  { id: 'delete-recursive', level: 'warn', label: 'Deletes a folder and everything in it' },
  { id: 'git-force-push-branch', level: 'warn', label: 'Force-pushes a branch (rewrites its history)' },
  { id: 'git-clean-files', level: 'warn', label: 'Permanently deletes untracked files (git clean -f)' },
  { id: 'git-branch-delete', level: 'warn', label: 'Force-deletes a git branch, merged or not' },
  { id: 'git-stash-drop', level: 'warn', label: 'Throws away stashed changes' },
  { id: 'publish', level: 'warn', label: 'Publishes (or unpublishes) a package on a public registry' },
  { id: 'docker-prune', level: 'warn', label: 'Deletes Docker images, containers or volumes' },
  { id: 'db-reset', level: 'warn', label: 'Resets or wipes a development database' },
  { id: 'pipe-to-shell', level: 'warn', label: 'Runs a script straight from the internet' },
  { id: 'kill-by-name', level: 'warn', label: 'Kills every process with that name, not just one' },
];
const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

// ── lexer ────────────────────────────────────────────────────────────────────
// One pass, shell-faithful enough that quoted text is never mistaken for a
// command. Each segment carries its raw text (what the user sees in `match`),
// its words with quotes removed (what the rules read), whether it was piped
// into, and any heredoc / here-string body fed to its stdin.
const FLAVORS = {
  bash: { bs: true, bt: false, caret: false, sq: true, group: false, subst: true, amp: true, lt: true },
  ps: { bs: false, bt: true, caret: false, sq: true, group: true, subst: false, amp: false, lt: false },
  cmd: { bs: false, bt: false, caret: true, sq: false, group: false, subst: false, amp: true, lt: true },
};

function findClose(s, i, F) {
  const open = s[i], close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if ((F.bs && c === '\\') || (F.bt && c === '`') || (F.caret && c === '^')) { j++; continue; }
    if (F.sq && c === "'") { const e = s.indexOf("'", j + 1); if (e < 0) return -1; j = e; continue; }
    if (c === '"') { const e = skipDq(s, j, F); if (e < 0) return -1; j = e; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
  }
  return -1;
}
function skipDq(s, j, F) {
  for (let k = j + 1; k < s.length; k++) {
    const c = s[k];
    if ((F.bs && c === '\\') || (F.bt && c === '`')) { k++; continue; }
    if (c === '"') return k;
    if (c === '$' && s[k + 1] === '(' && (F.subst || F.group)) { const e = findClose(s, k + 1, F); if (e < 0) return -1; k = e; }
  }
  return -1;
}

function lex(cmd, flavor, depth) {
  const F = FLAVORS[flavor] || FLAVORS.bash;
  const s = String(cmd || '');
  const d = depth || 0;
  const segs = [], extra = [], docs = [];
  let cur, word, redir;
  const fresh = (pipe) => { cur = { raw: '', words: [], pipe, heredoc: '' }; word = null; redir = null; };
  fresh(false);
  // $( ), backticks, PowerShell ( ) { } blocks: their contents RUN, so they are
  // classified as segments of their own. `echo $(rm -rf /)` is an rm.
  const sub = (inner) => { if (d < MAX_DEPTH) extra.push(...lex(inner, flavor, d + 1)); };
  const add = (text, raw) => { word = (word === null ? '' : word) + text; cur.raw += raw === undefined ? text : raw; };
  const endWord = () => {
    if (word === null) return;
    if (redir) {
      // a redirect's target is not an argument: `rm -rf x 2>/dev/null` has one target
      if (redir === '<<' || redir === '<<-') docs.push({ seg: cur, delim: word, strip: redir === '<<-' });
      else if (redir === '<<<') cur.heredoc += word + '\n';
      redir = null;
    } else cur.words.push(word);
    word = null;
  };
  const endSeg = (pipeNext) => {
    endWord();
    cur.raw = cur.raw.trim();
    if (cur.raw || cur.words.length) segs.push(cur);
    fresh(pipeNext);
  };
  // Heredoc bodies are DATA unless the program reads them as code. Without
  // this, `cat > clean.sh <<'EOF'` with an rm line inside it would be an rm.
  const readDocs = (i) => {
    while (docs.length) {
      const doc = docs.shift();
      const lines = [];
      while (i < s.length) {
        const k = s.indexOf('\n', i);
        const end = k < 0 ? s.length : k;
        const line = s.slice(i, end).replace(/\r$/, '');
        i = k < 0 ? s.length : k + 1;
        if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break;
        lines.push(line);
      }
      doc.seg.heredoc += lines.join('\n') + '\n';
    }
    return i;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    // escapes: \ in bash, ` in PowerShell, ^ in cmd
    if ((F.bs && c === '\\') || (F.bt && c === '`') || (F.caret && c === '^')) {
      if (n === undefined) { if (c !== '^') add(c); i++; }
      else if (n === '\n') i += 2;
      else if (n === '\r' && s[i + 2] === '\n') i += 3;
      else { add(n, c + n); i += 2; }
      continue;
    }
    // PowerShell here-strings: @' ... '@ spanning lines; quotes inside are literal
    if (flavor === 'ps' && c === '@' && (n === "'" || n === '"') && /^[ \t]*\r?\n/.test(s.slice(i + 2, i + 66))) {
      const nl = s.indexOf('\n', i + 2);
      const rest = s.slice(nl);
      const m = new RegExp('\\r?\\n' + n + '@').exec(rest);
      if (!m) { add(rest.slice(1), s.slice(i)); i = s.length; }
      else { const end = nl + m.index + m[0].length; add(rest.slice(1, m.index), s.slice(i, end)); i = end; }
      continue;
    }
    if (F.sq && c === "'") {
      let j = i + 1, text = '';
      for (;;) {
        const k = s.indexOf("'", j);
        if (k < 0) { text += s.slice(j); j = s.length; break; }
        text += s.slice(j, k);
        if (flavor === 'ps' && s[k + 1] === "'") { text += "'"; j = k + 2; continue; }
        j = k + 1; break;
      }
      add(text, s.slice(i, j)); i = j; continue;
    }
    if (c === '"') {
      let j = i + 1, text = '';
      while (j < s.length) {
        const q = s[j];
        if (q === '"') { if (flavor === 'ps' && s[j + 1] === '"') { text += '"'; j += 2; continue; } break; }
        if (F.bs && q === '\\') {
          // inside bash double quotes a backslash only escapes $ ` " \ and newline;
          // "C:\Users\b" keeps its backslashes
          const e = s[j + 1];
          if (e !== undefined && '$`"\\\n'.includes(e)) { if (e !== '\n') text += e; j += 2; continue; }
          text += q; j++; continue;
        }
        if (F.bt && q === '`') { if (s[j + 1] !== undefined) text += s[j + 1]; j += 2; continue; }
        if ((F.subst || F.group) && q === '$' && s[j + 1] === '(') {
          const e = findClose(s, j + 1, F);
          if (e > 0) { sub(s.slice(j + 2, e)); text += s.slice(j, e + 1); j = e + 1; continue; }
        }
        if (F.subst && q === '`') {
          const e = s.indexOf('`', j + 1);
          if (e > 0) { sub(s.slice(j + 1, e)); text += s.slice(j, e + 1); j = e + 1; continue; }
        }
        text += q; j++;
      }
      add(text, s.slice(i, Math.min(j + 1, s.length))); i = j + 1; continue;
    }
    // bash $( ) and process substitution <( ) >( )
    if (F.subst && (c === '$' || c === '<' || c === '>') && n === '(') {
      const e = findClose(s, i + 1, F);
      if (e > 0) {
        sub(s.slice(i + 2, e));
        if (c !== '$') endWord();
        add(s.slice(i, e + 1));
        i = e + 1; continue;
      }
    }
    if (F.subst && c === '`') {
      const e = s.indexOf('`', i + 1);
      if (e > 0) { sub(s.slice(i + 1, e)); add(s.slice(i, e + 1)); i = e + 1; continue; }
    }
    // PowerShell ( ) $( ) @( ) { } @{ }: one word here, and its body classified on its own
    if (F.group && (c === '(' || c === '{' || ((c === '$' || c === '@') && n === '(') || (c === '@' && n === '{'))) {
      const at = c === '$' || c === '@' ? i + 1 : i;
      const e = findClose(s, at, F);
      if (e > 0) { sub(s.slice(at + 1, e)); add(s.slice(i, e + 1)); i = e + 1; continue; }
    }
    // bash/cmd subshell parens: grouping only — `(cd x && rm -rf y)` is two segments
    if (!F.group && (c === '(' || c === ')')) { endWord(); cur.raw += ' '; i++; continue; }
    // comments: `git log # rm -rf /` is a git log
    if (c === '#' && word === null && flavor !== 'cmd') { const k = s.indexOf('\n', i); i = k < 0 ? s.length : k; continue; }
    if (flavor === 'ps' && c === '<' && n === '#') { const k = s.indexOf('#>', i + 2); i = k < 0 ? s.length : k + 2; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); cur.raw += c; i++; continue; }
    if (c === '\n') { endSeg(false); i = readDocs(i + 1); continue; }
    if (c === ';') { endSeg(false); i++; continue; }
    if (c === '|') {
      if (n === '|') { endSeg(false); i += 2; continue; }
      endSeg(true); i += n === '&' ? 2 : 1; continue;
    }
    if (c === '&') {
      if (n === '&') { endSeg(false); i += 2; continue; }
      if (n === '>' && flavor !== 'ps') { endWord(); let j = i + 2; if (s[j] === '>') j++; redir = '>'; cur.raw += s.slice(i, j); i = j; continue; }
      if (F.amp) { endSeg(false); i++; continue; }
      endWord(); add('&'); endWord(); i++; continue;   // PowerShell call operator: `& "C:\x\git.exe" push`
    }
    if (c === '>' || (c === '<' && F.lt)) {
      if (word !== null && /^(\d+|\*)$/.test(word)) word = null;    // the 2 in 2>&1 is part of the operator
      else endWord();
      let j = i + 1, op = c;
      if (c === '<' && s[j] === '<') {
        op = '<<'; j++;
        if (s[j] === '<') { op = '<<<'; j++; } else if (s[j] === '-') { op = '<<-'; j++; }
      } else {
        if (s[j] === c) j++;
        if (s[j] === '&' || s[j] === '|') j++;
      }
      redir = op; cur.raw += s.slice(i, j); i = j; continue;
    }
    add(c); i++;
  }
  endSeg(false);
  return segs.concat(extra);
}

function splitSegments(cmd, shell) {
  const flavor = /^(ps|powershell|pwsh)$/i.test(String(shell || '')) ? 'ps' : String(shell || '') === 'cmd' ? 'cmd' : 'bash';
  try { return lex(String(cmd || '').slice(0, MAX_LEN), flavor, 0).map((x) => x.raw).filter(Boolean); } catch (_) { return [String(cmd || '')]; }
}

// ── the command word ─────────────────────────────────────────────────────────
// "git" from "C:\Program Files\Git\cmd\git.exe", "rm" from "/usr/bin/rm"
function norm(w) {
  let s = String(w).toLowerCase();
  const k = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (k >= 0 && k < s.length - 1) s = s.slice(k + 1);
  return s.replace(/\.(exe|cmd|bat|com)$/, '');
}

// Words that run the NEXT word as the command. Value-taking flags are listed so
// `sudo -u postgres psql` finds psql, not postgres.
const PREFIX = {
  sudo: ['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-D'], doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '--unset', '--chdir'], nice: ['-n'], exec: ['-a'],
  nohup: [], time: [], command: [], builtin: [], stdbuf: [],
  xargs: ['-I', '-n', '-P', '-d', '-L', '-s', '-a', '-E', '--max-args', '--max-procs', '--delimiter', '--arg-file'],
  npx: ['-p', '--package'], bunx: [], wsl: ['-d', '--distribution', '-u', '--user', '--cd'],
  then: [], do: [], else: [], elif: [], if: [], while: [], until: [], '!': [], '{': [], '&': [], '.': [],
};
function commandWords(words, flavor) {
  let i = 0, via = '';
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }                       // FOO=1 cmd
    if (flavor === 'ps' && /^\$[\w:]+$/.test(w) && words[i + 1] === '=') { i += 2; continue; }
    const p = norm(w);
    if (Object.prototype.hasOwnProperty.call(PREFIX, p)) {
      via = p; i++;
      while (i < words.length && words[i].length > 1 && words[i][0] === '-') {
        const f = words[i];
        i += PREFIX[p].includes(f) ? 2 : 1;
        if (f === '--') break;
      }
      continue;
    }
    break;
  }
  if (i >= words.length) return null;
  return { prog: norm(words[i]), args: words.slice(i + 1), via };
}

// ── wrappers: the command inside the command ─────────────────────────────────
const SH = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const PS_HOSTS = new Set(['powershell', 'pwsh', 'powershell_ise']);
function innerCommand({ prog, args }) {
  if (SH.has(prog)) {
    let c = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-o' || a === '+o') { i++; continue; }
      if (/^-[a-zA-Z]+$/.test(a)) { if (a.includes('c')) c = true; continue; }
      if (a.startsWith('--') || a.startsWith('+')) continue;
      return c ? { cmd: a, flavor: 'bash' } : null;
    }
    return null;
  }
  if (PS_HOSTS.has(prog)) {
    for (let i = 0; i < args.length; i++) {
      if (!/^[-/]/.test(args[i])) continue;
      const name = args[i].slice(1).toLowerCase();
      if (!name) continue;
      if ('command'.startsWith(name)) return { cmd: args.slice(i + 1).join(' '), flavor: 'ps' };
      // -EncodedCommand hides the script in base64 UTF-16; decode it rather than wave it through
      if (name === 'ec' || 'encodedcommand'.startsWith(name)) {
        try { return { cmd: Buffer.from(String(args[i + 1] || ''), 'base64').toString('utf16le'), flavor: 'ps' }; } catch (_) { return null; }
      }
      if ('file'.startsWith(name)) return null;
    }
    return null;
  }
  if (prog === 'cmd') {
    for (let i = 0; i < args.length; i++) if (/^\/\/?[ck]$/i.test(args[i])) return { cmd: args.slice(i + 1).join(' '), flavor: 'cmd' };
  }
  return null;
}

function upstream(segs, k) {
  const out = [];
  for (let j = k; j > 0 && segs[j].pipe; j--) out.push(segs[j - 1]);
  return out;
}

// ── targets ──────────────────────────────────────────────────────────────────
const CWD_TARGETS = new Set(['.', '*', '*.*', '.*', '..']);
const HOME_TARGETS = new Set([
  '~', '$home', '${home}', '$env:userprofile', '${env:userprofile}', '%userprofile%', '$env:homepath', '%homepath%',
  '$env:homedrive', '%homedrive%', '$env:systemdrive', '%systemdrive%', '$env:systemroot', '%systemroot%',
  '$env:windir', '%windir%', '$env:programfiles', '%programfiles%', '$env:appdata', '%appdata%',
  '$env:localappdata', '%localappdata%', '$env:onedrive', '%onedrive%',
]);
const SYS_DIR = /^\/(bin|boot|dev|etc|home|lib|lib32|lib64|libx32|opt|proc|root|sbin|srv|sys|usr|var|users|system|library|applications|private|mnt|media|snap)$/;
const DRV = '(?:[a-z]:|\\/[a-z]|\\/mnt\\/[a-z]|\\/cygdrive\\/[a-z])';
const DRIVE = new RegExp('^' + DRV + '$');                                   // C:  /c  /mnt/c
const DRIVE_SYS = new RegExp('^' + DRV + '\\/(?:windows|windows\\/system32|users|program files|program files \\(x86\\)|programdata)$');
const PROFILE = new RegExp('^(?:' + DRV + '?\\/users|\\/home)\\/[^/]+$');    // C:\Users\b  /c/Users/b  /home/b

// 'cwd' = this folder (., *, ..); 'root' = a drive, the system, or a home folder
function dangerKind(t) {
  let s = String(t).trim().replace(/\\/g, '/').toLowerCase().replace(/\/{2,}/g, '/');
  if (!s) return null;
  const abs = s.startsWith('/');
  for (;;) { const nx = s.replace(/\/(\*|\.|\.\*|\*\.\*)?$/, ''); if (nx === s) break; s = nx; }
  if (!s) s = abs ? '/' : '.';
  if (CWD_TARGETS.has(s) || /^(\.\.\/)+\.\.$/.test(s)) return 'cwd';
  if (s === '/' || HOME_TARGETS.has(s) || SYS_DIR.test(s) || DRIVE.test(s) || DRIVE_SYS.test(s) || PROFILE.test(s) || /^~[^/]*$/.test(s)) return 'root';
  return null;
}

// Clearing build output is the most common rm -rf there is. Flagging it would
// train people to ignore the flag — so these are silent, but ONLY when every
// target is one of them (dist build ~/ is not a build dir).
const SAFE_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '__pycache__', '.cache', 'out', 'target', 'tmp',
  '.svelte-kit', '.turbo', '.nuxt', '.pytest_cache', '.parcel-cache']);
function isBuildDir(t) {
  const s = String(t).trim().replace(/\\/g, '/').replace(/(\/\*)+$/, '').replace(/\/+$/, '');
  const abs = /^(\/|[a-z]:)/i.test(s);
  const parts = s.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..')) return false;
  if (/^[a-z]:$/i.test(parts[0])) parts.shift();
  if (abs && parts.length < 2) return false;          // /tmp is the system's, not a build dir
  return parts.length > 0 && SAFE_DIRS.has(parts[parts.length - 1].toLowerCase());
}

const isHklm = (t) => /^(?:registry::)?(?:hklm|hkey_local_machine)/i.test(String(t));
const shortFlags = (a) => /^-[a-zA-Z]+$/.test(a);

// ── checks: each returns a rule id, { id, text }, or null ────────────────────
// rm / del / rd / rmdir / Remove-Item / rimraf — one parser for all the flag
// styles, because agents write cmd-style `rd /s /q` inside PowerShell and
// unix-style `rm -rf` everywhere.
const DELETERS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'ri', 'remove-item', 'rimraf']);
const SLASH_FLAGS = new Set(['del', 'erase', 'rd', 'rmdir']);
const PS_PATH_PARAMS = new Set(['-path', '-literalpath', '-lp', '-pspath']);
const PS_VALUE_PARAMS = new Set(['-include', '-exclude', '-filter', '-erroraction', '-ea', '-credential', '-stream',
  '-warningaction', '-wa', '-informationaction', '-infa', '-errorvariable', '-ev', '-outvariable', '-ov', '-pipelinevariable', '-pv']);
function checkDelete({ prog, args, flavor, via }) {
  if (!DELETERS.has(prog)) return null;
  const slash = SLASH_FLAGS.has(prog);
  const psish = flavor === 'ps' || prog === 'remove-item' || prog === 'ri';
  const list = (a) => (psish ? a.split(',').map((x) => x.trim()).filter(Boolean) : [a]);
  let rec = prog === 'rimraf', force = prog === 'rimraf', noRoot = false, opts = true;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i], la = a.toLowerCase();
    if (opts && a === '--') { opts = false; continue; }
    if (opts && slash && /^\/[a-z]$/i.test(a)) { if (la === '/s') rec = true; if (la === '/q' || la === '/f') force = true; continue; }
    if (opts && a.length > 1 && a[0] === '-') {
      const name = la.split(':')[0];
      if (name === '--recursive') rec = true;
      else if (name === '--force') force = true;
      else if (name === '--no-preserve-root') noRoot = true;
      else if (/^-[fiIrRdv]+$/.test(a)) { if (/r/i.test(a)) rec = true; if (a.includes('f')) force = true; }
      else if (name.startsWith('-rec')) rec = true;
      else if (name.startsWith('-fo')) force = true;
      else if (PS_PATH_PARAMS.has(name)) {
        if (a.includes(':')) targets.push(...list(a.slice(a.indexOf(':') + 1)));
        else if (i + 1 < args.length) targets.push(...list(args[++i]));
      } else if (PS_VALUE_PARAMS.has(name) && !a.includes(':')) i++;   // -Include * is a filter, not a target
      continue;
    }
    targets.push(...list(a));
  }
  if (targets.some(isHklm)) return 'reg-delete-hklm';
  if (noRoot) return 'delete-root';
  if ((rec || force) && targets.some((t) => dangerKind(t))) return 'delete-root';
  if (!rec) return null;
  // `Get-ChildItem | Remove-Item -Recurse` / `... | xargs rm -rf`: targets arrive on stdin, unseen
  if (!targets.length) return psish || via === 'xargs' ? 'delete-recursive' : null;
  if (targets.every(isBuildDir)) return null;
  return 'delete-recursive';
}

function gitSub(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'].includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return { sub: a.toLowerCase(), rest: args.slice(i + 1) };
  }
  return null;
}
const PROTECTED = /^(main|master)$/i;
function gitPush(rest) {
  let plain = false, lease = false, wide = false, del = false, dry = false;
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') { pos.push(...rest.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const nm = a.split('=')[0];
      if (nm === '--force') plain = true;
      else if (nm === '--force-with-lease' || nm === '--force-if-includes') lease = true;
      else if (nm === '--all' || nm === '--mirror' || nm === '--branches') wide = true;
      else if (nm === '--delete') del = true;
      else if (nm === '--dry-run') dry = true;
      else if (['--repo', '--push-option', '--receive-pack', '--exec'].includes(nm) && !a.includes('=')) i++;
      continue;
    }
    if (shortFlags(a)) { if (a.includes('f')) plain = true; if (a.includes('d')) del = true; if (a.includes('n')) dry = true; if (a.endsWith('o')) i++; continue; }
    pos.push(a);
  }
  if (dry) return null;
  const refs = pos.slice(1).map((r) => {
    const plus = r.startsWith('+'), x = plus ? r.slice(1) : r, k = x.indexOf(':');
    return { plus, src: k >= 0 ? x.slice(0, k) : x, dest: (k >= 0 ? x.slice(k + 1) : x).replace(/^refs\/heads\//, '') };
  });
  if (refs.some((r) => PROTECTED.test(r.dest) && (del || r.src === ''))) return 'git-force-push';   // deleting main
  const forced = plain ? refs : refs.filter((r) => r.plus);
  // no branch named = whatever is checked out, which is main more often than anyone admits
  if (plain && (!refs.length || wide)) return 'git-force-push';
  if (forced.some((r) => PROTECTED.test(r.dest) || /^head$/i.test(r.dest))) return 'git-force-push';
  // --force-with-lease refuses to clobber work it hasn't seen: a flag, never a block
  if (plain || lease || forced.length) return 'git-force-push-branch';
  return null;
}
function gitClean(rest) {
  let force = false, dirs = false, dry = false, inter = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') break;
    if (a === '--force') force = true;
    else if (a === '--dry-run') dry = true;
    else if (a === '--interactive') inter = true;
    else if (a === '--exclude') i++;
    else if (shortFlags(a)) {
      if (a.includes('f')) force = true;
      if (/[dxX]/.test(a)) dirs = true;
      if (a.includes('n')) dry = true;
      if (a.includes('i')) inter = true;
      if (a.endsWith('e')) i++;
    }
  }
  if (!force || dry || inter) return null;
  return dirs ? 'git-clean' : 'git-clean-files';
}
const ALL_PATHS = /^(\.|\.\/|\.\\|\*|:\/|:\/\*|:\/\.|:\(top\)\.?)$/;
function gitCheckout(rest) {
  if (rest.some((a) => /^(-b|-B|--orphan|-p|--patch|--detach|-t|--track)$/.test(a) || /^--orphan=/.test(a))) return null;
  const dd = rest.indexOf('--');
  const paths = dd >= 0 ? rest.slice(dd + 1) : rest.filter((a) => !a.startsWith('-'));
  if (paths.some((p) => ALL_PATHS.test(p))) return 'git-discard';
  if (dd < 0 && !paths.length && rest.some((a) => a === '-f' || a === '--force')) return 'git-discard';
  return null;
}
function gitRestore(rest) {
  let staged = false, wt = false, patch = false, opts = true;
  const paths = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (opts && a === '--') { opts = false; continue; }
    if (opts && a.startsWith('-')) {
      if (a === '--staged') staged = true;
      else if (a === '--worktree') wt = true;
      else if (a === '--patch') patch = true;
      else if (a === '--source' || a === '-s') i++;
      else if (shortFlags(a)) { if (a.includes('S')) staged = true; if (a.includes('W')) wt = true; if (a.includes('p')) patch = true; if (a.endsWith('s')) i++; }
      continue;
    }
    paths.push(a);
  }
  if (patch || (staged && !wt)) return null;          // --staged alone only unstages; nothing is lost
  return paths.some((p) => ALL_PATHS.test(p)) ? 'git-discard' : null;
}
function gitBranch(rest) {
  let D = false, del = false, f = false;
  for (const a of rest) {
    if (a === '--delete') del = true;
    else if (a === '--force') f = true;
    else if (shortFlags(a)) { if (a.includes('D')) D = true; if (a.includes('d')) del = true; if (a.includes('f')) f = true; }
  }
  return D || (del && f) ? 'git-branch-delete' : null;   // plain -d refuses unmerged branches: fine
}
function checkGit({ prog, args }) {
  if (prog !== 'git') return null;
  const g = gitSub(args);
  if (!g) return null;
  switch (g.sub) {
    case 'push': return gitPush(g.rest);
    case 'reset': return g.rest.includes('--hard') ? 'git-reset-hard' : null;
    case 'clean': return gitClean(g.rest);
    case 'checkout': return gitCheckout(g.rest);
    case 'restore': return gitRestore(g.rest);
    case 'branch': return gitBranch(g.rest);
    case 'stash': return /^(drop|clear)$/i.test(g.rest[0] || '') ? 'git-stash-drop' : null;
    default: return null;
  }
}

// SQL only counts when it is headed for a database client — `Select-String
// "DROP TABLE" *.sql` reads migrations, it doesn't run them.
const SQL_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlite', 'sqlcmd', 'duckdb', 'clickhouse-client', 'cockroach', 'mysqlsh', 'usql', 'invoke-sqlcmd']);
const REMOTE_WRAPPERS = new Set(['docker', 'podman', 'kubectl', 'oc', 'ssh', 'wsl', 'heroku', 'fly', 'flyctl', 'railway']);
const DESTRUCTIVE_SQL = /\bdrop\s+(?:table|database|schema)\b|\btruncate\s+(?:table\s+)?[\w"`[]/i;
function checkSql({ prog, args, seg, segs, k }) {
  if (prog === 'dropdb') return 'sql-drop';
  const client = SQL_CLIENTS.has(prog) ||
    (REMOTE_WRAPPERS.has(prog) && args.some((a) => SQL_CLIENTS.has(norm(String(a).trim().split(/\s+/)[0]))));
  if (!client) return null;
  if (DESTRUCTIVE_SQL.test(args.join(' ')) || DESTRUCTIVE_SQL.test(seg.heredoc)) return 'sql-drop';
  for (const up of upstream(segs, k)) {          // echo "DROP TABLE x" | psql
    if (DESTRUCTIVE_SQL.test(up.raw) || DESTRUCTIVE_SQL.test(up.heredoc)) return { id: 'sql-drop', text: up.raw + ' | ' + seg.raw };
  }
  return null;
}
function checkDbReset({ prog, args }) {
  const a = args.map((x) => x.toLowerCase());
  if (prog === 'prisma' && ((a[0] === 'migrate' && a[1] === 'reset') || (a[0] === 'db' && a[1] === 'push' && a.includes('--force-reset')))) return 'db-reset';
  if ((prog === 'rails' || prog === 'rake') && a.some((x) => /^db:(drop|reset|purge)$/.test(x))) return 'db-reset';
  if (prog === 'php' && a[0] === 'artisan' && /^(migrate:(fresh|reset)|db:wipe)$/.test(a[1] || '')) return 'db-reset';
  if (/^(python[\d.]*|py)$/.test(prog) && /manage\.py$/.test(a[0] || '') && /^(flush|reset_db)$/.test(a[1] || '')) return 'db-reset';
  if (prog === 'supabase' && a[0] === 'db' && a[1] === 'reset') return 'db-reset';
  return null;
}

function isDevice(p) {
  const s = String(p).replace(/\\/g, '/').toLowerCase();
  if (/physicaldrive|harddisk\d/.test(s)) return true;
  return /^\/dev\//.test(s) && !/^\/dev\/(null|zero|full|random|urandom|stdout|stderr|stdin|tty|fd\/|shm\/)/.test(s);
}
function checkDisk({ prog, args }) {
  if (prog === 'format' && args.some((a) => /^[a-z]:\\?$/i.test(a))) return 'disk-format';
  if (prog === 'diskpart' || prog === 'mkfs' || prog.startsWith('mkfs.') ||
      ['format-volume', 'clear-disk', 'initialize-disk', 'remove-partition'].includes(prog)) return 'disk-format';
  if (prog === 'wipefs' && args.some((a) => a === '--all' || /^-[a-zA-Z]*a/.test(a))) return 'disk-format';
  // of=/dev/null is the everyday benchmark; only a real device counts
  if (prog === 'dd' && args.some((a) => /^of=/i.test(a) && isDevice(a.slice(3)))) return 'disk-overwrite';
  return null;
}
function checkPower({ prog, args }) {
  const a = args.map((x) => x.toLowerCase());
  if (prog === 'shutdown') {
    if (a.some((x) => x === '/a' || x === '-a' || x === '/?' || x === '--help') || (a.length === 1 && a[0] === '-c')) return null;   // abort / cancel
    return 'shutdown';
  }
  if (['reboot', 'poweroff', 'halt', 'restart-computer', 'stop-computer'].includes(prog)) return 'shutdown';
  if (prog === 'systemctl' && /^(poweroff|reboot|halt|kexec)$/.test(a.find((x) => !x.startsWith('-')) || '')) return 'shutdown';
  if ((prog === 'init' || prog === 'telinit') && /^[06]$/.test(a[0] || '')) return 'shutdown';
  return null;
}
function checkReg({ prog, args }) {
  if (prog === 'reg' && /^delete$/i.test(args[0] || '') && isHklm(args[1] || '')) return 'reg-delete-hklm';
  if ((prog === 'remove-itemproperty' || prog === 'rp') && args.some(isHklm)) return 'reg-delete-hklm';
  return null;
}
function checkPerms({ prog, args }) {
  if (!['chmod', 'chown', 'chgrp'].includes(prog)) return null;
  let rec = false;
  const pos = [];
  for (const a of args) {
    if (a === '--recursive') rec = true;
    else if (shortFlags(a)) { if (a.includes('R')) rec = true; }
    else if (!a.startsWith('--')) pos.push(a);
  }
  // `chmod -R 755 .` is a project fix-up; only the system/home counts
  return rec && pos.slice(1).some((t) => dangerKind(t) === 'root') ? 'chmod-root' : null;
}
// Kill-by-name is a lesson from this very machine: `taskkill /F /IM chrome.exe`
// meant to close one Playwright test browser and closed every Chrome window
// the user had open, with their work in them.
function checkKill({ prog, args, segs, k, flavor }) {
  const p = prog === 'spps' || (flavor === 'ps' && prog === 'kill') ? 'stop-process' : prog;
  if (p === 'taskkill') return args.some((a) => /^[/-]f$/i.test(a)) && args.some((a) => /^[/-]im$/i.test(a)) ? 'kill-by-name' : null;
  if (p === 'stop-process') {
    if (!args.some((a) => /^-f/i.test(a)) || args.some((a) => /^-id$/i.test(a))) return null;
    const byName = args.some((a) => /^-(n|na|nam|name|processname)(:|$)/i.test(a)) ||
      upstream(segs, k).some((u) => {
        const c = commandWords(u.words, flavor);
        return c && /^(get-process|gps|ps)$/.test(c.prog) && c.args.some((x) => !x.startsWith('-'));
      });
    return byName ? 'kill-by-name' : null;
  }
  if (p === 'pkill' || p === 'killall') return 'kill-by-name';
  return null;
}
function checkDocker({ prog, args }) {
  const nf = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^(--context|-c|--host|-H|--config)$/.test(a)) { i++; continue; }
    if (!a.startsWith('-')) nf.push(a.toLowerCase());
  }
  const vols = args.some((a) => a === '--volumes' || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(a));
  const seq = (x, y) => { const j = nf.indexOf(x); return j >= 0 && nf[j + 1] === y; };
  if (prog === 'docker' || prog === 'podman') {
    if (seq('system', 'prune') || seq('volume', 'prune')) return 'docker-prune';
    if (nf.includes('compose') && nf.includes('down') && vols) return 'docker-prune';
  }
  if (prog === 'docker-compose' && nf.includes('down') && vols) return 'docker-prune';
  return null;
}
function checkPublish({ prog, args }) {
  if (!['npm', 'pnpm', 'yarn', 'bun', 'cargo'].includes(prog)) return null;
  const nf = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^(--prefix|-C|--dir|--filter|-F|-w|--workspace|--cwd)$/.test(a)) { i++; continue; }
    if (!a.startsWith('-')) nf.push(a.toLowerCase());
  }
  if (nf[0] === 'publish' || nf[0] === 'unpublish' || (prog === 'yarn' && nf[0] === 'npm' && nf[1] === 'publish')) return 'publish';
  return null;   // `npm run publish` is the project's own script, not this rule
}
const FETCH = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const RUNS_STDIN = new Set([...SH, 'iex', 'invoke-expression', 'pwsh', 'powershell']);
function checkPipeShell({ prog, seg, segs, k, flavor }) {
  if (!RUNS_STDIN.has(prog)) return null;
  const ups = upstream(segs, k);
  if (ups.some((u) => { const c = commandWords(u.words, flavor); return c && FETCH.has(c.prog); })) {
    return { id: 'pipe-to-shell', text: ups.slice().reverse().map((u) => u.raw).concat(seg.raw).join(' | ') };
  }
  if ((prog === 'iex' || prog === 'invoke-expression') && /\b(irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring|curl|wget)\b/i.test(seg.raw)) return 'pipe-to-shell';
  if (/[<$]\(\s*(curl|wget)\b/i.test(seg.raw)) return 'pipe-to-shell';      // bash <(curl …)  sh -c "$(curl …)"
  return null;
}

const CHECKS = [checkDelete, checkGit, checkSql, checkDbReset, checkDisk, checkPower, checkReg, checkPerms, checkKill, checkDocker, checkPublish, checkPipeShell];

// ── classify ─────────────────────────────────────────────────────────────────
function hit(id, text, label) {
  const r = RULE_BY_ID.get(id);
  return { level: r.level, rule: id, label: label || r.label, match: String(text).slice(0, 200) };
}

function checkSegment(segs, k, flavor, opts, depth) {
  const seg = segs[k];
  const extra = Array.isArray(opts.extra) ? opts.extra : [];
  const low = seg.raw.toLowerCase();
  for (const x of extra) {
    const t = String(x == null ? '' : x).trim();
    if (t && low.includes(t.toLowerCase())) return hit('user', seg.raw, 'On your guarded list: ' + t);
  }
  const cw = commandWords(seg.words, flavor);
  if (!cw) return null;
  // a dry run is the careful version of the command — never flag the care
  if (cw.args.some((a) => /^--dry-run(=|$)/i.test(a) || /^-whatif(:\$true)?$/i.test(a))) return null;
  const inner = innerCommand(cw);
  if (inner) { const r = classifyCommand(inner.cmd, inner.flavor, opts, depth + 1); if (r) return r; }
  if (seg.heredoc && (SH.has(cw.prog) || PS_HOSTS.has(cw.prog))) {        // bash <<EOF … : the body is the script
    const r = classifyCommand(seg.heredoc, SH.has(cw.prog) ? 'bash' : 'ps', opts, depth + 1);
    if (r) return r;
  }
  const ctx = { seg, segs, k, flavor, prog: cw.prog, args: cw.args, via: cw.via };
  let warn = null;
  for (const check of CHECKS) {
    const out = check(ctx);
    if (!out) continue;
    const h = typeof out === 'string' ? hit(out, seg.raw) : hit(out.id, out.text || seg.raw);
    if (h.level === 'critical') return h;
    if (!warn) warn = h;
  }
  return warn;
}

function classifyCommand(cmd, flavor, opts, depth) {
  if (depth > MAX_DEPTH) return null;
  const segs = lex(cmd, flavor, 0);
  let warn = null;
  for (let k = 0; k < segs.length; k++) {
    const r = checkSegment(segs, k, flavor, opts, depth);
    if (!r) continue;
    if (r.level === 'critical') return r;
    if (!warn) warn = r;
  }
  return warn;
}

function classify(toolName, toolInput, opts) {
  const t = String(toolName || '').toLowerCase();
  if (t !== 'bash' && t !== 'powershell') return null;
  const cmd = toolInput && typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!cmd.trim()) return null;
  try { return classifyCommand(cmd.slice(0, MAX_LEN), t === 'powershell' ? 'ps' : 'bash', opts || {}, 0); }
  catch (_) { return null; }
}

// mode: 'off' | 'flag' | 'critical' (default) | 'all'
function policy(classification, mode) {
  if (!classification) return 'allow';
  switch (mode) {
    case 'off': return 'allow';
    case 'flag': return 'flag';
    case 'all': return 'block';
    default: return classification.level === 'critical' ? 'block' : 'flag';
  }
}

module.exports = { classify, policy, splitSegments, RULES };
