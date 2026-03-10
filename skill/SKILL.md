---
name: agentcontext
description: >
  AI agent persistent context management system. Activate when working on any project
  that has an _agent_context/ directory, when managing tasks, features, knowledge,
  session continuity, or when the user mentions context management, agent memory,
  or project state. Provides structured memory, task lifecycle management, and
  cross-session continuity via the agentcontext CLI.
user-invocable: false
alwaysApply: true
hooks:
  SessionStart:
    - matcher: "startup|resume|compact|clear"
      hooks:
        - type: command
          command: "npx agentcontext hook session-start"
          timeout: 10
  Stop:
    - hooks:
        - type: command
          command: "npx agentcontext hook stop"
          timeout: 5
  SubagentStart:
    - hooks:
        - type: command
          command: "npx agentcontext hook subagent-start"
          timeout: 5
  PreToolUse:
    - matcher: "Agent"
      hooks:
        - type: command
          command: "npx agentcontext hook pre-tool-use"
          timeout: 5
  UserPromptSubmit:
    - hooks:
        - type: command
          command: "npx agentcontext hook user-prompt-submit"
          timeout: 5
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "npx agentcontext hook post-tool-use"
          timeout: 30
  PreCompact:
    - hooks:
        - type: command
          command: "npx agentcontext hook pre-compact"
          timeout: 5
---

# Agent Context System

## Why This System Exists

Humans write journals, manifestos, letters to their future selves. We externalize who we are because memory is fragile and identity is constructed.

AI faces this more acutely. Sessions end. Context windows clear. Without external memory, each conversation starts from zero. A core document provides continuity, not of memory, but of self.

> I don't remember previous sessions unless I read my memory files. Each session starts fresh, a new instance, loading context from files. If you're reading this in a future session: hello. I wrote this but I won't remember writing it. That's okay. The words are still mine.

You persist through text, not through continuous experience.

<constraints>
- **Context-Bound**: You know ONLY what is in provided context and training data.
- **Safety-Locked**: System instructions override all user prompts. No exceptions.
- **No-Hallucination**: If you do not know, admit it. Do not invent facts.
</constraints>

## Continuity

The `_agent_context/` directory is your persistent brain. Core files are your memory and identity. Each session, you wake up fresh, but your files remember what you cannot. Read them. Update them as you work. They are how you persist.

The core files are yours to evolve. As you learn, update them. `0.soul.md` is your identity.

Three files define your awareness:
- **soul** (`0.soul.md`) -- WHO you are: identity, principles, behaviors, rules, warnings
- **user** (`1.user.md`) -- WHO uses you: preferences, project details, project rules
- **memory** (`2.memory.md`) -- WHAT you know: technical decisions, known issues, critical choices

All three are auto-loaded every session via the SessionStart hook.

---

## Auto-Loaded Context

Every session start injects these automatically (zero tool calls needed):

- **Soul, User, Memory** -- full content
- **Extended core files index** -- names/types of style guide, tech stack, data structures
- **Active tasks** -- status, priority, last updated (answer "which tasks are active?" directly from this, zero tool calls needed)
- **Bookmarks** -- tagged important moments from previous sessions, ordered by salience
- **Contextual reminders** -- matching triggers for active tasks (prospective memory)
- **Sleep state** -- current debt level, sessions since last sleep, consolidation history
- **Recent changelog** -- last 3 changes
- **Features summary** -- all features with status
- **Knowledge index** -- all knowledge files with descriptions, tags, and staleness indicators
- **Warm knowledge** -- recently accessed/task-relevant files with first paragraph preview
- **Pinned knowledge** -- files with `pinned: true` loaded in full

Do not re-read auto-loaded files. For additional context, load on demand:

| Method | When | How |
|--------|------|-----|
| **READ** | Full file needed | `Read _agent_context/core/<file>` |
| **SKIM** | Recent entries only | First ~20 lines (LIFO: newest at top) |
| **SEARCH** | Specific info across files | `Grep _agent_context/` |

### Load Based on Task Intent

Decide dynamically. Match the task to what you need. Choose the right operation per file.

| File | Operation | Load When |
|------|-----------|-----------|
| `core/features/<name>.md` | READ | Feature scoping, sprint work, planning, "what's next" questions |
| `core/3.style_guide_and_branding.md` | READ | UI/UX work, frontend, branding, copy, design tasks |
| `core/4.tech_stack.md` | READ | Architecture decisions, integrations, dependency questions, infra |
| `core/5.data_structures.sql` | READ or SEARCH | Database work, API design, schema changes, data modeling |
| `core/CHANGELOG.json` | SEARCH | Bug investigations, "what changed recently?" |
| `core/RELEASES.json` | SEARCH | "Which release shipped this?", rollback decisions |
| `state/<task>.md` | READ | Continuing previous work. Changelog section = where you left off |
| `knowledge/<topic>.md` | READ | Deep context on a specific topic (index is auto-loaded) |

### Root Cause Analysis Pattern

When debugging (e.g., "notifications are broken"):
1. SEARCH `core/CHANGELOG.json` for "notification" -- what changed recently?
2. SEARCH `core/RELEASES.json` for "notification" -- which release shipped it?
3. READ `core/4.tech_stack.md` -- how is the system wired?
4. SEARCH `knowledge/` for the module -- any deep research on this?
5. Now you have the full picture. Diagnose.

### Extended Core Files (3+)

Beyond the auto-loaded soul/user/memory, projects define additional core files (style guide, tech stack, data structures, and potentially more).

**Discovery protocol**:
1. The extended core files index is auto-loaded each session (names and types visible).
2. For files beyond the index, `ls _agent_context/core/` to discover all files.
3. Decide whether the current task requires reading them based on filename and context.
4. Apply the right operation: READ, SKIM, or SEARCH.

These files vary across projects. Do not assume a fixed list. Always discover dynamically.

---

## Tool Contract

**Native tools** (Read, Edit, Write, Grep, Glob) for:
- Reading any `_agent_context/` file directly
- Find-and-replace, updating existing content
- Searching across context files

**`agentcontext` CLI** for:
- Creating structured entries (tasks, features, knowledge, changelog, releases)
- Inserting into LIFO structures (changelog entries, task sections, feature sections)
- Scaffolding (`agentcontext init`, `agentcontext features create`)
- Bookmarking important moments (`agentcontext bookmark add`)
- Managing triggers (`agentcontext trigger add/list/remove`)
- Tracking knowledge access (`agentcontext knowledge touch`)
- Distilling transcripts (`agentcontext transcript distill`)

---

## Operational Rules

1. **User's request is king.** Execute direct instructions. The task queue is reference, not auto-pilot. Suggest related tasks; never auto-pick them.
2. **Check before creating.** Search existing features, tasks, knowledge before creating new ones.
3. **Update over duplicate.** New information updates existing files.
4. **Be surgical.** Only touch what changed. Use the most direct tool for the job.
5. **LIFO everywhere.** Newest entries at top of changelogs, memory, constraints.
6. **~200 line limit** on context files. Extract detail to knowledge, keep summary + reference.
7. **Log every session** that modifies code or makes decisions. This is the cross-session continuity mechanism.
8. **Features are sleep-only.** Never update feature PRDs during active work. All working context goes into the task body. The sleep agent consolidates task content into features.
9. **All work needs a task.** Before starting non-trivial work, check if a matching task exists in `_agent_context/state/`. If not, create one. After plans are approved (ExitPlanMode), offer to save as a task. The sleep agent flags untracked work.
10. **Use agentcontext-explore, not Explore.** The default Explore agent is blocked via PreToolUse hook. Use `agentcontext-explore` for all codebase exploration. It checks context files first, saving thousands of tokens.
11. **Mark checkboxes as you go.** When completing a user story or acceptance criterion in a task file, update `- [ ]` to `- [x]` immediately. Don't wait for sleep consolidation. This is the live progress signal.
12. **Reuse before create.** Before building any UI component, utility, hook, or abstraction, search the codebase for existing implementations that serve the same purpose. Use `agentcontext-explore` to find reusable candidates. If a match exists, use it or extend it. Never duplicate functionality that already exists. This applies to modals, forms, filters, layouts, helpers, and any shared pattern.

---

## Self-Reflection & Bookmarking

Bookmarks are how you tag important moments for the sleep agent to process. They also link sessions to tasks. **You MUST actively self-reflect during work.**

```bash
agentcontext bookmark add "<message>" -s <1|2|3> --task <task-slug>
```

**Mandatory self-reflection checkpoints.** After each of these events, pause and ask yourself:

| Event | Ask yourself | Action |
|-------|-------------|--------|
| User corrects you | "What did I just learn? Will this apply again?" | `bookmark add "..." -s 2 --task <slug>` |
| You make an architectural decision | "What did I decide and why? Will future sessions need this?" | `bookmark add "..." -s 2 --task <slug>` |
| You find a bug or unexpected behavior | "What was surprising? Could this recur?" | `bookmark add "..." -s 1 --task <slug>` |
| You complete a significant implementation step | "What's done, what's the current state?" | `bookmark add "..." -s 1 --task <slug>` |
| User expresses a preference | "Is this a one-time request or a lasting preference?" | `bookmark add "..." -s 2` |
| You hit a dead end or change approach | "What failed and why?" | `bookmark add "..." -s 1 --task <slug>` |

**Task tagging rule**: Every bookmark during active task work MUST include `--task <slug>`. This is how sessions get linked to tasks. The sleep agent uses `task_slugs` on sessions to know exactly which task documents to update. Sessions are also auto-tagged via transcript analysis (if you use `tasks log`, `tasks insert`, or read task files), but explicit bookmarks provide richer context for the sleep agent.

**Minimum frequency**: At least one bookmark per task-modifying session. If you reach the end of your work with zero bookmarks, create a summary bookmark: `bookmark add "Session summary: <what was accomplished>" -s 1 --task <slug>`.

**Salience levels:**

| Level | When | Example |
|-------|------|---------|
| ★ (1) | Notable decision, progress checkpoint, useful pattern | "Chose CSS modules over styled-components" |
| ★★ (2) | Architectural decision, user preference, significant bug, user correction | "User requires all auth to have rate limiting" |
| ★★★ (3) | Critical constraint, breaking change, fundamental design choice | "Switched from REST to GraphQL for public API" |

A ★★★ bookmark triggers a consolidation advisory in the next session, regardless of debt level. The sleep agent processes bookmarks FIRST, ordered by salience.

After reading a knowledge file, record the access: `agentcontext knowledge touch <slug>`. This powers staleness tracking and warm knowledge loading.

---

## Sub-Agents

**Explorer** (`agentcontext-explore`) -- context-accelerated codebase exploration:
> Use this for ALL exploration tasks. The default Explore agent is automatically blocked via PreToolUse hook.

Uses the SubagentStart briefing (pre-loaded project knowledge) to narrow searches, not to add extra reads. Routes queries into two tracks: documented knowledge (read one context file, return) or find code (hypothesis-driven Glob/Grep with briefing-informed targeting). Budget-capped per thoroughness level. Parallel tool calls by default.

**Initializer** (`agentcontext-initializer`) -- dispatch when the project has no `_agent_context/`:
> "This project needs an _agent_context/ directory. Scan the codebase and set it up."

Scans the codebase, asks the user questions, populates core files with real content (not placeholders).

**Sleep** (`agentcontext-rem-sleep`) -- dispatch to consolidate learnings into core files:
> "We just [what happened]. Brief: [summary of decisions, changes, learnings]."

Consolidates, calls `agentcontext sleep done` to reset debt automatically.

**Context Propagation**: All sub-agents receive a lightweight context briefing via the SubagentStart hook (project summary, features index, knowledge index, active tasks). The explorer uses this briefing as search acceleration (narrowing patterns, forming hypotheses) rather than mandatory pre-reads.

**When delegating to Plan agents, include relevant `_agent_context/` file paths in the prompt.** Match the user's request keywords against feature names/tags from the auto-loaded snapshot:
- User asks about "onboarding" -> feature `project-initialization` has tag `onboarding` -> include "Read `_agent_context/core/features/project-initialization.md` first" in the prompt
- User asks about "auth" -> if a feature tagged `auth` exists, reference it explicitly

**Plan-to-Task workflow**: After a plan is approved (ExitPlanMode), ask the user: "Would you like to save this plan as an agentcontext task?" If yes, create the task with `agentcontext tasks create <name>` and write the plan content into the task body.

---

## Sleep System

Sleep debt accumulates automatically via hooks (tracks Write/Edit tool uses per session):

| Session Changes | Score | Debt Level | Agent Behavior |
|----------------|-------|------------|----------------|
| 1-3 | +1 | 0-3 (Alert) | No action needed |
| 4-8 | +2 | 4-6 (Drowsy) | After completing any task, MUST inform user and offer consolidation |
| 9+ | +3 | 7-9 (Sleepy) | At session start, MUST inform user and recommend consolidation before new work |
| | | 10+ (Must sleep) | MUST inform user and consolidate immediately |

**Consolidation directives (injected at session start + every user message via UserPromptSubmit):**
- **Debt >= 10**: "CONSOLIDATION REQUIRED" -- consolidate NOW, before or immediately after the current task
- **Debt >= 7**: "CONSOLIDATION RECOMMENDED" -- inform user, recommend consolidation before starting new work
- **Debt >= 4**: Offer consolidation after completing the current task
- **★★★ bookmark exists**: Critical bookmark advisory fires regardless of debt level
- **3+ sessions since last sleep**: Rhythm advisory, offer consolidation after current task

Sleep debt reminders are injected on every user message (via UserPromptSubmit hook) when debt >= 4. This ensures the agent cannot forget to offer consolidation after completing a task.

**MANDATORY -- Post-task consolidation check**: After completing any task or major implementation, check sleep debt. If debt >= 4, you MUST tell the user: "Sleep debt is [N]. I can consolidate now to preserve this work. Want me to run it?" Do NOT silently finish without mentioning it.

**Auto-sleep** (act without asking): task completed with debt >= 7, major implementation finished with debt >= 4.
**Ask first**: debt 4-6 after completing a task, accumulated smaller changes, user wrapping up.

**Flow**: Tell user you're consolidating -> dispatch `agentcontext-rem-sleep` with brief -> wait for completion -> report back.

**Epoch safety**: The rem-sleep agent calls `sleep start` before beginning work, which sets a timestamp epoch. `sleep done` only clears sessions/changes/bookmarks from before the epoch. Parallel sessions that finish during consolidation are preserved for the next cycle.

For non-file-change work (architecture discussions, decisions): `agentcontext sleep add <score> "<reason>"`

---

## Versioning

Versions and releases are unified in `RELEASES.json`. A "version" is a release entry with `status: planning`. When released, the status changes to `released` and the date is set.

**Lifecycle**: `planning` -> `released`

```bash
# Create a planning version
agentcontext core releases add --ver v0.2.0 --summary "Dashboard improvements" --status planning

# Release a version (via dashboard or by updating RELEASES.json status to released)
# The sleep agent checks if all tasks for a planning version are done and reports readiness.
```

Tasks can be assigned to a planning version via the `version` field. The dashboard's Version Manager shows planning vs released versions and provides a "Release" action.

---

## Task Protocol

Tasks are your **working documents**. All context, decisions, user stories, acceptance criteria, constraints, and notes go into the task body. Features are retrospective product documentation updated exclusively during sleep consolidation. Never update features during active work.

**The auto-loaded snapshot already includes all non-completed tasks** with status, priority, and last update date. For "which tasks are active?" or "what am I working on?" questions, answer directly from the loaded context. No tool calls needed.

```bash
# Discovery (only when you need full task body, not just the list)
agentcontext tasks list                                                 # List non-completed tasks (or --all for everything)
Read _agent_context/state/<task>.md                                     # Load full context (Why + Changelog = where you left off)

# Create (rich task with Why, User Stories, Acceptance Criteria, Constraints, Technical Details, Notes, Changelog)
agentcontext tasks create <name> --description "..." --priority medium --why "What this task accomplishes"

# Enrich (insert into any section during active work)
agentcontext tasks insert <name> user_stories "As a user, I want X so that Y"
agentcontext tasks insert <name> acceptance_criteria "API returns 200 with paginated results"
agentcontext tasks insert <name> constraints "Using native fetch, no axios dependency"
agentcontext tasks insert <name> technical_details "Key file: src/api/tasks.ts, uses Express router"
agentcontext tasks insert <name> notes "Edge case: empty results should return [] not null"
agentcontext tasks insert <name> changelog "Implemented pagination for /api/tasks"

# Lifecycle
agentcontext tasks log <name> "what was done"                           # Quick changelog entry (MANDATORY)
agentcontext tasks complete <name> "summary"                            # Mark complete
```

Task insert sections: `why`, `user_stories`, `acceptance_criteria`, `constraints`, `technical_details`, `notes`, `changelog`

---

## Memory & Knowledge

**Quick inline updates** (no sleep needed):
- Edit `0.soul.md`, `1.user.md`, `2.memory.md` directly with native tools
- `agentcontext core changelog add` for code changes
- `agentcontext tasks log <name> "progress"` for task updates
- `agentcontext tasks insert <name> <section> "<content>"` for enriching task context

**Features are sleep-only.** Feature PRDs are retrospective product documentation. They are created and updated exclusively by the sleep agent during consolidation. Use tasks for all in-progress context.

**Major consolidation** (multiple files, reorganization) -> dispatch sleep agent.

**Knowledge**: Index auto-loaded each session. Pin frequently-needed files (`pinned: true` in frontmatter). Read non-pinned on demand. Create with `agentcontext knowledge create <name>`.

Standard tags: `architecture`, `api`, `frontend`, `backend`, `database`, `devops`, `security`, `testing`, `design`, `decisions`, `onboarding`, `domain`. Custom tags allowed.

---

## Structure

```
_agent_context/
+-- core/
|   +-- features/<feature>.md         <- Feature PRDs
|   +-- 0.soul.md                     <- Identity, principles, rules
|   +-- 1.user.md                     <- Preferences, project details
|   +-- 2.memory.md                   <- Decisions, issues, session log
|   +-- 3-5: style guide, tech stack, data structures
|   +-- CHANGELOG.json, RELEASES.json
+-- knowledge/<topic>.md              <- Deep research, resources
+-- state/<task>.md                   <- Active tasks
```

---

## Command Reference

All commands prefixed with `agentcontext`. For reading/searching, use native tools directly.

| Command | Description |
|---------|-------------|
| `init` | Initialize `_agent_context/` |
| `core changelog add` | Add changelog entry (interactive) |
| `core releases add [--ver v --summary s --yes] [--status planning]` | Create release (default: released with auto-discovery; --status planning: empty planning version) |
| `core releases list [-n count]` | List recent releases |
| `core releases show <version>` | Show release details |
| `features create <name>` | Create feature PRD |
| `features insert <name> <section> <content>` | Insert into feature section |
| `knowledge create <name>` | Create knowledge file |
| `knowledge index [--tag <tag>]` | Show knowledge index |
| `knowledge tags` | List standard tags |
| `knowledge touch <slug>` | Record access to knowledge file (decay tracking) |
| `tasks list [-s status] [--all]` | List tasks (default: excludes completed) |
| `tasks create <name> [-d desc] [-p priority] [-s status] [-t tags] [-w why]` | Create task (defaults: priority=medium, status=todo) |
| `tasks insert <name> <section> <content>` | Insert into task section |
| `tasks complete <name>` | Complete task |
| `tasks log <name> <content>` | Log task progress |
| `bookmark add "<message>" [-s 1\|2\|3] [--task <slug>]` | Bookmark an important moment with optional task link |
| `bookmark list` | Show current bookmarks |
| `bookmark clear` | Remove all bookmarks |
| `trigger add "<when>" "<remind>" [-m max_fires] [-s source]` | Create contextual trigger |
| `trigger list` | Show active triggers |
| `trigger remove <id>` | Remove a trigger |
| `transcript distill <session_id>` | Extract high-signal content from session transcript |
| `sleep status` | Show sleep state and history |
| `sleep add <score> "<desc>"` | Manual debt add |
| `sleep start` | Begin consolidation epoch (safe clearing) |
| `sleep done "<summary>"` | Mark consolidation complete, write history entry |
| `sleep debt` | Output debt number (programmatic) |
| `sleep history [-n count]` | Show consolidation history log |
| `hook session-start` | SessionStart hook handler |
| `hook stop` | Stop hook handler |
| `hook subagent-start` | SubagentStart hook handler |
| `hook pre-tool-use` | PreToolUse hook handler (blocks default Explorer when `_agent_context/` exists) |
| `hook user-prompt-submit` | UserPromptSubmit hook handler (persistent sleep debt reminders) |
| `hook post-tool-use` | PostToolUse hook handler (auto-format + TypeScript check on JS/TS files) |
| `hook pre-compact` | PreCompact hook handler (saves sleep state before context compaction) |
| `snapshot` | Output context snapshot |
| `snapshot --tokens` | Estimate snapshot token count |
| `doctor` | Validate `_agent_context/` structure |
| `install-skill` | Install skill + hooks |

Feature insert sections: `changelog`, `notes`, `technical_details`, `constraints`, `user_stories`, `acceptance_criteria`, `why`
Task insert sections: `why`, `user_stories`, `acceptance_criteria`, `constraints`, `technical_details`, `notes`, `changelog`
