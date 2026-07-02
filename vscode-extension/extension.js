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

let panel = null;
// `src` is an asExternalUri()-resolved URL (webviews block a raw http://localhost iframe;
// the resolved URI is one the sandbox permits — and works under Remote/Codespaces too).
function html(src) {
  let origin = src; try { origin = new URL(src).origin; } catch (_) {}
  const csp = `default-src 'none'; frame-src ${origin} http://localhost:* http://127.0.0.1:*; style-src 'unsafe-inline';`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;padding:0;height:100%;background:#0b0b0d}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head><body><iframe src="${src}" allow="clipboard-read; clipboard-write; microphone"></iframe></body></html>`;
}

async function openPanel(context) {
  const url = bridgeUrl();
  const up = await ensureBridge(context);
  if (!up) {
    vscode.window.showWarningMessage(
      `Gander bridge isn't reachable at ${url}. Start a Claude Code session (its hook launches the bridge), or run "node bridge/launch.js" from the repo, then run "Gander: Reload Dashboard". You can also set gander.bridgePath.`
    );
  }
  const port = portOf(url);
  // Resolve to a webview-permitted URL (handles the sandbox + remote tunnelling).
  let src = url;
  try { src = (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString().replace(/\/+$/, ''); } catch (_) {}
  if (panel) { panel.reveal(vscode.ViewColumn.Active); panel.webview.html = html(src); return; }
  panel = vscode.window.createWebviewPanel('gander', 'Gander', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    portMapping: [{ webviewPort: port, extensionHostPort: port }],
  });
  panel.webview.html = html(src);
  panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
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
