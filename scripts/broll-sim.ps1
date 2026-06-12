<#
  B-roll director for the Gander launch video.
  Drives the LIVE dashboard through each narration beat so you can screen-record
  footage that matches the script. Each scene pauses first so you can switch the
  dashboard view and start recording, then animates continuously until YOU press
  Enter to advance -- you set the pace, no fixed timers.

  Realism: this stages FIVE concurrent Claude sessions (orchestrators) with
  different-sized swarms (9 / 5 / 3 / 2 / 0 sub-agents) -- like a real machine
  with several sessions going at once -- plus a couple of sub-agent trees.

  Run all scenes in order (recommended for a full capture session):
      powershell -ExecutionPolicy Bypass -File scripts\broll-sim.ps1

  Re-shoot ONE scene (1 = grid, 2 = floor, 4 = rogue/stop, 6 = full swarm):
      powershell -ExecutionPolicy Bypass -File scripts\broll-sim.ps1 -Scene 2

  Remove every demo agent this script created:
      powershell -ExecutionPolicy Bypass -File scripts\broll-sim.ps1 -Clear

  TIP: in the dashboard top-bar project filter, pick "gander-broll" so only
       the demo sessions show and your real session tile is hidden.
#>
param([int]$Port = 3131, [int]$Scene = 0, [switch]$Clear)

$ErrorActionPreference = 'SilentlyContinue'
$base = "http://localhost:$Port/api/event"
$repo = Split-Path $PSScriptRoot -Parent
$proj = 'gander-broll'

function ev($h) {
  try { Invoke-RestMethod -Uri $base -Method Post -Body ($h | ConvertTo-Json -Compress) -ContentType 'application/json' -TimeoutSec 3 | Out-Null } catch {}
}
function RemoveAgent($id) { ev @{ agentId = $id; remove = $true } }

# ── the five concurrent sessions (orchestrator roots) + their swarm sizes ──────
# Names read like real projects; all share one project tag so the filter + the
# -Clear sweep stay simple. One session is "solo" (swarm 0) to show that layout.
$sessions = @(
  @{ id = 'broll-s1'; name = 'WaivePulse';       swarm = 9; sessionId = [guid]::NewGuid().Guid }
  @{ id = 'broll-s2'; name = 'VideoGen';         swarm = 5; sessionId = [guid]::NewGuid().Guid }
  @{ id = 'broll-s3'; name = 'aiworkernow';      swarm = 3; sessionId = [guid]::NewGuid().Guid }
  @{ id = 'broll-s4'; name = 'Youtube-Insights'; swarm = 2; sessionId = [guid]::NewGuid().Guid }
  @{ id = 'broll-s5'; name = 'WaivePulse-Piano'; swarm = 0; sessionId = [guid]::NewGuid().Guid }
)
# sub-agent trees (depth) hung under specific workers that exist above
$subs = @(
  @{ id = 'broll-s1-w0-a'; name = 'FileIndexer'; parent = 'broll-s1-w0'; state = 'reading' }
  @{ id = 'broll-s1-w0-b'; name = 'TestRunner';  parent = 'broll-s1-w0'; state = 'testing' }
  @{ id = 'broll-s2-w0-a'; name = 'Reviewer';    parent = 'broll-s2-w0'; state = 'thinking' }
)

function WorkerIds {
  $w = @()
  foreach ($s in $sessions) { for ($i = 0; $i -lt $s.swarm; $i++) { $w += ($s.id + "-w$i") } }
  return $w
}
function AllIds {
  $a = @()
  foreach ($s in $sessions) { $a += $s.id }
  $a += (WorkerIds)
  foreach ($x in $subs) { $a += $x.id }
  $a += 'broll-rogue'
  return $a
}
function PoolIds { return @((WorkerIds) + ($subs | ForEach-Object { $_.id })) }
function RootIds { return @($sessions | ForEach-Object { $_.id }) }

function Cleanup {
  # roots are kept-on-remove by the bridge; demote them first so they fully delete
  foreach ($s in $sessions) { ev @{ agentId = $s.id; root = $false } }
  foreach ($id in (AllIds)) { RemoveAgent $id }
}

function Pause($msg) { Write-Host ""; [void](Read-Host ">> $msg  (press Enter)") }

# Non-blocking Enter detection so a scene can animate continuously until YOU advance
# it (manual pacing -- no fixed recording timer).
function DrainKeys { try { while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) } } catch {} }
function EnterPressed {
  try { while ([Console]::KeyAvailable) { if (([Console]::ReadKey($true)).Key -eq 'Enter') { return $true } } } catch {}
  return $false
}

# NOTE: valid states are idle/thinking/coding/spawning/reading/error/testing/done/awaiting.
# There is no 'running' state -- the bridge maps bash/exec to coding or testing.
$work = @('coding', 'reading', 'testing', 'thinking', 'spawning')
$logs = @{
  coding   = @('writing parser.js', 'editing server.js', 'patching the route', 'refactoring upsert()', 'npm run build')
  reading  = @('reading 42 files', 'scanning the repo', 'opening README.md', 'inspecting .claude')
  testing  = @('node --test', 'running the suite', 'checking assertions', '14 passing', 'git status')
  thinking = @('planning the change', 'reading context', 'deciding next step')
  spawning = @('dispatching a sub-agent', 'handing off work', 'delegating task')
}

# Stand up all five sessions + their swarms + sub-agent trees.
function BuildAll {
  foreach ($s in $sessions) {
    ev @{ agentId = $s.id; name = $s.name; root = $true; project = $proj; cwd = $repo; sessionId = $s.sessionId; state = 'spawning'; log = ("coordinating " + $s.name) }
  }
  Start-Sleep -Milliseconds 250
  foreach ($s in $sessions) { for ($i = 0; $i -lt $s.swarm; $i++) { ev @{ agentId = ($s.id + "-w$i"); name = 'general-purpose'; parentId = $s.id; project = $proj; state = 'spawning' } } }
  Start-Sleep -Milliseconds 250
  foreach ($x in $subs) { ev @{ agentId = $x.id; name = $x.name; parentId = $x.parent; project = $proj; state = $x.state; log = 'sub-agent' } }
}

# Cycle every worker across the five swarms continuously until the user presses
# Enter to advance. Optionally retire/respawn some workers for clock-out churn.
function AnimateUntilEnter($respawn, $label) {
  DrainKeys
  Write-Host ("[REC] {0}" -f $label) -ForegroundColor Green
  Write-Host "      recording... press Enter to advance to the next scene." -ForegroundColor Green
  $pool = PoolIds
  $roots = RootIds
  while (-not (EnterPressed)) {
    $id = $pool | Get-Random
    if ($respawn -and (Get-Random -Maximum 100) -lt 10 -and $id -match '-w\d+$') {
      $parent = $id -replace '-w\d+$', ''
      ev @{ agentId = $id; state = 'done'; log = 'task complete' }   # confetti + clock out
      Start-Sleep -Milliseconds 600
      RemoveAgent $id; Start-Sleep -Milliseconds 150
      ev @{ agentId = $id; name = 'general-purpose'; parentId = $parent; project = $proj; state = 'spawning' }
    } else {
      $st = $work | Get-Random
      ev @{ agentId = $id; state = $st; log = ($logs[$st] | Get-Random) }
    }
    ev @{ agentId = ($roots | Get-Random); state = (@('thinking', 'spawning', 'coding') | Get-Random) }
    Start-Sleep -Milliseconds (Get-Random -Minimum 200 -Maximum 480)
  }
}

# ---------------------------------------------------------------- Scene 1: GRID
function Scene1 {
  Write-Host "`n=== SCENE 1: the live agent grid (hook payoff) ===" -ForegroundColor Cyan
  Write-Host "Narration: 'every session and sub-agent becomes a tile... watch the packets flow.'"
  Write-Host "DASHBOARD: switch to the Mosaic / grid view. Filter project = gander-broll."
  Write-Host "Shows 5 sessions (swarms 9/5/3/2/0) + sub-agent trees = realistic mix."
  Pause "Position the grid view, then start recording"

  BuildAll
  AnimateUntilEnter $false "5 sessions, their swarms + connectors"
}

# --------------------------------------------------------------- Scene 2: FLOOR
function Scene2 {
  Write-Host "`n=== SCENE 2: the office floor (your banger / slot-2 point) ===" -ForegroundColor Cyan
  Write-Host "Narration: 'they walk around, gather at the water cooler, clock out when idle.'"
  Write-Host "DASHBOARD: switch to the Office floor view. Five offices, different swarm sizes."
  Pause "Position the floor view, then start recording"

  BuildAll
  Start-Sleep -Milliseconds 300
  # park a few workers (idle) so they clump at the water cooler
  foreach ($id in @('broll-s1-w7', 'broll-s1-w8', 'broll-s2-w4', 'broll-s3-w2')) { ev @{ agentId = $id; state = 'idle'; log = 'waiting on input' } }

  AnimateUntilEnter $true "floor: walking + cooler clump + clock-outs"
}

# --------------------------------------------------------- Scene 3: COST (no sim)
function Scene3 {
  Write-Host "`n=== SCENE 3: cost / usage (your BEST point -- real data) ===" -ForegroundColor Cyan
  Write-Host "Narration: 'one runaway session cost more than my whole week.'"
  Write-Host "No simulation -- this panel reads your REAL ~/.claude transcripts."
  Write-Host "DASHBOARD: open Usage. Record: total + 30-day chart, then scroll to"
  Write-Host "           'priciest sessions' and hover/point at the top (red) row."
  Write-Host "TIP: your top session (~`$1019 WaivePulse) is ~26% of total spend -- strong."
  Pause "Capture the Usage panel, then Enter for the next scene"
}

# ---------------------------------------------------- Scene 4: STOP A STRAY AGENT
function Scene4 {
  Write-Host "`n=== SCENE 4: click the stuck sub-agent -> stop it (slot 3) ===" -ForegroundColor Cyan
  Write-Host "Narration: 'that sub-agent stuck in a retry loop? stopped in one click.'"
  Write-Host "DASHBOARD: grid or floor. CLICK the red erroring sub-agent in WaivePulse's"
  Write-Host "           swarm, show its modal (last message: 'attempt 47...'), then Stop."
  Pause "Get ready to record the click + Stop"

  BuildAll
  # background life on the other sub-agents
  ev @{ agentId = 'broll-s1-w1'; state = 'reading' }
  ev @{ agentId = 'broll-s1-w2'; state = 'coding' }
  ev @{ agentId = 'broll-s2-w0'; state = 'testing' }
  # The stoppable target is a STRAY SUB-AGENT stuck in a retry loop -> 'error' state
  # (red ring + !!), with a juicy last message. NO dollar amount on it: sub-agents
  # don't show cost (only sessions do), so nothing here is fabricated. The cost/spend
  # story lives in Scene 3 (the real Usage panel).
  ev @{ agentId = 'broll-rogue'; name = 'general-purpose'; parentId = 'broll-s1'; project = $proj; cwd = $repo;
       state = 'error';
       lastMessage = 'Retrying tool call (attempt 47): command timed out, re-running the same search again...';
       log = 'looping: re-running search (attempt 47)' }

  Write-Host "[LIVE] A stray sub-agent is stuck in a retry loop (red, !!) -- no dollar amount on it." -ForegroundColor Green
  Write-Host "       Click it -> read the loop in the modal -> click Stop and it CLOCKS OUT on camera." -ForegroundColor Green
  Write-Host "       (Or press Enter to advance without stopping it.)" -ForegroundColor Green
  DrainKeys
  # The rogue is a fake agent, so a real Stop has nothing to halt -- but the click
  # queues a 'stop' command on the bridge, which we watch for here and then play out
  # the stop visually (done -> clock out). Baseline the queue so leftover stops from a
  # previous take don't trigger instantly on a re-run.
  $rsid = 'broll-rogue'
  $stateUrl = "http://localhost:$Port/api/state"
  function StopCount { try { $s = Invoke-RestMethod -Uri $stateUrl -TimeoutSec 2; if ($s.pending) { $v = $s.pending.$rsid; if ($v) { return [int]$v } } } catch {}; return 0 }
  $baseStops = StopCount
  while (-not (EnterPressed)) {
    if ((StopCount) -gt $baseStops) {
      ev @{ agentId = 'broll-rogue'; state = 'done'; log = 'stopped by you -- clocking out' }
      Write-Host "[LIVE] Stop received -> sub-agent clocking out. Re-run -Scene 4 for another take." -ForegroundColor Green
      Start-Sleep -Seconds 2
      RemoveAgent 'broll-rogue'
      break
    }
    ev @{ agentId = 'broll-rogue'; state = 'error'; log = 'looping: re-running search (attempt 47)' }   # keep it stuck/alive
    # gentle background life across the other sessions
    ev @{ agentId = ((WorkerIds) | Get-Random); state = ($work | Get-Random) }
    Start-Sleep -Milliseconds 1300
  }
}

# ----------------------------------------------------- Scene 5: PANELS (no sim)
function Scene5 {
  Write-Host "`n=== SCENE 5: projects + telegram (slots 4-5, native CTA) ===" -ForegroundColor Cyan
  Write-Host "No simulation -- these are real UI panels."
  Write-Host "DASHBOARD: open Projects (show the list + a git-status chip + Start/Commit),"
  Write-Host "           then Config/Telegram. For the install beat, screen-record a"
  Write-Host "           terminal running:  setup.bat   (or ./setup.sh on Mac/Linux)."
  Pause "Capture the panels + install, then Enter for the finale"
}

# --------------------------------------------------------- Scene 6: FULL SWARM
function Scene6 {
  Write-Host "`n=== SCENE 6: full swarm finale (outro shot) ===" -ForegroundColor Cyan
  Write-Host "Narration: 'this is a real run from earlier today... your agents, finally visible.'"
  Write-Host "DASHBOARD: Office floor (or Mosaic). Five sessions, all lit. Closing hero shot."
  Pause "Position the finale view, then start recording"

  BuildAll
  Start-Sleep -Milliseconds 400
  AnimateUntilEnter $true "five sessions, all swarms lit up -- Enter triggers the confetti finish"
  # celebratory finish: a wave of completions across swarms = confetti
  Write-Host "[REC] completion wave (confetti)..." -ForegroundColor Green
  foreach ($id in ((WorkerIds) | Get-Random -Count 12)) { ev @{ agentId = $id; state = 'done'; log = 'task complete' }; Start-Sleep -Milliseconds 170 }
  Pause "That's a wrap. Enter to clean up all demo agents"
}

# ----------------------------------------------------------------------- main
if ($Clear) { Cleanup; Write-Host "[broll] cleared all demo agents."; exit 0 }

# reachable?
try { Invoke-RestMethod -Uri "http://localhost:$Port/api/state" -TimeoutSec 3 | Out-Null }
catch { Write-Host "[broll] bridge not reachable on port $Port. Start it: node bridge/launch.js"; exit 1 }

Write-Host "Gander B-roll director -- 5 concurrent sessions (swarms 9/5/3/2/0)" -ForegroundColor Yellow
Write-Host "Set the dashboard project filter to 'gander-broll' to hide your real session.`n"

switch ($Scene) {
  1 { Scene1 }
  2 { Scene2 }
  3 { Scene3 }
  4 { Scene4 }
  5 { Scene5 }
  6 { Scene6 }
  default { Scene1; Scene2; Scene3; Scene4; Scene5; Scene6 }
}

Cleanup
Write-Host "`n[broll] done + cleaned up. Re-run a single shot with -Scene N, or -Clear anytime." -ForegroundColor Yellow
