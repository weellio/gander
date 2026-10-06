'use strict';
// test/diff.test.js — web/src/lib/diff.js: the line diff behind the approval
// rail's Edit/Write preview. The module is ESM (browser code), loaded via import().

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let D;
before(async () => {
  D = await import(pathToFileURL(path.join(__dirname, '..', 'web', 'src', 'lib', 'diff.js')).href);
});

const ops = (lines) => lines.map((l) => l.op).join('');
const flat = (hs) => hs.flatMap((h) => h.lines);
const nums = (n, p = 'l') => Array.from({ length: n }, (_, i) => p + i).join('\n');

describe('lineDiff', () => {
  test('identical inputs -> all unchanged', () => {
    const r = D.lineDiff('a\nb\nc', 'a\nb\nc');
    assert.equal(ops(r), '   ');
    assert.deepEqual(r.map((l) => l.text), ['a', 'b', 'c']);
  });

  test('single changed line', () => {
    const r = D.lineDiff('a\nb\nc', 'a\nX\nc');
    assert.deepEqual(r, [
      { op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'X' }, { op: ' ', text: 'c' },
    ]);
  });

  test('insertion at start and end', () => {
    assert.deepEqual(D.lineDiff('a\nb', 'N\na\nb'), [{ op: '+', text: 'N' }, { op: ' ', text: 'a' }, { op: ' ', text: 'b' }]);
    assert.deepEqual(D.lineDiff('a\nb', 'a\nb\nN'), [{ op: ' ', text: 'a' }, { op: ' ', text: 'b' }, { op: '+', text: 'N' }]);
  });

  test('deletion at start and end', () => {
    assert.deepEqual(D.lineDiff('x\na\nb', 'a\nb'), [{ op: '-', text: 'x' }, { op: ' ', text: 'a' }, { op: ' ', text: 'b' }]);
    assert.deepEqual(D.lineDiff('a\nb\nx', 'a\nb'), [{ op: ' ', text: 'a' }, { op: ' ', text: 'b' }, { op: '-', text: 'x' }]);
  });

  test('CRLF vs LF is the same line content', () => {
    assert.equal(ops(D.lineDiff('a\r\nb\r\nc\r\n', 'a\nb\nc\n')), '   ');
    assert.equal(ops(D.lineDiff('a\r\nb', 'a\nB')), ' -+');
  });

  test('empty sides', () => {
    assert.deepEqual(D.lineDiff('', ''), []);
    assert.equal(ops(D.lineDiff('', 'a\nb')), '++');
    assert.equal(ops(D.lineDiff('a\nb', '')), '--');
  });

  test('interleaved changes keep the common lines (real LCS, not a replace block)', () => {
    const r = D.lineDiff('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne');
    assert.equal(ops(r), ' -+ -+ ');
    const r2 = D.lineDiff('1\n2\n3\n4', '0\n1\n3\n4\n5');
    assert.equal(ops(r2), '+ -  +');
  });

  test('huge-input fallback returns quickly for two 50,000-line inputs', () => {
    const a = nums(50000, 'a'), b = nums(50000, 'b');
    const t0 = Date.now();
    const r = D.lineDiff(a, b);
    const ms = Date.now() - t0;
    assert.ok(ms < 200, 'took ' + ms + ' ms');
    assert.equal(r.length, 100000);
    assert.equal(r[0].op, '-'); assert.equal(r[99999].op, '+');

    // same size, mostly shared: prefix/suffix trim keeps the common lines unchanged
    const c = nums(50000), d = c.replace('l25000\n', 'CHANGED\n');
    const t1 = Date.now();
    const r2 = D.lineDiff(c, d);
    assert.ok(Date.now() - t1 < 200);
    assert.equal(r2.filter((l) => l.op !== ' ').length, 2);

    // and the whole preview path stays fast
    const t2 = Date.now();
    const p = D.previewFor('Edit', { file_path: '/x.txt', old_string: a, new_string: b });
    assert.ok(Date.now() - t2 < 200);
    assert.equal(p.added, 50000); assert.equal(p.removed, 50000); assert.equal(p.truncated, true);
  });

  test('fallback thresholds are configurable and still produce a correct (coarse) diff', () => {
    const a = 'p\na\nb\nc\ns', b = 'p\nX\nb\nY\ns';
    assert.equal(ops(D.lineDiff(a, b)), ' -+ -+ ');
    assert.equal(ops(D.lineDiff(a, b, { maxSide: 2 })), ' ---+++ ');
    assert.equal(ops(D.lineDiff(a, b, { maxProduct: 8 })), ' ---+++ ');
  });
});

describe('hunks', () => {
  test('collapses a long unchanged run with the correct count', () => {
    const a = nums(20), b = a.replace('l0\n', 'X\n').replace('\nl19', '\nY');
    const lines = D.lineDiff(a, b);
    const hs = D.hunks(lines, 3);
    assert.equal(hs.length, 2);
    const f = flat(hs);
    const mk = f.filter((l) => l.op === '…');
    assert.equal(mk.length, 1);
    assert.equal(mk[0].text, '12 unchanged lines'); // 18 unchanged - 3 - 3
    assert.equal(mk[0].count, 12);
    assert.equal(hs[1].lines[0].op, '…'); // marker opens the hunk after the gap
    assert.equal(hs[1].oldStart, 17);     // l16 is the first real line of hunk 2
  });

  test('runs of exactly 2*context are not collapsed', () => {
    const lines = D.lineDiff('X\n1\n2\n3\n4\n5\n6\nY', 'x\n1\n2\n3\n4\n5\n6\ny');
    const hs = D.hunks(lines, 3);
    assert.equal(hs.length, 1);
    assert.equal(flat(hs).some((l) => l.op === '…'), false);
  });

  test('leading and trailing runs keep only the context next to the change', () => {
    const a = nums(30), b = a.replace('l15', 'MID');
    const f = flat(D.hunks(D.lineDiff(a, b), 3));
    assert.equal(ops(f), '…   -+   …');
    assert.equal(f[0].text, '12 unchanged lines');
    assert.equal(f[f.length - 1].text, '11 unchanged lines');
  });

  test('identical long input collapses to a single marker; short stays as-is', () => {
    const f = flat(D.hunks(D.lineDiff(nums(10), nums(10)), 3));
    assert.deepEqual(f.map((l) => l.op), ['…']);
    assert.equal(f[0].text, '10 unchanged lines');
    assert.equal(ops(flat(D.hunks(D.lineDiff('a\nb', 'a\nb')))), '  ');
    assert.deepEqual(D.hunks([]), []);
  });
});

describe('previewFor', () => {
  test('Edit diffs old_string vs new_string; replace_all goes in the title', () => {
    const p = D.previewFor('Edit', { file_path: 'C:\\a\\b\\c\\d.js', old_string: 'x\ny', new_string: 'x\nz' });
    assert.equal(p.kind, 'edit');
    assert.equal(p.file, 'C:\\a\\b\\c\\d.js');
    assert.equal(p.added, 1); assert.equal(p.removed, 1); assert.equal(p.truncated, false);
    assert.equal(p.blocks.length, 1);
    assert.equal(p.blocks[0].title, 'Edit');
    assert.equal(ops(flat(p.blocks[0].hunks)), ' -+');
    const ra = D.previewFor('Edit', { file_path: 'f', old_string: 'a', new_string: 'b', replace_all: true });
    assert.match(ra.blocks[0].title, /replace all/);
  });

  test('accepts the tool input as a JSON string', () => {
    const p = D.previewFor('Edit', JSON.stringify({ file_path: 'f', old_string: 'a', new_string: 'b' }));
    assert.equal(p.kind, 'edit'); assert.equal(p.added, 1);
  });

  test('MultiEdit: one block per edit, totals summed', () => {
    const p = D.previewFor('MultiEdit', { file_path: 'f.py', edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c\nd', new_string: 'c', replace_all: true },
    ] });
    assert.equal(p.kind, 'multiedit');
    assert.equal(p.blocks.length, 2);
    assert.equal(p.blocks[0].title, 'Edit 1 of 2');
    assert.match(p.blocks[1].title, /^Edit 2 of 2 .*replace all/);
    assert.equal(p.added, 1); assert.equal(p.removed, 2);
  });

  test('Write: new content as all + lines, capped at 200', () => {
    const p = D.previewFor('Write', { file_path: '/n.txt', content: 'one\ntwo\n' });
    assert.equal(p.kind, 'write');
    assert.equal(p.blocks[0].title, 'New file content');
    assert.equal(ops(flat(p.blocks[0].hunks)), '++');
    assert.equal(p.added, 2); assert.equal(p.removed, 0); assert.equal(p.truncated, false);

    const big = D.previewFor('Write', { file_path: '/n.txt', content: nums(500) });
    assert.equal(flat(big.blocks[0].hunks).length, 200);
    assert.equal(big.truncated, true); assert.equal(big.blocks[0].truncated, true);
    assert.equal(big.blocks[0].hidden, 300);
    assert.equal(big.added, 500);
  });

  test('Write over an existing file (bridge passes __existingLines)', () => {
    const p = D.previewFor('Write', { file_path: '/n.txt', content: 'x', __existingLines: 42 });
    assert.equal(p.blocks[0].title, 'Replaces an existing file of 42 lines');
    assert.equal(p.removed, 42);
    assert.equal(D.previewFor('Write', { content: 'x', __existingLines: 1 }).blocks[0].title, 'Replaces an existing file of 1 line');
  });

  test('NotebookEdit: new_source as + lines', () => {
    const p = D.previewFor('NotebookEdit', { notebook_path: '/nb.ipynb', cell_id: 'c1', new_source: 'import x\nx()' });
    assert.equal(p.kind, 'write');
    assert.equal(p.file, '/nb.ipynb');
    assert.equal(ops(flat(p.blocks[0].hunks)), '++');
    assert.equal(p.added, 2);
  });

  test('anything else is kind none', () => {
    for (const t of ['Bash', 'Read', '', undefined]) {
      const p = D.previewFor(t, { command: 'ls' });
      assert.equal(p.kind, 'none');
      assert.deepEqual(p.blocks, []);
    }
    assert.equal(D.previewFor('Edit', null).kind, 'edit'); // tolerant of missing input
  });

  test('each diff block is capped at 400 rendered lines with truncated set', () => {
    const a = nums(1000, 'a'), b = nums(1000, 'b');
    const p = D.previewFor('Edit', { file_path: 'f', old_string: a, new_string: b });
    assert.equal(flat(p.blocks[0].hunks).length, 400);
    assert.equal(p.blocks[0].truncated, true);
    assert.equal(p.truncated, true);
    assert.equal(p.blocks[0].hidden, 1600);
    assert.equal(p.added, 1000); assert.equal(p.removed, 1000); // totals are not capped

    const nb = D.previewFor('NotebookEdit', { notebook_path: 'n', new_source: nums(450) });
    assert.equal(flat(nb.blocks[0].hunks).length, 400);
    assert.equal(nb.truncated, true);
  });
});
