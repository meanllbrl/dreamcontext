---
id: feat_9qLM-gY_
status: active
created: '2026-02-25'
updated: '2026-03-02'
released_version: 0.1.0
tags:
  - architecture
  - backend
  - decisions
related_tasks: []
---

## Why

Agents accumulate knowledge and make decisions across many sessions, but that knowledge degrades or gets lost without a structured consolidation process. Sleep consolidation — modeled on REM sleep — automatically tracks how much work has accumulated and triggers a dedicated sub-agent to fold learnings into the core context files before the brain gets overloaded.

## User Stories

- [x] As an AI agent, I want sleep debt tracked automatically so I don't have to manually decide when to consolidate.
- [x] As an AI agent, I want to see the current sleep debt level at session start so I know whether to consolidate before doing more work.
- [x] As an AI agent, I want graduated awareness thresholds (Alert / Drowsy / Sleepy / Must Sleep) so the urgency of consolidation is unambiguous.
- [x] As an AI agent, I want the Stop hook to record each session's transcript path and last assistant message so the consolidation agent has the raw material it needs.
- [x] As an AI agent, I want the SessionStart hook to auto-analyze any unanalyzed sessions so debt scoring happens even if the Stop hook missed a session.
- [x] As a developer, I want to manually add debt for non-file-change work (architecture discussions, decisions) so the debt meter reflects cognitive load accurately.
- [x] As a developer, I want to reset debt after consolidation with a summary so the system knows when the last sleep happened.
- [x] As an AI agent, I want a dedicated REM Sleep sub-agent to do the consolidation so the main agent can stay focused on the user's task.
- [x] As an AI agent, I want persistent sleep debt reminders on every user message so consolidation urgency cannot be forgotten across a session.

## Acceptance Criteria

- `hook stop` reads session_id, transcript_path, and last_assistant_message from stdin JSON; analyzes transcript for Write/Edit tool uses; stores session record in `state/.sleep.json`.
- `hook session-start` finds all sessions with `score: null` and analyzes their transcripts; adds computed scores to debt total.
- Debt scoring: session score = `Math.max(scoreFromChangeCount, scoreFromToolCount)`. `scoreFromChangeCount`: 0=0, 1-3=+1, 4-8=+2, 9+=+3. `scoreFromToolCount`: 0=0, 1-15=+1, 16-40=+2, 41+=+3.
- Debt levels: 0-3 = Alert, 4-6 = Drowsy, 7-9 = Sleepy, 10+ = Must Sleep.
- `hook session-start` prepends a CRITICAL consolidation directive to the snapshot output when debt >= 10.
- `hook session-start` prepends a softer advisory note when debt >= 7.
- `sleep status` shows current debt, level, last sleep date, and per-session history.
- `sleep add <score> <description>` manually records a debt entry (scores 1-3 only).
- `sleep done <summary>` resets debt to 0, records last_sleep date, clears sessions array.
- `sleep debt` outputs the raw debt number for programmatic use.
- If the same session_id stops twice, the old score is subtracted before the new score is added (no double-counting).
- Transcripts over 50MB are skipped (safety cap).
- `hook user-prompt-submit` fires on every user message, outputs a one-line reminder when debt >= 4 or critical bookmarks exist. Silent when debt < 4. Read-only (no state writes).

## Constraints & Decisions

- **[2026-02-27]** Bookmarks (awake ripples) are now the primary consolidation signal. Critical (salience 3) bookmarks trigger the consolidation advisory regardless of debt level. The rem-sleep agent processes bookmarks first.
- **[2026-02-27]** `freshDefaults()` replaces `DEFAULT_SLEEP_STATE` spread everywhere. Spreading a const with arrays shares references across calls -- this caused test pollution. Always call `freshDefaults()` when initializing an empty SleepState.
- **[2026-02-27]** Trigger `fired_count` is persisted by `writeSleepState()` inside `generateSnapshot()`. Triggers expire (removed from state) in `sleep done` after hitting `max_fires`. This is intentional -- persistent triggers that always fire become noise.
- **[2026-02-28]** `SleepHistoryEntry` extended with `consolidated_at: string` (ISO timestamp) and `session_ids: string[]`. `transcript distill` uses these to auto-filter: only shows content after `consolidated_at` for sessions that have already been consolidated. `--full` shows entire transcript; `--since <iso>` for manual cutoff.
- **[2026-03-02]** PreCompact hook added as 7th hook. Saves `CompactionRecord` (timestamp, trigger, debt, session_count, bookmark_count) to `compaction_log[]` in `.sleep.json` before context compaction. LIFO, capped at 20 entries. Prevents silent loss of sleep state context during compaction. `CompactionRecord` interface in `sleep.ts`.
- **[2026-03-02]** Pattern extraction (Step 1c) added to rem-sleep agent between Task Linkage Check and Step 2. Agent scans distilled transcripts for repeated preferences (2+), workflow patterns (3+), recurring errors (2+), bookmark themes (3+). Prompt-level only.
- **[2026-03-01]** Debt thresholds tightened: debt >= 4 now triggers directives (was >= 7). Rhythm check is 3+ sessions (was 5+). SKILL.md updated to mandate consolidation offers at Drowsy level. UserPromptSubmit hook added as 5th hook — fires on every user message with compact one-line reminder. Read-only. PostToolUse was considered and rejected (fires mid-work, wrong timing). 415 tests.
- **[2026-02-28]** Transcript distillation output quality improved: includes thinking blocks, subagent I/O (input+output, internal tool calls filtered), full content without truncation, byte deltas on Edit changes, line counts on Write. Trivial response filter removed.
- **[2026-02-27]** Transcript distillation is pure Node.js structural filtering, no AI. Keeps user messages, agent text, Write/Edit calls, modifying Bash, bookmark calls, errors. Discards Read/Glob/Grep/WebFetch results, tool metadata.
- **[2026-02-25]** Debt is tracked in `state/.sleep.json` (dot-prefixed to separate it from user task files in `state/`).
- **[2026-02-25]** Transcript analysis is regex-based (`/"name"\s*:\s*"(?:Write|Edit)"/g`), not a full JSON parse, for performance on large JSONL files.
- **[2026-02-25]** The consolidation itself is done by the `agentcontext-rem-sleep` sub-agent, not by the CLI. The CLI only tracks debt; the agent dispatches the sub-agent when needed.
- **[2026-02-25]** Sessions array is LIFO (newest first) -- the most recent session is at index 0.

## Technical Details

**Sleep state file**: `_agent_context/state/.sleep.json`

**Schema** (see also `_agent_context/core/6.system_flow.md` for full annotated schema):
```json
{
  "debt": 4,
  "last_sleep": "2026-02-24",
  "last_sleep_summary": "Consolidated auth implementation and API design decisions",
  "sessions_since_last_sleep": 2,
  "sessions": [
    {
      "session_id": "abc123",
      "transcript_path": "/path/to/transcript.jsonl",
      "stopped_at": "2026-02-24T18:30:00.000Z",
      "last_assistant_message": "Implemented JWT middleware...",
      "change_count": 7,
      "tool_count": 35,
      "score": 2,
      "bookmarks": ["bookmark-id-1"]
    }
  ],
  "bookmarks": [
    {
      "id": "bk_abc",
      "text": "Decided to use freshDefaults() instead of DEFAULT_SLEEP_STATE spread",
      "salience": 3,
      "session_id": "abc123",
      "created_at": "2026-02-27T10:00:00.000Z"
    }
  ],
  "triggers": [
    {
      "id": "tr_abc",
      "pattern": "auth",
      "reminder": "JWT tokens expire after 24h -- always refresh before API calls",
      "tags": ["security"],
      "fired_count": 1,
      "max_fires": 5,
      "created_at": "2026-02-27T10:00:00.000Z"
    }
  ],
  "knowledge_access": {
    "jwt-auth-flow": "2026-02-27T10:00:00.000Z"
  },
  "sleep_history": [
    {
      "date": "2026-02-27",
      "summary": "Consolidated neuroscience session",
      "debt_before": 6,
      "debt_after": 0,
      "sessions_processed": 2,
      "bookmarks_processed": 3
    }
  ],
  "dashboard_changes": [],
  "compaction_log": [
    {
      "timestamp": "2026-03-02T10:00:00.000Z",
      "trigger": "manual",
      "debt": 6,
      "session_count": 2,
      "bookmark_count": 1
    }
  ]
}
```

**Hook flow**:
1. Session ends → Claude Code fires Stop hook → `hook stop` reads stdin JSON, analyzes transcript, prepends session record to `sessions[]`, adds score to `debt`, writes state.
2. Next session starts → Claude Code fires SessionStart hook → `hook session-start` finds sessions with `score: null`, analyzes their transcripts, updates scores and debt. Then generates and outputs the snapshot with any consolidation directive prepended.

**Scoring function** (`src/cli/commands/hook.ts`): `Math.max(scoreFromChangeCount, scoreFromToolCount)`

`scoreFromChangeCount` (Write/Edit tool calls):
- 0 changes → 0
- 1-3 changes → +1 (light session)
- 4-8 changes → +2 (moderate session)
- 9+ changes → +3 (heavy session)

`scoreFromToolCount` (all tool calls — catches Bash-heavy sessions with no file writes):
- 0 tools → 0
- 1-15 tools → +1
- 16-40 tools → +2
- 41+ tools → +3

**Key files**:
- `src/cli/commands/hook.ts` — hook stop, hook session-start, hook user-prompt-submit, hook post-tool-use, hook pre-compact, transcript analysis, debt scoring, bookmark linking, rhythm counter, findProjectConfig(), resolveLocalBin()
- `src/cli/commands/sleep.ts` — sleep status, sleep add, sleep done, sleep debt, sleep history, SleepState type (Bookmark, Trigger, SleepHistoryEntry, KnowledgeAccessRecord), readSleepState/writeSleepState, freshDefaults()
- `src/cli/commands/bookmark.ts` — bookmark add/list/clear
- `src/cli/commands/trigger.ts` — trigger add/list/remove
- `src/cli/commands/transcript.ts` — transcript distill (structural JSONL filter)
- `src/cli/commands/snapshot.ts` — bookmarks section, warm knowledge tier, contextual reminders, sleep history in output, extractFirstParagraph(), trigger matching + fired_count persistence
- `agents/agentcontext-rem-sleep.md` — the REM sleep consolidation sub-agent instructions (bookmark-first processing, transcript distillation, trigger creation, access-based anti-bloat)
- `_agent_context/core/6.system_flow.md` — complete system lifecycle and data flow documentation

**REM Sleep agent protocol**: When dispatched, the agent reads the brief from the main agent, reads session records from `.sleep.json` (using `last_assistant_message` as primary input), determines what files to update, executes updates (soul, user, memory, changelog, task logs, feature PRDs), then calls `agentcontext sleep done "<summary>"` to reset debt.

## Notes

- The Stop hook does not block the session from ending — it has a 5-second timeout. If it fails silently, the SessionStart hook catches up by re-analyzing the transcript.
- The `last_assistant_message` field from the Stop hook is the single most valuable piece of data for the REM sleep agent — it contains Claude's summary of what was accomplished, making transcript reads optional in most cases.
- Manual debt entries (`sleep add`) use a `manual-<timestamp>` session_id and `transcript_path: null`. They will never be re-analyzed by the SessionStart hook.
- The REM sleep agent calls `sleep done` itself after consolidation — the main agent should not call it.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-03-02 - PostToolUse hook, PreCompact hook, pattern extraction
- PostToolUse hook: auto-format (Biome/Prettier walk-up) + tsc --noEmit --incremental on JS/TS edits. execFileSync (no shell injection). resolveLocalBin() (npx fallback). findProjectConfig() merges walk-up. 30s timeout. 7th hook registered.
- PreCompact hook: saves CompactionRecord to compaction_log[] (LIFO, cap 20). CompactionRecord interface + compaction_log field added to SleepState. 5s timeout.
- rem-sleep Step 1c: pattern extraction from distilled transcripts (preferences 2+, workflows 3+, errors 2+, bookmark themes 3+)
- ensureHooks() refactored: 160-line boilerplate -> data-driven HOOK_SPECS table
- 451 tests (450 passing, 1 pre-existing flaky nanoid)

### 2026-03-01 - UserPromptSubmit hook + tightened thresholds
- hook user-prompt-submit added: fires on every user message, one-line debt reminder when debt >= 4. Critical bookmarks override. Read-only. 6 new tests.
- Thresholds tightened: debt >= 4 triggers directives (was >= 7), rhythm check 3+ sessions (was 5+)
- SKILL.md: Drowsy (4-6) mandatory consolidation offer language added
- PostToolUse considered and rejected (fires mid-work)
- 415 tests total, all passing

### 2026-02-28 - transcript distill: timestamp filter + SleepHistoryEntry fields + output quality
- SleepHistoryEntry: added consolidated_at (ISO timestamp) and session_ids (string[]) fields
- transcript distill auto-filters by consolidated_at: only shows content after last consolidation for previously-processed sessions
- transcript distill output: full content, thinking blocks, subagent I/O, byte deltas on edits, trivial response filter removed
- 7 new tests, 394 total (all passing)

### 2026-02-27 - Neuroscience-Inspired Memory System (8 phases)
- Phase 1: Bookmarks (awake ripples) -- salience-scored tagging during active work, critical bookmarks trigger consolidation advisory
- Phase 2: Knowledge decay tracking -- knowledge_access map in SleepState, staleness indicators at 30+ days
- Phase 3: Consolidation rhythm -- sessions_since_last_sleep counter, rhythm advisory at 5+ sessions
- Phase 4: Warm knowledge tier -- extractFirstParagraph() helper, warm knowledge section in snapshot (7-day recency + tag overlap)
- Phase 5: Contextual triggers -- pattern-matched reminders surfaced in snapshot, auto-expire after max_fires
- Phase 6: Transcript distillation -- pure Node.js structural JSONL filter, no AI required
- Phase 7: Sleep history -- SleepHistoryEntry, sleep_history[] LIFO, sleep history subcommand, snapshot shows last 3
- Phase 8: System flow documentation -- core/6.system_flow.md with lifecycle, schema, neuroscience mapping
- Fixed freshDefaults() shared-reference mutation bug in readSleepState
- 48 new tests (384 total, 383 passing)

### 2026-02-27 - Tool Count Scoring
- Added `tool_count` to `SessionRecord` schema (counts all tool calls, not just Write/Edit)
- Session score now `Math.max(scoreFromChangeCount, scoreFromToolCount)` to avoid under-scoring Bash-heavy sessions
- Snapshot display updated: `(+2) 0 changes, 35 tools`
- 336 tests passing

### 2026-02-25 - Created
- Feature PRD created.
