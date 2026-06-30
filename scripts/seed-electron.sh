#!/usr/bin/env bash
# seed-electron.sh — seed the Electron binary cache from a local zip so
# `npm install` doesn't have to download the ~100MB binary over a slow/proxied
# network.
#
# Usage:
#   bash scripts/seed-electron.sh [path-to-zip]
#
# If no path is given, it looks for electron-v*-darwin-*.zip in ~/Downloads,
# ~/Desktop, and the repo root. It computes the correct Electron cache location
# automatically (no need to type long hashed paths).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find a zip to use.
ZIP="${1:-}"
if [ -z "$ZIP" ]; then
  for dir in "$HOME/Downloads" "$HOME/Desktop" "$REPO_DIR"; do
    found="$(ls "$dir"/electron-v*-darwin-*.zip 2>/dev/null | head -n1 || true)"
    if [ -n "$found" ]; then ZIP="$found"; break; fi
  done
fi

if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then
  echo "Could not find an Electron zip."
  echo "Download 'electron-v<version>-darwin-arm64.zip' into ~/Downloads, then re-run:"
  echo "  bash scripts/seed-electron.sh"
  exit 1
fi

FILENAME="$(basename "$ZIP")"
# Derive the version from the filename: electron-v35.7.5-darwin-arm64.zip -> 35.7.5
VERSION="$(echo "$FILENAME" | sed -E 's/^electron-v([0-9.]+)-.*/\1/')"
# Derive platform/arch chunk: darwin-arm64
PLATARCH="$(echo "$FILENAME" | sed -E 's/^electron-v[0-9.]+-(.*)\.zip$/\1/')"

if [ -z "$VERSION" ] || [ -z "$PLATARCH" ]; then
  echo "Couldn't parse version/arch from: $FILENAME"
  exit 1
fi

URL="https://github.com/electron/electron/releases/download/v${VERSION}/${FILENAME}"

# Compute the exact cache directory the same way @electron/get does
# (sha256 of the URL with its filename stripped off).
CACHE_DIR_HASH="$(cd "$REPO_DIR" && node -e "
const c=require('@electron/get/dist/cjs/Cache.js');
console.log(c.Cache.getCacheDirectory('$URL'));
" 2>/dev/null || true)"

if [ -z "$CACHE_DIR_HASH" ]; then
  echo "Could not compute the cache path (is @electron/get present?)."
  echo "Run 'npm install' once first, then re-run this script."
  exit 1
fi

DEST="$HOME/Library/Caches/electron/$CACHE_DIR_HASH"
mkdir -p "$DEST"
cp "$ZIP" "$DEST/$FILENAME"

echo "Seeded Electron $VERSION ($PLATARCH) into the cache:"
echo "  $DEST/$FILENAME"
echo
echo "Now run:  npm install   (it will use the cached binary instead of downloading)"
