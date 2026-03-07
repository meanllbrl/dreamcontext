---
id: task_lvA80LWa
name: code-quality-hooks
description: >-
  Implement post-edit code quality gates and PreCompact hook inspired by ECC
  competitive analysis. Four deliverables: (1) PostToolUse Auto-Format hook:
  detect Biome/Prettier, run on edited file. (2) PostToolUse TypeScript Check
  hook: tsc --noEmit filtered to edited file. (3) PreCompact hook: save sleep
  state + bookmarks before context compaction. (4) Pattern extraction step in
  rem-sleep agent: look for repeated patterns during consolidation, write to
  knowledge.
priority: critical
status: completed
created_at: '2026-03-01'
updated_at: '2026-03-02'
tags:
  - hooks
  - dx
  - code-quality
parent_task: null
related_feature: null
---

## Why

AI agents frequently introduce formatting inconsistencies and TypeScript errors during code generation. By running the project's existing formatter and type-checker immediately after each Edit/Write, errors are caught and corrected in real-time rather than accumulating into larger debugging sessions. The PreCompact hook prevents silent loss of sleep state during context compaction. Pattern extraction in the sleep agent automates discovery of recurring themes that should be codified into persistent memory.

## User Stories

- [x] As a developer, I want my AI agent to auto-format files after editing them so that code style stays consistent without manual intervention
- [x] As a developer, I want TypeScript errors shown to the agent immediately after editing so the agent can self-correct
- [x] As a developer, I want a record of context compaction events so I can understand when and why context was lost
- [x] As a developer, I want the sleep agent to detect recurring patterns across sessions so useful knowledge is automatically captured

## Acceptance Criteria

- [x] PostToolUse hook detects Biome config (biome.json, biome.jsonc) by walking up from file path
- [x] PostToolUse hook detects Prettier config (11 variants) by walking up from file path
- [x] Biome is preferred over Prettier when both are present
- [x] Formatter runs via npx, failure is silent (exit 0)
- [x] Hook only fires for JS/TS file extensions (.js, .jsx, .ts, .tsx, .mjs, .cjs, .mts, .cts)
- [x] tsc --noEmit errors filtered to only the edited file
- [x] tsc errors fed back via additionalContext JSON
- [x] PreCompact saves debt, session count, bookmark count to compaction_log
- [x] compaction_log capped at 20 entries (LIFO)
- [x] install-skill registers both PostToolUse and PreCompact hooks
- [x] SKILL.md frontmatter updated with both hooks
- [x] Step 1c added to rem-sleep agent with clear pattern categories and minimum occurrence thresholds
- [x] Unit tests for isJsTsFile, findFormatterConfig, findTsconfig
- [x] Integration tests for hook post-tool-use and hook pre-compact

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-03-02 - Implementation decisions
- ESM-only, .js extensions in all imports
- Graceful failure: if npx, biome, prettier, or tsc are not installed, the hook silently exits 0
- PostToolUse timeout: 30 seconds (accommodates npx bootstrap + tsc on large projects)
- PreCompact timeout: 5 seconds
- No new npm dependencies: uses npx for all external tools
- Walk-up limit: 10 levels for formatter/tsconfig detection
- Single post-tool-use subcommand handles both format and tsc (avoids registering two separate hooks)
- Biome preferred over Prettier when both exist (Biome is faster, encompasses both)
- additionalContext used instead of decision:"block" (PostToolUse can't block, tool already ran)
- Pattern extraction is prompt-level (Step 1c in rem-sleep agent), not CLI code
- compaction_log is a new field on SleepState, capped at 20 entries

## Technical Details

**Key files:**
- `src/cli/commands/hook.ts` -- 5 new exported functions + 2 new subcommands
- `src/cli/commands/sleep.ts` -- CompactionRecord type + compaction_log field
- `src/cli/commands/install-skill.ts` -- 2 new hook constants + registration
- `skill/SKILL.md` -- frontmatter + command reference table
- `agents/agentcontext-rem-sleep.md` -- Step 1c pattern extraction

**Functions added to hook.ts:**
- `isJsTsFile(filePath)` -- extension check
- `findFormatterConfig(filePath)` -- walk-up Biome/Prettier detection
- `runFormatter(detection, filePath)` -- execSync npx format
- `findTsconfig(filePath)` -- walk-up tsconfig detection
- `runTscCheck(filePath)` -- tsc --noEmit filtered to file

## Notes

Inspired by ECC (everything-claude-code) competitive analysis. See `_agent_context/knowledge/competitive-analysis-ecc.md` for full analysis.

## Changelog
<!-- LIFO: newest entry at top -->


### 2026-03-02 - Session Update
- All 4 deliverables shipped: PostToolUse hook (auto-format + tsc), PreCompact hook (compaction_log), rem-sleep Step 1c pattern extraction, HOOK_SPECS data-driven refactor. Code review fixes applied: execFileSync shell injection fix, resolveLocalBin() npx optimization, findProjectConfig() merged walk-up, tsc --incremental. 451 tests, 450 passing.
### 2026-03-02 - Implemented all 4 deliverables
- PostToolUse hook: auto-format (Biome/Prettier detection) + tsc check on JS/TS files
- PreCompact hook: saves compaction record to .sleep.json compaction_log
- Pattern extraction Step 1c added to rem-sleep agent
- SleepState extended with CompactionRecord type and compaction_log field
- install-skill registers PostToolUse (Edit|Write, 30s) and PreCompact (5s) hooks
- SKILL.md updated with 7 hooks total
- Unit tests: isJsTsFile (14), findFormatterConfig (7), findTsconfig (3)
- Integration tests: post-tool-use (6), pre-compact (5), install-skill registration (2)

### 2026-03-01 - Created
- Task created.
