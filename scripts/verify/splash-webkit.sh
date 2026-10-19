#!/usr/bin/env bash
# The opening screen in a REAL WKWebView under macOS Low Power Mode — the engine and the rule
# the owner actually hit.
#
#   bash scripts/verify/splash-webkit.sh          # the working-tree splash.html: MUST PASS
#   bash scripts/verify/splash-webkit.sh --old    # the pre-fix splash.html: MUST FAIL (with Low Power Mode on)
#
# Compiles scripts/verify/splash-webkit-probe.swift, wraps it in a minimal ad-hoc-signed .app
# (an unbundled binary is not treated like an app by WebKit/AppKit, so it might not hit the
# same media policy), and runs it against desktop/src-tauri/frontend-placeholder. The probe
# answers `splash_play` the way src/splash.rs does: evaluateJavaScript of __dcSplashPlay().
# The media events are the evidence; no screenshots (the probe has no screen-recording grant).
# Artifacts: tmp/verify/splash-webkit/.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PAGES="$REPO/desktop/src-tauri/frontend-placeholder"
OUT="$REPO/tmp/verify/splash-webkit"
APP="$OUT/SplashProbe.app"
OLD=0
# The last commit whose splash.html still played the clip itself; HEAD holds the fixed page once committed.
OLD_PAGE_COMMIT=55c6ff92
for arg in "$@"; do
  case "$arg" in
    --old) OLD=1 ;;
    *) echo "splash-webkit: unknown argument \"$arg\" (expected --old)" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT"

# The restriction only exists in Low Power Mode. Outside it every page plays, so the old page
# would pass too and the --old FAIL would prove nothing.
LPM="$(pmset -g | grep lowpowermode || true)"
echo "pmset: ${LPM:-lowpowermode (not reported)}"
if echo "$LPM" | grep -q 'lowpowermode *1'; then
  echo "Low Power Mode is ON: WebKit's video low-power restriction applies; the --old FAIL proof is meaningful."
else
  echo "WARNING: Low Power Mode is OFF. The restriction this checks is not active: the new page should still"
  echo "         PASS, but the old page would pass as well, so an --old run proves nothing. Turn Low Power Mode on"
  echo "         (System Settings > Battery) for the mutation proof."
fi

# Build the probe app (rebuilt when the source is newer).
SRC="$REPO/scripts/verify/splash-webkit-probe.swift"
BIN="$APP/Contents/MacOS/probe"
if [ ! -x "$BIN" ] || [ "$SRC" -nt "$BIN" ]; then
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS"
  cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.dreamcontext.verify.splashprobe</string><key>CFBundleExecutable</key><string>probe</string><key>CFBundleName</key><string>SplashProbe</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>
PLIST
  swiftc -O -o "$BIN" "$SRC" -framework Cocoa -framework WebKit
  codesign --force --sign - "$APP" >/dev/null 2>&1
fi

ROOT="$PAGES"
LABEL="working tree"
if [ "$OLD" = 1 ]; then
  ROOT="$OUT/old-page"
  rm -rf "$ROOT"
  mkdir -p "$ROOT"
  for f in "$PAGES"/*; do [ "$(basename "$f")" = splash.html ] || cp "$f" "$ROOT/"; done
  git -C "$REPO" show "$OLD_PAGE_COMMIT:desktop/src-tauri/frontend-placeholder/splash.html" > "$ROOT/splash.html"
  LABEL="$OLD_PAGE_COMMIT"
fi

LOG="$OUT/$([ "$OLD" = 1 ] && echo old || echo new).log"
echo "page: $LABEL splash.html   log: $LOG"
set +e
"$BIN" "$ROOT" splash.html | tee "$LOG"
STATUS=${PIPESTATUS[0]}
set -e
exit "$STATUS"
