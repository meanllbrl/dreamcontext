# Brain-Repo Sync — Merge Rules & State Machine

Authoritative spec for `dreamcontext brain sync` / `/dream-sync` (github-cloud-collaboration-brain-repo-sync,
plan v3.3). The CLI (`src/lib/git-sync/*`) implements everything on this page.

## 1. Modes

- **`full-repo`** — cloud sync ON: the WHOLE project (code + `.claude/` + `_dream_context/`) is the
  synced unit, pushed to the project's own `origin` on the CURRENT branch. Full auto-sync: fetch →
  merge → commit → push. Enabled via `dreamcontext brain enable` or the Settings toggle (requires a
  GitHub `origin`).
- **`in-tree`** (default) — cloud sync OFF: the brain is nested inside the code repo. **Commit-only —
  NEVER auto-pushes.** The scrub gate still runs before every in-tree commit — an in-tree commit
  lands in the code repo's history and can be pushed to a public OSS remote by the user's own normal
  `git push`.

## 2. Cloud-sync master switch (v3.3)

`brainRepo.enabled` (explicit) always wins. Absent ⇒ derived: **ON** iff the project is already
GitHub-connected (code repo's `origin` is a `github.com` URL, OR `taskBackend==='github'`) — **OFF**
otherwise (new/unconnected projects stay off until the user runs `dreamcontext brain enable` or
flips the Settings toggle). Enabling flips the mode to `full-repo`; disabling reverts to `in-tree`.
When OFF: `sleep done` skips the whole block with one dim line, the session-start pull is never
spawned, and `brain sync` returns `action:'disabled'`.

## 3. Tracked vs local — machine-local excludes under `_dream_context/`

In `full-repo` the whole project is staged with `git add -A` at the project root, so the project's
own `.gitignore` must exclude the machine-local brain runtime + secrets (prefixed `_dream_context/`).

| Path | `taskBackend=local` | `taskBackend=github`/`clickup` |
|---|---|---|
| `core/**` (soul/user/memory, features, CHANGELOG.json, RELEASES.json, taxonomy.json, objectives/) | tracked | tracked |
| `knowledge/**` | tracked | tracked |
| `overrides/**` | tracked | tracked |
| `state/*.md` (tasks) | tracked (source of truth) | gitignored (local mirror; issues/ClickUp are source of truth) |
| `state/.config.json`, `.active-version.json`, `.migrations.json` | tracked | tracked |
| `state/.secrets.json`, `.sleep.json`, `.sleep-history.json`, `.agent-sessions.json`, `.session-digests/`, `.conflicts/`, `.brain-merge/`, `.version-check.json`, `.auto-upgrade.json`, `.brain-local.json`, `.lab-prefs.json`, `.tasks-map.json`, `.tasks-sync.*`, `.tasks-queue.json`, `.obsidian/`, `tmp/`, `**/.env`, `**/.DS_Store` | gitignored | gitignored |
| `lab/**` (insights + cache) | tracked | tracked |
| `lab/credentials.json` / `lab/credentials.*` (except the tracked `credentials.example.json`) | gitignored | gitignored |

The `_dream_context/.gitignore` is built by `buildBrainGitignore(taskBackend)` and the project-root
excludes by `ensureFullRepoGitignore(projectRoot, taskBackend)` (both `src/lib/git-sync/brain-repo.ts`),
written gitignore-first before every whole-project stage; `ensureLocalOnlyArtifacts` re-asserts the
`_dream_context/.gitignore` after a clone/pull. `CLAUDE.md` and `.claude/` are plain files at the
project root and sync natively — no separate brain repo, no platform-layer symlinks.

## 4. Credential supply (GIT_ASKPASS — decision F)

The token is NEVER embedded in a remote URL, env, or argv. Every networked git call runs inside
`withGitCredentials(token, fn)` (`src/lib/git-sync/credentials.ts`):

1. Token written to a fresh `os.tmpdir()` file, created 0600 **atomically at write**
   (`writeFileSync(path, token, { mode: 0o600 })`), belt-and-suspenders `chmodSync`.
2. Child env: `GIT_ASKPASS=<askpass.cjs>`, `DREAMCONTEXT_ASKPASS_TOKEN_FILE=<tmp path>`,
   `GIT_TERMINAL_PROMPT=0`. Every call also passes `-c credential.helper=` to disable any
   persisted helper (osxkeychain etc).
3. `fn(env)` runs the actual git call.
4. `finally`: the tmp file is unlinked — even if `fn` throws.

`askpass.cjs` prints `x-access-token` for a username prompt, and the tmp file's token otherwise.

## 5. Token resolution (decision D)

`resolveBrainSyncToken(projectRoot)` — **M1: per-project `.secrets.json` github token → env
(`GITHUB_TOKEN`/`GH_TOKEN`)**. Secrets-first, env-last — the INTENTIONAL reverse of
`resolveGitHubToken` (env-first): a stray `GITHUB_TOKEN` in some inherited shell must never
silently override the account a non-technical collaborator is actually logged in as. (M2 inserts a
global `~/.dreamcontext/.secrets.json` tier between the two.)

## 6. Scrub gate (decisions — BLOCK vs WARN)

Runs before EVERY commit: in-tree commits, the full-repo whole-project push, and after every merge
(a merge can reintroduce a secret).

- **BLOCK** (aborts everywhere, loudly, non-zero exit): GitHub PAT/OAuth tokens, AWS/Google/Slack/
  OpenAI/Anthropic/Stripe keys, private-key headers, 3-part JWTs.
- **WARN** (non-blocking in every FOREGROUND mode — a human is present to judge): home-directory
  paths, generic `token = "..."` style assignments.
- **Headless pull-only is effective-`--strict`**: because NO human sees a background auto-commit
  before it can be pushed, pull-only treats a WARN hit as blocking too — it refuses the auto-commit
  and returns `blocked-scrub` with a "looks sensitive — review and run `brain sync` manually" notice
  surfaced at the next session start. Foreground `auto`/`push-only`/`--resume` keep WARN
  non-blocking.

## 7. Deterministic merge rules (per file class)

| File class | Rule |
|---|---|
| `core/CHANGELOG.json` | Set-union by fingerprint = hash(`date`+`type`+`scope`+`description`). Dedupe, sort date desc (LIFO). No entry lost. |
| `core/RELEASES.json` | Union by `version`/`id`. Same key both sides → field-merge: union `features[]`/`tasks[]`/`changelog[]`; scalars (`date`/`summary`/`status`/`breaking`) — non-empty side wins. |
| `state/*.md` (tasks) | **Furthest status wins** (`todo < in_progress < in_review < completed`) + **changelog LIFO union** (dedup by normalized text) + everything else via `merge3Bodies`. |
| `state/.config.json` | `people[]`/`packs[]`/`platforms[]` union; `peopleIdentity` key-union; other scalars — "ours" (local) wins on conflict. |
| `core/taxonomy.json` | Union tag entries per facet. |
| `knowledge/**` (incl. `knowledge/features/**` — features are typed knowledge) | **Clean union via `merge3Bodies` ONLY when no section was touched differently by both sides.** Otherwise (see §8) the CLI discards its own remote-wins attempt and defers to an agent. |
| anything else | Same rule as knowledge/features: clean union or defer. |

**CLI does:** every JSON class, task status/changelog, clean markdown unions — fully automatic,
zero data loss by construction. **Agent (`/dream-sync`) does:** only prose where two people
genuinely edited the same section.

## 8. The C1 discard contract (why some files defer to an agent)

`merge3Bodies` (`src/lib/task-backend/merge.ts`) is **remote-always-wins and never fails**: when
both sides changed the SAME section differently, it silently returns the remote version and
records the section name in `conflictSections`. Writing that "resolution" to disk would silently
throw away the local author's words. So the wrapper (`mergeMarkdownDoc`,
`src/lib/git-sync/semantic-merge.ts`) is stricter:

- `conflictSections.length > 0` → `{ merged: null, needsAgent: true }` — **the CLI writes nothing**;
  the section-overlap is real disagreement, not something a heuristic should silently arbitrate.
- `conflictSections.length === 0` → the union is safe and is written directly.

## 9. The conflict report (the agent handoff contract)

When any file needs an agent, the CLI writes `_dream_context/state/.brain-merge/report.json`
(gitignored) with `base`/`ours`/`theirs` snapshot files alongside it:

```jsonc
{ "startedAt": 1720000000, "remoteRef": "origin/main",
  "resolvedByCli": ["core/CHANGELOG.json", "state/task-foo.md"],
  "deferred": [ { "path": "knowledge/architecture.md", "class": "knowledge-md",
      "reason": "overlapping edits to same section",
      "basePath": "state/.brain-merge/knowledge__architecture.md.base.md",
      "oursPath": "state/.brain-merge/knowledge__architecture.md.ours.md",
      "theirsPath": "state/.brain-merge/knowledge__architecture.md.theirs.md" } ],
  "status": "awaiting-agent" }
```

`clearConflictReport` removes the report AND every snapshot file. It fires at exactly three
points: **(a)** `--continue` success (after the agent-resolved files are re-scrubbed and pushed —
this covers BOTH the classic-auto completion and the pull-only → `--resume` → `--continue`
completion, since they share the same `--continue` code path), **(b)** `--resume`'s START (the OLD
pull-only report is superseded by a fresh attempt, before that attempt runs), **(c)** a genuinely
STALE report (`!MERGE_HEAD && !pendingAgentMerge` — a report left behind with no live handoff).

**Staleness is NOT "no `MERGE_HEAD`" alone** — a legitimate pull-only defer, by design, has no
`MERGE_HEAD` (pull-only aborts the merge before returning `awaiting-agent`). A report is stale only
when BOTH `MERGE_HEAD` is absent AND `pendingAgentMerge` is false. A `pendingAgentMerge:true`
report is a LIVE handoff — never auto-cleared, consumable only via `--resume`.

## 10. The reentrancy guard — 5-clause precedence (v3.2)

Every `runBrainSync` call (full-repo only — in-tree bypasses this entirely, see §1) checks, in
order, BEFORE acquiring the lock:

1. **Flag misuse** → `invalid-flag` + a guiding `note`: `--continue` without `MERGE_HEAD`;
   `--resume` with `MERGE_HEAD` present; `--resume` without a pending handoff.
2. **`MERGE_HEAD` present** → only `--continue` proceeds; everything else disambiguates by the
   **conflict report** (a merge dreamcontext started ALWAYS leaves one; the user's own
   `git merge`/`rebase` — common in `full-repo`, where the git repo IS the project root —
   leaves none):
   - **no report** → `user-merge-in-progress` ("Finish your in-progress git merge first"). Never
     claims a team merge awaits `/dream-sync` (there's nothing for the agent to resolve).
   - **report with `codeConflicts`** → `code-conflict` (a full-repo code file for the human's
     editor — see §16), never an agent job.
   - **report without `codeConflicts`** → `already-awaiting-agent` (a real prose handoff for `/dream-sync`).
3. **`pendingAgentMerge && !MERGE_HEAD`** (a LIVE pull-only-deferred handoff) → only `--resume`
   proceeds; everything else returns `already-awaiting-agent`.
4. **Stale report** (`!MERGE_HEAD && !pendingAgentMerge`, and an existing report) → cleared, then
   proceed normally in the requested mode.
5. Otherwise → normal. Then `acquireBrainLock` — held by a LIVE holder → `locked`. A lock left by a
   DEAD PID past the staleness window is reclaimed (PID-liveness probe via `process.kill(pid, 0)`);
   a lock held by an ALIVE PID is never reclaimed regardless of age.

## 11. `--resume` vs `--continue`

- **`--continue`** — commit an IN-PROGRESS merge (requires a real `MERGE_HEAD`). The single
  completion path for BOTH the classic-auto defer and a resumed-pull-only re-defer.
- **`--resume`** — ATTENDED redo of a pull-only-deferred handoff (requires `pendingAgentMerge` with
  no `MERGE_HEAD`). Pre-clears the OLD report, then runs a fresh FOREGROUND fetch+merge (WARN
  non-blocking — a human/agent is present): if the remote moved on, this alone completes
  (`pushed`/`pulled`, `pendingAgentMerge` flips false, no agent step). If it re-defers, a FRESH
  report + a real `MERGE_HEAD` now exist for the classic `--continue`.

**Unattended callers (`sleep done` autoSync, the session-start pull, the dashboard) NEVER resume or
continue themselves** — they print the `/dream-sync` instruction on `already-awaiting-agent` and
stop. Only `/dream-sync` or a human at `brain sync` drives these two flags.

## 12. Pull-only — content delivery, safe headless (P2/C6)

The zero-git promise means a teammate's content must arrive even for someone who never sleeps,
without ever leaving the working tree broken mid-session:

1. Fetch. Remote not ahead → `noop`.
2. Dirty tracked tree → auto-commit first (`chore(brain): auto-checkpoint local edits before team
   merge`, M1 author tiering) under **effective-`--strict`** scrub (§6) — ANY hit refuses the
   auto-commit and returns `blocked-scrub`, delivering nothing.
3. Merge the remote ref:
   - **Clean or all-deterministic** → commit → `pulled`, `pulledUpdates>0`. **Never pushes.**
   - **Agent-class conflict** → write the report + snapshots, `git merge --abort` back to a CLEAN
     COMMITTED tree (never left mid-merge), `pendingAgentMerge:true` → `awaiting-agent`. The redo
     happens later via `--resume` (§11), driven by `/dream-sync` or a human — never automatically.

## 13. Non-fast-forward push race (C4)

`push` rejected → `fetch` → `attemptMerge` (clean/all-deterministic → commit, push again;
agent-class → write report, `awaiting-agent`, no infinite loop) → retry the push **at most once**.
Still rejected → a loud `GitSyncError` (this is the one case that's allowed to surface as a thrown
error rather than a typed `SyncResult`, since two failed pushes in a row means something
operationally wrong, not a normal conflict).

## 14. Commit author tiering (amendment 2)

**M1 tier (default):** let git resolve its own `user.name`/`user.email`. If unset, fall back to
the fixed `dreamcontext-sync <noreply@dreamcontext.local>` author (passed explicitly via
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` env) — a commit never fails on a missing git identity, and M1
takes zero forward dependency on M3. **M3 tier (adds, does not replace):** once a GitHub login
exists, `mapLoginToPerson(login)` swaps in the resolved `person:` identity on top.

## 15. Manual UI checklist (dashboard — appendix)

Verify by hand: device-flow login (shows `user_code`, opens `verification_uri`) AND the PAT-paste
fallback, both with the scope disclosure visible; the **Cloud sync toggle** turns whole-project
sync on (400 `no_origin` if the project has no GitHub `origin`) and off (reverts to `in-tree`);
the team-updates badge shows N after a teammate pushes, driven by a background fetch (the badge
endpoint itself makes no network call in the request path); a deferred prose merge surfaces a
one-click **"Resolve with AI"** banner.

## 16. full-repo hardening (2026-07-08) — refuse/defer/recover, never mangle

`full-repo` mode makes the WHOLE project repo the synced unit, so the engine touches real code
and the user's own git state. Five extra guarantees on top of the base merge contract:

- **Detached HEAD → refuse.** `full-repo` syncs the CURRENT branch (`git.currentBranch`); on a
  detached HEAD there is no branch to push. The engine returns **`detached-head`** ("check out a
  branch") instead of falling back to `main` (which would push detached commits onto the team's
  `main`). Brain-only modes keep their fixed `main` and never call `currentBranch`.
- **The user's own merge ≠ a team handoff.** The reentrancy guard (§10.2) distinguishes them by
  the conflict report's presence. A `MERGE_HEAD` with no report is the user's own `git
  merge`/`rebase` → **`user-merge-in-progress`**, never `already-awaiting-agent`.
- **Code conflicts defer to the HUMAN, never to the agent.** A conflicted path OUTSIDE
  `_dream_context/` is classified **`code`** (`resolveConflicts({fullRepo:true})` →
  `deferredToHuman`). It is NEVER semantically merged (`merge3Bodies` is for markdown/frontmatter
  and would mangle source) and NEVER sent to `/dream-sync`. Foreground: git's native 3-way markers
  are left in the tree for the editor; the human resolves, `git commit`s the merge, and the next
  sync pushes it (a locally-ahead HEAD now pushes — see below). Headless background pull: aborts to
  a clean tree (never breaks a working tree with no one watching); the next foreground sync
  re-surfaces it. The conflict report **separates `codeConflicts` (human) from `deferred` (agent)** so
  the two never blur → **`code-conflict`** outcome.
- **Locally-ahead HEAD pushes.** `autoSync` now proceeds (not `noop`) when HEAD is ahead of the
  remote even with a clean tree and remote-not-ahead — e.g. after the human finishes a code-conflict
  merge natively. Without this those commits would be silently stranded.
- **Auto-checkpoint transparency + opt-out.** The pull-only dirty-tree checkpoint reports
  `checkpointed` + `checkpointSha` (identifiable message, undo via `git reset --soft <sha>^`). The
  dashboard's on-open pull can pass **`noCheckpoint`** (the "auto-checkpoint on open" preference off) →
  a dirty tree is left UNTOUCHED (the pull is skipped) instead of auto-committing WIP.

**Failure classification (`src/lib/git-sync/failure.ts`).** Every thrown `GitSyncError` (and a
token-shaped `no-remote`) maps to a SPECIFIC failure + recovery, never a generic "sync failed":
`auth` → Reconnect GitHub; `permission` → names the repo + Contents-write scope; `network` →
"you're offline, will retry" (passive); `push-rejected` (non-fast-forward twice) → Retry sync;
`unrelated histories` → manual. The `/api/brain/sync` route returns these as `action:'error'` +
`failure` (200, so the UI renders the recovery affordance). No local work is ever lost — the bar is
that every failure is surfaced clearly and offers a concrete next step.

**Scrub is MANDATORY over EVERYTHING pushed.** In addition to the staged-commit scrub, EVERY pushing
path runs a pre-push **`scrubCommitRange`** over the commits about to leave: `autoSync` scrubs
`origin/main..HEAD` when HEAD is locally ahead; `pushOnlySync` (the `--push-only` CLI path) scrubs
`(revParse(origin/main) ?? EMPTY_TREE)..HEAD`. So commits made OUTSIDE our staged-commit path (a
human-finished code-conflict merge, any locally-ahead work) can never reach the remote unscrubbed. A
block there aborts the push, loudly.

**Scrub-block guidance.** `blocked-scrub` surfaces each `scrub.blocks` entry (file/line/rule); for a
file whose name marks it a local secret/config (`.env`, `credentials*`, `*.pem`, …) the dashboard
offers one-click **add-to-`.gitignore`** (`POST /api/brain/scrub/ignore`, server-revalidated). A real
source file is refused — the secret must be removed, not the file un-tracked. The path is rejected if it
contains gitignore metacharacters (`! # * ? [ ]`) or control chars: a leading `!` is a NEGATION that
would UN-ignore an already-excluded secret, so it can never be written.

**Mixed conflicts keep both records.** When one merge conflicts on BOTH a code file (human) and a brain
prose file (agent), the report records `codeConflicts` AND the agent `deferred` snapshots — the prose
conflict is never silently dropped.

**Status `mergeKind`.** `GET /api/brain/status` returns `mergeKind: 'agent' | 'code' | 'user' | null`
(+ `codeConflicts[]`) so the dashboard shows the right banner: Resolve-with-AI (agent), resolve-in-editor
(code), or finish-your-git-merge (user).
