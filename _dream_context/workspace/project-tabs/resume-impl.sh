#!/usr/bin/env bash
# Resume an already-forked implementer with a DELTA only (a gate/review failure).
#
#   usage: resume-impl.sh <taskId> <sessionId> <promptFile>
#
# Never re-explain what the session already knows from its own context — pass only the
# specific failure. (goal-skill: "don't churn unrelated code".)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TASK="${1:?task id required}"
SESSION="${2:?session id required}"
PROMPT_FILE="${3:?prompt file required}"
OUT="${HERE}/.impl-${TASK}.resume.json"

claude -p --resume "$SESSION" "$(cat "$PROMPT_FILE")" \
  --permission-mode acceptEdits \
  --allowedTools "Write" "Edit" "Bash" \
  --output-format json \
  --model sonnet \
  < /dev/null > "$OUT" 2>&1

echo "EXIT=$? TASK=${TASK} OUT=${OUT}"
