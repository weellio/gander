#!/usr/bin/env bash
# Gander one-step setup (macOS/Linux). Installs the Claude Code hooks.
#   ./setup.sh            install globally (every session reports in)
#   ./setup.sh --project  only sessions started in this folder
#   ./setup.sh --dry-run  show what would change, write nothing
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[Gander] Node.js is required but was not found on PATH."
  echo "           Install it from https://nodejs.org then run ./setup.sh again."
  exit 1
fi

echo "[Gander] Wiring the Claude Code hooks..."
node "$DIR/install.js" "$@"

cat <<EOF

[Gander] Setup complete.
  1) In any open Claude Code session run  /hooks  (or restart) to load the hooks.
  2) The dashboard opens automatically on your next session, or launch it now:
       node "$DIR/bridge/launch.js"
     then open  http://localhost:3131/

  Optional: set up Telegram, a custom editor, or the idle-nudge task from the
  dashboard's Config panel / the scripts in scripts/ (see README).
EOF
