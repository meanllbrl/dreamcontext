---
id: task_cV_3_gr5
name: optional-skill-packs
description: >-
  Optional installable skill packs for dreamcontext users. Curated skills
  organized into packs (engineering, design, growth) + standalone skills. Users
  install via CLI.
priority: critical
urgency: medium
status: in_progress
created_at: '2026-03-24'
updated_at: '2026-04-19'
tags:
  - skills
  - cli
  - distribution
parent_task: null
related_feature: null
version: v0.2.0
---

## Why

Users of dreamcontext need curated, high-quality skills beyond the core context management skill. 15 draft skills covering engineering, design, growth/marketing, and AI agents existed in `_dream_context/inbox/draft-skills/` but were unorganized and not installable. This task organizes them into a structured, installable skill pack system.

## User Stories

- [x] As a developer, I want curated skill packs organized by domain so I can install relevant skills without sifting through individual files
- [x] As a developer, I want to run `dreamcontext install-skill --packs` to interactively select and install optional skill packs
- [x] As a developer, I want to run `dreamcontext install-skill --packs engineering` to install a specific pack directly
- [ ] As a developer, I want to discover more skills from official Claude Code sources and community

## Acceptance Criteria

- [x] Skills organized into packs with base skill + on-demand sub-skills
- [x] Each pack SKILL.md = base skill content (always-active) + sub-skill reference table
- [x] Sub-skills are flat .md files (no unnecessary subdirs), content preserved from drafts
- [x] catalog.json manifest for CLI discovery
- [x] Build pipeline ships skill-packs to dist/
- [x] 473 tests still passing
- [x] `install-skill` CLI command extended with `--packs` and `--skill` options
- [x] Interactive pack selection via @inquirer/prompts
- [x] Prerequisite resolution (warn if installing a pack without its dependencies)
- [x] `alwaysApply` handling during install (shown as badge in UI)
- [ ] Skills from official sources (Anthropic, community) evaluated and added

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-03-24 - Agents separated from skills, flat structure
Agents are fundamentally different from skills (executable vs context). Moved all agents out of pack directories into `skill-packs/agents/` (flat, no subdirs, matching `.claude/agents/` layout). catalog.json has top-level `agents` array with `pack` field linking each agent to its related pack. Packs reference agents via `relatedAgents` (name list). Install CLI will copy agents to `.claude/agents/` separately from skills.

### 2026-03-24 - Brand-voice adapted for dreamcontext system
Removed commands directory (not part of our system). Guidelines storage changed from `.claude/brand-voice-guidelines.md` to `_dream_context/core/` as a core file (e.g., `7.brand_voice.md`). Settings moved from `.claude/brand-voice.local.md` to core file frontmatter (`strictness`, `always_explain`). All "Brand Voice Plugin" and "Cowork" references removed from agents. Discovery reports can be saved as knowledge files. Cross-references use sub-skill/agent names instead of slash commands.

### 2026-03-24 - Reviewer agent belongs in engineering pack
reviewer.md is a code review agent that references coding-principles, backend-principles, frontend-principles. Natural fit as an engineering agent. Stored at `engineering/agents/reviewer.md`.

### 2026-03-24 - Brand-voice is a single pack with 3 interconnected skills
discover-brand, guideline-generation, and brand-voice-enforcement form a workflow: discover -> generate -> enforce. They share references and agents. Organized as one pack rather than 3 standalone skills. Base SKILL.md = enforcement (most commonly triggered), sub-skills = discovery + generation.

### 2026-03-24 - Descriptions must be trigger-specific
Non-alwaysApply skills (growth, system-prompts) need explicit trigger conditions in their `description` field. Claude Code uses this to decide when to load. Generic descriptions like "growth strategy" don't trigger; specific ones like "D30 retention benchmarks, TikTok distribution, paywall optimization" do.

### 2026-03-24 - Frontend pack dissolved into design + engineering
`general-frontend-principles` (token architecture, i18n, a11y) moved to `design/frontend-principles.md`. `web-app-frontend` (React, TypeScript implementation) moved to `engineering/web-app-frontend.md`. Frontend as a separate 2-file pack was unnecessary overhead.

### 2026-03-24 - Base skill IS the pack SKILL.md
No separate base file. `design/SKILL.md` IS design-principles content + sub-skill reference table. Eliminates redundancy. Agent always has the base loaded when the pack is installed.

### 2026-03-24 - Sub-skills are flat files, not subdirs
Single-file skills don't need their own directory. `design-web.md` not `design-web/SKILL.md`. Exception: firebase skills keep subdirs because they have `references/` with 5-6 files each.

### 2026-03-24 - system-prompts is standalone (not wrapped in ai-agents/)
Single-skill categories don't need a wrapper pack. But it still needs `system-prompts/SKILL.md` format (not bare .md) because Claude Code expects `{name}/SKILL.md`.

### 2026-03-24 - Install FLAT into .claude/skills/
When installed, each skill goes to `.claude/skills/{skill-name}/SKILL.md` (flat), not nested by pack. This preserves all existing cross-references in skill content.

### 2026-03-24 - Content preserved verbatim from drafts
Only additions: sub-skill reference tables prepended to pack SKILL.md files, and system-prompts reformatted to standard `<system_instructions><role>` format. All other content copied as-is.

## Technical Details

### Current Structure (Phase 1 + Level 2 COMPLETE)

```
skill-packs/                              # 42 files total
  catalog.json                            # Master manifest (packs + standalone + agents)
  engineering/                            # Pack: coding-principles base (alwaysApply: true)
    SKILL.md                              # IS coding-principles + sub-skill refs
    backend-principles.md                 # Sub-skill: APIs, serverless, rate limiting
    web-app-frontend.md                   # Sub-skill: React, Vue, GSAP, ShadCN, Tailwind
    firebase-cloud-functions/SKILL.md     # Sub-skill + 6 reference files
    firebase-firestore/SKILL.md           # Sub-skill + 5 reference files
  design/                                 # Pack: design-principles base (alwaysApply: true)
    SKILL.md                              # IS design-principles + sub-skill refs
    frontend-principles.md                # Sub-skill: tokens, i18n, a11y, components
    design-web.md                         # Sub-skill: responsive, landing pages, conversion
    design-mobile.md                      # Sub-skill: haptics, widgets, App Store
    onboarding-design.md                  # Sub-skill: paywalls, signup funnels
  growth/                                 # Pack: app-growth base (alwaysApply: false)
    SKILL.md                              # IS app-growth + sub-skill refs
    performance-marketing.md              # Sub-skill: Meta Ads, ROAS, budget
    lean-analytics-experiments.md         # Sub-skill: MVPs, A/B tests, hypothesis
    lean-analytics-metrics.md             # Sub-skill: KPIs, Mixpanel, cohorts
  brand-voice/                            # Pack: brand-voice-enforcement base (alwaysApply: false)
    SKILL.md                              # IS enforcement + sub-skill refs + agent name refs
    discover-brand.md                     # Sub-skill: platform discovery orchestration
    guideline-generation.md               # Sub-skill: guideline synthesis -> core file
    references/                           # 6 shared reference files
      search-strategies.md                # Platform-specific search queries
      source-ranking.md                   # Source triage algorithm + weights
      voice-constant-tone-flexes.md       # Voice/tone mental model
      before-after-examples.md            # Content enforcement examples
      confidence-scoring.md               # Section confidence methodology
      guideline-template.md               # Full output template
  system-prompts/                         # Standalone skill (alwaysApply: false)
    SKILL.md                              # Cognitive architecture, prompt engineering
  agents/                                 # Optional agents (flat, no subdirs)
    reviewer.md                           # Critical code reviewer (PASS/FAIL) [engineering]
    discover-brand.md                     # 4-phase autonomous platform search [brand-voice]
    document-analysis.md                  # Brand document parsing + extraction [brand-voice]
    conversation-analysis.md              # Transcript pattern recognition [brand-voice]
    content-generation.md                 # Long-form brand-aligned content [brand-voice]
    quality-assurance.md                  # Content/guideline validation [brand-voice]
```

### Phase 2: CLI Install Mechanism (COMPLETE)

`install-skill` extended with:
- `--packs [names...]`: interactive checkbox browser or direct pack names
- `--skill <pack> <skill>`: install individual sub-skill
- `--list`: show available packs and sub-skills from catalog

Install flow implemented:
1. `findPackageDir('skill-packs')` locates the catalog
2. `catalog.json` read; packs presented via @inquirer/prompts checkbox
3. Each selected pack: copies SKILL.md to `.claude/skills/{pack-name}/SKILL.md`
4. Sub-skills copied alongside (same dir or subdirs for firebase refs)
5. Cross-pack dependency warnings (e.g., brand-voice requires design)
6. `alwaysApply: true` base skills shown as badge in UI
7. Related agents copied to `.claude/agents/`
8. Base `install-skill` (without --packs) now hints about available packs

17 new integration tests, 490 total passing.

### Source Skills

**Level 1 (15 skills, from `_dream_context/inbox/draft-skills/`):**
coding-principles, backend-principles, firebase-cloud-functions (+ 6 refs), firebase-firestore (+ 5 refs), design-principles, design-web, design-mobile, onboarding-design, general-frontend-principles, web-app-frontend, app-growth, performance-marketing, lean-analytics-experiments, lean-analytics-metrics, system-prompts

**Level 2 (3 skills + 5 agents + 3 commands + 6 refs, from `_dream_context/inbox/draft-skills-level2/` + `draft-agents-level2/` + `draft-agents/` + `inbox/commands/`):**
brand-voice-enforcement, discover-brand, guideline-generation, reviewer agent, discover-brand agent, document-analysis agent, conversation-analysis agent, content-generation agent, quality-assurance agent

## Notes

- Phase 3 (more skills from official sources) depends on user providing those sources.
- New skills should follow the system-prompts skill's formatting standards.
- User preference: "copy, not rewrite" for existing skill content.
- Open question: should the CLI also register skills in Claude Code's settings.json (like hooks are registered by install-skill)?

## Changelog
<!-- LIFO: newest entry at top -->



### 2026-03-24 - Session Update
- Phase 2 CLI complete. install-skill extended with --packs (interactive checkbox browser + direct pack names), --skill (individual sub-skill install), --list (show available packs). Cross-pack dependency warnings, related agent installation, firebase reference directory copying, base-pack-missing warnings. 'Install skill packs' and 'List skill packs' added to interactive mode Setup menu. Core install-skill now hints about available optional packs after base install. 17 new integration tests, 490 total passing. README updated (skill packs section + command reference). DEEP-DIVE updated (architecture section + 2 design tradeoffs). CHANGELOG.md updated. Committed and pushed to GitHub (111 files, rebrand + skill-packs CLI).
### 2026-03-24 - Session Update
- 2026-03-24: Level 2 complete. Added brand-voice pack (3 skills + 6 references) and 6 optional agents (reviewer + 5 brand-voice). Agents separated into skill-packs/agents/ (flat). catalog.json updated with top-level agents array. 42 files total in skill-packs/. Project also renamed from agentcontext to dreamcontext in same sessions. Phase 1 + Level 2 done; Phase 2 (CLI install mechanism) is next.
### 2026-03-24 - Level 2 skills added: brand-voice pack + reviewer agent
- Added `brand-voice/` pack: 3 skills + 6 references (9 skill files)
- Added 6 optional agents in `skill-packs/agents/`: 5 brand-voice + 1 engineering (reviewer)
- Adapted for dreamcontext: guidelines save to `_dream_context/core/` as core file, settings in frontmatter, no commands, no Cowork/plugin references
- Agents separated from skills: `skill-packs/agents/{pack-name}/` with top-level `agents` array in catalog.json, packs link via `relatedAgents`
- 42 files total in skill-packs/ (was 27)
- Build passes, 473 tests passing, dist/skill-packs/ populated

### 2026-03-24 - Phase 1 complete: skill-packs organized
- Created `skill-packs/` directory with 3 packs (engineering, design, growth) + 1 standalone (system-prompts)
- 27 files total: 4 pack SKILL.md + 8 sub-skill .md + 2 firebase SKILL.md + 11 reference files + 1 catalog.json
- Updated `package.json` (files array) and `tsup.config.ts` (cpSync) for build pipeline
- Dissolved frontend pack: frontend-principles → design, web-app-frontend → engineering
- Fixed system-prompts to standard `<system_instructions><role>` format
- Improved all skill descriptions with specific trigger conditions
- Build passes, 473 tests passing, dist/skill-packs/ populated
