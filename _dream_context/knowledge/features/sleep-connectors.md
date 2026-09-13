---
id: "feat_2fUTun4J"
type: "feature"
name: "sleep-connectors"
description: >-
  The brain's sensory feed: pluggable external-source connectors (ClickUp first)
  pulled on a per-connector cadence during sleep and distilled into canonical
  knowledge. A connector is an AGREEMENT, not a copy — the manifest is tracked,
  the event cache is gitignored. IN PROGRESS: wave 1 landed behaviour-neutral,
  the CLI is not registered and the sleep distill step is not built.
pinned: false
date: "2026-09-13"
status: "in_progress"
created: "2026-09-13"
updated: "2026-09-13"
released_version: null
tags:
  - 'topic:sleep'
  - 'kind:architecture'
  - 'topic:clickup'
  - 'domain:knowledge'
  - 'layer:backend'
related_tasks:
  - sleep-connectors-pull-outside-sources-on-a-cadence-and-turn-them-into-knowledge-and-theses
---

## Why

The brain learns only from what happens inside its own sessions. Everything the team decides in Slack, ClickUp comments, or any other external system is invisible to it, so the same decision gets re-litigated in-session or silently contradicted. Connectors are the sensory feed: the user connects a source in conversation, the agent scaffolds a manifest plus a callable fetch script (the Lab model), and the sleep orchestrator decides when to pull and what to learn from it.

The durable output is a **canonical-doc update written at distill time**, not an archive of foreign content. That is the federation staleness lesson applied before it could be repeated: a copy of someone else's data rots, an agreement to keep learning from it does not.

## User Stories

- [ ] As a user, I want to connect an external source in conversation and have the agent scaffold the manifest for me, so wiring a feed is not a config exercise.
- [ ] As a brain owner, I want each connector pulled on its OWN cadence during sleep, so a noisy source and a quiet one do not share a schedule.
- [ ] As a brain owner, I want what is pulled distilled into canonical knowledge, so the brain gets an updated doc rather than a growing pile of foreign text.
- [ ] As a team member, I want external content never to sync into a shared brain repo, so connecting a private source does not publish it.
- [ ] As an operator, I want one malformed manifest not to blind the whole feed.

## Acceptance Criteria

- [x] **Store contract** (`src/lib/connectors/store.ts`, `types.ts`): manifest at `connectors/<slug>.md` — tracked and recall-indexable — holds the standing "learn from this source" contract; the event cache at `connectors/cache/<slug>.json` holds raw pulled text and is **gitignored on the same gitignore-first footing as the secrets store**.
- [x] **Reads are lenient, writes are strict**: a malformed sub-block degrades rather than throwing, so one bad manifest cannot blind the whole feed; every write throws `ConnectorError`.
- [x] **Cadence is due when EITHER trigger fires**: `every_cycles` counts completed sleep cycles, `ttl_hours` is wall clock. Neither set means pull every sleep.
- [x] **ClickUp pull scoped to comments and newly created tasks ONLY** (`src/lib/connectors/clickup-pull.ts`). Task state — status, assignees, fields — belongs to the task-sync backend; pulling it here would give two writers one mirror and corrupt its integrity.
- [x] **Credentials resolve in the CLI process only.** Sub-agents are handed cache paths, never secrets.
- [x] 20 unit tests green over the store and the pull (`tests/unit/connectors-store.test.ts`, `connectors-clickup-pull.test.ts`).
- [ ] **NOT DONE — the CLI is not registered.** `registerConnectorsCommand` (`src/cli/commands/connectors.ts`) is exported but **nothing calls it**. Wave 1 is behaviour-neutral on purpose: it lands the contract and its tests without changing a single existing command. There is no user-reachable `dreamcontext connectors` command today.
- [ ] **NOT DONE — the sleep-flow distill step does not exist.** Nothing pulls on a cadence and nothing writes a canonical-doc update yet. Registration and distill ship together in the wave that can be verified end to end.
- [ ] **NOT DONE** — the conversational connect-a-source flow, the scaffolded fetch script, any non-ClickUp connector, and the thesis-generation half named in the originating task.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-09-13] A connector is an AGREEMENT, not a copy.** The manifest (the contract) is tracked; the cache (the raw content) is gitignored, so external content never syncs into a brain repo that may be shared with a team. The cache is working material; the durable artifact is the distilled canonical doc.
- **[2026-09-13] ClickUp's scope is comments and newly created tasks only** — task state belongs to the task-sync backend, and two writers on one mirror corrupts it.
- **[2026-09-13] Wave 1 ships behaviour-neutral and unregistered, deliberately.** Landing the contract plus tests without touching an existing command means the risky half (registration + the sleep distill step) arrives only when it can be verified end to end. Read this PRD as a contract that exists, not a capability that runs.

## Technical Details

`src/lib/connectors/` — `types.ts` (114 lines), `store.ts` (360, manifest + cache read/write, gitignore-first cache), `clickup-pull.ts` (231, comments + newly created tasks). `src/cli/commands/connectors.ts` (284) exports `registerConnectorsCommand`, **currently uncalled**. Tests: `tests/unit/connectors-store.test.ts` (198), `tests/unit/connectors-clickup-pull.test.ts` (234).

Landed in `b2210600`. Nothing in the sleep flow, the snapshot, or the CLI surface references any of it yet.

## Notes

- The originating task (`sleep-connectors-…`, created 2026-07-19) is marked `completed` because it was a **planning-only** task; the build is this PRD's subject and is not finished. Do not read that status as "shipped".
- Open question for the next wave: where the distill step sits in the sleep fan-out — a new specialist pass, or work folded into `sleep-product`'s knowledge pass.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-09-13 - Created
- PRD written at sleep from commit `b2210600` (wave 1) and task `sleep-connectors-…`. Recorded as IN PROGRESS with the unbuilt half named explicitly, because the commit message itself says "not yet registered".
