#!/bin/zsh
# Round 2: the 4 new task types x 6 reps, then reps 4-6 of the first 8 tasks, Off vs Eco Plus.
# Finished runs are skipped (journal); a STOP file in $BENCH ends the queue before the next run
# (the spend guard writes it). queue2.sh [P]
P=${1:-4}; E=${0:A:h}; B=/tmp/eco-benchmark
{
  for rep in 1 2 3 4 5 6; do for t in t9-validate t10-labels t11-review t12-report-json; do for m in off plus; do echo "$t $m $rep"; done; done; done
  for rep in 4 5 6; do for t in t8-long t4-develop t5-plan t6-super t2-feature t3-debug t1-fix t7-memory; do for m in off plus; do echo "$t $m $rep"; done; done; done
} | xargs -P $P -L 1 sh -c '[ -f /tmp/eco-benchmark/STOP ] && { echo "stopped $1/$2/$3"; exit 0; }; node "$0/run.mjs" "$1" "$2" "$3" > "/tmp/eco-benchmark/logs/$1-$2-$3.log" 2>&1; tail -1 "/tmp/eco-benchmark/logs/$1-$2-$3.log"' "$E"
echo QUEUE2_DONE
