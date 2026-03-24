---
id: feat_twaJVmWW
status: active
created: '2026-02-25'
updated: '2026-02-26'
released_version: 0.1.0
tags:
  - architecture
  - decisions
  - domain
related_tasks: []
---

## Why

Agents need to understand not just what was built but why — the user stories, acceptance criteria, constraints, and design decisions behind each product feature. Without structured PRDs, feature context lives only in conversation history that gets discarded. Living feature documents that update as work progresses give agents the product understanding needed to make correct implementation decisions.

## User Stories

- [x] As an AI agent, I want to create a feature PRD with a Why statement so that the product rationale is captured from the start.
- [x] As an AI agent, I want to insert content into specific feature sections (user stories, acceptance criteria, technical details, constraints, notes, changelog) without rewriting the whole file.
- [x] As an AI agent, I want the features summary shown in the context snapshot so I can see all features and their status without reading individual files.
- [x] As an AI agent, I want the snapshot to show each feature's Why, related tasks, and latest changelog entry so I can understand context at a glance.
- [x] As a developer, I want fuzzy feature lookup by name so I can reference features without typing the exact slug.
- [x] As a developer, I want feature files stored as Markdown with YAML frontmatter so they are human-readable and version-controllable.

## Acceptance Criteria

- `features create <name> [--why <why>]` creates `core/features/<slug>.md` from the feature template, with `## Why`, `## User Stories`, `## Acceptance Criteria`, `## Constraints & Decisions`, `## Technical Details`, `## Notes`, and `## Changelog` sections.
- `features insert <name> <section> <content>` inserts content into the specified section of the named feature file.
- Section aliases work: `changelog`, `notes`, `technical_details`, `constraints`, `user_stories`, `acceptance_criteria`, `why`.
- Changelog inserts are auto-prefixed with `### <date> - Update\n- <content>` and placed at the top of the section (LIFO).
- Constraint inserts are auto-prefixed with `- **[<date>]** ` and placed at the top (LIFO).
- All other section inserts are appended at the bottom.
- The `updated` frontmatter field is set to today's date after every insert.
- Feature lookup is fuzzy: exact slug → prefix match → substring match.
- The context snapshot features section shows: status, tags, first line of Why (up to 120 chars), related tasks from frontmatter, and latest non-creation changelog entry.

## Constraints & Decisions

- **[2026-02-25]** Feature files live in `_dream_context/core/features/` (under core, not state) because they are product knowledge, not active work items. Tasks live in `state/`.
- **[2026-02-25]** The template is loaded from `src/templates/feature.md` at runtime (with inline fallback). This allows the template to be customized at the package level.
- **[2026-02-25]** `related_tasks` is a frontmatter array field, not a section. It links a feature to task slugs. Updated via direct Edit, not via the `features insert` command.
- **[2026-02-25]** Status values are not enforced by the CLI — any string is valid. Recommended values: `planning`, `active`, `paused`, `shipped`, `archived`.

## Technical Details

**Feature file location**: `_dream_context/core/features/<slug>.md`

**Feature file schema**:
```yaml
---
id: "feat_abc123"
status: "active"
created: "2026-02-25"
updated: "2026-02-25"
released_version: null
tags: ["backend", "api"]
related_tasks: ["implement-auth", "write-api-docs"]
---

## Why
...

## User Stories
...

## Acceptance Criteria
...

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

## Technical Details
...

## Notes
...

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-02-25 - Created
- Feature PRD created.
```

**Commands** (`src/cli/commands/features.ts`):
- `features create <name>` — loads template, substitutes `{{ID}}`, `{{DATE}}`, `{{WHY}}`, writes file.
- `features insert <name> <section> [content...]` — maps section alias to heading, calls `insertToSection()`, updates frontmatter.

**Section alias map**:
```
changelog         → "Changelog"
notes             → "Notes"
technical_details → "Technical Details"
constraints       → "Constraints & Decisions"
user_stories      → "User Stories"
acceptance_criteria → "Acceptance Criteria"
why               → "Why"
```

**Snapshot integration** (`src/cli/commands/snapshot.ts`): For each feature file, reads frontmatter for `status`, `tags`, `related_tasks`; reads `## Why` section for first non-placeholder line; reads `## Changelog` for latest non-creation entry header + bullet. Truncates both to 120 characters.

**Library dependencies**:
- `src/lib/frontmatter.ts` — `updateFrontmatterFields()`
- `src/lib/markdown.ts` — `insertToSection()`, `readSection()`
- `src/lib/id.ts` — `generateId('feat')`, `slugify()`, `today()`

## Notes

- The `features insert` command is designed for incremental updates during active work. For wholesale rewrites or complex restructuring, use the Edit tool directly on the feature file.
- The snapshot deliberately truncates Why and changelog entries rather than omitting them — even a 120-char preview gives enough context to decide whether to read the full file.
- `released_version` can be set manually when a feature ships to track which npm package version included it.
- There is no `features list` command — use `Glob _dream_context/core/features/*.md` or read the snapshot's Features section.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-02-25 - Created
- Feature PRD created.
