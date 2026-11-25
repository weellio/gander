'use strict';
// The bridge keeper: a tiny long-running process that pings the bridge every
// minute and runs launch.js when it does not answer. Started at logon from a
// Startup-folder launcher (Windows) — see autostart.js. launch.js exits at once
// when a bridge already answers, so a running bridge costs the keeper nothing.
//
// Deliberately NOT a Scheduled Task: "schtasks /Create … wscript //B hidden.vbs"
// is exactly the persistence shape Windows Defender's ML rule flags as
// Trojan:Win32/Commando, and it did. A plain file in the Startup folder is not.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.AOC_PORT || 3131);
const LAUNCHER = path.join(__dirname, 'launch.js');
const LOCK = path.join(os.tmpdir(), `gander-keeper-${PORT}.lock`);

function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }

// One keeper per port: a second one started by hand exits quietly.
function singleInstance() {
  try { const pid = Number(fs.readFileSync(LOCK, 'utf8')); if (pid && pid !== process.pid && alive(pid)) return false; } catch (_) {}
  try { fs.writeFileSync(LOCK, String(process.pid)); } catch (_) {}
  return true;
}

function ping(port, cb) {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/state', timeout: 3000 }, (res) => { res.resume(); cb(res.statusCode === 200); });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

function launch() {
  try {
    spawn(process.execPath, [LAUNCHER], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, GANDER_NO_OPEN: '1', AOC_PORT: String(PORT) } }).unref();
  } catch (_) {}
}

// Check once: launch when nothing answers. `doLaunch` is injectable for tests.
function check(port = PORT, doLaunch = launch, cb) {
  ping(port, (up) => { if (!up) doLaunch(); if (cb) cb(up); });
}

function main() {
  if (!singleInstance()) process.exit(0);
  check();
  setInterval(check, 60000);
  process.on('SIGTERM', () => { try { fs.unlinkSync(LOCK); } catch (_) {} process.exit(0); });
}

if (require.main === module) main();
module.exports = { check, ping, LOCK, lockPath: (port) => path.join(os.tmpdir(), `gander-keeper-${port}.lock`) };
