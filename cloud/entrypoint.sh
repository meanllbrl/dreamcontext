#!/bin/bash
# dreamcontext hands-free root entrypoint. The `codespace` user may run ONLY this script via
# sudo (`/etc/sudoers.d/codespace`). Fixed subcommands; nothing here runs caller-supplied code:
#   start <codespace-name> <port-forwarding-domain>   (poststart.sh, every container start)
#   claude-login <accountId>                           (interactive, over `gh codespace ssh -c <name> -- -t`; D13)
set -u
umask 0022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SRV=/workspaces/dc-server          # 0700 dcserver: verifiers, sessions, limiter, phase, uploads
PUB=/workspaces/dc-server-pub      # 0755 dcserver: orchestration gitconfig, stop request, mirror state
WORK=/workspaces/dc-work           # 2770 dcuser:dcwork: the worker's backups and incoming files
HM=/workspaces/dc-home             # the mirror's backing dir on the persistent disk
RUNTIME=/workspaces/dc-runtime     # 0700 root: the last good dreamcontext tarball (survives a rebuild)
NAME_RE='^[a-z0-9-]{1,100}$'
DOMAIN_RE='^[a-z0-9.-]{1,100}$'
ID_RE='^[a-z0-9][a-z0-9-]{0,63}$'
DROP=(setpriv --reuid=dcuser --regid=dcwork --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs --)
ENTRY=/opt/dreamcontext/node_modules/dreamcontext/dist/index.js

strip_default_acl() { # /workspaces carries a default ACL other::rwx that would defeat umask (W0)
  python3 -c 'import os,sys
for p in sys.argv[1:]:
    try: os.removexattr(p, "system.posix_acl_default")
    except OSError: pass' "$@"
}

# The root listener (AC19, smoke #4). Port 8080 is bound HERE, outside libuv: this python step
# binds 0.0.0.0:8080 (SO_REUSEADDR, backlog 511), leaves the listening socket on fd 3 and
# exec's the supervisor (same pid; `pkill -f /opt/dc-hf/supervisor.mjs` still matches it). The
# supervisor only HOLDS fd 3 and hands it to every server instance; it never accepts on it (a
# listening net.Server there answered nothing for the connections it won: forwarder 504s).
# A failed bind exits before the exec: logged, and no half-started supervisor.
# argv: <host> <port> <public log or ''> <program> [args...]
HOLD_PY=$(cat <<'PY'
import os, socket, sys, time
host, port, pub, argv = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4:]
def publog(line):
    if not pub:
        return
    try:
        fd = os.open(pub, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o644)
        try:
            os.write(fd, (time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + ' ' + line + '\n').encode())
        finally:
            os.close(fd)
    except OSError:
        pass
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, port))
    s.listen(511)
except OSError as e:
    msg = 'listener: bind %s:%d failed: %s (errno %s); supervisor NOT started' % (host, port, e.strerror or e, e.errno)
    print(msg, file=sys.stderr, flush=True)
    publog(msg)
    sys.exit(3)
fd = s.detach()
if fd != 3:
    os.dup2(fd, 3)
    os.close(fd)
os.set_inheritable(3, True)
publog('listener: bound %s:%d on fd 3, exec supervisor (pid %d)' % (host, port, os.getpid()))
os.execv(argv[0], argv)
PY
)

# A persistent, world-readable boot record (no secrets, no env, nothing under the mirror):
# root appends with O_NOFOLLOW (the codespace user owns /workspaces), trimmed to 500 lines.
PUBLOG=/workspaces/dc-runtime-pub.log
PUBLOG_PY=$(cat <<'PY'
import os, sys, time
path, line, trim = sys.argv[1], sys.argv[2], sys.argv[3] == 'trim'
try:
    if trim:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as f:
                keep = f.read().splitlines(keepends=True)[-499:]
            tmp = path + '.tmp'
            if os.path.lexists(tmp):
                os.unlink(tmp)
            t = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(t, 'wb') as f:
                f.writelines(keep)
            os.rename(tmp, path)
        except FileNotFoundError:
            pass
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o644)
    try:
        os.fchmod(fd, 0o644)
        os.write(fd, (time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + ' ' + line + '\n').encode())
    finally:
        os.close(fd)
except OSError:
    pass
PY
)
publog() { python3 -c "$PUBLOG_PY" "$PUBLOG" "$1" "${2:-}" 2>/dev/null; }

# The mirror root the supervisor mounted (/Users/<name>, the laptop HOME), empty before a trip.
mirror_root() {
  local m
  m=$(cat "$PUB/mirror-mounted" 2>/dev/null)
  if [[ "$m" =~ ^/(Users|home)/[A-Za-z0-9._-]{1,64}$ ]] && mountpoint -q "$m"; then echo "$m"; fi
}

# The repo checkout (/workspaces/<repo>) sits under the default ACL other::rwx (W0 b): the
# supervisor's `prepare` locks its .devcontainer tree down AS ROOT (root:root, no group/other
# write, ACLs stripped, links removed; fd-based, never following a link) BEFORE anything reads
# it, then copies the bootstrap verifiers through its no-follow, owner-checked reader.
repair_owners() {
  chown -R -P dcserver:dcserver "$SRV" "$PUB"; chmod 0700 "$SRV"; chmod 0755 "$PUB"
  chown dcuser:dcwork "$HM" "$WORK"; chmod 2775 "$HM"; chmod 2770 "$WORK"
  chown root:root "$RUNTIME"; chmod 0700 "$RUNTIME"
}

cmd="${1:-}"
case "$cmd" in
start)
  NAME="${2:-}"; DOMAIN="${3:-}"
  [[ "$NAME" =~ $NAME_RE ]] || { echo "bad codespace name"; exit 2; }
  [[ "$DOMAIN" =~ $DOMAIN_RE ]] || { echo "bad forwarding domain"; exit 2; }
  ORIGIN="https://${NAME}-8080.${DOMAIN}"
  publog "=== boot $(cat /proc/sys/kernel/random/boot_id 2>/dev/null) codespace=$NAME url=$ORIGIN" trim
  mkdir -p "$SRV" "$PUB" "$WORK" "$HM" "$RUNTIME"
  strip_default_acl "$SRV" "$PUB" "$WORK" "$HM" "$RUNTIME"
  repair_owners
  chmod 0700 /workspaces/.codespaces /home/codespace 2>/dev/null
  # A stop request left from an earlier boot must never stop this one.
  rm -f "$PUB/stop-request"
  /usr/bin/node /opt/dc-hf/supervisor.mjs prepare < /dev/null >> "$RUNTIME/supervisor.out" 2>&1
  printf '%s\n' "$ORIGIN" > "$RUNTIME/origin"
  # Everything below outlives this lifecycle step.
  pkill -f '/opt/dc-hf/supervisor.mjs' 2>/dev/null
  sleep 1
  setsid -f python3 -c "$HOLD_PY" 0.0.0.0 8080 "$PUBLOG" /usr/bin/node /opt/dc-hf/supervisor.mjs < /dev/null >> "$RUNTIME/supervisor.out" 2>&1
  # GitHub re-owns all of /workspaces to `codespace` ONCE at creation, ~10 s AFTER this step
  # (W0): wait for it, then repair the owners and modes and restart the server.
  PUBLOG="$PUBLOG" PUBLOG_PY="$PUBLOG_PY" setsid -f bash -c '
    SRV=/workspaces/dc-server
    for i in $(seq 1 120); do
      if [ "$(stat -c %U "$SRV")" != dcserver ]; then
        sleep 5
        chown -R -P dcserver:dcserver /workspaces/dc-server /workspaces/dc-server-pub
        chmod 0700 /workspaces/dc-server; chmod 0755 /workspaces/dc-server-pub
        chown dcuser:dcwork /workspaces/dc-home /workspaces/dc-work; chmod 2775 /workspaces/dc-home; chmod 2770 /workspaces/dc-work
        chown root:root /workspaces/dc-runtime; chmod 0700 /workspaces/dc-runtime
        python3 -c "import os
for p in (\"/workspaces/dc-server\",\"/workspaces/dc-server-pub\",\"/workspaces/dc-work\",\"/workspaces/dc-home\",\"/workspaces/dc-runtime\"):
    try: os.removexattr(p, \"system.posix_acl_default\")
    except OSError: pass"
        /usr/bin/node /opt/dc-hf/supervisor.mjs lockdown < /dev/null >> /workspaces/dc-runtime/supervisor.out 2>&1
        pkill -TERM -u dcserver 2>/dev/null
        echo "$(date -u +%FT%TZ) settle: re-own repaired after ${i}x5s" >> /workspaces/dc-runtime/settle.log
        python3 -c "$PUBLOG_PY" "$PUBLOG" "settle: re-own repaired after ${i}x5s" "" 2>/dev/null
        exit 0
      fi
      sleep 5
    done
    python3 -c "$PUBLOG_PY" "$PUBLOG" "settle: no re-own within 10 min (not a first boot)" "" 2>/dev/null' < /dev/null > /dev/null 2>&1
  echo "started supervisor origin=$ORIGIN"
  ;;
claude-login)
  # D13: the CLI's own `claude auth login`, as dcuser, into this account's sandbox config dir
  # (built by the existing ensureSandbox through the worker entry). Nothing is captured or
  # stored by us; success is judged only by `claude auth status --json` in that dir.
  ID="${2:-}"; [[ "$ID" =~ $ID_RE ]] || { echo "bad account id"; exit 2; }
  MIRROR=$(mirror_root)
  [ -n "$MIRROR" ] || { echo "no trip has reached this cloud yet: run a go first"; exit 2; }
  [ -f "$ENTRY" ] || { echo "dreamcontext is not installed yet; try again in a minute"; exit 2; }
  CD="$MIRROR/.dreamcontext/claude-accounts/$ID"
  ENVV=(env -i HOME="$MIRROR" USER=dcuser LOGNAME=dcuser SHELL=/bin/bash LANG=C.UTF-8 TERM="${TERM:-xterm-256color}" PATH=/usr/local/bin:/usr/bin:/bin)
  python3 -c 'import json,struct,sys
h=json.dumps({"op":"ensure-sandbox","params":{"configDir":sys.argv[1]}}).encode()
sys.stdout.buffer.write(struct.pack(">I",len(h))+h)' "$CD" \
    | "${ENVV[@]}" "${DROP[@]}" /usr/bin/node "$ENTRY" cloud worker ensure-sandbox 3>/dev/null \
    || { echo "could not prepare the account sandbox"; exit 1; }
  "${ENVV[@]}" CLAUDE_CONFIG_DIR="$CD" "${DROP[@]}" /bin/bash -lc 'umask 0077; claude auth login'
  echo "--- claude auth status:"
  "${ENVV[@]}" CLAUDE_CONFIG_DIR="$CD" "${DROP[@]}" /bin/bash -lc 'claude auth status --json' 2>/dev/null \
    | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print("unknown"); sys.exit(0)
print("signed in" if d.get("loggedIn") else "NOT signed in", d.get("email") or "")'
  ;;
*)
  echo "usage: entrypoint.sh start <codespace> <domain> | claude-login <accountId>"; exit 2 ;;
esac
