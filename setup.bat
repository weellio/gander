@echo off
setlocal
rem Hivemind one-step setup (Windows). Installs the Claude Code hooks.
rem   setup.bat            install globally (every session reports in)
rem   setup.bat --project  only sessions started in this folder
rem   setup.bat --dry-run  show what would change, write nothing

where node >nul 2>nul
if errorlevel 1 (
  echo [Hivemind] Node.js is required but was not found on PATH.
  echo            Install it from https://nodejs.org then run setup.bat again.
  exit /b 1
)

echo [Hivemind] Wiring the Claude Code hooks...
node "%~dp0install.js" %*
if errorlevel 1 ( echo [Hivemind] install failed. & exit /b 1 )

echo.
echo [Hivemind] Setup complete.
echo   1^) In any open Claude Code session run  /hooks  ^(or restart^) to load the hooks.
echo   2^) The dashboard opens automatically on your next session, or launch it now:
echo        node "%~dp0bridge\launch.js"
echo      then open  http://localhost:3131/
echo.
echo   Optional: set up Telegram, a custom editor, or the idle-nudge task from the
echo   dashboard's Config panel / the scripts in scripts\ (see README).
endlocal
