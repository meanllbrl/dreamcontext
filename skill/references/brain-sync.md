# Brain sync (GitHub cloud sync for the brain)

The one reference for the **shared brain repo** — what it is, the three modes, how it's set up, how it authenticates, what it syncs, the cross-machine / cross-OS setup, and how to diagnose it when it silently stops. This is a *different* feature from **cloud task sync** (ClickUp/GitHub Issues — tasks only) and **federation** (read-only recall across your own separate projects — nothing is copied). Say so if the user conflates them.

**Guide the user into this** the moment they say *"use this with my team / on another machine," "share the brain," "put the brain in its own repo," "sync my brain to GitHub."* Do NOT answer "we don't support that" — this is the feature.

## What it is

The brain (`_dream_context/`) is mirrored to a **GitHub remote** and kept in sync across people/machines. Local markdown + JSON on disk stays canonical (local-first); **git is just the transport**, not a new database. Merges are **agent-assisted and semantic**: the CLI auto-resolves deterministic files itself and only defers overlapping *prose* edits to the `/dream-sync` skill.

A **master switch** (cloud sync ON/OFF) gates everything: `dreamcontext brain enable` / `brain disable`, resolved and shown by `dreamcontext brain status`.

## The three sync modes

Mode lives in `_dream_context/state/.config.json` under `brainRepo.mode`. **Anything not `separate`/`full-repo` resolves to `in-tree`.**

| Mode | Git root | Remote | Branch | What lands on the remote | Auto-push? |
|---|---|---|---|---|---|
| **`separate`** | `_dream_context/` (the brain is its OWN repo) | a dedicated brain repo (`brainRepo.remote`) | always `main` | the **contents of `_dream_context/`** at the repo root (core/, knowledge/, state/…) | **Yes** |
| **`full-repo`** | the **project root** (whole project is the repo) | the project's own `origin` | the **current** branch (never assumes `main`) | the **entire project** — code + `_dream_context/` nested inside it | **Yes** |
| **`in-tree`** (default) | — | — | — | nothing pushed — **commit-only**, stages `_dream_context/` and commits locally | **No, never** |

- **`separate`** is the classic "team shares one brain repo, separate from the code repo." Created by `brain init` / joined by `brain attach`.
- **`full-repo`** makes the whole project folder the synced repo (brain nested under `_dream_context/`, plus root `CLAUDE.md` / `.claude/` if present). It **refuses on a detached HEAD** (`detached-head`) and force-writes machine-local excludes into the project-root `.gitignore` before every sync so secrets/lock files never get staged by `git add -A`.
- **`in-tree`** is the safe default: it commits the brain alongside your code but **never pushes** — you sync manually or promote to another mode.

**Switching modes:** there is **no `brain scope` / `brain mode` CLI command.** Switching to/from `full-repo` is done from the **dashboard** (Settings → Brain → Sync scope; server route `POST /api/brain/scope`). `full-repo` requires the project to already have a GitHub `origin` (it errors `no_origin` otherwise). To go the other way it becomes `separate` if a brain remote exists, else `in-tree`. `brain init` produces `separate`; a project with no brain config is `in-tree`.

## Set it up (CLI)

```bash
# 0. Token FIRST — init/attach and every push need it (see Auth for scope + resolution order).
dreamcontext config github-token "$(gh auth token)"   # per-MACHINE token; gitignored, never travels with the repo

# Create a brand-new shared brain repo (PRIVATE by default), scrubbed first push → separate mode
dreamcontext brain init --owner <you-or-org> --name <repo>   # --code-repo <url> pins the paired code repo

# OR join an existing brain repo (a TRUST decision — it loads into every session)
dreamcontext brain discover                      # list repos tagged `dreamcontext-brain` you can access
dreamcontext brain attach <brain-repo-url>       # trust warning + read-only diff preview, then confirm

dreamcontext brain status                        # verify: mode, remote, resolved cloud-sync switch
```

`brain init` creates the GitHub repo through the API with the **same resolved token**, so set the token (or be logged into dreamcontext for the global store) *before* `init`/`attach`. (PowerShell/cmd have no `$(…)` — use `dreamcontext config github-token <token>` or set `GITHUB_TOKEN`.)

Carry the Claude Code layer with the brain so a fresh clone is ready to use:

```bash
dreamcontext brain platform        # moves CLAUDE.md + .claude/ into _dream_context/platform/ and symlinks from root
dreamcontext brain platform --status
```
(Separate mode only — its repo is rooted at `_dream_context/`, so root files wouldn't sync otherwise. In `full-repo` the root files sync natively and `brain platform` is unnecessary. Every `brain sync` re-creates missing root symlinks on a fresh clone; `doctor` flags broken links.)

## Auth — how the brain repo authenticates (NOT gh, NOT the keychain)

The token is resolved by **`resolveBrainSyncToken`, secrets-first, env-last**:

1. per-project `_dream_context/state/.secrets.json` → `github.token` (set via `dreamcontext config github-token`)
2. global `~/.dreamcontext/.secrets.json` → `github.token` (the account you logged into dreamcontext as)
3. env `GITHUB_TOKEN`, then `GH_TOKEN`

**The `gh` CLI and git credential helpers are never consulted** — helpers are actively disabled on every networked git call (`-c credential.helper=`), and the token is handed to git only through a `GIT_ASKPASS` helper pointed at a fresh **0600** temp file (never in the remote URL or argv). `.secrets.json` is written **gitignore-first** (the write aborts if it can't be ignored) and chmod **0600**.

> **Required scope (this bites people):** brain sync **pushes repo contents**, so the token needs classic **`repo`** scope, or a fine-grained PAT with **Contents: read & write** (add **Administration: read & write** on the owner if you'll `brain init` to *create* the repo). `config github-token` writes the SAME per-project store the GitHub-Issues *task* backend uses — but a fine-grained **Issues-only** token (enough for task sync) will authenticate that and yet **silently fail every brain push**. When in doubt, use a classic `repo` token or a fine-grained PAT that includes Contents:write.

## Shared vs machine-local config (important)

- **`state/.config.json` — SYNCS** across machines/teammates. It holds the whole `brainRepo` block: **`mode`, `enabled`, `remote`, `autoSync`**. Consequence: **an explicit `mode` or `enabled` propagates to everyone** on the next sync — they are a *shared* decision, not per-machine. (This is deliberate: one remote can only have one structure, so all machines must agree on the mode.)
- **`state/.brain-local.json` — MACHINE-LOCAL** (gitignored). Only runtime bookkeeping: `lastFetchAt`, `pulledUpdates`, `pendingAgentMerge`, `needsTaskSync`, `codeRepoPath`. This is what keeps two machines from clobbering each other's sync state.
- **`enabled` resolution:** an explicit `true`/`false` in `.config.json` wins (and is shared). If **absent**, it's **derived per-machine** — ON iff this machine is GitHub-connected (local `origin` is github.com, OR `taskBackend=github`, OR `brainRepo.remote` is set), else OFF. So the *default* is per-machine; an *explicit* toggle is global.

## Lifecycle — when sync happens

- **Session start:** a **detached, non-blocking** `brain sync --pull-only` fires in the background (only when `enabled` + mode `separate`/`full-repo` + `autoSync`; honors `DREAMCONTEXT_BRAIN_SYNC=0`). Its results land on the **NEXT** session (you see the previous pull's `pulledUpdates`).
- **`sleep done`:** runs a foreground `brain sync` (fetch → merge → commit → push) when `autoSync` is set. **Sync failure never fails sleep** — but on a prose conflict it pauses with `awaiting-agent` and prints the `/dream-sync` prompt.
- **Manual, any time:** `dreamcontext brain sync` (flags: `--pull-only`, `--push-only`, `--strict`, `--continue`, `--resume`).
- **Commit messages** (so you can recognize them): `chore(brain): sync` (separate/in-tree), `chore: sync project (dreamcontext)` (full-repo), `chore(brain): merge team updates` (auto-merge), `… (agent-resolved)` (after `/dream-sync`).

**Conflicts:** deterministic files — JSON (changelog/releases/config/taxonomy) and task `.md` — are auto-merged by the CLI. Only overlapping edits to the **same `##` section of a knowledge/feature (prose) doc** defer to the agent (`awaiting-agent`): a report with base/ours/theirs snapshots is written to `state/.brain-merge/`, the `/dream-sync` skill writes the real merge, and `brain sync --continue` commits it. In `full-repo`, real **code** conflicts go to the human with native git markers (never to the agent). A **scrub gate** runs before every commit and push (BLOCK always stops it; WARN stops only under `--strict` or a headless pull-only).

## Cross-machine / cross-OS setup

The brain is portable, but each machine needs a few things right. **The #1 real-world failure is a machine with no token — sync then silently no-ops.**

- **Every machine needs its own token.** `.secrets.json` is gitignored, so the token does **not** travel with the repo. On each new machine run **`dreamcontext config github-token "$(gh auth token)"`** (or set `GITHUB_TOKEN`, or log in so the global `~/.dreamcontext/.secrets.json` is populated). No `gh`/keychain fallback exists — if none of the three token sources is set, push/pull just quietly do nothing.
- **The brain folder must be its OWN git root (the enclosing-repo trap).** In `separate` mode the repo root must be `_dream_context/`; in `full-repo` it must be the project folder. Verify: `git -C <that folder> rev-parse --show-toplevel` should print *that* folder — **not climb into an enclosing parent repo** (e.g. a home-directory `~/.git` or a wrapping code repo). dreamcontext guards this at `init`/`attach`/disconnect, but the per-sync path only checks "is a git repo," so a misplaced enclosing `.git` can hijack resolution. If sync targets the wrong tree, hunt for a parent `.git` above the folder and remove its stray `origin`.
- **Windows / WSL — line endings.** dreamcontext does **not** normalize CRLF. On Windows, set `git config core.autocrlf false` (or commit a `.gitattributes` with `* text=lf`) in the brain repo to avoid phantom whole-file conflicts on markdown/JSON. A mixed Windows⇄WSL checkout of the *same* folder is the highest-risk setup — pick one.
- **Node/npx must be on PATH for GUI-launched agents.** The background pull launches via the node binary directly (not a bare `dreamcontext`), so a minimal Finder/Explorer PATH is tolerated — but the CLI itself must be installed on each machine.
- **Credential helpers are bypassed by design**, so macOS Keychain / Windows Credential Manager / libsecret differences don't matter — auth is only the resolved token via askpass.
- **Windows symlinks (separate mode).** `brain platform` shares CLAUDE.md/.claude by **symlinking** them from the project root, and every `brain sync` re-creates missing links. On Windows, creating symlinks normally needs **Developer Mode enabled or an elevated shell** — otherwise `brain platform` fails. On a Windows brain, prefer **`full-repo` mode**, where root files sync natively and no symlinks are involved.

**Per-OS quick matrix**

| | macOS | Linux | Windows / WSL |
|---|---|---|---|
| Token | `config github-token "$(gh auth token)"` | same | same (in WSL use the WSL `gh`; native Windows: `GITHUB_TOKEN` or dashboard login) |
| Line endings | fine | fine | **set `core.autocrlf false`** |
| Git root check | `rev-parse --show-toplevel` | same | same |
| Keychain/helper | bypassed | bypassed | bypassed |
| `brain platform` symlinks | native | native | **need Developer Mode / elevated shell** — or use `full-repo` (root files sync natively) |
| Token scope | `repo` / Contents:write | same | same (an Issues-only fine-grained token won't push) |

**Operating rule — sleep before you leave a machine.** `sleep done` pushes the consolidated state, so the next machine pulls clean. Skipping it is the main way two machines drift into an avoidable prose conflict.

## Onboarding a second machine (same user) — checklist

**On Windows, read the Cross-OS section first** — the token syntax (step 2), symlink privilege (step 3), and `core.autocrlf` (step 6) all differ.

1. `git clone <brain-or-project-url>` (or `dreamcontext brain attach <url>` in an existing checkout).
2. `dreamcontext config github-token "$(gh auth token)"` — the per-machine token (Windows: `config github-token <token>` or `GITHUB_TOKEN`; scope must include Contents:write).
3. `dreamcontext brain platform` — re-create root `CLAUDE.md` / `.claude/` symlinks (separate mode; Windows needs Developer Mode/elevation, or use `full-repo` mode).
4. `dreamcontext brain status` — confirm mode, remote, cloud-sync ON, right git root.
5. `dreamcontext brain sync --pull-only` — take the latest, verify a clean pull.
6. On Windows: `git config core.autocrlf false` first.

## When sync is "silently failing" (troubleshooting)

Failures are swallowed by design (they never fail sleep or block a session). When a user says *"my teammate isn't seeing my changes"* / *"the other machine is stale,"* run this, in order:

1. **`dreamcontext brain status`** — is cloud sync ON (and *why* — explicit vs derived)? Right `mode` and `remote`? Any `mergeInProgress` / `pendingAgentMerge`?
2. **Token present?** Check `state/.secrets.json` (or global / `GITHUB_TOKEN`). No token = silent no-op — the most common cause. Set it and retry.
3. **`dreamcontext brain scrub`** — a scrub-gate BLOCK is the #1 *silent* blocker; it stops the push before anything leaves. Fix the flagged secret/absolute-path and re-sync.
4. **`dreamcontext brain sync --push-only`** (foreground) — forces the error to the surface instead of the background swallowing it.
5. **`full-repo` on a detached HEAD** → `detached-head` refusal. Check out a branch.
6. **Wrong git root** → the enclosing-repo trap above (`rev-parse --show-toplevel`).
7. **`pendingAgentMerge` / `awaiting-agent`** → a prose conflict is waiting: run **`/dream-sync`**, then `brain sync --continue`.

## `brain` command surface (10 subcommands)

`status`, `enable`, `disable`, `init`, `attach`, `discover`, `platform`, `scrub`, `sync`, `detach`. (`sync` flags: `--pull-only`, `--push-only`, `--strict`, `--continue`, `--resume` — the last two are attended-only; never drive them unattended.) Merge internals live in the `/dream-sync` skill and `skill-sync/references/merge-rules.md`; full feature status in `knowledge/features/brain-repo-sync.md`.
