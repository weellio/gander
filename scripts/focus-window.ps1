<#
  Bring a Claude Code session's window to the foreground (Windows) — used by the
  dashboard's "Focus window" button so you can jump from an agent tile straight to
  the terminal it's running in. Prefers the PID captured at launch (▶ Start / ＋ New
  task); falls back to matching a window whose title contains -Match (project name,
  works for VS Code-hosted sessions).

    powershell -ExecutionPolicy Bypass -File scripts\focus-window.ps1 -WinPid 12345
    powershell -ExecutionPolicy Bypass -File scripts\focus-window.ps1 -Match "WaivePulse"

  Restores the window if minimised, then raises + activates it. Unlike sendkeys it
  types nothing — it only changes focus.
#>
param([int]$WinPid = 0, [string]$Match = '', [string]$Pids = '')

if ($WinPid -le 0 -and -not $Match -and -not $Pids) { Write-Host "[focus] need -WinPid, -Pids or -Match"; exit 0 }

try {
  Add-Type -ErrorAction Stop @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HmFocus {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static IntPtr ByPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      if (GetWindowTextLength(h) <= 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr ByTitle(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h); if (len <= 0) return true;
      var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Raise(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (IsIconic(h)) { ShowWindow(h, 9); }  // SW_RESTORE
    else { ShowWindow(h, 5); }              // SW_SHOW
    return SetForegroundWindow(h);
  }
}
"@
} catch {}

# Find the target window: captured PID first (survives Claude renaming the title to
# "Claude Code"), then each pid in -Pids (a process may be windowless — its owner's
# window is the next best thing), then a title substring (VS Code-hosted sessions).
$h = [IntPtr]::Zero
$winner = $WinPid
$cands = @()
if ($WinPid -gt 0) { $cands += $WinPid }
if ($Pids) { foreach ($s in $Pids -split ',') { $v = 0; if ([int]::TryParse($s.Trim(), [ref]$v) -and $v -gt 0) { $cands += $v } } }
foreach ($c in $cands) {
  $h = [HmFocus]::ByPid([uint32]$c)
  if ($h -ne [IntPtr]::Zero) { $winner = $c; break }
}
if ($h -eq [IntPtr]::Zero -and $Match) { $h = [HmFocus]::ByTitle($Match) }

if ($h -eq [IntPtr]::Zero) {
  Write-Host "[focus] no window for pids '$($cands -join ',')' / '$Match'"
  exit 0
}

# Restore + raise via user32, then AppActivate for the reliable focus-steal Windows
# allows from a foreground-granting context (same trick sendkeys/nudge use).
[void][HmFocus]::Raise($h)
try { (New-Object -ComObject WScript.Shell).AppActivate([int]$winner) | Out-Null } catch {}
Write-Host "[focus] raised window (pid $winner)"
