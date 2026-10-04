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
echo "=== poststart $(date -u +%FT%TZ)" >> "$LOG" 2>&1
chmod 644 "$LOG" 2>/dev/null

setsid -f bash /opt/dc-hf/stop-helper.sh < /dev/null > /dev/null 2>&1
echo "stop helper launched" >> "$LOG"

setsid -f bash -c '
  for i in $(seq 1 40); do
    if gh codespace ports visibility 8080:public -c "$CODESPACE_NAME" >> /tmp/dc-ports.log 2>&1; then
      echo "public ok try=$i $(date -u +%FT%TZ)" >> /tmp/dc-ports.log; chmod 644 /tmp/dc-ports.log; exit 0
    fi
    sleep 6
  done
  echo "public FAILED $(date -u +%FT%TZ)" >> /tmp/dc-ports.log; chmod 644 /tmp/dc-ports.log
' < /dev/null > /dev/null 2>&1

sudo -n /opt/dc-hf/entrypoint.sh start "$CODESPACE_NAME" "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN" >> "$LOG" 2>&1
echo "entrypoint exit=$?" >> "$LOG"
# Give the detached children a moment to leave this process group before the step ends.
sleep 3
