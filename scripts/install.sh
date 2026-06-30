#!/usr/bin/env bash
# install.sh — register the `dashboardgui` command so you can launch the
# Dev Dashboard from anywhere by typing `dashboardgui`.
#
# This adds an alias to your shell rc file (no sudo required). Re-running is safe.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCHER="$SCRIPT_DIR/dashboardgui.sh"

chmod +x "$LAUNCHER"

# Pick the right rc file for the current shell.
case "$(basename "${SHELL:-}")" in
  zsh)  RC="$HOME/.zshrc" ;;
  bash) RC="$HOME/.bashrc" ;;
  *)    RC="$HOME/.profile" ;;
esac
touch "$RC"

ALIAS_LINE="alias dashboardgui='$LAUNCHER'"
MARKER="# dev-dashboard launcher"

if grep -qF "$MARKER" "$RC"; then
  # Update the existing alias in place (path may have changed).
  tmp="$(mktemp)"
  grep -vF "$MARKER" "$RC" | grep -v "alias dashboardgui=" > "$tmp" || true
  mv "$tmp" "$RC"
fi

printf '\n%s\n%s\n' "$MARKER" "$ALIAS_LINE" >> "$RC"

echo "Installed 'dashboardgui' command -> $LAUNCHER"
echo "Added to: $RC"
echo
echo "Run this to use it now (or just open a new terminal):"
echo "  source \"$RC\""
echo "Then type:  dashboardgui"
