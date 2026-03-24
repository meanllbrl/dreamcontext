---
id: feat_jI0huqeH
status: active
created: '2026-02-25'
updated: '2026-02-26'
released_version: 0.1.0
tags:
  - architecture
  - backend
  - decisions
related_tasks: []
---

## Why

Core context files have a ~200 line limit to stay lightweight. When deep research, architectural context, or domain knowledge grows too large for the core files, it needs a home that is still discoverable. The knowledge base provides tagged, indexable files that the snapshot auto-indexes every session, with a pinning mechanism for critical files that should always be loaded in full.

## User Stories

- [x] As an AI agent, I want to create a knowledge file with a name, description, tags, and content so that detailed research is stored in a structured, discoverable way.
- [x] As an AI agent, I want the knowledge index loaded every session so I know what files exist and can load them on demand when relevant.
- [x] As an AI agent, I want to pin a knowledge file so its full content is auto-loaded every session without an extra read.
- [x] As a developer, I want to filter the knowledge index by tag so I can find relevant files quickly.
- [x] As a developer, I want a canonical list of standard tags so knowledge files are tagged consistently across projects.
- [x] As an AI agent, I want the REM sleep agent to extract verbose detail from core files into knowledge files to prevent bloat.

## Acceptance Criteria

- `knowledge create <name>` creates `knowledge/<slug>.md` with frontmatter (id, name, description, tags, pinned: false, date) and body content.
- `knowledge index` lists all knowledge files with slug, description, and tags. Pinned files are visually distinguished.
- `knowledge index --tag <tag>` filters to only files matching that tag (case-insensitive).
- `knowledge index --plain` outputs plain text suitable for piping.
- `knowledge tags` lists all 12 standard tags.
- Knowledge index in the context snapshot shows: slug, path, description, and tags. Sorted pinned-first, then alphabetical by slug.
- Pinned files (frontmatter `pinned: true`) are included in full in the snapshot's Pinned Knowledge section.
- Non-pinned files appear in the index only; agents load them on demand.
- Setting `pinned: true` on a knowledge file's frontmatter is done by direct Edit (no dedicated CLI command needed).

## Constraints & Decisions

- **[2026-02-25]** Knowledge files live in `_dream_context/knowledge/` as flat `.md` files (no subdirectories). Tags provide the organizational structure instead of folders.
- **[2026-02-25]** Standard tags (12 total): `architecture`, `api`, `frontend`, `backend`, `database`, `devops`, `security`, `testing`, `design`, `decisions`, `onboarding`, `domain`. Custom tags are allowed but standard tags are preferred for discoverability.
- **[2026-02-25]** Pin sparingly — pinned files inflate snapshot size on every session. Reserve pinning for files needed in nearly every session (e.g., a complex auth flow referenced constantly).
- **[2026-02-25]** Knowledge files have no `## Changelog` section by default. They are research artifacts, not work items. They can be edited directly without CLI scaffolding.

## Technical Details

**Knowledge file location**: `_dream_context/knowledge/<slug>.md`

**Knowledge file schema**:
```yaml
---
id: "know_abc123"
name: "JWT Authentication Flow"
description: "Complete JWT auth flow with refresh tokens and rotation strategy"
tags: ["security", "api", "decisions"]
pinned: false
date: "2026-02-25"
---

Full content of the knowledge file here...
```

**Commands** (`src/cli/commands/knowledge.ts`):
- `knowledge create <name>` — interactive prompts for description, tags (comma-separated), and content if not provided via flags.
- `knowledge index [--tag <tag>] [--plain]` — reads all `knowledge/*.md` via `buildKnowledgeIndex()`.
- `knowledge tags [--plain]` — outputs the `STANDARD_TAGS` array from `src/lib/knowledge-index.ts`.

**Index builder** (`src/lib/knowledge-index.ts`):
- `buildKnowledgeIndex(contextRoot)` — globs `knowledge/*.md`, reads frontmatter, returns `KnowledgeEntry[]`.
- Sort order: pinned first, then alphabetical by slug.
- `KnowledgeEntry` fields: `slug`, `name`, `description`, `tags`, `date`, `pinned`, `content` (full body text).

**Snapshot integration** (`src/cli/commands/snapshot.ts`):
- Calls `buildKnowledgeIndex(root)` to get all entries.
- Emits Knowledge Index section with one line per entry.
- For pinned entries, emits full content under Pinned Knowledge section.

**Library dependencies**:
- `src/lib/knowledge-index.ts` — `buildKnowledgeIndex()`, `STANDARD_TAGS`
- `src/lib/frontmatter.ts` — `writeFrontmatter()`
- `src/lib/id.ts` — `generateId('know')`, `slugify()`, `today()`

## Notes

- The REM sleep agent (`agents/dreamcontext-rem-sleep.md`) is the primary consumer of `knowledge create` — it extracts verbose detail from core files into knowledge files when they approach 200 lines. The main agent creates knowledge files for deep research completed during a session.
- There is no `knowledge delete` command. Stale knowledge files should be identified by the REM sleep agent during anti-bloat passes and removed manually if needed.
- Knowledge tags drive the `--tag` filter in `knowledge index`. Because the snapshot always loads the full index, agents can find relevant files by scanning tags in the snapshot rather than running the index command.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-02-25 - Created
- Feature PRD created.
