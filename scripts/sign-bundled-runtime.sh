#!/usr/bin/env bash
# Signs the desktop bundle's own runtime BEFORE `tauri build` (plan npmsiz-beta C1):
#
#   scripts/sign-bundled-runtime.sh <signing identity> [resources dir]
#
# Every Mach-O file under <resources>/runtime and <resources>/native is signed with the given
# Developer ID, the hardened runtime and a secure timestamp. The Node binary
# (runtime/bin/node) gets desktop/src-tauri/entitlements-node.plist (exactly the two V8 keys);
# everything else (node-pty's pty.node and spawn-helper) gets no entitlements. Tauri then seals
# these files as resources. scripts/verify-macos-bundle.sh checks the result on the built .app.
#
# Fails closed: a symlink anywhere under those folders, a missing node, or any file that does not
# verify after signing stops the script with exit 1.
set -euo pipefail

ID="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="${2:-$ROOT/desktop/src-tauri/resources}"
ENT="$ROOT/desktop/src-tauri/entitlements-node.plist"
NODE="$RES/runtime/bin/node"

if [ -z "$ID" ]; then
  echo "usage: sign-bundled-runtime.sh <signing identity> [resources dir]" >&2
  exit 2
fi
if [ ! -f "$NODE" ] || [ -L "$NODE" ]; then
  echo "error: $NODE is missing or not a regular file (run scripts/fetch-bundled-node.mjs darwin-arm64 first)" >&2
  exit 1
fi

dirs=()
for d in "$RES/runtime" "$RES/native"; do [ -d "$d" ] && dirs+=("$d"); done

links="$(find "${dirs[@]}" -type l)"
if [ -n "$links" ]; then
  echo "error: symlinks are not allowed in the bundled runtime:" >&2
  echo "$links" >&2
  exit 1
fi

signed=0
while IFS= read -r -d '' f; do
  if ! file -b "$f" | grep -q '^Mach-O'; then continue; fi
  if [ "$f" = "$NODE" ]; then
    codesign --force --sign "$ID" --options runtime --timestamp --entitlements "$ENT" "$f"
  else
    codesign --force --sign "$ID" --options runtime --timestamp "$f"
  fi
  codesign --verify --strict "$f"
  signed=$((signed + 1))
done < <(find "${dirs[@]}" -type f -print0)

echo "signed $signed Mach-O file(s) under ${dirs[*]}"
