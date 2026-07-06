---
id: feat_IV4p9Yjx
status: active
created: '2026-06-20'
updated: '2026-07-06'
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

- [x] As an agent, I can open a references/ file for the specific capability I need, so I don't have to re-read the entire SKILL.md every session.
- [x] As an agent, I see a "Capabilities at a Glance" table in SKILL.md that maps every major feature (ClickUp, dashboard, desktop app, federation, council, marketing) to its reference file, so I never wrongly say a feature doesn't exist.
- [x] As a project maintainer, `dreamcontext update` / `upgrade` / drift-check automatically picks up the references/ folder alongside SKILL.md, so installed skills stay in sync.
- [x] As a developer, I want running `dreamcontext install-skill` to install the full skill folder (SKILL.md + references/) so that agents at my project immediately get the complete reference set.

## Acceptance Criteria

*(All shipped v0.8.8; task `dreamcontext-skill-folder-overhaul` completed.)*

- [x] `skill/references/` exists with 6 files: `cli-reference.md`, `integrations.md`, `tasks-and-features.md`, `knowledge-and-recall.md`, `sleep.md`, `improving-dreamcontext.md`
- [x] `SKILL.md` has a "Capabilities at a Glance" table mapping every major capability (ClickUp, dashboard, desktop, federation, council, marketing, recall, tasks, knowledge, sleep, taxonomy, versions, multi-product, people, feedback loop, full CLI) to its reference file
- [x] `installCoreForPlatform` in `install-skill.ts` copies `references/` alongside `SKILL.md` for claude + codex platforms
- [x] `dreamcontext update` and `upgrade` pick up `references/` (asset-drift detection covers the new files; `pruneStaleFiles` removes dropped references on next update)
- [x] Skill rules updated: rule 2 references only shipped packs (no phantom skills); rule 4 = single-source-of-truth + feature-vs-knowledge boundary; rule 5 = 5-min task threshold + extend-don't-fork; rule 13 = read connected peer projects
- [x] Marker tests (`taxonomy-markers`, `excalidraw-knowledge`) remain green after SKILL.md restructure
- [x] Validation probes (isolated agents loaded via the installed skill) correctly report ClickUp as supported and context-grouped knowledge layout as the convention

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-06]** **Skill docs are edited ONLY in `skill/` (repo source), NEVER in installed copies — pinned by marker tests.** Incident: v0.11.0 shipped the entire Lab subsystem with ZERO Lab skill docs in `skill/`. The doc edits had been made to the *installed* copies (`.claude/skills/dreamcontext/`), which `install-skill`/`update` clobber from `skill/` — so they silently vanished, while the task changelog claimed the docs were done. Consequence: agents misrouted "create insight" to `knowledge create`. Fix (this session): Lab capabilities row + a new "Entity Router" section in `SKILL.md` (an 8-entity routing table — insight / objective / knowledge / feature-PRD / task / bookmark / trigger / release — each mapped to its ONE creation path, plus litmus tests and an ask-don't-guess rule), Lab sections in `cli-reference.md` / `tasks-and-features.md` / `knowledge-and-recall.md`, and marker tests in `tests/unit/taxonomy-markers.test.ts` asserting the Entity Router section, the Lab capabilities row, `dreamcontext lab create`, the lab CLI verbs, and the insight-capture protocol exist in `skill/` — so a missing doc fails CI loudly instead of shipping silently. Rule for every future capability: the doc lands in `skill/` in the same change as the code, and a marker test pins it.
- **[2026-06-20]** `knowledge move` is not yet a shipped command (PR #37 `feat/knowledge-move-command` is open). The skill references this fact accurately and will be updated to reflect the command when it merges. *(Since shipped — `dreamcontext knowledge move` is live and documented.)*
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

### 2026-07-06 - Lab skill-docs incident fixed + Entity Router added (working tree)
- Root-caused why v0.11.0 shipped Lab with no skill docs: edits landed in installed copies instead of `skill/` and were clobbered on update (see the 2026-07-06 constraint). Landed in `skill/`: Lab / Insights capabilities row, "Insights are NOT knowledge" rule, new Entity Router section (8-entity routing table), Lab sections in `cli-reference.md` / `tasks-and-features.md` / `knowledge-and-recall.md`, and marker tests in `taxonomy-markers.test.ts` pinning all of it.
- PRD reconciled: overhaul shipped v0.8.8 and task `dreamcontext-skill-folder-overhaul` completed — status `in_progress` → `active`, stories/ACs ticked; `knowledge move` note marked shipped.

### 2026-06-20 - Initial implementation (working tree, uncommitted)
- `skill/SKILL.md` rewritten: lean core, capabilities map, 13 behavioral rules (incl. new SSOT, 5-min task, peer-read rules).
- `skill/references/` created with 6 reference files built from authoritative source (not guessed).
- `src/cli/commands/install-skill.ts` updated: `installCoreForPlatform` copies `references/` alongside `SKILL.md`.
- Skill propagated locally to `.claude/skills/dreamcontext/` and `.agents/skills/dreamcontext/`.
- Tests updated; full suite green (1986 passed, 0 failures).
- 4 validation probes passed (ClickUp, sleep flow, knowledge layout, bookmarks+recall+hallucination guard).
- PRD created.
