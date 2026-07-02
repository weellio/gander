// Gander VS Code extension — a THIN wrapper: it loads the same dashboard the bridge
// already serves (localhost:3131) into a webview panel, so VS Code users get Gander
// next to their editor + integrated terminal. No forked app: the bridge + dashboard
// are identical to the standalone web version. Zero npm deps (vscode + node built-ins).
'use strict';
const vscode = require('vscode');
const http = require('http');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

function cfg() { return vscode.workspace.getConfiguration('gander'); }
function bridgeUrl() { return (cfg().get('url') || 'http://localhost:3131').replace(/\/+$/, ''); }
function portOf(url) { try { return Number(new URL(url).port) || 80; } catch (_) { return 3131; } }

// Is the bridge answering on /api/state?
function ping(url) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.get({ host: u.hostname, port: u.port || 80, path: '/api/state', timeout: 1500 }, (r) => { r.resume(); resolve((r.statusCode || 0) > 0); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch (_) { resolve(false); }
  });
}

// Find bridge/launch.js — configured path first, then relative to the extension when
// it's running from inside the Gander repo (…/vscode-extension → …/bridge/launch.js).
function findBridge(context) {
  const candidates = [
    cfg().get('bridgePath'),
    path.join(context.extensionPath, '..', 'bridge', 'launch.js'),
    path.join(context.extensionPath, 'bridge', 'launch.js'),
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

async function ensureBridge(context) {
  const url = bridgeUrl();
  if (await ping(url)) return true;
  if (!cfg().get('autostart')) return false;
  const launch = findBridge(context);
  if (!launch) return false;
  try {
    // Run the bridge with VS Code's bundled Node (no dependency on `node` being on PATH).
    const child = cp.spawn(process.execPath, [launch], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  } catch (_) { return false; }
  for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 500)); if (await ping(url)) return true; }
  return false;
}

// Open the dashboard in VS Code's built-in Simple Browser — a webview that's purpose-built
// to load external URLs (incl. localhost), so we don't hand-roll an iframe/CSP. It opens as
// an editor tab next to your code + terminal. asExternalUri handles Remote/Codespaces.
async function openPanel(context) {
  const url = bridgeUrl();
  const up = await ensureBridge(context);
  if (!up) {
    vscode.window.showWarningMessage(
      `Gander bridge isn't reachable at ${url}. Start a Claude Code session (its hook launches the bridge), or run "node bridge/launch.js" from the repo, then run "Gander: Open Dashboard". You can also set gander.bridgePath.`
    );
  }
  let src = url;
  try { src = (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString(); } catch (_) {}
  try {
    await vscode.commands.executeCommand('simpleBrowser.show', src);
  } catch (e) {
    vscode.window.showErrorMessage(`Gander: could not open the Simple Browser (${e && e.message}). Open ${url} in a browser instead.`);
  }
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('gander.open', () => openPanel(context)));
  context.subscriptions.push(vscode.commands.registerCommand('gander.reload', () => openPanel(context)));

  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sb.text = '$(rocket) Gander';
  sb.tooltip = 'Open the Gander dashboard';
  sb.command = 'gander.open';
  sb.show();
  context.subscriptions.push(sb);

  if (cfg().get('openOnStartup')) openPanel(context);
}
function deactivate() {}
module.exports = { activate, deactivate };
