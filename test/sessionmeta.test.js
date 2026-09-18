'use strict';
// test/sessionmeta.test.js — tests for bridge/sessionmeta.js
//
// sessionmeta reads the bookkeeping lines Claude Code already writes into a
// transcript (.jsonl, one JSON object per line) — ai-title, mode, frame-link,
// file-history-delta — and folds them into what a dashboard tile wants.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sessionmeta = require('../bridge/sessionmeta.js');

// --- helpers ---------------------------------------------------------------

// Write an array of objects (or raw strings, for malformed-line tests) as a
// .jsonl file in a fresh temp dir. Returns the absolute path.
function writeTranscript(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gander-sessionmeta-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, entries.map(toLine).join(''), 'utf8');
  return file;
}

// Append more lines to an existing transcript — the incremental-read case.
function appendLines(file, entries) {
  fs.appendFileSync(file, entries.map(toLine).join(''), 'utf8');
}

function toLine(e) {
  return (typeof e === 'string' ? e : JSON.stringify(e)) + '\n';
}

const ASSISTANT_LINE = { type: 'assistant', message: { role: 'assistant', content: 'hello' } };
const USER_LINE = { type: 'user', message: { role: 'user', content: 'hi' } };
const ATTACHMENT_LINE = { type: 'attachment', attachment: { kind: 'file', path: 'a.png' } };

beforeEach(() => { sessionmeta._reset(); });

// ---------------------------------------------------------------------------
// read() — the happy path
// ---------------------------------------------------------------------------
describe('sessionmeta.read() happy path', () => {
  test('title and mode take the LAST value seen, artifacts and files accumulate', () => {
    const file = writeTranscript([
      { type: 'ai-title', aiTitle: 'First guess at the topic', sessionId: 's1' },
      { type: 'mode', mode: 'normal', sessionId: 's1' },
      USER_LINE,
      { type: 'frame-link', title: 'Ambient Lamp Wiring', frameUrl: 'https://claude.ai/code/artifact/abc', timestamp: '2026-09-14T10:00:00.000Z', sessionId: 's1' },
      { type: 'file-history-delta', trackingPath: '.gitignore', backup: { backupFileName: 'x', version: 1 }, timestamp: '2026-09-14T10:00:00.000Z' },
      ASSISTANT_LINE,
      { type: 'ai-title', aiTitle: 'Analyze Claude session patterns', sessionId: 's1' },
      { type: 'mode', mode: 'bypassPermissions', sessionId: 's1' },
      { type: 'frame-link', title: 'MOSFET Picker', frameUrl: 'https://claude.ai/code/artifact/def', timestamp: '2026-09-14T11:00:00.000Z', sessionId: 's1' },
      { type: 'file-history-delta', trackingPath: 'bridge/server.js', backup: { backupFileName: 'y', version: 2 }, timestamp: '2026-09-14T11:00:00.000Z' },
    ]);

    const meta = sessionmeta.read(file);

    assert.equal(meta.title, 'Analyze Claude session patterns', 'the last ai-title wins');
    assert.equal(meta.mode, 'bypassPermissions', 'the last mode wins');
    assert.equal(meta.artifactCount, 2);
    assert.equal(meta.artifacts.length, 2);
    assert.equal(meta.fileCount, 2);
    assert.deepEqual(meta.files.slice().sort(), ['.gitignore', 'bridge/server.js']);
  });
});

// ---------------------------------------------------------------------------
// read() — artifacts
// ---------------------------------------------------------------------------
describe('sessionmeta.read() artifacts', () => {
  test('dedupes by url and keeps the NEWER title when one is republished', () => {
    const url = 'https://claude.ai/code/artifact/abc';
    const file = writeTranscript([
      { type: 'frame-link', title: 'Ambient Lamp Wiring', frameUrl: url, timestamp: '2026-09-14T10:00:00.000Z', sessionId: 's1' },
      { type: 'frame-link', title: 'Ambient Lamp Wiring v2', frameUrl: url, timestamp: '2026-09-14T12:00:00.000Z', sessionId: 's1' },
    ]);

    const meta = sessionmeta.read(file);

    assert.equal(meta.artifactCount, 1, 'one url is one artifact');
    assert.equal(meta.artifacts.length, 1);
    assert.equal(meta.artifacts[0].title, 'Ambient Lamp Wiring v2', 'the republished title replaces the old one');
    assert.equal(meta.artifacts[0].url, url);
  });

  test('skips placeholder rows whose frameUrl is null or missing, without throwing', () => {
    const file = writeTranscript([
      { type: 'frame-link', title: 'Placeholder', frameUrl: null, timestamp: '2026-09-14T09:00:00.000Z', sessionId: 's1' },
      { type: 'frame-link', title: 'No url key at all', timestamp: '2026-09-14T09:30:00.000Z', sessionId: 's1' },
      { type: 'frame-link', title: 'Real One', frameUrl: 'https://claude.ai/code/artifact/real', timestamp: '2026-09-14T10:00:00.000Z', sessionId: 's1' },
    ]);

    const meta = sessionmeta.read(file);

    assert.equal(meta.artifactCount, 1, 'only the row with a real url counts');
    assert.equal(meta.artifacts[0].title, 'Real One');
  });

  test('come back sorted newest-first by timestamp', () => {
    const file = writeTranscript([
      { type: 'frame-link', title: 'Middle', frameUrl: 'https://claude.ai/code/artifact/mid', timestamp: '2026-09-14T11:00:00.000Z', sessionId: 's1' },
      { type: 'frame-link', title: 'Oldest', frameUrl: 'https://claude.ai/code/artifact/old', timestamp: '2026-09-14T09:00:00.000Z', sessionId: 's1' },
      { type: 'frame-link', title: 'Newest', frameUrl: 'https://claude.ai/code/artifact/new', timestamp: '2026-09-14T15:00:00.000Z', sessionId: 's1' },
    ]);

    const meta = sessionmeta.read(file);

    assert.deepEqual(meta.artifacts.map((a) => a.title), ['Newest', 'Middle', 'Oldest']);
  });
});

// ---------------------------------------------------------------------------
// read() — files
// ---------------------------------------------------------------------------
describe('sessionmeta.read() files', () => {
  test('dedupes by trackingPath — a repeated path appears once and fileCount matches', () => {
    const file = writeTranscript([
      { type: 'file-history-delta', trackingPath: '.gitignore', backup: { backupFileName: 'x', version: 1 }, timestamp: '2026-09-14T10:00:00.000Z' },
      { type: 'file-history-delta', trackingPath: 'web/src/App.svelte', backup: { backupFileName: 'y', version: 1 }, timestamp: '2026-09-14T10:05:00.000Z' },
      { type: 'file-history-delta', trackingPath: '.gitignore', backup: { backupFileName: 'z', version: 2 }, timestamp: '2026-09-14T10:10:00.000Z' },
    ]);

    const meta = sessionmeta.read(file);

    assert.deepEqual(meta.files, ['.gitignore', 'web/src/App.svelte']);
    assert.equal(meta.fileCount, meta.files.length);
    assert.equal(meta.fileCount, 2);
  });
});

// ---------------------------------------------------------------------------
// read() — robustness
// ---------------------------------------------------------------------------
describe('sessionmeta.read() robustness', () => {
  test('ignores unrelated line types and survives a malformed/truncated JSON line', () => {
    const file = writeTranscript([
      USER_LINE,
      ASSISTANT_LINE,
      ATTACHMENT_LINE,
      '{not json',
      '{"type":"ai-title","aiTitle":"truncated mid-writ',   // torn line, still matches the pre-filter
      { type: 'ai-title', aiTitle: 'Analyze Claude session patterns', sessionId: 's1' },
      { type: 'frame-link', title: 'Ambient Lamp Wiring', frameUrl: 'https://claude.ai/code/artifact/abc', timestamp: '2026-09-14T10:00:00.000Z', sessionId: 's1' },
      { type: 'file-history-delta', trackingPath: '.gitignore', backup: { backupFileName: 'x', version: 1 }, timestamp: '2026-09-14T10:00:00.000Z' },
    ]);

    const meta = sessionmeta.read(file);

    assert.equal(meta.title, 'Analyze Claude session patterns', 'the good ai-title still lands');
    assert.equal(meta.artifactCount, 1);
    assert.equal(meta.fileCount, 1);
  });

  test('returns null for a path that does not exist', () => {
    const missing = path.join(os.tmpdir(), 'gander-sessionmeta-does-not-exist', 'nope.jsonl');
    assert.equal(sessionmeta.read(missing), null);
  });
});

// ---------------------------------------------------------------------------
// read() — incremental (byte-offset) reads
// ---------------------------------------------------------------------------
describe('sessionmeta.read() incremental', () => {
  test('picks up appended lines without duplicating what it already folded', () => {
    const file = writeTranscript([
      { type: 'ai-title', aiTitle: 'First pass title', sessionId: 's1' },
      { type: 'frame-link', title: 'Ambient Lamp Wiring', frameUrl: 'https://claude.ai/code/artifact/abc', timestamp: '2026-09-14T10:00:00.000Z', sessionId: 's1' },
    ]);

    const first = sessionmeta.read(file);
    assert.equal(first.title, 'First pass title');
    assert.equal(first.artifactCount, 1);

    appendLines(file, [
      ASSISTANT_LINE,
      { type: 'ai-title', aiTitle: 'Second pass title', sessionId: 's1' },
      { type: 'frame-link', title: 'MOSFET Picker', frameUrl: 'https://claude.ai/code/artifact/def', timestamp: '2026-09-14T13:00:00.000Z', sessionId: 's1' },
    ]);

    const second = sessionmeta.read(file);

    assert.equal(second.title, 'Second pass title', 'the newer ai-title replaces the old one');
    assert.equal(second.artifactCount, 2, 'exactly two artifacts — the first one is not re-added');
    assert.deepEqual(second.artifacts.map((a) => a.title), ['MOSFET Picker', 'Ambient Lamp Wiring']);
  });
});

// ---------------------------------------------------------------------------
// forTile() — the small object a live tile carries
// ---------------------------------------------------------------------------
describe('sessionmeta.forTile()', () => {
  test('includes the title and omits permMode when the mode is "normal"', () => {
    const file = writeTranscript([
      { type: 'ai-title', aiTitle: 'Analyze Claude session patterns', sessionId: 's1' },
      { type: 'mode', mode: 'normal', sessionId: 's1' },
    ]);

    const tile = sessionmeta.forTile(file);

    assert.equal(tile.title, 'Analyze Claude session patterns');
    assert.ok(!('permMode' in tile), 'the default mode says nothing and is left out');
  });

  test('includes permMode when the mode is not the default', () => {
    const file = writeTranscript([
      { type: 'mode', mode: 'bypassPermissions', sessionId: 's1' },
    ]);

    assert.equal(sessionmeta.forTile(file).permMode, 'bypassPermissions');
  });

  test('omits artifactCount and fileCount when they are zero', () => {
    const file = writeTranscript([
      { type: 'ai-title', aiTitle: 'Nothing published yet', sessionId: 's1' },
      USER_LINE,
    ]);

    const tile = sessionmeta.forTile(file);

    assert.ok(!('artifactCount' in tile), 'zero artifacts is not worth a badge');
    assert.ok(!('fileCount' in tile), 'zero files is not worth a badge');
  });

  test('includes artifactCount and fileCount when they are non-zero', () => {
    const file = writeTranscript([
      { type: 'frame-link', title: 'Ambient Lamp Wiring', frameUrl: 'https://claude.ai/code/artifact/abc', timestamp: '2026-09-14T10:00:00.000Z', sessionId: 's1' },
      { type: 'file-history-delta', trackingPath: '.gitignore', backup: { backupFileName: 'x', version: 1 }, timestamp: '2026-09-14T10:00:00.000Z' },
      { type: 'file-history-delta', trackingPath: 'bridge/server.js', backup: { backupFileName: 'y', version: 1 }, timestamp: '2026-09-14T10:01:00.000Z' },
    ]);

    const tile = sessionmeta.forTile(file);

    assert.equal(tile.artifactCount, 1);
    assert.equal(tile.fileCount, 2);
  });
});
