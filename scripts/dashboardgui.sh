#!/usr/bin/env bash
# dashboardgui — launch the Dev Dashboard app.
# Prefers the packaged Dashboard.app; falls back to running from source.
# Runs detached so it doesn't tie up your terminal.

set -e

# Resolve the repo root (this script lives in <repo>/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PACKAGED="$REPO_DIR/dist/mac-arm64/Dashboard.app"

if [ -d "$PACKAGED" ]; then
  # Packaged app: shows proper "Dashboard" name + icon
  open "$PACKAGED"
  exit 0
fi

# Run from source. Ensure dependencies are installed.
cd "$REPO_DIR"
if [ ! -d node_modules ]; then
  echo "First run: installing dependencies (npm install)..."
  npm install
fi

# Launch detached so the terminal is freed up.
nohup npm start >/dev/null 2>&1 &
echo "Dashboard launching..."
