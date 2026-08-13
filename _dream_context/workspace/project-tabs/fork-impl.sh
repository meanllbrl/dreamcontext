#!/usr/bin/env bash
# Fork one implementer from the project-tabs planner session.
#
#   usage: fork-impl.sh <taskId> <promptFile> <model>
#
# Writes the CLI's JSON response to .impl-<taskId>.json next to this script, so the
# orchestrator can read back the forked session_id for the registry and later resumes.
#
# The permission flags are NOT optional: a headless `-p` session has no interactive
# permission prompt, so a fork without them stalls at its first Write with zero files
# changed. (goal-skill mechanics rule 3.)
set -euo pipefail

PLANNER="f1fb24f5-b868-4e18-bf96-146b2c1a2586"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TASK="${1:?task id required, e.g. T1}"
PROMPT_FILE="${2:?prompt file required}"
MODEL="${3:-sonnet}"
OUT="${HERE}/.impl-${TASK}.json"

claude -p --resume "$PLANNER" --fork-session "$(cat "$PROMPT_FILE")" \
  --permission-mode acceptEdits \
  --allowedTools "Write" "Edit" "Bash" \
  --output-format json \
  --model "$MODEL" \
  < /dev/null > "$OUT" 2>&1

echo "EXIT=$? TASK=${TASK} OUT=${OUT}"
