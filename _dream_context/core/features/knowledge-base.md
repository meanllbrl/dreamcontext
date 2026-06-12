---
id: feat_jI0huqeH
status: active
created: '2026-02-25'
updated: '2026-06-12'
released_version: 0.1.0
tags:
  - architecture
  - backend
  - decisions
related_tasks:
  - data-structures-to-knowledge
  - issue-20-excalidraw-knowledge
---

## Why

Core context files have a ~200 line limit to stay lightweight. When deep research, architectural context, or domain knowledge grows too large for the core files, it needs a home that is still discoverable. The knowledge base provides tagged, indexable files that the snapshot auto-indexes every session, with a pinning mechanism for critical files that should always be loaded in full.

## User Stories

- [x] As an AI agent, I want to create a knowledge file with a name, description, tags, and content so that detailed research is stored in a structured, discoverable way.
- [x] As an AI agent, I want the knowledge index loaded every session so I know what files exists and can load them on demand when relevant.
- [x] As an AI agent, I want to pin a knowledge file so its full content is auto-loaded every session without an extra read.
- [x] As a developer, I want to filter the knowledge index by tag so I can find relevant files quickly.
- [x] As a developer, I want a canonical list of standard tags so knowledge files are tagged consistently across projects.
- [x] As an AI agent, I want the sleep agent to extract verbose detail from core files into knowledge files to prevent bloat.
- [x] As an AI agent, I want data-structure schemas stored under `knowledge/data-structures/` so they are recall-indexed and staleness-tracked like all other knowledge files.
- [x] As a developer, I want `dreamcontext init` to scaffold schemas under `knowledge/data-structures/` so new projects land in the correct location from the start.
- [x] As a dreamcontext user, I can keep Excalidraw boards in `knowledge/` without their embedded scene JSON poisoning BM25 recall or bloating the index/snapshot, so that memory stays precise while the dashboard still renders the boards.

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
- [x] `knowledge/data-structures/<product>.md` (or `default.md`) is the canonical location for schemas/data-models; `core/data-structures/` is retired. `buildKnowledgeIndex()` recurses into subdirectories so data-structures files appear in the index.
- [x] `dreamcontext init` scaffolds `knowledge/data-structures/default.md` (or per-product files); `dreamcontext doctor` validates the new location and emits a migration hint when the old `core/data-structures/` is present.
- [x] The idempotent migration in `doctor.ts` moves `core/data-structures/*.md` → `knowledge/data-structures/*.md` and enriches frontmatter (`type: data-structures`, `product`, tags).
- [x] `sleep-product` (not `sleep-state`) owns schema routing; agent prompts and `.codex/` + `.claude/` mirrors updated.

### Excalidraw boards as first-class knowledge (#20, shipped 2026-06-12)
- [x] A `*.excalidraw.md` board contributes only frontmatter + `## Text Elements` tokens to the BM25 corpus, the knowledge index, and the snapshot — never scene JSON, base64, or `^blockref` ids. A ≥2MB board and a tiny board with identical text elements yield equal snapshot token estimates.
- [x] Extraction is applied in BOTH `src/lib/knowledge-index.ts` (`entry.content`) and `src/lib/recall.ts` (corpus `body`) — neither alone closes all memory surfaces (index, BM25, snapshot warm/pinned, list, reflection).
- [x] Dark diagram-folder siblings: in a folder directly containing a board, all non-board files (generator `.board.cjs`/spec/helper `.md`) are excluded from index/recall/list; folders without a board are unaffected.
- [x] Live flat `knowledge/diagrams/*.excalidraw.md` boards keep indexing/recalling/rendering with extraction applied — no forced migration.
- [x] Migration `0.7.2` registered as the first consumer of the #23 registry: code step is safe-detection only (records `detected`, moves nothing); the opt-in `agentTask` (`diagrams-folder-convention`) organizes boards into `knowledge/diagrams/<title>/` via `dreamcontext migrations apply-diagrams` with atomic inbound-wikilink rewrite.
- [x] Folder convention documented in `skill/SKILL.md` + `skill-packs/excalidraw/SKILL.md`: `knowledge/diagrams/<title>/<title>.excalidraw.md` (flat still works), scripts-are-dark contract, do-not-hand-edit/spec-is-source-of-truth, REQUIRED `name`+`description` frontmatter on every board (zero-text boards → description is the only recall surface).

## Constraints & Decisions

- **[2026-06-12]** Excalidraw memory/render invariant (#20): detail = raw, memory = extracted. The dashboard knowledge detail route returns the RAW body (the renderer needs the scene JSON); all memory surfaces (index content, BM25 corpus, snapshot) get only extracted text via `extractExcalidrawText()`. Extraction never returns the raw body (try/catch → `''`, frontmatter-only fallback). `src/` must not import `dashboard/src/` (separate builds) — the drawing-block regex is replicated with a cross-ref comment. Maintainer decisions (do not relitigate): migration version key = 0.7.2; snapshot relies on extraction (Option A — no new pinned-inline feature); migration code step never auto-moves flat boards (avoids silent slug/wikilink/access-record breakage) — moves are opt-in via the agentTask.
- **[2026-06-09]** Data-structures migration (issue #12): `buildKnowledgeIndex()` was changed from `glob('knowledge/*.md')` to `glob('knowledge/**/*.md')` to recurse into subdirectories. The `data-structures/` subdir keeps multi-product grouping without fragmenting the tag space. Old `core/data-structures/` dir is left in place for user confirmation before deletion; `doctor` emits a migration hint. Ownership: `sleep-state` drops the "schema/table/model change → core/data-structures/" routing; `sleep-product` now owns it (schema changes = B6 in the sleep-product protocol, single-observation gate).
- **[2026-02-25]** Knowledge files live in `_dream_context/knowledge/` as flat `.md` files or in tagged subdirs (e.g. `data-structures/`). Tags provide the primary organizational structure; subdirs are used sparingly for file-type grouping only.
- **[2026-02-25]** Standard tags (12 total): `architecture`, `api`, `frontend`, `backend`, `database`, `devops`, `security`, `testing`, `design`, `decisions`, `onboarding`, `domain`. Custom tags are allowed but standard tags are preferred for discoverability.
- **[2026-02-25]** Pin sparingly — pinned files inflate snapshot size on every session. Reserve pinning for files needed in nearly every session (e.g., a complex auth flow referenced constantly).
- **[2026-02-25]** Knowledge files have no `## Changelog` section by default. They are research artifacts, not work items. They can be edited directly without CLI scaffolding.

## Technical Details

**Knowledge file locations**:
- `_dream_context/knowledge/<slug>.md` — general knowledge (flat)
- `_dream_context/knowledge/data-structures/<product>.md` — schemas/models (subdirectory; `default.md` for single-product)
- `_dream_context/knowledge/products/<product>.md` — per-product knowledge in multi-product projects

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
- `buildKnowledgeIndex(contextRoot)` — globs `knowledge/**/*.md` (recursive), reads frontmatter, returns `KnowledgeEntry[]`.
- Sort order: pinned first, then alphabetical by slug.
- `KnowledgeEntry` fields: `slug`, `name`, `description`, `tags`, `date`, `pinned`, `content` (full body text).
- Subdirectory slugs are based on filename only (not the full relative path) to keep recall keys short.

**Excalidraw text extraction** (`src/lib/excalidraw-text.ts`, pure, no fs):
- `EXCALIDRAW_SUFFIX = '.excalidraw.md'`; `isExcalidrawPath(path)`.
- `extractExcalidrawText(rawBody)`: keeps only `## Text Elements` labels; strips the `## Drawing` block (both ```json and ```compressed-json forms), `## Embedded Files`, the Obsidian banner, and trailing `^blockref` suffixes; collapses blanks; slices to 200 lines; returns `''` on no-parse or error.
- Dark-sibling helpers: `diagramFolderDirs(allFiles)` (dirnames directly containing ≥1 board, computed once per glob) + `isDarkDiagramSibling(filePath, dirsSet)`.
- Wired into `knowledge-index.ts` (after glob: skip dark siblings; board content = extracted text) and `recall.ts` `loadMarkdownDocs` (same two edits; safe no-op for feature/task channels).

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

### 2026-06-12 - Excalidraw boards as first-class knowledge (#20, PR #28)
- `src/lib/excalidraw-text.ts`: extraction (frontmatter + Text Elements only) + dark diagram-folder siblings; wired into both `knowledge-index.ts` and `recall.ts`.
- Dashboard: nested `diagrams/{title}/` grouping with basename leaf labels; detail route stays raw (renderer invariant).
- Migration 0.7.2 registered (first #23 registry consumer): detection-only code step + opt-in `apply-diagrams` agentTask with atomic wikilink rewrite.
- Folder convention + scripts-are-dark contract documented in `skill/SKILL.md` and `skill-packs/excalidraw/SKILL.md`.

### 2026-06-09 - Data-structures → knowledge migration (#12): subdir support + ownership shift
- `buildKnowledgeIndex()` now recurses into subdirectories (`knowledge/**/*.md`); data-structures files appear in the recall corpus and snapshot index automatically.
- `dreamcontext init` scaffolds `knowledge/data-structures/default.md` (or per-product) instead of `core/data-structures/`.
- `dreamcontext doctor` validates the new location; idempotent migration moves old `core/data-structures/*.md` files with frontmatter enrichment.
- Ownership: `sleep-product` now owns schema routing (B6, single-observation gate); `sleep-state` drops it.

### 2026-02-25 - Created
- Feature PRD created.
