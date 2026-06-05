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
status: in_review
created_at: '2026-06-01'
updated_at: '2026-06-05'
version: v0.6.0
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

### WAVE 0 — "The brain is silently lying" — SHIPPED (PRs #1 + #2, 2026-06-02)
Each restores a capability the system already claimed to have.
- [x] 0.1 Relevance-rank the Haiku corpus index (BM25 pre-pass top-100 replacing 8K positional cut). Shipped: `a56f9d4` (Batch 1 B6).
- [x] 0.2 Add `dreamcontext memory recall` + `transcript distill` to the explore agent Bash allowlist. Shipped: `1451ab5` (Batch 3 D1).
- [x] 0.3 Make the corpus glob recursive + carry `product` field. Shipped: `a56f9d4` (Batch 1 B1).
- [x] 0.4 On recall hit, bump `knowledge_access` (bumpKnowledgeAccess extracted to sleep.ts). Shipped: `a5edce7` (Batch 2 C4).
- [x] 0.5 Revived dead `.env` PreToolUse gate (2nd hook entry `Edit|Write|MultiEdit` matcher). Shipped: `1451ab5` (Batch 3 D2).

### WAVE 1 — FLAGSHIP: automatic awake-ripple tagging + continuous capture — SHIPPED (PR #1, 2026-06-02)
- [x] 1.1 Auto-mine transcript via `distillTranscript()` on SessionStart catch-up path; persists session digests to `state/.session-digests/<id>.md`. Shipped: `a5edce7` (Batch 2 C1).
- [x] 1.2 Automatic salience detection: structural detectors (user-correction keywords, error→fix, decision keywords) auto-emit bookmarks salience 1-2. Shipped: `a5edce7` (Batch 2 C2).
- [x] 1.3 Session digests + `.sleep.json` bookmarks indexed into recall corpus immediately. Shipped: `a5edce7` (Batch 2 C3).

**Capture guard** (PR #2, `4585612`): CAPTURE_RANK_PENALTY 0.5 on auto-capture docs (rankScore only; raw hit.score/gates unaffected) + K=50 digest cap. Zero true displacement proven. Fixed latent `created_at` Date-parse bug. e2e loop test green.

### WAVE 2 — Recall quality — SHIPPED (PR #1, 2026-06-02)
- [x] 2.1 Gold-set + eval harness: `eval/gold.jsonl` (60 queries, 7 categories), `eval/BASELINE.md`, `tests/unit/recall-eval.test.ts`. Shipped: `1a2b567` + `f560fd8` (Batch 0).
- [x] 2.2 Recency + status weighting (`STATUS_PENALTY={completed:0.6}`, `recencyMultiplier` half-life 120 days) as post-BM25 rankScore multiplier. Shipped: `a56f9d4` (Batch 1 B3).
- [x] 2.3 BM25F per-field weighting (title×3, tags×2, desc×2, body×1). Shipped: `a56f9d4` (Batch 1 B2).
- [x] 2.4 TR/EN stemming + synonym map (deferred link-aware/embedding stay off — no measured need). Shipped: `a56f9d4` (Batch 1 B4). Link-aware gated `opts.linkAware` DEFAULT OFF as decided.

**Benchmark result (PR #1):** overall recall@1 68.3→85.0%, recall@3 81.7→95.0%; Turkish 37.5→75.0, paraphrase 41.7→66.7; no category regressed. 1063 tests pass, build clean. Raw `hit.score` stays flat-BM25 so hook gate thresholds unaffected (decoupling via derived `rankScore`).

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
- [x] WAVE 0 items shipped and covered by tests.
- [x] WAVE 1 continuous-capture shipped; capture guard (PR #2) proves zero true displacement.
- [x] WAVE 2.1 gold-set harness exists and runs (vitest); BASELINE frozen before any scoring changes.
- [x] WAVE 2 recall improvements shipped and benchmarked (68.3→85.0% recall@1).
- [ ] WAVE 3 sub-agent recall + write-back + sleep harvesting tracked and shipped.
- [ ] WAVE 4 hook hygiene / cost / security items tracked and shipped.

## Constraints & Decisions
- Respect the existing deferral discipline: link-aware/embedding recall stay deferred until a measured gold set proves the miss (`knowledge/decision-link-aware-vs-embedding-recall.md`, `knowledge/decision-mem0-vs-bm25-recall.md`).
- Continuous capture must stay deterministic + bounded (size-cap the distiller, fire-and-forget or move off the latency-sensitive Stop path).
- Auto-sleep stays opt-in / "pin epoch + strong nudge" — never silently rewrite core files unsupervised.

## Changelog



### 2026-06-05 - Session Update
- 2026-06-04 (session 4626d1f6): Audit of current capture/recall/consolidation state reviewed. disable-claude-native-memory shipped (autoMemoryEnabled:false default on install). reflect command shipped. Key findings: knowledge_access only updated by explicit knowledge touch (not by recall path) — tracked as Wave 3+ work.
### 2026-06-02 - Status → in_review
- Wave 0+1+2 + capture guard shipped and benchmarked (68.3→85.0% recall@1). Wave 3+4 remain — ready for user to verify shipped waves and prioritize remaining work.
### 2026-06-02 - Session Update
- Wave 0+1+2 + capture guard shipped via PRs #1+#2 to main. Benchmark: recall@1 68.3→85.0%, recall@3 81.7→95.0%. 1063 tests pass. Remaining: Wave 3 (sub-agent recall/write-back/sleep harvesting) + Wave 4 (hook hygiene/cost/security secret-scan).
- 2026-06-02: Wave 0+1+2 fully shipped via PRs #1 + #2 to main. Benchmark: recall@1 68.3→85.0%, recall@3 81.7→95.0%. Capture guard (PR #2) proves 0 true displacement. 1063 tests pass, build clean. Wave 3 (sub-agent recall/write-back/sleep harvesting) and Wave 4 (hook hygiene/cost/security) remain. Task bumped in_progress; Waves 3+4 are the remaining work.
- 2026-06-01: Roadmap created from four parallel subsystem audits + ECC analysis + neuroscience source. Three Wave-0 claims verified in source before commit.


## Notes

Wave 3.3 research (session 21bbee0c): SubagentStop hook event EXISTS in Claude Code (fires when sub-agent completes). Sub-agent transcripts stored at ~/.claude/projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl. session_id in SubagentStop may be the sub-agent's own ID (not parent). This enables sleep harvesting of sub-agent findings for Wave 3.3.
