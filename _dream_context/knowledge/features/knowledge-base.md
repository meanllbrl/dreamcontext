---
id: feat_jI0huqeH
status: active
created: '2026-02-25'
updated: '2026-07-19'
released_version: v0.19.0
tags:
  - architecture
  - backend
  - decisions
related_tasks:
  - issue-20-excalidraw-knowledge
  - >-
    desktop-co-located-board-folder-renders-wrong-tree-splits-the-folder-excalidraw-embedded-images-don-t-load
  - >-
    knowledge-support-topical-subfolders-for-grouping-beyond-data-structures-diagrams-products
  - >-
    knowledge-move-cannot-relocate-a-board-directory-with-its-companion-files-across-context-folders
type: feature
name: knowledge-base
description: ''
pinned: false
date: '2026-02-25'
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
- [x] As a dreamcontext user, I can place a companion `.md` knowledge file beside an Excalidraw board in the same folder and have it indexed and recalled as first-class knowledge, so that detailed teardowns or notes co-located with a board are not silently excluded from recall.
- [x] As a dreamcontext user, I can organize knowledge into arbitrary topical subfolders under `knowledge/` (not just `data-structures/` and `products/`), and `buildKnowledgeIndex()` recurses the whole tree so grouped files stay first-class across recall, dashboard, and sleep — subfolders are structural grouping, not a dark silo.
- [x] As a dreamcontext user, I can organize feature PRDs into topical/product subfolders under `knowledge/features/` (e.g. `features/lina/`, `features/memoryos/`), and the top-level folder IS the feature's product (derived from the path, single source of truth), so a feature's product never drifts from its location.

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
- [x] Dark diagram-folder siblings: in a folder directly containing a board, non-board tooling files (generator `.board.cjs`, spec JSON, frontmatter-less helper `.md`) are excluded from index/recall/list. A companion `.md` with `name:` frontmatter is NOT dark — it is indexed as first-class knowledge (shipped 2026-06-17, PR #35 / commit e110d9f).
- [x] Live flat `knowledge/diagrams/*.excalidraw.md` boards keep indexing/recalling/rendering with extraction applied — no forced migration.
- [x] Migration `0.7.2` registered as the first consumer of the #23 registry: code step is safe-detection only (records `detected`, moves nothing); the opt-in `agentTask` (`diagrams-folder-convention`) organizes boards into `knowledge/diagrams/<title>/` via `dreamcontext migrations apply-diagrams` with atomic inbound-wikilink rewrite.
- [x] Folder convention documented in `skill/SKILL.md` + `skill-packs/excalidraw/SKILL.md`: `knowledge/diagrams/<title>/<title>.excalidraw.md` (flat still works), scripts-are-dark contract, do-not-hand-edit/spec-is-source-of-truth, REQUIRED `name`+`description` frontmatter on every board (zero-text boards → description is the only recall surface).
- [x] Self-contained board folders (a board + its `.board.cjs` generator + a companion teardown `.md` + an `assets/` image subfolder, all co-located) render as ONE grouped node in the dashboard knowledge tree — the folder is never split with the board hoisted to the parent level while a sibling card stays behind (fixed 2026-06-30, desktop bug report; see Constraints & Decisions).
- [x] Embedded board images stored in a sibling `assets/` subfolder (not just the board's own directory or an `Attachments/` folder) resolve and render via `GET /api/knowledge-assets/:slug` — a bare `[[image.png]]` wikilink now matches `boardDir/assets/<basename>` in addition to the pre-existing candidates.
- [x] The board builder (`build_excalidraw.js`) refuses to write a board with ANY dangling embedded-image reference — a pre-flight collects every missing asset across the whole spec and fails once with the complete list, rather than throwing on the first missing image mid-build (which could leave a partially-written board with silent gaps).
- [x] Knowledge supports arbitrary topical subfolders — `buildKnowledgeIndex()` globs `knowledge/**/*.md` recursively (not just the flat root), and slugs are basename-only (not full relative path) so recall keys stay short and wikilinks stay portable across moves.
- [x] Features support topical/product subfolders — `dreamcontext features create <name> --folder <product>` writes to `features/<product>/<name>.md`; `dreamcontext features move <name> <folder>` (or `.` for root) moves + rewrites inbound `[[wikilinks]]` atomically; nested features stay first-class everywhere (snapshot, recall, graph, releases, dashboard tree). The **top-level folder IS the feature's product** (single source of truth, derived from path — no stored `product:` field that can drift).
- [x] `dreamcontext knowledge move <slug> <folder>` now auto-detects Excalidraw board DIRECTORIES (wrapper folder + companions: `.excalidraw.md`, `.board.cjs`, `.board.json`, etc.) and relocates the entire directory atomically with inbound `[[wikilink]]` rewrite + decay-key migration (v0.19.0). File-vs-directory dispatch is transparent; boards in per-title wrappers move as one unit without manual bundling.

## Constraints & Decisions

- **[2026-07-08]** Knowledge topical subfolders + feature-product SSOT (session 7d826ba9, uncommitted). Knowledge now supports arbitrary topical subfolders under `knowledge/` — `buildKnowledgeIndex()` globs `**/*.md` (recursive), and slugs are basename-only for short recall keys. Features support topical/product subfolders under `features/` — `dreamcontext features create <name> --folder <product>` or `features move <name> <folder>` (atomic move + inbound `[[wikilink]]` rewrite). The **top-level folder IS the feature's product** — derived from the path (single source of truth), no stored `product:` field that can drift. `features/<product>/<name>.md` → product = `<product>`; `features/<name>.md` → product = null (root). Nested features stay first-class everywhere (snapshot, recall, graph, releases, dashboard tree). The stored `product:` frontmatter field is RETIRED — session 7d826ba9 removed it from ~24 feature files, and the feature-product resolver (`features-path.ts`) now derives product from the top-level folder only. See also `dreamcontext-skill-folder.md` for the broader skill/agent/hook foldering model. `dreamcontext migrations apply-diagrams` (idempotent) folds flat `knowledge/diagrams/*.excalidraw.md` boards into per-title `diagrams/<title>/` subfolders + rewrites `[[wikilinks]]` (legacy structural; promoted layout is context-co-located).
- **[2026-06-30]** Co-located board-folder tree/asset bugs (desktop feedback, session `65a69348`): (1) **Tree split** — `buildKnowledgeTree`'s "board self-wrapper collapse" heuristic (built for the legacy convention: a board alone in a folder named after itself) unconditionally hoisted the board out of ANY self-named folder, including the newer self-contained convention where a teardown `.md` lives alongside it — splitting the board from its own folder. Fix: the collapse now only fires when the board is the folder's SOLE occupant, counted over the WHOLE subtree (every ancestor prefix, not just direct children — a first-pass fix that only counted direct children was caught by two independent multi-reviewers as still splitting a board co-located with a *nested* notes subfolder). (2) **Blank embedded images** — `handleKnowledgeAssets` resolved wikilinks against vault-root/context-root/the board folder/`Attachments/`, but not the sibling `assets/` subfolder the self-contained convention uses; added `boardDir/<path>` and `boardDir/assets/<basename>` candidates, still `safeChildPath`-contained (multi-review security PASS — the new candidates are STRICTLY tighter than pre-existing ones, cannot widen traversal). (3) **Silent dangling embeds** — the builder's pre-flight now collects every missing asset across a spec and fails once with the full list (was: throw on the first missing image, and a directory-valued path silently skipped the guard entirely before raising a raw `EISDIR` later — also fixed via `statSync().isFile()`). 31 regression tests (`tests/unit/excalidraw-knowledge.test.ts`).
- **[2026-06-17]** Companion-knowledge indexing (PR #35, commit e110d9f): `isDarkDiagramSibling()` was previously a blanket exclusion of ALL non-board `.md` files co-located with a board. It is now role-based: a `.md` with `name:` frontmatter beside a board (`isIndexableKnowledge=true`) is NOT dark — it is indexed as first-class knowledge. Generator scripts (`.board.cjs`), spec JSON, and frontmatter-less helper notes remain dark. This resolves the prior tradeoff where keeping a board + its teardown `.md` in one folder forced a choice between good co-location and recall. The predicate stays O(1) (caller supplies the flag from already-read frontmatter; no extra fs calls). The old "all files beside a board are dark siblings" documentation in `skill/SKILL.md` and `skill-packs/excalidraw/SKILL.md` is NOW STALE and should be updated to reflect the role-based rule.
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

**Knowledge file schema**:```yaml
---
id: "know_abc123"
name: "JWT Authentication Flow"
description: "Complete JWT auth flow with refresh tokens and rotation strategy"
tags: ["security", "api", "decisions"]
pinned: false
date: "2026-02-25"
---

Full content of the knowledge file here...```
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
- Dark-sibling helpers: `diagramFolderDirs(allFiles)` (dirnames directly containing ≥1 board, computed once per glob) + `isDarkDiagramSibling(filePath, dirsSet, isIndexableKnowledge?)`.
  - `isIndexableKnowledge` (default `false`) — when `true`, the file is NOT dark even if co-located with a board. Callers (knowledge-index.ts, recall.ts) pass this flag based on whether the file's frontmatter contains a `name:` field. This implements role-based sibling detection: tooling artifacts are dark, knowledge companions are not.
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

### 2026-07-08 - Knowledge topical subfolders + feature-product SSOT (session 7d826ba9, uncommitted)
- Knowledge now supports arbitrary topical subfolders — `buildKnowledgeIndex()` globs `**/*.md` recursively; slugs are basename-only for short recall keys.
- Features support topical/product subfolders — `features create --folder <product>`, `features move <name> <folder>` (atomic move + `[[wikilink]]` rewrite). The **top-level folder IS the feature's product** (derived from path, single source of truth). Stored `product:` frontmatter field RETIRED (~24 files swept in session 7d826ba9).
- Nested features first-class everywhere (snapshot, recall, graph, releases, dashboard tree). See `dreamcontext-skill-folder.md` for the broader foldering model.

### 2026-06-30 - Co-located board-folder tree/asset bugs fixed (desktop feedback)
- Tree grouping: board self-wrapper collapse now gated on "sole occupant of the whole subtree" instead of unconditional — a board is never split from a co-located teardown note or nested notes subfolder.
- Asset resolution: `boardDir/assets/<basename>` and `boardDir/<path>` added as resolver candidates for embedded images (still `safeChildPath`-contained; security-reviewed PASS).
- Builder pre-flight: collects every missing referenced image across a spec and fails once with the full list; directory/broken-symlink paths now caught too.
- Multi-reviewed (security/frontend/edge-cases): one Major caught and fixed pre-merge (subtree-vs-direct-children occupant count), 31/31 tests green.

### 2026-06-17 - Companion-knowledge indexing (PR #35, commit e110d9f)
- `isDarkDiagramSibling()` refactored from blanket exclusion to role-based: `.md` with `name:` frontmatter beside a board is now indexed as first-class knowledge. Generator scripts, spec JSON, frontmatter-less helpers remain dark. Backward-safe: callers without the new flag default to original behavior.
- User story added: companion `.md` beside a board is recalled as knowledge.
- Constraint added: old "all files beside a board are dark" docs in SKILL.md files are stale and flagged for update.

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
