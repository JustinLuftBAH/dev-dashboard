#!/usr/bin/env bash
# dashboardgui — launch the Dev Dashboard app.
# Prefers the packaged Dashboard.app; falls back to running from source.
# Runs detached so it doesn't tie up your terminal.

set -e

# Resolve the repo root (this script lives in <repo>/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PACKAGED="$REPO_DIR/dist/mac-arm64/Dashboard.app"
LOG="$REPO_DIR/dashboard.log"

if [ -d "$PACKAGED" ]; then
  # Packaged app: shows proper "Dashboard" name + icon
  open "$PACKAGED"
  exit 0
fi

cd "$REPO_DIR"

# Make sure dependencies (and specifically the Electron binary) are installed.
# Checking for the binary — not just node_modules/ — catches partial/interrupted installs.
if [ ! -x node_modules/.bin/electron ]; then
  echo "Installing dependencies (this can take a minute the first time)..."
  if ! npm install; then
    echo
    echo "npm install failed — see the output above."
    echo "Make sure Node.js is installed (node -v). Node 18 is recommended."
    exit 1
  fi
fi

# Launch detached, but capture output so failures aren't swallowed.
echo "Launching Dashboard..."
nohup npm start > "$LOG" 2>&1 &
PID=$!

# Give Electron a moment to start, then confirm it actually stayed up.
sleep 4
if kill -0 "$PID" 2>/dev/null; then
  echo "Dashboard is running."
else
  echo
  echo "Dashboard failed to start. Last lines of $LOG:"
  echo "----------------------------------------------"
  tail -n 25 "$LOG"
  echo "----------------------------------------------"
  exit 1
fi
