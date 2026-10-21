'use strict';
// How a new terminal window running a command is opened on each platform.
// Pure: returns what to spawn, never spawns. server.js's launchSession uses it,
// and test/terminal.test.js pins the quoting, which is where macOS and Linux
// launches used to break silently (a task's inner quotes ended the outer string).

const fs = require('fs');
const path = require('path');

const UNSET = 'unset CLAUDECODE CLAUDE_CODE_SSE_PORT CLAUDE_CODE_ENTRYPOINT';

// AppleScript string literal escaping: backslash and double quote.
const appleScriptQuote = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
// POSIX single-quote escaping: the one safe way to pass arbitrary text to `bash -c`.
const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// Linux terminals in preference order, with how each takes a command.
const LINUX_TERMINALS = [
  { bin: 'x-terminal-emulator', args: (script) => ['-e', `bash -c ${shellQuote(script)}`] },
  { bin: 'gnome-terminal', args: (script) => ['--', 'bash', '-c', script] },
  { bin: 'konsole', args: (script) => ['-e', 'bash', '-c', script] },
  { bin: 'xfce4-terminal', args: (script) => ['-e', `bash -c ${shellQuote(script)}`] },
  { bin: 'kitty', args: (script) => ['-e', 'bash', '-c', script] },
  { bin: 'alacritty', args: (script) => ['-e', 'bash', '-c', script] },
  { bin: 'xterm', args: (script) => ['-e', `bash -c ${shellQuote(script)}`] },
];

function findOnPath(bin, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { if (fs.existsSync(path.join(dir, bin))) return path.join(dir, bin); } catch (_) {}
  }
  return '';
}

// -> { cmd, args, shell } to spawn, or { error }.
// `inner` is the command to run in the new window (e.g. `claude "do the thing"`), `title` the window title.
function launchSpec({ platform = process.platform, cwd, inner, title = 'Claude', find = findOnPath }) {
  if (platform === 'win32') {
    return { cmd: `start "${String(title).replace(/"/g, '')}" cmd /k ${inner}`, args: [], shell: true };
  }
  if (platform === 'darwin') {
    const script = `cd ${shellQuote(cwd)} && ${UNSET} && ${inner}`;
    return { cmd: 'osascript', args: ['-e', `tell app "Terminal" to do script "${appleScriptQuote(script)}"`], shell: false };
  }
  const script = `cd ${shellQuote(cwd)}; ${UNSET}; ${inner}; exec bash`;
  for (const t of LINUX_TERMINALS) {
    if (find(t.bin)) return { cmd: t.bin, args: t.args(script), shell: false };
  }
  return { error: `no terminal emulator found on PATH (looked for ${LINUX_TERMINALS.map((t) => t.bin).join(', ')}); open a terminal and run: cd ${shellQuote(cwd)} && ${inner}` };
}

module.exports = { launchSpec, appleScriptQuote, shellQuote, findOnPath, LINUX_TERMINALS, UNSET };
