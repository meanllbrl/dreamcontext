---
id: feat_cSWvTF1K
status: in_review
created: '2026-02-25'
updated: '2026-06-21'
released_version: 0.1.0
tags:
  - devops
  - onboarding
  - architecture
  - topic:agents
related_tasks:
  - initializer-skill
  - initializer-improvements
---

## Why

Setting up the _dream_context/ directory structure correctly is tedious and error-prone when done manually. The `init` command bootstraps the entire scaffold in one command, detects the tech stack automatically, runs token substitution on templates, and sets up the Claude Code hooks — turning a blank project into a fully agent-aware workspace in under a minute. Beyond scaffolding, the `initializer` skill drives a sub-agent-led brain bootstrap that progressively ingests the user's actual material (docs, wikis, Obsidian/Notion exports, ADRs, codebases) into the knowledge/feature/task hierarchy — delivering a meaningful brain, not just empty template files. The system also auto-detects sparse or migrating brains and proactively offers to run the initializer workflow.

## User Stories

- [x] As a developer, I want `dreamcontext init` to scaffold the full `_dream_context/` directory structure so I don't have to create files and folders manually.
- [x] As a developer, I want tech stack detection from `package.json` so the tech stack field is pre-populated without me having to type it.
- [x] As a developer, I want template files populated with real project values (name, description, stack, priority) via token substitution so the initial files are immediately useful.
- [x] As a developer, I want `dreamcontext install-skill` to install SKILL.md and hooks into `.claude/` so Claude Code picks them up automatically.
- [x] As a developer, I want the Initializer sub-agent to do the full setup interactively — scanning the codebase, asking targeted questions, and writing rich content — so I get a meaningful context, not just scaffolding.
- [x] As a developer, I want the `--yes` flag to skip all prompts and use sensible defaults so the init can be scripted non-interactively.
- [x] As a developer, I want `install-skill` to migrate the old `npx dreamcontext snapshot` hook to the new `hook session-start` format so upgrading from older versions is automatic.
- [x] As a developer, I want `dreamcontext setup` to run init + install-skill in one command so I don't need to chain two separate commands for a fresh project.
- [x] As a developer, I want `dreamcontext init --multi-product=a,b` to scaffold per-product data-structures and knowledge files so multi-product projects are fully set up from init.
- [x] As a developer with an existing docs folder / wiki / Obsidian export / ADR set, I can invoke the `initializer` skill and have sub-agents progressively ingest that material into the knowledge/feature/task hierarchy — so I get a real brain, not empty templates.
- [x] As a developer, I want dreamcontext to proactively detect a sparse, stub, or migrating brain and offer to run the initializer workflow, so I never need to know the skill exists to benefit from it.
- [x] As a developer running the initializer on a codebase-only repo (no existing docs), I want the scout → ingest → verify flow to still produce a useful brain from the code alone.
- [x] As a developer, I want the standalone `dreamcontext-initializer` agent removed and replaced by the interactive `initializer` skill, so there is a single bootstrap surface with no confusion.

## Acceptance Criteria

- `dreamcontext init` creates `_dream_context/core/`, `_dream_context/core/features/`, `_dream_context/knowledge/`, `_dream_context/state/`.
- Template files written: `0.soul.md`, `1.user.md`, `2.memory.md`, `3.style_guide_and_branding.md`, `4.tech_stack.md`, `5.data_structures.sql`. Slot 6+ left intentionally empty for user customization.
- JSON files written as empty arrays: `CHANGELOG.json`, `RELEASES.json`.
- Initial CHANGELOG.json entry added: `{ date, type: "chore", scope: "project", description: "Agent context initialized" }`.
- Template tokens replaced: `{{PROJECT_NAME}}`, `{{PROJECT_DESCRIPTION}}`, `{{TARGET_USER}}`, `{{TECH_STACK}}`, `{{PRIORITY}}`, `{{DATE}}`.
- Tech stack auto-detected from `package.json` (React, Next.js, Vue, Express, TypeScript, Tailwind, Prisma, etc.), `pubspec.yaml`, `Cargo.toml`, `go.mod`, `requirements.txt`/`pyproject.toml`.
- Running init on a directory that already has `_dream_context/` returns an error and does not overwrite.
- `dreamcontext init --multi-product=a,b` creates `_dream_context/core/data-structures/a.md`, `_dream_context/core/data-structures/b.md`, `_dream_context/knowledge/products/a.md`, `_dream_context/knowledge/products/b.md`.
- `dreamcontext setup` runs init then install-skill in one orchestrated flow, supporting `--defaults`, `--yes`, `--platforms`, `--packs`, `--multi-product` flags; writes `.config.json` with full setup state.
- `install-skill` copies `SKILL.md` to `.claude/skills/dreamcontext/SKILL.md`.
- `install-skill` copies all `agents/*.md` files to `.claude/agents/`.
- `install-skill` writes `SessionStart` and `Stop` hooks to `.claude/settings.json`, creating or merging with existing settings.
- `install-skill` migrates old `npx dreamcontext snapshot` SessionStart hook to `npx dreamcontext hook session-start` if found.
- SessionStart hook uses `matcher: "startup|resume|compact|clear"` and timeout 10s; Stop hook has no matcher and timeout 5s.
- `initializer` core skill (`skill-initializer/SKILL.md`) is a user-invocable orchestrator (not a sub-agent) that drives: Phase 0 RECOGNIZE & OFFER → Scaffold → Scout (manifest) → Confirm-hierarchy (user owns shape) → Progressive ingest (fan-out, coverage-tracked) → Core files → Verify (PASS/FAIL gate) → Report.
- Three core sub-agents ship: `initializer-scout` (read-only intake, produces ingestion manifest), `initializer-ingestor` (fan-out worker, distils source material into knowledge/feature/task/bookmarks), `initializer-verifier` (PASS/FAIL gate: no placeholders, `dreamcontext doctor` clean, recall works, no feature/knowledge dup).
- Auto-detection fires for: no `_dream_context/` at all (no-brain), sparse/stub brain (empty `knowledge/`, zero features, untouched template files), migration-from-folder (an existing `_dream_context/` or notes dir elsewhere), mass-new-source (user points at a docs folder / export / wiki dump). Each condition has a deterministic detection check and a corresponding integration test.
- False-positive guard: a normal session on a healthy brain with no new source does NOT fire the offer. Detection has own try/catch; hook exits 0 even on detection failure.
- The standalone `dreamcontext-initializer` agent was REMOVED (PR #39); the `initializer` skill is now the single bootstrap surface and handles codebase-only repos via a light scout+ingest pass. `dreamcontext update` prunes the deleted agent from all platform mirrors via manifest diff.
- `installCoreForPlatform` copies `skill-initializer/SKILL.md` to `<skillRoot>/initializer/SKILL.md`, recorded as manifest kind `'core'` so `update` always refreshes it. `package.json` `files[]` includes `skill-initializer/`. Three agents (`initializer-scout.md`, `initializer-ingestor.md`, `initializer-verifier.md`) auto-install via the `agents/` glob, recorded as kind `'agent'`, NOT in `catalog.json`.

## Constraints & Decisions

- **[2026-06-06]** `init.ts` gained a finish-offer flow (v0.6.0): when run interactively without an existing integration, it offers to call `installPlatformIntegration()` or prints a loud warning. Gated on `SETUP_INTERNAL_ENV` absent + TTY + `.every()` over selected platforms. Full architecture in `manifest-based-install-update.md`.
- **[2026-05-22]** `dreamcontext setup` is the recommended first-run command. It orchestrates init + install-skill internally via the `SETUP_INTERNAL_ENV` flag to suppress deprecation hints from child commands.
- **[2026-05-22]** `install-skill` and `install-claude-md` are deprecated but not removed until v0.5. They still work; print a hint directing to `setup` unless invoked internally by `setup`.
- **[2026-02-25]** `init` and `install-skill` are separate commands by design. `init` sets up `_dream_context/` (data/context); `install-skill` sets up `.claude/` (Claude Code integration). A project might use `init` without Claude Code, or update the skill without reinitializing.
- **[2026-02-25]** Templates live in `src/templates/init/` in source and are bundled via tsup into `dist/templates/init/`. The command resolves template paths relative to the compiled file location using multiple candidate paths.
- **[2026-06-21]** The standalone `dreamcontext-initializer.md` agent was REMOVED (PR #39, session 8ffe039b). The `initializer` skill (`skill-initializer/SKILL.md`) is now the single bootstrap surface. It handles codebase-only repos via a light scout+ingest pass. All load-bearing references (SKILL.md, AGENTS/CLAUDE templates, README, system_flow, init.ts) were updated.
- **[2026-06-21]** Auto-detection expanded (PR #39): hooks and skill now detect four trigger conditions (no-brain, sparse-brain, migrate-from-folder, mass-new-source) and proactively offer the initializer workflow. Detection never breaks the hook (own try/catch, exits 0).
- **[2026-02-25]** `init` and `install-skill` are separate commands by design. `init` sets up `_dream_context/` (data/context); `install-skill` sets up `.claude/` (Claude Code integration). A project might use `init` without Claude Code, or update the skill without reinitializing.
- **[2026-02-25]** Templates live in `src/templates/init/` in source and are bundled via tsup into `dist/templates/init/`. The command resolves template paths relative to the compiled file location using multiple candidate paths.
- **[2026-02-25]** `install-skill` installs hooks into the project-level `.claude/settings.json`, not user-level. This keeps the skill scoped to the project.

## Technical Details

**`dreamcontext init`** (`src/cli/commands/init.ts`):

Tech stack detection (`detectTechStack()`):
- Reads `package.json` dependencies + devDependencies
- Checks for: React, Next.js, Vue, Nuxt, Svelte, Express, Fastify, TypeScript, Tailwind CSS, Prisma
- Falls back to: Flutter/Dart (pubspec.yaml), Rust (Cargo.toml), Go (go.mod), Python (requirements.txt or pyproject.toml)
- Returns null if no recognizable stack found

Token substitution (`replaceTokens(content, tokens)`):
- Replaces `{{TOKEN_NAME}}` across all template file contents
- Tokens: `PROJECT_NAME`, `PROJECT_DESCRIPTION`, `TARGET_USER`, `TECH_STACK`, `PRIORITY`, `DATE`

Template directory resolution: checks 3 candidate paths relative to `__dirname` to handle both development and dist builds.

**`dreamcontext install-skill`** (`src/cli/commands/install-skill.ts`):

Hook constants:
- `SESSION_START_HOOK = 'npx dreamcontext hook session-start'`
- `STOP_HOOK = 'npx dreamcontext hook stop'`
- `OLD_HOOK = 'npx dreamcontext snapshot'` (migration target)

`ensureHooks(projectRoot)`: reads `.claude/settings.json`, checks for existing hooks, migrates old hook if found, adds missing hooks, writes updated settings. Returns `{ added: string[], migrated: boolean }`.

File resolution uses `findPackageFile()` and `findPackageDir()` with 3 candidate paths to locate `skill/SKILL.md` and `agents/*.md` relative to the compiled file.

**`initializer` core skill** (`skill-initializer/SKILL.md`): The single bootstrap surface (replaces the removed `dreamcontext-initializer.md` agent). Orchestrates brain bootstrap/ingestion in goal-skill style: Phase 0 RECOGNIZE & OFFER → Scaffold → Scout (manifest) → Confirm-hierarchy → Progressive ingest (fan-out, coverage-tracked) → Core files → Verify (PASS/FAIL) → Report. Iteration caps mirror goal-skill; TodoWrite ritual enforced.

**Three core sub-agents** (`agents/`): `initializer-scout.md` (read-only intake, produces ingestion manifest), `initializer-ingestor.md` (fan-out worker per batch, parallel/pipeline, distils source material into knowledge/feature/task hierarchy + bookmarks), `initializer-verifier.md` (PASS/FAIL gate: no template placeholders, `dreamcontext doctor` clean, recall sanity, no feature/knowledge dup).

**Auto-detection** (hook + skill): `src/hooks/session-start.ts` and `src/hooks/user-prompt-submit.ts` detect four conditions: no `_dream_context/` (no-brain), sparse/stub brain (empty `knowledge/`, zero features, untouched templates), migration-from-folder, mass-new-source. Each condition has a deterministic heuristic and an integration test. False-positive guard: healthy brain with no new source → silence.

## Notes

- The `initializer` skill is automatically offered by the main agent (per SKILL.md and the SessionStart/UserPromptSubmit hooks) when a no/sparse/migrating brain is detected. Developers don't need to know the skill exists.
- Template files in `src/templates/init/` are what new projects receive as their starting point. These should be kept generic enough to be useful across different project types.
- The `--yes` flag with `--name`, `--description`, `--stack` flags supports scripted initialization (e.g., in CI or project generators).
- After `init`, the recommended next step is `dreamcontext install-skill` to wire up Claude Code hooks.
- The `initializer-improvements` task tracks future richness enhancements (feature detection from codebase, git-author people seeding, real data-structure detection) — those are complementary to the skill, not part of this shipped capability.
- PR #39 shipped the skill. PR #39 also shipped the hook auto-detection extensions (no-brain / sparse / migrate-from-folder / mass-new-source trigger conditions).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-21 - Shipped interactive initializer skill + hook auto-detection (PR #39)
- Replaced standalone `dreamcontext-initializer` agent with the `initializer` core skill (goal-skill-style orchestrator with 3 sub-agents: scout/ingestor/verifier).
- Added hook auto-detection for 4 trigger conditions: no-brain, sparse-brain, migrate-from-folder, mass-new-source.
- Updated status to `in_review`; related_tasks += initializer-skill.

### 2026-02-25 - Removed code_registry from init template set
- Removed `6.code_registry.json` from the init template files. Static code registries go stale immediately; removed before v0.1.0.
- Slot 6 left intentionally empty for user customization.

### 2026-02-25 - Created
- Feature PRD created.
