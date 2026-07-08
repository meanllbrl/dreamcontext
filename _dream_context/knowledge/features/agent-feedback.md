---
id: feat_vYyVonQ3
status: active
created: '2026-06-10'
updated: '2026-07-08'
released_version: v0.8.7
tags:
  - 'topic:cli'
  - backend
  - 'topic:agents'
related_tasks: []
type: feature
name: agent-feedback
description: ''
pinned: false
date: '2026-06-10'
---

## Why

Dreamcontext-using agents sometimes hit gaps in their own context management tooling — a memory they cannot see, a CLI command that would help but doesn't exist, a bug causing silent failure. Without a structured path to report these gaps, they either silently work around them (perpetuating the issue) or file ad hoc issues inconsistently. This feature gives any agent a single, structured, safe channel to file a GitHub issue against the upstream dreamcontext project — with a draft-confirm-file flow to prevent accidental noise.

## User Stories

- [x] As an agent that hits a recall gap (memory I cannot see), I can run `dreamcontext feedback` to file a structured issue against the upstream dreamcontext repo so the gap is addressed in a future release.
- [x] As an agent that encounters a missing CLI command or friction point, I can draft a feedback issue with a full scenario, confirm it, and submit it — without needing to manually construct a `gh issue create` command.
- [x] As an agent without a GitHub account configured, I get clear guidance on how to install `gh`, authenticate, and create an account so I can proceed without blocking the user.
- [x] As a developer, the SKILL.md informs every session agent that it is a "field reporter" responsible for filing gaps rather than silently working around them, so the habit is established by default.

## Acceptance Criteria

- [x] `dreamcontext feedback` CLI command ships with `--title`, `--category`, `--scenario`, `--dry-run`, `--yes` flags.
- [x] Six feedback categories: `bug`, `missing-cli`, `unseen-memory`, `feature`, `docs`, `other`.
- [x] Issue body template includes: Scenario / Expected / Gap / Repro / Suggested improvement / Environment (dreamcontext version + OS). Hidden `<!-- filed via \`dreamcontext feedback\` -->` marker for analytics/dedup.
- [x] Jaccard-similarity dedup check against open issues with the `agent-feedback` label before filing; user warned if a similar issue exists.
- [x] `gh` detection: checks for binary presence, auth status, and account; outputs actionable instructions for each missing prerequisite including `github.com/signup` link when no account.
- [x] Dry-run (`--dry-run`) renders the full issue body for review before any network call.
- [x] Issues always target `meanllbrl/dreamcontext` — never the user's own project remote.
- [x] `agent-feedback` label created on-demand if absent.
- [x] 17 unit tests covering template rendering, category validation, dedup, and `gh` detection parsing.
- [x] SKILL.md "Improving dreamcontext (Agent Feedback)" section: trigger conditions (recall gap, missing CLI, bug, awkward workaround), responsibility mindset ("you are its field reporter"), draft→confirm→file loop, account-creation guidance, quality bar.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-06-10]** Draft-confirm-file flow is the only supported path. `SKILL.md` explicitly prohibits running `gh issue create` by hand — the command exists to provide a single canonical channel with template, dedup, and upstream targeting baked in.
- **[2026-06-10]** Issues always target `meanllbrl/dreamcontext` (constant `UPSTREAM_REPO`), not the user's own repo. Feedback must flow from user projects to the dreamcontext maintainers — there is no per-project routing.
- **[2026-06-10]** Dedup uses Jaccard similarity on title tokens (not exact match) to catch near-duplicate phrasings; threshold tunable but currently a conservative check. False negatives (missing a similar issue) are preferred over false positives (blocking legitimate new reports).
- **[2026-06-10]** The behavior is probabilistic (SKILL.md prompt-level), not deterministic (no hook fires automatically on recall misses). A future hardening would inject a UserPromptSubmit reminder when recall returns empty results, similar to the sleep-debt reminder pattern.

## Technical Details

**Core files:**
- `src/lib/feedback.ts` — pure testable core: `GhStatus` interface + `detectGh()`, issue body template builder, Jaccard dedup against existing issues (`searchExistingIssues()`), `createIssue()` wrapper around `gh issue create`. Constants: `UPSTREAM_REPO = 'meanllbrl/dreamcontext'`, `FEEDBACK_LABEL = 'agent-feedback'`, `FEEDBACK_MARKER` (hidden HTML comment).
- `src/cli/commands/feedback.ts` — CLI surface: `commander` sub-command with `--title`, `--category`, `--scenario`, `--dry-run`, `--yes`. Flow: gh detection → missing-prereq guidance → template render → dedup → preview → confirm → create → print URL.
- `src/cli/index.ts` — command registered under the tool-agnostic help group.
- `skill/SKILL.md` — "Improving dreamcontext (Agent Feedback)" section (always-applied via `alwaysApply: true`): trigger list, "field reporter" framing, draft→confirm→file loop, `gh issue create` prohibition, account creation guidance, quality bar for scenario completeness.
- `tests/unit/feedback.test.ts` — 17 unit tests: template, category guards, Jaccard dedup, `gh` detection output parsing.

**gh detection hierarchy**: (1) binary on PATH → (2) auth status (`gh auth status`) → (3) account existence. Each level produces a targeted instruction string if missing. `GhStatus.accountExists` is inferred from auth output containing a username.

**FeedbackCategory map**: each category carries a human title and an optional GitHub built-in label co-applied on create (e.g., `bug`→`bug`, `missing-cli`→`enhancement`).

## Notes

- The `transcript.ts` TypeScript error visible during implementation is pre-existing and unrelated to feedback.ts — confirmed by empty git diff on that file.
- A production test issue was intentionally NOT filed during development (to keep the upstream repo clean); dedup + createIssue are tested via injected runners.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-10 - Implemented (session eed6d72c)
- `src/lib/feedback.ts` + `src/cli/commands/feedback.ts` + command registration shipped.
- SKILL.md "Improving dreamcontext (Agent Feedback)" section added.
- 17 unit tests; full suite 1056 passing.
- `agent-feedback` label creation + dry-run verified live.

### 2026-06-10 - Created
- Feature PRD created.
