---
id: feat_bt9zRxgL
status: in_review
created: '2026-06-13'
updated: '2026-06-13'
released_version: null
tags:
  - desktop
  - onboarding
  - backend
  - frontend
related_tasks:
  - launcher-quiz-onboarding
---

## Why

Onboarding a project today requires the terminal for anything beyond registering an already-initialized folder. The beta Launcher should let users create or initialize projects via a quiz — no terminal needed — then hand off to Claude Code for LLM-powered enrichment.

## User Stories

- [x] As a user, I can create a brand-new project OR set up an existing folder from the Launcher via a quiz, with no terminal, so onboarding is self-serve.
- [x] As a user, when a folder I pick already contains `_dream_context/`, the wizard skips the quiz and registers + opens the vault directly, so I don't re-answer questions about a project that's already initialized.
- [x] As a user, I see a copyable Claude Code prompt on the success screen so I can kick off the LLM-powered enrichment step without memorizing any commands.

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

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-06-13]** No new Tauri/Rust commands needed — scaffold is a server endpoint; the native folder picker (dialog plugin) and `WebviewWindow` API were already in place. Rich LLM enrichment is explicitly OUT of the in-app scope (Tauri app ships no LLM); handed off via a copyable prompt card pointing the user to Claude Code.
- **[2026-06-13]** Login-shell probe (`$SHELL -lc`) is required for CLI detection: a `.app` launched from Finder/Spotlight does NOT inherit the interactive-shell PATH, so `command -v dreamcontext` fails without the login flag even when the binary is installed via nvm/brew/volta. Same pattern used by the Rust `find_node()` resolver.
- **[2026-06-13]** CLI entry point resolved as `process.env.DREAMCONTEXT_CLI ?? process.argv[1]` — same override the Rust shell uses — so test harnesses can inject a mock CLI without recompiling Tauri.

## Technical Details

Key files:
- `src/server/routes/launcher.ts` — `handleLauncherScaffold`, `handleLauncherDetect`, `handleLauncherDefaults`
- `src/server/index.ts` — registers the three `/api/launcher/*` routes
- `src/lib/tech-stack.ts` — `detectTechStack(dir)` extracted from `init` command; shared by `init` and the detect endpoint
- `src/lib/ensure-cli.ts` — `ensureCliInstalled()`: login-shell probe + `npm -g install`, injectable runner, never throws
- `dashboard/src/pages/LauncherPage.tsx` — `+ Add Project` tile entry point
- `dashboard/src/components/OnboardingWizard` — multi-step quiz stepper (new/existing, Browse picker, review, success + prompt card)
- `dashboard/src/hooks/useLauncher.ts` — `useScaffoldProject`, `useDetectStack`, `useLauncherDefaults`
- `dashboard/src/lib/desktop.ts` — folder picker (already existed for the multi-vault feature)
- `desktop/src-tauri/src/lib.rs` — dead `open_vault` + `Port` state removed; `cargo check` clean

Scaffold execution sequence per call:
1. `init --yes --name <n> --description <d> --user <u> --stack <s> --priority <p> --platforms claude` (cwd=target)
2. `setup --defaults --platforms claude` (cwd=target)
3. `addVault` to register in `~/.dreamcontext/vaults.json`

Step 1 exits 0 with a warning if `_dream_context/` already exists → idempotency.

## Notes

Rich enrichment (code scan, smart fill) is intentionally deferred to the agent side. See `initializer-improvements` task for the Claude Code enrichment flow that users trigger via the copyable prompt on the success screen.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-13 - Feature PRD created (sleep-product consolidation)
- Created from task `launcher-quiz-onboarding` (all 9 acceptance criteria verified, status in_review).
- All user stories and acceptance criteria marked done.
- Technical details reflect the shipped implementation.
