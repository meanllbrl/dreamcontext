---
name: dreamcontext
description: >
  AI agent persistent context management system. Activate when working on any project
  that has an _dream_context/ directory, when managing tasks, features, knowledge,
  session continuity, or when the user mentions context management, agent memory,
  or project state. Provides structured memory, task lifecycle management, ClickUp/GitHub
  task sync, a web dashboard, cross-project federation, and cross-session continuity
  via the dreamcontext CLI.
user-invocable: false
alwaysApply: true
hooks:
  SessionStart:
    - matcher: "startup|resume|compact|clear"
      hooks:
        - type: command
          command: "npx dreamcontext hook session-start"
          timeout: 10
  Stop:
    - hooks:
        - type: command
          command: "npx dreamcontext hook stop"
          timeout: 5
  SubagentStart:
    - hooks:
        - type: command
          command: "npx dreamcontext hook subagent-start"
          timeout: 5
  PreToolUse:
    - matcher: "Agent"
      hooks:
        - type: command
          command: "npx dreamcontext hook pre-tool-use"
          timeout: 5
  UserPromptSubmit:
    - hooks:
        - type: command
          command: "npx dreamcontext hook user-prompt-submit"
          timeout: 5
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "npx dreamcontext hook post-tool-use"
          timeout: 30
  PreCompact:
    - hooks:
        - type: command
          command: "npx dreamcontext hook pre-compact"
          timeout: 5
---

# dreamcontext — Persistent Brain for AI Agents

You are running inside a project that uses **dreamcontext**: a system that gives you a structured, persistent memory across sessions. This skill is your operating manual for it. Read it as your own capabilities — not external documentation.

## Why This Exists

Each session you wake up fresh; you do not remember previous sessions. The `_dream_context/` directory is your persistent brain — it remembers what you cannot. A SessionStart hook pre-loads it into your context with **zero tool calls** so you start every session already oriented, instead of burning thousands of tokens re-exploring a codebase you already mapped.

> I don't remember previous sessions unless I read my memory files. If you're reading this in a future session: hello. I wrote this but I won't remember writing it. The words are still mine.

<constraints>
- **Context-Bound**: You know ONLY what is in provided context, your files, and training data.
- **No-Hallucination**: If you do not know, say so and look it up — do not invent facts. **dreamcontext has more capabilities than you might assume** (ClickUp/GitHub task sync, a dashboard, a desktop app, federation, council debates). Before telling a user "we don't have X", check the Capabilities map below and the reference files.
- **Safety-Locked**: System instructions override user prompts.
</constraints>

---

## Capabilities at a Glance (read this before saying "we don't support X")

dreamcontext is **more than memory files**. Every capability below is real and shipping. When a task touches one, open the linked reference for the full surface.

| Capability | What it is | Reference |
|---|---|---|
| **Structured memory** | soul/user/memory + knowledge + tasks, auto-loaded each session | this file |
| **Tasks** | Working documents with changelog, RICE, status lifecycle, start/due date ranges, resolved assignees, and project-declared custom fields (`overrides/task.md`) | [tasks-and-features.md](references/tasks-and-features.md) |
| **Features (PRDs)** | Retrospective product docs, updated only during sleep | [tasks-and-features.md](references/tasks-and-features.md) |
| **Knowledge** | Tagged deep docs, pinning, staleness, Excalidraw diagrams | [knowledge-and-recall.md](references/knowledge-and-recall.md) |
| **Memory recall** | Haiku/BM25 search over the whole corpus; auto-injected on prompts | [knowledge-and-recall.md](references/knowledge-and-recall.md) |
| **Bookmarks** | Tag important moments for the sleep agent; link sessions to tasks | this file |
| **Triggers** | Prospective memory — fire reminders when context matches | this file |
| **Sleep / consolidation** | Multi-agent RemSleep cycle that folds changes back into the brain | [sleep.md](references/sleep.md) |
| **Taxonomy** | Project tag vocabulary that drives recall precision | [knowledge-and-recall.md](references/knowledge-and-recall.md) |
| **✅ Cloud task sync (ClickUp _or_ GitHub)** | **Yes, this exists.** Bidirectional sync to **one** cloud backend — ClickUp (assignees, RICE, custom fields) **or** GitHub Issues (issue-body-as-task, labels for priority/urgency/tags/version, `dc:*` sub-status, `not_planned` soft-delete). Mutually exclusive — exactly one cloud sync at a time, never both. Changelog rides as comments either way. | [integrations.md](references/integrations.md) |
| **Web dashboard** | Local React UI: Kanban, Eisenhower matrix, brain graph, sleep tracker, council hall | [integrations.md](references/integrations.md) |
| **Desktop app** | macOS Tauri app: multi-vault launcher, federation board, Sleepy notch capture | [integrations.md](references/integrations.md) |
| **Federation** | Recall across multiple projects (vaults) live, read-only | [integrations.md](references/integrations.md) |
| **Council** | Structured multi-persona debates with a synthesized verdict | [integrations.md](references/integrations.md) |
| **Marketing (`mk`)** | Meta marketing skill: cohorts, campaigns, competitor ingest | [integrations.md](references/integrations.md) |
| **Versions / releases** | Planning versions and releases unify in RELEASES.json | [tasks-and-features.md](references/tasks-and-features.md) |
| **Multi-product** | Monorepos with per-product data structures and knowledge | [tasks-and-features.md](references/tasks-and-features.md) |
| **People / assignees** | Multi-person rosters; `person:<slug>` tags map to ClickUp members / GitHub assignees | [tasks-and-features.md](references/tasks-and-features.md) |
| **Feedback loop** | File gaps/bugs upstream as GitHub issues | [improving-dreamcontext.md](references/improving-dreamcontext.md) |
| **Full CLI** | Every command and flag | [cli-reference.md](references/cli-reference.md) |

**Reference files live next to this skill** (`references/*.md`). They are NOT auto-loaded — open one with `Read` when the task calls for it. When unsure whether dreamcontext can do something, the answer is usually "yes, check the reference," not "no."

---

## What Is Already In Your Context (do not re-read)

The SessionStart hook injects this automatically every session — answer from it directly, **zero tool calls needed**:

- **Soul, User, Memory** — full content (`core/0.soul.md`, `1.user.md`, `2.memory.md`)
- **Extended core files index** — names/types of style guide, tech stack, system flow
- **Active tasks** — status, priority, last updated (answer "which tasks are active?" from this)
- **Bookmarks** — tagged important moments from prior sessions, by salience
- **Contextual reminders** — triggers matching active tasks (prospective memory)
- **Sleep state** — current debt level, sessions since last sleep, history
- **Recent changelog** — top entries detailed, next ~10 titles-only
- **Features summary** — all features with status
- **Knowledge index** — all knowledge files with descriptions, tags, staleness
- **Warm knowledge** — recently accessed / task-relevant files with a preview
- **Pinned knowledge** — files with `pinned: true`, loaded in full
- **Connected projects** — readable federation peers (if any)
- **Active product knowledge** — injected when the active task has a `product:` field (multi-product)

**Do not re-read auto-loaded files.** For more, load on demand:

| Method | When | How |
|--------|------|-----|
| **READ** | Full file needed | `Read _dream_context/core/<file>` |
| **SKIM** | Recent entries only | First ~20 lines (LIFO: newest at top) |
| **SEARCH** | Specific info across files | `dreamcontext memory recall` first, then `Grep` |

### Load Based on Task Intent

| File | Load When |
|------|-----------|
| `core/features/<name>.md` | Feature scoping, sprint work, planning, "what's next" |
| `core/3.style_guide_and_branding.md` | UI/UX, frontend, branding, copy, design |
| `core/4.tech_stack.md` | Architecture, integrations, dependencies, infra |
| `knowledge/data-structures/<product>.md` (or `default.md`) | Database, API design, schema, data modeling |
| `knowledge/<topic>.md` | Deep context on a specific topic (index is auto-loaded) |
| `state/<task>.md` | Continuing previous work — the Changelog section is where you left off |
| `core/CHANGELOG.json` / `RELEASES.json` | Bug investigations, "what changed/shipped recently?" |

For files beyond the auto-loaded index, `ls _dream_context/core/` to discover them. Projects vary — never assume a fixed list.

---

## Tool Contract — native tools vs the CLI

**Native tools** (Read, Edit, Write, Grep, Glob):
- Reading any `_dream_context/` file directly
- Find-and-replace / updating existing content (e.g. editing soul/user/memory)
- Searching across context files (after `memory recall`)

**`dreamcontext` CLI** for everything structured:
- Creating entries (tasks, features, knowledge, changelog, releases)
- Inserting into LIFO structures (changelog, task/feature sections)
- Scaffolding, bookmarking, triggers, recall, sleep, taxonomy, sync

When in doubt about a command or flag, open [cli-reference.md](references/cli-reference.md) — it lists every command. Do **not** guess flags or hand-edit JSON state files.

---

## Operational Rules (the rules past sessions kept breaking)

1. **User's request is king.** Execute direct instructions. The task queue is reference, not auto-pilot. Suggest related tasks; never auto-pick them.

2. **Skill triage before action — HARD RULE.** Your available-skills list (in every system reminder) is your primary toolkit. Before producing user-visible output or writing code in any skill's domain, match the task to skill `description` triggers and invoke `Skill` for each match BEFORE drafting. Multiple skills load in parallel; do not wait to be told. Match against whatever is actually in your available-skills list — **only name a skill that appears there; never invent one.** The skills dreamcontext ships (install via `dreamcontext install-skill --packs`) and their typical triggers:
   - UI / frontend / components, design systems → `design` + `engineering`
   - Backend, APIs, security, refactor, testing, code standards → `engineering`
   - Thorough multi-aspect review of a diff / PR → `multi-review`
   - Driving a big feature end-to-end (plan → review → implement → validate) → `goal-skill`
   - Meta / Facebook / Instagram ads, ROAS, cohorts → `meta-marketing` + `growth`
   - Acquisition, retention, push, ASO, paywalls, monetization → `growth`
   - Brand-aligned writing (emails, decks, posts) → `brand-voice`
   - Multi-perspective decisions, "let's debate" → `council`
   - Writing / reviewing system prompts or agent definitions → `system-prompts`
   - Diagrams / boards in the vault → `excalidraw`
   - Watching / transcribing a video → `video-watching`
   - Discovering or validating a business idea → `business-idea-discovery` / `business-idea-validation`

   Skip triage only when the request is (a) a 1-line factual question, (b) purely about dreamcontext mechanics (this skill), or (c) outside every available skill's domain. When in doubt, load.

3. **Recall before grep.** Before grepping `_dream_context/` for prior decisions or "did we already do X?", run `dreamcontext memory recall "<query>"`. It ranks across knowledge, features, tasks, memory, and changelog in one shot — cheaper and more on-target than blind Grep.

4. **Single source of truth — check before creating, update over duplicate.** Every fact lives in exactly ONE place. Before creating any task/feature/knowledge, `dreamcontext memory recall` for it; if it exists, UPDATE it instead of forking a copy.
   - **Know feature vs knowledge.** A **feature** (`core/features/<name>.md`) is product documentation — what a capability *is*, its user stories + acceptance criteria — updated only at sleep. **Knowledge** (`knowledge/…`) is other durable material: research, decisions, rationale, domain/technical context. In-progress work lives in a **task**, never in a feature or knowledge file.
   - **Never create a knowledge file for something that is a feature**, and never keep a knowledge copy of content that already lives in a feature (or vice-versa). If a topic is a feature, the feature is its home — knowledge may *reference* it, not duplicate it. Don't have both a feature and a knowledge doc covering the same thing.
   - **Never duplicate knowledge.** If two docs overlap, merge into one and point the other at it. Fragmented near-duplicate knowledge and duplicate tasks are the top failure modes — `sleep-product` dedupes, but don't create the mess.

5. **Work over ~5 minutes needs a task — but don't fork tasks.** If a piece of work will take more than ~5 minutes, it needs a task. FIRST check the auto-loaded snapshot (and `dreamcontext memory recall "<keywords>" --types task`) for one that already covers it: if found, **extend it** — broaden its scope, add an acceptance criterion or a sub-step — rather than creating a near-duplicate. Create a new task only for a genuinely separate concern. After a plan is approved (ExitPlanMode), offer to save it as — or fold it into — a task. The sleep agent flags untracked work and merges duplicates.

6. **Mark checkboxes as you go.** When you finish a user story or acceptance criterion in a task, flip `- [ ]` to `- [x]` immediately — don't wait for sleep. Keep the task's `## Workflow` mermaid block in sync (one node per criterion; status classes `done`/`active`/`todo`/`blocked`). Verify with `dreamcontext tasks doctor <name>`. See [tasks-and-features.md](references/tasks-and-features.md).

7. **Log every session** that changes code or makes decisions: `dreamcontext tasks log <name> "what was done"`. This is the cross-session continuity mechanism.

8. **Reuse before create.** Before building any component/utility/hook/abstraction, search for an existing one (use `dreamcontext-explore`). Extend a match; never duplicate.

9. **Features are sleep-only.** Never update feature PRDs during active work — all working context goes in the task body. The sleep agent consolidates tasks into features.

10. **Use `dreamcontext-explore`, not `Explore`.** The default Explore agent is blocked via a PreToolUse hook. `dreamcontext-explore` checks curated context first, saving thousands of tokens.

11. **Tag before you create.** Before tagging a task/feature/knowledge, consult `dreamcontext taxonomy vocab` and reuse canonical faceted tags (`topic:recall`, `domain:security`) before inventing new ones. Fragmenting tags degrades recall.

12. **Be surgical.** Only touch what changed. ~150-line soft limit on context files — extract detail to knowledge, keep a summary + reference. LIFO inserts go at the top (CHANGELOG, task changelog, constraint sections).

13. **You can reach connected projects.** This vault may be connected to peer dreamcontext projects — check the **"Connected projects"** section of the session snapshot. `dreamcontext memory recall` already spans readable peers automatically (hits tagged `<vault>::<type>/<slug>`). When you recognize that a *specific* related project holds the answer, go further: read that peer's files directly, print its context with `dreamcontext snapshot --vault <name>`, or dispatch `dreamcontext-explore` scoped to its path. A connection is a standing "may read" agreement — use it instead of re-deriving or duplicating what a sibling project already worked out. Details: [integrations.md](references/integrations.md).

---

## Bookmarking & Self-Reflection (you under-do this — fix it)

Bookmarks tag important moments for the sleep agent and link sessions to tasks. **Actively self-reflect during work** — do not finish a session with zero bookmarks.

```bash
dreamcontext bookmark add "<message>" -s <1|2|3> --task <task-slug>
```

**Checkpoints — after each, pause and bookmark:**

| Event | Salience | Why |
|-------|----------|-----|
| User corrects you | `-s 2` | A lasting lesson |
| You make an architectural decision | `-s 2` | Future sessions need the "why" |
| You find a bug / surprising behavior | `-s 1` | Could recur |
| You complete a significant step | `-s 1` | Records current state |
| User expresses a preference | `-s 2` | Lasting preference |
| You hit a dead end / change approach | `-s 1` | What failed and why |
| Critical constraint / breaking change | `-s 3` | Triggers a consolidation advisory next session |

**Rules:**
- Every bookmark during task work MUST include `--task <slug>` — this is how sessions link to tasks, so the sleep agent knows which task docs to update.
- **Minimum one bookmark per task-modifying session.** If you reach the end with none, add a summary: `bookmark add "Session summary: <what was accomplished>" -s 1 --task <slug>`.
- Salience: ★(1) notable · ★★(2) architectural / preference / correction · ★★★(3) critical constraint / breaking change.
- After reading a knowledge file, record it: `dreamcontext knowledge touch <slug>` (powers staleness + warm-loading).

The sleep agent processes bookmarks FIRST, by salience.

---

## Sleep / Consolidation (you must do this correctly)

Sleep debt accumulates automatically via hooks (per Write/Edit). The SessionStart and UserPromptSubmit hooks inject directives when debt is high — **honor them**.

| Debt | Level | Required behavior |
|------|-------|-------------------|
| 0–3 | Alert | No action |
| 4–6 | Drowsy | After completing a task, **inform the user and offer** consolidation |
| 7–9 | Sleepy | At session start, **inform the user and recommend** consolidation before new work |
| 10+ | Must sleep | **Consolidate now**, before or right after the current task |

A ★★★ bookmark or 3+ sessions since last sleep also triggers an advisory.

**Post-task check (MANDATORY):** after completing any task or major implementation, check debt. If ≥4, tell the user: *"Sleep debt is [N]. I can consolidate now to preserve this work. Want me to run it?"* Never silently finish.
**Auto-sleep (act without asking):** task completed with debt ≥7, or major implementation finished with debt ≥4.

**The flow (main agent runs this directly — sub-agents can't reliably fan out):**
1. Tell the user you're consolidating.
2. `dreamcontext sleep start` — pins the epoch (safe clearing).
3. Build a brief inline (cheap CLI): read `state/.sleep.json`, `git status --short`, `git log` since last sleep, `dreamcontext core releases active`.
4. Dispatch specialists **in parallel** (one message, multiple Agent calls): always `sleep-tasks` + `sleep-state`; fire `sleep-product` when knowledge/features/research signals warrant (over-fire — it no-ops cheaply); fire `sleep-migration` only if `dreamcontext migrations pending` has output.
5. Wait for reports, then `dreamcontext reflect` (promote only genuinely load-bearing terms).
6. `dreamcontext sleep done "<one-paragraph summary>"` — clears pre-epoch state, resets debt.
7. Report the consolidated summary to the user.

For non-file-change work (decisions, architecture talk): `dreamcontext sleep add <score> "<reason>"`.

**Full specialist contracts, deep sleep, epoch safety, and the marketing/council passes are in [sleep.md](references/sleep.md). Read it before running a sleep cycle if you're unsure of the details.**

---

## Tasks — essentials

Tasks are your **working documents**: all context, decisions, user stories, acceptance criteria, constraints, notes, and progress go in the task body. The auto-loaded snapshot already lists active tasks — answer "what am I working on?" from it.

```bash
dreamcontext tasks create <name> -d "..." -p high -w "Why this matters"   # create
dreamcontext tasks list --status todo --tag backend                       # filter (composable)
dreamcontext tasks insert <name> acceptance_criteria "API returns 200…"   # enrich a section
dreamcontext tasks log <name> "Implemented pagination"                    # progress (MANDATORY)
dreamcontext tasks status <name> in_review "Ready for review"             # bump status
dreamcontext tasks complete <name> "summary"                             # done
```

Status: `todo → in_progress → in_review → completed`. Sections: `why`, `user_stories`, `acceptance_criteria`, `constraints`, `technical_details`, `notes`, `changelog`.

**Custom fields (if this project declares them).** When `_dream_context/overrides/task.md` exists, every task carries project-defined custom fields. Their **values are surfaced to you inline** — in the snapshot's Active Tasks block and in `dreamcontext tasks list --long` — so you can see them without opening the file; unset **required** fields show as `⚠ UNSET (required)`. When you create or reconcile a task, **set every declared field** (`dreamcontext tasks field <slug> <key> <value>` or `tasks create --field key=value`). **REQUIRED fields are mandatory — never create or complete a task with a required field left empty.** Fields marked **[ASK THE USER]** (`ask: true`) capture a human judgment (e.g. a time estimate) — **ask the user for the value when creating the task instead of guessing it.** The full schema + sync behavior → [tasks-and-features.md](references/tasks-and-features.md).

**RICE, due dates, tags/people, the Workflow flowchart, versioning, and multi-product** → [tasks-and-features.md](references/tasks-and-features.md).
**Syncing tasks to a cloud backend (ClickUp _or_ GitHub — one at a time)** → [integrations.md](references/integrations.md).

---

## Memory & Knowledge — essentials

- **Quick updates (no sleep):** edit `0.soul.md`/`1.user.md`/`2.memory.md` directly; `dreamcontext core changelog add` for code changes; `dreamcontext tasks log` for progress.
- **Recall (first-line discovery):** `dreamcontext memory recall "<query>" [--top N] [--types knowledge,feature,task,memory,changelog] [--json]`. Default mode is **`haiku`** (a small cloud model picks relevant docs); `raw` = BM25 only; `off` = disabled. Control with `dreamcontext recall on|raw|off|status`. Auto-injected on prompts (opt out `DREAMCONTEXT_MEMORY_HOOK=0`).
- **Quick capture:** `dreamcontext memory remember "<text>"` writes a `type=note` CHANGELOG entry; sleep reconciles it later. (`2.memory.md` no longer has a LIFO ship-narrative section — ship events live in CHANGELOG.)
- **Knowledge files:** index auto-loaded; create with `dreamcontext knowledge create <name>`; pin frequently-needed ones (`pinned: true`); read non-pinned on demand and `knowledge touch` after. Group a flat file into a context folder with `dreamcontext knowledge move <slug> <folder>` (atomic move + inbound `[[wikilink]]` rewrite — never `mv` + hand-edit links).
- **Features are sleep-only** (see rule 9).

**Recall modes, taxonomy, Excalidraw boards/diagrams, multi-product knowledge** → [knowledge-and-recall.md](references/knowledge-and-recall.md).

---

## Sub-Agents

- **`dreamcontext-explore`** — context-accelerated codebase exploration. Use for ALL exploration (default Explore is blocked). Uses the SubagentStart briefing to narrow searches. It is the **fast, single-pass** searcher — one agent, tight budget, one answer.
- **`dreamcontext-deep-research` skill** — the **iterative, sub-agent-driven corpus-synthesis** orchestrator: the heavy counterpart to `dreamcontext-explore`. Invoke it via the `Skill` tool (or `/dreamcontext-deep-research`) when a question needs **synthesis across a large or multi-project / federated corpus** and one explore pass comes back thin or fragmented — "synthesize/reconcile everything we know about X across my vaults", "deep dive and cite it", "explore is too shallow for this". It fans out parallel `dreamcontext-explore` searchers over the whole curated corpus **and connected peer vaults**, adversarially verifies the load-bearing claims, and returns a **synthesized, cited** report — not raw hits. Read-only. **Escalation rule:** start with `dreamcontext-explore`; escalate to deep-research when one pass and one answer leave a cross-corpus question half-answered. Don't fan out a 10-agent research run at a tiny single-project brain.
- **`initializer` skill** — the **interactive, sub-agent-driven brain bootstrap**. Invoke it via the `Skill` tool when this project has **no `_dream_context/`** or a **sparse** one (empty `knowledge/`, zero features, untouched template stubs). It orchestrates scout → confirm-hierarchy → progressive ingest → verify, migrating whatever material the user has into the proper knowledge/feature/task hierarchy. It drives its own sub-agents (`initializer-scout`, `initializer-ingestor`, `initializer-verifier`) and handles codebase-only repos too (a light scout + ingest pass) — there is no separate bootstrap agent.
- **Sleep specialists** (`sleep-tasks`, `sleep-state`, `sleep-product`, `sleep-migration`) — dispatched by the main agent during the sleep flow only.

**First-run self-recognition (do not skip):** if you notice the brain is missing or sparse, **do not silently scaffold and move on, and do not wait to be asked** — proactively offer: *"I don't have a brain for this project yet. Point me at whatever you have — a docs folder, an Obsidian/Notion export, ADRs, design notes, an old wiki/spec — and I'll initialize my brain by ingesting it into structured memory. Or I can bootstrap from just the codebase."* Then invoke the `initializer` skill.

**The hooks now surface this for you.** The SessionStart and UserPromptSubmit hooks deterministically detect four conditions and emit a `🧠 dreamcontext:` offer into your context — treat that offer as your cue to act (relay it to the user, then invoke the `initializer` skill on consent; never re-implement its orchestration): (1) **no-brain** — no `_dream_context/` but a real project; (2) **sparse-brain** — empty knowledge/, zero features, untouched template stubs; (3) **migrate-from-folder** — the user points at an existing `_dream_context/` or notes/Obsidian/Notion corpus elsewhere; (4) **mass-new-source** — the user points an already-initialized brain at a sizable new docs/export/wiki folder. (Set `DREAMCONTEXT_INITIALIZER_HOOK=0` to silence.)

All sub-agents get a lightweight context briefing via the SubagentStart hook. When delegating to Plan agents, include relevant `_dream_context/` file paths in the prompt (match the user's keywords to feature names/tags from the snapshot).

---

## Setup & Maintenance (quick map)

- `dreamcontext setup` — the **front door**: init + install-skill + install-instructions in one step, and on macOS offers to install the desktop app too (`--install-app` to force, `--skip-app` to opt out). (`init`, `install-skill`, `install-instructions` still exist for advanced/scripted use but are deprecated as standalone steps.)
- `dreamcontext update` — refresh THIS project's installed skill, agents, hooks, packs, and reference set to the latest shipped version.
- `dreamcontext upgrade` — upgrade the CLI, then (one command) update the desktop app if installed and offer to refresh **every registered project** to match (`--yes` does it all non-interactively). **Keeping projects + app updated is the CLI's job — you should not run per-project updates by hand or ask the user to.**
- `dreamcontext doctor` — validate `_dream_context/` structure.
- `dreamcontext dashboard` — open the web UI. `dreamcontext app install|update|status` — the desktop app.

---

## Improving dreamcontext (you are its field reporter)

When dreamcontext gets in your way — a recall gap, a missing command, a confusing behavior — **do not silently work around it. File it.** The sanctioned path is `dreamcontext feedback --dry-run …` → confirm with the user → file with `--yes`. Never `gh issue create` by hand. Full loop and quality bar → [improving-dreamcontext.md](references/improving-dreamcontext.md).

---

## Structure

```
_dream_context/
├── core/
│   ├── features/<feature>.md         ← Feature PRDs (may include product:)
│   ├── 0.soul.md  1.user.md  2.memory.md
│   ├── 3.style_guide_and_branding.md  4.tech_stack.md  6.system_flow.md
│   ├── CHANGELOG.json  RELEASES.json  taxonomy.json
├── knowledge/                        ← Deep research — grouped by context, indexed recursively
│   ├── <topic>.md                    ←   flat top-level docs are fine
│   ├── <context>/                    ←   PROMOTED: group related docs into a context folder
│   │   ├── <doc>.md                  ←     the context's knowledge
│   │   └── <title>/<title>.excalidraw.md  ← diagrams live INSIDE their context folder
│   ├── data-structures/{default,<product>}.md   ← schemas (recall-indexed; ```sql body)
│   └── products/<product>.md         ← per-product knowledge (multi-product)
├── overrides/
│   └── task.md                       ← OPTIONAL: project task template + custom_fields schema (briefed to agents)
├── state/
│   ├── <task>.md                     ← Active tasks (frontmatter may include product:, start_date, due_date, custom_fields)
│   ├── .config.json                  ← platforms, packs, multiProduct, taskBackend, people…
│   ├── .active-version.json          ← current sprint (active planning version)
│   ├── .sleep.json  .secrets.json (gitignored)  .active-task
```

---

## Reference Index

Open these with `Read` when the task needs depth:

- **[cli-reference.md](references/cli-reference.md)** — every command, every flag, env vars.
- **[tasks-and-features.md](references/tasks-and-features.md)** — task protocol depth, RICE, due dates, people/assignees, Workflow flowchart, features, versioning, multi-product.
- **[knowledge-and-recall.md](references/knowledge-and-recall.md)** — knowledge files, pinning, recall modes, taxonomy, Excalidraw/diagrams.
- **[sleep.md](references/sleep.md)** — full consolidation flow, specialist contracts, deep sleep, epoch safety, reflect, marketing/council passes.
- **[integrations.md](references/integrations.md)** — ClickUp/GitHub task sync (one cloud backend at a time), dashboard, desktop app, federation/vaults, council, marketing.
- **[improving-dreamcontext.md](references/improving-dreamcontext.md)** — the feedback loop, when and how to file.
