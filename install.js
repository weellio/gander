#!/usr/bin/env node
// Gander installer — wires the dashboard into Claude Code.
//
//   node install.js              # global: every session on this machine reports
//   node install.js --project    # only sessions started in the current folder
//   node install.js --dry-run    # show what would change, write nothing
//   node install.js --mods       # also install the gander-feed mod (Claude Code 2.1.287+; otherwise skipped)
//
// Safe to re-run (idempotent) and pairs with `node uninstall.js`.

const { install, settingsPath, ROOT } = require('./setup/lib');
const version = require('./bridge/version');
const mod = require('./bridge/mod');

const opts = {
  project: process.argv.includes('--project'),
  dryRun: process.argv.includes('--dry-run'),
  mods: process.argv.includes('--mods'),
};

console.log('Gander — live NOC for your Claude Code agents');
console.log(`  install dir: ${ROOT}`);
console.log(`  settings:    ${settingsPath(opts)}\n`);

install(opts);

// The mod is optional and gated: only a CLI at or past the gate gets it. An
// older CLI, or a machine without Claude Code (other providers), keeps the
// classic hook path that was just installed, and is told so.
if (opts.mods && !opts.dryRun) {
  version.currentVersion('claude', (_e, current) => {
    const gate = mod.supports(current);
    if (!gate.supported) {
      console.log(`
~ gander-feed mod skipped: ${gate.reason}.`);
      console.log('  Everything above still works through the classic hooks.');
      return;
    }
    console.log(`
Installing the gander-feed mod (Claude Code ${gate.current} >= ${gate.min})…`);
    mod.install({ cli: 'claude', root: ROOT, current }, (_e2, r) => {
      if (r.ok) console.log('✓ gander-feed installed at user scope. Run /reload-plugins in open sessions, or start a new one.');
      else console.log(`✗ gander-feed install failed: ${r.error}
${r.output}`);
    });
  });
}

if (!opts.dryRun) {
  console.log('\nNext steps:');
  console.log('  1. In any open Claude Code session, run  /hooks  (or restart) to load the hooks.');
  console.log('  2. The dashboard opens automatically on the next session — or run:');
  console.log(`       node "${ROOT.replace(/\\/g, '/')}/bridge/launch.js"`);
  console.log('     then visit  http://localhost:3131/');
}
