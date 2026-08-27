---
name: multi-session-checkout-safety
description: >-
  When two agent sessions work in ONE checkout, their git commits corrupt each other
  unless you use pathspec commits, archive-based verification, and recognize gitignored
  state artifacts. The commands and reasoning for never losing work to a parallel session.
type: knowledge
tags:
  - kind:pattern
  - topic:git
  - devops
  - architecture
  - topic:sleep
date: '2026-08-27'
---

# Multi-Session Checkout Safety Pattern

## Why This Exists

Two agent sessions working in ONE checkout can corrupt each other's commits. The symptom: one session staged 14 files, the other session's `git add` replaced the index between the add and the commit, so the message landed on the other session's work — attribution wrong, evidence wrong, and the actual work invisible to the test that was supposed to verify it.

This pattern documents the safe commands and the reasoning behind them, so a future session can avoid the same corruption.

## The Problem

Git's index (`.git/index`) is a **single-writer** file. When two processes run `git add` concurrently:

1. Process A runs `git add file-a.ts` (writes the index)
2. Process B runs `git add file-b.ts` (overwrites the index)
3. Process A runs `git commit -m "..."` (commits what B staged, not what A staged)

The commit message describes A's work but contains B's files. The verification script reads the wrong code. A's actual changes are lost in the working tree until someone notices.

## The Solution — Three Rules

### Rule 1: Commit with pathspec, not index

**DO THIS:**
```bash
git commit -F - -- path/to/file-a.ts path/to/file-b.ts <<'EOF'
feat(example): your commit message

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

**NOT THIS:**
```bash
git add .
git commit -m "feat(example): your commit message"
```

**Why it works:**  
`git commit -- <paths>` takes working-tree content for those paths directly, bypassing the index entirely. Another process's `git add` cannot poison it. The `-F -` reads the message from stdin (the heredoc), and `--` separates the message-reading flags from the pathspec.

**When to use it:**  
Every commit, in every environment where a second agent session might be running — which is any desktop app scenario (the user can spawn two chat sessions), any CI run that doesn't isolate checkouts, and any headless sleep cycle if the user is also working.

### Rule 2: Verify from archive, not checkout

**DO THIS:**
```bash
VERIFY_DIR=$(mktemp -d)
git archive HEAD | tar -xC "$VERIFY_DIR"
ln -s "$(pwd)/node_modules" "$VERIFY_DIR/node_modules"  # symlink, never copy
cd "$VERIFY_DIR"
npm run build && npm test
cd -
rm -rf "$VERIFY_DIR"
```

**NOT THIS:**
```bash
git stash push -u
npm run build && npm test
git stash pop
```

**Why it works:**  
`git archive HEAD` extracts the committed tree into a temp dir without touching the working tree. The other session's live edits stay untouched. `git stash` / `git checkout` / any tree mutation clobbers files the other session is writing to, and you lose work.

**When to use it:**  
Every verification step after a commit, in any multi-session environment.

### Rule 3: Recognize gitignored state as artifacts, not regressions

`_dream_context/state/` is gitignored (the active-person pin, `.sleep.json`, `.brain-local.json`), so an archive extract **will not have those files**. Tests that depend on them will fail in the archive verification, even though they pass in the working tree.

**Failures in archive verification that are NOT regressions:**
- `active-person.json` missing (archive has no gitignored state)
- `dist/` missing (build artifacts are not in git)
- `node_modules/` missing (we symlinked it, but the test may require a clean install)

**How to handle it:**  
Note the failure in your verification report, but recognize it as an artifact of the archive extraction, not a regression in the commit. The real test is: does the code you committed build and pass tests when extracted cleanly?

## When NOT to Use This Pattern

This pattern is for **parallel sessions in ONE checkout**. It is NOT for:

- **Separate worktrees**: Each worktree has its own index, so they cannot corrupt each other. Use worktrees when you can (`git worktree add`).
- **Separate machines**: Each clone has its own index. This pattern is about process-level concurrency, not distributed collaboration.
- **Single-session environments**: If you know only one agent is running, the index is safe. But: the desktop app can spawn two chat sessions, so "single-session" is rarer than it looks.

## Cross-References

- `knowledge/worktrees-and-the-brain.md` — why the brain lives in the working tree (a second worktree forks the brain, by design)
- `knowledge/archive/1.user-2026-h2.md` — archived rule "Do not commit unless explicitly asked" names the parallel-session hazard
- This pattern is what `sleep-state` points to when it writes the one-line decision in `2.memory.md`

## Evidence

- Bookmark `bm_wPFL67Qe` (salience 3, 2026-08-27) — the symptom: 14 files staged, commit landed on the other session's work
- Session that discovered it: [session ID would go here if available]
- Fixed by: applying pathspec commits + archive-based verification in the sleep flow

## Changelog

### 2026-08-27 - Created
- Pattern created from the multi-session commit corruption discovered today
- Documents the three rules: pathspec commits, archive verification, gitignored state artifacts
