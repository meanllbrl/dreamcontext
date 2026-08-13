---
id: knowledge_retire_capability
name: retire-shipped-capability-properly
description: >-
  When retiring a shipped, documented capability (not refactoring, but DELETING
  a whole subsystem): document what's being deleted and why, state what
  replaces it, update all related docs/PRDs/references, delete code in the
  right order (repoint importers first), and leave a clear trail so future
  sessions understand the decision.
type: knowledge
tags:
  - kind:pattern
  - architecture
  - documentation
pinned: false
created: '2026-08-11'
---

# Retire a Shipped Capability Properly

## Why this exists

Refactoring is common; **retiring a shipped, user-visible capability** is rare and high-stakes. When a subsystem that was documented, shipped to users, and integrated into workflows is completely removed (not just rewritten), the deletion leaves ghosts: stale documentation claiming the feature exists, references in related PRDs, user questions about where it went, and confusion for future sessions reading history. A proper retirement documents the decision, updates all traces, and leaves a clear replacement path.

## The pattern

When retiring a shipped capability (not internal refactoring, but user-visible feature deletion):

### 1. Document the retirement decision

**Where:** The feature PRD (if one exists) or a dedicated knowledge file.

**What to capture:**
- What capability is being retired (its name, what it did)
- Why it's being retired (what friction it created, why the replacement is better)
- What replaces it (the new model/architecture/workflow)
- When it was retired (date range: when it shipped, when it was deleted)
- What was deleted (file list: modules, UI components, tests)

**Format:** A new section in Constraints & Decisions (for PRDs) or a standalone retirement note (for capabilities without PRDs).

### 2. Update all related documentation

**Checklist:**
- [ ] Feature PRD (if exists) — add retirement entry, update Technical Details to reflect new architecture
- [ ] Related PRDs that reference the retired capability — remove/update references
- [ ] Skill references (e.g., `skill/references/*.md`) — remove instructions for the retired capability
- [ ] CLI reference — remove commands/flags that no longer exist
- [ ] Knowledge files that reference it — update or archive

### 3. Delete code in the right order

**Rule:** When the retired module has importers, deletion must be LAST.

**Steps:**
- Map all importers of the module being deleted (`grep -rn "from './review.ts'"`)
- Each importer repoints itself in a prior wave/commit
- Deletion comes last, with a zero-reference proof (`grep -rn 'deleted-module' returns empty`)

**Why:** Deleting early breaks the build for every wave/commit that still imports it. The intermediate states must compile.

### 4. Leave a clear trail for future sessions

**Audit questions a future session should be able to answer:**
- "Did we ever have X?" → Yes, see PRD section Y or knowledge file Z
- "Why was it removed?" → See retirement decision (link)
- "What do I use instead?" → See replacement model (link)
- "When did this happen?" → Dates + commit SHA

**Anti-pattern:** Deleting files, removing all documentation, and leaving no record. A future session re-proposes the same capability, unaware it was tried and retired.

## When to use it

- Retiring a **user-visible** capability (a feature, a CLI command, a dashboard page, an integration) — something users relied on or documentation mentioned
- Complete removal (the capability is GONE, not just rewritten) — files deleted, not just refactored
- Shipped long enough to have external references (docs, related PRDs, user workflows)

## When NOT to use it

- Internal refactoring (same capability, different implementation) — this is just code churn
- Prototypes or experimental features that never shipped — no external references exist
- Deprecation (capability still exists, just discouraged) — mark as deprecated, don't retire yet

## Two occurrences (qualifying this as a pattern)

### Occurrence 1: Task-manager pane retirement (2026-08-04)

The automations task-manager pane (a dedicated board for managing automation runs, separate from the main automations board) was retired in favor of inline run cards on the automations board itself. Shipped under earlier commits, removed in `f9ffba0`.

**What was done right:**
- Feature PRD (`automations-scheduled-headless-claude-jobs.md`) documented the change in Constraints & Decisions
- Dashboard component deleted (`AutomationsTaskManager.tsx`)
- Route removed from server

**What was missed (first occurrence, learning opportunity):**
- No explicit "what replaces it" statement in the PRD (had to infer from context)
- Related skill references not updated in the same commit

### Occurrence 2: Review-queue model retirement (2026-08-10/11, automations redesign)

The review-queue model (HITL questions living on a separate review-queue board, with review cards at `automations/review/<slug>/<id>.json`) was retired after only five commits. Replaced by flow-graph architecture with questions in `automations/hitl/` answerable from chat/CLI/Telegram.

**What was done right:**
- Feature PRD (`automations-scheduled-headless-claude-jobs.md`) added a detailed Constraints & Decisions entry documenting: what was deleted (file list), what replaces it (flow-graph + HITL questions), why (nine owner-identified friction points), and the new model's architecture
- Technical Details section completely rewritten to reflect new architecture
- Deleted files listed explicitly: `review.ts`, `card-registry.ts`, `AutomationsReviewQueue.tsx/.css`, tests
- Skill references (`skill/references/automations.md`) updated
- Deletion was LAST (W9) after six importers repointed themselves in prior waves
- Zero-reference grep proof in wave gate

**Pattern confirmed:** Two occurrences, same shape (user-visible capability → complete removal → documentation + code deletion in right order).

## The litmus test

Ask: **"If a future session asks 'did we ever have X?', can they find the answer without asking the user?"** If no, document the retirement.

## Sources

- Task `automations-hitl-a-run-can-stop-and-ask...` (f9ffba0, task-manager pane retired)
- Task `automations-redesign-the-flow-graph-is-the-manifest...` (review-queue retired, 2026-08-10/11)
- Pattern discussion in sleep cycles 2026-08-09, 2026-08-10, 2026-08-11 (deferred twice, created on third occurrence)

## Last verified

2026-08-11
