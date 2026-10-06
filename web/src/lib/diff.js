// web/src/lib/diff.js — tiny line diff for the approval rail's Edit/Write preview.
// Plain ES module, zero dependencies; runs in the browser and in Node (import()).
//
//   lineDiff(a, b, opts)      -> [{ op: ' ' | '-' | '+', text }]
//   hunks(lines, context = 3) -> [{ start, oldStart, newStart, lines }]
//   previewFor(tool, input)   -> { kind, file, blocks: [{ title, hunks, truncated }], added, removed, truncated }
//
// The diff is an LCS line diff on the part left after trimming the common prefix
// and suffix. When that middle is too big (either side > 2000 lines, or the
// product of the line counts > 4,000,000) it falls back to "remove the old
// middle, add the new middle" so a huge paste can never freeze the browser.

export const MAX_SIDE = 2000;
export const MAX_PRODUCT = 4000000;
export const BLOCK_CAP = 400;   // rendered lines per block (markers included)
export const WRITE_CAP = 200;   // lines of new content shown for Write

// Split text into lines on \r?\n. A single trailing newline terminates the last
// line rather than starting an empty one, and '' is zero lines.
export function splitLines(s) {
  if (s == null) return [];
  s = String(s);
  if (s === '') return [];
  const out = s.split(/\r?\n/);
  if (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

export function lineDiff(a, b, opts = {}) {
  const A = Array.isArray(a) ? a : splitLines(a);
  const B = Array.isArray(b) ? b : splitLines(b);
  const maxSide = opts.maxSide ?? MAX_SIDE;
  const maxProduct = opts.maxProduct ?? MAX_PRODUCT;
  const out = [];

  // common prefix / suffix
  let pre = 0;
  const minLen = Math.min(A.length, B.length);
  while (pre < minLen && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < minLen - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;

  for (let i = 0; i < pre; i++) out.push({ op: ' ', text: A[i] });

  const aEnd = A.length - suf, bEnd = B.length - suf;
  const n = aEnd - pre, m = bEnd - pre;

  if (n === 0 || m === 0 || n > maxSide || m > maxSide || n * m > maxProduct) {
    // trivial or huge middle: replace block (removals first, then additions)
    for (let i = pre; i < aEnd; i++) out.push({ op: '-', text: A[i] });
    for (let j = pre; j < bEnd; j++) out.push({ op: '+', text: B[j] });
  } else {
    // LCS table over the middle, suffix form: L[i][j] = LCS(A[pre+i..], B[pre+j..])
    const W = m + 1;
    const L = new Uint16Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      const ai = A[pre + i];
      const row = i * W, next = (i + 1) * W;
      for (let j = m - 1; j >= 0; j--) {
        if (ai === B[pre + j]) L[row + j] = L[next + j + 1] + 1;
        else {
          const down = L[next + j], right = L[row + j + 1];
          L[row + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[pre + i] === B[pre + j]) { out.push({ op: ' ', text: A[pre + i] }); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { out.push({ op: '-', text: A[pre + i] }); i++; }
      else { out.push({ op: '+', text: B[pre + j] }); j++; }
    }
    while (i < n) { out.push({ op: '-', text: A[pre + i] }); i++; }
    while (j < m) { out.push({ op: '+', text: B[pre + j] }); j++; }
  }

  for (let i = aEnd; i < A.length; i++) out.push({ op: ' ', text: A[i] });
  return out;
}

const marker = (count) => ({ op: '…', text: count + ' unchanged line' + (count === 1 ? '' : 's'), count });

// Group a lineDiff result into hunks. Any run of unchanged lines longer than
// 2*context is collapsed: `context` lines are kept next to each change and the
// rest becomes one '…' marker line. Markers sit at the top of the hunk that
// follows the gap (or at the end of the last hunk for a trailing gap), so
// concatenating every hunk's lines gives the full rendered view.
// start = index into `lines` of the hunk's first real line;
// oldStart/newStart = 1-based line numbers of that line in the old/new text.
export function hunks(lines, context = 3) {
  lines = lines || [];
  context = Math.max(0, context | 0);
  const result = [];
  let cur = null;
  let oldNo = 1, newNo = 1;
  let pendingMarker = null;

  const pushLine = (idx, ln) => {
    if (!cur) {
      cur = { start: idx, oldStart: oldNo, newStart: newNo, lines: [] };
      if (pendingMarker) { cur.lines.push(pendingMarker); pendingMarker = null; }
      result.push(cur);
    }
    cur.lines.push(ln);
  };
  const advance = (op) => { if (op !== '+') oldNo++; if (op !== '-') newNo++; };

  let i = 0;
  while (i < lines.length) {
    if (lines[i].op !== ' ') { pushLine(i, lines[i]); advance(lines[i].op); i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].op === ' ') j++;
    const len = j - i;
    const atStart = i === 0, atEnd = j === lines.length;
    if (len <= 2 * context) {
      for (let k = i; k < j; k++) { pushLine(k, lines[k]); advance(' '); }
    } else {
      const head = atStart ? 0 : context;   // lines kept after the previous change
      const tail = atEnd ? 0 : context;     // lines kept before the next change
      for (let k = i; k < i + head; k++) { pushLine(k, lines[k]); advance(' '); }
      const hidden = len - head - tail;
      for (let k = 0; k < hidden; k++) advance(' ');
      const mk = marker(hidden);
      if (atEnd && cur) cur.lines.push(mk);        // trailing gap closes the last hunk
      else if (atEnd) result.push({ start: i, oldStart: oldNo - hidden, newStart: newNo - hidden, lines: [mk] }); // nothing changed at all
      else { pendingMarker = mk; cur = null; }     // gap: next hunk opens with the marker
      for (let k = j - tail; k < j; k++) { pushLine(k, lines[k]); advance(' '); }
    }
    i = j;
  }
  return result;
}

function count(lines) {
  let added = 0, removed = 0;
  for (const l of lines) { if (l.op === '+') added++; else if (l.op === '-') removed++; }
  return { added, removed };
}

// Cap a block's hunks at `cap` rendered lines. Returns { hunks, truncated, hidden }.
function capHunks(hs, cap) {
  let left = cap, total = 0;
  for (const h of hs) total += h.lines.length;
  if (total <= cap) return { hunks: hs, truncated: false, hidden: 0 };
  const out = [];
  for (const h of hs) {
    if (left <= 0) break;
    if (h.lines.length <= left) { out.push(h); left -= h.lines.length; }
    else { out.push({ ...h, lines: h.lines.slice(0, left) }); left = 0; }
  }
  return { hunks: out, truncated: true, hidden: total - cap };
}

function diffBlock(title, oldS, newS) {
  const lines = lineDiff(oldS, newS);
  const c = count(lines);
  const capped = capHunks(hunks(lines), BLOCK_CAP);
  return { block: { title, hunks: capped.hunks, truncated: capped.truncated, hidden: capped.hidden }, ...c };
}

function plusBlock(title, text, cap) {
  const all = splitLines(text);
  const shown = all.slice(0, cap);
  const lines = shown.map((t) => ({ op: '+', text: t }));
  const truncated = all.length > shown.length;
  return {
    block: { title, hunks: lines.length ? [{ start: 0, oldStart: 1, newStart: 1, lines }] : [], truncated, hidden: all.length - shown.length },
    added: all.length,
    removed: 0,
  };
}

export function previewFor(tool, input) {
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_) { input = null; } }
  input = input && typeof input === 'object' ? input : {};
  const name = String(tool || '').trim().toLowerCase();
  const file = String(input.file_path || input.notebook_path || input.path || '');
  const none = { kind: 'none', file, blocks: [], added: 0, removed: 0, truncated: false };
  const finish = (kind, parts) => ({
    kind,
    file,
    blocks: parts.map((p) => p.block),
    added: parts.reduce((s, p) => s + p.added, 0),
    removed: parts.reduce((s, p) => s + p.removed, 0),
    truncated: parts.some((p) => p.block.truncated),
  });

  if (name === 'edit') {
    const title = input.replace_all ? 'Edit (replace all occurrences)' : 'Edit';
    return finish('edit', [diffBlock(title, input.old_string ?? '', input.new_string ?? '')]);
  }
  if (name === 'multiedit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const n = edits.length;
    return finish('multiedit', edits.map((e, i) => {
      e = e || {};
      const title = 'Edit ' + (i + 1) + ' of ' + n + (e.replace_all ? ' (replace all occurrences)' : '');
      return diffBlock(title, e.old_string ?? '', e.new_string ?? '');
    }));
  }
  if (name === 'write') {
    const existing = Number(input.__existingLines);
    const replaces = Number.isFinite(existing) && existing >= 0 && input.__existingLines != null && input.__existingLines !== '';
    const title = replaces ? 'Replaces an existing file of ' + existing + ' line' + (existing === 1 ? '' : 's') : 'New file content';
    const part = plusBlock(title, input.content ?? '', WRITE_CAP);
    if (replaces) part.removed = existing;
    return finish('write', [part]);
  }
  if (name === 'notebookedit') {
    const mode = String(input.edit_mode || 'replace');
    const cell = input.cell_id ? ' ' + input.cell_id : '';
    if (mode === 'delete') return finish('write', [{ block: { title: 'Delete cell' + cell, hunks: [], truncated: false, hidden: 0 }, added: 0, removed: 0 }]);
    const title = (mode === 'insert' ? 'New cell' : 'Replace cell') + cell + ' source';
    return finish('write', [plusBlock(title, input.new_source ?? '', BLOCK_CAP)]);
  }
  return none;
}
