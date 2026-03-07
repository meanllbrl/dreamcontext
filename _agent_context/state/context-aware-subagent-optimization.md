---
id: task_EUS-eUI5
name: context-aware-subagent-optimization
description: >-
  Custom context-aware sub-agents replacing default Explorer and enhancing Plan
  to eliminate token waste from re-exploring already-curated context
priority: critical
status: completed
created_at: '2026-03-01'
updated_at: '2026-03-01'
tags:
  - architecture
  - performance
  - sub-agents
  - hooks
parent_task: null
related_feature: null
---

## Why

Default Explorer and Plan sub-agents ignore `_agent_context/` context despite SubagentStart hook injection. Root cause: `additionalContext` is inherently lower priority than the sub-agent's built-in system prompt (documented 2026-02-27). Result: Explorer burns 100K-150K tokens re-reading codebase files that are already curated in core files (e.g., data structures, tech stack). Plan creates plans in a temp file that doesn't integrate with the agentcontext task system, making plans untrackable and lost across sessions.

## User Stories

- [x] As a developer using agentcontext, I want the Explorer to check `_agent_context/` files first so that it doesn't waste 100K+ tokens re-reading what's already curated
- [x] As a developer, I want the default Explorer blocked when `_agent_context/` exists so that the context-aware version is always used instead
- [x] As a developer, I want plans to be offered as agentcontext tasks so that I can track, update, and add changelogs to them across sessions
- [x] As a developer, I want the custom Explorer to report sleep debt but NOT trigger sleep so that exploration stays fast

## Acceptance Criteria

- [x] `agentcontext-explore` agent file exists in `agents/` with context-first exploration behavior
- [x] PreToolUse hook blocks default Explorer (Agent tool with subagent_type "Explore") ONLY when `_agent_context/` directory exists
- [x] PreToolUse hook returns a clear message directing the agent to use `agentcontext-explore` instead
- [x] Custom Explorer reads relevant `_agent_context/` files first, returns early if context answers the query
- [x] Custom Explorer falls back to full codebase exploration if context is insufficient (no capability loss)
- [x] Custom Explorer reports sleep debt level if high, but does NOT trigger sleep
- [x] SubagentStart briefing includes Task Awareness section for all sub-agents (plan-to-task workflow, task creation commands)
- [x] SKILL.md updated with custom Explorer documentation and Plan-to-task workflow
- [x] `install-skill` registers the new PreToolUse hook and `agentcontext-explore` agent
- [x] Non-agentcontext projects (no `_agent_context/` directory) are unaffected, default Explorer works normally
- [x] Integration tests cover Explorer blocking, custom explorer context-first behavior, and Plan deliverable injection

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-03-01 - Plan: enhance, don't replace
Plan mode stays as-is. SubagentStart hook injects a deliverable instruction ("offer to create an agentcontext task"). This is additive (doesn't contradict Plan's built-in behavior) unlike Explorer where we need to override the behavior. Agent asks user if they want to save plan as task.

### 2026-03-01 - Explorer: full replacement via PreToolUse hook
Default Explorer blocked via PreToolUse hook when `_agent_context/` exists. Custom `agentcontext-explore` agent has identical tool access (Glob, Grep, Read, Bash, WebFetch, WebSearch) but context-first behavior. No capability loss.

### 2026-03-01 - No sleep trigger in Explorer
Explorer reports sleep debt but does not trigger consolidation. Sleep can take 1-3 minutes and would block the exploration response. Main agent decides whether to consolidate.

### 2026-03-01 - Scope limited to _agent_context/ projects
PreToolUse hook checks for `_agent_context/` directory existence before blocking. Non-agentcontext projects use default Explorer unchanged.

## Technical Details

### 1. PreToolUse Hook (`src/cli/commands/hook.ts`)
New `pre-tool-use` subcommand. Reads stdin JSON `{ tool_name, tool_input }`. If `tool_name === "Agent"` and `tool_input.subagent_type === "Explore"`, check if `_agent_context/` exists. If yes, exit 0 with JSON deny response (`permissionDecision: "deny"` + redirect message). If no `_agent_context/`, exit 0 with no output (allow default).

### 2. Custom Explorer Agent (`agents/agentcontext-explore.md`)
Agent definition with tools: Glob, Grep, Read, Bash, WebFetch, WebSearch (same as default Explorer). System prompt:
1. Read the exploration query
2. Map query keywords to `_agent_context/` files (core files, features, knowledge)
3. Read relevant context files first
4. If context answers the query, return immediately with structured answer
5. If not, proceed with traditional codebase exploration using context as background knowledge
6. Report sleep debt level at end if debt >= 4

### 3. SubagentStart Enhancement (`src/cli/commands/snapshot.ts`)
`generateSubagentBriefing()` already runs for all sub-agents. Detect when the requesting agent is Plan type (from hook input). Append Plan-specific deliverable: "When your plan is complete, ask the user: 'Would you like me to save this plan as an agentcontext task?' If yes, create the task with `agentcontext tasks create <name> --status pending --priority <p> --tags <t>`."

### 4. SKILL.md Updates (`skill/SKILL.md`)
- Sub-Agents section: add `agentcontext-explore` documentation
- Remove "Context Propagation" workaround (no longer needed for Explorer)
- Add Plan-to-task workflow: "After plan approval, agent offers task creation"

### 5. Hook Registration (`skill/SKILL.md` hooks section + `install-skill`)
Add PreToolUse hook:
```yaml
PreToolUse:
  - matcher: "Agent"
    hooks:
      - type: command
        command: "npx agentcontext hook pre-tool-use"
        timeout: 5
```

### Key Files
- `src/cli/commands/hook.ts` - new pre-tool-use subcommand
- `src/cli/commands/snapshot.ts` - SubagentStart Plan detection
- `agents/agentcontext-explore.md` - new agent definition
- `skill/SKILL.md` - hook registration + documentation updates
- `src/cli/commands/install-skill.ts` - register new hook
- `tests/integration/hook.test.ts` - PreToolUse blocking + end-to-end hook tests

## Notes

- SubagentStart `additionalContext` is lower priority for Explorer (contradicts built-in behavior) but should work for Plan (additive behavior). This is the core asymmetry that drives the different strategies.
- The custom Explorer's "context-first" approach could save 50K-150K tokens per exploration query when the answer is already in `_agent_context/`. This is the primary performance win.
- PreToolUse hook must be fast (< 1s). It only checks `_agent_context/` existence and parses one JSON field. No heavy computation.
- Future consideration: if the Plan SubagentStart injection doesn't work well in practice (same lower-priority problem), escalate to PreToolUse blocking + custom `agentcontext-plan` agent. But try the lighter approach first.

## Changelog
<!-- LIFO: newest entry at top -->


### 2026-03-01 - Completed
- All 11 acceptance criteria met. PreToolUse hook blocks default Explorer; agentcontext-explore agent is context-first. SubagentStart Task Awareness section added. REM sleep task linkage check added. 403 tests passing.
### 2026-03-01 - Implementation complete, all acceptance criteria met
- `agents/agentcontext-explore.md`: Context-first Explorer with keyword-to-file mapping, early return, sleep debt reporting, thoroughness levels
- `src/cli/commands/hook.ts`: `pre-tool-use` subcommand blocks default Explorer via JSON deny response when `_agent_context/` exists
- `src/cli/commands/install-skill.ts`: PreToolUse hook registration (matcher: "Agent")
- `src/cli/commands/snapshot.ts`: Task Awareness section in SubagentStart briefing (plan-to-task workflow for all sub-agents)
- `skill/SKILL.md`: PreToolUse hook in YAML, Explorer + Plan-to-task in Sub-Agents, Rules 9-10, Command Reference updated
- `agents/agentcontext-rem-sleep.md`: Step 1b Task Linkage Check (mandatory), Untracked work row in decision tree, Task Linkage in report template
- `tests/integration/hook.test.ts`: 9 new tests (Explorer blocking, passthrough for Plan/rem-sleep/custom-explore/non-Agent, deny reason content, Task Awareness section)
- Code review: 2 P1 fixes (hook description, command reference), 4 P2 fixes (task file inaccuracies, missing test)
- 403 tests passing

### 2026-03-01 - Created
- Task created with full PRD: custom Explorer agent, PreToolUse hook, Plan-to-task deliverable, scope limited to _agent_context/ projects.
