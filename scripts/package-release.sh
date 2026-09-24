#!/usr/bin/env bash
# Canonical release packaging. Use this instead of an ad hoc `zip` command —
# a hand-typed `zip -x ".*"` looks like it only excludes VCS/editor junk, but
# it silently drops every dotfile, .nojekyll included, from the shipped
# archive while leaving it untouched in the source tree. tests/regressions.js
# checks .nojekyll exists in source; nothing checked the packaged artifact
# itself, so that gap shipped unnoticed. This script is the fix: build it one
# way, then verify the actual zip contents before calling it done.
#
# Usage: scripts/package-release.sh [output.zip]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-/mnt/user-data/outputs/nexus-release.zip}"
REQUIRED_FILES=(".nojekyll" "index.html" "manifest.json" "sw.js" "package.json")

rm -f "$OUT"
mkdir -p "$(dirname "$OUT")"
# Exclude only VCS metadata — never a blanket ".*", which also matches
# required dotfiles like .nojekyll.
zip -r "$OUT" . -x ".git/*" -x ".git" > /dev/null

echo "Verifying packaged archive contents..."
missing=0
for f in "${REQUIRED_FILES[@]}"; do
  if unzip -l "$OUT" | awk '{print $4}' | grep -qx "$f"; then
    echo "  OK      $f"
  else
    echo "  MISSING $f"
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "Release packaging FAILED: required file(s) missing from $OUT" >&2
  exit 1
fi

echo "Release archive OK: $OUT"
