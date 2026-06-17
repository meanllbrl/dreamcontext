---
id: know_ds_migration
name: "Data-Structures → Knowledge Migration & Ownership"
description: "Rationale and ownership routing for the data-structures → knowledge/ migration (issue #12). Covers why schemas moved, the new canonical path, sleep-product ownership, and migration mechanics."
tags:
  - architecture
  - decisions
  - domain:knowledge
  - database
pinned: false
date: "2026-06-09"
---

## Why This Exists

Schemas and data-model files used to live in `_dream_context/core/data-structures/` and were owned by `sleep-state`. This was the wrong home: schemas are *domain knowledge*, not identity files. By keeping them in `core/` they were excluded from recall indexing, staleness tracking, pinning, and the knowledge UI. Issue #12 (shipped 2026-06-09) moved them to `knowledge/data-structures/` and shifted ownership to `sleep-product`.

## The Migration

**Before**: `core/data-structures/<product>.md` (or `default.md`)
**After**: `knowledge/data-structures/<product>.md` (or `default.md`)

What changed across the codebase:

- `src/cli/commands/init.ts` — scaffolds `knowledge/data-structures/` instead of `core/data-structures/`.
- `src/cli/commands/doctor.ts` — validates the new location; idempotent migration moves `core/data-structures/*.md` → `knowledge/data-structures/*.md` with frontmatter enrichment (`type: data-structures`, `product`, `tags: [data-structures, database, schema]`). Emits a migration hint when the old `core/data-structures/` dir is still present — does NOT delete it (user confirms).
- `src/lib/knowledge-index.ts` — `buildKnowledgeIndex()` now globs `knowledge/**/*.md` (recursive) so subdirectory files are indexed.
- `skill/SKILL.md` — load-table, multi-product section, structure diagram, and command reference updated to `knowledge/data-structures/`.
- Agent files (`agents/sleep-state.md`, `agents/sleep-product.md`) and all mirrors (`.codex/agents/prompts/`, `.claude/agents/`) updated for ownership shift.

## New Ownership Rules

**Who writes schemas**: `sleep-product` (not `sleep-state`).

The sleep-product protocol (Pass B6) owns data-structures:
- **Single-observation gate**: unlike prefs/decisions (two-observation), a schema change is reflected in the *same* consolidation cycle. If the diff shows a model/table change, write it now.
- **Routing**: active task has `product: X` → `knowledge/data-structures/X.md` (create if missing); otherwise single-product → `knowledge/data-structures/default.md`.

**sleep-state no longer routes "schema/table/model change → core/data-structures/"** — that routing was dropped from the sleep-state agent prompt.

## Benefits

1. **Recall-indexed**: `memory recall "user schema"` finds `knowledge/data-structures/default.md` just like any other knowledge file.
2. **Staleness tracking**: `knowledge_access` map and snapshot staleness flags (30-day threshold) now apply to schemas.
3. **Pinnable**: schemas can be `pinned: true` to auto-load in the snapshot.
4. **Dashboard SQL highlighting**: data-structures appear under the Knowledge view with full SQL syntax highlighting (highlight.js, theme-aware). **Requires the body to be a fenced \`\`\`sql block** — a bare `--` comment body renders as plain markdown paragraphs and receives no highlighting. The `migrateDataStructures` helper automatically wraps unfenced bodies in the fence; new projects get the fenced template via `dreamcontext init`.

## Data-Structures Frontmatter Convention```yaml
---
name: default
type: data-structures
product: default     # or the product name
tags:
  - data-structures
  - database
  - schema
---```## Body Convention: ```sql Fenced Block

Every data-structures file body MUST be a single `\`\`\`sql` fenced block. Write all documentation as SQL comments (`-- ...`) inside the fence. This is the only format the dashboard highlights.

- `migrateDataStructures` (runs on every `sleep start`) wraps unfenced bodies in a `\`\`\`sql` fence automatically.
- `dreamcontext init` scaffolds new files with a fenced template.
- `sleep-product` should write schema updates inside the existing fence.

## Legacy Files

- Old `core/data-structures/*.md` — left in place for user projects; `doctor` nags to remove them. The dreamcontext repo's own `core/data-structures/` has been removed (confirmed 2026-06-09).
- Legacy `core/5.data_structures.sql` — if it still exists and `knowledge/data-structures/default.md` does not, copy + migrate. `doctor` nags about this too. The dreamcontext repo's own `core/5.data_structures.sql` has been removed (confirmed 2026-06-09).
- Never delete the old dirs in user projects yourself; the user confirms removal after `doctor` guidance.

## Sources

- GitHub issue #12: https://github.com/meanllbrl/dreamcontext/issues/12
- Task: `_dream_context/state/data-structures-to-knowledge.md`
- Feature PRD: `_dream_context/core/features/knowledge-base.md`

## Last Verified

2026-06-09
