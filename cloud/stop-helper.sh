#!/bin/bash
# dreamcontext hands-free self-stop (D15). Runs as the `codespace` user, launched FIRST by
# poststart.sh, so GitHub's in-codespace GITHUB_TOKEN lives in THIS process's env only
# (dcserver and dcuser cannot read another uid's environ). It never prints the token.
#
# dcserver decides WHEN (the D14 clock) and writes `<due epoch seconds> <boot id>` into its
# 0755 sibling dir. A request from an earlier boot is ignored (and the root entrypoint clears
# it at every start), so a stale request can never stop a fresh start. Polled every 15 s.
REQ=/workspaces/dc-server-pub/stop-request
LOG=/tmp/dc-stop-helper.log
BOOT_ID=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
echo "$(date -u +%FT%TZ) helper up pid=$$ token_present=$([ -n "$GITHUB_TOKEN" ] && echo yes || echo no)" >> "$LOG"
chmod 644 "$LOG" 2>/dev/null
while true; do
  if [ -f "$REQ" ] && [ ! -L "$REQ" ]; then
    read -r due boot < "$REQ"
    due=$(printf '%s' "$due" | tr -cd '0-9')
    if [ -n "$due" ] && [ "$boot" = "$BOOT_ID" ] && [ "$(date +%s)" -ge "$due" ]; then
      echo "$(date -u +%FT%TZ) stop request due ($due), stopping $CODESPACE_NAME" >> "$LOG"
      gh codespace stop -c "$CODESPACE_NAME" >> "$LOG" 2>&1
      echo "$(date -u +%FT%TZ) gh codespace stop exit=$?" >> "$LOG"
      sleep 60
    fi
  fi
  sleep 15
done
