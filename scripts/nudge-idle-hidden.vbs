' Run nudge-idle.ps1 with NO visible window (for Task Scheduler) — avoids the PowerShell
' window flashing every interval. wscript.exe has no console; the "0" runs PowerShell hidden.
' Any arguments passed to this script are forwarded to the .ps1.
'
'   Schedule it (every 10 min, current user, no flash):
'     schtasks /Create /TN "Hivemind Nudge" /TR "wscript.exe \"%CD%\scripts\nudge-idle-hidden.vbs\" -OnlyPending" /SC MINUTE /MO 10 /F
Dim sh, here, args, i
Set sh = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
sh.Run "powershell.exe -ExecutionPolicy Bypass -NoProfile -File """ & here & "nudge-idle.ps1""" & args, 0, False
