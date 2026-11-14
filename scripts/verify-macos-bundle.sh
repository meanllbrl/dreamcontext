#!/usr/bin/env bash
# The security gate on a built macOS bundle (plan npmsiz-beta C1), run by the release job on the
# real .app before anything is published:
#
#   scripts/verify-macos-bundle.sh <path/to/X.app> <TEAM_ID>
#
# Fails (exit 1, one line per defect) when ANY Mach-O file in the bundle:
#   - is unsigned, ad-hoc signed, or signed by another team than <TEAM_ID>
#   - lacks the hardened runtime flag or a secure timestamp
#   - carries the get-task-allow entitlement
# or when the bundled runtime (Contents/Resources/runtime/bin/node) carries any entitlement other
# than com.apple.security.cs.allow-jit and com.apple.security.cs.allow-unsigned-executable-memory.
#
# Test seam: `--test-adhoc` in place of <TEAM_ID> accepts an ad-hoc signature (and so no team and
# no timestamp, which ad-hoc signing cannot carry) so the fixture test can exercise every other
# check. The release job always passes its real team id (a test on the release-job wiring checks it).
set -uo pipefail

APP="${1:-}"
TEAM="${2:-}"
if [ -z "$APP" ] || [ -z "$TEAM" ] || [ ! -d "$APP/Contents" ]; then
  echo "usage: verify-macos-bundle.sh <X.app> <TEAM_ID|--test-adhoc>" >&2
  exit 2
fi
ADHOC_OK=0
if [ "$TEAM" = "--test-adhoc" ]; then ADHOC_OK=1; fi

RUNTIME_NODE="$APP/Contents/Resources/runtime/bin/node"
ALLOWED_NODE_KEYS="com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory"
fail=0
checked=0
runtime_checked=0
defect() { echo "DEFECT: $1: $2"; fail=1; }

# The entitlement keys of a signed file, one per line (none = empty). Exit 1 when they cannot be
# read: the gate then reports a defect instead of reading "no entitlements".
entitlement_keys() {
  local xml
  xml="$(codesign -d --entitlements :- "$1" 2>/dev/null)" || return 1
  [ -z "$xml" ] && return 0
  local json
  json="$(printf '%s' "$xml" | /usr/bin/plutil -convert json -o - -- - 2>/dev/null)" || return 1
  # Keys whose value is not false (node runs every release job and test that calls this script).
  printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);if(!o||typeof o!=="object"||Array.isArray(o))process.exit(1);for(const[k,v]of Object.entries(o))if(v!==false)console.log(k)})' || return 1
}

while IFS= read -r -d '' f; do
  # Mach-O only (executables, dylibs, .node addons, universal binaries).
  case "$(file -b "$f" 2>/dev/null)" in
    *Mach-O*) ;;
    *) continue ;;
  esac
  checked=$((checked + 1))
  rel="${f#"$APP"/}"
  info="$(codesign -dv --verbose=4 "$f" 2>&1)"
  if ! codesign --verify --strict "$f" >/dev/null 2>&1; then
    if printf '%s' "$info" | grep -q "code object is not signed"; then
      defect "$rel" "unsigned"
    else
      defect "$rel" "signature does not verify"
    fi
    continue
  fi
  if printf '%s' "$info" | grep -q '^Signature=adhoc'; then
    [ "$ADHOC_OK" = 1 ] || defect "$rel" "ad-hoc signed"
  else
    team_line="$(printf '%s\n' "$info" | sed -n 's/^TeamIdentifier=//p')"
    if [ "$ADHOC_OK" = 1 ] || [ "$team_line" != "$TEAM" ]; then
      defect "$rel" "team ${team_line:-none}, expected ${TEAM}"
    fi
    printf '%s' "$info" | grep -q '^Timestamp=' || defect "$rel" "no secure timestamp"
  fi
  flags_line="$(printf '%s\n' "$info" | grep -E '^CodeDirectory .*flags=' | head -1)"
  printf '%s' "$flags_line" | grep -q 'runtime' || defect "$rel" "no hardened runtime flag"
  if ! keys="$(entitlement_keys "$f")"; then
    defect "$rel" "entitlements could not be read"
    continue
  fi
  [ "$f" = "$RUNTIME_NODE" ] && runtime_checked=1
  if printf '%s\n' "$keys" | grep -qx 'com.apple.security.get-task-allow'; then
    defect "$rel" "carries get-task-allow"
  fi
  if [ "$f" = "$RUNTIME_NODE" ]; then
    while IFS= read -r k; do
      [ -z "$k" ] && continue
      case " $ALLOWED_NODE_KEYS " in
        *" $k "*) ;;
        *) defect "$rel" "runtime node carries entitlement $k" ;;
      esac
    done <<< "$keys"
  fi
done < <(find "$APP" -type f -print0)

if [ "$checked" = 0 ]; then
  echo "DEFECT: no Mach-O file found in $APP"
  exit 1
fi
if [ ! -f "$RUNTIME_NODE" ]; then
  defect "Contents/Resources/runtime/bin/node" "missing"
elif [ "$runtime_checked" = 0 ]; then
  defect "Contents/Resources/runtime/bin/node" "not a checked Mach-O binary"
fi
if [ "$fail" = 0 ]; then
  echo "✓ $checked Mach-O files: signed by ${TEAM}, hardened runtime, timestamped, no get-task-allow; runtime node holds only its two entitlements"
fi
exit "$fail"
