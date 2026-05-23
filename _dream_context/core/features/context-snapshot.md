---
id: feat_4NB3SlrK
status: active
created: '2026-02-25'
updated: '2026-05-23'
released_version: 0.1.0
tags:
  - architecture
  - backend
  - onboarding
related_tasks: []
---

## Why

Every AI session starts blind — no memory of previous work, no knowledge of project identity or rules. The snapshot solves this by auto-injecting the full project brain into context at session start via a hook, requiring zero tool calls from the agent. It is the core value proposition of the entire system.

## User Stories

- [x] As an AI agent, I want my project identity (soul), user preferences, and memory injected at session start so I don't have to read core files manually.
- [x] As an AI agent, I want active tasks surfaced automatically so I can immediately see what work is in progress without grepping the state directory.
- [x] As an AI agent, I want the knowledge index loaded every session so I know what deep research exists and can load it on demand.
- [x] As an AI agent, I want pinned knowledge files surfaced prominently at the top of the Knowledge Index with a warning, so I know which files to load — without inlining their bodies into the snapshot (kept body inlining out as of 2026-05-23 to keep snapshot under budget).
- [ ] ~~As an AI agent, I want sleep state shown at startup so I know whether to consolidate before doing more work.~~ — Sleep State block was **removed from the snapshot** on 2026-05-23. Debt and consolidation prompts still surface via the SessionStart consolidation directive prepend and the UserPromptSubmit hook reminders; the standalone Sleep State block was duplicative.
- [x] As an AI agent, I want recent CHANGELOG entries surfaced **tiered**: top 3 detailed (summary + ~300 char body), next 10 titles-only under an "Older" subheading — so I get the most recent signal without the section eating context budget.
- [x] As an AI agent, I want the features summary shown (with Why, related tasks, latest changelog) so I understand the product surface without reading every PRD.
- [x] As an AI agent, I want the extended core files index shown so I know what additional files exist and can read them on demand.
- [x] As a sub-agent, I want a lightweight context briefing injected at launch so I know the project structure and can check existing knowledge without any tool calls.

## Acceptance Criteria

- Running `dreamcontext snapshot` outputs a plain-text, no-color document to stdout.
- Soul (0.soul.md), user (1.user.md), and memory (2.memory.md) are always included in full when they exist.
- Active tasks (status != completed) are listed with name, status, priority, and last-updated date.
- ~~Sleep state section appears only when debt > 0 or sessions exist; shows debt level (Alert/Drowsy/Sleepy/Must Sleep).~~ **Removed 2026-05-23** — Sleep State block is no longer emitted as a dedicated section. Consolidation pressure is communicated via the SessionStart consolidation directive (prepended before the snapshot when debt is high or critical bookmarks exist) and via the UserPromptSubmit hook one-liner.
- Recent CHANGELOG is tiered: top 3 entries detailed (summary + first ~300 chars of description), next 10 entries as titles-only under an `### Older` subheading. Tier sizes are configurable via constants at the top of `src/cli/commands/snapshot.ts`.
- Features section includes each feature's status, tags, first line of `Why:` (capped at **250 chars**, up from 100), related tasks, and latest non-creation changelog entry. HTML template comments (`<!-- ... -->`) are stripped from the Why excerpt.
- Active-task surfacing also caps the task's `why:` excerpt at **250 chars** (up from 100), with HTML template comments stripped.
- Knowledge index lists all knowledge files with slug, path, description, and tags. **Pinned files surface at the top of the Knowledge Index with a prominent warning** instead of having their bodies inlined in a separate Pinned Knowledge section — the agent loads pinned files on demand using the surfaced path.
- Extended core index lists all core files numbered 3+ (not soul/user/memory) with their name and summary.
- If `_dream_context/` does not exist, the command exits silently with no output and no error.
- Output is designed for `SessionStart` hook consumption — no chalk, no interactivity.
- `hook subagent-start` outputs valid JSON `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"..."}}` per Claude Code's SubagentStart hook spec. The briefing inside is ~25 lines: project summary, directory structure, active tasks, knowledge index, pinned knowledge, usage instructions.

## Constraints & Decisions

- **[2026-02-25]** Plain text only — no ANSI colors or interactive elements. The snapshot is piped into the Claude Code context window, not displayed to a human in a terminal.
- **[2026-02-25]** Completed tasks are excluded from the snapshot to avoid cluttering context with resolved work.
- **[2026-05-23]** Feature `Why:` and active-task `why:` excerpt cap raised from 100 → 250 chars. HTML template comments stripped from excerpts so scaffold boilerplate doesn't leak into the snapshot.
- **[2026-05-23]** Sleep State section removed from the snapshot output. Consolidation pressure communicated via the SessionStart consolidation directive prepend (when debt is high or critical bookmarks exist) and the UserPromptSubmit hook reminder. The standalone block was duplicative.
- **[2026-05-23]** Pinned Knowledge body inlining removed. Pinned files surface at the top of the Knowledge Index with a prominent warning; the agent loads the bodies on demand via the surfaced path. Keeps snapshot size bounded as projects accumulate pinned docs.
- **[2026-05-23]** Recent CHANGELOG section is now tiered (top 3 detailed + next 10 titles-only). Tier sizes and body-snippet length configurable via constants at the top of `src/cli/commands/snapshot.ts`. Older entries remain searchable through `memory recall --types changelog`.
- **[2026-02-25]** Feature Why text was originally truncated to 120 chars; feature changelog entries still 120 chars.
- **[2026-02-25]** Non-pinned knowledge shows only the index line. This keeps snapshot size bounded.
- **[2026-02-25]** SubagentStart briefing is intentionally lighter than the full snapshot. Sub-agents are task-focused and short-lived; they need enough to check existing knowledge, not the full project state. Soul/user/memory content excluded to avoid leaking internal rules into sub-agent contexts.

## Technical Details

**Entry point**: `src/cli/commands/snapshot.ts` — `generateSnapshot()` function.

**Hook integration**: Three hooks are registered by `install-skill`:
- `hook session-start`: Analyzes previous session transcript for debt scoring, then calls `generateSnapshot()` and outputs plain text. Used by SessionStart hook.
- `hook stop`: Records session_id + transcript_path for the next session's debt analysis. Used by Stop hook.
- `hook subagent-start`: Calls `generateSubagentBriefing()` and outputs JSON per Claude Code's SubagentStart spec. Used by SubagentStart hook (no matcher, fires for all sub-agents). Includes Task Awareness section with plan-to-task workflow instructions.
- `hook pre-tool-use`: PreToolUse hook handler. Reads stdin JSON `{ tool_name, tool_input }`. If `tool_name === "Agent"` and `subagent_type === "Explore"` and `_dream_context/` exists, returns deny response redirecting to `dreamcontext-explore`. Otherwise outputs nothing (allow).

**Section generation order** (all sections are conditional — only emitted if data exists):
1. Soul (`core/0.soul.md`) — full file content
2. User (`core/1.user.md`) — full file content (Decisions + Known Issues; LIFO section was removed 2026-05-23)
3. Memory (`core/2.memory.md`) — full file content
4. Extended Core Files index — built by `buildCoreIndex()` in `src/lib/core-index.ts`; scans `core/[3-9]*`, reads frontmatter `name`/`type`/`summary` fields
5. Active Tasks — fast-glob `state/*.md`, reads frontmatter, skips `status: completed`. Task `why:` excerpt capped at 250 chars with HTML template comments stripped.
6. ~~Sleep State~~ — **removed 2026-05-23.** Consolidation pressure surfaces via the SessionStart consolidation directive prepend + UserPromptSubmit hook one-liner.
7. Recent CHANGELOG — **tiered**: top 3 detailed (summary + first ~300 chars of description), next 10 titles-only under `### Older`. Tier sizes and body-snippet length configurable via constants at the top of `snapshot.ts`.
7a. Latest Release — most recent entry from `core/RELEASES.json` (version, date, summary)
8. Features summary — fast-glob `core/features/*.md`, reads frontmatter + `## Why` + `## Changelog` sections. Feature `Why:` excerpt capped at 250 chars with HTML template comments stripped.
9. Knowledge Index — built by `buildKnowledgeIndex()` in `src/lib/knowledge-index.ts`; **pinned entries surface at the top of the index with a prominent warning** (no body inlining as of 2026-05-23).

**Library dependencies**:
- `src/lib/core-index.ts` — `buildCoreIndex()`
- `src/lib/knowledge-index.ts` — `buildKnowledgeIndex()`
- `src/lib/frontmatter.ts` — `readFrontmatter()`
- `src/lib/markdown.ts` — `readSection()`
- `src/lib/json-file.ts` — `readJsonArray()`
- `src/cli/commands/sleep.ts` — `readSleepState()`

## Notes

- The snapshot is append-only by design — each section independently guarded by existence checks. A missing file never crashes the snapshot.
- The `hook session-start` command prepends a consolidation directive (`>>> CRITICAL: CONSOLIDATION REQUIRED <<<`) before the snapshot output when debt >= 10, and a softer note when debt >= 7. This appears before snapshot content so the agent reads it first.
- The `snapshot` command is also registered as a standalone CLI command for testing/debugging purposes.
- Snapshot size can grow large on projects with many pinned knowledge files. The recommendation is to pin sparingly — only files that are needed in nearly every session.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-05-23 - Snapshot leanness pass
- Sleep State block removed from snapshot output; consolidation pressure now lives in the SessionStart prepend + UserPromptSubmit hook only.
- Pinned Knowledge body inlining removed. Pinned entries now surface at the top of the Knowledge Index with a prominent warning; agent loads bodies on demand via the surfaced path.
- Recent CHANGELOG section made tiered: top 3 detailed (summary + ~300 char body), next 10 titles-only under `### Older`. Configurable via constants at the top of `snapshot.ts`.
- Feature `Why:` and active-task `why:` excerpt cap raised 100 → 250 chars. HTML template comments stripped from excerpts.

### 2026-03-01 - Context-Aware Sub-Agent Optimization (PreToolUse + Task Awareness)
- Added `hook pre-tool-use` subcommand. Blocks default Explorer (`subagent_type: "Explore"`) via JSON deny response when `_dream_context/` exists. Non-dreamcontext projects unaffected.
- Added Task Awareness section to SubagentStart briefing for all sub-agents: plan-to-task workflow, task creation commands, "All work should be linked to a task" directive.
- `install-skill` now registers 4 hooks: SessionStart, Stop, SubagentStart, PreToolUse (matcher: "Agent").
- `agents/dreamcontext-explore.md` created: context-first Explorer. Checks _dream_context/ files first, returns immediately if context answers the query, falls back to full codebase search. Same tools as default Explorer.
- 9 new integration tests; 403 total passing.

### 2026-02-26 - Latest Release Section + Changelog Limit
- Added Latest Release section to snapshot (reads most recent entry from RELEASES.json, shows version/date/summary).
- Recent Changelog reduced from 5 to 3 entries to balance token budget.
- `src/lib/release-discovery.ts` drives both the snapshot section and the `releases add` auto-discovery.

### 2026-02-25 - SubagentStart Hook Support
- Added `hook subagent-start` subcommand outputting JSON with lightweight context briefing for all sub-agents.
- Added `generateSubagentBriefing()` to snapshot.ts; extracted `getActiveTaskLines()` helper shared with `generateSnapshot()`.
- `install-skill` now registers three hooks: SessionStart, Stop, SubagentStart.
- 10 new integration tests; 246 total passing.

### 2026-02-25 - Created
- Feature PRD created.
