# Gander "Free the GPU" helper — lower (or restore) the priority of heavy work
# that Claude Code sessions started: renders, encodes, Python jobs, headless
# browsers. It never stops anything; the work carries on, it just yields.
#
#   -Mode lower              set Idle on every heavy descendant of a claude.exe
#   -Mode restore -Pids 1,2  put those processes back to Normal
#
# Children inherit the priority class on Windows, so a render that starts a new
# ffmpeg step after this runs is still low priority. Prints one JSON line.
param(
  [ValidateSet('lower', 'restore')][string]$Mode = 'lower',
  [string]$Pids = ''
)
$ErrorActionPreference = 'SilentlyContinue'
$heavy = '^(python|pythonw|ffmpeg|ffprobe|chrome-headless-shell|magick|blender|whisper|whisper-cli)\.exe$'
$out = @()

if ($Mode -eq 'restore') {
  foreach ($id in ($Pids -split '[,\s]+' | Where-Object { $_ -match '^\d+$' })) {
    $p = Get-Process -Id ([int]$id)
    if ($p) { try { $p.PriorityClass = 'Normal'; $out += [pscustomobject]@{ pid = [int]$id; name = $p.ProcessName; priority = 'Normal' } } catch {} }
  }
} else {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $kids = @{}
  foreach ($p in $all) { if (-not $kids.ContainsKey($p.ParentProcessId)) { $kids[$p.ParentProcessId] = @() }; $kids[$p.ParentProcessId] += $p }
  $seen = @{}
  $stack = New-Object System.Collections.Stack
  foreach ($c in ($all | Where-Object { $_.Name -eq 'claude.exe' })) { $stack.Push($c) }
  while ($stack.Count) {
    $n = $stack.Pop()
    if ($seen.ContainsKey($n.ProcessId)) { continue }
    $seen[$n.ProcessId] = $true
    if ($n.Name -match $heavy) {
      $p = Get-Process -Id $n.ProcessId
      if ($p -and $p.PriorityClass -ne 'Idle') {
        $was = "$($p.PriorityClass)"
        try { $p.PriorityClass = 'Idle'; $out += [pscustomobject]@{ pid = $n.ProcessId; name = $n.Name; was = $was; priority = 'Idle' } } catch {}
      }
    }
    foreach ($k in $kids[$n.ProcessId]) { $stack.Push($k) }
  }
}
ConvertTo-Json -Compress -InputObject @($out)
