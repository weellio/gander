<#
  Emit JSON of running processes + listening TCP ports, for Gander's Processes
  inspector. Returns ALL processes (pid, ppid, name, cmd, started) so the bridge
  can walk the parent tree to attribute a process to the Claude session that
  spawned it, plus the listening port(s) each holds. The bridge filters this down
  to "interesting" long-running / port-holding processes.

  Output: a single compact JSON object { "procs": [ ... ] } on stdout.
#>
param([int]$CmdMax = 200)

$ErrorActionPreference = 'SilentlyContinue'

# Listening TCP ports -> owning pid
$ports = @{}
try {
  foreach ($c in (Get-NetTCPConnection -State Listen)) {
    $op = [int]$c.OwningProcess
    if (-not $ports.ContainsKey($op)) { $ports[$op] = New-Object System.Collections.ArrayList }
    $lp = [int]$c.LocalPort
    if ($ports[$op] -notcontains $lp) { [void]$ports[$op].Add($lp) }
  }
} catch {}

$list = foreach ($p in (Get-CimInstance Win32_Process)) {
  $procId = [int]$p.ProcessId
  $cmd = [string]$p.CommandLine
  if ($cmd.Length -gt $CmdMax) { $cmd = $cmd.Substring(0, $CmdMax) }
  $start = $null
  try { if ($p.CreationDate) { $start = ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') } } catch {}
  $pp = if ($ports.ContainsKey($procId)) { @($ports[$procId]) } else { @() }
  [pscustomobject]@{
    pid     = $procId
    ppid    = [int]$p.ParentProcessId
    name    = [string]$p.Name
    cmd     = $cmd
    started = $start
    ports   = $pp
  }
}

@{ procs = @($list) } | ConvertTo-Json -Depth 5 -Compress
