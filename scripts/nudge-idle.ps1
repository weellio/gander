<#
  Hivemind — wake idle Claude Code sessions so queued messages get delivered.

  Hivemind can only inject a queued reply when a session's Stop hook fires, which needs the
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
    schtasks /Create /TN "Hivemind Nudge" /TR "wscript.exe \"%CD%\scripts\nudge-idle-hidden.vbs\" -OnlyPending" /SC MINUTE /MO 10 /F
    schtasks /Delete /TN "Hivemind Nudge" /F      # remove
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
  Write-Host "[nudge] bridge not reachable on :$Port - is Hivemind running?"
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
  public static uint FindPid(string needle) {
    uint found = 0;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
        uint pid; GetWindowThreadProcessId(h, out pid); found = pid; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
} catch {}

$wsh = New-Object -ComObject WScript.Shell

foreach ($a in $targets) {
  $title = $a.project
  if (-not $title) { continue }
  $procId = [HmWin]::FindPid($title)
  if (-not $procId) {
    Write-Host "  [nudge] no open window contains '$title' - is that session's VS Code/terminal open?"
    continue
  }
  if ($procId -eq [HmWin]::ForegroundPid()) {
    Write-Host "  [nudge] skipping '$title' - it's your active (foreground) window"
    continue
  }
  Write-Host "[nudge] '$Text' -> window containing '$title' (pid $procId, session $($a.sessionId))"
  if ($DryRun) { continue }
  if ($wsh.AppActivate([int]$procId)) {
    Start-Sleep -Milliseconds 350
    $wsh.SendKeys($Text)
    Start-Sleep -Milliseconds 120
    $wsh.SendKeys('{ENTER}')
    Start-Sleep -Milliseconds 200
  } else {
    Write-Host "  [nudge] found pid $procId but could not activate it"
  }
}
