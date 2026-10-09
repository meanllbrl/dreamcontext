---
id: feat_hAiJvY_G
type: feature
name: first-run-onboarding
description: >-
  One machine-readiness model that finds every missing piece (Node.js,
  dreamcontext CLI, Claude and its sign-in, Git, GitHub) and fixes it step by
  step, in the desktop Launcher and in dreamcontext setup
pinned: false
date: '2026-10-08'
status: in_review
created: '2026-10-08'
updated: '2026-10-09'
released_version: null
tags:
  - onboarding
  - 'topic:desktop'
  - 'topic:cli'
  - 'topic:macos'
  - 'layer:frontend'
  - 'layer:backend'
related_tasks:
  - >-
    first-run-onboarding-detects-every-missing-piece-on-this-machine-and-installs-it-step-by-step-in-the-app-and-in-the-cli
---

## Why

Owner 2026-10-08: dreamcontext must be one app with a perfect, very easy onboarding. The app dead-ended with no Node.js, never checked Claude, its sign-in, git or npm before a project existed, and ended by asking the user to paste a prompt into Claude by hand. App and CLI users must get the same detect-and-fix flow from one source of truth.

## User Stories

- [ ] As a new Mac user with no Node.js, I open the app and it sets Node.js up for me (a private, verified copy) and continues, instead of an error window.

- [ ] As a new user, the Launcher shows me what this Mac is missing (dreamcontext in Terminal, Claude and its sign-in, Git, GitHub) and one Set everything up button fixes it in order, with sign-ins as guided steps.

- [ ] As a new user, I create, open or clone a project in one short step that asks only a name and a location, with Git set up (even while Git is still installing) and my existing documents noticed.

- [ ] As a new user, Start with Claude opens my project with Claude already building its brain with me, instead of a prompt to copy and paste; Claude asks only what it cannot find in the folder and offers skill packs, installing only the ones I pick.

- [ ] As a terminal-only user, dreamcontext setup checks and fixes the same things with my confirmation, then the project, then offers to start Claude; doctor --machine tells me what is missing.

## Acceptance Criteria

- [x] One readiness model (src/lib/onboarding) with checks network, node, npm, cli, claude, claude-auth, git, github, gh, terminal; dependency blocking; a plan with git-install first and no optional fixes; used by the server, setup and doctor --machine.

- [x] Desktop shell: no usable Node.js (missing or older than 18) hands the splash over to the node-setup window, which downloads the pinned SHA-256-verified Node.js into ~/.dreamcontext/node/<version> (current link, npm-global prefix) and continues boot; startup failures show the same window in error mode with Try again.

- [x] Launcher onboarding: takeover at 0 vaults, a Finish setting up bar when projects exist but the machine is not ready; This Mac, Project, Start; one waiting card at a time; the Mac step auto-advances; Start with Claude is gated on agentCanSpawn plus sign-in and falls back to a visible notice.

- [x] CLI: setup machine phase (--skip-machine, --no-start, --yes auto fixes only, --defaults or non-TTY report only), git init wait-or-pending, hand-off to claude with the kickoff prompt; doctor --machine [--json] exits 1 while a required check is not ready.

- [x] Security: fix, cancel and agent-install routes require not-cloud, desktop, loopback peer and loopback Host; readiness refuses cross-site requests; shell-profile writes refuse unsafe characters; the Claude installer is downloaded to a temp file (https, size cap, shebang) and run with bash, never piped; a gh token import is scope-checked.

- [x] Project step: Create new and Open a folder take only a name and a location (no quiz, no platform or skill-pack picker); a cloned repo's description and the detected stack reach `init` silently; the kickoff prompt and the initializer skill (Phase 0 questions, Phase 5 skill packs via `install-skill --list`, install only the picks) own the questions. `verify:onboarding` 15/15 after the change.

- [ ] Validation: unit tests and build, npm run verify:onboarding and verify:node-setup-page, and the owner's manual checklist in the installed .app (never closed on the owner's behalf).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-10-09]** Owner: the project step asks nothing about the project. The More details (optional) form (description, target user, stack, focus, platforms, skill packs) is removed; Create new and Open a folder take only a name and a location (a cloned repo's description and the detected stack still reach init silently). The initializer chat asks what it cannot detect and recommends skill packs from install-skill --list, installing only the ones the user picks; the kickoff prompt says so.
- **[2026-10-08]** Git install starts first and never blocks the sequence; a project created while it runs gets a pending git init (~/.dreamcontext/onboarding.json, written via temp file + rename) run by the git-install completion hook, the readiness GET, the next setup or doctor --machine.
- **[2026-10-08]** Private Node.js lives in versioned folders with a current link and a fixed npm-global prefix, so a pin bump never loses the global dreamcontext CLI; the CLI shim names current, never a version folder.
- **[2026-10-08]** One GitHub sign-in shared with gh: the onboarding device flow asks for repo read:org gist only when gh is installed and hands the token to gh over stdin; an existing gh token is imported only when its scopes are a subset; a stored repo-only token is never widened silently (gh-signin is its own action).
- **[2026-10-08]** One front door: no new onboard command; dreamcontext setup gained the machine phase and doctor --machine is the read-only view.

## Technical Details

Plan of record: tmp/goal/onboarding-overhaul/plan-r3.md (contracts in section 3). Model: src/lib/onboarding/{types,copy,runner,checks,readiness,plan,folder,platform,fixes,download,github,pending-git}.ts. Server: src/server/routes/onboarding.ts (GET /api/onboarding/readiness, POST /api/onboarding/fix, POST /api/onboarding/fix/cancel), src/server/install-runs.ts (one run store shared with /api/agent/install and its status), guards requireLocalDesktop / requireLocalRead in src/server/routes/agent-spawn-shared.ts.

CLI: src/cli/onboarding-tty.ts (renderReadiness, runMachinePhase, awaitGitForInit, handOffToClaude), src/cli/commands/setup.ts (machine phase, git-init offer, hand-off), src/cli/commands/doctor.ts (--machine, machineToDoctorResults, codes doctor/machine-<id>). install.sh: brew install node, else the pinned private Node.js (mirror of assets/runtime-pins.json).

Dashboard: dashboard/src/pages/onboarding/ (Onboarding with stages machine / project / handoff, ReadinessChecklist, CheckRow, StatusGlyph, WaitingCard, ProjectStep, CloneFlow, Handoff, handoffPlan, GemConverge, StepDots); hooks/useOnboarding.ts; lib/agentReady.ts (agentCanSpawn); lib/startChatIntent.ts (acceptStartIntent, START_CHAT_INTENT_EVENT); OnboardingWizard was deleted. The agent surface's setup panel is ReadinessChecklist scope=agent.

Project step (2026-10-09): ProjectStep.tsx shows three cards, then ONE details screen with name and location only (plus the Git toggle). A clone's description and a detected stack are kept in a never-shown `details` state and sent to POST /api/launcher/scaffold. The scaffold API still accepts `platforms[]` (default claude) and `packs[]`, but the onboarding UI sends no packs: packs are chosen in the initializer chat (skill-initializer/SKILL.md, "Onboarding hand-off" and "Skill packs"; kickoff prompt in dashboard/src/lib/agentPrompt.ts).

Verification: scripts/verify/onboarding.mjs (S1-S14 + S8b, fixtures in scripts/verify/fixtures/onboarding/), scripts/verify/node-setup-page.mjs (P1-P5), tests/unit/onboarding-*.test.ts, setup-machine, doctor-machine, pending-git, start-intent. Status 2026-10-09: uncommitted in the working tree; goal-validator PASS on 2026-10-08 (611/611 targeted tests, cargo 42/42, verify:onboarding 15/15, verify:node-setup-page 37/37); a signed .app was built but not installed; the owner's .app checklist (plan-r3.md section 7) is pending.

Desktop shell: desktop/src-tauri/src/node_runtime.rs (resolve_usable_node, install_managed, pins), node_setup.rs (window node-setup, commands node_setup_start/status/cancel/retry/quit/open_download_page, hand_over, show_error), splash.rs open_behind with a successor; page frontend-placeholder/node-setup.html; capability node-setup.json. Testing switch DREAMCONTEXT_FORCE_NODE_SETUP=1.

## Notes

- **Planned, not built:** a first-run Welcome screen in front of the This Mac step was being designed on 2026-10-09 (board: _dream_context/whiteboards/onboarding/). Nothing in dashboard/src/pages/onboarding/ implements it yet.
- Pre-existing regressions seen during the release gate and proven not onboarding's (identical on a pure HEAD build): verify:claude-auth-switch 13 failures in the multi-account switch section, verify:agent-attachments 1 strict-mode locator failure.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-10-09 - Reconciled with the code (sleep)
- Status in_progress -> in_review: built and through goal-validator PASS; the owner's .app checklist is the open gate (Validation criterion stays unticked, stories stay unticked until he walks them).
- Five build criteria ticked from code, tests and verify runs; one criterion added for the name-and-location-only project step and the chat-owned skill-pack choice.
- Technical Details gained the project-step data flow, the verify scripts and a status line. Welcome screen noted as planned only.
- Decisions re-dated (duplicate date prefixes removed).

### 2026-10-09 - Created from the built work
- PRD created from task first-run-onboarding-detects-every-missing-piece-on-this-machine-and-installs-it-step-by-step-in-the-app-and-in-the-cli once lanes A-K had landed. Status in_progress: built and unit-tested, not yet through the final gate, browser verify or the owner's .app checklist. Supersedes the wizard parts of launcher-quiz-onboarding.
### 2026-10-08 - Created
- Feature PRD created.
