---
id: feat_I8gilyj8
status: in_review
created: '2026-06-25'
updated: '2026-07-07'
tags:
  - 'topic:skills'
  - 'topic:cli'
  - 'topic:recall'
  - 'topic:agents'
related_tasks:
  - >-
    add-a-deep-research-mode-beyond-dreamcontext-explore-for-large-multi-project-tagged-corpora
type: feature
name: dreamcontext-deep-research
description: ''
pinned: false
date: '2026-06-25'
---

## Why

`dreamcontext-explore` is tuned for fast, narrow, single-pass lookups returning one answer. Users with large or federated corpora — multiple local projects tagged or connected as peers — hit a ceiling: questions that need synthesis across dozens of knowledge, feature, task, and CHANGELOG files (and connected vaults) cannot be answered by a single exploration pass. There was no heavier capability for cross-file, cross-project synthesis when there is "tons of data." `dreamcontext-deep-research` fills that gap: an iterative, adversarially-verified, cited-synthesis orchestrator that researches your brain (curated corpus + connected vaults), not the open web.

The naming (`dreamcontext-deep-research`, not `deep-research`) is intentional — the open-web `deep-research` skill already exists; this one researches the curated corpus and must be distinguishable. Decision rationale: `knowledge/deep-research-mode-decision.md`.

## User Stories

- [x] As an agent on a federated vault, I can invoke `dreamcontext-deep-research` to get a synthesized, cited answer that spans knowledge files, feature PRDs, tasks, CHANGELOG entries, and connected peer vaults — not raw search hits.
- [x] As a developer using `dreamcontext-explore`, I am nudged to escalate to `dreamcontext-deep-research` when explore reaches its budget with only a fragment of a cross-corpus question answered.
- [x] As a developer, I can install `dreamcontext-deep-research` via `dreamcontext install-skill` — it ships as a core skill (like `initializer` and `curator`), not an optional pack.
- [x] As a developer, my load-bearing claims in the synthesized report are adversarially verified before I see them, so the report is trustworthy rather than a hallucinated interpolation of snippets.
- [x] As a developer, `dreamcontext-deep-research` never mutates my corpus — it is read-only and may only offer to capture a finding as knowledge (consent-gated) at the end.
- [x] As a developer, deep-research reuses the tested `dreamcontext-explore` agent as both searcher and verifier — there is no new sub-agent to maintain.

## Acceptance Criteria

- [x] `skill-deep-research/SKILL.md` ships from the package via `files` in `package.json`; `dreamcontext update` refreshes it.
- [x] `dreamcontext install-skill` wires it as a core skill, mirroring the `initializer`/`curator` copy block in `src/cli/commands/install-skill.ts`; recorded as `core` in the installed manifest.
- [x] Orchestration flow: scope & seed (recall, `--types`, `--connected`/federation-spanning) → parallel fan-out `dreamcontext-explore` searchers → gap loop (loop-until-dry when no new evidence) → adversarial verification of every load-bearing claim → synthesized, cited report written by the orchestrator.
- [x] Reuses `dreamcontext-explore` as both searcher and verifier. No new sub-agent file, no new codex `.toml`/prompt mirror to maintain.
- [x] Recall engine is the seed: every wave starts from `dreamcontext memory recall --json --types … ` spanning connected peers. Cross-vault hits (`<vault>::<type>/<slug>`) are first-class in citations.
- [x] Named `dreamcontext-deep-research` (not `deep-research`) to avoid collision with the pre-existing generic web `deep-research` skill.
- [x] Read-only invariant: the skill never writes to the corpus. It may offer consent-gated capture of synthesis findings at the end. Identical read-only constraint as `dreamcontext-explore`.
- [x] Discoverability wired in three places: (1) escalation note in `agents/dreamcontext-explore.md`; (2) Sub-Agents section of core `skill/SKILL.md`; (3) two-depths-of-search note in `references/knowledge-and-recall.md`.
- [x] Unit test `tests/unit/deep-research-skill.test.ts` (skill contract, 22 pass) and integration test `tests/integration/platform-install.test.ts` (install copies it for both claude and codex targets).
- [x] Full test suite green (2307 pass), `tsc --noEmit` clean, `dreamcontext doctor` clean after install.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-06-25]** Installed as `core`, not optional pack. Same pattern as `initializer` and `curator` — capabilities the main agent needs to function, not domain-specific extensions. Optional packs are domain skills (engineering, design, growth). The orchestration skills that power the agent loop are core.
- **[2026-06-25]** Orchestrator lives in the main agent (skill instructs the main agent to run the loop). Sub-agents cannot reliably fan out to other sub-agents (established in the sleep fan-out architecture decision). Deep-research follows the same convention: the main agent drives fan-out; specialists (explore instances) are leaves.
- **[2026-06-25]** Escalation boundary: start with `dreamcontext-explore`; escalate to deep-research only when explore finishes one pass with a fragment of a cross-corpus question. Don't launch a 10-agent research run at a tiny single-project brain. Explore flags its own ceiling.
- **[2026-06-25]** No new sub-agent file. Reusing `dreamcontext-explore` as searcher and verifier was an explicit design constraint — one tested surface, not two. Adding a separate `dreamcontext-deep-research-searcher` would double the maintenance surface without adding capability.
- **[2026-06-25]** Decision and naming rationale: `knowledge/deep-research-mode-decision.md` (the decision record; this PRD is the capability spec — no content duplication).

## Technical Details

**Key files:**
- `skill-deep-research/SKILL.md` — the orchestrator skill. Installed to `.claude/skills/dreamcontext-deep-research/SKILL.md` (and codex mirror via `install-skill.ts`).
- `src/cli/commands/install-skill.ts` — core skill copy block extended for `deep-research` (mirrors the curator/initializer pattern).
- `package.json` `files` — includes `skill-deep-research/` so it ships with the npm package.
- `agents/dreamcontext-explore.md` — escalation note added pointing at deep-research.
- `skill/SKILL.md` Sub-Agents section — `dreamcontext-deep-research` listed as a core capability.
- `references/knowledge-and-recall.md` — two-depths-of-search note linking explore → deep-research.

**Orchestration flow (inside the skill):**
1. **Scope & seed** — parse question, run `dreamcontext memory recall --json --types knowledge,feature,task,memory,changelog` spanning connected peers (`--connected` / `--vault`). Cross-vault hits get `<vault>::<type>/<slug>` provenance.
2. **Parallel fan-out** — dispatch N `dreamcontext-explore` instances (one per seed cluster or question facet). Collect findings.
3. **Gap loop** — identify unanswered facets; run another recall wave with refined queries. Loop until dry (no new evidence in a wave).
4. **Adversarial verification** — for each load-bearing claim, invoke `dreamcontext-explore` in verifier mode (dispute the claim, find counter-evidence). Flag unverifiable claims.
5. **Synthesis** — orchestrator writes a cited report. Every fact traces back to a `type/slug` (and vault prefix for federated hits). Optional consent-gated capture of the synthesis as a knowledge file.

**Tests:**
- `tests/unit/deep-research-skill.test.ts` — skill contract: SKILL.md exists, parses, contains required sections (Scope, Fan-out, Gap-loop, Verify, Synthesize, Read-only).
- `tests/integration/platform-install.test.ts` — install copies `skill-deep-research/SKILL.md` into both `.claude/skills/dreamcontext-deep-research/SKILL.md` and `.codex/agents/prompts/dreamcontext-deep-research.md`.

**Relationship to other features:**
- `memory-recall-bm25.md` — recall is the seed engine; deep-research depends on the BM25/Haiku recall corpus and federation spanning.
- `optional-skill-packs.md` — covers install mechanism for optional packs; deep-research is core (different install path in `install-skill.ts`), not an optional pack.
- `sleep-fanout-architecture.md` — establishes the pattern: main agent drives fan-out, sub-agents are leaves. Deep-research follows the same convention.

## Notes

- The escalation heuristic (when should explore recommend deep-research?) is judgment-based for now. Explore flags its ceiling; users escalate. A future improvement could make this automatic when recall returns ≥N cross-vault hits.
- The adversarial verification step fires on every load-bearing claim. On a small corpus this may be overkill — a future refinement could scope verification to claims with conflicting evidence only.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-25 - Shipped
- `skill-deep-research/SKILL.md` created; install wiring in `install-skill.ts` + `package.json files`; 22 unit tests pass; full suite 2307 green, tsc clean, doctor clean. Escalation note in explore agent + core SKILL.md + knowledge-and-recall.md reference.

### 2026-06-25 - Created
- Feature PRD created.
