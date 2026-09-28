// one-off: patch the VS Code extension's status bar (kept out of the shell to avoid quoting damage)
const fs = require('fs');
const p = process.argv[2];
let s = fs.readFileSync(p, 'utf8');
const oldSb = `  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sb.text = '$(rocket) Gander';
  sb.tooltip = 'Open the Gander dashboard';
  sb.command = 'gander.open';
  sb.show();
  context.subscriptions.push(sb);`;
if (!s.includes(oldSb)) throw new Error('status bar block not found');
s = s.replace(oldSb, `  // The status bar item used to be a second "open dashboard" button — the same
  // thing the sidebar goose already does. It now earns its place: a live count of
  // what needs you, readable without opening anything. Click still opens the panel.
  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sb.command = 'gander.open';
  context.subscriptions.push(sb);
  const refresh = () => statusTick(sb);
  refresh();
  const timer = setInterval(refresh, 15000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  context.subscriptions.push(vscode.window.onDidChangeWindowState((w) => { if (w.focused) refresh(); }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('gander')) refresh(); }));`);
const anchor = 'function activate(context) {';
s = s.replace(anchor, `// /api/statusline: the same small payload the terminal status line uses.
function getJson(url, pathName) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.get({ host: u.hostname, port: u.port || 80, path: pathName, timeout: 2500 }, (r) => {
        let b = ''; r.on('data', (d) => (b += d));
        r.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch (_) { resolve(null); }
  });
}

async function statusTick(sb) {
  if (!cfg().get('statusBar')) { sb.hide(); return; }
  if (!vscode.window.state.focused && sb._seen) return;   // background windows: skip the poll, keep the last value
  const j = await getJson(bridgeUrl(), '/api/statusline');
  sb._seen = true;
  if (!j) {
    sb.text = '$(circle-slash) Gander';
    sb.tooltip = 'Gander bridge is not running — click to open (it starts the bridge)';
    sb.backgroundColor = undefined;
  } else {
    const n = Number(j.needsYou) || 0;
    const parts = [];
    if (j.running) parts.push(j.running + ' running');
    if (j.queued) parts.push(j.queued + ' queued');
    if (j.review) parts.push(j.review + ' waiting for review');
    if (j.escalations) parts.push(j.escalations + ' escalation' + (j.escalations === 1 ? '' : 's'));
    sb.text = n ? '$(bell-dot) Gander ' + n : '$(check) Gander';
    sb.tooltip = (n ? n + (n === 1 ? ' thing needs' : ' things need') + ' you' : 'Nothing needs you')
      + (parts.length ? ' · ' + parts.join(' · ') : '') + '\nClick to open the dashboard';
    // warningBackground is a theme color, so it follows light/dark/high-contrast themes
    sb.backgroundColor = n ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }
  sb.show();
}

function activate(context) {`);
fs.writeFileSync(p, s);
console.log('patched', p);
