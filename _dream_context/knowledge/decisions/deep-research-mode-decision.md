---
id: know_5ixlrF4b
name: deep-research-mode-decision
description: >-
  Decision: dreamcontext-deep-research is the iterative, sub-agent-driven
  corpus-synthesis skill — the heavy counterpart to dreamcontext-explore for
  large/multi-project/federated corpora. Reuses dreamcontext-explore as
  searcher/verifier; read-only; fan-out → gap-loop → adversarial verify → cited
  synthesis.
tags:
  - architecture
  - decisions
  - 'topic:recall'
  - 'topic:agents'
pinned: false
date: '2026-06-25'
---

## Why This Exists

A user with several local projects tagged/federated into one large vault hit the ceiling of
`dreamcontext-explore`: explore is tuned for **fast, narrow, single-pass** lookups returning one
answer, and it under-serves questions that need **synthesis across many knowledge/feature/task
files and connected peer vaults** ("reconcile everything we know about X across my projects", "pull
the whole history of Y and cite it"). Only one exploration surface existed; there was no deeper mode
for cross-file / cross-project synthesis when there is "tons of data". Filed as the feedback task
`add-a-deep-research-mode-beyond-dreamcontext-explore-for-large-multi-project-tagged-corpora`.

## The Decision

**Ship `dreamcontext-deep-research` as a core orchestration skill** — the heavy, iterative,
sub-agent-driven counterpart to `dreamcontext-explore`. Installed with the core (like `initializer`
and `curator`), not as an optional pack.

- **Form: option (a) from the feedback** — a multi-agent orchestrator skill, not a behavioral loop
  in a single agent. This matches the repo's established convention (SKILL.md: *"the main agent runs
  this directly — sub-agents can't reliably fan out"*) and the curator/initializer/council pattern.
  The **main agent** owns the loop and the fan-out; sub-agents can't nest.
- **Flow:** scope & seed (recall, JSON, type-scoped, federation-spanning) → **fan-out** parallel
  searchers → **gap loop** (loop-until-dry) → **adversarial verification** of load-bearing claims →
  **synthesized, cited** report (written by the orchestrator) → optional consent-gated capture.
- **Reuses `dreamcontext-explore`** as both searcher and verifier — no new sub-agent file, no new
  codex `.toml`/prompt mirror to maintain. The skill is the *orchestration* around the tested,
  recall-accelerated, read-only explorer.
- **Recall is the engine.** Every wave seeds from `dreamcontext memory recall --json --types … `
  spanning connected peers (`--connected`/`--all-vaults`/`--vault`). Cross-vault hits
  (`<vault>::<type>/<slug>`) are first-class — provenance is the point on a multi-project corpus.
- **Read-only.** It synthesizes existing memory; it never mutates the corpus (may *offer* to capture
  a finding as knowledge or file feedback, on consent). Same fan-out shape as the sleep cycle,
  opposite direction: sleep *writes* memory, deep-research *reads* it.

## Naming

Named `dreamcontext-deep-research` (not `deep-research`) to avoid colliding with the pre-existing
generic `deep-research` skill that researches the **open web**. This one researches **your brain**
(curated corpus + connected vaults) — same harness shape, different substrate. The lineage to
`dreamcontext-explore` is deliberate.

## Escalation Boundary (explore vs deep-research)

Start with `dreamcontext-explore`; escalate to deep-research only when one pass and one answer leave
a cross-corpus question half-answered. Explore now flags its own ceiling and recommends the
escalation when it hits its budget with only a fragment. Don't fan out a 10-agent research run at a
tiny single-project brain — scale the machinery to the corpus.

## Where It Lives

- Skill: `skill-deep-research/SKILL.md` (ships from repo root via package.json `files`, installed by
  `install-skill` into `<skillRoot>/dreamcontext-deep-research/SKILL.md`, recorded `core`).
- Install wiring: `src/cli/commands/install-skill.ts` (mirrors the curator/initializer copy block).
- Discoverability: core `skill/SKILL.md` Sub-Agents section + `references/knowledge-and-recall.md`
  (the two-depths-of-search note) + the escalation note in `agents/dreamcontext-explore.md`.
- Tests: `tests/unit/deep-research-skill.test.ts` (skill contract) + `tests/integration/platform-install.test.ts` (install copies it, claude + codex).
- Capability spec (user stories, acceptance criteria): `core/features/dreamcontext-deep-research.md`.

## Relationship to Other Decisions

- **[[decisions/graphify-coexistence-decision]]** — deep research stays in the curated decisions/knowledge
  lane; raw code *structure* ("who calls this function?") remains the code-graph (graphify) lane. It
  synthesizes curated content, it is not an AST indexer.

## Last Verified

2026-06-25 (built alongside the feature).
