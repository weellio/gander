#!/usr/bin/env bash
# Send a keystroke to a Claude session's window (macOS/Linux) for the dashboard quick-keys.
#   scripts/sendkeys.sh --match "WaivePulse" --keys "1{ENTER}"
# Keys: a literal string optionally ending in one special token {ENTER} {ESC} {TAB} {UP} {DOWN}.
MATCH=""; KEYS=""
while [ $# -gt 0 ]; do case "$1" in
  --match) MATCH="$2"; shift 2;;
  --keys)  KEYS="$2";  shift 2;;
  *) shift;;
esac; done
[ -z "$MATCH" ] && exit 0
[ -z "$KEYS" ] && exit 0

special=""; text="$KEYS"
case "$KEYS" in
  *"{ENTER}") special="Return"; text="${KEYS%\{ENTER\}}";;
  *"{ESC}")   special="Escape"; text="${KEYS%\{ESC\}}";;
  *"{TAB}")   special="Tab";    text="${KEYS%\{TAB\}}";;
  *"{UP}")    special="Up";     text="${KEYS%\{UP\}}";;
  *"{DOWN}")  special="Down";   text="${KEYS%\{DOWN\}}";;
esac

if [ "$(uname)" = "Darwin" ]; then
  osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "Code") to true' 2>/dev/null
  [ -n "$text" ] && osascript -e "tell application \"System Events\" to keystroke \"$text\"" 2>/dev/null
  case "$special" in
    Return) osascript -e 'tell application "System Events" to key code 36' 2>/dev/null;;
    Escape) osascript -e 'tell application "System Events" to key code 53' 2>/dev/null;;
    Tab)    osascript -e 'tell application "System Events" to key code 48' 2>/dev/null;;
    Up)     osascript -e 'tell application "System Events" to key code 126' 2>/dev/null;;
    Down)   osascript -e 'tell application "System Events" to key code 125' 2>/dev/null;;
  esac
else
  command -v xdotool >/dev/null 2>&1 || { echo "[sendkeys] install xdotool"; exit 0; }
  wid=$(xdotool search --name "$MATCH" 2>/dev/null | head -1)
  [ -z "$wid" ] && { echo "[sendkeys] no window matched '$MATCH'"; exit 0; }
  xdotool windowactivate --sync "$wid"
  [ -n "$text" ] && xdotool type --clearmodifiers "$text"
  [ -n "$special" ] && xdotool key "$special"
fi
