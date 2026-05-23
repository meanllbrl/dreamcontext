---
id: "feat_mPr0d4Ct"
status: "in_review"
created: "2026-05-22"
updated: "2026-05-22"
released_version: null
tags: ["architecture", "domain", "onboarding"]
related_tasks: []
---

## Why

Developers working on monorepos or product portfolios own multiple distinct products. Without product boundaries, all tasks, knowledge, and data structures collapse into a single global pool — decisions for Product A bleed into Product B context, agent sessions become noisy, and per-product architectural knowledge has no home.

Multi-product support introduces a lightweight product namespace: per-product data structures, per-product knowledge files, and optional `product:` frontmatter on tasks. The most important capability is automatic per-product knowledge injection at session start — when the active task carries `product: X`, the session hook injects `knowledge/products/X.md` into the snapshot without any tool call from the agent.

## User Stories

- [x] As a developer, I want to declare my products during `dreamcontext init` (or `setup`) via `--multi-product=a,b,c` so the directory structure is created correctly from the start.
- [x] As a developer, I want per-product data structures at `_dream_context/core/data-structures/<product>.md` so each product's schema lives in its own file.
- [x] As a developer, I want per-product knowledge at `_dream_context/knowledge/products/<product>.md` so cross-cutting research for a product is always findable and auto-injectable.
- [x] As an AI agent, I want the active product's knowledge injected automatically at session start when the active task has `product: <name>`, so I never need to manually load it.
- [x] As a developer, I want task frontmatter to support `product: <name>` so tasks are linked to a product scope.
- [ ] As a developer, I want the dashboard to surface a product filter when multiProduct is configured, so I can view tasks by product.
- [ ] As a sleep specialist, I want per-product knowledge stubs (Pass C in sleep-product) so new products get a knowledge scaffold during sleep consolidation.

## Acceptance Criteria

- [x] `dreamcontext init --multi-product=a,b` creates `core/data-structures/a.md`, `core/data-structures/b.md`, and `knowledge/products/a.md`, `knowledge/products/b.md`.
- [x] Single-product projects use `core/data-structures/default.md` (unchanged behavior).
- [x] `_dream_context/state/.config.json` stores `multiProduct: string[] | false`; `false` (or missing) means single-product.
- [x] `snapshot.ts` `getActiveProductKnowledge()` reads `.config.json`, resolves active task, checks `product:` frontmatter, loads matching `knowledge/products/<name>.md` body (stripped of frontmatter), caps at 200 lines with pointer to full file.
- [x] Snapshot injects the product knowledge under `## Active Product Knowledge: <name>` with auto-injection note.
- [x] If `.config.json` is absent or `multiProduct` is false, `getActiveProductKnowledge()` returns empty and the snapshot is unaffected.
- [x] `SKILL.md` documents the multi-product convention: per-product data structures, per-product knowledge, `product:` task frontmatter, `.config.json` `multiProduct` list, auto-injection behavior.
- [ ] Dashboard task filter includes product filter when `multiProduct` is configured.
- [ ] `sleep-product` Pass C: for each product in `multiProduct`, ensure `knowledge/products/<product>.md` exists; create stub if missing.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-05-22]** Product knowledge injection is fully automatic via the SessionStart hook — agents never need to remember to load it. The hook calls `generateSnapshot()` which calls `getActiveProductKnowledge()` on every session start.
- **[2026-05-22]** `product:` on task frontmatter is optional. Tasks without it work normally; the product-knowledge injection simply does not fire.
- **[2026-05-22]** Feature PRDs may include `product: <name>` in frontmatter for product scoping, but they still live in the flat `core/features/` directory. No per-product features subdirectory.
- **[2026-05-22]** Cross-cutting knowledge lives at the top-level `knowledge/`. Per-product knowledge (product-specific decisions, patterns, domain context) lives at `knowledge/products/<product>.md`. The two are complementary, not exclusive.
- **[2026-05-22]** `data-structures/default.md` is the fallback for single-product projects. The SKILL.md instructs agents to check `.config.json` `multiProduct` before deciding which data-structures file to load. No magic fallback — agents use the schema doc explicitly.

## Technical Details

**Key code locations**:
- `src/cli/commands/snapshot.ts` — `getActiveProductKnowledge()` (lines ~200–271), `generateSnapshot()` injects at line ~338.
- `src/cli/commands/init.ts` — `--multi-product` flag (or `--multi-product=a,b` shorthand); creates `core/data-structures/<product>.md` + `knowledge/products/<product>.md` per product.
- `src/lib/setup-config.ts` — `SetupConfig.multiProduct: false | string[]`.
- `skill/SKILL.md` — "Multi-Product Binding" section documents the full convention.
- `agents/sleep-product.md` — Pass C (per-product knowledge bootstrap) specced but conditional on `.config.json`.

**`getActiveProductKnowledge` logic**:
1. `readSetupConfig(root)` — if no config or `multiProduct` is not an array: return `[]`.
2. `resolveActiveTaskPath(root)` — `.active-task` override file or most-recently-modified `in_progress` task.
3. Read active task frontmatter → `data.product`.
4. Check `product` is in `config.multiProduct`.
5. Read `knowledge/products/<product>.md`, strip frontmatter, cap at 200 lines.
6. Return lines for the `## Active Product Knowledge: <name>` snapshot section.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-05-22 - Created
- Feature PRD created from v0.4 session. Snapshot injection (steps 1-6 above) is live. Dashboard product filter and sleep-product Pass C remain pending.
