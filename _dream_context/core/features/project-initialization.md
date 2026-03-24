---
id: feat_cSWvTF1K
status: active
created: '2026-02-25'
updated: '2026-02-26'
released_version: 0.1.0
tags:
  - devops
  - onboarding
  - architecture
related_tasks: []
---

## Why

Setting up the _dream_context/ directory structure correctly is tedious and error-prone when done manually. The init command bootstraps the entire scaffold in one command, detects the tech stack automatically, runs token substitution on templates, and sets up the Claude Code hooks — turning a blank project into a fully agent-aware workspace in under a minute.

## User Stories

- [x] As a developer, I want `dreamcontext init` to scaffold the full `_dream_context/` directory structure so I don't have to create files and folders manually.
- [x] As a developer, I want tech stack detection from `package.json` so the tech stack field is pre-populated without me having to type it.
- [x] As a developer, I want template files populated with real project values (name, description, stack, priority) via token substitution so the initial files are immediately useful.
- [x] As a developer, I want `dreamcontext install-skill` to install SKILL.md and hooks into `.claude/` so Claude Code picks them up automatically.
- [x] As a developer, I want the Initializer sub-agent to do the full setup interactively — scanning the codebase, asking targeted questions, and writing rich content — so I get a meaningful context, not just scaffolding.
- [x] As a developer, I want the `--yes` flag to skip all prompts and use sensible defaults so the init can be scripted non-interactively.
- [x] As a developer, I want `install-skill` to migrate the old `npx dreamcontext snapshot` hook to the new `hook session-start` format so upgrading from older versions is automatic.

## Acceptance Criteria

- `dreamcontext init` creates `_dream_context/core/`, `_dream_context/core/features/`, `_dream_context/knowledge/`, `_dream_context/state/`.
- Template files written: `0.soul.md`, `1.user.md`, `2.memory.md`, `3.style_guide_and_branding.md`, `4.tech_stack.md`, `5.data_structures.sql`. Slot 6+ left intentionally empty for user customization.
- JSON files written as empty arrays: `CHANGELOG.json`, `RELEASES.json`.
- Initial CHANGELOG.json entry added: `{ date, type: "chore", scope: "project", description: "Agent context initialized" }`.
- Template tokens replaced: `{{PROJECT_NAME}}`, `{{PROJECT_DESCRIPTION}}`, `{{TARGET_USER}}`, `{{TECH_STACK}}`, `{{PRIORITY}}`, `{{DATE}}`.
- Tech stack auto-detected from `package.json` (React, Next.js, Vue, Express, TypeScript, Tailwind, Prisma, etc.), `pubspec.yaml`, `Cargo.toml`, `go.mod`, `requirements.txt`/`pyproject.toml`.
- Running init on a directory that already has `_dream_context/` returns an error and does not overwrite.
- `install-skill` copies `SKILL.md` to `.claude/skills/dreamcontext/SKILL.md`.
- `install-skill` copies all `agents/*.md` files to `.claude/agents/`.
- `install-skill` writes `SessionStart` and `Stop` hooks to `.claude/settings.json`, creating or merging with existing settings.
- `install-skill` migrates old `npx dreamcontext snapshot` SessionStart hook to `npx dreamcontext hook session-start` if found.
- SessionStart hook uses `matcher: "startup|resume|compact|clear"` and timeout 10s; Stop hook has no matcher and timeout 5s.

## Constraints & Decisions

- **[2026-02-25]** `init` and `install-skill` are separate commands by design. `init` sets up `_dream_context/` (data/context); `install-skill` sets up `.claude/` (Claude Code integration). A project might use `init` without Claude Code, or update the skill without reinitializing.
- **[2026-02-25]** Templates live in `src/templates/init/` in source and are bundled via tsup into `dist/templates/init/`. The command resolves template paths relative to the compiled file location using multiple candidate paths.
- **[2026-02-25]** The Initializer sub-agent (`agents/dreamcontext-initializer.md`) is the preferred setup path for new projects. `dreamcontext init` provides the scaffold; the agent provides the rich content. The SKILL.md directs main agents to dispatch the Initializer when no `_dream_context/` is detected.
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

**`dreamcontext-initializer` sub-agent** (`agents/dreamcontext-initializer.md`): Scans codebase, calls `dreamcontext init --yes`, asks 3-6 targeted questions, then writes rich content to the three core files. Protocol documented in the agent file.

## Notes

- The Initializer agent is automatically dispatched by the main agent (per SKILL.md) when no `_dream_context/` is found. Developers don't need to run `init` manually if they use Claude Code.
- Template files in `src/templates/init/` are what new projects receive as their starting point. These should be kept generic enough to be useful across different project types.
- The `--yes` flag with `--name`, `--description`, `--stack` flags supports scripted initialization (e.g., in CI or project generators).
- After `init`, the recommended next step is `dreamcontext install-skill` to wire up Claude Code hooks.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-02-25 - Removed code_registry from init template set
- Removed `6.code_registry.json` from the init template files. Static code registries go stale immediately; removed before v0.1.0.
- Slot 6 left intentionally empty for user customization.

### 2026-02-25 - Created
- Feature PRD created.
