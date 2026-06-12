#!/usr/bin/env node
// Gander installer — wires the dashboard into Claude Code.
//
//   node install.js              # global: every session on this machine reports
//   node install.js --project    # only sessions started in the current folder
//   node install.js --dry-run    # show what would change, write nothing
//
// Safe to re-run (idempotent) and pairs with `node uninstall.js`.

const { install, settingsPath, ROOT } = require('./setup/lib');

const opts = {
  project: process.argv.includes('--project'),
  dryRun: process.argv.includes('--dry-run'),
};

console.log('Gander — live NOC for your Claude Code agents');
console.log(`  install dir: ${ROOT}`);
console.log(`  settings:    ${settingsPath(opts)}\n`);

install(opts);

if (!opts.dryRun) {
  console.log('\nNext steps:');
  console.log('  1. In any open Claude Code session, run  /hooks  (or restart) to load the hooks.');
  console.log('  2. The dashboard opens automatically on the next session — or run:');
  console.log(`       node "${ROOT.replace(/\\/g, '/')}/bridge/launch.js"`);
  console.log('     then visit  http://localhost:3131/');
}
