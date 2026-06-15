---
id: "feat_bTBRuxX0"
status: "in_review"
created: "2026-03-24"
updated: "2026-06-05"
released_version: null
tags: ["skills", "cli", "distribution"]
related_tasks: ["optional-skill-packs"]
---

## Why

Users need curated, installable skills beyond the core context management skill. 15 draft skills existed but were unorganized and not installable. Skill packs let users extend their agent's capabilities with domain-specific skills (engineering, design, growth, brand-voice) without manually placing files.

## User Stories

- [x] As a developer, I want curated skill packs organized by domain so I can install relevant skills without sifting through individual files
- [x] As a developer, I want to run `dreamcontext install-skill --packs` to interactively select and install skill packs
- [x] As a developer, I want to run `dreamcontext install-skill --packs engineering` to install a specific pack directly
- [x] As a developer, I want to add code-bearing skills (with scripts/binaries) to the catalog and have the entire directory installed correctly, not just the SKILL.md
- [ ] As a developer, I want to discover more skills from official Claude Code sources and community

## Acceptance Criteria

- [x] Skills organized into packs with base skill + on-demand sub-skills
- [x] Each pack SKILL.md is the base skill content plus sub-skill reference table
- [x] Sub-skills are flat .md files (no unnecessary subdirs), content preserved from drafts
- [x] catalog.json manifest for CLI discovery
- [x] Build pipeline ships skill-packs to dist/
- [x] 473 tests still passing
- [x] `install-skill` CLI extended with `--packs` and `--skill` options
- [x] Interactive pack selection via @inquirer/prompts
- [x] Prerequisite resolution (warn if installing a pack without its dependencies)
- [x] `alwaysApply` handling during install (shown as badge in UI)
- [x] `bundleDir: true` in catalog entry causes the entire skill directory to be installed (not just SKILL.md), preserving executable bits — required for code-bearing skills with scripts
- [x] excalidraw skill added: full directory vendored (SKILL.md + build_excalidraw.js + scripts/lib/* + examples/ + reference/), CommonJS compatibility via `package.json {"type":"commonjs"}` in skill root
- [x] video-watching skill added: SKILL.md + transcribe.sh (executable) + gap_fill.py + build_frame_index.py; aligns with bundleDir pattern; executable bit preserved by cpSync
- [ ] Skills from official sources evaluated and added (Phase 3, user-supplied sources)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-06-04 - Code-bearing skills: bundleDir + CommonJS package.json
Standalone skills that ship executable scripts must use `bundleDir: true` in catalog.json — `installStandaloneFiles` then uses `cpSync` to copy the whole directory, preserving executable bits (vs. single-file SKILL.md copy). For skills whose scripts use CommonJS (`require`/`module.exports`), add a `package.json {"type":"commonjs"}` at the skill root to override the dreamcontext package-root `"type":"module"`. Without it, Node treats `.js` files as ESM and `require()` calls throw at runtime. Both excalidraw and video-watching follow this pattern.

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

### Structure (Phase 1 + Level 2 complete + Phase 3 standalone skills, 50+ files)```
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
  excalidraw/                         # Standalone, bundleDir: true, alwaysApply: false
    SKILL.md
    scripts/build_excalidraw.js       # Board generator (CommonJS)
    scripts/lib/                      # fractional-indexing, imagesize, style
    examples/                         # sample boards
    reference/format.md
    package.json                      # {"type":"commonjs"} — overrides root ESM
  video-watching/                     # Standalone, bundleDir: true, alwaysApply: false
    SKILL.md
    scripts/transcribe.sh             # executable (+x)
    scripts/build_frame_index.py
    .gitignore```### Phase 3: Code-Bearing Standalone Skills (COMPLETE)

`CatalogStandalone` type extended with optional `bundleDir: boolean` field. When `true`, `installStandaloneFiles` uses `cpSync` (recursive) instead of a single-file copy, preserving the full directory tree and all file permissions (exec bits). Uninstall removes the entire directory. Manifest tracks all files for clean uninstall.

Skills with CommonJS scripts must include `package.json {"type":"commonjs"}` at the skill root — this scopes CJS resolution to just that subtree without affecting the rest of the package.

Test coverage: `tests/unit/install-packs.test.ts` (A9b: bundleDir copies full tree; A9c: video-watching executable bit preserved after install). Total: 16 install-pack tests.

To install: `dreamcontext install-skill --packs excalidraw` or `--packs video-watching`. Runtime deps for video-watching: `brew install whisper-cpp ffmpeg` (yt-dlp for remote URLs).

### Phase 2: CLI Install Mechanism (COMPLETE)

`install-skill` extended with three new flags:
- `--packs [names...]`: interactive @inquirer/prompts checkbox browser, or direct pack names for non-interactive use
- `--skill <pack> <skill>`: install a single sub-skill from a pack
- `--list`: show all available packs and their sub-skills from catalog.json

Implemented install flow:
1. `findPackageDir('skill-packs')` locates the catalog
2. `catalog.json` parsed; packs shown as checkbox list with `alwaysApply` badge
3. Each selected pack: SKILL.md copied to `.claude/skills/{pack-name}/SKILL.md`
4. Sub-skills copied alongside (flat dir, or subdirs for firebase references)
5. Cross-pack dependency check; warns if prerequisite pack is missing
6. Related agents copied to `.claude/agents/`
7. Base `install-skill` (no flags) prints hint about available packs after install

Interactive mode: "Install skill packs" and "List skill packs" entries added to Setup menu.

## Notes

- Phase 3 (official/community skills) depends on user providing sources. User preference: "copy, not rewrite" for existing skill content.
- Consider: should CLI also register skills in Claude Code's settings.json (like hooks are)?

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-04 - Phase 3: excalidraw + video-watching + bundleDir mechanism
- `bundleDir: true` catalog field added; `installStandaloneFiles` uses `cpSync` (full dir, exec bits preserved); uninstall removes whole directory.
- CommonJS fix: skills with `require()`-based scripts need `package.json {"type":"commonjs"}` at skill root to survive ESM host packages.
- excalidraw skill vendored: 11 files (SKILL.md, build_excalidraw.js, scripts/lib/*, examples/*, reference/), end-to-end verified.
- video-watching skill added: SKILL.md + transcribe.sh (executable) + gap_fill.py + build_frame_index.py; runtime deps: whisper-cpp, ffmpeg.
- 2 new install-packs tests (A9b, A9c); install-packs 16/16 green; build ships skill-packs/*/  to dist/.

### 2026-03-24 - Phase 2 complete: CLI install mechanism
- `install-skill` extended with `--packs`, `--skill`, `--list` flags
- Interactive checkbox browser, cross-pack dependency warnings, agent install
- "Install skill packs" and "List skill packs" added to interactive mode Setup menu
- Base install-skill now hints about available packs after install
- 17 new integration tests, 490 total passing
- README, DEEP-DIVE, CHANGELOG.md all updated; pushed to GitHub

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
