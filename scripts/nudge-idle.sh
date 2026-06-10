#!/usr/bin/env bash
# Wake idle Claude Code sessions so queued messages get delivered (mac/linux twin of nudge-idle.ps1).
# Starting a turn flushes any queued dashboard/Telegram replies at that turn's Stop hook.
#
# Requires: node (for JSON parsing) + curl.
#   macOS:  uses osascript (System Events keystroke) — activates the VS Code app and types.
#   Linux:  uses xdotool to find the window by project name, focus it, and type.
#
# CAVEAT: this is keystroke automation — it steals focus of the matched window and types into
# whatever control is focused there. Keep the Claude terminal focused. Try --dry-run first.
#
#   scripts/nudge-idle.sh --dry-run
#   scripts/nudge-idle.sh --only-pending
#   scripts/nudge-idle.sh --match "my-window-title"
#
# Schedule with cron (every 10 min):  */10 * * * * /path/to/scripts/nudge-idle.sh --only-pending

PORT=3131; TEXT="check running jobs"; ONLY_PENDING=0; MATCH=""; DRYRUN=""; MIN_IDLE_SEC=120
while [ $# -gt 0 ]; do case "$1" in
  --port)         PORT="$2"; shift 2;;
  --text)         TEXT="$2"; shift 2;;
  --only-pending) ONLY_PENDING=1; shift;;
  --match)        MATCH="$2"; shift 2;;
  --min-idle-sec) MIN_IDLE_SEC="$2"; shift 2;;
  --dry-run)      DRYRUN=1; shift;;
  *) shift;;
esac; done

state=$(curl -s --max-time 5 "http://localhost:$PORT/api/state") || { echo "[nudge] bridge not reachable on :$PORT"; exit 0; }

titles=$(printf '%s' "$state" | ONLY_PENDING="$ONLY_PENDING" MIN_IDLE_SEC="$MIN_IDLE_SEC" node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  let j; try{j=JSON.parse(d)}catch(_){process.exit(0)}
  const onlyPending = process.env.ONLY_PENDING === "1";
  const minIdle = (Number(process.env.MIN_IDLE_SEC)||0) * 1000;   // skip sessions active within this window (you are likely still in them)
  const now = Date.now();
  const pend = j.pending || {};
  for (const a of (j.agents || [])) {
    if (a.root !== true || a.state !== "idle") continue;
    if (minIdle && !(a.updatedAt && (now - a.updatedAt) > minIdle)) continue;
    if (onlyPending && !(a.sessionId && pend[a.sessionId] > 0)) continue;
    if (a.project) console.log(a.project);
  }
});')

[ -n "$MATCH" ] && titles="$MATCH"
[ -z "$titles" ] && { echo "[nudge] nothing to nudge"; exit 0; }

os=$(uname)
while IFS= read -r title; do
  [ -z "$title" ] && continue
  echo "[nudge] '$TEXT' -> window matching '$title'"
  [ -n "$DRYRUN" ] && continue
  if [ "$os" = "Darwin" ]; then
    osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "Code") to true' 2>/dev/null
    osascript -e "tell application \"System Events\" to keystroke \"$TEXT\"" -e 'tell application "System Events" to key code 36' 2>/dev/null
  else
    if command -v xdotool >/dev/null 2>&1; then
      wid=$(xdotool search --name "$title" 2>/dev/null | head -1)
      if [ -n "$wid" ]; then
        active=$(xdotool getactivewindow 2>/dev/null)
        if [ "$wid" = "$active" ]; then echo "  [nudge] skipping '$title' - it's your active window"; continue; fi
        xdotool windowactivate --sync "$wid"; xdotool type --clearmodifiers "$TEXT"; xdotool key Return
      else
        echo "  [nudge] no window matched '$title' (xdotool)"
      fi
    else
      echo "  [nudge] install xdotool to send keystrokes on Linux"
    fi
  fi
done <<< "$titles"
