#!/bin/zsh
# Re-runs every queue key with no ok journal row (a run lost to a full disk, or ok=false).
# Drop an ok=false row from journal.jsonl first, or run.mjs skips it. requeue.sh [P]
P=${1:-4}; E=${0:A:h}; B=/tmp/eco-benchmark
df -h / | tail -1
node "$E/missing.mjs" --keys | tr '/' ' ' \
| xargs -P $P -L 1 sh -c '[ -f /tmp/eco-benchmark/STOP ] && { echo "stopped $1/$2/$3"; exit 0; }; node "$0/run.mjs" "$1" "$2" "$3" > "/tmp/eco-benchmark/logs/$1-$2-$3.log" 2>&1; tail -1 "/tmp/eco-benchmark/logs/$1-$2-$3.log"' "$E"
echo REQUEUE_DONE
