#!/bin/zsh
# Runs the whole matrix, P at a time; finished runs are skipped (journal). queue.sh [P]
P=${1:-4}; E=${0:A:h}
for rep in 1 2 3; do for t in t8-long t4-develop t5-plan t6-super t2-feature t3-debug t1-fix t7-memory; do for m in off plus; do echo "$t $m $rep"; done; done; done |
  xargs -P $P -L 1 sh -c 'node "$0/run.mjs" "$1" "$2" "$3" > "/tmp/eco-benchmark/logs/$1-$2-$3.log" 2>&1; tail -1 "/tmp/eco-benchmark/logs/$1-$2-$3.log"' "$E"
echo QUEUE_DONE
