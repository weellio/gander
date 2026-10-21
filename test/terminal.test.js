'use strict';
// bridge/terminal.js — opening a terminal window per platform, with the quoting that
// used to break macOS and Linux launches silently whenever a task was given.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../bridge/terminal.js');

const inner = 'claude --permission-mode plan "fix the failing tests in src/app.js"';

test('macOS: the whole shell line is one AppleScript string with inner quotes escaped', () => {
  const s = T.launchSpec({ platform: 'darwin', cwd: '/Users/b/proj', inner });
  assert.equal(s.cmd, 'osascript');
  assert.equal(s.args[0], '-e');
  const script = s.args[1];
  assert.match(script, /^tell app "Terminal" to do script "/);
  assert.ok(script.endsWith('"'), 'the AppleScript string is closed');
  assert.ok(script.includes('\\"fix the failing tests in src/app.js\\"'), 'inner double quotes are escaped: ' + script);
  assert.ok(script.includes("cd '/Users/b/proj'"), 'cwd is single-quoted for the shell');
  assert.ok(script.includes(T.UNSET), 'the nested-session guard is kept');
  // an AppleScript string must not contain an unescaped double quote between its delimiters
  const body = script.slice(script.indexOf('do script "') + 'do script "'.length, -1);
  assert.equal(body.replace(/\\"/g, '').includes('"'), false, 'no unescaped quote inside: ' + body);
});

test('macOS: a cwd with a single quote survives shell quoting', () => {
  const s = T.launchSpec({ platform: 'darwin', cwd: "/Users/b/it's here", inner: 'claude' });
  // the shell form is cd '/Users/b/it'\''s here'; inside the AppleScript string its backslash is doubled
  assert.ok(s.args[1].includes("cd '/Users/b/it'\\\\''s here'"), s.args[1]);
});

test('Linux: the first terminal on PATH is used, and the script is passed safely', () => {
  const have = new Set(['gnome-terminal', 'xterm']);
  const find = (bin) => (have.has(bin) ? '/usr/bin/' + bin : '');
  const s = T.launchSpec({ platform: 'linux', cwd: '/home/b/proj', inner, find });
  assert.equal(s.cmd, 'gnome-terminal', 'x-terminal-emulator is missing, gnome-terminal is next');
  assert.deepEqual(s.args.slice(0, 3), ['--', 'bash', '-c']);
  assert.ok(s.args[3].includes(inner) && s.args[3].endsWith('exec bash'), s.args[3]);
  const x = T.launchSpec({ platform: 'linux', cwd: '/home/b/proj', inner, find: (b) => (b === 'xterm' ? '/usr/bin/xterm' : '') });
  assert.equal(x.cmd, 'xterm');
  assert.equal(x.args[0], '-e');
  assert.match(x.args[1], /^bash -c '/, 'one argument, single-quoted for -e terminals');
  assert.ok(x.args[1].includes('"fix the failing tests in src/app.js"'), 'inner double quotes stay intact inside single quotes');
});

test('Linux: no terminal at all is an error that says what to run by hand, not a silent ok', () => {
  const s = T.launchSpec({ platform: 'linux', cwd: '/home/b/proj', inner, find: () => '' });
  assert.ok(s.error);
  assert.match(s.error, /no terminal emulator found/);
  assert.ok(s.error.includes(inner));
});

test('Windows: unchanged start/cmd line', () => {
  const s = T.launchSpec({ platform: 'win32', cwd: 'D:\\proj', inner, title: 'Gander: proj' });
  assert.equal(s.shell, true);
  assert.equal(s.cmd, `start "Gander: proj" cmd /k ${inner}`);
});

test('shellQuote and appleScriptQuote', () => {
  assert.equal(T.shellQuote("a'b"), "'a'\\''b'");
  assert.equal(T.appleScriptQuote('say "hi" \\ there'), 'say \\"hi\\" \\\\ there');
  assert.equal(typeof T.findOnPath('definitely-not-a-binary-xyz'), 'string');
});
