#!/usr/bin/env bash
# What the REAL desktop app costs this Mac while it sits idle (task: the desktop app stays light
# on an 8GB MacBook Air, AC14). Samples `top` every 2 s over the processes the app drives —
# WindowServer, the app's own WebKit GPU process, each of its WebContent processes, the app
# process and its dashboard `node` server — first with the app frontmost, then with another app
# frontmost (the window visible beside it), and writes mean + p95 CPU and RSS per process as
# JSON, with the power source and the Light mode state recorded beside the numbers.
#
#   scripts/verify/real-app-load.sh --phase before|after|light-on [--seconds 60] [--out DIR] [--no-activate]
#   (--no-activate: leave the frontmost app alone; both legs then measure whatever is in front)
#
# Conditions for a fair BEFORE/AFTER pair (the script records them, it cannot enforce them):
# AC power, the same 10 chat tabs restored, nothing typed or streaming, Light mode Auto (which
# resolves OFF on a 16 GB Mac on AC). Run it from a terminal OUTSIDE the app: a chat that is
# streaming inside the app is not idle.
#
# Which processes are the app's: the app is `dreamcontext-desktop` inside the bundle; its
# WebContent processes hold the bundle's cache directory open (lsof); its GPU process is the
# WebKit GPU service started within a few seconds of the app. Read-only: nothing is killed,
# nothing is changed except which app is frontmost (osascript `activate`).
set -euo pipefail

PHASE=""
SECONDS_PER_LEG=60
OUT=""
BUNDLE_ID="com.dreamcontext.beta"
APP_NAME="dreamcontext-beta"
OTHER_APP="Finder"
ACTIVATE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --phase) PHASE="$2"; shift 2 ;;
    --seconds) SECONDS_PER_LEG="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --app-name) APP_NAME="$2"; shift 2 ;;
    --no-activate) ACTIVATE=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PHASE" ] || { echo "usage: $0 --phase before|after|light-on [--seconds 60] [--out DIR]" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT:-$REPO/tmp/real-app-load/$PHASE}"
mkdir -p "$OUT"

# `ps`, not `pgrep`: pgrep does not see every process from every caller on macOS.
pids_matching() { ps -axo pid=,command= | awk -v re="$1" '$0 ~ re { print $1 }'; }
APP_PID="$(pids_matching "$APP_NAME[.]app/Contents/MacOS/dreamcontext-desktop" | head -1 || true)"
[ -n "$APP_PID" ] || { echo "the desktop app is not running" >&2; exit 1; }
APP_START="$(ps -o lstart= -p "$APP_PID" | xargs -I{} date -j -f "%a %b %d %T %Y" "{}" +%s)"

GPU_PID=""
for p in $(pids_matching "com[.]apple[.]WebKit[.]GPU[.]xpc" || true); do
  s="$(ps -o lstart= -p "$p" | xargs -I{} date -j -f "%a %b %d %T %Y" "{}" +%s)"
  d=$(( s - APP_START )); [ "$d" -lt 0 ] && d=$(( -d ))
  if [ "$d" -le 5 ]; then GPU_PID="$p"; break; fi
done
WC_PIDS=""
for p in $(pids_matching "com[.]apple[.]WebKit[.]WebContent[.]xpc" || true); do
  if lsof -p "$p" 2>/dev/null | grep -q "Library/Caches/$BUNDLE_ID"; then WC_PIDS="$WC_PIDS $p"; fi
done
NODE_PIDS="$(ps -axo pid=,ppid=,command= | awk -v app="$APP_PID" '$2 == app && /dashboard/ { print $1 }' | tr '\n' ' ' || true)"
WS_PID="$(pids_matching "/WindowServer( |$)" | head -1 || true)"

ROLES="$OUT/roles.txt"
: > "$ROLES"
echo "$APP_PID app" >> "$ROLES"
[ -n "$GPU_PID" ] && echo "$GPU_PID webkit-gpu" >> "$ROLES"
for p in $WC_PIDS; do echo "$p webcontent" >> "$ROLES"; done
for p in $NODE_PIDS; do echo "$p dashboard-node" >> "$ROLES"; done
[ -n "$WS_PID" ] && echo "$WS_PID windowserver" >> "$ROLES"
PIDARGS=""
while read -r pid _; do PIDARGS="$PIDARGS -pid $pid"; done < "$ROLES"

pmset -g batt > "$OUT/pmset.txt" 2>&1 || true
cp "$HOME/.dreamcontext/agent-ui.json" "$OUT/agent-ui.json" 2>/dev/null || echo '{}' > "$OUT/agent-ui.json"
sysctl -n hw.memsize > "$OUT/memsize.txt"

SAMPLES=$(( SECONDS_PER_LEG / 2 + 1 ))
leg() {
  local name="$1"
  # `top -l N -s 2`: the first sample's CPU is meaningless (no interval yet), skipped later.
  # shellcheck disable=SC2086
  top -l "$SAMPLES" -s 2 -stats pid,cpu $PIDARGS > "$OUT/top-$name.txt" &
  local tp=$!
  : > "$OUT/rss-$name.txt"
  local end=$(( $(date +%s) + SECONDS_PER_LEG ))
  while [ "$(date +%s)" -lt "$end" ]; do
    while read -r pid _; do
      r="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
      [ -n "$r" ] && echo "$pid $r" >> "$OUT/rss-$name.txt"
    done < "$ROLES"
    sleep 2
  done
  wait "$tp" || true
}

activate() { [ "$ACTIVATE" = 1 ] && osascript -e "tell application \"$1\" to activate" >/dev/null 2>&1 || true; }
activate "$APP_NAME"; [ "$ACTIVATE" = 1 ] && sleep 3
leg frontmost
activate "$OTHER_APP"; [ "$ACTIVATE" = 1 ] && sleep 3
leg background
activate "$APP_NAME"

node - "$OUT" "$PHASE" <<'NODE'
const fs = require('fs');
const path = require('path');
const [out, phase] = process.argv.slice(2);
const roles = Object.fromEntries(fs.readFileSync(path.join(out, 'roles.txt'), 'utf8').trim().split('\n').map((l) => l.split(' ')));
const stat = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean: Math.round(mean * 10) / 10, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], n: xs.length };
};
const legs = {};
for (const leg of ['frontmost', 'background']) {
  const cpu = {};
  let sample = -1;
  for (const line of fs.readFileSync(path.join(out, `top-${leg}.txt`), 'utf8').split('\n')) {
    if (/^Processes:/.test(line)) { sample += 1; continue; }
    const m = /^\s*(\d+)\s+([\d.]+)\s*$/.exec(line);
    if (!m || sample < 1) continue; // sample 0 has no interval
    (cpu[m[1]] ||= []).push(Number(m[2]));
  }
  const rss = {};
  for (const line of fs.readFileSync(path.join(out, `rss-${leg}.txt`), 'utf8').trim().split('\n')) {
    const [pid, kb] = line.split(' ');
    if (pid && kb) (rss[pid] ||= []).push(Number(kb) / 1024);
  }
  const perPid = {};
  for (const [pid, role] of Object.entries(roles)) {
    perPid[pid] = { role, cpu: stat(cpu[pid] || []), rssMb: stat(rss[pid] || []) };
  }
  const byRole = {};
  for (const { role, cpu: c, rssMb } of Object.values(perPid)) {
    const r = (byRole[role] ||= { cpuMean: 0, rssMbMean: 0, processes: 0 });
    r.processes += 1;
    r.cpuMean = Math.round((r.cpuMean + (c?.mean || 0)) * 10) / 10;
    r.rssMbMean = Math.round(r.rssMbMean + (rssMb?.mean || 0));
  }
  legs[leg] = { byRole, perPid };
}
const pmset = fs.readFileSync(path.join(out, 'pmset.txt'), 'utf8');
let lightSetting = 'auto';
try { lightSetting = JSON.parse(fs.readFileSync(path.join(out, 'agent-ui.json'), 'utf8')).lightMode || 'auto'; } catch {}
const memGb = Math.round(Number(fs.readFileSync(path.join(out, 'memsize.txt'), 'utf8')) / 1024 ** 3 * 10) / 10;
const onBattery = /'Battery Power'/.test(pmset) || /discharging/i.test(pmset);
const lightEffective = lightSetting === 'on' || (lightSetting === 'auto' && (memGb <= 8.5 || onBattery));
const numbers = {
  phase, at: new Date().toISOString(), power: onBattery ? 'battery' : 'ac', pmset: pmset.trim().split('\n')[0],
  memGb, light: { setting: lightSetting, effective: lightEffective }, legs,
};
fs.writeFileSync(path.join(out, 'numbers.json'), JSON.stringify(numbers, null, 2) + '\n');
for (const [leg, { byRole }] of Object.entries(legs)) {
  console.log(`${phase} ${leg}: ` + Object.entries(byRole).map(([r, v]) => `${r} cpu ${v.cpuMean}% rss ${v.rssMbMean}MB (${v.processes})`).join(' · '));
}
console.log(`power ${numbers.power} · light ${lightSetting} → ${lightEffective ? 'on' : 'off'} · ${path.join(out, 'numbers.json')}`);
NODE
