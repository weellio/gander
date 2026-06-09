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
  [switch]$DryRun
)

try {
  $state = Invoke-RestMethod -Uri "http://localhost:$Port/api/state" -TimeoutSec 5
} catch {
  Write-Host "[nudge] bridge not reachable on :$Port - is Hivemind running?"
  exit 0
}

# idle root sessions (orchestrators)
$idle = @($state.agents | Where-Object { $_.root -eq $true -and $_.state -eq 'idle' })

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

$wsh = New-Object -ComObject WScript.Shell

foreach ($a in $targets) {
  $title = $a.project
  if (-not $title) { continue }
  Write-Host "[nudge] '$Text' -> window matching '$title' (session $($a.sessionId))"
  if ($DryRun) { continue }
  if ($wsh.AppActivate($title)) {
    Start-Sleep -Milliseconds 350
    $wsh.SendKeys($Text)
    Start-Sleep -Milliseconds 120
    $wsh.SendKeys('{ENTER}')
    Start-Sleep -Milliseconds 200
  } else {
    Write-Host "  [nudge] no window matched '$title' - open it or pass -Match"
  }
}
