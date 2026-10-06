'use strict';
// Gander runbook: turn a solved Claude Code session into a clean, step-by-step
// hand-off for the person who has to implement the fix. Deterministic: no model
// calls, only what the transcript already says.
//
// Public API:  module.exports = { build, toMarkdown, toHtml }
//   async build(file, opts?) -> runbook
//     opts = { title, since, until }  (since/until: ISO string, ms number or Date)
//     runbook = { title, goal, project, cwd, branch, startedAt, endedAt,
//                 steps: [{ n, title, command, shell: 'bash'|'powershell', at }],
//                 filesChanged: [{ file, edits, created }],
//                 checks: [{ title, command, shell, passed? }],
//                 outcome, failedAttempts, truncated, toolCalls, empty }
//   toMarkdown(runbook) -> string
//   toHtml(runbook)     -> string (a complete, self-contained HTML document)
//
// What counts as a step: a Bash / PowerShell command that CHANGED something and
// SUCCEEDED. Read-only inspection (ls, cat, git status, Get-*, curl GET, ...) and
// passing test runs become "How it was verified" checks. Failed commands are left
// out and only counted. File edits (Edit / Write / MultiEdit / NotebookEdit) are
// aggregated per file instead of being listed as steps.
//
// Reading: the transcript is read in 1 MB chunks with setImmediate between them,
// so a 500 MB session never blocks the bridge. After MAX_TOOL_CALLS tool calls the
// runbook stops collecting (truncated: true) and only the outcome / end time are
// still tracked to the end of the file.
//
// Safety (toHtml): every session-derived string is HTML-escaped on the server; the
// Markdown copy rides in a <script type="application/json"> block with '<', '>',
// '&' and U+2028/9 escaped, so '</script' in a command cannot break out. CSP is
// inline-only and the page loads nothing external.

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const CHUNK = 1024 * 1024;
const MAX_TOOL_CALLS = 2000;
const MAX_CHECKS = 15;
const MAX_CHECK_POOL = 1000;
const TITLE_CAP = 100;
const GOAL_CAP = 600;
const OUTCOME_CAP = 1500;
const COMMAND_CAP = 2000;
const CHECK_CMD_CAP = 500;
const STEP_TITLE_CAP = 120;
const EMPTY_MSG = 'Nothing to hand off yet';

// ── Small helpers ────────────────────────────────────────────────────────────
function cap(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n - 1).replace(/\s+$/, '') + '…' : str;
}

/** One line, control-char-free, whitespace collapsed. */
function oneLine(s) {
  // eslint-disable-next-line no-control-regex
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Prose we generate or copy must not carry em-dashes (house rule for hand-offs). */
function noEm(s) {
  return String(s == null ? '' : s).replace(/[ \t]*\u2014[ \t]*/g, ' - ');
}

/** Multi-line prose: normalized newlines, no control chars, no runs of blank lines. */
function prose(s, n) {
  // eslint-disable-next-line no-control-regex
  let t = String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, ' ');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cap(noEm(t), n);
}

/** Like prose(), but a long text is cut at a paragraph, line or sentence end rather than mid-word. */
function proseCut(s, n) {
  const full = prose(s, Infinity);
  if (full.length <= n) return full;
  const head = full.slice(0, n - 3);
  const floor = Math.floor(n * 0.6);
  let cut = head.lastIndexOf('\n\n');
  if (cut < floor) cut = head.lastIndexOf('\n');
  if (cut < floor) { const m = head.match(/^[\s\S]*[.!?](?=\s)/); cut = m ? m[0].length : -1; }
  if (cut < floor) cut = head.lastIndexOf(' ');
  if (cut < floor) cut = head.length;
  let out = head.slice(0, cut).replace(/\s+$/, '');
  // never leave a code fence open
  if (((out.match(/^\s*```/gm) || []).length) % 2 === 1) out += '\n```';
  return out + '\n\n…';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON that is inert inside a <script> element. */
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function toMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
}

// ── Paths ────────────────────────────────────────────────────────────────────
function normPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  const gitBash = /^\/([a-zA-Z])(\/|$)/.exec(s);           // /d/Files/... -> d:/Files/...
  if (gitBash) s = gitBash[1] + ':' + s.slice(2);
  return s.replace(/\/+/g, '/').replace(/\/$/, '');
}

const WIN = (s) => /^[a-zA-Z]:/.test(s);

/** Relative to cwd (forward slashes) when inside it, else the path as written. */
function relTo(cwd, file) {
  const f = normPath(file);
  const c = normPath(cwd);
  if (c && f) {
    const ci = WIN(c) || WIN(f);
    const fa = ci ? f.toLowerCase() : f;
    const ca = ci ? c.toLowerCase() : c;
    if (fa === ca) return '.';
    if (fa.startsWith(ca + '/')) return f.slice(c.length + 1);
  }
  return String(file || '');
}

/** Throwaway files that are not part of the fix: scratchpads, temp dirs, Claude's own memory. */
function isScratch(file) {
  const f = normPath(file).toLowerCase();
  return /\/scratchpad(\/|$)/.test(f)
    || /\/temp\/claude\//.test(f)
    || /^\/tmp\//.test(f)
    || /\/appdata\/local\/temp\//.test(f)
    || /\/\.claude\/(projects\/[^/]+\/)?memory\//.test(f)
    || /\/\.claude\/plans\//.test(f);
}

// ── Shell command classification ─────────────────────────────────────────────
// A deliberately small, quote-aware splitter. It does not try to be a shell; it
// only needs to find each simple command's first word and any file redirect.
const NULL_TARGETS = new Set(['/dev/null', '$null', 'nul', 'null', '/dev/stderr', '/dev/stdout']);

/**
 * Heredoc bodies are data, not commands. Cut each body (and its terminator line)
 * out of the source; the tokenizer hands it to the segment that opened it.
 */
function cutHeredocs(src) {
  const bodies = [];
  let out = '';
  let rest = src;
  const re = /<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1/;
  for (let guard = 0; guard < 50; guard++) {
    const m = re.exec(rest);
    if (!m) break;
    const nl = rest.indexOf('\n', m.index);
    if (nl < 0) break;
    const tag = m[2];
    const after = rest.slice(nl + 1);
    const lines = after.split('\n');
    let k = 0;
    while (k < lines.length && lines[k].trim() !== tag) k++;
    bodies.push(lines.slice(0, k).join('\n'));
    out += rest.slice(0, nl + 1);
    rest = lines.slice(k + 1).join('\n');
  }
  return { src: out + rest, bodies };
}

function splitSegments(cmd) {
  const cut = cutHeredocs(String(cmd || ''));
  const bodies = cut.bodies;
  const src = cut.src.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const segs = [];
  let words = [], redirects = [], cur = '', has = false, heredoc = null;
  const pushWord = () => { if (has) words.push(cur); cur = ''; has = false; };
  const pushSeg = () => {
    pushWord();
    if (words.length || redirects.length) segs.push(heredoc != null ? { words, redirects, heredoc } : { words, redirects });
    words = []; redirects = []; heredoc = null;
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      cur += src.slice(i + 1, end); has = true; i = end + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') { if (src[j] === '\\' && j + 1 < n) j++; j++; }
      cur += src.slice(i + 1, Math.min(j, n)); has = true; i = j + 1; continue;
    }
    if (ch === '#' && !has) {                       // comment to end of line
      const j = src.indexOf('\n', i);
      i = j < 0 ? n : j; continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { pushWord(); i++; continue; }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      pushSeg(); i++; if ((ch === '|') && src[i] === '|') i++; continue;
    }
    if (ch === '&') {
      if (src[i + 1] === '&') { pushSeg(); i += 2; continue; }
      if (!has && words.length === 0) { i++; continue; }   // PowerShell call operator: & "x.exe"
      pushSeg(); i++; continue;                            // bash background
    }
    if (ch === '>') {
      // fd prefix such as 2> or *> belongs to the redirect, not to the words
      if (has && /^(\d|\*)$/.test(cur)) { cur = ''; has = false; } else pushWord();
      i++;
      if (src[i] === '>') i++;
      if (src[i] === '&') { i++; while (i < n && /[\d-]/.test(src[i])) i++; continue; } // 2>&1
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      let t = '';
      if (src[i] === '"' || src[i] === "'") {
        const q = src[i];
        const j = src.indexOf(q, i + 1);
        t = src.slice(i + 1, j < 0 ? n : j); i = j < 0 ? n : j + 1;
      } else {
        while (i < n && !/[\s;|&)]/.test(src[i])) t += src[i++];
      }
      redirects.push(t);
      continue;
    }
    if (ch === '<' && src[i + 1] === '<') {
      pushWord();
      const m = /^<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1/.exec(src.slice(i, i + 80));
      if (m) { i += m[0].length; heredoc = bodies.length ? bodies.shift() : ''; continue; }
      i += 2; continue;
    }
    if (ch === '<') { pushWord(); i++; continue; }
    // bash escapes such as \( \; \| are literal; a plain backslash (C:\path) is kept
    if (ch === '\\' && i + 1 < n && /[()[\]{};|&<>"' ]/.test(src[i + 1])) { cur += src[i + 1]; has = true; i += 2; continue; }
    cur += ch; has = true; i++;
  }
  pushSeg();
  return segs;
}

const READ_WORDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'findstr', 'sls',
  'gci', 'gc', 'gi', 'gp', 'gcm', 'gps', 'gsv', 'gwmi', 'echo', 'printf', 'pwd', 'which', 'where', 'whereis',
  'wc', 'stat', 'file', 'du', 'df', 'sort', 'uniq', 'cut', 'tr', 'jq', 'tree', 'less', 'more', 'column',
  'measure', 'select', 'ft', 'fl', 'ftable', 'netstat', 'ipconfig', 'ifconfig', 'tasklist', 'whoami', 'hostname',
  'nslookup', 'dig', 'host', 'ping', 'tracert', 'traceroute', 'pathping', 'tnc', 'systeminfo', 'printenv', 'date', 'ps', 'lsof',
  'uname', 'id', 'md5sum', 'sha1sum', 'sha256sum', 'diff', 'cmp', 'comm', 'basename', 'dirname', 'realpath', 'readlink',
  'nl', 'od', 'xxd', 'hexdump', 'strings', 'awk', 'gawk', 'sed', 'find', 'test', '[', '[[', 'ver', 'vol', 'query',
  'getmac', 'nbtstat', 'gpresult', 'driverquery', 'qwinsta', 'quser',
  'nvidia-smi', 'ffprobe', 'mediainfo', 'identify', 'exiftool', 'pdfinfo', 'sqlite3_analyzer', 'free', 'uptime', 'top', 'htop', 'env', '?', 'w', 'last', 'journalctl', 'dmesg',
]);
// PowerShell verbs that never change anything by convention
const READ_VERBS = /^(get|test|resolve|find|measure|select|format|compare|show|search|convertto|convertfrom|where|sort|group|split|join|out-string|out-host|out-null|write-host|write-output|write-verbose|write-information|read)-/;
const NEUTRAL_WORDS = new Set([
  'cd', 'chdir', 'set-location', 'sl', 'pushd', 'popd', 'push-location', 'pop-location', 'sleep', 'start-sleep',
  'true', 'false', ':', 'exit', 'return', 'export', 'set', 'unset', 'clear', 'cls', 'clear-host', 'fi', 'done', 'esac',
  'for', 'foreach', 'foreach-object', '%', 'in', 'function', 'param', 'begin', 'process', 'end', 'break', 'continue',
  'local', 'declare', 'setlocal', 'endlocal', 'chcp', 'wait', 'trap', 'shopt', 'set-strictmode', 'new-object', 'add-type',
]);
const LEAD_SKIP = new Set(['if', 'then', 'else', 'elif', 'elseif', 'do', 'while', 'until', '!', 'try', 'catch', 'finally', '-not', 'time', 'nohup', 'sudo', 'command', 'exec', 'builtin', 'call', 'cmd', '/c', 'cmd.exe', 'powershell', 'pwsh', '-command', '-c', '-noprofile', '-nologo']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-remote', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'show-ref', 'whatchanged', 'rev-list', 'name-rev', 'merge-base', 'check-ignore', 'help', 'version', '--version']);

const TEST_RE = /^(npm|pnpm|yarn|bun) (t|test|run test\S*)\b|^(jest|vitest|mocha|ava|tap|rspec|phpunit|pytest|py\.test|nosetests|tox)\b|^node (.* )?--test\b|^(python\d*|py) (-\S+ )*-m (pytest|unittest)\b|^(go|cargo|dotnet|mvn|gradle|gradlew|bun|deno|swift|mix|ctest) test\b|^invoke-pester\b|^playwright test\b|^(node|python|py|bun|deno|tsx|ts-node) (-\S+ )*\S*(tests?[\\/]|test_|_tests?\.|\.test\.|\.spec\.|run_?tests?)\S*\.(m?js|cjs|ts|py)(\s|$)/;
// "Run the test suite" / "Re-run unit tests" on a single script counts as a test run too
const RUN_TESTS_DESC = /^(re-?)?run\b.*\b(tests?|test suite|specs?|smoke tests?)\b/i;

function baseWord(w) {
  let s = String(w || '').replace(/^[(]+/, '');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (slash >= 0 && slash < s.length - 1) s = s.slice(slash + 1);
  s = s.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  if (/^python\d+(\.\d+)?$/.test(s)) s = 'python';
  if (s === 'gradlew') s = 'gradle';
  return s;
}

// An inline script (python -c / python - <<EOF / node -e) only counts as a change
// when its code visibly writes, deletes, spawns or sends something.
const WRITE_PY = /\.write(?:_text|_bytes|lines)?\(|\bopen\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]|\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|removedirs|system|chmod|symlink|link|truncate|startfile|kill)\b|\bshutil\.|\bsubprocess\.|\.(?:mkdir|unlink|touch|rmdir|symlink_to|hardlink_to|chmod)\(|\.rename\(|execute(?:many|script)?\(\s*(?:f|r)?['"]{1,3}\s*(?:insert|update|delete|create|drop|alter|replace|vacuum|pragma\s+\w+\s*=)|\.commit\(|\.save\(|\.dump\(|\brequests\.(?:post|put|patch|delete)|\burlopen\(|\burlretrieve\(|\.to_(?:csv|excel|json|parquet|sql)\(|\bsavefig\(|\bimwrite\(|\.(?:post|put|patch|delete)\(\s*['"]/i;
const WRITE_JS = /\b(?:writeFile|appendFile|createWriteStream|unlink|rmdir|rm|mkdir|rename|copyFile|symlink|truncate|chmod|execSync|execFileSync|spawn|spawnSync|fork)(?:Sync)?\s*\(|child_process|method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)|\.write\(/i;

function inlineBody(args, heredoc, flags) {
  for (let k = 0; k < args.length; k++) {
    if (flags.includes(String(args[k]).toLowerCase())) return String(args[k + 1] || '');
    if (!/^-/.test(args[k])) break;                       // a script path: not inline
  }
  if (heredoc != null && (args.length === 0 || args.every((a) => /^-/.test(a)))) return heredoc;
  return null;
}

/** curl is a check when it only GETs to the terminal; sending data or saving a file is a change. */
function curlKind(args) {
  let method = 'GET';
  for (let k = 0; k < args.length; k++) {
    const a = String(args[k]);
    if (/^--(data|data-\w+|form|form-string|json|upload-file|output|remote-name|remote-name-all|output-dir)(=|$)/.test(a)) return 'change';
    if (a === '--request' || a === '-X') { method = String(args[k + 1] || '').toUpperCase(); k++; continue; }
    if (/^--request=/.test(a)) { method = a.slice(10).toUpperCase(); continue; }
    if (/^-[A-Za-z]+/.test(a) && !/^--/.test(a)) {
      const flags = a.slice(1);
      const xi = flags.indexOf('X');
      if (xi >= 0) {
        const rest = flags.slice(xi + 1);
        method = (rest || String(args[k + 1] || '')).toUpperCase();
        if (!rest) k++;
        if (/[dFToO]/.test(flags.slice(0, xi))) return 'change';
        continue;
      }
      if (/[dFToO]/.test(flags)) return 'change';
    }
  }
  return method === 'GET' || method === 'HEAD' ? 'read' : 'change';
}

/** Classify one simple command: 'read' | 'test' | 'change' | 'neutral'. */
function classifySegment(seg) {
  for (const r of seg.redirects) {
    const t = String(r || '').trim().toLowerCase();
    if (t && !NULL_TARGETS.has(t)) return 'change';
  }
  let w = seg.words.slice();
  // a bare quoted phrase ("done: 3 files") is PowerShell printing a string
  if (w.length && /\s/.test(w[0]) && !/[\\/]/.test(w[0])) return 'neutral';
  // drop leading keywords, env assignments (FOO=1 cmd), npx / env shims
  for (;;) {
    if (!w.length) return 'neutral';
    const first = w[0];
    const b = baseWord(first);
    if (LEAD_SKIP.has(b)) { w.shift(); continue; }
    if (/^[A-Za-z_]\w*=/.test(first)) { w.shift(); continue; }
    if (b === 'npx' || b === 'bunx' || (b === 'env' && w.length > 1)) {
      w.shift();
      while (w.length && /^-/.test(w[0])) { if (/^-u$/.test(w[0])) w.shift(); w.shift(); }
      continue;
    }
    break;
  }
  const first = w[0];
  // PowerShell member access left over from "(expr).Prop"
  if (/^\.[A-Za-z_]/.test(first)) return 'neutral';
  // PowerShell variable work: `$x = <rhs>` classifies the rhs, a bare `$x.Prop` is neutral
  if (/^\$/.test(first) || /^\[/.test(first)) {
    const eq = w.findIndex((x, k) => x === '=' || (k === 0 && /^[$[][^=]*=$/.test(x)));
    if (eq >= 0 && eq < w.length - 1) return classifySegment({ words: w.slice(eq + 1), redirects: [], heredoc: seg.heredoc });
    return 'neutral';
  }
  const b = baseWord(first);
  const args = w.slice(1);
  const lower = args.map((a) => a.toLowerCase());
  const line = [b].concat(lower).join(' ');
  if (TEST_RE.test(line)) return 'test';
  if (NEUTRAL_WORDS.has(b)) return 'neutral';
  if (b === 'git') {
    // skip global options: -C <dir>, -c <k=v>, --no-pager, ...
    let si = 0;
    while (si < lower.length && /^-/.test(lower[si])) si += (lower[si] === '-c' || lower[si] === '--git-dir' || lower[si] === '--work-tree') ? 2 : 1;
    const sub = lower[si] || '';
    lower.splice(0, si);
    if (GIT_READ.has(sub)) return 'read';
    if (sub === 'branch') return lower.slice(1).every((a) => /^(-a|-r|-v|-vv|--all|--list|--show-current|--remotes|--verbose|--contains|--merged|--no-merged|-l)$/.test(a)) ? 'read' : 'change';
    if (sub === 'remote') return lower.length === 1 || /^(-v|show|get-url)$/.test(lower[1]) ? 'read' : 'change';
    if (sub === 'config') return lower.some((a) => /^(--get|--get-all|--list|-l|--get-regexp)$/.test(a)) ? 'read' : 'change';
    if (sub === 'tag') return lower.length === 1 || lower[1] === '-l' || lower[1] === '--list' ? 'read' : 'change';
    if (sub === 'stash') return lower[1] === 'list' || lower[1] === 'show' ? 'read' : 'change';
    if (sub === 'worktree') return lower[1] === 'list' ? 'read' : 'change';
    if (sub === 'reflog') return lower.length === 1 || lower[1] === 'show' ? 'read' : 'change';
    return 'change';
  }
  if (b === 'curl') return curlKind(args);
  if (b === 'wget') return 'change';
  if (b === 'invoke-webrequest' || b === 'iwr' || b === 'invoke-restmethod' || b === 'irm') {
    const mi = lower.indexOf('-method');
    const method = mi >= 0 ? lower[mi + 1] : 'get';
    if (method !== 'get' && method !== 'head') return 'change';
    return lower.some((a) => a === '-body' || a === '-outfile' || a === '-infile') ? 'change' : 'read';
  }
  if (b === 'node' || b === 'deno' || b === 'bun') {
    if (/^(-c|--check|-v|--version)$/.test(lower[0] || '')) return 'read';
    const body = inlineBody(args, seg.heredoc, ['-e', '--eval', '-p', '--print']);
    if (body != null) return WRITE_JS.test(body) ? 'change' : 'read';
    return 'change';
  }
  if (b === 'python' || b === 'py') {
    if (lower.length === 1 && /^(-v|--version|-0|-0p)$/.test(lower[0])) return 'read';
    const body = inlineBody(args, seg.heredoc, ['-c']);
    if (body != null) return WRITE_PY.test(body) ? 'change' : 'read';
    if (lower[0] === '-m' && lower[1] === 'pip' && /^(list|show|freeze|check|--version)$/.test(lower[2] || '')) return 'read';
    if (lower[0] === '-m' && lower[1] === 'py_compile') return 'read';
    if (lower[0] === '-m' && lower.length === 3 && /^(--version|-v)$/.test(lower[2])) return 'read';
    return 'change';
  }
  if (b === 'pip' || b === 'pip3') return /^(list|show|freeze|check|--version|-v)$/.test(lower[0] || '') ? 'read' : 'change';
  if (b === 'npm' || b === 'pnpm' || b === 'yarn') return /^(ls|list|view|info|outdated|-v|--version|root|bin|prefix|why|explain|search|doctor)$/.test(lower[0] || '') || (lower[0] === 'config' && lower[1] === 'get') || (lower[0] === 'audit' && !lower.includes('fix')) ? 'read' : 'change';
  if (b === 'sed') return lower.some((a) => /^-[a-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place=')) ? 'change' : 'read';
  if (b === 'find') return lower.some((a) => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok') ? 'change' : 'read';
  if (b === 'awk' || b === 'gawk') return /system\(|print\s*>/.test(args.join(' ')) ? 'change' : 'read';
  if (b === 'env') return 'read';
  if (b === 'sc' || b === 'sc.exe') return /^(query|queryex|qc|getdisplayname|getkeyname|qdescription|qfailure)$/.test(lower[0] || '') ? 'read' : 'change';
  if (b === 'reg') return /^(query|compare|export)$/.test(lower[0] || '') ? 'read' : 'change';
  if (b === 'net') return /^(view|statistics|config|accounts)$/.test(lower[0] || '') || ((lower[0] === 'user' || lower[0] === 'localgroup' || lower[0] === 'group' || lower[0] === 'share' || lower[0] === 'use' || lower[0] === 'session') && !lower.some((a) => /^\/(add|delete|del|active|expires|passwordchg)/.test(a)) && lower.filter((a) => !/^\//.test(a)).length <= 2) ? 'read' : 'change';
  if (b === 'netsh') return lower.includes('show') || lower.includes('dump') ? 'read' : 'change';
  if (b === 'docker' || b === 'podman' || b === 'kubectl') return /^(ps|images|logs|inspect|version|info|stats|top|get|describe|events|port|history|diff|config)$/.test(lower[0] || '') && !(b === 'kubectl' && lower[0] === 'config' && /^(set|use|delete)/.test(lower[1] || '')) ? 'read' : 'change';
  if (b === 'systemctl' || b === 'service') return /^(status|is-active|is-enabled|list-units|list-unit-files|show|cat)$/.test(lower[0] || lower[1] || '') ? 'read' : 'change';
  if (READ_WORDS.has(b)) return 'read';
  if (READ_VERBS.test(b)) return 'read';
  if (b === 'select-string' || b === 'get-childitem' || b === 'get-content') return 'read';
  return 'change';
}

/** Every simple command with its kind, plus the overall kind. */
function analyze(cmd) {
  const segs = splitSegments(cmd).map((s) => ({ ...s, kind: classifySegment(s) }));
  const kinds = segs.map((s) => s.kind);
  let kind = 'neutral';
  if (kinds.includes('change')) kind = 'change';
  else if (kinds.includes('test')) kind = 'test';
  else if (kinds.includes('read')) kind = 'read';
  return { kind, segs };
}

/** Whole command: 'change' wins, then 'test', then 'read'; nothing but noise is 'neutral'. */
function classifyCommand(cmd) {
  return analyze(cmd).kind;
}

// ── Titles for commands that came without a description ──────────────────────
const PATH_FLAGS = new Set(['-filepath', '-path', '-literalpath', '-name', '-uri', '-taskname', '-file', '-destination', '-servicename', '-displayname', '-processname']);
const GIT_ARG_SUBS = new Set(['checkout', 'switch', 'push', 'pull', 'merge', 'rebase', 'reset', 'clone', 'tag', 'branch', 'revert', 'cherry-pick', 'stash', 'restore', 'rm', 'mv']);

function displayExe(w) {
  let s = String(w || '').replace(/^[(]+/, '');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (slash >= 0 && slash < s.length - 1) s = s.slice(slash + 1);
  return s.replace(/\.(exe|cmd|bat|com)$/i, '');
}

function shortArg(a, cwd) {
  let s = String(a || '');
  if (!s || /^\$/.test(s) || /[\n\r]/.test(s)) return '';
  if (/^https?:\/\//i.test(s)) s = s.replace(/^https?:\/\//i, '');
  else if (/[\\/]/.test(s) && !(/^[^\\/:]/.test(s) && !/^[A-Za-z]:/.test(s) && s.length <= 44)) {   // relative paths read fine as they are
    const rel = cwd ? relTo(cwd, s) : s;
    s = rel !== s ? rel : (s.length > 40 || /\.(exe|cmd|bat|com|ps1|py|js|sh)$/i.test(s) ? displayExe(s) : s);
  }
  return s.length <= 44 ? s : '';
}

function skipLead(words) {
  const w = words.slice();
  for (;;) {
    if (!w.length) return w;
    const b = baseWord(w[0]);
    if (LEAD_SKIP.has(b) || /^[A-Za-z_]\w*=/.test(w[0])) { w.shift(); continue; }
    if (b === 'npx' || b === 'bunx') { w.shift(); while (w.length && /^-/.test(w[0])) w.shift(); continue; }
    if (b === 'env' && w.length > 1) {
      w.shift();
      while (w.length && (/^-/.test(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]))) { if (w[0] === '-u') w.shift(); w.shift(); }
      continue;
    }
    if (/^\$/.test(w[0]) || /^\[/.test(w[0])) {
      const eq = w.findIndex((x, k) => x === '=' || (k === 0 && /=$/.test(x)));
      if (eq >= 0 && eq < w.length - 1) { w.splice(0, eq + 1); continue; }
      return [];
    }
    return w;
  }
}

/** "git commit \"msg\"", "python fix.py", "Restart-Service Spooler", "npm run build"... */
function segLabel(seg, cwd) {
  const w = skipLead(seg.words);
  if (!w.length) return '';
  const exe = displayExe(w[0]);
  const b = baseWord(w[0]);
  const args = w.slice(1);
  if (b === 'git') {
    let si = 0;
    while (si < args.length && /^-/.test(args[si])) si += /^(-c|-C|--git-dir|--work-tree)$/.test(args[si]) ? 2 : 1;
    const sub = args[si] || '';
    const rest = args.slice(si + 1);
    if (sub === 'commit') {
      const mi = rest.findIndex((a) => /^-[a-z]*m$/i.test(a) || a === '--message');
      // the message's headline: up to the first aside, clause break or sentence end
      const msg = mi >= 0 ? oneLine(String(rest[mi + 1] || '').split(/\n/)[0]).split(/\s\(|;\s|\.\s/)[0] : '';
      return 'git commit' + (msg ? ' "' + cap(msg, 60) + '"' : '');
    }
    const arg = GIT_ARG_SUBS.has(sub) ? rest.find((a) => !/^-/.test(a)) : '';
    return ('git ' + sub + (arg && arg.length <= 40 ? ' ' + arg : '')).trim();
  }
  if (b === 'npm' || b === 'pnpm' || b === 'yarn' || b === 'bun') {
    const sub = args[0] || '';
    if (sub === 'run' || sub === 'run-script') return exe + ' run ' + (args[1] || '');
    if (/^(i|install|add|uninstall|remove|rm|ci|update|up)$/.test(sub)) {
      const pk = args.slice(1).filter((a) => !/^-/.test(a));
      return (exe + ' ' + sub + (pk.length ? ' ' + cap(pk.join(' '), 40) : '')).trim();
    }
    return (exe + ' ' + sub).trim();
  }
  if (b === 'python' || b === 'py' || b === 'node' || b === 'deno' || b === 'bun' || b === 'pwsh' || b === 'powershell') {
    const body = inlineBody(args, seg.heredoc, ['-c', '-e', '--eval', '-p', '--print']);
    if (body != null) {
      // name the file an inline edit targets: Path("x.py"), open('x.json', 'w'), writeFileSync('x')
      const m = /(?:Path|open|writeFileSync|writeFile|readFileSync|load_workbook)\(\s*r?(["'])([^"'\n]{1,120}?\.[A-Za-z0-9]{1,6})\1/.exec(body);
      const target = m ? shortArg(m[2], cwd) : '';
      if (seg.kind === 'change') return exe + (target ? ': edit ' + target : ' inline script');
      return exe + (target ? ': read ' + target : ' inline script');
    }
    const mi = args.indexOf('-m');
    if (mi >= 0 && args[mi + 1]) return exe + ' -m ' + args[mi + 1] + (args[mi + 2] && !/^-/.test(args[mi + 2]) && args[mi + 2].length <= 20 ? ' ' + args[mi + 2] : '');
    const script = args.find((a) => !/^-/.test(a));
    return exe + (script ? ' ' + displayExe(script) : '');
  }
  let arg = '';
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^-/.test(a)) {
      if (PATH_FLAGS.has(a.toLowerCase()) && args[k + 1]) { arg = shortArg(args[k + 1], cwd); if (arg) break; }
      continue;
    }
    // a value right after a PowerShell -Flag belongs to that flag (-Method Post, -Id 42)
    if (k > 0 && /^-[A-Za-z]/.test(args[k - 1]) && /^[A-Z]/.test(exe)) continue;
    arg = shortArg(a, cwd);
    if (arg) break;
  }
  return exe + (arg ? ' ' + arg : '');
}

function commandTitle(cmd, cwd) {
  const { segs } = analyze(cmd);
  let pick = segs.filter((s) => s.kind === 'change');
  if (!pick.length) pick = segs.filter((s) => s.kind !== 'neutral');
  const labels = [];
  for (const s of pick) {
    const l = segLabel(s, cwd);
    if (l && !labels.includes(l)) labels.push(l);
  }
  if (!labels.length) return shortCommand(cmd, cwd);
  // "git add" before a commit says nothing the commit does not
  if (labels.some((l) => l.startsWith('git commit'))) for (let k = labels.length - 1; k >= 0; k--) if (/^git add\b/.test(labels[k])) labels.splice(k, 1);
  const shown = labels.slice(0, 3).join(' + ') + (labels.length > 3 ? ' + …' : '');
  return cap(shown, 100);
}

/** Paths in a command that point into a throwaway scratch dir (the implementer will not have them). */
function scratchRefs(cmd) {
  const out = [];
  for (const s of splitSegments(cmd)) {
    for (const w of s.words) {
      if (/[\\/]/.test(w) && isScratch(w)) { const n = displayExe(w); if (!out.includes(n)) out.push(n); }
    }
  }
  return out;
}

// A description that says "I am only looking" makes the command a check, whatever it runs.
const CHECK_DESC = /^(check|checks|checking|show|shows|list|lists|read|reads|find|finds|inspect|inspects|look|looks|view|display|print|search|grep|count|verify|confirm|peek|preview|probe|measure|explore|examine|review|scan|diagnose|compare|query|locate|identify|detect|determine|get|dump|test|tests|smoke[- ]test|screenshot|capture a screenshot|take a screenshot|(?:playwright|browser|live)[- ]?(?:verify|check|test))\b/i;
const NOT_CHECK_DESC = /^check\s*-?\s*out\b|^checkout\b|^get\s+rid\b/i;

function descIsCheck(desc) {
  const d = String(desc || '').trim();
  return !!d && CHECK_DESC.test(d) && !NOT_CHECK_DESC.test(d);
}

// ── Command display ──────────────────────────────────────────────────────────
/** Drop a leading `cd <session cwd> &&` / `Set-Location <cwd>;`: the runbook header already says where. */
function stripCwdCd(cmd, cwd) {
  const s = String(cmd || '');
  const m = /^\s*(?:cd|set-location|sl|pushd)\s+(?:\/d\s+)?("([^"]*)"|'([^']*)'|([^\s;&|]+))\s*(?:&&|;|\r?\n)\s*/i.exec(s);
  if (!m) return s;
  const target = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
  const rest = s.slice(m[0].length);
  if (!rest.trim()) return s;
  if (cwd && relTo(cwd, target) === '.') return rest;
  return s;
}

/** A readable title for a command that came without a description. */
function shortCommand(cmd, cwd) {
  let s = stripCwdCd(cmd, cwd);
  s = s.split(/\r?\n/).find((l) => l.trim()) || s;
  s = oneLine(s);
  if (cwd) {
    const c = normPath(cwd);
    if (c.length >= 3) {
      const parts = c.split('/').filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const alts = [parts.join('[\\\\/]+')];
      if (/^[a-zA-Z]:$/.test(parts[0] || '')) alts.push('/' + parts[0][0] + '/' + parts.slice(1).join('/'));
      s = s.replace(new RegExp('(?:' + alts.join('|') + ')[\\\\/]+', 'gi'), '');
    }
  }
  return cap(s, 80);
}

/** Claude's description when there is one; otherwise a summary (steps) or the command's first line (checks). */
function cleanTitle(desc, cmd, cwd, literal) {
  let t = oneLine(desc);
  if (t) {
    t = noEm(t).replace(/[.:;]+$/, '').trim();
    t = t.charAt(0).toUpperCase() + t.slice(1);
    return cap(t, STEP_TITLE_CAP);
  }
  // a short one-liner check reads best as itself; anything longer gets summarized
  const one = stripCwdCd(cmd, cwd).trim();
  if (literal && one.length <= 80 && !/[\r\n]/.test(one) && !/<</.test(one)) return noEm(shortCommand(cmd, cwd)) || 'Command';
  return noEm(commandTitle(cmd, cwd)) || 'Command';
}

function cmdKey(cmd, cwd) {
  return oneLine(stripCwdCd(cmd, cwd)).toLowerCase();
}

// ── Prompt filtering ─────────────────────────────────────────────────────────
const HARNESS_BLOCK = /^\s*<(ide_[a-z_]+|system-reminder|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>\s*/;

/** Drop leading IDE / hook context blocks; whatever still starts with '<' is harness output. */
function stripHarness(s) {
  let t = String(s || '');
  for (let k = 0; k < 20 && HARNESS_BLOCK.test(t); k++) t = t.replace(HARNESS_BLOCK, '');
  return t.trim();
}

function promptText(j) {
  if (!j || j.type !== 'user' || j.isMeta || j.isCompactSummary || j.isSidechain || j.isVisibleInTranscriptOnly) return '';
  const m = j.message;
  if (!m || (m.role && m.role !== 'user')) return '';
  const c = m.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return '';
  // IDE clients send context blocks (<ide_opened_file>, <ide_selection>, ...) beside the typed text
  const blocks = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text) : [];
  const t = blocks.map((s) => stripHarness(s)).filter(Boolean).join('\n').trim();
  if (!t) return '';
  if (t[0] === '<') return '';                                    // <system-reminder>, <command-name>, <local-command..., <task-notification>
  if (/^\[(Request interrupted|Image|Pasted)/i.test(t)) return '';
  if (/^Caveat: The messages below were generated/i.test(t)) return '';
  if (/^This session is being continued from a previous conversation/i.test(t)) return '';
  return t;
}

// ── Build ────────────────────────────────────────────────────────────────────
function emptyRunbook(o) {
  return {
    title: o && o.title ? cap(noEm(oneLine(o.title)), TITLE_CAP) : 'Runbook',
    goal: '', project: '', cwd: '', branch: '',
    startedAt: null, endedAt: null,
    steps: [], filesChanged: [], checks: [],
    outcome: '', failedAttempts: 0, truncated: false, toolCalls: 0, empty: true,
  };
}

const SHELLS = { Bash: 'bash', PowerShell: 'powershell' };
const MEMORY_PATH = /\.claude[\\/]+(?:projects[\\/]+[^\\/\s'"]+[\\/]+)?memory(?:[\\/'"\s]|$)/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function newState(o) {
  return {
    o,
    since: toMs(o.since),
    until: toMs(o.until),
    cwd: '', branch: '', firstTs: null, lastTs: null,
    goal: '', lastPrompt: '', outcome: '',
    toolCalls: 0, truncated: false, failed: 0,
    pending: new Map(),        // tool_use id -> { name, input, at }
    steps: [],                 // { title, command, shell, at, key }
    checks: [],                // { title, command, shell, passed, key, seq }
    checkIdx: new Map(),       // key -> index into checks
    files: new Map(),          // abs path key -> { file, edits, created, order }
    readFiles: new Set(),
    seq: 0,
  };
}

function inWindow(st, ms) {
  if (st.since != null && ms < st.since) return false;
  if (st.until != null && ms > st.until) return false;
  return true;
}

function fileKey(p) {
  const n = normPath(p);
  return WIN(n) ? n.toLowerCase() : n;
}

function recordFile(st, filePath, edits, created) {
  if (!filePath || isScratch(filePath)) return;
  const key = fileKey(filePath);
  let f = st.files.get(key);
  if (!f) { f = { path: String(filePath), edits: 0, created: false, order: st.files.size }; st.files.set(key, f); }
  f.edits += edits;
  if (created && f.edits === edits) f.created = true;              // only a first touch can create
}

function addCheck(st, title, command, shell, passed, key) {
  const k = key + '|' + (passed ? 't' : 'c');
  const seq = ++st.seq;
  if (st.checkIdx.has(k)) { st.checks[st.checkIdx.get(k)].seq = seq; return; }
  if (st.checks.length >= MAX_CHECK_POOL) return;
  st.checkIdx.set(k, st.checks.length);
  const c = { title, command: cap(command, CHECK_CMD_CAP), shell, seq };
  if (passed) c.passed = true;
  st.checks.push(c);
}

function resolveTool(st, call, ok, resultLine, resultText) {
  const { name, input, at } = call;
  const inp = input && typeof input === 'object' ? input : {};
  if (SHELLS[name]) {
    const command = typeof inp.command === 'string' ? inp.command : '';
    if (!command.trim()) return;
    const shell = SHELLS[name];
    const desc = typeof inp.description === 'string' ? inp.description : '';
    const an = analyze(command);
    let kind = an.kind;
    if (kind === 'change' && RUN_TESTS_DESC.test(desc.trim()) && !/&&|;|\n/.test(stripCwdCd(command, st.cwd).trim())) kind = 'test';
    const isCheck = kind === 'read' || descIsCheck(desc);
    if (!ok) {
      // a grep that matched nothing "fails" too; only real attempts count
      if (kind === 'change' && !descIsCheck(desc)) st.failed++;
      else if (kind === 'test') st.failed++;
      return;
    }
    if (kind === 'neutral') return;
    if (MEMORY_PATH.test(command)) return;                        // Claude's own notes are not part of the fix
    const key = cmdKey(command, st.cwd);
    if (kind === 'test') { addCheck(st, cleanTitle(desc, command, st.cwd, true), stripCwdCd(command, st.cwd), shell, true, key); return; }
    if (isCheck) { addCheck(st, cleanTitle(desc, command, st.cwd, true), stripCwdCd(command, st.cwd), shell, false, key); return; }
    const step = { title: cleanTitle(desc, command, st.cwd), command: cap(stripCwdCd(command, st.cwd).replace(/\s+$/, ''), COMMAND_CAP), shell, at, key };
    const scratch = scratchRefs(command);
    if (scratch.length) step.note = 'Runs ' + scratch.slice(0, 3).join(', ') + ' from the original session\'s scratch folder, not from the project.';
    st.steps.push(step);
    // a test run chained onto a change ("patch && pytest") still proves something
    for (const s of an.segs) {
      if (s.kind !== 'test') continue;
      const label = segLabel(s, st.cwd);
      if (label) addCheck(st, label, skipLead(s.words).join(' '), shell, true, label.toLowerCase());
    }
    return;
  }
  if (!ok) return;
  if (EDIT_TOOLS.has(name)) {
    const fp = inp.file_path || inp.notebook_path || '';
    if (!fp) return;
    if (name === 'Write') {
      const tur = resultLine && resultLine.toolUseResult;
      let created;
      if (tur && typeof tur === 'object' && (tur.type === 'create' || tur.type === 'update')) created = tur.type === 'create';
      else if (/File created successfully/i.test(resultText)) created = true;
      else if (/has been (updated|overwritten)/i.test(resultText)) created = false;
      else created = !st.readFiles.has(fileKey(fp)) && !st.files.has(fileKey(fp));
      recordFile(st, fp, 1, created);
    } else if (name === 'MultiEdit') {
      recordFile(st, fp, Array.isArray(inp.edits) ? Math.max(1, inp.edits.length) : 1, false);
    } else {
      recordFile(st, fp, 1, false);
    }
  }
}

function foldLine(st, line) {
  // cheap pre-filter: only conversation lines matter
  const isA = line.indexOf('"assistant"') >= 0;
  const isU = line.indexOf('"user"') >= 0;
  if (!isA && !isU) {
    // a resumed / continued transcript may hold its opening prompt only in a bookkeeping line
    if (!st.lastPrompt && line.indexOf('"last-prompt"') >= 0) {
      try { const j = JSON.parse(line); if (j && j.type === 'last-prompt' && typeof j.lastPrompt === 'string') st.lastPrompt = stripHarness(j.lastPrompt); } catch (_) { /* ignore */ }
    }
    return;
  }
  // past the cap only the outcome (last assistant text) and the end time still move
  if (st.truncated && !(isA && line.indexOf('"text"') >= 0)) {
    const ti = line.indexOf('"timestamp":"');
    if (ti >= 0) {
      const ms = Date.parse(line.slice(ti + 13, ti + 50).split('"')[0]);
      if (Number.isFinite(ms) && inWindow(st, ms)) st.lastTs = ms;
    }
    return;
  }
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  if (!j || (j.type !== 'user' && j.type !== 'assistant')) return;
  if (j.isSidechain) return;                                        // sub-agent chatter lives in its own story
  const ms = toMs(j.timestamp);
  if ((st.since != null || st.until != null) && (ms == null || !inWindow(st, ms))) return;
  if (ms != null) { if (st.firstTs == null) st.firstTs = ms; st.lastTs = ms; }
  if (j.cwd && !st.cwd) st.cwd = String(j.cwd);
  if (j.gitBranch && j.gitBranch !== 'HEAD') st.branch = String(j.gitBranch);
  const content = j.message && j.message.content;

  if (j.type === 'assistant') {
    if (j.isApiErrorMessage || !Array.isArray(content)) return;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) { st.outcome = b.text; continue; }
      if (b.type !== 'tool_use' || st.truncated) continue;
      st.toolCalls++;
      if (st.toolCalls > MAX_TOOL_CALLS) { st.truncated = true; st.toolCalls = MAX_TOOL_CALLS; continue; }
      const name = String(b.name || '');
      if (name === 'Read' && b.input && b.input.file_path) st.readFiles.add(fileKey(b.input.file_path));
      if ((SHELLS[name] || EDIT_TOOLS.has(name)) && b.id) {
        st.pending.set(String(b.id), { name, input: b.input, at: ms != null ? new Date(ms).toISOString() : null });
      }
    }
    return;
  }

  // user line
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || b.type !== 'tool_result') continue;
      const id = String(b.tool_use_id || '');
      const call = st.pending.get(id);
      if (!call) continue;
      st.pending.delete(id);
      const text = textOf(b.content);
      const tur = j.toolUseResult;
      let ok = !b.is_error;
      if (ok && tur && typeof tur === 'object' && tur.interrupted) ok = false;
      if (ok && /^\[Request interrupted/i.test(text)) ok = false;
      if (ok && /^Exit code [1-9]\d*\b/.test(text)) ok = false;
      resolveTool(st, call, ok, j, text);
    }
  }
  if (!st.goal) {
    const p = promptText(j);
    if (p) st.goal = p;
  }
}

/** A prompt's first line as a title: whole if it fits, else the whole sentences that fit, else cut at a word. */
function titleFrom(line) {
  let s = line.trim().replace(/^\W+(?=\w)/, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length <= TITLE_CAP) return s.replace(/(\w)\.$/, '$1');
  const head = s.slice(0, TITLE_CAP);
  const re = /[.?!](?=\s)/g;
  let cut = -1, m;
  while ((m = re.exec(head))) if (m.index >= 20) cut = m.index;
  if (cut > 0) return s.slice(0, s[cut] === '.' ? cut : cut + 1);
  const sp = head.lastIndexOf(' ', TITLE_CAP - 2);
  return (sp >= 40 ? head.slice(0, sp) : head.slice(0, TITLE_CAP - 1)).replace(/[\s,;:]+$/, '') + '…';
}

function selectChecks(checks) {
  if (checks.length <= MAX_CHECKS) return checks.slice().sort((a, b) => a.seq - b.seq);
  // passing tests first, then the most recent inspections; show them in session order
  const tests = checks.filter((c) => c.passed).sort((a, b) => b.seq - a.seq).slice(0, MAX_CHECKS);
  const rest = checks.filter((c) => !c.passed).sort((a, b) => b.seq - a.seq).slice(0, MAX_CHECKS - tests.length);
  return tests.concat(rest).sort((a, b) => a.seq - b.seq);
}

function finish(st) {
  const o = st.o;
  const rb = emptyRunbook(o);
  rb.cwd = st.cwd;
  rb.project = st.cwd ? path.basename(normPath(st.cwd)) || st.cwd : '';
  rb.branch = st.branch;
  rb.startedAt = st.firstTs != null ? new Date(st.firstTs).toISOString() : null;
  rb.endedAt = st.lastTs != null ? new Date(st.lastTs).toISOString() : null;
  const goal = st.goal || (st.lastPrompt && st.lastPrompt[0] !== '<' ? st.lastPrompt : '');
  rb.goal = prose(goal, GOAL_CAP);
  const firstLine = oneLine((goal.split(/\r?\n/).find((l) => l.trim()) || ''));
  rb.title = o.title ? cap(noEm(oneLine(o.title)), TITLE_CAP) : (firstLine ? titleFrom(noEm(firstLine)) : (rb.project ? 'Runbook: ' + rb.project : 'Runbook'));

  // a command that ran more than once appears once, at its LAST successful run
  const last = new Map();
  st.steps.forEach((s, i) => last.set(s.key, i));
  rb.steps = st.steps
    .filter((s, i) => last.get(s.key) === i)
    .map((s, i) => {
      const out = { n: i + 1, title: s.title, command: s.command, shell: s.shell, at: s.at };
      if (s.note) out.note = s.note;
      return out;
    });

  rb.filesChanged = [...st.files.values()]
    .sort((a, b) => a.order - b.order)
    .map((f) => ({ file: relTo(st.cwd, f.path), edits: f.edits, created: f.created }));
  rb.checks = selectChecks(st.checks).map((c) => {
    const out = { title: c.title, command: c.command, shell: c.shell };
    if (c.passed) out.passed = true;
    return out;
  });
  rb.outcome = proseCut(st.outcome, OUTCOME_CAP);
  rb.failedAttempts = st.failed;
  rb.truncated = st.truncated;
  rb.toolCalls = st.toolCalls;
  rb.empty = !rb.steps.length && !rb.filesChanged.length && !rb.checks.length;
  return rb;
}

/** Read a transcript (JSONL) into a runbook without blocking the event loop. */
async function build(file, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const st = newState(o);
  const f = String(file || '');
  if (!f) return finish(st);
  let fh;
  try { fh = await fs.promises.open(f, 'r'); } catch (_) { return finish(st); }
  const decoder = new StringDecoder('utf8');
  const buf = Buffer.alloc(CHUNK);
  let tail = '';
  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (!bytesRead) break;
      const lines = (tail + decoder.write(buf.subarray(0, bytesRead))).split('\n');
      tail = lines.pop();
      for (const l of lines) if (l) foldLine(st, l);
      await new Promise((r) => setImmediate(r));
    }
    tail += decoder.end();
    if (tail.trim()) foldLine(st, tail);
  } catch (_) { /* unreadable mid-way: hand off what we have */ }
  finally { try { await fh.close(); } catch (_) { /* ignore */ } }
  return finish(st);
}

// ── Formatting shared by Markdown + HTML ────────────────────────────────────
function fmtDuration(ms) {
  if (!(ms > 0)) return '';
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm';
  return s + 's';
}

function fmtDate(iso) {
  const ms = toMs(iso);
  if (ms == null) return '';
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function metaParts(rb) {
  const parts = [];
  if (rb.project) parts.push(rb.project);
  if (rb.branch) parts.push(rb.branch);
  const date = fmtDate(rb.startedAt);
  if (date) parts.push(date);
  const dur = fmtDuration((toMs(rb.endedAt) || 0) - (toMs(rb.startedAt) || 0));
  if (dur) parts.push(dur);
  return parts.map((p) => noEm(oneLine(p)));
}

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

function footNotes(rb) {
  const out = [];
  if (rb.truncated) out.push('This runbook stops after the first ' + MAX_TOOL_CALLS + ' tool calls; the session went on past that.');
  const n = rb.failedAttempts || 0;
  if (n > 0) out.push(n === 1 ? '1 attempt that failed along the way is left out.' : n + ' attempts that failed along the way are left out.');
  return out;
}

function fileLine(f) {
  const bits = [];
  if (f.created) bits.push('created');
  if (!f.created || f.edits > 1) bits.push(plural(f.edits, 'edit'));
  return bits.join(', ');
}

function langOf(shell) { return shell === 'powershell' ? 'powershell' : 'bash'; }

// ── Markdown ─────────────────────────────────────────────────────────────────
function mdInline(s) {
  // intraword underscores (snake_case, file_names) never start emphasis, so leave them readable
  return String(s == null ? '' : s)
    .replace(/([`*[\]<>])/g, '\\$1')
    .replace(/(^|[^A-Za-z0-9])_|_(?=[^A-Za-z0-9]|$)/g, (m) => m.replace('_', '\\_'));
}

function mdCode(s) {
  const str = String(s == null ? '' : s);
  const runs = str.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(1, ...runs.map((r) => r.length + 1)));
  const pad = /^`|`$/.test(str) || fence.length > 1 ? ' ' : '';
  return fence + pad + str + pad + fence;
}

function mdFence(code, lang) {
  const str = String(code == null ? '' : code).replace(/\r\n?/g, '\n');
  const runs = str.match(/`{3,}/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return fence + lang + '\n' + str + '\n' + fence;
}

/** Claude's closing text is Markdown already; only stop its headings from outranking ours. */
function mdBody(s) {
  let inFence = false;
  return String(s || '').split('\n').map((l) => {
    if (/^\s*(`{3,}|~{3,})/.test(l)) { inFence = !inFence; return l; }
    if (inFence) return l;
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(l);
    return h ? '**' + h[1].replace(/\*+/g, '') + '**' : l;
  }).join('\n');
}

function toMarkdown(rb) {
  const r = rb && typeof rb === 'object' ? rb : emptyRunbook({});
  const out = [];
  out.push('# ' + mdInline(noEm(r.title || 'Runbook')));
  out.push('');
  const meta = metaParts(r);
  if (meta.length) { out.push(meta.map(mdInline).join(' · ')); out.push(''); }

  if (r.empty || (!(r.steps || []).length && !(r.filesChanged || []).length && !(r.checks || []).length)) {
    out.push('**' + EMPTY_MSG + '.**');
    out.push('');
    out.push('This session has no successful changes, file edits or checks to hand off.');
    if (r.goal) { out.push(''); out.push('## Goal'); out.push(''); out.push(quoteMd(r.goal)); }
    out.push('');
    return out.join('\n');
  }

  if (r.goal) { out.push('## Goal'); out.push(''); out.push(quoteMd(r.goal)); out.push(''); }

  out.push('## Steps');
  out.push('');
  if (!(r.steps || []).length) {
    out.push('No commands needed: the change is entirely in the files below.');
    out.push('');
  } else {
    for (const s of r.steps) {
      out.push(s.n + '. **' + mdInline(noEm(s.title)) + '**');
      out.push('');
      const indent = ' '.repeat(String(s.n).length + 2);           // list-item content column
      out.push(mdFence(s.command, langOf(s.shell)).split('\n').map((l) => indent + l).join('\n'));
      out.push('');
      if (s.note) { out.push(indent + '_Note: ' + mdInline(noEm(s.note)) + '_'); out.push(''); }
    }
  }

  if ((r.filesChanged || []).length) {
    out.push('## Files changed');
    out.push('');
    for (const f of r.filesChanged) out.push('- ' + mdCode(f.file) + ': ' + fileLine(f));
    out.push('');
  }

  if ((r.checks || []).length) {
    out.push('## How it was verified');
    out.push('');
    for (const c of r.checks) {
      // a one-line command is shown inline; a multi-line script's first line is noise, so only the title stays
      const full = String(c.command || '').trim();
      const cmd = /[\r\n]/.test(full) ? '' : (full.length > 140 ? full.slice(0, 139) + '…' : full);
      out.push('- ' + (c.passed ? '**Passed:** ' : '') + mdInline(noEm(c.title)) + (cmd && oneLine(cmd).toLowerCase() !== String(c.title).toLowerCase() ? ': ' + mdCode(cmd) : ''));
    }
    out.push('');
  }

  if (r.outcome) {
    out.push('## Outcome');
    out.push('');
    out.push(mdBody(noEm(r.outcome)));
    out.push('');
  }

  const notes = footNotes(r);
  if (notes.length) {
    out.push('---');
    out.push('');
    for (const n of notes) out.push('_' + n + '_');
    out.push('');
  }
  return out.join('\n');
}

function quoteMd(s) {
  return noEm(s).split('\n').map((l) => (l ? '> ' + l.replace(/^(\s*)#/, '$1\\#') : '>')).join('\n');
}

// ── HTML ─────────────────────────────────────────────────────────────────────
/** Light, safe rendering of Claude's closing Markdown: escape first, then a few inline marks. */
function htmlBody(s) {
  const text = String(s || '');
  const parts = text.split(/^\s*```[^\n]*\n?/m);
  const html = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1) { html.push('<pre class="plain"><code>' + escapeHtml(part.replace(/\n$/, '')) + '</code></pre>'); return; }
    const blocks = part.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    for (const b of blocks) {
      const lines = b.split('\n');
      if (lines.every((l) => /^\s*([-*+]|\d+[.)])\s+/.test(l))) {
        const ordered = /^\s*\d/.test(lines[0]);
        html.push((ordered ? '<ol>' : '<ul>') + lines.map((l) => '<li>' + inlineHtml(l.replace(/^\s*([-*+]|\d+[.)])\s+/, '')) + '</li>').join('') + (ordered ? '</ol>' : '</ul>'));
      } else if (/^\s*\|/.test(lines[0])) {
        html.push('<pre class="plain"><code>' + escapeHtml(b) + '</code></pre>');
      } else {
        // Claude's own headings become bold lead-ins (ours outrank them)
        html.push('<p>' + lines.map((l) => {
          const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(l);
          return h ? '<strong>' + inlineHtml(h[1].replace(/\*\*/g, '')) + '</strong>' : inlineHtml(l);
        }).join('<br>') + '</p>');
      }
    }
  });
  return html.join('\n');
}

function inlineHtml(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function slug(s) {
  const t = String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, ' ').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
  return (t.slice(0, 60).replace(/-+$/, '') || 'session');
}

const CSS = `
:root{color-scheme:light dark;
  --bg:#f6f7f9;--panel:#ffffff;--line:#dfe3ea;--text:#16191f;--muted:#5d6675;--accent:#1d5fd1;--accent-ink:#ffffff;
  --code-bg:#f1f3f7;--code-text:#1b1f27;--ok:#147a4a;--ok-bg:#e3f5ec;--new:#7a4a00;--new-bg:#fdf0d8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0f1217;--panel:#161a22;--line:#2a313d;--text:#e8ebf1;--muted:#98a2b3;--accent:#7cb0ff;--accent-ink:#0f1217;
  --code-bg:#0b0e13;--code-text:#dfe5ee;--ok:#5fd39b;--ok-bg:#12291f;--new:#f3c46b;--new-bg:#2c2312}}
:root[data-theme="dark"]{
  --bg:#0f1217;--panel:#161a22;--line:#2a313d;--text:#e8ebf1;--muted:#98a2b3;--accent:#7cb0ff;--accent-ink:#0f1217;
  --code-bg:#0b0e13;--code-text:#dfe5ee;--ok:#5fd39b;--ok-bg:#12291f;--new:#f3c46b;--new-bg:#2c2312}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 "Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.mono,code,pre{font-family:"Cascadia Mono",Consolas,"SF Mono",Menlo,"DejaVu Sans Mono",monospace}
.wrap{max-width:880px;margin:0 auto;padding:40px 24px 64px}
.top{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:flex-start;justify-content:space-between}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
h1{margin:6px 0 0;font-size:30px;line-height:1.2;font-weight:750;letter-spacing:-.01em;overflow-wrap:anywhere}
.meta{margin-top:10px;color:var(--muted);font-size:14px;display:flex;flex-wrap:wrap;gap:6px 14px}
.meta span{white-space:nowrap}
.tools{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;font-size:14px;font-weight:600;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);padding:7px 14px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
h2{font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:40px 0 12px}
.goal{margin:0;padding:14px 18px;border-left:4px solid var(--accent);background:var(--panel);border-radius:0 10px 10px 0;white-space:pre-wrap;overflow-wrap:anywhere}
ol.steps{list-style:none;margin:0;padding:0;counter-reset:none}
.step{display:grid;grid-template-columns:36px minmax(0,1fr);gap:0 14px;margin:0 0 18px}
.num{width:32px;height:32px;border-radius:50%;background:var(--accent);color:var(--accent-ink);font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;margin-top:2px}
.stitle{font-weight:650;font-size:17px;line-height:1.4;overflow-wrap:anywhere;margin:4px 0 8px}
.code{position:relative;background:var(--code-bg);border:1px solid var(--line);border-radius:10px}
.code .bar{display:flex;justify-content:space-between;align-items:center;padding:6px 8px 0 14px;font-size:12px;color:var(--muted);text-transform:lowercase;letter-spacing:.04em}
.code .bar button{font-size:12px;padding:3px 10px}
pre{margin:0;padding:8px 14px 12px;overflow:auto;max-height:30em;font-size:13.5px;line-height:1.55;color:var(--code-text);white-space:pre-wrap;overflow-wrap:anywhere}
.more{display:block;margin-top:2px;font-size:12px;color:var(--muted);font-style:italic}
pre.plain{background:var(--code-bg);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:10px 0}
.when{font-size:12px;color:var(--muted);margin-top:6px}
.snote{font-size:13.5px;margin-top:8px;padding:6px 10px;border-radius:8px;background:var(--new-bg);color:var(--new)}
.files{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14.5px}
.files td{padding:8px 14px;border-top:1px solid var(--line);vertical-align:top}
.files tr:first-child td{border-top:0}
.files td.f{overflow-wrap:anywhere;font-size:13.5px}
.files td.c{white-space:nowrap;color:var(--muted);text-align:right;width:1%}
.tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:6px;padding:1px 7px;margin-right:6px}
.tag.new{background:var(--new-bg);color:var(--new)}
.tag.ok{background:var(--ok-bg);color:var(--ok)}
ul.checks{list-style:none;margin:0;padding:0}
ul.checks li{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:0 0 8px}
ul.checks .ct{font-weight:600;overflow-wrap:anywhere}
ul.checks code{display:block;margin-top:4px;font-size:12.5px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.outcome{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:4px 18px;overflow-wrap:anywhere}
.outcome code{background:var(--code-bg);border-radius:4px;padding:1px 5px;font-size:.9em}
.outcome pre code{background:none;padding:0}
.note{margin-top:32px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
.note p{margin:4px 0}
.empty{margin-top:40px;padding:40px 24px;text-align:center;background:var(--panel);border:1px dashed var(--line);border-radius:14px}
.empty .big{font-size:24px;font-weight:700}
.empty p{color:var(--muted);margin:8px 0 0}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:8px 16px;border-radius:8px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.show{opacity:1}
@media (max-width:560px){.wrap{padding:24px 16px 48px}h1{font-size:24px}.step{grid-template-columns:28px minmax(0,1fr);gap:0 10px}.num{width:26px;height:26px;font-size:13px}}
@media print{
  :root{--bg:#fff;--panel:#fff;--text:#000;--muted:#444;--line:#bbb;--code-bg:#f4f4f4;--code-text:#000;--accent:#000;--accent-ink:#fff}
  body{background:#fff;font-size:12pt}
  .tools,.code .bar button,#toast{display:none!important}
  .wrap{max-width:none;padding:0}
  pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:none;overflow:visible}
  .step,.code,ul.checks li{break-inside:avoid}
}
`;

/* Browser half: copy + download only. Serialized with Function#toString, so it is
   self-contained and never writes session data into the DOM. */
function clientMain() {
  var md = '';
  try { md = JSON.parse(document.getElementById('runbook-md').textContent); } catch (e) { md = ''; }
  var toast = document.getElementById('toast');
  var timer = 0;
  function say(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(function () { toast.classList.remove('show'); }, 1600);
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copy(text, what) {
    var done = function () { say(what + ' copied'); };
    var fail = function () { if (fallbackCopy(text)) done(); else say('Copy failed: select the text and copy it'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'copy-md') copy(md, 'Markdown');
    else if (act === 'copy-code') {
      var box = b.closest('.code');
      var code = box ? box.querySelector('code') : null;
      if (code) copy(code.textContent, 'Command');
    } else if (act === 'download') {
      var name = b.getAttribute('data-file') || 'runbook.md';
      var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      say('Downloading ' + name);
    } else if (act === 'print') window.print();
  });
}

function codeBlock(command, shell) {
  const lang = langOf(shell);
  return '<div class="code"><div class="bar"><span>' + lang + '</span><button type="button" data-act="copy-code" aria-label="Copy this command">Copy</button></div>'
    + '<pre><code class="language-' + lang + '">' + escapeHtml(command) + '</code></pre></div>';
}

/** A check's command, kept short: the first 3 lines of a script, nothing when it only repeats the title. */
function checkCmdHtml(c) {
  const full = String(c.command || '').replace(/\r\n?/g, '\n').trim();
  if (!full || oneLine(full).toLowerCase() === oneLine(c.title).toLowerCase()) return '';
  const lines = full.split('\n');
  const head = lines.slice(0, 3).join('\n');
  const more = lines.length > 3 ? '<span class="more">' + escapeHtml(plural(lines.length - 3, 'more line')) + '</span>' : '';
  return '<code>' + escapeHtml(head) + '</code>' + more;
}

function fmtTime(iso) {
  const ms = toMs(iso);
  if (ms == null) return '';
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function toHtml(rb) {
  const r = rb && typeof rb === 'object' ? rb : emptyRunbook({});
  const md = toMarkdown(r);
  const title = noEm(r.title || 'Runbook');
  const file = 'runbook-' + slug(title) + '.md';
  const steps = r.steps || [];
  const files = r.filesChanged || [];
  const checks = r.checks || [];
  const isEmpty = r.empty || (!steps.length && !files.length && !checks.length);
  const body = [];

  body.push('<header class="top"><div style="min-width:0;flex:1 1 420px">');
  body.push('<div class="eyebrow">Runbook</div>');
  body.push('<h1>' + escapeHtml(title) + '</h1>');
  const meta = metaParts(r);
  if (meta.length) body.push('<div class="meta">' + meta.map((m) => '<span>' + escapeHtml(m) + '</span>').join('<span aria-hidden="true">·</span>') + '</div>');
  body.push('</div><div class="tools" role="toolbar" aria-label="Export">');
  body.push('<button type="button" class="primary" data-act="copy-md">Copy as Markdown</button>');
  body.push('<button type="button" data-act="download" data-file="' + escapeHtml(file) + '">Download .md</button>');
  body.push('<button type="button" data-act="print">Print</button>');
  body.push('</div></header>');

  if (r.goal) body.push('<h2>Goal</h2><blockquote class="goal">' + escapeHtml(noEm(r.goal)) + '</blockquote>');

  if (isEmpty) {
    body.push('<div class="empty"><div class="big">' + EMPTY_MSG + '</div><p>This session has no successful changes, file edits or checks to hand off.</p></div>');
  } else {
    body.push('<h2>Steps</h2>');
    if (!steps.length) body.push('<p>No commands needed: the change is entirely in the files below.</p>');
    else {
      body.push('<ol class="steps">');
      for (const s of steps) {
        const t = fmtTime(s.at);
        body.push('<li class="step"><div class="num" aria-hidden="true">' + escapeHtml(String(s.n)) + '</div><div style="min-width:0">'
          + '<div class="stitle"><span class="sr">Step ' + escapeHtml(String(s.n)) + ': </span>' + escapeHtml(noEm(s.title)) + '</div>'
          + codeBlock(s.command, s.shell)
          + (s.note ? '<div class="snote">' + escapeHtml(noEm(s.note)) + '</div>' : '')
          + (t ? '<div class="when">Ran at ' + escapeHtml(t) + '</div>' : '')
          + '</div></li>');
      }
      body.push('</ol>');
    }
    if (files.length) {
      body.push('<h2>Files changed</h2><table class="files"><tbody>');
      for (const f of files) {
        body.push('<tr><td class="f mono">' + (f.created ? '<span class="tag new">new</span>' : '') + escapeHtml(f.file) + '</td><td class="c">' + escapeHtml(plural(f.edits, 'edit')) + '</td></tr>');
      }
      body.push('</tbody></table>');
    }
    if (checks.length) {
      body.push('<h2>How it was verified</h2><ul class="checks">');
      for (const c of checks) {
        body.push('<li><div class="ct">' + (c.passed ? '<span class="tag ok">passed</span>' : '') + escapeHtml(noEm(c.title)) + '</div>'
          + checkCmdHtml(c) + '</li>');
      }
      body.push('</ul>');
    }
    if (r.outcome) body.push('<h2>Outcome</h2><div class="outcome">' + htmlBody(noEm(r.outcome)) + '</div>');
  }
  const notes = footNotes(r);
  if (notes.length) body.push('<div class="note">' + notes.map((n) => '<p>' + escapeHtml(n) + '</p>').join('') + '</div>');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`,
    '<meta name="generator" content="Gander runbook">',
    '<title>' + escapeHtml(title) + ' · Runbook</title>',
    '<style>' + CSS + '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style>',
    '</head>',
    '<body>',
    '<main class="wrap">',
    body.join('\n'),
    '</main>',
    '<div id="toast" role="status" aria-live="polite"></div>',
    `<script type="application/json" id="runbook-md">${safeJson(md)}</script>`,
    `<script>(${clientMain.toString()})();</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

module.exports = {
  build, toMarkdown, toHtml,
  _test: { classifyCommand, splitSegments, descIsCheck, stripCwdCd, shortCommand, relTo, isScratch, promptText, safeJson, MAX_TOOL_CALLS },
};
