#!/usr/bin/env node
// Gander uninstaller — removes the hooks it added, leaving your other
// settings untouched.
//
//   node uninstall.js            # remove from global settings
//   node uninstall.js --project  # remove from this project's settings
//   node uninstall.js --dry-run  # show what would change, write nothing

const { uninstall, settingsPath } = require('./setup/lib');

const opts = {
  project: process.argv.includes('--project'),
  dryRun: process.argv.includes('--dry-run'),
};

console.log(`Gander uninstall — settings: ${settingsPath(opts)}\n`);
uninstall(opts);
console.log('\nThe bridge (if running) will stop on next reboot, or stop it now: stop the node process on port 3131.');
