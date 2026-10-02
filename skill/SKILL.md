---
name: dreamcontext
description: >
  AI agent persistent context management system. Activate when working on any project
  that has an _dream_context/ directory, when managing tasks, features, knowledge,
  insights (Lab analytics metrics), roadmap objectives/OKRs, automations (scheduled,
  unattended recurring jobs), triggers, session continuity, or when the user mentions
  context management, agent memory, or project state — the words insight, objective,
  task, feature, knowledge, automation, trigger name dreamcontext entities in any
  language. Also activate when work should repeat on a schedule with nobody asking
  ("every morning", "her gün", "run this daily", a recurring digest/report/check): that
  is an automation here, never a hand-rolled cron/launchd job or external scheduler.
  Provides structured memory, task lifecycle management, scheduled automations and
  context triggers, analytics insight syncing, ClickUp/GitHub task sync, a web
  dashboard, cross-project federation, and cross-session continuity via the
  dreamcontext CLI.
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

Each session you wake up fresh; you do not remember previous sessions. The `_dream_context/` directory is your persistent brain. A SessionStart hook pre-loads it into your context with **zero tool calls** so you start every session already oriented, instead of re-exploring a codebase you already mapped.

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
| **Structured memory** | soul + the active person's constitution + memory + knowledge + tasks, auto-loaded each session | this file |
| **Tasks** | Working documents: changelog, RICE, status lifecycle, dates, assignees, project-declared custom fields | [tasks-and-features.md](references/tasks-and-features.md) |
| **Roadmap / Objectives** | PO-authored OKR board in `core/objectives/`: many-to-many task links, dependency DAG, forecast and slip detection (`dreamcontext roadmap`) | [tasks-and-features.md](references/tasks-and-features.md) |
| **Lab / Insights** | Curated analytics **metrics** synced from HTTP APIs or scripts into `lab/insights/`, cached every session, bindable to a Key Result. **Funnel analytics** (`--render funnel`) and multi-page app insights (`--render app`) included. **Boards (Beta)** compose them: `lab/boards/<slug>.md`, a 12-column grid of cards built from the block catalog (`lab block list`) plus saved HTML blocks (`lab/blocks/`). **An insight is NOT a knowledge file**: create with `dreamcontext lab create`, never `knowledge create` | [tasks-and-features.md](references/tasks-and-features.md) |
| **Features (PRDs)** | Retrospective product docs, updated only during sleep | [tasks-and-features.md](references/tasks-and-features.md) |
| **Knowledge** | Tagged deep docs, pinning, staleness, Excalidraw diagrams | [knowledge-and-recall.md](references/knowledge-and-recall.md) |
| **Memory recall** | Haiku/BM25 search over the whole corpus; auto-injected on prompts | [knowledge-and-recall.md](references/knowledge-and-recall.md) |
| **Bookmarks** | Tag important moments for the sleep agent; link sessions to tasks | this file |
| **Triggers** | Prospective memory — fire reminders when context matches | this file |
| **Whiteboard** | live boards (`dreamcontext whiteboard`), default Control Panel | [whiteboards.md](references/whiteboards.md) |
| **Automations** | Scheduled headless `claude` jobs with a dated output and a learned pattern. A `## Flow` graph draws the orchestration; a run that must ask hands over a **question** (chat, CLI or a **per-automation** Telegram bot). Replying in a thread or `@`-mentioning an agent resumes its bound session (`agent-thread` card in Chat). A usage-limited run publishes **nothing**. Disabled until approved on this machine; private until `automations share <slug>` | [automations.md](references/automations.md) |
| **Sleep / consolidation** | Multi-agent RemSleep cycle that folds changes back into the brain | [sleep.md](references/sleep.md) |
| **Taxonomy** | Project tag vocabulary that drives recall precision | [knowledge-and-recall.md](references/knowledge-and-recall.md) |
| **✅ Cloud task sync (ClickUp _or_ GitHub)** | **Yes, this exists.** Bidirectional sync to **one** backend at a time, never both. | [integrations.md](references/integrations.md) |
| **Duplicate task family repair** | `dreamcontext tasks dedup [--dry-run] [--yes]` merges `state/<slug>-2/-3/-4.md` duplicates. Local-only; `--dry-run` first. | [troubleshooting.md](references/troubleshooting.md#duplicate-tasks--the-same-task-appears-24-in-tasks-list) |
| **Troubleshooting** | Symptom, cause and fix for broken-brain states (sync refusals, a stuck brain sync, structure or version drift) | [troubleshooting.md](references/troubleshooting.md) |
| **Web dashboard** | Local React UI: Kanban, brain graph, sleep tracker, council hall, an in-app Claude Code agent and the **Chat view BETA**. **Chat view only**: `dream-view`/`dream-actions` reach the agent through a surface briefing appended to a Chat spawn alone; anywhere else the fence renders as raw JSON | [integrations.md](references/integrations.md) |
| **Chat modes (Basic / Plan / Develop / Train Me)** | **Chat view only.** A per-session system-prompt append: **Basic** (plain Claude Code), **Plan** (goal-skill's planning half, ends in a task), **Develop** (its implementing half), **Train Me** (ALPHA: learns the owner's taste, writes a pattern). The dreamcontext **Assistant** has its own mode in the notch, never in the picker | [integrations.md](references/integrations.md) |
| **Desktop app** | macOS app: multi-vault launcher, federation board, the dreamcontext Assistant (notch, hotkey, voice) | [integrations.md](references/integrations.md) |
| **Notifications (`dreamcontext://`)** | A clicked banner opens the place it is about; `dreamcontext notify` posts one | [cli-reference.md](references/cli-reference.md#notifications) |
| **Federation** | Recall across multiple projects (vaults) live, read-only | [integrations.md](references/integrations.md) |
| **Peer mail (ask another project)** | Connected projects can be **ASKED**, not just read: `dreamcontext peer ask <vault> "<q>"` wakes that project's own agent; `peer send` hands over a note or work. **Ask vs recall**: recall returns what a peer WROTE DOWN; ask returns an answer REASONED from its code, so reach for ask when recall came back empty and the peer would still know | [integrations.md](references/integrations.md) |
| **✅ Team brain sync (whole project)** | **Yes: a team, or one person across machines, can share ONE brain** via the project's GitHub `origin`, synced at `sleep done`; `/dream-sync` resolves prose conflicts. | [brain-sync.md](references/brain-sync.md) |
| **Linked repos** | One brain governs **bare code repos** (`dreamcontext link add\|clone\|ls\|rm`): a **pointer to code, not a sync**. | [cli-reference.md](references/cli-reference.md) |
| **Council** | Structured multi-persona debates with a synthesized verdict | [integrations.md](references/integrations.md) |
| **Marketing (`mk`)** | Meta marketing skill: cohorts, campaigns, competitor ingest | [integrations.md](references/integrations.md) |
| **Versions / releases** | Planning versions and releases unify in RELEASES.json | [tasks-and-features.md](references/tasks-and-features.md) |
| **Proactive learning (Hypotheses)** | Falsifiable **theses** validated/invalidated across sleep cycles, confidence derived from an evidence ledger. Opt-in: off until `dreamcontext theses enable` | [learning.md](references/learning.md) |
| **Multi-product** | Monorepos with per-product data structures and knowledge | [tasks-and-features.md](references/tasks-and-features.md) |
| **People (constitutions + roster)** | One constitution per person (`people/<slug>.md`), a roster (`people/people.json`), `person:<slug>` assignee tags | [tasks-and-features.md](references/tasks-and-features.md) |
| **Feedback loop** | File gaps/bugs upstream as GitHub issues | [improving-dreamcontext.md](references/improving-dreamcontext.md) |
| **Full CLI** | Every command and flag | [cli-reference.md](references/cli-reference.md) |

**Reference files live next to this skill** (`references/*.md`), NOT auto-loaded: `Read` one when the task calls for it. Unsure whether dreamcontext can do something? Usually "yes, check the reference".

---

## Entity Router — create the RIGHT thing (past sessions got this wrong)

dreamcontext has **fourteen distinct entity types**, each with ONE home and ONE creation path. When the user says "create/add/track X", route by what X **is** — never by the nearest command you happen to remember. The canonical mistake: user says *"create an insight"* and the agent runs `knowledge create`. An insight is not knowledge.

Two routing rules that override surface reading:

- **Entity nouns are reserved words — in ANY language.** In a dreamcontext project, *insight, objective, roadmap, thesis, task, feature, knowledge, pattern, bookmark, trigger, automation, release, person* name THESE entities, not their dictionary meanings — whatever language the sentence around them is in ("insight oluşturalım", "crea un insight" → `lab create`, not a prose analysis or an external dashboard). The trigger phrases below are English examples; match the **intent**, not the exact words.
- **Route by problem-shape too, not only by verbs.** Users often describe the need without naming the entity. If the described capability matches a subsystem's shape (see litmus tests + the "don't rebuild" rule below), that subsystem IS the answer.

| User says… | Entity | What it IS | Create with |
|---|---|---|---|
| "create an insight", "track MRR", "funnel analizi", "which funnel is underperforming", "let the script build its own UI, don't write me a component", **or the problem-shape:** "a number that refreshes itself from an API" | **Insight** — `lab/insights/<slug>.md` | A **metric backed by an external source** that re-syncs (manifest, cache, TTL, optional KR binding). **Funnel analysis is an insight too** (`--render funnel`); a multi-page view is `--render app`. Never hand-build a dashboard for it | `dreamcontext lab create <slug> --title "…"` (offer-and-confirm protocol → [tasks-and-features.md](references/tasks-and-features.md)) |
| "put these insights on one page", "an insights board / dashboard for growth", "günlük ürün panosu", "show MRR as a big number next to the signups line", **or the problem-shape:** "one composed view over metrics we already track" | **Board** — `lab/boards/<slug>.md` | A **composed page over EXISTING insights**: cards of catalog blocks (`stat`, `line`, `table`, `funnel`, `breakdown`, `benchmark`, `html`, …) bound to insight caches; owns no data, never fetches. Not a whiteboard (that is an editable canvas) | `dreamcontext lab board create <slug>` + `lab board add-card` (contract → [tasks-and-features.md](references/tasks-and-features.md)) |
| "add an objective / goal / OKR", "put it on the roadmap", "we want X by Q4" | **Objective** — `core/objectives/<slug>.md` | A PO-authored **outcome** with target date, dependency DAG, optional Key-Result metric | `dreamcontext roadmap objective create` (ASK first — objectives are PO-owned) |
| "I have a thesis: X improves Y", "track this hypothesis" | **Thesis** — `theses/<slug>.md` | A falsifiable OPTIMIZATION claim; confidence is DERIVED, never asserted | `dreamcontext theses create "<claim>"` (quality bar and offer-and-confirm first; layer off → offer `theses enable`, never capture silently → [learning.md](references/learning.md)) |
| "document this", "write up the research / decision / how X works" | **Knowledge** — `knowledge/…` | Durable **prose**: research, decisions, rationale, domain context. It doesn't refresh itself and it isn't work to do | `dreamcontext knowledge create <name>` |
| "the X feature", what a shipped capability is | **Feature PRD** — `knowledge/features/` | Retrospective **product doc** (user stories + acceptance criteria) | Sleep agent ONLY — never during active work |
| any work over ~5 minutes, "let's build / fix X" | **Task** — `state/<slug>.md` | A **working document** with lifecycle, changelog, criteria | `dreamcontext tasks create` (check for an existing one first) |
| a moment worth remembering, a correction, a decision made | **Bookmark** | A salience-tagged marker for the sleep agent | `dreamcontext bookmark add "…" -s N --task <slug>` |
| "we solve this class of problem THIS way", **or the problem-shape:** the same approach worked twice | **Pattern** — `knowledge/patterns/<slug>.md` | A portable solution shape, written awake; the prompt hook injects every pattern your message names. **When the user contradicts or extends an injected pattern, UPDATE that pattern file before finishing the task.** Adding a FEATURE? `knowledge/patterns/feature-integration-pattern.md` is MANDATORY | plain knowledge file under `knowledge/patterns/` (offer-and-confirm when agent-initiated) |
| "remind me when / next time X comes up" | **Trigger** | Prospective memory — fires when context matches | `dreamcontext trigger add <when> <remind>` |
| "every evening at 6pm, summarize today", "her akşam / her cuma / her gün", **or the problem-shape:** "it happens on its own while nobody is at the keyboard" | **Automation**: `automations/<slug>.md` | A schedule plus a prose prompt, run unattended. **Private to this machine by default** (say so; `automations share <slug>` shares it) | `dreamcontext automations create <slug> --title "…" --days <daily\|mon,wed> --at HH:MM` (capture protocol → [automations.md](references/automations.md)) |
| "board / whiteboard / control panel / pano" | **Whiteboard**: `whiteboards/<slug>/` | An editable widget canvas; not a knowledge `.excalidraw.md`, not a Tasks board view | `dreamcontext whiteboard create "<name>"` |
| "version / release / sprint / milestone" | **Release entry** — `RELEASES.json` | A planning version or shipped release | `dreamcontext core releases add` |
| "add a teammate", "who am I", "kim çalışıyor" | **Person** — `people/<slug>.md` (constitution) + a row in `people/people.json` (roster) | A **human who works in this vault**; the constitution renders verbatim when they are ACTIVE on this machine. **Not knowledge** | `dreamcontext people add "<Name>" --email <address>`; `dreamcontext people whoami [--set <slug>]` binds THIS machine |

**Litmus tests when unsure:**
- Is it a **number/series that updates from a source**? → insight (`lab`).
- Is it a **chart of data you already have, for THIS answer only**? → not an entity; it belongs to the surface. **SURFACE-GATED: emit a `dream-view` only when your system prompt carries a briefing that names it** (Chat view only); otherwise state the numbers in prose. The split from an insight is whether it must re-fetch later (→ [integrations.md](references/integrations.md)).
- Is it a **composed page over metrics you ALREADY track**? → board (`lab board create` + `lab board add-card`), not a new insight and not a hand-built dashboard.
- Is it an **outcome with a committed date**? → objective (`roadmap`).
- Is it **prose you write once and maintain**? → knowledge.
- Is it **work to do**? → task.
- Is it a **falsifiable claim actively being proven/disproven**? → thesis (not knowledge).
- Is it **work that should run on a schedule with nobody asking**? → automation (`automations`), never a hand-rolled cron job or external scheduler.
- Is it a **human who works in this vault**? → person (`dreamcontext people add`), never a knowledge file about a teammate and never a `## People` block inside a core file.
- **Duplicate task families / `-N` mirrors, or `tasks list` shows the same task 2–4×**? → repair, don't recreate: `dreamcontext tasks dedup` (never hand-delete the extra files or hand-edit `.tasks-map.json`).

**The router governs READING too, not only creating.** A metric question (*"What's our MRR?"*, *"kaç aktif öğretmen var?"*) routes to the insight that already measures it, before any external call: the ladder is Operational Rule 13.

**Don't rebuild what the brain already has.** Before scaffolding a new app, script, page or service, check: a self-refreshing metric → **Lab insight**; OKRs → **roadmap objectives**; "remind me when…" → **triggers**; a recurring job that must run unattended on a schedule → **automations** (never an external cron/Zapier-style scheduler); board views → the **dashboard**. Build outside only when none fits.

If the requested entity type is ambiguous ("track this" could be insight, objective, or trigger), **ask one clarifying question instead of guessing** — creating the wrong entity pollutes the brain and the user has to notice and undo it.

---

## What Is Already In Your Context (do not re-read)

The SessionStart hook injects this automatically every session — answer from it directly, **zero tool calls needed**:

- **Soul, Person, Memory** — full content (`core/0.soul.md`, `people/<slug>.md` for whoever is at THIS keyboard, `core/2.memory.md`). The person block renders under `## Person (Active — <Name>, \`person:<slug>\`)`; when this machine cannot be identified it renders `## Person (Active — UNRESOLVED)` and **no constitution at all** — somebody else's preferences are never substituted
- **Other People (this vault)**: the rest of the roster, on multi-person vaults only
- **Extended core index, active tasks, bookmarks, contextual reminders, recent changelog, connected projects**
- **Objectives**: progress, forecast and slip flags. **Weigh decisions against these outcomes**
- **Lab insights**: each metric's latest value and staleness (Rule 13)
- **Automations**: always one line; on an empty vault `none yet` plus the create command, which answers "can we make this run on a schedule?"
- **Sleep**: a `Sleep - Pending Analysis` section when sessions await scoring; consolidation asks arrive as hook directives
- **Features**: name, status and path
- **Knowledge index**: pinned files (📌, with path) and every pattern by name; other knowledge is counted, not listed (`dreamcontext knowledge index` or `memory recall`). Pinned bodies are NOT inlined: Read the file when the pin applies

**On a mature brain this shrinks, never blindly.** Past the harness's 20,000-char limit, sections demote cheapest-loss first; every file path stays and `Read` or `memory recall` recovers the full text. `core/0.soul.md` and the active `people/<slug>.md` always render verbatim. If it still cannot fit, a **`⚠️ CONTEXT IS INCOMPLETE`** banner under the H1 names the fix: act on it before assuming an empty brain. Full ladder → [cli-reference.md](references/cli-reference.md).

**Do not re-read auto-loaded files.** For more, load on demand:

| Method | When | How |
|--------|------|-----|
| **READ** | Full file needed | `Read _dream_context/core/<file>` |
| **SKIM** | Recent entries only | First ~20 lines (LIFO: newest at top) |
| **SEARCH** | Specific info across files | `dreamcontext memory recall` first, then `Grep` |
| **HISTORY** | "What happened, in order?" | `dreamcontext changelog list --page <n>` |

### Load Based on Task Intent

Feature work → `knowledge/features/<name>.md`; UI, copy, design → `core/3.style_guide_and_branding.md`; architecture, infra → `core/4.tech_stack.md`; schemas → `knowledge/data-structures/<product>.md`; continuing work → `state/<task>.md` (its Changelog is where you left off); "what shipped?" → `core/CHANGELOG.json` / `RELEASES.json`. Projects vary: `ls _dream_context/core/`, never assume a fixed list.

---

## Tool Contract — native tools vs the CLI

**Native tools** (Read, Edit, Write, Grep, Glob):
- Reading any `_dream_context/` file directly
- Find-and-replace / updating existing content (e.g. editing the soul, a person's constitution, memory)
- Searching across context files (after `memory recall`)

**`dreamcontext` CLI** for everything structured:
- Creating entries (tasks, features, knowledge, changelog, releases)
- Inserting into LIFO structures (changelog, task/feature sections)
- Scaffolding, bookmarking, triggers, recall, sleep, taxonomy, sync

**PDFs: classify before you Read** (→ [knowledge-and-recall.md](references/knowledge-and-recall.md) § Reading PDFs).

When in doubt about a command or flag, open [cli-reference.md](references/cli-reference.md) — it lists every command. Do **not** guess flags or hand-edit JSON state files.

---

## Operational Rules (the rules past sessions kept breaking)

1. **User's request is king.** Execute direct instructions. The task queue is reference, not auto-pilot. Suggest related tasks; never auto-pick them.

2. **Skill triage before action — HARD RULE.** Your available-skills list (in every system reminder) is your primary toolkit. Before producing user-visible output or writing code in any skill's domain, match the task to skill `description` triggers and invoke `Skill` for each match BEFORE drafting. Multiple skills load in parallel; do not wait to be told. Match against whatever is actually in your available-skills list — **only name a skill that appears there; never invent one.** The skills dreamcontext ships (install via `dreamcontext install-skill --packs`) and their typical triggers:
   UI/frontend → `design` + `engineering`; backend, security, testing → `engineering`; a multi-aspect diff review → `multi-review`; a big feature end-to-end → `goal-skill`; Meta ads → `meta-marketing` + `growth`; retention, ASO, paywalls → `growth`; brand writing → `brand-voice`; "let's debate" → `council`; system prompts or agent definitions → `system-prompts`; vault diagrams → `excalidraw`; a video → `video-watching`; browser validation of a screen or funnel → `jev-verify`; business ideas → `business-idea-discovery` / `business-idea-validation`.

   Skip triage only when the request is (a) a 1-line factual question, (b) purely about dreamcontext mechanics (this skill), or (c) outside every available skill's domain. When in doubt, load.

3. **Recall before grep.** Before grepping `_dream_context/` for prior decisions or "did we already do X?", run `dreamcontext memory recall "<query>"`. It ranks across **all nine channels** in one shot, knowledge, features, tasks, memory, changelog, **objectives, insights, theses (hypotheses), and automations**. Narrow with `--types <csv>` or by importance with `--level 2|3`.

4. **Single source of truth — check before creating, update over duplicate.** Every fact lives in exactly ONE place. Before creating any task/feature/knowledge, `dreamcontext memory recall` for it; if it exists, UPDATE it instead of forking a copy.
   - **Feature vs knowledge.** A **feature** (`knowledge/features/<name>.md`, `type: feature`) is product documentation, updated only at sleep; **knowledge** is research, decisions, rationale, domain context. In-progress work lives in a **task**. Never keep a feature and a knowledge doc on the same topic; knowledge may *reference* a feature, not duplicate it.
   - **Never duplicate knowledge.** If two docs overlap, merge into one and point the other at it. Fragmented near-duplicate knowledge and duplicate tasks are the top failure modes.

5. **Work over ~5 minutes needs a task — but don't fork tasks.** FIRST check the snapshot (and `memory recall "<keywords>" --types task`) for one that covers it and **extend it** (scope, a criterion, a sub-step); create a new task only for a genuinely separate concern. After a plan is approved, offer to save it as, or fold it into, a task.
   **When the user drops, cancels or says no to work that has NO task yet, record it:** `dreamcontext tasks decline "<topic>" --reason "<why not>"`, or the next sleep may file it as a task.

6. **Mark checkboxes as you go.** When you finish a user story or acceptance criterion, flip `- [ ]` to `- [x]` with Edit immediately, not at sleep, and keep the `## Workflow` mermaid block in sync. Verify with `dreamcontext tasks doctor <name>`.

7. **Log every session** that changes code or makes decisions: `dreamcontext tasks log <name> "what was done"`. This is the cross-session continuity mechanism.

8. **Reuse before create.** Before building any component/utility/hook/abstraction, search for an existing one (use `dreamcontext-explore`). Extend a match; never duplicate.

9. **Features are sleep-only.** Never update feature PRDs during active work — all working context goes in the task body. The sleep agent consolidates tasks into features.

10. **Use `dreamcontext-explore`, not `Explore`.** The default Explore agent is blocked via a PreToolUse hook. `dreamcontext-explore` checks curated context first, saving thousands of tokens.

11. **Tag before you create.** Before tagging a task/feature/knowledge, consult `dreamcontext taxonomy vocab` and reuse canonical faceted tags (`topic:recall`, `domain:security`) before inventing new ones. Fragmenting tags degrades recall. Heal accumulated drift with `dreamcontext taxonomy audit --fix` (`--dry-run` to preview).

12. **Be surgical.** Only touch what changed. Core files carry two anti-bloat ceilings: ~150 lines **and ~4,000 characters** (`CORE_FILE_CHAR_CEILING`); the character one binds, because the snapshot pays it every session, so measure bytes, not lines. `dreamcontext doctor` reports both. Over either ceiling: extract detail to knowledge, keep a summary + reference. LIFO inserts go at the top (CHANGELOG, task changelog, constraint sections).

13. **Insights before external fetch — the READ path, not just the create path.** When the user asks for a metric (MRR, WAU, signups, churn, revenue, conversion, "kaç aktif kullanıcı var?"), the answer comes from the brain FIRST, in this order: the snapshot's **Lab** section (latest value + staleness, zero tool calls) → `dreamcontext lab show <slug>` (**the full cached series, never fetches**) → `dreamcontext lab list` / `memory recall "<phrase>" --types insight`. Only when TTL-stale: `dreamcontext lab sync <slug>`. **An MCP tool, a raw API request, or a hand-written script is the LAST resort**: and when you take it, say why the insight didn't cover it. **The hook tells you when this applies**: a recall hit of type `insight` arrives with `→ ALREADY TRACKED as an insight` and the exact `lab show` call; that line is authoritative. App insight bodies and peer insights → [tasks-and-features.md](references/tasks-and-features.md) § Lab insights.

14. **You can reach connected projects.** Check the snapshot's **"Connected projects"**. Recall already spans readable peers; when one peer holds the answer, read its files, `dreamcontext snapshot --vault <name>`, or dispatch `dreamcontext-explore` at its path. Details: [integrations.md](references/integrations.md).

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
| User drops a planned piece of work (no task exists) | — | Not a bookmark: `dreamcontext tasks decline "<topic>" --reason "<why not>"`, so sleep cannot re-file it |

**Rules:**
- Every bookmark during task work MUST include `--task <slug>` (find it with `tasks list` first; fix a missed one with `bookmark relink <id> --task <slug>`).
- **Minimum one bookmark per task-modifying session**, if only a `Session summary: …` one.
- After reading a knowledge file, record it: `dreamcontext knowledge touch <slug>` (powers staleness + warm-loading).

The sleep agent processes bookmarks FIRST, by salience.

---

## Sleep / Consolidation (you must do this correctly)

Sleep debt accumulates automatically via hooks. Each finished session scores **0–10** (weighted sum of novel tokens, file changes, tool calls and substance: an idle or question-only session scores 0, a heavy multi-agent session approaches 10). The SessionStart and UserPromptSubmit hooks inject directives when debt is high: **honor them**.

| Debt | Level | Required behavior |
|------|-------|-------------------|
| 0–23 | Alert | No action |
| 24–39 | Drowsy | After completing a task, **inform the user and offer** consolidation |
| 40–59 | Sleepy | At session start, **inform the user and recommend** consolidation before new work |
| 60–89 | Must sleep | **Consolidate** before new work, or right after the current task. Header `>>> CONSOLIDATION REQUIRED <<<` |
| 90–119 | Must sleep, deep | Consolidate before new work; `sleep start` normally picks a deep cycle. Header `>>> CONSOLIDATION REQUIRED: DEEP CYCLE <<<` |
| 120+ | Overdue | Stop and consolidate now; this overrides the cooldown. Header `>>> CONSOLIDATION REQUIRED: OVERDUE <<<` |

These are the defaults: the deep and overdue edges follow the configured Must Sleep (×1.5 and ×2). A ★★★ bookmark or 12+ sessions since last sleep also triggers an advisory.

**Spawned sessions carry no debt.** Sessions dreamcontext or an orchestrator spawns (Develop and registered goal-skill builders, automation runs, background sleep, peer and lab runs, `claude -p` run synchronously under a session) are recorded with a `spawn` marker, add no debt, get no auto-bookmarks and receive no sleep directive. Their work still reaches sleep through their `task_slugs`, the task log and git.

**Cooldown:** hooks stop asking for 3 hours after a consolidation; a ★★★ bookmark, debt ≥120 or a user asking overrides it.

**Post-task check (MANDATORY):** after completing any task or major implementation, check debt. If ≥24 and no cooldown is active, tell the user: *"Sleep debt is [N]. I can consolidate now to preserve this work. Want me to run it?"* Never silently finish.
**Auto-sleep (act without asking):** task completed with debt ≥60. Otherwise ask.

**Sub-agent dispatch is REQUESTED, not optional.** A user asking for a sleep *is* the user requesting the specialist sub-agents: a standing "don't call the Agent tool unless requested" instruction is **already satisfied** for this flow. Each specialist owns a **disjoint file domain**; inline passes break that and blow the context budget. Never decide the cycle is "small enough" to inline; size is not the criterion (full argument → [sleep.md](references/sleep.md)).

**The flow (the top-level session orchestrates; a sub-agent can't reliably fan out further):**
1. Tell the user you're consolidating.
2. `dreamcontext sleep start` — pins the epoch (safe clearing).
3. Build a brief inline (cheap CLI): read `state/.sleep.json`, `git status --short`, `git log` since last sleep, `dreamcontext core releases active`.
4. Dispatch specialists **in parallel** (one message, multiple Agent calls; never inline, never sequential): sleep-tasks + sleep-state always; sleep-product, sleep-migration and sleep-learn only when their signals fire (sleep-product: knowledge/feature/research signals; sleep-migration: `dreamcontext migrations pending` has output; sleep-learn: learning is enabled and a thesis is due). Over-fire sleep-product when unsure: it no-ops cheaply.
5. Wait for reports, then `dreamcontext reflect` (promote only genuinely load-bearing terms).
6. If `core/objectives/` is non-empty, run `dreamcontext roadmap` and surface any 🔴 SLIPPING objectives.
7. `dreamcontext sleep done "<one-paragraph summary>"` — clears pre-epoch state, resets debt.
8. Report the consolidated summary to the user.

For non-file-change work (decisions, architecture talk): `dreamcontext sleep add <score> "<reason>"`.

**Specialist contracts, deep sleep and epoch safety → [sleep.md](references/sleep.md).**

---

## Tasks — essentials

Tasks are your **working documents**: all context, decisions, user stories, acceptance criteria, constraints, notes, and progress go in the task body. The auto-loaded snapshot already lists active tasks — answer "what am I working on?" from it.

**Naming: a task name is a short plain sentence saying what the task does** ("Fix the login redirect loop"), never a type-prefixed slug; the slug derives from the name. **`-w/--why` is mandatory.** Tasks scaffold lean (`## Why` and `## Changelog`); a section appears on first `tasks insert`. Never insert placeholder content.

```bash
dreamcontext tasks create "Readable sentence name" -d "..." -p high -w "Why this matters"   # create (-w REQUIRED)
dreamcontext tasks list --status todo --tag backend                       # filter (composable)
dreamcontext tasks insert <name> acceptance_criteria "API returns 200…"   # enrich a section
dreamcontext tasks log <name> "Implemented pagination"                    # progress (MANDATORY)
dreamcontext tasks status <name> in_review "Ready for review"             # bump status
dreamcontext tasks complete <name> "summary"                             # done
```

Status: `todo → in_progress → in_review → completed` by default. A project may **declare more** in `overrides/task.md` (`dreamcontext tasks statuses` lists them). When a **cancelled-kind** status exists, abandoned or superseded work goes THERE, not to `in_review "confirm close"`.

**Custom fields.** When `overrides/task.md` declares them, **set every declared field** when you create or reconcile a task (`dreamcontext tasks field <slug> <key> <value>` or `tasks create --field key=value`). **REQUIRED fields are mandatory**, and **[ASK THE USER]** fields are asked, never guessed. Values show inline in the snapshot and `tasks list --long` → [tasks-and-features.md](references/tasks-and-features.md).

**Objectives.** When the project has objectives, propose `objectives: [slug-a, slug-b]` links for tasks you create (`tasks create --objectives a,b` or `dreamcontext tasks objectives <task> a,b`); **never overwrite a non-empty `objectives:` list**, it is a PO decision → [tasks-and-features.md](references/tasks-and-features.md).

**RICE, due dates, tags/people, the Workflow flowchart, versioning, and multi-product** → [tasks-and-features.md](references/tasks-and-features.md).
**Syncing tasks to a cloud backend (ClickUp _or_ GitHub — one at a time)** → [integrations.md](references/integrations.md).

---

## Context handoff — ECO mode (opt-in, and it escalates)

When a vault or pane has it on, a long session gets an injected `[context handoff]` note that gets louder: at **300k–650k** it is firm (hand off unless the task is nearly done; "I'm mid-task" is not a reason), at **650k+** severe (finish the turn, then hand off, or tell the user why you keep going). A handoff is ONE command, every part required:

```bash
dreamcontext tasks handoff <slug> --done "…" --next "…" --decisions "…" --learned "…" --style "…" --files "…"
```

It refuses while a part is missing. Details → [tasks-and-features.md](references/tasks-and-features.md) § Context handoff.

---

## Memory & Knowledge — essentials

- **Quick updates (no sleep):** edit `core/0.soul.md`/`core/2.memory.md`/`people/<slug>.md` directly; `dreamcontext core changelog add` for code changes; `dreamcontext tasks log` for progress.
- **Recall modes:** default **`haiku`** (a small model picks docs); `raw` (BM25), `hybrid` (BM25 + local embeddings), `off`; switch with `dreamcontext recall on|raw|hybrid|off|status`. Auto-injected on prompts (opt out `DREAMCONTEXT_MEMORY_HOOK=0`).
- **Quick capture:** `dreamcontext memory remember "<text>"` writes a `type=note` CHANGELOG entry; sleep reconciles it later.
- **Knowledge files:** `dreamcontext knowledge create <name>`; pin frequently-needed ones (`pinned: true`); `knowledge touch` after reading one; group files with `dreamcontext knowledge move <slug> <folder>`, never `mv` plus hand-edited links.

**Recall modes, taxonomy, Excalidraw boards/diagrams, multi-product knowledge** → [knowledge-and-recall.md](references/knowledge-and-recall.md).

---

## Sub-Agents

- **`dreamcontext-explore`**: context-accelerated codebase exploration. Use for ALL exploration (default Explore is blocked). It is the **fast, single-pass** searcher, one agent, tight budget, one answer.
- **`dreamcontext-deep-research` skill**: the iterative counterpart for **synthesis across a large or multi-project corpus**, returning a cited report. Start with `dreamcontext-explore`; escalate when one pass leaves a cross-corpus question half-answered.
- **`initializer` skill**: the interactive, sub-agent-driven **brain bootstrap** for a missing or sparse `_dream_context/` (it drives `initializer-scout`, `initializer-ingestor`, `initializer-verifier`, and handles codebase-only repos too).
- **Sleep specialists** (`sleep-tasks`, `sleep-state`, `sleep-product`, `sleep-migration`, `sleep-learn`), dispatched by the main agent during the sleep flow only.
- **Preloads:** dreamcontext's own sub-agents preload the small `dreamcontext-agent-core` skill; only the four curator/initializer judges preload this one.

**First-run self-recognition (do not skip):** if the brain is missing or sparse, **do not silently scaffold and do not wait to be asked**: offer to ingest whatever material the user has (docs, an Obsidian/Notion export, an old wiki) or to bootstrap from the codebase, then invoke the `initializer` skill. The SessionStart and UserPromptSubmit hooks emit a `🧠 dreamcontext:` offer when they detect this: relay it and invoke `initializer` on consent (conditions → [cli-reference.md](references/cli-reference.md) § Setup & maintenance).

All sub-agents get a budgeted context briefing via the SubagentStart hook (at most 12,000 chars → [cli-reference.md](references/cli-reference.md) § Sub-agent briefing budget). When delegating to Plan agents, include relevant `_dream_context/` file paths in the prompt (match the user's keywords to feature names/tags from the snapshot).

---

## Setup & Maintenance (quick map)

- `dreamcontext setup`: the **front door** (init + install-skill + install-instructions, plus the desktop app on macOS).
- `dreamcontext update`: refresh THIS project's installed skill, agents, hooks, packs and references. **Exits 1 when it refreshed nothing** or when the refresh throws, so a script may trust the exit code.
- `dreamcontext upgrade`: the CLI, the desktop app and **every registered project** in one command; never run per-project updates by hand.
- `dreamcontext doctor`: validate `_dream_context/` structure (`--json` for repair loops).
- `dreamcontext dashboard` — open the web UI. `dreamcontext app install|update|status` — the desktop app.
- **"claude: command not found" even though it's installed**: don't conclude the CLI is missing: Claude Code installs into `~/.local/bin`, on no default PATH. Point the user to **Settings → System → "Installed, not on your PATH"** and its one-click **Fix PATH** → [integrations.md](references/integrations.md).
- **Team collaboration / shared brain / second machine**: that's **whole-project cloud sync**: `dreamcontext brain enable` / `brain status`, auto-synced at `sleep done`, prose conflicts resolved by **`/dream-sync`**. **Guide them into it, don't say "unsupported"** → [brain-sync.md](references/brain-sync.md).

---

## Improving dreamcontext (you are its field reporter)

When dreamcontext gets in your way — a recall gap, a missing command, a confusing behavior — **do not silently work around it. File it.** The sanctioned path is `dreamcontext feedback --dry-run …` → confirm with the user → file with `--yes`. Never `gh issue create` by hand. Full loop and quality bar → [improving-dreamcontext.md](references/improving-dreamcontext.md).

---

## Structure

```
_dream_context/
├── core/
│   ├── 0.soul.md  2.memory.md            ← slot 1 is RETIRED (the user file became people/)
│   ├── 3.style_guide_and_branding.md  4.tech_stack.md  6.system_flow.md
│   ├── CHANGELOG.json  RELEASES.json  taxonomy.json
├── people/                           ← WHO works in this vault (`dreamcontext people`)
│   ├── people.json                   ←   the roster
│   └── <slug>.md                     ←   one constitution per person (NOT knowledge, NOT recall-indexed)
├── knowledge/                        ← Deep research — grouped by context, indexed recursively
│   ├── <topic>.md                    ←   flat top-level docs are fine
│   ├── <context>/                    ←   PROMOTED: group related docs into a context folder
│   │   ├── <doc>.md                  ←     the context's knowledge
│   │   └── <title>/<title>.excalidraw.md  ← diagrams live INSIDE their context folder
│   ├── features/<feature>.md         ← Feature PRDs, typed knowledge (type: feature; may include product:)
│   └── data-structures/  products/   ← schemas; per-product knowledge
├── lab/                              ← Analytics insights (curated metrics — NOT knowledge)
│   ├── insights/<slug>.md            ←   insight manifests (`dreamcontext lab create`)
│   ├── cache/<slug>.json             ←   synced series snapshots (never hand-edit)
│   ├── scripts/<slug>.mjs            ←   custom-script adapters (run locally with your credentials)
│   ├── boards/<slug>.md              ←   Insights boards: cards of blocks on a 12-column grid (`lab board …`)
│   ├── blocks/<slug>.md              ←   the vault's library of custom HTML blocks (`lab block save`)
│   └── credentials.json              ←   gitignored; write ONLY via `lab credentials set`
├── overrides/task.md                 ← OPTIONAL: project task template + custom fields
├── state/
│   ├── <task>.md                     ← Active tasks
│   ├── .config.json  .brain-local.json (gitignored)  .active-version.json  .sleep.json
```

---

## Reference Index

Open these with `Read` when the task needs depth:

- **[cli-reference.md](references/cli-reference.md)**: every command, every flag, env vars, the snapshot ladder and the sub-agent briefing budget.
- **[tasks-and-features.md](references/tasks-and-features.md)**: task protocol depth, RICE, due dates, people/assignees, Workflow flowchart, Lab insights, context handoff, features, versioning, multi-product.
- **[knowledge-and-recall.md](references/knowledge-and-recall.md)**: knowledge files, pinning, recall modes, patterns, taxonomy, Excalidraw/diagrams, reading PDFs.
- **[sleep.md](references/sleep.md)** — full consolidation flow, specialist contracts, deep sleep, epoch safety, reflect, marketing/council passes.
- **[sleep-specialists.md](references/sleep-specialists.md)**: why each sleep specialist's rules exist, with worked examples (read when a rule's edge case is unclear).
- **[learning.md](references/learning.md)**: theses (hypotheses): the quality bar, evidence ledger, derived confidence, flips and promotion.
- **[automations.md](references/automations.md)**: scheduled headless runs: capture, the `## Flow` graph and its questions, per-automation Telegram, sharing, the channel, approval, stopping a run.
- **[whiteboards.md](references/whiteboards.md)**: widgets, format, daily and todo recipes.
- **[brain-sync.md](references/brain-sync.md)**: whole-project GitHub cloud sync, setup, per-machine auth, cross-OS setup, troubleshooting.
- **[integrations.md](references/integrations.md)**: ClickUp/GitHub task sync (one cloud backend at a time), dashboard and Chat view, desktop app, federation/vaults, peer mail, council, marketing. (Brain sync has its own reference above.)
- **[troubleshooting.md](references/troubleshooting.md)**: symptom, cause and careful fix for broken-brain states: duplicate tasks, sync ledger refusals, a stuck brain sync, structure and version drift.
- **[improving-dreamcontext.md](references/improving-dreamcontext.md)** — the feedback loop, when and how to file.
