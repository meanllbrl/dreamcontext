---
id: feat_4NB3SlrK
status: active
created: '2026-02-25'
updated: '2026-03-01'
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
- [x] As an AI agent, I want pinned knowledge files loaded in full so frequently-needed context is always present without extra tool calls.
- [x] As an AI agent, I want sleep state shown at startup so I know whether to consolidate before doing more work.
- [x] As an AI agent, I want the recent changelog surfaced so I have immediate visibility into what changed in the last 5 entries.
- [x] As an AI agent, I want the features summary shown (with Why, related tasks, latest changelog) so I understand the product surface without reading every PRD.
- [x] As an AI agent, I want the extended core files index shown so I know what additional files exist and can read them on demand.
- [x] As a sub-agent, I want a lightweight context briefing injected at launch so I know the project structure and can check existing knowledge without any tool calls.

## Acceptance Criteria

- Running `agentcontext snapshot` outputs a plain-text, no-color document to stdout.
- Soul (0.soul.md), user (1.user.md), and memory (2.memory.md) are always included in full when they exist.
- Active tasks (status != completed) are listed with name, status, priority, and last-updated date.
- Sleep state section appears only when debt > 0 or sessions exist; shows debt level (Alert/Drowsy/Sleepy/Must Sleep).
- Recent changelog shows up to 5 most recent entries from CHANGELOG.json.
- Features section includes each feature's status, tags, first line of Why, related tasks, and latest non-creation changelog entry.
- Knowledge index lists all knowledge files with slug, path, description, and tags; pinned files are loaded in full under a separate Pinned Knowledge section.
- Extended core index lists all core files numbered 3+ (not soul/user/memory) with their name and summary.
- If `_agent_context/` does not exist, the command exits silently with no output and no error.
- Output is designed for `SessionStart` hook consumption — no chalk, no interactivity.
- `hook subagent-start` outputs valid JSON `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"..."}}` per Claude Code's SubagentStart hook spec. The briefing inside is ~25 lines: project summary, directory structure, active tasks, knowledge index, pinned knowledge, usage instructions.

## Constraints & Decisions

- **[2026-02-25]** Plain text only — no ANSI colors or interactive elements. The snapshot is piped into the Claude Code context window, not displayed to a human in a terminal.
- **[2026-02-25]** Completed tasks are excluded from the snapshot to avoid cluttering context with resolved work.
- **[2026-02-25]** Feature Why text is truncated to 120 chars; feature changelog entries to 120 chars — enough for signal without bloat.
- **[2026-02-25]** Pinned knowledge loads full file content; non-pinned knowledge shows only the index line. This lets critical files be always-present while keeping snapshot size bounded.
- **[2026-02-25]** SubagentStart briefing is intentionally lighter than the full snapshot. Sub-agents are task-focused and short-lived; they need enough to check existing knowledge, not the full project state. Soul/user/memory content excluded to avoid leaking internal rules into sub-agent contexts.

## Technical Details

**Entry point**: `src/cli/commands/snapshot.ts` — `generateSnapshot()` function.

**Hook integration**: Three hooks are registered by `install-skill`:
- `hook session-start`: Analyzes previous session transcript for debt scoring, then calls `generateSnapshot()` and outputs plain text. Used by SessionStart hook.
- `hook stop`: Records session_id + transcript_path for the next session's debt analysis. Used by Stop hook.
- `hook subagent-start`: Calls `generateSubagentBriefing()` and outputs JSON per Claude Code's SubagentStart spec. Used by SubagentStart hook (no matcher, fires for all sub-agents). Includes Task Awareness section with plan-to-task workflow instructions.
- `hook pre-tool-use`: PreToolUse hook handler. Reads stdin JSON `{ tool_name, tool_input }`. If `tool_name === "Agent"` and `subagent_type === "Explore"` and `_agent_context/` exists, returns deny response redirecting to `agentcontext-explore`. Otherwise outputs nothing (allow).

**Section generation order** (all sections are conditional — only emitted if data exists):
1. Soul (`core/0.soul.md`) — full file content
2. User (`core/1.user.md`) — full file content
3. Memory (`core/2.memory.md`) — full file content
4. Extended Core Files index — built by `buildCoreIndex()` in `src/lib/core-index.ts`; scans `core/[3-9]*`, reads frontmatter `name`/`type`/`summary` fields
5. Active Tasks — fast-glob `state/*.md`, reads frontmatter, skips `status: completed`
6. Sleep State — read from `state/.sleep.json` via `readSleepState()`
7. Recent Changelog — last 3 entries from `core/CHANGELOG.json` (reduced from 5)
7a. Latest Release — most recent entry from `core/RELEASES.json` (version, date, summary)
8. Features summary — fast-glob `core/features/*.md`, reads frontmatter + `## Why` + `## Changelog` sections
9. Knowledge Index — built by `buildKnowledgeIndex()` in `src/lib/knowledge-index.ts`; sorted pinned-first then alphabetical
10. Pinned Knowledge — full content of any knowledge entry where `pinned: true`

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

### 2026-03-01 - Context-Aware Sub-Agent Optimization (PreToolUse + Task Awareness)
- Added `hook pre-tool-use` subcommand. Blocks default Explorer (`subagent_type: "Explore"`) via JSON deny response when `_agent_context/` exists. Non-agentcontext projects unaffected.
- Added Task Awareness section to SubagentStart briefing for all sub-agents: plan-to-task workflow, task creation commands, "All work should be linked to a task" directive.
- `install-skill` now registers 4 hooks: SessionStart, Stop, SubagentStart, PreToolUse (matcher: "Agent").
- `agents/agentcontext-explore.md` created: context-first Explorer. Checks _agent_context/ files first, returns immediately if context answers the query, falls back to full codebase search. Same tools as default Explorer.
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
