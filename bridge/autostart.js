'use strict';
// Keep the bridge running. Today the bridge is only ever started by a Claude Code
// session's SessionStart hook, so after a reboot, a logoff, a crash or a Windows
// update there is no bridge until the next session starts: no Telegram, no phone
// page, no connector. This installs something the OS starts at logon that brings
// the bridge back when it is not answering:
//   Windows: a launcher in the user's Startup folder that runs keeper.js (pings
//            every minute, runs launch.js when the bridge is down). NOT a Scheduled
//            Task: "schtasks /Create … wscript //B hidden.vbs" is the exact shape
//            Defender's ML rule flags as Trojan:Win32/Commando, and it did.
//   macOS:   a LaunchAgent with StartInterval 300 running launch.js
//   Linux:   a systemd user timer every 5 minutes running launch.js
// launch.js exits at once when a bridge already answers. plan() is pure (what
// would be written and run); status/enable/disable act.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const LABEL = 'com.gander.bridge';
const UNIT = 'gander-bridge';
const STARTUP_NAME = 'gander-bridge.vbs';

function plan(o = {}) {
  const platform = o.platform || process.platform;
  const node = o.node || process.execPath;
  const launcher = o.launcher || path.join(__dirname, 'launch.js');
  const keeper = o.keeper || path.join(__dirname, 'keeper.js');
  const port = String(o.port || 3131);
  const home = o.home || os.homedir();
  const P = platform === 'win32' ? path.win32 : path.posix;   // plan for the target platform, wherever this runs
  if (platform === 'win32') {
    const startup = P.join(o.appData || process.env.APPDATA || P.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const file = P.join(startup, STARTUP_NAME);
    const content = [
      "' Gander: starts the bridge keeper at logon (Settings → Advanced → Keep the bridge running). Delete this file to stop.",
      'Set sh = CreateObject("WScript.Shell")',
      'Set env = sh.Environment("PROCESS")',
      'env("GANDER_NO_OPEN") = "1"',
      `env("AOC_PORT") = "${port}"`,
      `sh.Run """${node}"" ""${keeper}""", 0, False`,
      '',
    ].join('\r\n');
    return {
      how: 'a launcher in your Startup folder runs the keeper (checks every minute) at logon',
      files: [{ path: file, content }],
      enable: [],
      startNow: { node, keeper, port },
      disable: [],
      query: null,
      removeOnDisable: [file],
    };
  }
  if (platform === 'darwin') {
    const plist = P.join(home, 'Library', 'LaunchAgents', LABEL + '.plist');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${launcher}</string></array>
  <key>EnvironmentVariables</key><dict><key>GANDER_NO_OPEN</key><string>1</string><key>AOC_PORT</key><string>${port}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
</dict></plist>
`;
    return {
      how: 'macOS LaunchAgent ' + LABEL + ', at login and every 5 minutes',
      files: [{ path: plist, content }],
      enable: [['launchctl', ['load', '-w', plist]]],
      disable: [['launchctl', ['unload', '-w', plist]]],
      query: ['launchctl', ['list', LABEL]],
      removeOnDisable: [plist],
    };
  }
  const udir = P.join(home, '.config', 'systemd', 'user');
  const service = P.join(udir, UNIT + '.service');
  const timer = P.join(udir, UNIT + '.timer');
  return {
    how: 'systemd user timer ' + UNIT + '.timer, at login and every 5 minutes',
    files: [
      { path: service, content: `[Unit]\nDescription=Gander bridge keeper (starts the bridge if it is not running)\n\n[Service]\nType=oneshot\nEnvironment=GANDER_NO_OPEN=1\nEnvironment=AOC_PORT=${port}\nExecStart=${node} ${launcher}\n` },
      { path: timer, content: `[Unit]\nDescription=Run the Gander bridge keeper every 5 minutes\n\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=5min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n` },
    ],
    enable: [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', UNIT + '.timer']]],
    disable: [['systemctl', ['--user', 'disable', '--now', UNIT + '.timer']]],
    query: ['systemctl', ['--user', 'is-enabled', UNIT + '.timer']],
    removeOnDisable: [service, timer],
  };
}

function run(argv) {
  const [cmd, args] = argv;
  return execFileSync(cmd, args, { windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function keeperPid(port) {
  try { const pid = Number(fs.readFileSync(path.join(os.tmpdir(), `gander-keeper-${port || 3131}.lock`), 'utf8')); if (pid) { process.kill(pid, 0); return pid; } } catch (_) {}
  return 0;
}

function status(o = {}) {
  const p = plan(o);
  if (!p.query) {   // windows: the Startup file is the switch; the keeper's pid says whether it is running right now
    const installed = p.files.every((f) => fs.existsSync(f.path));
    const pid = keeperPid(o.port);
    return { enabled: installed, how: p.how, detail: installed ? (pid ? `keeper running (pid ${pid})` : 'keeper starts at next logon') : '' };
  }
  try { const out = run(p.query); return { enabled: !/could not be found|not found|disabled|No such/i.test(out), how: p.how, detail: out.trim().split('\n').slice(0, 3).join(' · ').slice(0, 200) }; }
  catch (e) { return { enabled: false, how: p.how, detail: '' }; }
}

function enable(o = {}) {
  const p = plan(o);
  try {
    for (const f of p.files) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.writeFileSync(f.path, f.content); }
    for (const c of p.enable) run(c);
    if (p.startNow && !keeperPid(o.port)) {
      spawn(p.startNow.node, [p.startNow.keeper], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, GANDER_NO_OPEN: '1', AOC_PORT: p.startNow.port } }).unref();
    }
    return { ok: true, enabled: true, how: p.how };
  } catch (e) { return { ok: false, enabled: false, how: p.how, error: String(e.stderr || e.message || e).trim().slice(0, 300) }; }
}

function disable(o = {}) {
  const p = plan(o);
  let error = '';
  for (const c of p.disable) { try { run(c); } catch (e) { error = String(e.stderr || e.message || e).trim().slice(0, 300); } }
  for (const f of p.removeOnDisable || []) { try { fs.unlinkSync(f); } catch (_) {} }
  const pid = keeperPid(o.port);
  if (pid) { try { process.kill(pid); } catch (_) {} }
  const still = status(o).enabled;
  return { ok: !still, enabled: still, how: p.how, error: still ? error : '' };
}

module.exports = { plan, status, enable, disable, keeperPid, LABEL, UNIT, STARTUP_NAME };
