---
id: "feat_bTBRuxX0"
status: "in_progress"
created: "2026-03-24"
updated: "2026-03-24"
released_version: null
tags: ["skills", "cli", "distribution"]
related_tasks: ["optional-skill-packs"]
---

## Why

Users need curated, installable skills beyond the core context management skill. 15 draft skills existed but were unorganized and not installable. Skill packs let users extend their agent's capabilities with domain-specific skills (engineering, design, growth, brand-voice) without manually placing files.

## User Stories

- [x] As a developer, I want curated skill packs organized by domain so I can install relevant skills without sifting through individual files
- [ ] As a developer, I want to run `dreamcontext install-skill --packs` to interactively select and install skill packs
- [ ] As a developer, I want to run `dreamcontext install-skill --packs engineering` to install a specific pack directly
- [ ] As a developer, I want to discover more skills from official Claude Code sources and community

## Acceptance Criteria

- [x] Skills organized into packs with base skill + on-demand sub-skills
- [x] Each pack SKILL.md is the base skill content plus sub-skill reference table
- [x] Sub-skills are flat .md files (no unnecessary subdirs), content preserved from drafts
- [x] catalog.json manifest for CLI discovery
- [x] Build pipeline ships skill-packs to dist/
- [x] 473 tests still passing
- [ ] `install-skill` CLI extended with `--packs` and `--skill` options
- [ ] Interactive pack selection via @inquirer/prompts
- [ ] Prerequisite resolution (warn if installing a pack without its dependencies)
- [ ] `alwaysApply` handling during install (prompt user for base skills)
- [ ] Skills from official sources evaluated and added (Phase 3, user-supplied sources)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-03-24 - Agents separated from skills, flat structure
Agents go to `skill-packs/agents/` (flat, no subdirs, matching `.claude/agents/` layout). catalog.json has top-level `agents` array with `pack` field linking each agent to its pack. Packs reference agents via `relatedAgents`.

### 2026-03-24 - Base skill IS the pack SKILL.md
No separate base file. `design/SKILL.md` is design-principles content plus sub-skill reference table. Sub-skills are flat .md files. Exception: firebase packs with `references/` subdirs.

### 2026-03-24 - Install flat into .claude/skills/
Skills install to `.claude/skills/{pack-name}/SKILL.md` (flat, not nested by pack). Preserves all cross-references in skill content.

### 2026-03-24 - Brand-voice guidelines go to _dream_context/core/
Guidelines save as a numbered core file (e.g., `7.brand_voice.md`). Settings (`strictness`, `always_explain`) in frontmatter. Consistent with dreamcontext core-file pattern.

### 2026-03-24 - Non-alwaysApply descriptions must be trigger-specific
Claude Code uses `description` to decide when to load the skill. Generic descriptions don't reliably trigger. Descriptions must list specific keywords (e.g., "D30 retention benchmarks, TikTok distribution, paywall optimization").

### 2026-03-24 - Frontend pack dissolved
`general-frontend-principles` moved to `design/frontend-principles.md`. `web-app-frontend` moved to `engineering/web-app-frontend.md`. Frontend as a 2-file standalone pack was unnecessary overhead.

## Technical Details

### Structure (Phase 1 + Level 2 complete, 42 files)

```
skill-packs/
  catalog.json                        # Master manifest (packs + agents)
  agents/                             # Optional agents (flat)
    reviewer.md                       # Code reviewer (engineering)
    discover-brand.md / document-analysis.md / conversation-analysis.md
    content-generation.md / quality-assurance.md  # Brand-voice agents
  engineering/                        # alwaysApply: true base
    SKILL.md                          # coding-principles + sub-skill refs
    backend-principles.md / web-app-frontend.md
    firebase-cloud-functions/SKILL.md / firebase-firestore/SKILL.md
  design/                             # alwaysApply: true base
    SKILL.md                          # design-principles + sub-skill refs
    frontend-principles.md / design-web.md / design-mobile.md / onboarding-design.md
  growth/                             # alwaysApply: false
    SKILL.md                          # app-growth + sub-skill refs
    performance-marketing.md / lean-analytics-experiments.md / lean-analytics-metrics.md
  brand-voice/                        # alwaysApply: false
    SKILL.md                          # enforcement base + sub-skill refs + agent refs
    discover-brand.md / guideline-generation.md
    references/                       # 6 shared reference files
  system-prompts/                     # Standalone, alwaysApply: false
    SKILL.md
```

### Phase 2: CLI Install Mechanism

Key files to extend:
- `src/cli/commands/install-skill.ts` -- add `--packs` / `--skill` options
- `skill-packs/catalog.json` -- CLI reads this to discover available packs
- `package.json` -- `"skill-packs"` already in `files` array
- `tsup.config.ts` -- `cpSync('skill-packs', 'dist/skill-packs')` already added

Install flow:
1. `findPackageDir('skill-packs')` to locate the catalog
2. Read `catalog.json`, present packs via @inquirer/prompts multi-select
3. For each selected pack: copy SKILL.md to `.claude/skills/{pack-name}/SKILL.md`
4. Copy sub-skill files alongside (same dir or subdirs for firebase)
5. Check prerequisites in catalog; warn if missing cross-pack deps
6. For `alwaysApply: true` base skills, prompt user to confirm
7. Agents: copy selected agents to `.claude/agents/`

## Notes

- Phase 3 (official/community skills) depends on user providing sources. User preference: "copy, not rewrite" for existing skill content.
- Consider: should CLI also register skills in Claude Code's settings.json (like hooks are)?

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-03-24 - Level 2 complete: brand-voice pack + reviewer agent
- Added brand-voice pack: 3 skills + 6 references
- Added 6 optional agents in skill-packs/agents/
- Adapted brand-voice for dreamcontext system (guidelines -> core file, no commands)
- 42 files total in skill-packs/

### 2026-03-24 - Phase 1 complete: skill-packs organized
- Created skill-packs/ with 3 packs + 1 standalone
- 27 files: 4 pack SKILL.md + 8 sub-skills + 2 firebase + 11 references + 1 catalog.json
- Build pipeline: package.json files array + tsup cpSync
- 473 tests passing
