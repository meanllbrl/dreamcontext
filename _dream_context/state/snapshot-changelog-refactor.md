---
id: task_6aERBNKQ
name: snapshot-changelog-refactor
description: >-
  Refactor context snapshot changelog display to tiered format; remove
  DREAMCONTEXT_MEMORY_HOOK env gate (memory recall on by default);
  council-reviewed plan for memory.md→decisions.md migration and changelog
  schema changes
priority: medium
urgency: medium
status: in_progress
created_at: '2026-05-23'
updated_at: '2026-05-23'
tags: []
parent_task: null
related_feature: null
version: v0.4.0
---

## Workflow

```mermaid
flowchart TD
  subgraph M1 ["M1 — Snapshot + recall defaults"]
    A1[DREAMCONTEXT_MEMORY_HOOK env gate removed — recall on by default]:::done
    A2[Snapshot changelog tiered display — Tier1 top 3 with body preview, Tier2 next 10 headline-only]:::done
    A3[memory.md LIFO ship-narrative section removed — ship events route to CHANGELOG]:::done
    A4[CHANGELOG.json added to memory recall BM25 corpus]:::done
    A5[SKILL.md + agent docs updated to reflect new defaults]:::done
  end
  subgraph M2 ["M2 — Changelog schema (pending user direction)"]
    B1[Council plan: summary field + references[] + Option E shipping order]:::active
    B2[Implement summary field in CHANGELOG schema]:::todo
    B3[Implement references[] as flat string[] with prefix convention]:::todo
    B4[Migrate existing 82 entries backfill]:::todo
  end
  subgraph M3 ["M3 — memory.md rename decision (pending)"]
    C1[Decide: rename 2.memory.md to 2.decisions.md or keep filename]:::todo
    C2[If rename: doctor auto-migration + setupVersion gating]:::todo
  end
  A5 --> B1

  classDef done fill:#86efac,stroke:#15803d,color:#052e16
  classDef active fill:#fde68a,stroke:#b45309,color:#451a03
  classDef todo fill:#e5e7eb,stroke:#6b7280,color:#111827
  classDef blocked fill:#fecaca,stroke:#b91c1c,color:#450a0a
```

## Why

The snapshot changelog section was loading 5 full-description entries (~1000 tokens wasted on history the agent rarely needs immediately). The `DREAMCONTEXT_MEMORY_HOOK=1` opt-in gate was friction with no benefit — recall was always safe to run. A plan to add a `summary` field to CHANGELOG (for richer snapshot/recall display) and a `references[]` field (for linking to commits/files/tasks) was developed by a council pattern and adversarially reviewed.

## User Stories

- [x] As an agent starting a session, I see the 3 most recent changelog entries with a headline + body preview, and the next 10 as headlines only — saving ~700 tokens vs the old 5-full-descriptions format.
- [x] As an agent using `dreamcontext memory recall`, CHANGELOG entries are in the BM25 corpus so "what shipped in scope X?" queries return ship events.
- [x] As a user, memory recall is on by default — no env gate to set.
- [ ] As the main agent logging a changelog entry, I can provide a short `summary` (≤ ~200 chars) and a full `description`, with optional `references[]` for commit/file/task links.
- [ ] As an agent doing "what changed in scope X?", I can use `--types changelog` to scope recall to ship events only.

## Acceptance Criteria

- [x] `DREAMCONTEXT_MEMORY_HOOK` env gate removed from UserPromptSubmit hook — memory recall runs on every session by default
- [x] Snapshot changelog: Tier 1 (top 3) shows summary headline + up to 300-char description preview; Tier 2 (next 10) shows one-line headline only; both tiers use `summary` if present, fall back to truncated `description`
- [x] memory.md LIFO "ship narrative" section removed — agents directed to use CHANGELOG for ship events
- [x] `core/CHANGELOG.json` indexed in BM25 recall corpus alongside knowledge/feature/task/memory
- [x] SKILL.md + dreamcontext-explore agent docs updated to reflect default-on recall and changelog corpus inclusion
- [ ] CHANGELOG schema: `summary` field (mandatory, ≤200 chars) + `references[]` (flat string[], prefixed: `commit:|file:|knowledge:|feature:|task:|url:|note:`) added and documented
- [ ] Existing 82 CHANGELOG entries backfilled with `summary` (first-sentence extraction)
- [ ] `core releases add` and `core changelog add` CLI commands updated to prompt/accept `summary` and `references`

## Constraints & Decisions

- **[2026-05-23]** Council reviewer (Option E) rejected `descriptionDetailed` split — `description` field is already long-form (mean 522 chars). Pivot: add `summary` as a mandatory short lead; keep `description` for full content.
- **[2026-05-23]** `references[]` as flat `string[]` with prefix convention — rejected structured `{type, value}[]` (30% more bytes, identical expressive power).
- **[2026-05-23]** Reviewer found blast radius of rename (2.memory.md → 2.decisions.md) is 40 files (not 18 as planned) — rename is deferred pending user decision. Option B (keep filename, swap snapshot heading) is the fallback.
- **[2026-05-23]** Reviewer found `CORE_ALIASES` symbol in planner's §7.1 is hallucinated — that step must be dropped from any implementation plan.
- **[2026-05-23]** PR ordering: schema first (independent win) is fine; rename last (if at all). Reviewer's inversion concern addressed by dropping the rename to optional.
- **[2026-05-23]** Recall corpus addition does NOT delete LIFO from memory.md — the concern was that removing LIFO without indexing CHANGELOG would create a recall gap. CHANGELOG is now indexed, so the LIFO removal is safe.

## Technical Details

Shipped (Phase 1 — done):
- `src/hooks/user-prompt-submit.ts` — `DREAMCONTEXT_MEMORY_HOOK` env gate removed; recall always injected
- `src/cli/commands/snapshot.ts` — tiered changelog display: `CHANGELOG_TIER1=3` (summary + 300-char body), `CHANGELOG_TIER2=10` (headline, 140-char cap); both use `summary` field when present
- `src/lib/recall.ts` — CHANGELOG corpus type `changelog` added; `--types changelog` flag supported; existing `memory` type unchanged
- `skill/SKILL.md` + `agents/dreamcontext-explore.md` — updated to reflect new defaults and `--types changelog` usage

Pending (Phase 2 — schema):
- `src/cli/commands/core/changelog.ts` — add `--summary` and `--references` flags to `core changelog add`
- `src/cli/commands/core/releases.ts` — add `--summary` and `--references` to `core releases add`
- `_dream_context/core/CHANGELOG.json` — backfill `summary` on 82 existing entries (first-sentence extraction)

## Notes

- memory.md rename to decisions.md: 40-file blast radius confirmed. Reviewer recommends Option B (keep filename `2.memory.md`, update snapshot heading label to "Decisions & Open Issues") as the safer path — no rename, no migration. User decision required before Phase 3 starts.
- `dreamcontext memory remember` now writes a CHANGELOG entry (type `note`, scope `quick`) rather than a LIFO section in `2.memory.md` — documented in SKILL.md.


Session 0459cdb8 decision: link-aware BM25 boost and embedding overlay both deferred. BM25 already achieves 94.7% top-1, 100% top-5 on current corpus. Decision: gather a gold-set of queries where BM25 fails before investing in either approach. When 5-10 failure examples accumulate, evaluate link-aware boost (~2h, no new deps) first; embedding overlay (MiniLM, ~1 day) only if boost insufficient.
## Changelog
<!-- LIFO: newest at top. Auto-prepended by `dreamcontext tasks log`. -->



### 2026-05-23 - Status → in_review
- Tier-1/2 snapshot changelog shipped; DREAMCONTEXT_MEMORY_HOOK env gate removed; CHANGELOG added to recall corpus; council plan reviewed (APPROVE WITH SIGNIFICANT CHANGES). Remaining work: changelog schema (summary+references[]) and memory.md rename decisions pending user direction.
### 2026-05-23 - Session Update
- Session cbea2a55: removed DREAMCONTEXT_MEMORY_HOOK env gate (memory recall now on by default); refactored snapshot changelog to tiered display (Tier1=top 3 with summary+300-char body preview, Tier2=next 10 headline-only); memory.md LIFO ship-narrative section removed (ship events routed to CHANGELOG); memory recall corpus extended to include CHANGELOG.json entries; council-reviewed plan for changelog schema (summary field + references[]) and memory.md→decisions.md rename — plan APPROVED WITH SIGNIFICANT CHANGES (reviewer rejected descriptionDetailed, flagged blast-radius undercount, hallucinated CORE_ALIASES symbol, inverted PR ordering risk, recall gap on CHANGELOG deletion); SKILL.md and agent docs updated to reflect new defaults
### 2026-05-23 - Created
- Task created.
