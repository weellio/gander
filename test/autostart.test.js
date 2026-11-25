'use strict';
// The bridge keeper: what gets written and run on each platform, without running it;
// and keeper.js's one decision, launch when nothing answers.
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const autostart = require('../bridge/autostart.js');
const keeper = require('../bridge/keeper.js');

const base = { node: 'C:\\Program Files\\nodejs\\node.exe', launcher: 'D:\\gander\\bridge\\launch.js', keeper: 'D:\\gander\\bridge\\keeper.js', port: 3131, home: 'C:\\Users\\b', appData: 'C:\\Users\\b\\AppData\\Roaming' };

test('windows: a launcher in the Startup folder that runs keeper.js hidden; no Scheduled Task, no schtasks', () => {
  const p = autostart.plan({ ...base, platform: 'win32' });
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].path, 'C:\\Users\\b\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\gander-bridge.vbs');
  const vbs = p.files[0].content;
  assert.match(vbs, /GANDER_NO_OPEN"\) = "1"/, 'the keeper never pops a browser tab');
  assert.match(vbs, /AOC_PORT"\) = "3131"/);
  assert.match(vbs, /sh\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""D:\\gander\\bridge\\keeper\.js""", 0, False/, 'window style 0 = no console');
  assert.deepEqual(p.enable, [], 'nothing to run: the file in Startup is the whole mechanism');
  assert.ok(!JSON.stringify(p).includes('schtasks'), 'never a scheduled task (Defender flags that shape)');
  assert.deepEqual(p.startNow, { node: base.node, keeper: base.keeper, port: '3131' });
  assert.deepEqual(p.removeOnDisable, [p.files[0].path]);
});

test('macOS: a LaunchAgent that runs at load and every 300 s', () => {
  const p = autostart.plan({ ...base, platform: 'darwin', node: '/usr/local/bin/node', launcher: '/Users/b/gander/bridge/launch.js', home: '/Users/b' });
  assert.equal(p.files[0].path, '/Users/b/Library/LaunchAgents/com.gander.bridge.plist');
  assert.match(p.files[0].content, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(p.files[0].content, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p.files[0].content, /GANDER_NO_OPEN/);
  assert.deepEqual(p.enable[0], ['launchctl', ['load', '-w', '/Users/b/Library/LaunchAgents/com.gander.bridge.plist']]);
});

test('linux: a systemd user service + timer, enabled now', () => {
  const p = autostart.plan({ ...base, platform: 'linux', node: '/usr/bin/node', launcher: '/home/b/gander/bridge/launch.js', home: '/home/b' });
  const names = p.files.map((f) => f.path);
  assert.ok(names.includes('/home/b/.config/systemd/user/gander-bridge.service') && names.includes('/home/b/.config/systemd/user/gander-bridge.timer'));
  assert.match(p.files[0].content, /ExecStart=\/usr\/bin\/node \/home\/b\/gander\/bridge\/launch\.js/);
  assert.match(p.files[1].content, /OnUnitActiveSec=5min/);
  assert.deepEqual(p.enable[1], ['systemctl', ['--user', 'enable', '--now', 'gander-bridge.timer']]);
});

test('keeper.check(): launches when nothing answers, leaves a live bridge alone', async () => {
  const free = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  let launched = 0;
  await new Promise((resolve) => keeper.check(free, () => launched++, resolve));
  assert.equal(launched, 1, 'nothing on the port: launch');
  const srv = http.createServer((req, res) => { res.writeHead(req.url === '/api/state' ? 200 : 404); res.end('{}'); });
  await new Promise((r) => srv.listen(free, '127.0.0.1', r));
  await new Promise((resolve) => keeper.check(free, () => launched++, resolve));
  assert.equal(launched, 1, 'a bridge answered: no launch');
  await new Promise((r) => srv.close(r));
});
