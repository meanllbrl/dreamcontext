#!/bin/bash
# dreamcontext hands-free: postStartCommand, run as the `codespace` user at every container start.
#
# Order matters (W0):
#  1. the self-stop helper FIRST, detached: the lifecycle step tears its process group down the
#     moment this script ends, and the helper must keep GitHub's in-codespace GITHUB_TOKEN in
#     ITS env only (D15; dcserver and dcuser never see it);
#  2. make port 8080 public with the in-codespace gh (retried detached: the port is not
#     listening yet, and it stays private for ~10 s after a start);
#  3. the root entrypoint (the only command this user may sudo), which launches everything
#     detached so it outlives this lifecycle step.
LOG=/tmp/dc-poststart.log
# The same lines ALSO go to a persistent log on /workspaces (the /tmp ones are wiped by the
# next container start): readable by the codespace user, 0644, trimmed to 500 lines per boot.
# Nothing secret is ever written to either (no token, no env).
BOOT=/workspaces/dc-boot.log
[ -L "$BOOT" ] && rm -f "$BOOT"
if [ -f "$BOOT" ]; then tail -n 499 "$BOOT" > "$BOOT.tmp" 2>/dev/null && mv -f "$BOOT.tmp" "$BOOT"; fi
touch "$BOOT" 2>/dev/null; chmod 644 "$BOOT" 2>/dev/null
blog() { printf '%s\n' "$*" >> "$LOG" 2>/dev/null; printf '%s\n' "$*" >> "$BOOT" 2>/dev/null; }
blog "=== poststart $(date -u +%FT%TZ) boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) codespace=$CODESPACE_NAME"
chmod 644 "$LOG" 2>/dev/null

setsid -f bash /opt/dc-hf/stop-helper.sh < /dev/null > /dev/null 2>&1
blog "stop helper launched"

setsid -f bash -c '
  plog() { printf "%s\n" "$*" >> /tmp/dc-ports.log; printf "%s\n" "ports: $*" >> /workspaces/dc-boot.log; }
  for i in $(seq 1 40); do
    out=$(gh codespace ports visibility 8080:public -c "$CODESPACE_NAME" 2>&1); rc=$?
    [ -n "$out" ] && plog "$out"
    if [ "$rc" -eq 0 ]; then
      plog "public ok try=$i $(date -u +%FT%TZ)"; chmod 644 /tmp/dc-ports.log; exit 0
    fi
    sleep 6
  done
  plog "public FAILED $(date -u +%FT%TZ)"; chmod 644 /tmp/dc-ports.log
' < /dev/null > /dev/null 2>&1

out=$(sudo -n /opt/dc-hf/entrypoint.sh start "$CODESPACE_NAME" "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN" 2>&1); rc=$?
[ -n "$out" ] && blog "$out"
blog "entrypoint exit=$rc"
# Give the detached children a moment to leave this process group before the step ends.
sleep 3
