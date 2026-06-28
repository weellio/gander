<#
  Gander — wake idle Claude Code sessions so queued messages get delivered.

  Gander can only inject a queued reply when a session's Stop hook fires, which needs the
  session to actually run a turn. A parked (idle) session never runs on its own, so queued
  messages wait. This asks the bridge which root sessions are idle, finds the matching window
  by project name, and types a nudge ("check running jobs") + Enter to start a turn — which
  flushes any queued dashboard/Telegram messages at that turn's Stop.

  CAVEATS: uses WScript.Shell AppActivate + SendKeys, so it briefly STEALS FOCUS of the matched
  window and types into whatever control is focused there. Keep the Claude terminal focused in
  that window. Window match is by project name in the title (great for VS Code). Try -DryRun first.

  Params: -Port 3131  -Text 'check running jobs'  -OnlyPending  -Match '<title>'  -DryRun

  Schedule every 10 min with NO window flash — run it through the hidden VBS launcher
  (powershell -WindowStyle Hidden still flashes a console; wscript.exe does not):
    schtasks /Create /TN "Gander Nudge" /TR "wscript.exe \"%CD%\scripts\nudge-idle-hidden.vbs\" -OnlyPending" /SC MINUTE /MO 10 /F
    schtasks /Delete /TN "Gander Nudge" /F      # remove
#>
param(
  [int]$Port = 3131,
  [string]$Text = 'check running jobs',
  [switch]$OnlyPending,
  [string]$Match = '',
  [int]$MinIdleSec = 120,   # a session you're conversing in goes 'idle' between turns; only nudge ones parked longer than this
  [switch]$DryRun
)

try {
  $state = Invoke-RestMethod -Uri "http://localhost:$Port/api/state" -TimeoutSec 5
} catch {
  Write-Host "[nudge] bridge not reachable on :$Port - is Gander running?"
  exit 0
}

# idle root sessions (orchestrators) that have been parked a while. A session you're
# actively working in flips to 'idle' between turns, so skip ones updated recently —
# don't type into the conversation you're in the middle of.
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$idle = @($state.agents | Where-Object {
  $_.root -eq $true -and $_.state -eq 'idle' -and
  $_.updatedAt -and (($nowMs - [double]$_.updatedAt) -gt ($MinIdleSec * 1000))
})

# optionally keep only those with a queued message waiting
if ($OnlyPending) {
  $pending = $state.pending
  $names = @()
  if ($pending) { $names = $pending.PSObject.Properties.Name }
  $kept = @()
  foreach ($x in $idle) {
    $sid = $x.sessionId
    if ($sid -and ($names -contains $sid) -and ($pending.$sid -gt 0)) { $kept += $x }
  }
  $idle = $kept
}

# build the target list
$targets = $idle
if ($Match -ne '') {
  $targets = @([pscustomobject]@{ project = $Match; sessionId = '(match)' })
}

if (@($targets).Count -eq 0) {
  Write-Host "[nudge] nothing to nudge"
  exit 0
}

# AppActivate only matches a title that STARTS or ENDS with the string, but the
# project name sits in the MIDDLE of a VS Code title ("<tab> - <folder> - Visual
# Studio Code"). So we enumerate visible windows, find one whose title CONTAINS the
# project name, and activate it by PID (AppActivate accepts a PID and keeps its
# reliable focus-stealing). Works for VS Code, Windows Terminal, etc.
try {
  Add-Type -ErrorAction Stop @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class HmWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static uint ForegroundPid() { IntPtr h = GetForegroundWindow(); uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  // Returns a pid ONLY when exactly one process has a visible window whose title contains
  // the needle. Multiple matches (e.g. several VS Code windows) -> 0, so we never guess
  // and type into the wrong window. Same process with several matching windows is fine.
  public static uint FindPid(string needle) {
    var pids = new HashSet<uint>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
        uint pid; GetWindowThreadProcessId(h, out pid); pids.Add(pid);
      }
      return true;
    }, IntPtr.Zero);
    if (pids.Count != 1) return 0;
    var e = pids.GetEnumerator(); e.MoveNext(); return e.Current;
  }
}
"@
} catch {}

# SendKeys treats + ^ % ~ ( ) { } [ ] specially; escape them so a real reply types verbatim.
function EscapeKeys([string]$s) {
  if (-not $s) { return '' }
  $s = $s -replace "[\r\n]+", ' '                 # collapse to one line so a single ENTER submits it
  $out = New-Object System.Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) {
    if ('+^%~(){}[]'.IndexOf($ch) -ge 0) { [void]$out.Append('{').Append($ch).Append('}') }
    else { [void]$out.Append($ch) }
  }
  $out.ToString()
}

$wsh = New-Object -ComObject WScript.Shell

foreach ($a in $targets) {
  $title = $a.project
  # prefer the PID captured at launch (survives Claude renaming the terminal title);
  # else match the window by project name, but ONLY when exactly one window matches.
  $procId = 0
  if ($a.winPid) { $procId = [int]$a.winPid }
  if ((-not $procId) -and $title) { $procId = [HmWin]::FindPid($title) }
  if (-not $procId) {
    Write-Host "  [nudge] no unique window for '$title' - skipping (it'll deliver on the session's next turn, never the wrong window)"
    continue
  }
  if ($procId -eq [HmWin]::ForegroundPid()) {
    Write-Host "  [nudge] skipping '$title' - it's your active (foreground) window"
    continue
  }
  if ($DryRun) { Write-Host "[nudge dry] would target pid $procId for '$title' (session $($a.sessionId))"; continue }
  # Activate the exact window FIRST; only then pull the queued reply, so we never dequeue a
  # message we can't actually deliver.
  if ($wsh.AppActivate([int]$procId)) {
    $payload = $Text
    if ($OnlyPending -and $a.sessionId -and $a.sessionId -ne '(match)') {
      try { $payload = (Invoke-RestMethod -Uri "http://localhost:$Port/api/wake-deliver" -Method Post -Body (@{ sessionId = $a.sessionId } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 5).text } catch { $payload = '' }
      if (-not $payload) { Write-Host "  [nudge] no queued message for $($a.sessionId) - skipping"; continue }
    }
    Write-Host "[nudge] delivering to '$title' (pid $procId, session $($a.sessionId))"
    Start-Sleep -Milliseconds 350
    $wsh.SendKeys((EscapeKeys $payload))
    Start-Sleep -Milliseconds 120
    $wsh.SendKeys('{ENTER}')
    Start-Sleep -Milliseconds 200
  } else {
    Write-Host "  [nudge] found pid $procId but could not activate it"
  }
}
