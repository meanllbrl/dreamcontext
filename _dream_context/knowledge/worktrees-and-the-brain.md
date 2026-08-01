---
id: know_gUtelmoB
name: Worktrees and the brain
description: >-
  The brain has ONE home — the main worktree — and it stays inside the code
  repo. Why moving it out was rejected, what a linked worktree's _dream_context/
  copy actually is, and the rule for never losing work to a deleted worktree.
tags:
  - 'layer:devops'
  - 'topic:sleep'
  - 'domain:infrastructure'
  - 'kind:decisions'
pinned: false
date: '2026-08-01'
---

## The rule

**The brain has exactly one home: the MAIN worktree. It stays inside the code repo.**

A linked worktree's `_dream_context/` is a *checkout artifact*, never authoritative. Treat it the way you treat `dist/` — something git materialised, not something that holds state anyone should trust.

This matters here more than in most repos: working across concurrent branches in separate worktrees is a standing preference in this project (recorded in `knowledge/archive/1.user-2026-h2.md`), and both the `goal-skill` handoffs and Claude Code's own `isolation: 'worktree'` open them routinely.

## Why the brain is not moved out of the codebase

Considered on 2026-08-01 and rejected — a "keep the brain outside the codebase" best practice sounds like it dissolves the whole problem, and it does not:

- **There is no mechanism.** No context-root override env var, no pointer file. `state/.config.json` lives *inside* the brain, so it structurally cannot point at it. The vault registry (`~/.dreamcontext/vaults.json`) only serves explicit `--vault <name>` and the launcher.
- **The opposite is a stated invariant.** `src/lib/git-sync/brain-repo.ts:12` — *"The brain always lives inside the code repo (`_dream_context/`)"*. Both sync modes (`full-repo`, `in-tree`) are built on it.
- **The cheap variant breaks two things.** Gitignoring all of `_dream_context/` does stop worktrees carrying a copy, but it kills team brain sync (nothing left to push) and only works for worktrees nested *inside* the repo: `resolveContextRoot`'s `MAX_WALK_UP = 5` means a **sibling** worktree (`../dreamcontext-memory-uplift` — the layout this project's own handoff task prescribes) finds no brain at all and the hooks throw. It converts a silent loss into a hard failure on the most common layout.

Genuinely relocating the brain is a separate, much larger feature (pointer + resolver + revising that invariant), not a documentation line.

## What actually goes wrong (and the number that proves it)

`resolveContextRoot` (`src/lib/context-path.ts:11`) walks up from cwd and stops at the first `_dream_context/`. It has no notion of git worktrees — no `git rev-parse --git-common-dir` anywhere in the resolve path. Two gitignore facts then split the brain in half:

- `core/` + `knowledge/` are **tracked** → a worktree checkout gets its own copy and the walk-up stops there.
- `state/` is **gitignored** (`.gitignore:27`, `brain-repo.ts:252-269`) → that copy has no `.sleep.json`, no session digests, no task files. It starts at debt 0.

Measured on this repo, 2026-08-01, `.claude/worktrees/launcher-space` vs main: debt 10 / 1 session / `last_sleep: null` vs debt 16 / 4 sessions / slept that day; 0 session digests vs 54; CHANGELOG 557 entries vs 571; 116 knowledge files vs 118. The `launcher-becomes-a-space` task existed in **both** copies and had already diverged — the worktree's (4147 B) held the full defect-and-verification log, main's (2367 B) did not.

Because `state/` is gitignored, none of that is committed anywhere. **A merge cannot bring it back — it was never in the branch. Deleting the worktree destroys it silently.**

## Operating rules

1. **Never read a worktree's `_dream_context/` as current.** It is frozen at the branch commit — assume it is weeks stale.
2. **Before deleting any worktree, check `<worktree>/_dream_context/state/`.** Task logs, `.sleep.json` and session digests live only there and are committed nowhere. Merge anything real into the main brain first.
3. **Don't try to reconcile two brains after the fact.** There is no merge path for `.sleep.json`; hand-merge the prose that matters and drop the rest.
4. **Run brain-affecting CLI (`sleep`, `tasks`, `brain sync`) from the main worktree** until the resolver fix lands.

## After the resolver fix

Task: `[[resolve-the-context-root-from-the-main-worktree-so-git-worktrees-share-one-brain]]`. Once a linked worktree resolves to the main worktree's brain, rules 1–4 stop being a discipline and become the default. Two consequences to expect rather than to debug:

- Brain writes from a worktree session land in the **main working tree**, not on the branch — so main's checkout shows uncommitted `core/` + `knowledge/` changes while you are on a branch elsewhere. That is correct, and it removes the `CHANGELOG.json` / `2.memory.md` LIFO merge-conflict class entirely.
- `sleep start`'s lock is path-derived (`<contextRoot>/state/.sleep.start.lock`). Two brains today means two lock files and no mutual exclusion; one brain means the lock finally engages.

## Related

- `[[document-or-automate-dashboard-deps-provision-for-fresh-worktrees]]` — different problem (a fresh worktree needs its own `dashboard/` npm install), same blast zone: worktrees are second-class here.
- `../.dc-base-<sha>` worktrees are the deliberate exception — `tests/unit/snapshot-byte-identity.test.ts` regenerates its golden from a detached base-SHA worktree and `chdir()`s into a *nested* fixture vault. The resolver fix is scoped to a worktree's ROOT-level brain precisely so that keeps working.
