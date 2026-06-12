<#
  Capture the PID of a just-launched session window by its (brief) title, before
  Claude Code renames the terminal to "Claude Code". The bridge calls this right
  after ▶ Start / ＋ New task so it can later target the window by PID (which the
  title-rename can't break). Prints the PID and exits as soon as it's found.

    powershell -ExecutionPolicy Bypass -File scripts\capture-window.ps1 -Title "Gander: WaivePulse" -TimeoutMs 5000
#>
param([string]$Title = '', [int]$TimeoutMs = 5000)
if (-not $Title) { exit 0 }

try {
  Add-Type -ErrorAction Stop @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HmCap {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
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

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
while ((Get-Date) -lt $deadline) {
  $found = [HmCap]::FindPid($Title)
  if ($found) { Write-Output $found; exit 0 }
  Start-Sleep -Milliseconds 200
}
exit 0
