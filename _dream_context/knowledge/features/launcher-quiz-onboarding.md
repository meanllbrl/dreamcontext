---
id: feat_bt9zRxgL
status: active
created: '2026-06-13'
updated: '2026-07-11'
released_version: v0.8.7
tags:
  - 'topic:desktop'
  - onboarding
  - backend
  - frontend
related_tasks:
  - >-
    launcher-clone-from-github-sign-in-search-repos-clone-locally-dreamcontext-ready
type: feature
name: launcher-quiz-onboarding
description: ''
pinned: false
date: '2026-06-13'
---

## Why

Onboarding a project today requires the terminal for anything beyond registering an already-initialized folder. The beta Launcher should let users create or initialize projects via a quiz — no terminal needed — then hand off to Claude Code for LLM-powered enrichment.

## User Stories

- [x] As a user, I can create a brand-new project OR set up an existing folder from the Launcher via a quiz, with no terminal, so onboarding is self-serve.
- [x] As a user, when a folder I pick already contains `_dream_context/`, the wizard skips the quiz and registers + opens the vault directly, so I don't re-answer questions about a project that's already initialized.
- [x] As a user, I see a copyable Claude Code prompt on the success screen so I can kick off the LLM-powered enrichment step without memorizing any commands.
- [x] As a user, the wizard asks which coding platforms I want (e.g., Claude Code — recommended — and/or Codex) and which optional skill packs to include, for both new-project AND existing-folder flows, so I can tailor the setup without going to the terminal.
- [x] As a user, the platform and pack choices I make are applied by the scaffold call (`setup --platforms` + `install-skill` per pack) so the resulting project is ready for my preferred tools immediately.
- [x] As a user, I can sign in with GitHub (device flow or PAT) from the Launcher and see a searchable list of my accessible repos (owner, collaborator, org member), so I can clone one locally without touching the terminal.
- [x] As a user, when I select a GitHub repo to clone, I see a destination picker with a Browse button and can choose where to clone it, so I control my project layout.
- [x] As a user, cloning happens as a cancelable background job with live git progress (`Receiving objects: N%...`), so I see what's happening and can cancel mid-clone if needed.
- [x] As a user, if the cloned repo already contains `_dream_context/`, it registers directly and opens the project window immediately, skipping the quiz since it's already dreamcontext-ready.
- [x] As a user, if the cloned repo is a bare codebase (no `_dream_context/`), the wizard flows into the existing-folder quiz (pre-filled with repo description and detected stack), so init+setup make it dreamcontext-ready.
- [x] As a user, if I try to clone into a destination that already exists, I get three clear options (Open the existing project / Use the existing folder / Choose another location) instead of a dead-end error, so I'm never stuck.

## Acceptance Criteria

- [x] POST /api/launcher/scaffold creates a new project (mkdir under parentDir) OR initializes an existing folder: runs `init --yes` (with quiz answers) + `setup`, then registers the vault; idempotent when `_dream_context/` already exists (just registers)
- [x] Strict-pick body + validation: parentDir/projectPath must be absolute & exist; new-project name rejects path traversal (`/`, `..`); target must not be a non-empty existing dir; behind existing cross-site CSRF guard; no stderr/path leakage in errors
- [x] Server spawns the bundled CLI via `execFile` (`process.execPath` + `process.argv[1]`) with `cwd=target` — no shell, arg array, timeout — so the server's own `cwd` is never mutated
- [x] GET /api/launcher/detect?path=<abs> returns detected tech stack, `hasContext`, and `basename` for quiz prefill / skip-quiz when the folder is already a vault; `detectTechStack` refactored to accept a `dir` param (moved to `src/lib/tech-stack.ts`)
- [x] Launcher shows a `+ Add Project` entry → onboarding wizard: choose new vs existing, quiz steps (name, parentDir w/ default `~/projects` + Browse, description, target user, tech stack, priority), confirm, success screen with "open window" + copyable "hand off to Claude" enrichment prompt
- [x] Existing folder already containing `_dream_context/` skips the quiz: registers + opens directly
- [x] Dead Rust `open_vault` command + `Port` state removed from `desktop/src-tauri/src/lib.rs`; `cargo check` passes
- [x] Unit + integration tests: scaffold validation (bad parentDir, traversal name, idempotent existing `_dream_context/`) and a real tmpdir scaffold producing `_dream_context/` + `.claude/` + registered vault; full vitest green (1784 tests)
- [x] Scaffold auto-ensures a PATH-resolvable global `dreamcontext` CLI: probes `command -v dreamcontext` via login shell (`$SHELL -lc`), runs `npm install -g dreamcontext@latest` only when missing; best-effort (never blocks creation); `{ cli: { status } }` returned in scaffold response and surfaced on success screen
- [x] Wizard includes a platform-selection step (Claude Code recommended + Codex as option) and an optional skill-pack selection step; both appear for new-project AND existing-folder flows
- [x] `GET /api/launcher/catalog` returns available platforms and skill packs
- [x] `POST /api/launcher/scaffold` accepts `platforms[]` and `packs[]`; runs `setup --platforms <selected>` (idempotent for existing vaults) then `install-skill <pack>` for each selected pack
- [x] `GET /api/launcher/github/repos?q=<substring>` returns the signed-in user's accessible GitHub repos (owner, collaborator, org member), sorted by last-pushed, with optional substring filter; desktop-gated, 401 no_token, 401 bad_token on GitHub auth reject
- [x] `resolveLauncherGitHubToken()` resolves launcher-tier GitHub token (global signed-in account → env; never per-project since the launcher has no project yet)
- [x] `listGitHubRepos()` fetches ≤3 pages from GitHub API, supports substring filter + direct owner/repo lookup with swallowed 404, capped at 50 repos
- [x] `POST /api/launcher/clone { url, parentDir }` validates synchronously via `planGitHubClone` (canonicalRemote-only URL, absolute+existing parentDir, sanitized folder name, direct-child + dest-not-exists guards) then returns `cloneId`; desktop-gated, strict-pick body, 401 no_token, 400 clone_failed, 409 clone_in_progress for concurrent same-dest attempts
- [x] `GET /api/launcher/clone/status?cloneId=` streams clone job state + live git progress + final result; desktop-gated
- [x] `POST /api/launcher/clone/cancel { cloneId }` cancels a running clone via SIGTERM (idempotent, no-op if already done/error); desktop-gated
- [x] `cloneStreaming()` spawns `git clone --progress` with the same hardened argv as every other networked git call (credential-helper disabled, protocol.ext.allow=never, -- terminator), streams stderr (where git writes progress), cancelable via SIGTERM (git cleans the partial dest itself), 10-min timeout with SIGTERM→10s SIGKILL escalation (so git still has time to clean up before hard kill)
- [x] `cloneDestsInFlight` Map prevents concurrent clones into the same destination (409 guard)
- [x] `pruneCloneRuns()` evicts finished/error jobs when the in-memory map exceeds size limit, but NEVER evicts a running job (closed eviction-bypassing-dest-guard gap)
- [x] When the cloned repo already has `_dream_context/`, the clone route registers the vault directly (name collision auto-suffixed -2..-9), runs best-effort `ensureCliInstalled`, and returns `vaultName` so the wizard can hand off to `onReady(vaultName)`
- [x] When the cloned repo is a bare codebase (no `_dream_context/`), the wizard flows into the existing-folder detail quiz; `probeFolder()` pre-checks the exact destination and offers "Open the existing project"/"Use the existing folder"/"Choose another location" on conflict instead of a dead-end error
- [x] GitHub repo description pre-fills the quiz description field; detected tech stack pre-fills the stack field
- [x] Unit tests: 16 lib tests (`git-sync-github-browse.test.ts`: token tiering, pagination/filter/direct-lookup, clone guards, askpass env hygiene incl. token never in env values + tmp file unlinked) + 8 route-guard tests (`launcher-clone-route.test.ts`: 403/401/400/409 paths); full vitest green

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-10]** Clone from GitHub is a BACKGROUND JOB with live progress streaming — not synchronous. `POST /clone` validates and returns immediately with a `cloneId`; `GET /clone/status` streams state+progress+result. This keeps the dashboard server event loop responsive during a multi-minute git clone and enables the live "Receiving objects: N%" tail in the wizard.
- **[2026-07-10]** `pruneCloneRuns()` NEVER evicts a running clone — size-limit eviction only touches finished/error jobs. A running job's eviction would bypass the `cloneDestsInFlight` 409 guard, allowing a concurrent same-dest clone (security/correctness gap). Reviewer found this in initial FAIL → fixed → PASS.
- **[2026-07-10]** Clone timeout is SIGTERM (git cleans up) → 10s → SIGKILL, not immediate SIGKILL. Direct SIGKILL strands the partial destination folder, causing every retry to hit "already exists" with no hint it's an orphaned partial clone. The 10s window lets git remove the partial dest before hard kill.
- **[2026-07-10]** Destination conflict is pre-checked with three options, not a dead-end error. If `probeFolder` finds the exact destination already exists: dreamcontext project → "Open the existing project" (register+open); non-dreamcontext folder → "Use the existing folder" (flow into quiz); both offer "Choose another location" (go back to dest picker). Never a "folder exists, abort" wall.
- **[2026-07-10]** Repo description + detected stack pre-fill the quiz when the cloned codebase is bare (no `_dream_context/`). Makes the init+setup step faster and more accurate for a known-good GitHub repo.
- **[2026-06-14]** Platform + pack selection applies to BOTH new-project and existing-folder flows. `setup` is idempotent so re-running it on an already-initialized vault is safe. Skill packs are installed sequentially (one `install-skill` child-spawn per pack) after `setup` completes. Skill selection is optional — the wizard presents packs from the catalog but nothing is required.
- **[2026-06-13]** No new Tauri/Rust commands needed — scaffold is a server endpoint; the native folder picker (dialog plugin) and `WebviewWindow` API were already in place. Rich LLM enrichment is explicitly OUT of the in-app scope (Tauri app ships no LLM); handed off via a copyable prompt card pointing the user to Claude Code.
- **[2026-06-13]** Login-shell probe (`$SHELL -lc`) is required for CLI detection: a `.app` launched from Finder/Spotlight does NOT inherit the interactive-shell PATH, so `command -v dreamcontext` fails without the login flag even when the binary is installed via nvm/brew/volta. Same pattern used by the Rust `find_node()` resolver.
- **[2026-06-13]** CLI entry point resolved as `process.env.DREAMCONTEXT_CLI ?? process.argv[1]` — same override the Rust shell uses — so test harnesses can inject a mock CLI without recompiling Tauri.

## Technical Details

Key files:
- `src/lib/git-sync/github-browse.ts` — NEW: launcher-tier GitHub repo browsing + clone-to-local (`resolveLauncherGitHubToken`, `listGitHubRepos`, `cloneGitHubRepo`, `planGitHubClone`)
- `src/lib/git-sync/git.ts` — `cloneStreaming()` (NEW): background-job clone with live stderr progress streaming, SIGTERM-cancelable, 10-min timeout with SIGTERM→SIGKILL escalation
- `src/server/routes/launcher.ts` — `handleLauncherScaffold`, `handleLauncherDetect`, `handleLauncherDefaults`, `handleLauncherCatalog`; NEW: `handleLauncherGitHubRepos` (GET /github/repos), `handleLauncherClone` (POST /clone), `handleLauncherCloneStatus` (GET /clone/status), `handleLauncherCloneCancel` (POST /clone/cancel), clone job tracking (`cloneRuns` Map, `cloneDestsInFlight` Set, `pruneCloneRuns`)
- `src/server/index.ts` — registers the launcher routes (adds clone endpoints)
- `src/lib/tech-stack.ts` — `detectTechStack(dir)` extracted from `init` command; shared by `init` and the detect endpoint
- `src/lib/ensure-cli.ts` — `ensureCliInstalled()`: login-shell probe + `npm -g install`, injectable runner, never throws
- `dashboard/src/pages/LauncherPage.tsx` — `+ Add Project` tile entry point
- `dashboard/src/pages/OnboardingWizard.tsx` — multi-step quiz stepper; NEW: third mode "Clone from GitHub" (repo selection with inline GitHub sign-in + debounced search, destination picker, live clone progress with Cancel, conflict resolution with three options, auto-register or flow into quiz)
- `dashboard/src/hooks/useLauncher.ts` — `useScaffoldProject`, `useDetectStack`, `useLauncherDefaults`; NEW: `useGithubRepos`, `useCloneGithubRepo`, `useInvalidateLauncher` (re-query launcher state when a clone registers a vault)
- `dashboard/src/lib/desktop.ts` — folder picker (already existed for the multi-vault feature)
- `dashboard/src/context/I18nContext.tsx` — NEW i18n keys for clone mode UI strings
- `desktop/src-tauri/src/lib.rs` — dead `open_vault` + `Port` state removed; `cargo check` clean

Scaffold execution sequence per call (new-project or existing-folder mode):
1. `init --yes --name <n> --description <d> --user <u> --stack <s> --priority <p> --platforms <selected>` (cwd=target; skipped with warning if `_dream_context/` already exists → idempotent)
2. `setup --defaults --platforms <selected>` (cwd=target; idempotent for existing vaults)
3. For each selected skill pack: `install-skill <pack>` (cwd=target; sequential child-spawns)
4. `addVault` to register in `~/.dreamcontext/vaults.json`

Clone from GitHub execution sequence:
1. User signs in with GitHub (device flow or PAT) → token stored in `~/.dreamcontext/secrets.json` (global, not per-project)
2. User searches/browses accessible repos (`GET /api/launcher/github/repos?q=`)
3. User picks a repo and destination parent dir → `POST /api/launcher/clone` validates synchronously via `planGitHubClone`, returns `cloneId`
4. Background clone job spawns: `cloneStreaming()` runs `git clone --progress` with hardened argv (askpass-credentialed, transport-locked), streams stderr progress to in-memory state
5. Wizard polls `GET /api/launcher/clone/status?cloneId=` for live `Receiving objects: N%` tail + state (running/done/error/canceled)
6. On completion: if cloned repo has `_dream_context/` → registers vault directly (auto-suffix on name collision) + runs `ensureCliInstalled` + opens project window; else → flows into existing-folder quiz (pre-filled) for init+setup
7. Cancel flow: `POST /api/launcher/clone/cancel` sends SIGTERM → git cleans partial dest → job state → canceled

`GET /api/launcher/catalog` returns `{ platforms: [{ id, name, recommended }], packs: [{ id, name, description }] }`. Frontend renders Claude Code as the pre-checked recommended platform; Codex as an opt-in. Skill pack step is optional (zero selections is valid). If the layout overflows (many packs), the wizard scrolls within the step — no pagination needed for the current pack count.

## Notes

Rich enrichment (code scan, smart fill) is intentionally deferred to the agent side. See `initializer-improvements` task for the Claude Code enrichment flow that users trigger via the copyable prompt on the success screen.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-11 - Clone from GitHub mode added (sleep-product consolidation, working tree)
- Added third onboarding mode: Clone from GitHub. Sign in with GitHub (device flow or PAT, reusing existing launcher-tier auth), search accessible repos (owner/collaborator/org member, sorted by last-pushed), clone to local parent dir as a cancelable background job with live git progress streaming.
- Added 6 user stories (sign-in+browse, destination picker, live progress+cancel, direct register for dreamcontext repos, flow into quiz for bare codebases, conflict resolution with three options).
- Added 16 acceptance criteria (GitHub API routes, `resolveLauncherGitHubToken`, `listGitHubRepos`, clone infrastructure with `planGitHubClone`/`cloneStreaming`/routes/job tracking, conflict pre-check, pre-fill, 24 unit tests).
- Added 5 constraints: background-job rationale, pruneCloneRuns never-evict-running guard, SIGTERM→SIGKILL timeout escalation, dest-conflict three-option flow, repo-description+stack pre-fill.
- Updated Technical Details: new `github-browse.ts`, `cloneStreaming()` in `git.ts`, clone routes + job tracking in `launcher.ts`, OnboardingWizard third mode, new hooks.
- Added "Clone from GitHub execution sequence" alongside the existing scaffold sequence.
- Status: working tree (uncommitted); task `launcher-clone-from-github-sign-in-search-repos-clone-locally-dreamcontext-ready` completed 2026-07-10.

### 2026-06-14 - Onboarding enrichment: platform + pack selection (sleep-product consolidation)
- Added platform-selection step (Claude Code recommended + Codex) and optional skill-pack selection step to wizard, for both new-project and existing-folder flows.
- Added `GET /api/launcher/catalog` endpoint; `POST /api/launcher/scaffold` now accepts `platforms[]` + `packs[]`.
- Added 2 user stories, 3 acceptance criteria; scaffold execution sequence updated to reflect multi-platform + skill-pack steps.
- Added constraint: `setup` is idempotent; skill packs installed sequentially after setup.

### 2026-06-13 - Feature PRD created (sleep-product consolidation)
- Created from task `launcher-quiz-onboarding` (all 9 acceptance criteria verified, status in_review).
- All user stories and acceptance criteria marked done.
- Technical details reflect the shipped implementation.
