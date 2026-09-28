---
id: command-not-found-in-a-spawned-child
name: 'Command Not Found in a Spawned Child: Shim the Running Binary'
description: >-
  A process spawned outside a login shell (launchd, a Finder-started app)
  cannot see the user's PATH. Do not guess an install dir: write a tiny shim
  that execs the exact binary the parent is running, and put its dir on the
  child's PATH only when nothing already resolves.
tags:
  - 'kind:pattern'
  - architecture
  - 'topic:agents'
  - 'topic:automations'
  - 'topic:macos'
pinned: false
date: '2026-09-25'
---

## The rule

When a child process must call our own CLI (or `node`), and that child can be started from an environment without the user's login-shell PATH, give it a **shim**, not a guessed PATH:

1. Write a two-line script into a directory of its own: `exec <process.execPath> <process.argv[1]> "$@"`. The running process is the one thing that always knows which install is the right one.
2. Put that directory on the child's PATH **only when no binary of that name already resolves**. A developer's linked checkout, or whatever the user deliberately has on PATH, must never be shadowed; the shim only rescues a lookup that would otherwise fail.
3. Append (do not prepend) node's own directory, so `node`/`npx` resolve too.
4. Never throw. A shim that cannot be written degrades to the PATH as it was.

## Why not guess

The directory holding the user's CLI (nvm version dir, `~/.local/bin`, Homebrew, a linked checkout) is exactly what a process without a login shell cannot know. A guessed directory can hold a **different** install, which is worse than "command not found": it runs, with the wrong version, and nothing says so. Sourcing an interactive login shell works but is slow and can print or prompt; it belongs to install-time resolution, not every spawn.

## Occurrences

- **2026-07-25, the launchd dispatcher wrapper.** launchd gives `/usr/bin:/bin:/usr/sbin:/sbin`. The plist runs a generated `~/.dreamcontext/bin/automations-dispatch.sh` that execs the absolute CLI resolved at install, with a `zsh -ilc` fallback when that path is gone. See `knowledge/macos-launchd-scheduler-constraints.md`.
- **2026-09-24, app-started automation runs.** An @mention or "run now" from the desktop app inherits the Finder PATH, so the agent's `dreamcontext automations post` failed with "command not found" and `npx` with "npx not found" (a real Tilki run said so in its own document; the thread stayed empty). `src/lib/automations/cli-path.ts` writes `~/.dreamcontext/bin/cli/dreamcontext` and `executeClaudeDetached` uses `cliAwarePath(claudeAwarePath())`, which covers runs, question runs and reply turns at once.

## How to prove it

Launch the server with a stripped PATH (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`) and have a stand-in child call the CLI **by name**. `verify:agent-attachments` does this; reverting `cliAwarePath` makes it fail with exactly `spawnSync dreamcontext ENOENT`. A test that runs from your own terminal proves nothing here, because your shell already has the PATH (see the sibling rule in `ask-the-subject-not-its-configuration.md`: an agent's own shell is inside the environment being varied).

## Related

- `ask-the-subject-not-its-configuration.md`: the same instinct (the running thing knows what a configuration can only guess), applied to binary resolution.
- `mutation-test-assertions.md`: the stripped-PATH check is a FIX assertion proven against the reverted code.
- Feature: `knowledge/features/automations-scheduled-headless-claude-jobs.md`, Constraints 2026-09-24.
