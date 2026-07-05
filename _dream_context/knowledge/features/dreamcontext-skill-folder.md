---
id: feat_IV4p9Yjx
status: in_progress
created: '2026-06-20'
updated: '2026-06-21'
released_version: v0.8.8
tags:
  - 'topic:skills'
  - 'topic:cli'
  - 'topic:agents'
  - devops
related_tasks:
  - dreamcontext-skill-folder-overhaul
type: feature
name: dreamcontext-skill-folder
description: ''
pinned: false
date: '2026-06-20'
---

## Why

The core `dreamcontext` skill was a single 53KB `SKILL.md` with `alwaysApply: true`. It loaded in full every session yet still missed major shipping capabilities — agents said "we don't have ClickUp" despite a full bidirectional ClickUp task-backend existing, and made the same mistakes on sleep, bookmarks, and knowledge layout. The root cause was structural: a monolithic file cannot be both always-loaded and comprehensive. The fix is progressive disclosure: a lean always-loaded core that names every capability and delegates depth to on-demand reference files.

## User Stories

- [ ] As an agent, I can open a references/ file for the specific capability I need, so I don't have to re-read the entire SKILL.md every session.
- [ ] As an agent, I see a "Capabilities at a Glance" table in SKILL.md that maps every major feature (ClickUp, dashboard, desktop app, federation, council, marketing) to its reference file, so I never wrongly say a feature doesn't exist.
- [ ] As a project maintainer, `dreamcontext update` / `upgrade` / drift-check automatically picks up the references/ folder alongside SKILL.md, so installed skills stay in sync.
- [ ] As a developer, I want running `dreamcontext install-skill` to install the full skill folder (SKILL.md + references/) so that agents at my project immediately get the complete reference set.

## Acceptance Criteria

- [ ] `skill/references/` exists with 6 files: `cli-reference.md`, `integrations.md`, `tasks-and-features.md`, `knowledge-and-recall.md`, `sleep.md`, `improving-dreamcontext.md`
- [ ] `SKILL.md` has a "Capabilities at a Glance" table mapping every major capability (ClickUp, dashboard, desktop, federation, council, marketing, recall, tasks, knowledge, sleep, taxonomy, versions, multi-product, people, feedback loop, full CLI) to its reference file
- [ ] `installCoreForPlatform` in `install-skill.ts` copies `references/` alongside `SKILL.md` for claude + codex platforms
- [ ] `dreamcontext update` and `upgrade` pick up `references/` (asset-drift detection covers the new files; `pruneStaleFiles` removes dropped references on next update)
- [ ] Skill rules updated: rule 2 references only shipped packs (no phantom skills); rule 4 = single-source-of-truth + feature-vs-knowledge boundary; rule 5 = 5-min task threshold + extend-don't-fork; rule 13 = read connected peer projects
- [ ] Marker tests (`taxonomy-markers`, `excalidraw-knowledge`) remain green after SKILL.md restructure
- [ ] Validation probes (isolated agents loaded via the installed skill) correctly report ClickUp as supported and context-grouped knowledge layout as the convention

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-06-20]** `knowledge move` is not yet a shipped command (PR #37 `feat/knowledge-move-command` is open). The skill references this fact accurately and will be updated to reflect the command when it merges.
- **[2026-06-20]** Progressive-disclosure design: SKILL.md always loads but only names capabilities; reference files are NOT auto-loaded — agents open them with `Read` when the task calls for it. This avoids the prior monolithic context bloat while guaranteeing no capability is invisible. The tradeoff: agents must recognize the need to open a reference; the capability map is the forcing function.
- **[2026-06-20]** `installCoreForPlatform` uses `cpSync({recursive: true})` for the references dir. The `walk()` bootstrap scan in `asset-drift.ts` recurses, so reference files are automatically tracked in drift detection — no separate registration needed.
- **[2026-06-20]** The `package.json` `files` array already ships the whole `skill/` dir; no change needed there. Both `install-skill` and `update` call `installCoreForPlatform` — fixing that one function propagates to both flows.

## Technical Details

**Source files:**
- `skill/SKILL.md` — lean always-loaded core with capability map + behavioral rules
- `skill/references/cli-reference.md` — every command + flag, built from source
- `skill/references/integrations.md` — ClickUp setup/sync, dashboard, desktop app, federation/vaults, council, marketing
- `skill/references/tasks-and-features.md` — task protocol, RICE, due dates, people/assignees, Workflow flowchart, versioning, multi-product
- `skill/references/knowledge-and-recall.md` — knowledge files, recall modes + functions, taxonomy, Excalidraw/diagrams
- `skill/references/sleep.md` — full consolidation flow + specialist contracts
- `skill/references/improving-dreamcontext.md` — the feedback loop

**Installer change (`src/cli/commands/install-skill.ts`):**
- `installCoreForPlatform()` — after copying `SKILL.md`, copies `references/` dir via `cpSync({recursive: true})` to the skill's install dir; records each reference file in the manifest via `recordFile`.
- Applies to both claude (`.claude/skills/dreamcontext/`) and codex (`.agents/skills/dreamcontext/`) platforms.
- Asset-drift detection (`asset-drift.ts`) uses `walk()` which recurses — references are auto-included.

**Tests affected:**
- `tests/unit/taxonomy-markers.test.ts` — taxonomy marker moved from `skill/SKILL.md` to `skill/references/knowledge-and-recall.md`; test updated to assert correct location.
- `tests/unit/excalidraw-knowledge.test.ts` — diagrams convention changed from `knowledge/diagrams/<title>/` to context-grouped folders with diagrams co-located; test updated to reflect new convention.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-20 - Initial implementation (working tree, uncommitted)
- `skill/SKILL.md` rewritten: lean core, capabilities map, 13 behavioral rules (incl. new SSOT, 5-min task, peer-read rules).
- `skill/references/` created with 6 reference files built from authoritative source (not guessed).
- `src/cli/commands/install-skill.ts` updated: `installCoreForPlatform` copies `references/` alongside `SKILL.md`.
- Skill propagated locally to `.claude/skills/dreamcontext/` and `.agents/skills/dreamcontext/`.
- Tests updated; full suite green (1986 passed, 0 failures).
- 4 validation probes passed (ClickUp, sleep flow, knowledge layout, bookmarks+recall+hallucination guard).
- PRD created.
