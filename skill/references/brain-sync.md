# Brain sync (GitHub cloud sync for the whole project)

The one reference for **cloud sync** — what it is, the two modes, how it's set up, how it authenticates, what it syncs, the cross-machine / cross-OS setup, and how to diagnose it when it silently stops. This is a *different* feature from **cloud task sync** (ClickUp/GitHub Issues — tasks only) and **federation** (read-only recall across your own separate projects — nothing is copied). Say so if the user conflates them.

**Guide the user into this** the moment they say *"use this with my team / on another machine," "share the brain," "sync my project to GitHub."* Do NOT answer "we don't support that" — this is the feature.

## What it is

The project (your code + `.claude/` + the brain under `_dream_context/`) is synced to the project's **own GitHub repo** and kept in sync across people/machines. Local markdown + JSON on disk stays canonical (local-first); **git is just the transport**, not a new database. Merges are **agent-assisted and semantic**: the CLI auto-resolves deterministic files itself and only defers overlapping *prose* edits to the `/dream-sync` skill.

A **master switch** (cloud sync ON/OFF) gates everything: `dreamcontext brain enable` / `brain disable`, resolved and shown by `dreamcontext brain status`. There is one shared, whole-project model — `.claude/` and `_dream_context/` live in the code repo and travel together, so there is no separate brain repo and no symlink layer to maintain.

## The two sync modes

Mode lives in `_dream_context/state/.config.json` under `brainRepo.mode`. **Anything not `full-repo` resolves to `in-tree`.**

| Mode | Git root | Remote | Branch | What lands on the remote | Auto-push? |
|---|---|---|---|---|---|
| **`full-repo`** | the **project root** (the whole project is the repo) | the project's own `origin` | the **current** branch (never assumes `main`) | the **entire project** — code + `.claude/` + `_dream_context/` nested inside it | **Yes** |
| **`in-tree`** (default) | the project root | — | — | nothing pushed — **commit-only**, stages `_dream_context/` and commits locally | **No, never** |

- **`full-repo`** is cloud sync turned ON: the whole project folder is the synced repo (brain nested under `_dream_context/`, plus root `CLAUDE.md` / `.claude/`). It **refuses on a detached HEAD** (`detached-head`) and force-writes machine-local excludes into the project-root `.gitignore` before every sync so secrets/lock files never get staged by `git add -A`.
- **`in-tree`** is the safe default (cloud sync OFF): it commits the brain alongside your code but **never pushes** — turn cloud sync on to promote it to `full-repo`.

**Turning it on/off:** cloud sync is the master switch. Enable it from the **dashboard** (Settings → Brain → Cloud sync toggle; server route `POST /api/brain/settings`) or the CLI (`dreamcontext brain enable`). Enabling requires the project to already have a GitHub `origin` (it errors `no_origin` otherwise) and flips the mode to `full-repo`; disabling reverts to `in-tree`.

## Set it up (CLI)

```bash
# 0. Token FIRST — every push needs it (see Auth for scope + resolution order).
dreamcontext config github-token "$(gh auth token)"   # per-MACHINE token; gitignored, never travels with the repo

# 1. Make sure the project has a GitHub origin (full-repo pushes to it).
git remote add origin https://github.com/<you-or-org>/<repo>.git   # skip if it already has one

# 2. Turn cloud sync ON — flips the project to full-repo (whole project → origin, current branch).
dreamcontext brain enable

dreamcontext brain status                        # verify: mode full-repo, remote, resolved cloud-sync switch
```

Every push uses the **same resolved token**, so set the token (or be logged into dreamcontext for the global store) *before* enabling. (PowerShell/cmd have no `$(…)` — use `dreamcontext config github-token <token>` or set `GITHUB_TOKEN`.) Because the whole project is the synced unit, `CLAUDE.md` and `.claude/` are already at the project root and sync natively — nothing extra to wire up.

## Auth — how sync authenticates (NOT gh, NOT the keychain)

The token is resolved by **`resolveBrainSyncToken`, secrets-first, env-last**:

1. per-project `_dream_context/state/.secrets.json` → `github.token` (set via `dreamcontext config github-token`)
2. global `~/.dreamcontext/.secrets.json` → `github.token` (the account you logged into dreamcontext as)
3. env `GITHUB_TOKEN`, then `GH_TOKEN`

**The `gh` CLI and git credential helpers are never consulted** — helpers are actively disabled on every networked git call (`-c credential.helper=`), and the token is handed to git only through a `GIT_ASKPASS` helper pointed at a fresh **0600** temp file (never in the remote URL or argv). `.secrets.json` is written **gitignore-first** (the write aborts if it can't be ignored) and chmod **0600**.

> **Required scope (this bites people):** sync **pushes repo contents**, so the token needs classic **`repo`** scope, or a fine-grained PAT with **Contents: read & write** on the project repo. `config github-token` writes the SAME per-project store the GitHub-Issues *task* backend uses — but a fine-grained **Issues-only** token (enough for task sync) will authenticate that and yet **silently fail every push**. When in doubt, use a classic `repo` token or a fine-grained PAT that includes Contents:write.

## Shared vs machine-local config (important)

- **`state/.config.json` — SYNCS** across machines/teammates. It holds the `brainRepo` block: **`mode`, `enabled`, `autoSync`**. Consequence: **an explicit `mode` or `enabled` propagates to everyone** on the next sync — they are a *shared* decision, not per-machine.
- **`state/.brain-local.json` — MACHINE-LOCAL** (gitignored). Only runtime bookkeeping: `lastFetchAt`, `pulledUpdates`, `pendingAgentMerge`, `needsTaskSync`, `codeRepoPath`. This is what keeps two machines from clobbering each other's sync state.
- **`enabled` resolution:** an explicit `true`/`false` in `.config.json` wins (and is shared). If **absent**, it's **derived per-machine** — ON iff this machine is GitHub-connected (local `origin` is github.com, OR `taskBackend=github`), else OFF. So the *default* is per-machine; an *explicit* toggle is global.

## Lifecycle — when sync happens

- **Session start:** a **detached, non-blocking** `brain sync --pull-only` fires in the background (only when `enabled` + mode `full-repo` + `autoSync`; honors `DREAMCONTEXT_BRAIN_SYNC=0`). Its results land on the **NEXT** session (you see the previous pull's `pulledUpdates`).
- **`sleep done`:** runs a foreground `brain sync` (fetch → merge → commit → push) when `autoSync` is set. **Sync failure never fails sleep** — but on a prose conflict it pauses with `awaiting-agent` and prints the `/dream-sync` prompt.
- **Manual, any time:** `dreamcontext brain sync` (flags: `--pull-only`, `--push-only`, `--strict`, `--continue`, `--resume`).
- **Commit messages** (so you can recognize them): `chore: sync project (dreamcontext)` (full-repo), `chore(brain): sync` (in-tree commit-only), `chore(brain): merge team updates` (auto-merge), `… (agent-resolved)` (after `/dream-sync`).

**Conflicts:** deterministic files — JSON (changelog/releases/config/taxonomy) and task `.md` — are auto-merged by the CLI. Only overlapping edits to the **same `##` section of a knowledge/feature (prose) doc** defer to the agent (`awaiting-agent`): a report with base/ours/theirs snapshots is written to `state/.brain-merge/`, the `/dream-sync` skill writes the real merge, and `brain sync --continue` commits it. Real **code** conflicts go to the human with native git markers (never to the agent). A **scrub gate** runs before every commit and push (BLOCK always stops it; WARN stops only under `--strict` or a headless pull-only).

## Cross-machine / cross-OS setup

The project is portable, but each machine needs a few things right. **The #1 real-world failure is a machine with no token — sync then silently no-ops.**

- **Every machine needs its own token.** `.secrets.json` is gitignored, so the token does **not** travel with the repo. On each new machine run **`dreamcontext config github-token "$(gh auth token)"`** (or set `GITHUB_TOKEN`, or log in so the global `~/.dreamcontext/.secrets.json` is populated). No `gh`/keychain fallback exists — if none of the three token sources is set, push/pull just quietly do nothing.
- **The project must be its OWN git root (the enclosing-repo trap).** In `full-repo` the repo root must be the project folder. Verify: `git -C <project> rev-parse --show-toplevel` should print *that* folder — **not climb into an enclosing parent repo** (e.g. a home-directory `~/.git`). If sync targets the wrong tree, hunt for a parent `.git` above the folder and remove its stray `origin`.
- **Windows / WSL — line endings.** dreamcontext does **not** normalize CRLF. On Windows, set `git config core.autocrlf false` (or commit a `.gitattributes` with `* text=lf`) in the project repo to avoid phantom whole-file conflicts on markdown/JSON. A mixed Windows⇄WSL checkout of the *same* folder is the highest-risk setup — pick one.
- **Node/npx must be on PATH for GUI-launched agents.** The background pull launches via the node binary directly (not a bare `dreamcontext`), so a minimal Finder/Explorer PATH is tolerated — but the CLI itself must be installed on each machine.
- **Credential helpers are bypassed by design**, so macOS Keychain / Windows Credential Manager / libsecret differences don't matter — auth is only the resolved token via askpass.
- **No symlinks involved.** Because the whole project syncs natively, `CLAUDE.md`/`.claude/` are plain files at the project root on every OS — no symlink layer, so Windows Developer-Mode / elevation is never required for cloud sync.

**Per-OS quick matrix**

| | macOS | Linux | Windows / WSL |
|---|---|---|---|
| Token | `config github-token "$(gh auth token)"` | same | same (in WSL use the WSL `gh`; native Windows: `GITHUB_TOKEN` or dashboard login) |
| Line endings | fine | fine | **set `core.autocrlf false`** |
| Git root check | `rev-parse --show-toplevel` | same | same |
| Keychain/helper | bypassed | bypassed | bypassed |
| `CLAUDE.md` / `.claude/` | plain files (sync natively) | native | native (no symlinks, no Developer Mode needed) |
| Token scope | `repo` / Contents:write | same | same (an Issues-only fine-grained token won't push) |

**Operating rule — sleep before you leave a machine.** `sleep done` pushes the consolidated state, so the next machine pulls clean. Skipping it is the main way two machines drift into an avoidable prose conflict.

## Onboarding a second machine (same user) — checklist

**On Windows, read the Cross-OS section first** — the token syntax (step 2) and `core.autocrlf` (step 5) differ.

1. `git clone <project-url>` — the whole project (code + `.claude/` + `_dream_context/`).
2. `dreamcontext config github-token "$(gh auth token)"` — the per-machine token (Windows: `config github-token <token>` or `GITHUB_TOKEN`; scope must include Contents:write).
3. `dreamcontext brain status` — confirm mode `full-repo`, remote, cloud-sync ON, right git root.
4. `dreamcontext brain sync --pull-only` — take the latest, verify a clean pull.
5. On Windows: `git config core.autocrlf false` first.

## When sync is "silently failing" (troubleshooting)

Failures are swallowed by design (they never fail sleep or block a session). When a user says *"my teammate isn't seeing my changes"* / *"the other machine is stale,"* run this, in order:

1. **`dreamcontext brain status`** — is cloud sync ON (and *why* — explicit vs derived)? Right `mode` and `remote`? Any `mergeInProgress` / `pendingAgentMerge`?
2. **Token present?** Check `state/.secrets.json` (or global / `GITHUB_TOKEN`). No token = silent no-op — the most common cause. Set it and retry.
3. **`dreamcontext brain scrub`** — a scrub-gate BLOCK is the #1 *silent* blocker; it stops the push before anything leaves. Fix the flagged secret/absolute-path and re-sync.
4. **`dreamcontext brain sync --push-only`** (foreground) — forces the error to the surface instead of the background swallowing it.
5. **Detached HEAD** → `detached-head` refusal. Check out a branch.
6. **Wrong git root** → the enclosing-repo trap above (`rev-parse --show-toplevel`).
7. **`pendingAgentMerge` / `awaiting-agent`** → a prose conflict is waiting: run **`/dream-sync`**, then `brain sync --continue`.

## `brain` command surface (5 subcommands)

`status`, `enable`, `disable`, `scrub`, `sync`. (`sync` flags: `--pull-only`, `--push-only`, `--strict`, `--continue`, `--resume` — the last two are attended-only; never drive them unattended.) `brain enable` turns cloud sync ON (whole-project `full-repo` sync — needs a GitHub `origin`); `brain disable` reverts to `in-tree`. Merge internals live in the `/dream-sync` skill and `skill-sync/references/merge-rules.md`; full feature status in `knowledge/features/brain-repo-sync.md`.
