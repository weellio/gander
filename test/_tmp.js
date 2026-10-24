'use strict';
// Scratch folders for tests that clean themselves up.
//
// Every test used to call fs.mkdtempSync(os.tmpdir() + 'gander-…') and leave the
// folder behind; a few hundred suite runs left 1,900 of them in %TEMP%. This
// registers each folder and removes them all when the test process exits
// (node --test runs each file in its own process, so exit is the right hook).
const fs = require('fs');
const os = require('os');
const path = require('path');

const made = [];

function tmpdir(prefix = 'gander-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

function cleanup() {
  for (const d of made.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
  }
}

process.on('exit', cleanup);

module.exports = { tmpdir, cleanup };
