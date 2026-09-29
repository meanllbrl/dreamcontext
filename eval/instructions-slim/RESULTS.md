# Instructions slim (Dalga 2): results

Measured 2026-09-30 after W0-W2, on this repo's brain, after `npm run build` and `node dist/index.js update --yes`. Baseline: `tmp/instructions-slim/baseline/` (SHA256SUMS verified by measure.mjs).

## Sizes

| what                          | unit  | before |  after |  delta |
|-------------------------------|-------|--------|--------|--------|
| skill/SKILL.md                | B     |  73517 |  45688 | -37.9% |
| agents/sleep-tasks.md         | B     |  42116 |  22892 | -45.6% |
| agents/sleep-product.md       | B     |  39540 |  21991 | -44.4% |
| agents/sleep-state.md         | B     |  31783 |  17930 | -43.6% |
| agents/*.md (sum)             | B     | 184497 | 127739 | -30.8% |
| skill-agent-core/SKILL.md     | B     |      0 |   4712 |    n/a |
| SubagentStart briefing        | chars |  91984 |   9475 | -89.7% |
| SubagentStart briefing (info) | B     |  92517 |   9569 | -89.7% |

T1 all-floors briefing body: 9,189 chars (cap 11,600). Default budget: 9,475 chars total, overBudget false (cap 12,000).

## Install checks

- `.claude/agents/sleep-federation.md` absent; `.claude/skills/dreamcontext-agent-core/SKILL.md` present.
- All 13 installed pack agents from `skill-packs/agents` preload dreamcontext-agent-core (`grep -L` empty).
- `dist/agents/sleep-federation.md` and `dist/templates/AGENTS.md` absent.
- `git diff -G'^model:' -- agents skill-packs/agents` shows only the deletion of `agents/sleep-federation.md`; no model line added or edited.

## Doctor

Baseline summary {ok 21, warn 1, error 0}; after {ok 21, warn 1, error 0}. No new error {code, subject}.

## Tests

Full `npm test` under loadavg ~20: 9 files / 30 tests red, all timeouts or load-sensitive integration tests plus one real drift. Serial rerun of those 9 files: 353/354 green; the one failure was `cli-manifest` (T3 corrected the `update` description), fixed by `npm run gen:cli-manifest` (the regenerated manifest also picks up the uncommitted `whiteboard` command from parallel work in the tree).

## nothing-lost --target skill

```
nothing-lost --target skill
units 576 | exact 551 | fuzzy 17 | ledger deleted 4 | ledger corrected 4 | missing 0

Weakest 17 fuzzy passes (spot-check these):
  82%  SKILL.md:261 -> skill/SKILL.md:231
       When you finish a user story or acceptance criterion in a task, flip `- [ ]` to `- [x]` immediately — don't wait for sleep.
  83%  SKILL.md:447 -> skill/SKILL.md:380
       All sub-agents get a lightweight context briefing via the SubagentStart hook.
  86%  SKILL.md:182 -> skill/references/knowledge-and-recall.md:252
       **Pinned knowledge** — files with `pinned: true`, loaded in full
  86%  SKILL.md:261 -> skill/references/tasks-and-features.md:401
       Keep the task's `## Workflow` mermaid block in sync (one node per criterion; status classes `done`/`active`/`todo`/`blocked`).
  89%  SKILL.md:115 -> skill/SKILL.md:115
       When unsure whether dreamcontext can do something, the answer is usually "yes, check the reference," not "no."
  93%  SKILL.md:342 -> skill/SKILL.md:309
       Dispatch specialists **in parallel** (one message, multiple Agent calls — never inline, never sequential): always `sleep-tasks` + `sleep-state`; fire `sleep-...
  95%  SKILL.md:344 -> skill/references/sleep.md:96
       If `_dream_context/core/objectives/` is non-empty, run `dreamcontext roadmap` — a cheap deterministic call that refreshes the auto-generated board (`knowledg...
  100%  SKILL.md:100 -> skill/SKILL.md:100
       **Chat modes (Basic / Plan / Develop)**
  100%  SKILL.md:261 -> skill/SKILL.md:85
       See [tasks-and-features.md](references/tasks-and-features.md).
  100%  SKILL.md:344 -> skill/references/sleep.md:96
       Surface any 🔴 SLIPPING objectives in your summary.
  100%  SKILL.md:350 -> skill/SKILL.md:439
       **Full specialist contracts, deep sleep, epoch safety, and the marketing/council passes are in [sleep.md](references/sleep.md).
  100%  SKILL.md:429 -> skill/references/sleep.md:111
       **Features are sleep-only** (see rule 9).
  100%  SKILL.md:441 -> skill/SKILL.md:375
       **Sleep specialists** (`sleep-tasks`, `sleep-state`, `sleep-product`, `sleep-migration`) — dispatched by the main agent during the sleep flow only.
  100%  SKILL.md:513 -> skill/SKILL.md:436
       **[cli-reference.md](references/cli-reference.md)** — every command, every flag, env vars.
  100%  SKILL.md:514 -> skill/SKILL.md:437
       **[tasks-and-features.md](references/tasks-and-features.md)** — task protocol depth, RICE, due dates, people/assignees, Workflow flowchart, features, version...
  100%  SKILL.md:515 -> skill/SKILL.md:438
       **[knowledge-and-recall.md](references/knowledge-and-recall.md)** — knowledge files, pinning, recall modes, taxonomy, Excalidraw/diagrams.
  100%  SKILL.md:519 -> skill/SKILL.md:444
       **[integrations.md](references/integrations.md)** — ClickUp/GitHub task sync (one cloud backend at a time), dashboard, desktop app, federation/vaults, counci...
```

## nothing-lost --target sleep-agents

```
nothing-lost --target sleep-agents
units 1063 | exact 985 | fuzzy 68 | ledger deleted 0 | ledger corrected 10 | missing 0

Weakest 20 fuzzy passes (spot-check these):
  80%  sleep-tasks.md:127 -> agents/sleep-tasks.md:87
       Add the new work as concrete **sub-items in the body**, not a new file:
  80%  sleep-tasks.md:202 -> agents/sleep-tasks.md:129
       A near-verbatim twin of this candidate is already on the board (live **or** `state/archive/`)
  80%  sleep-tasks.md:357 -> skill/references/sleep.md:109
       # Compare its task list to current statuses:
  80%  sleep-tasks.md:461 -> agents/sleep-tasks.md:173
       Read `.config.json` `people` first.
  80%  sleep-product.md:162 -> agents/sleep-product.md:110
       Frontmatter: `id`, `status` (start at `in_progress` or `planning` per current state), `created`, `updated`, `released_version: null`, `tags`, `related_tasks`.
  80%  sleep-product.md:405 -> agents/sleep-product.md:277
       Tag them if content is clear; leave them if the doc is a stub.
  80%  sleep-product.md:438 -> _dream_context/knowledge/features/sleep-consolidation.md:51
       - related_tasks += sleep-fanout-architecture
  80%  sleep-product.md:439 -> _dream_context/knowledge/features/sleep-consolidation.md:167
       - Created: features/sleep-fanout-architecture.md
  82%  sleep-product.md:333 -> agents/sleep-product.md:223
       Frontmatter: `type: data-structures`, `product: <name>`, `tags: [data-structures, database, schema]` (add domain tags as relevant).
  82%  sleep-state.md:170 -> agents/sleep-state.md:152
       A schema change, new table, or new model → flag for **sleep-product** to write `knowledge/data-structures/<product>.md`.
  83%  sleep-tasks.md:172 -> agents/sleep-tasks.md:114
       A new task must clear **every** line below:
  83%  sleep-product.md:143 -> agents/sleep-product.md:102
       dreamcontext features insert <name> constraints "<decision>"
  83%  sleep-product.md:403 -> agents/sleep-product.md:275
       Remove it from the offending file's frontmatter surgically.
  83%  sleep-product.md:456 -> agents/sleep-product.md:264
       - taxonomy init: no-op (core/taxonomy.json already exists)
  83%  sleep-state.md:84 -> agents/sleep-state.md:83
       A feature shipped across 4 commits → **one** `feat` entry.
  83%  sleep-state.md:144 -> agents/sleep-state.md:128
       You apply **two different gates** depending on whether the target file describes user intent or code reality.
  83%  sleep-state.md:302 -> agents/sleep-state.md:210
       Read `knowledge_access` from `.sleep.json`:
  83%  sleep-state.md:304 -> agents/sleep-state.md:210
       File frequently accessed but not pinned → suggest `pinned: true`.
  83%  sleep-state.md:305 -> agents/sleep-state.md:210
       File pinned but never accessed → suggest unpinning.
  86%  sleep-tasks.md:280 -> agents/sleep-tasks.md:173
       # Read the current roster (people/people.json — never .config.json)
```

## Ledger: skill

- **deleted**: "They are NOT auto-loaded — open one with `Read` when the task calls for it" (Reworded in place: the Capabilities footer in SKILL.md still says references are NOT auto-loaded and to Read one when the task calls for it.)
- **deleted**: "Read it before running a sleep cycle if you're unsure of the details" (Pointer sentence condensed to: Specialist contracts, deep sleep and epoch safety -> sleep.md.)
- **deleted**: "scheduled headless claude runs: the capture protocol, the ## Flow graph" (Reference Index blurb condensed; automations.md itself is the content and the index line still names the channel.)
- **deleted**: "whole-project GitHub cloud sync: the two modes" (Reference Index blurb condensed; brain-sync.md itself is the content.)
- **corrected-stale-fact**: "Sleep state — current debt level, sessions since last sleep, history" (The snapshot has no sleep-state section; it renders a Sleep Pending Analysis section and debt reaches the agent as hook directives (snapshot.ts:1732).; home skill/SKILL.md)
- **corrected-stale-fact**: "Features summary — all features with status" (Features render as name, status and path, demoting to a named roster on a mature brain.; home skill/SKILL.md)
- **corrected-stale-fact**: "Knowledge index — all knowledge files with descriptions, tags, staleness" (Only pinned files and patterns are listed; other knowledge is counted, not listed (snapshot.ts:2086-2092).; home skill/SKILL.md)
- **corrected-stale-fact**: "Warm knowledge — recently accessed / task-relevant files with a preview" (Warm Knowledge previews were removed from the snapshot (snapshot.ts:2056); the corrected list names what is injected instead.; home skill/SKILL.md)

## Ledger: sleep-agents

- **corrected-stale-fact**: "every operation you do (read `.sleep.json`, run `dreamcontext tasks` CLI verbs" (The agent no longer preloads the full dreamcontext skill; its Skills section now names dreamcontext-agent-core and cites where the task CLI and protocol live.; home agents/sleep-tasks.md)
- **corrected-stale-fact**: "Without it, you'd hand-edit JSON and miss the structural guarantees" (Same Skills bullet: the never-hand-edit-JSON rule now lives in the agent-core skill the agent preloads.; home skill-agent-core/SKILL.md)
- **corrected-stale-fact**: "Single-person projects (`.config.json` `people` has 0 or 1 entry)" (The roster moved from .config.json to people/people.json in 0.23.0; the rule now reads the roster.; home agents/sleep-tasks.md)
- **corrected-stale-fact**: "Never inject a `person:` tag on a solo project." (Kept in the agent with the corrected roster source.; home agents/sleep-tasks.md)
- **corrected-stale-fact**: "If 0 or 1 entry, step 2.5 is a complete NO-OP" (Step 2.5 now states it against the people/people.json roster.; home agents/sleep-tasks.md)
- **corrected-stale-fact**: "knowledge files use `dreamcontext knowledge create` with the standard tag set" (The agent now preloads dreamcontext-agent-core; the knowledge, tag and pinning rules are cited in the knowledge-and-recall reference.; home agents/sleep-product.md)
- **corrected-stale-fact**: "Feature PRDs use `dreamcontext features create` (deprecated compat alias" (Feature commands stay in the domain table; the schema is cited in tasks-and-features.md.; home agents/sleep-product.md)
- **corrected-stale-fact**: "The skill defines the PRD schema" (The PRD schema lives in the tasks-and-features reference, not in a preloaded skill.; home agents/sleep-product.md)
- **corrected-stale-fact**: "are auto-loaded by the dreamcontext skill at session start" (The core files reach the main session through the SessionStart hook, not through a skill; the specialist reads them from disk.; home agents/sleep-state.md)
- **corrected-stale-fact**: "The skill also defines the `dreamcontext core changelog add`" (Changelog, release and trigger schemas are cited in cli-reference.md.; home agents/sleep-state.md)

