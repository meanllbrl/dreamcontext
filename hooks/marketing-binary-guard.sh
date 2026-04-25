#!/bin/sh
# dreamcontext marketing — pre-commit binary guard.
#
# Refuses to commit any file under _dream_context/marketing/**/_assets/ or
# _dream_context/marketing/**/_media/. These directories hold large competitor
# media (frames, mp4) that must never enter git history.
#
# Defense-in-depth on top of .gitignore (which can be bypassed with `git add -f`).
#
# Install: copy or symlink to .git/hooks/pre-commit, OR run
#   dreamcontext mk hooks install

if ! command -v dreamcontext >/dev/null 2>&1; then
  echo "dreamcontext: command not found — skipping marketing-binary-guard hook" >&2
  exit 0
fi

exec dreamcontext mk hooks check-staged
