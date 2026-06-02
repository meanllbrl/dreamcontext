---
id: task_mem360rd
name: memory-engine-360-roadmap
description: >-
  360° prioritized roadmap for the dreamcontext memory/recall/hook/sub-agent
  stack, grounded in four parallel code audits (recall engine, hooks+injection,
  sub-agents+explore, sleep+continuous-learning) plus the ECC competitive
  analysis and the "what your brain remembers" neuroscience source. Core
  diagnosis: the brain's stage-1 "awake-ripple tagging" is effectively dead
  (30/32 consolidations had zero bookmarks; the transcript distiller never runs
  automatically), and the read/recall path has several silent-degradation bugs.
  Biggest uplift = close the experience->memory loop automatically + fix the
  recall bugs. Supersedes/extends [[ecc-inspired-roadmap]].
priority: high
status: todo
created_at: '2026-06-01'
updated_at: '2026-06-01'
tags:
  - roadmap
  - memory
  - recall
  - hooks
  - sub-agents
  - continuous-learning
parent_task: null
related_feature: memory-recall-bm25
---

## Why

The user asked for a 360° review of what could be better across memory, hook-injected memory, the recall method, and the sub-agents (explore etc.), with a roadmap prioritized by uplift. Four parallel code audits converged on one diagnosis:

**dreamcontext's identity is the brain metaphor: tag important moments while awake (awake ripples -> bookmarks), consolidate them during sleep. Stage 1 — the awake-ripple tagging — is effectively dead.** Empirically, 30 of 32 recorded consolidations processed zero bookmarks; the high-quality `distillTranscript()` engine exists but is never run automatically; salience (surprise / user-correction / error->fix) is described in the neuroscience docs but implemented as *no* automatic signal. The brain only remembers what the agent manually flagged, only when someone remembers to run sleep. Meanwhile the READ path (snapshot + recall) has several bugs where it silently under-delivers on capabilities it already claims.

This is also the exact competitive gap: ECC's "continuous-learning / instinct system" is their #1 HIGH-IMPACT advantage (`knowledge/competitive-analysis-ecc.md:33-42`).

## Audit evidence (load-bearing, verified in source)

- **Haiku recall index is positionally truncated at 8000 chars** (`src/lib/recall-query-extractor.ts:70-74`). `buildCorpusIndex` emits in corpus load order with changelog LAST (`recall.ts:229-244`). On this 188-doc repo (~109 changelog entries) the entire ship history + task tail is invisible to Haiku. Truncation is blind, not relevance-ranked.
- **Corpus glob is non-recursive** (`recall.ts:60` `fg.sync('*.md', ...)`). `knowledge/products/*.md` (a shipped multi-product feature) is never indexed by recall or the hook. Latent until the first multi-product user.
- **Recall haystack has no field weighting** (`recall.ts:70`): title/tags/body flattened; a title match scores like a body mention. No recency/status/pin signal (pinned + updated are written but never scored).
- **Explore agent self-contradicts**: Rule 2 (`agents/dreamcontext-explore.md:130`) mandates `dreamcontext memory recall` as the first-line tool; the Bash allowlist (`:124`) omits it. The headline context-first-explore optimization cannot run. Also `model: haiku` for an agent whose protocol needs hypothesis discipline.
- **Sub-agents are read-only consumers**: explore (`disallowedTools` write, read-only Bash) and reviewers learn things that evaporate on return. No write-back verb; sleep never reads sub-agent output.
- **No automatic capture between sleeps**: Stop hook stores counts + `last_assistant_message` only (`hook.ts:382-426`). If the user never sleeps, durable knowledge is never written. Bookmarks empirically ~0/session.
- **No salience model in code**: debt = `max(changeCount, toolCount)` capped at 3 — measures activity volume, not importance. A 545-tool exploration and a 5-edit architecture decision both cap at 3.
- **PreCompact saves only counters** (`hook.ts:823-829`), not content — the most information-rich moment is wasted.
- **Recall doesn't feed warmth/staleness**: recalled docs aren't marked accessed, so they rot to "stale: never accessed" (e.g. `competitive-analysis-ecc.md`).
- **No eval/gold-set harness**: both recall decision docs gate every future improvement on "collect 5+ real misses, then measure recall@k" — that infra was never built, so the entire deferred recall roadmap is permanently blocked.
- **Per-prompt cost**: corpus rebuilt from disk 2x/prompt; static context-gate boilerplate (~120-150 tokens) re-injected verbatim every prompt; synchronous Haiku subprocess on the critical path (120s timeout) with zero cross-prompt caching.
- **Dead `.env` PreToolUse gate** (`hook.ts:504-521`) never runs under `matcher: "Agent"`. **Codex explore** is told to rely on a SubagentStart briefing that is Claude-only.

## Roadmap (prioritized by uplift)

### WAVE 0 — "The brain is silently lying" (highest ROI; ~1 week; tiny diffs)
Each restores a capability the system already claims to have.
- [ ] 0.1 Relevance-rank the Haiku corpus index (BM25 pre-pass -> top ~100 docs) instead of the 8K positional cut. `recall-query-extractor.ts:70-74`. [S]
- [ ] 0.2 Add `dreamcontext memory recall` + `transcript distill` to the explore agent Bash allowlist. `agents/dreamcontext-explore.md:124`. [S]
- [ ] 0.3 Make the corpus glob recursive (or add a products loader) + carry a `product` field. `recall.ts:60`. [S]
- [ ] 0.4 On recall hit, bump `knowledge_access` like `knowledge touch` does. `hook.ts:691-705`. [S]
- [ ] 0.5 Remove/relocate the dead `.env` PreToolUse gate (register a second hook with `Edit|Write` matcher, or drop the branch). [S]

### WAVE 1 — FLAGSHIP: automatic awake-ripple tagging + continuous capture (biggest absolute uplift)
Converts "remembers what the agent flagged, when someone sleeps" into "automatically captures the high-signal slice of every session, immediately recallable." Closes the ECC gap and finally realizes the brain metaphor.
- [ ] 1.1 Auto-mine the transcript: run the existing `distillTranscript()` at Stop (or the less latency-sensitive SessionStart catch-up path) and persist the high-signal slice (decisions, user corrections, error->fix) as a recall-indexed session digest. Capture stops depending on the agent remembering anything. `hook.ts:355-438`, `transcript.ts:49`. [M]
- [ ] 1.2 Automatic salience detection = the awake ripple: structural detectors (user message with "no/actually/wrong/instead" after an assistant action; `errors` followed by a code change; decision keywords) auto-emit bookmarks with salience 1-2. This is the dead stage-1 tagging, implemented from signals already parsed in `DistilledSection`. [S-M]
- [ ] 1.3 Index `.sleep.json` bookmarks + session digests into the recall corpus immediately (not only post-sleep), so a decision in session N is recallable in session N+1. Closes the cross-session blind window. `recall.ts buildCorpus`. [S]

### WAVE 2 — Recall quality, eval-gated (respect your own deferral discipline)
- [ ] 2.1 Build the gold-set + eval harness FIRST: opt-in hook logging of `{prompt, hits, mode}` + committed `eval/gold.jsonl` + vitest recall@1/@3. Unblocks the whole deferred roadmap; catches regressions (e.g. the 2.0-vs-3.0 threshold drift). [M]
- [ ] 2.2 Recency + status weighting in BM25 (down-weight `status: completed`; light decay on `updated`). Tune against the gold set. [S-M]
- [ ] 2.3 Per-field weighting (BM25F: title x3, tags x2, desc x2, body x1). [S]
- [ ] 2.4 THEN, only if the gold set shows the misses: link-aware `[[ ]]` boost -> stemming + small synonym dict -> embedding overlay (RRF). Do NOT build speculatively — both decision docs already deferred these pending a measured gold set. [S->L]

### WAVE 3 — Sub-agents stop being amnesiac
- [ ] 3.1 Give explore a single write-back verb (`memory remember "<subsystem map>"`) so a mapped subsystem persists instead of evaporating. Scope to high-confidence results; let sleep-product dedup. [M]
- [ ] 3.2 Put real recall into the SubagentStart briefing (BM25-keyed snippets inline, not just pointers) + add recall/write-back instructions to the briefing body itself. `snapshot.ts:743-919`. [M]
- [ ] 3.3 Sleep harvests sub-agent findings (reviewer/explore), not only the main transcript. [M]
- [ ] 3.4 Platform correctness: stop the Codex explore agent relying on a Claude-only briefing; harden the Explore PreToolUse match (case/spelling tolerant). [S]

### WAVE 4 — Hook hygiene, cost, timing, safety (steady-state)
- [ ] 4.1 PreCompact preserves a working-set content summary (active task + recent decisions), not just counters. `hook.ts:810-837`. [M]
- [ ] 4.2 Per-prompt cost: cache the corpus index (mtime-keyed; built 2x/prompt today), inject the static context-gate boilerplate once/session, skip redundant Haiku calls. [M]
- [ ] 4.3 Substance-weighted debt (use the distiller's byte/line deltas; weight core/knowledge/PRD edits higher) + auto-pin the sleep epoch at a debt threshold (consolidation fires late today, debt 10-16). [S-M]
- [ ] 4.4 ECC-parity security hook: prompt secret-scan + sensitive-file read warning (zero security hooks today; cheap, table-stakes). Already partly tracked in [[ecc-inspired-roadmap]]. [S]

## If you do only three things
1. WAVE 0 (one week, restores broken promises). 2. WAVE 1.1 + 1.2 (the flagship: automatic capture + salience). 3. WAVE 2.1 (the eval harness that unblocks everything else and stops regressions).

## Acceptance Criteria
- [ ] Each wave item has a tracked task or is consciously deferred with a reason.
- [ ] WAVE 0 items shipped and covered by tests (recall index relevance-rank has a unit test proving changelog docs survive on a >100-doc corpus).
- [ ] WAVE 1 has a feature PRD before implementation (continuous-capture is a brain-defining capability, not a patch).
- [ ] WAVE 2.1 gold-set harness exists and runs in CI before any 2.2-2.4 work begins.

## Constraints & Decisions
- Respect the existing deferral discipline: link-aware/embedding recall stay deferred until a measured gold set proves the miss (`knowledge/decision-link-aware-vs-embedding-recall.md`, `knowledge/decision-mem0-vs-bm25-recall.md`).
- Continuous capture must stay deterministic + bounded (size-cap the distiller, fire-and-forget or move off the latency-sensitive Stop path).
- Auto-sleep stays opt-in / "pin epoch + strong nudge" — never silently rewrite core files unsupervised.

## Changelog
- 2026-06-01: Roadmap created from four parallel subsystem audits + ECC analysis + neuroscience source. Three Wave-0 claims verified in source before commit.
