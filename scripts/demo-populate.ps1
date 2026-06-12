<#
  Fill the Office floor with a believable, animated swarm for screenshots / the demo GIF.
  Posts fake agent events to the bridge: one orchestrator + N workers that cycle through
  working states, occasionally finish (confetti + clock out) and respawn with fresh names.

    powershell -ExecutionPolicy Bypass -File scripts\demo-populate.ps1            # 16 workers, ~3 min
    powershell -ExecutionPolicy Bypass -File scripts\demo-populate.ps1 -Workers 24 -Seconds 240
    powershell -ExecutionPolicy Bypass -File scripts\demo-populate.ps1 -Clear     # remove the demo agents

  Tip: in the top-bar project filter, pick "gander-demo" to show only the swarm.
#>
param([int]$Port = 3131, [int]$Workers = 16, [int]$Seconds = 180, [switch]$Clear)

$base = "http://localhost:$Port/api/event"
function ev($h) { try { Invoke-RestMethod -Uri $base -Method Post -Body ($h | ConvertTo-Json -Compress) -ContentType 'application/json' -TimeoutSec 3 | Out-Null } catch {} }

$root = "demo-root"
$ids = @(); for ($i = 0; $i -lt $Workers; $i++) { $ids += "demo-w$i" }

if ($Clear) {
  foreach ($id in $ids) { ev @{ agentId = $id; remove = $true } }
  ev @{ agentId = $root; remove = $true }
  Write-Host "[demo] cleared"; exit 0
}

$states = @('coding', 'reading', 'testing', 'thinking', 'spawning', 'running')

ev @{ agentId = $root; name = 'Demo Orchestrator'; root = $true; project = 'gander-demo'; state = 'spawning'; log = 'spinning up the team' }
foreach ($id in $ids) { ev @{ agentId = $id; name = 'general-purpose'; parentId = $root; project = 'gander-demo'; state = 'spawning' } }
Start-Sleep -Milliseconds 500

Write-Host "[demo] $Workers workers live for $Seconds sec. Record now. Ctrl+C to stop, then run with -Clear to remove."
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $id = $ids | Get-Random
  if ((Get-Random -Maximum 100) -lt 12) {
    ev @{ agentId = $id; state = 'done'; log = 'task complete' }
    Start-Sleep -Milliseconds 700
    ev @{ agentId = $id; remove = $true }; Start-Sleep -Milliseconds 200
    ev @{ agentId = $id; name = 'general-purpose'; parentId = $root; project = 'gander-demo'; state = 'spawning' }
  } else {
    $s = $states | Get-Random
    ev @{ agentId = $id; state = $s; log = "$s ..." }
  }
  ev @{ agentId = $root; state = (@('thinking', 'spawning', 'coding') | Get-Random) }
  Start-Sleep -Milliseconds (Get-Random -Minimum 220 -Maximum 560)
}

foreach ($id in $ids) { ev @{ agentId = $id; remove = $true } }
ev @{ agentId = $root; remove = $true }
Write-Host "[demo] done + cleaned up"
