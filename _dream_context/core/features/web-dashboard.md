---
id: feat_O7LODr7O
status: active
created: '2026-02-25'
updated: '2026-06-17'
released_version: 0.1.0
tags:
  - frontend
  - architecture
  - design
related_tasks:
  - web-dashboard
  - v06-control-panel-frontend
  - v06-control-plane-backend
  - landing-page-v2
  - dashboard-alignment
  - data-structures-to-knowledge
  - knowledge-diagram-nesting
---

## Why

Users need a visual interface to manage agent context without using the terminal. The dashboard provides a Kanban task board, sleep state tracking, core file editing, knowledge management, and feature viewing, all through a premium Notion/Linear-inspired web UI. Every manual change is tracked in the sleep file so the agent learns what the user did between sessions.

## User Stories

- [ ] As a user, I want to run `dreamcontext dashboard` and have a web UI open in my browser so that I can manage my project context visually
- [ ] As a user, I want to see a Kanban board of my tasks so that I can track work status at a glance
- [ ] As a user, I want to drag tasks between columns (todo, in_progress, completed) so that I can update status without typing commands
- [ ] As a user, I want to filter tasks by status, priority, urgency, tags, version, text search, and date range so that I can find specific tasks quickly
- [ ] As a user, I want to group tasks by status, priority, urgency, version, or tags so that I can organize the board to my preference
- [ ] As a user, I want to switch between Kanban and Eisenhower Matrix views so that I can see tasks by prioritization quadrant
- [ ] As a user, I want to create new tasks from the dashboard with name, description, priority, urgency, version, and tags so that I can add work without the CLI
- [ ] As a user, I want to update task fields (status, priority, description) and add changelog entries from a detail panel so that I can keep tasks current
- [ ] As a user, I want to see the agent character in the top-left corner showing sleep state (alert, drowsy, sleepy, must sleep) so that I know when consolidation is needed
- [ ] As a user, I want a dedicated sleep page showing debt level, session history, and dashboard changes so that I can track sleep cycles in a beautiful UI
- [ ] As a user, I want to read and edit core files (soul, user, memory, style guide, tech stack) with a markdown editor and live preview so that I can update project identity
- [ ] As a user, I want to browse, search, and view knowledge files so that I can find stored knowledge quickly
- [ ] As a user, I want to pin and unpin knowledge files from the dashboard so that important knowledge appears in the snapshot
- [ ] As a user, I want to view feature PRDs with all their sections (Why, User Stories, Acceptance Criteria, etc.) so that I can review feature specs
- [ ] As a user, I want to manage planning versions alongside released versions in a Version Manager so that I can track what's coming next
- [ ] As a user, I want to promote a planning version to released from the Version Manager so that I can track release milestones
- [ ] As a user, I want all manual changes I make in the dashboard to be recorded in the sleep file so that the agent consolidates them during the next sleep cycle
- [ ] As a user, I want light and dark mode (with system preference detection) so that the UI matches my OS settings
- [ ] As a user, I want multi-language support (English initially, i18n-ready) so that the dashboard can be localized in the future
- [x] As a user, I want to toggle the Brain graph to a 3D rendering mode so that I can perceive relationship depth and cluster density that 2D layouts obscure when nodes overlap
- [x] As a user, I want a Settings page to view and edit my project's platforms and packs so that I can configure dreamcontext without using the CLI.
- [x] As a user, I want a Packs page to browse available skill packs and see which are installed.
- [x] As a user, I want an in-app update badge that tells me when a newer dreamcontext version is available so I know to run `dreamcontext upgrade`.
- [x] As a user, I can see registered vaults (read-only) from the Settings page so that I know which projects are tracked.
- [x] As a user, I see a "What is this?" section at the bottom of the sidebar that opens a full-page marketing/explainer landing page with a real system diagram, sleep walkthrough, recall flow, cinematic architecture view, live skill-packs marquee, and collapsible features showcase.
- [x] As a user, the landing page hero shows the logo+wordmark and a looping brain-graph video so I immediately understand what dreamcontext is.
- [x] As a user, the dashboard's responsive layout doesn't clip or misalign at tablet/narrow widths (768px) because the sidebar collapses and pages use flexible spacing.
- [x] As a user, the "What is this?" sidebar entry bounces and glows until I open it once (then remembers via localStorage and stops) so I never miss the landing page on first run.
- [x] As a user, the landing page hero headline reads "The persistent brain for AI natives" with a "Works with Claude Code" credibility pill so I immediately understand the audience.
- [x] As a user, the "One brain, many faculties" features showcase is a pinned scroll-scrubbed spotlight: the header+stage stay sticky while a tall track scrolls past; scroll progress continuously crossfades faculty panels (opacity+translateY on refs, zero React renders per frame); snap-to-nearest settles any intermediate frame on scroll idle.
- [x] As a user, the goal-skill orchestration is a flagship spotlight faculty with its own landscape loop diagram so I understand how planning-review-implementation-validation works end-to-end.
- [x] As a user, flow animations in diagrams are compositor-smooth (CSS Motion Path dots riding offset-path/offset-distance rather than stroke-dashoffset), so 27 simultaneous dots cause 0 jank frames.

- [x] As a user, I can view Excalidraw diagrams stored in knowledge/diagrams/ rendered as real hand-drawn boards (native canvas, crisp at any zoom, wheel-pan/pinch-zoom, auto-centered on load) in the dashboard's Knowledge Preview tab.
- [x] As a user, embedded screenshots in Excalidraw boards (Obsidian SHA1-linked) resolve and render in the dashboard canvas view, so boards that reference screenshots are visually complete.
- [x] As a user, the dashboard header has a refresh button so I can reload the current page's data without navigating away (sleep debt, tasks, knowledge all update in place).
- [x] As a user, I see the data-structures knowledge file rendered as the relational/ER view (entities with PK/FK fields and relationship lines) in the Knowledge Preview tab, identical to the view the Core page previously provided for .sql files.
- [x] As a user, I can expand any knowledge document (markdown, SQL/ER, excalidraw, raw file view) into a full-screen in-app overlay via a ⛶ button next to the File/Preview tabs, and exit with Esc or the close button, so large boards and long documents are readable.
- [x] As a user, nested `diagrams/{title}/` excalidraw boards display under the Diagrams group with a clean leaf name (basename), not a redundant `title/title.excalidraw` label.
- [x] As a user, I can browse the project tag taxonomy on a dedicated Taxonomy page (facet chip clusters with usage counts, alias arrows, drift/audit panel) so I can see vocabulary health without the CLI.

## Acceptance Criteria

### Kanban Board
- [x] Board shows four columns: To Do, In Progress, In Review (purple), Completed
- [x] Tasks can be dragged between columns, status updates on drop
- [x] Filter by status (todo/in_progress/completed) works
- [x] Filter by priority (critical/high/medium/low) works
- [x] Text search filters by task name and description
- [x] Date range filter (from/to) on created_at or updated_at field works
- [x] Filter state persists across page reloads via localStorage
- [x] Clear Filters button resets filter fields but preserves sort and groupBy
- [x] Filter by tag (multi-select with type-ahead search)
- [x] Sort by updated date, created date, priority, name works
- [x] Group by status (default), priority, urgency, version, or tags (multi-column)
- [x] Sub-grouping within columns (collapsible SubGroupSection with count)
- [x] Create task modal: name (required), description, priority, urgency, version, tags
- [x] Detail panel slides in from right on task click: shows all fields, status/priority/urgency/version dropdowns, changelog with add entry form
- [x] Eisenhower Matrix view: 2×2 priority×urgency grid, excludes completed tasks; tasks draggable between quadrants (updates priority+urgency on drop)
- [x] MultiSelectFilter: checkbox-based, type-ahead search shown when >5 options, All/None toggle
- [x] Version Manager: planning/released sections, stats header, Release button to promote
- [x] Flowchart-to-acceptance-criteria sync: `<!-- node:<id> -->` markers in task body link mermaid node IDs to checkboxes; toggling a checkbox updates the corresponding mermaid node's `:::class` (done/active/todo/blocked) and vice versa.
- [x] Race-safe rapid checkbox toggles: `pendingBodyRef` pattern computes successive optimistic bodies from the latest in-flight state (not stale server state); reverts on API failure.
- [x] Server PATCH body size limit raised to 1 MB; `---` front-matter delimiters sanitized from body before writing to prevent parse corruption.
- [x] Mermaid edge-line corruption fix: lines containing edge operators (`-->`, `---`, `-.->`, etc.) are never treated as node definitions during class-injection pass.

### Sleep State
- [ ] Agent avatar (diamond logo) in header: full color when alert, dims progressively, pulses with "zzz" when must_sleep
- [ ] Sleep badge in header shows level name and debt number
- [ ] Sleep page: large debt gauge with color coding (green/yellow/purple/red by level)
- [ ] Sleep page: session history timeline with timestamps, scores, change counts
- [ ] Sleep page: dashboard changes list with entity/action/summary

### Core Files
- [ ] File list in left panel shows all core files (0.soul.md through 5.data_structures.sql, CHANGELOG.json, RELEASES.json)
- [ ] Clicking a file shows content in right panel
- [ ] Markdown files have an Edit button that opens split-pane editor (textarea left, preview right)
- [ ] JSON files display formatted JSON
- [ ] Saving a core file records the change in .sleep.json dashboard_changes

### Knowledge Management
- [ ] Knowledge list shows all knowledge files with name, description, tags
- [ ] Search filters by name, description, and tags
- [ ] Pin/unpin toggle on each knowledge card
- [ ] Clicking shows full content in detail panel
- [ ] Pin/unpin records change in .sleep.json dashboard_changes
- [x] `MarkdownPreview` renders SQL and other code blocks with syntax highlighting (highlight.js, theme-aware, DOMPurify allowlist extended for `hljs-*` span classes)
- [x] Data-structures files appear under the Knowledge view (not Core), because `knowledge/data-structures/` is now canonical

#### Knowledge Fullscreen (#21 / PR #30)
- [x] Generic `FullscreenOverlay` component (`dashboard/src/components/layout/FullscreenOverlay.tsx/.css`): in-app fixed-position dialog (NOT the browser Fullscreen API), `role="dialog"` + `aria-modal` + `aria-label` (doc name); header carries doc name, File/Preview tabs, and a close button.
- [x] Esc closes via a document-level capture-phase keydown listener (element-scoped listeners go dead in Firefox/Safari when clicking non-focusable content moves focus to `<body>`); Tab is trapped and pulled back into the overlay if it escapes; focus returns to the trigger on close.
- [x] FOCUSABLE selector excludes disabled elements (`:not(:disabled)`) — markdown task lists render disabled checkboxes that can never be `document.activeElement`; one at first/last position would break the Tab wrap check.
- [x] Body scroll locked while open with scrollbar-width compensation (no layout shift on enter/exit).
- [x] ⛶ expand button on KnowledgePage covers all views: markdown preview, SQL/ER, excalidraw, and raw file; File/Preview tab state is shared in/out of fullscreen (survives enter/leave).
- [x] Single render site: pane content is unmounted while the overlay is open so a doc never mounts twice (excalidraw export + mermaid element ids collide on double-mount); ExcalidrawPreview's mount-time fit + ResizeObserver re-fit the board to the larger canvas.
- [x] `.fullscreen-overlay-body` child rule uses `:only-child` (0,2,0 specificity) so it beats `.excalidraw-preview { min-height: 420px }` regardless of CSS emission order.
- [x] e2e spec `e2e/knowledge-fullscreen.spec.ts`: open/close paths, tab use inside the overlay, scroll lock, list/search preservation, and the excalidraw svg actually growing in full-screen.

#### Taxonomy Page
- [x] Taxonomy page (`dashboard/src/pages/TaxonomyPage.tsx/.css`, `useTaxonomy.ts` hook): facet chip clusters with alias-resolved usage tallies, alias arrows, drift/audit panel; linked from nav + CorePage.
- [x] Backed by read-only `GET /api/taxonomy` (vocabulary + usage tallies + audit buckets); all mutations stay CLI-only.

### Features
- [x] Feature list shows all features with slug, status badge, tags
- [x] Clicking shows full PRD: all sections (Why, User Stories, Acceptance Criteria, Constraints, Technical Details, Notes, Changelog)
- [x] File/Preview tab toggle: File shows raw markdown, Preview renders as HTML (same pattern as Core and Knowledge pages)

### Change Tracking
- [ ] Every create/update action via dashboard API writes to .sleep.json dashboard_changes array
- [ ] Each change records: timestamp, entity, action, target file, field changed, human-readable summary
- [ ] `dreamcontext sleep done` clears dashboard_changes along with sessions

### About / Landing Page
- [x] AboutPage rebuilt as 9 self-contained section components under `dashboard/src/components/about/`.
- [x] FlowDiagram engine: single data-driven React component (FlowDiagram.tsx); instance-unique gradient IDs via `useId()`; inline SVG `stroke`/`fill` attributes (not CSS); CSS Motion Path dot animation (offset-path + offset-distance); reduced-motion guard parks dots at 55% (static, directional).
- [x] Hero: inline recolored diamond SVG + wordmark left; looping brain video (webm + mp4 + poster) right; heading "The persistent brain for AI natives"; "Works with Claude Code" credibility pill above install command.
- [x] How-it-works diagram: 8 context categories incl. data-structures, skills, sub-agents; RemSleep shown as multi-agent (parallel specialists); Motion Path dot animation.
- [x] "How sleep works" sub-section: debt accumulation flow + 3 parallel specialists with real file domains.
- [x] "How the system remembers" sub-section: BM25F → Haiku (smallest cloud agent) → SessionStart snapshot.
- [x] Architecture: cinematic 3D cortical-stack (layered cross-section), not a flat grid.
- [x] Skill-packs marquee: live from `usePacks()` hook (not hardcoded), infinite scroll, pause on hover, reduced-motion fallback to static scroll row.
- [x] Features showcase: "One brain, many faculties" pinned scroll-scrubbed spotlight — 11 faculty panels (incl. goal-skill flagship), sticky header+stage, imperative scrub on refs, snap-to-nearest on scroll-idle; mobile (<860px) un-stacks to normal tablist.
- [x] goal-skill faculty: landscape loop diagram (planner→plan-review↻→implementer→code-review↻→validator↻→shipped; ↻≤3 bounded retry loops on each stage).
- [x] FlowDiagram `wrapSub()` auto-wraps captions to node width (greedy break on ` · ` separators, viewBox-unit font math, size-aware 12/10 for full/mini); no caption overflow possible.
- [x] Wire contrast fix: `.fd-wire` uses `color-mix(in srgb, var(--color-text) 38%, transparent)` (not `var(--color-border)`) so connectors read in both light and dark themes.
- [x] "What is this?" sidebar entry: accent-soft fill + glow dot + bounce keyframe until first click; `dreamcontext.dashboard.aboutSeen` localStorage flag retires nudge permanently.
- [x] Token-only colors in all about component CSS (no raw hex/rgb in component rules).
- [x] Build green, tsc clean, light + dark screenshots pass.
- [x] Responsive: 11 alignment tests green (sidebar rail at 390/768, KB/Core/Features stacked at 768, settings hint aligned, council count in column).

### Design
- [ ] Lightweight, minimal UI inspired by Notion and Linear
- [x] Linear Midnight design system applied: Neon Lime (#e4f222) as sole accent, Inter Variable typeface (weight 510/590 with 500/600 fallback), pitch-black/graphite/deep-slate layered surfaces, muted Storm Cloud secondary text, flat surfaces (glassmorphism removed), Berkeley Mono for code.
- [ ] Purple-to-magenta brand gradient: #641787, #781ca3, #8200a6, #db04b4 (retained as legacy variable; Neon Lime replaces as primary action color)
- [ ] Light and dark mode with system preference detection and manual toggle
- [ ] WCAG AA contrast ratios
- [ ] Responsive layout (sidebar collapses on small screens)

### Technical
- [x] Command: `dreamcontext dashboard` starts HTTP server on localhost:4173 (configurable with --port)
- [x] Server: Node.js native http module, zero new runtime dependencies
- [x] Server binds to `127.0.0.1` by default (loopback only); a `--host` flag allows overriding with a visible warning.
- [x] Mutating endpoints (`POST/PUT/PATCH/DELETE`) reject requests whose `Origin` header is present but not a loopback origin — CSRF defense.
- [x] CORS reflects only loopback origins (never `*`).
- [x] All filesystem paths built from request input go through `safeChildPath()` — path-traversal guard.
- [ ] Frontend: React 19 + Vite 6 + TypeScript strict
- [ ] State: TanStack Query for server data, Context for theme/i18n
- [ ] Build: `npm run build` builds dashboard then CLI, dashboard output copied to dist/dashboard/
- [ ] All existing 258+ tests continue to pass

- [x] Excalidraw preview: knowledge files with slug matching diagrams/*.excalidraw render via `Excalidraw` canvas component (view-mode, lazy-loaded); boards are crisp at all zoom levels (live re-draw vs. one-shot SVG rasterization); `scrollToContent({fitToViewport:true})` called on mount + 100ms settle + ResizeObserver so board is always centered and fit; handles both `json` and `compressed-json` fence variants.
- [x] Embedded-image resolution for Excalidraw boards: `GET /api/knowledge-assets/:slug` parses `## Embedded Files` SHA1→path map, resolves image paths under vault (containment-guarded, image extensions only), down-scales to WebP via sharp (mtime-cached), returns base64 `files` map; dashboard merges resolved files into scene before canvas mount so Obsidian-linked screenshots render.
- [x] Live refresh header button: clicking refresh calls `queryClient.invalidateQueries()` for the active page without a full page reload; sleep debt, tasks, and knowledge data all update in place.
- [x] Data-structures ER view in Knowledge: files with slug starting with data-structures/ detect the ```sql fence (fenceConcat fallback for multi-fence files), extract the body, and render SqlPreview. Non-schema knowledge files are unaffected and continue using MarkdownPreview.
- [x] Nested excalidraw grouping (#20): depth-2 `diagrams/{title}/` slugs show leaf `{title}` under Diagrams; `leafName` uses basename (collapsing redundant `{title}/{title}.excalidraw`), not prefix-strip; `isExcalidrawSlug` matches nested slugs; knowledge detail route stays raw (renderer needs the raw scene — memory gets extracted text, see knowledge-base PRD).
- [x] Recursive nested folder tree: KnowledgePage.tsx builds a full recursive folder tree for knowledge/diagrams (and all knowledge subfolders), not just single-level depth. Category boards nest as collapsible sub-folders. Board cards show pen/sketch icon.
- [x] Excalidraw canvas rendering: `ExcalidrawPreview` uses live `@excalidraw/excalidraw` canvas (view-mode) instead of `exportToSvg()`. Lazy-loaded. `scrollToContent` via mount + 100ms timer + ResizeObserver. See `knowledge/dashboard-knowledge-rendering.md`.
- [x] `GET /api/knowledge-assets/:slug`: resolves Obsidian embedded images (SHA1→WebP base64, sharp, mtime-cached, safeChildPath-guarded). Key files: `src/server/routes/knowledge.ts`, `src/server/index.ts`.
- [x] Page-title headers removed from Tasks, Features, and Knowledge pages (content starts without a redundant h1 title) to reclaim vertical space.
- [x] Sleep page layout width matches other pages (full-width alignment consistent across all pages).
- [x] Features page search box added.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-06-17]** Excalidraw canvas over SVG export (PR #35): `exportToSvg()` rasterizes boards once — WebKit samples a 2556×4646 px SVG down to viewport → soft on high-DPI, not recoverable on zoom. Replaced with the live `Excalidraw` canvas component (view-mode): re-draws per zoom level, crisp at all scales. Trade-off: larger runtime bundle (lazy-loaded via React.lazy, no initial load cost). `scrollToContent` must be called at mount + 100ms timer + ResizeObserver to catch flex-pane layout settling; a single mount-time call fires before final dimensions. See `knowledge/dashboard-knowledge-rendering.md` for full rendering architecture.
- **[2026-06-17]** `knowledge-assets` route is image-only, safeChildPath-guarded (PR #35): resolves Obsidian board embedded images (SHA1→path→base64 WebP via sharp); containment guard + image-extension allowlist prevent path traversal. Mtime-cached; recompresses on file change. See `knowledge/dashboard-server-security.md` for the broader security model.
- **[2026-06-12]** Knowledge fullscreen is an in-app fixed dialog, NOT the browser Fullscreen API: predictable theming/layout, no UA chrome or permission quirks, and it keeps the overlay inside the app's stacking/theme context. Single-render-site invariant: never mount the same document twice (excalidraw export and mermaid ids collide) — the pane unmounts while the overlay is open. Deferred follow-ups (explicit owner decision, anti-over-engineering): (1) Core-page fullscreen adoption via the same `FullscreenOverlay`, (2) single-instance render to avoid remount cost on toggle, (3) shared icon-button CSS class.
- **[2026-06-09]** Eisenhower Matrix drag & drop: the existing matrix had `onDragStart={() => {}}` no-op handlers — only structure, no interactivity. Implemented using native HTML5 DnD API (consistent with Kanban). A quadrant receives `onDragOver` + `onDrop`; on drop, both `priority` and `urgency` are patched atomically via the existing PATCH /api/tasks endpoint. No new DnD library added — native API is sufficient for the 2×2 grid (4 drop targets, no complex reordering). `eisenhower.ts` maps quadrant ID to `{priority, urgency}` pairs.
- **[2026-06-06]** `overflow-x: hidden` vs `clip` on the `.about` container: `overflow-x: hidden` creates a new scroll container, so any `position: sticky` descendant resolves its scroll container to `.about` (not `.shell-main`) and pins immediately — the whole spotlight was stuck. `overflow-x: clip` clips visually without creating a scroll container, preserving sticky semantics. Fix: `.about { overflow-x: clip }` in AboutPage.css. This is a general CSS invariant: if a section has sticky children, its overflow must be `clip` (or `visible`), never `hidden` or `auto`.
- **[2026-06-06]** CSS Motion Path for flow animation: `stroke-dashoffset` repainted the entire dashed stroke (full path length) on the main thread every frame. With 27 simultaneous comets the browser re-rasterized ~27 paths per frame → stutter. Replaced with a small `<circle>` per edge riding the path via `offset-path: path(d)` + `offset-distance: 0→100%` — a compositor-class transform; only the ~14px dot region is dirtied per frame. Glow is a per-instance radial-gradient fill (purple→blue→transparent), rasterized once. Measured: worst frame 11.2ms, 0 jank/179 frames at 27 dots. `FlowEdge.travel` is now unused (offset-distance is length-independent). Reduced-motion: park dot at `offset-distance: 55%` (static, but still on-path and directional).
- **[2026-06-06]** Pinned scroll-scrubbed spotlight (FeaturesShowcase): imperative scrub — scroll progress written to panel refs (opacity + translateY) per-frame, zero React re-renders per frame; React state fires only when centred faculty changes (for tab ARIA + rail highlight). Snap-to-nearest on scroll-idle: 140ms debounce after last scroll event; smooth-scrolls container to nearest faculty centre; lands within 8px SNAP_EPS → no-op (no loop). Skips snap at track ends (progress ≤0.012 / ≥0.988) to let the user scroll out of the section naturally.
- **[2026-06-05]** Responsive fix: root cause was zero width media queries in Sidebar/Shell — fixed 220px sidebar was clipping every page at tablet/narrow. Fix: responsive CSS breakpoints for sidebar + shell, plus alignment audit across all pages (11 Playwright tests). `dist/dashboard` sync: `vite` writes to `dashboard/dist/`, but `dreamcontext dashboard` serves from `dist/dashboard/` — must run root `npm run build` (not `cd dashboard && npm run build`) to sync. See note in web-dashboard task.
- **[2026-06-04]** About page / landing page: AboutPage.tsx is a composition-only file (no inline logic); all sections are self-contained under `dashboard/src/components/about/`. FlowDiagram.tsx is the single diagram engine — gradient IDs must use `useId()` and be referenced as inline SVG attributes (not CSS) to avoid cross-diagram collisions. HowItWorksDiagram.tsx/.css deleted once FlowDiagram landed. Logo is inline recolored SVG diamond (not a network hotlink — that image isn't dashboard-served). Brain video is pre-generated at `dashboard/public/media/brain.{webm,mp4,png}`.
- **[2026-05-31]** Server hardening decisions: (1) default host=127.0.0.1 (not 0.0.0.0) — LAN access requires explicit `--host`; (2) CSRF guard via Origin/Host check at server level (not per-route) so all new mutating routes inherit it automatically; (3) `safeChildPath()` in `src/server/safe-path.ts` is the single path-validation function — every route that builds a path from request input MUST use it. These are security invariants; do not regress. See knowledge file `dashboard-server-security.md` for full threat model.
- **[2026-05-23]** Brain 3D view is a toggle on the existing Brain page, not a separate route. `react-force-graph-3d` + `three` are dashboard-only deps (isolated from CLI). Labels use `THREE.Sprite` (billboard) to stay legible at all camera angles. `fog: true` on `SpriteMaterial` ties label opacity to scene fog so distant labels auto-fade with their nodes. Fly-to on click uses `fgRef.current.cameraPosition()` (ForceGraph3D's imperative API), not Three.js directly.
- **[2026-05-22]** Linear Midnight design system (additive, non-breaking): old `--glass-*` and `--color-brand-*` CSS variables retained for backward compatibility; no selectors deleted. Google Fonts CDN loads Inter in browser; air-gapped environments fall back to system font. `font-weight: 510/590` uses Inter variable font axis; falls back to `500/600` if Inter is not a variable font instance.
- **[2026-05-22]** Flowchart sync uses `<!-- node:<id> -->` comment markers embedded in task body (between a checkbox and its label) to bind checkbox state to a mermaid node ID. Edge-line corruption guard: lines containing `-->`, `---`, `-.->`, `==>`, `--`, `==` operators are skipped during node-class injection. `sanitizeMermaid()` strips problematic characters before passing to `mermaid.render()`.
- **[2026-05-22]** `pendingBodyRef` race safety: PATCH mutations read from `pendingBodyRef.current` (last optimistic value) rather than stale server data. On failure, `bodySourceRef.current` (last confirmed server value) is used to revert.
- **[2026-03-07]** in_review is treated as active (not completed): shown in snapshot, default task list, and Eisenhower Matrix alongside todo and in_progress. This is intentional — in_review is a review gate before completion, not a done state.
- **[2026-03-07]** Versions unified with Releases: no separate VERSIONS.json. Planning-stage versions are ReleaseEntries with `status: 'planning'`. Backward compat: entries without status field treated as released. One schema, one file, UI handles the separation.
- **[2026-03-07]** Eisenhower Matrix excludes completed tasks: it's a prioritization view for future work, not a history. Completed tasks remain visible in the Kanban "Completed" column.
- **[2026-03-07]** MultiSelectFilter search threshold: type-ahead search input shown when >5 options (list too long to scan). Hidden when ≤5 options.
- **[2026-02-25]** Agent character: user will provide custom design later. Using brand diamond logo as placeholder with opacity/animation based on sleep level.
- **[2026-02-25]** Multi-language: i18n infrastructure built (I18nContext with t() function and translation keys), English only for v1. Adding languages means adding translation objects.
- **[2026-02-25]** No router library: 5 pages managed by state-based page switcher. No deep linking needed. Add wouter (~1.5KB) later if URL routing is wanted.
- **[2026-02-25]** No drag-and-drop library: using native HTML DnD API. Upgrade to @dnd-kit if UX is insufficient.
- **[2026-02-25]** No CSS framework: custom CSS with design tokens (CSS custom properties). Keeps bundle minimal, full control over design system.
- **[2026-02-25]** Server uses Node.js native http module: zero new runtime dependencies. Routes are thin wrappers around existing src/lib/ utilities.
- **[2026-02-25]** dashboard_changes separate from sessions: dashboard changes are individual user actions, agent sessions have transcripts and scores. Mixing them would confuse the rem-sleep agent.
- **[2026-02-25]** Dashboard is a separate build target (dashboard/ directory with own package.json). React deps isolated from CLI deps.
- **[2026-02-25]** Framework: React + Vite chosen over Preact/Svelte for full ecosystem support (TanStack Query, rich component patterns).
- **[2026-02-25]** Editor: Markdown textarea with live preview. No heavy editor library for v1.

## Technical Details

### Architecture
- `src/server/` - Node HTTP server + REST API (bundled by tsup with CLI)
- `dashboard/` - React SPA (built by Vite, output copied to dist/dashboard/)
- Server serves static files from dist/dashboard/ and API from /api/*

### Key Files
- `src/server/index.ts` - createServer, startDashboardServer(), route registration
- `src/server/router.ts` - URL pattern matching with :param extraction
- `src/server/routes/*.ts` - API handlers (tasks, sleep, core, knowledge, features, changelog, health)
- `src/server/change-tracker.ts` - recordDashboardChange() writes to .sleep.json
- `src/cli/commands/dashboard.ts` - CLI command registration
- `dashboard/src/App.tsx` - React root with providers (QueryClient, Theme, I18n)
- `dashboard/src/styles/tokens.css` - Design tokens (colors, spacing, typography)
- `dashboard/src/hooks/useTasks.ts` - TanStack Query hooks for task CRUD
- `dashboard/src/components/tasks/KanbanBoard.tsx` - Main board with filtering/sorting/grouping

### API Endpoints
~26 endpoints covering: tasks (5), sleep (2), core (3), knowledge (3), features (2), changelog (1), releases (3 — list/show/add with planning support), health (1), config (2 — GET+PATCH), packs (1), version-check (1), vaults (1), council (3), taxonomy (1 — read-only GET). Versions API (was 3 endpoints) deleted; versions now handled via releases routes. All mutating endpoints call recordDashboardChange() except `PATCH /api/config` (entity union not widened in v0.6).

### Build Pipeline
1. `npm run build:dashboard` - Vite builds React app to dashboard/dist/
2. `npm run build:cli` - tsup builds CLI + server to dist/index.js
3. tsup onSuccess copies dashboard/dist/ to dist/dashboard/
4. dist/dashboard/ ships in npm package (covered by "files": ["dist"])

### Brain 3D View (v0.4)

- `dashboard/src/pages/BrainPage.tsx` — `React.lazy(() => import('../components/brain/BrainCanvas3D'))` behind `<Suspense>`. Conditional render on `settings.display.view === '3d'`. Runtime node type extended with `z/vz/fz` fields for 3D force simulation state.
- `dashboard/src/components/brain/BrainCanvas3D.tsx` — owns `ForceGraph3D` instance, 3D force config (`d3-force-3d`: `forceCollide`, `forceX/Y/Z`), billboard label sprites (`makeLabelSprite()` → `THREE.Sprite` via `THREE.CanvasTexture`), scene fog setup, and click fly-to camera animation via `fgRef.current.cameraPosition()`.
- `dashboard/src/components/brain/BrainSettings.tsx` — `SegmentedRow` component added; View 2D/3D row at top of Display section.
- `dashboard/src/hooks/useGraphSettings.ts` — `display.view: '2d' | '3d'` field added (default `'2d'`); persisted in `brain:settings:v1` localStorage blob; old persisted state without `view` falls back to `'2d'` via falsy check.
- **Dependencies** (dashboard-only): `react-force-graph-3d@^1.29.1`, `three@^0.184.0`, `@types/three@^0.184.1`.
- **Chunk**: Vite splits `BrainCanvas3D` into its own async chunk (`~334 KB gzip`). Initial bundle size unchanged.
- **Fog**: `THREE.Fog(color, 320, 1100)` — linear fog from distance 320 to 1100. Fog color: dark `#0d0d10`, light `#f7f7fa`. `SpriteMaterial.fog = true` ties label opacity to fog, so far labels auto-fade with their nodes.
- **Fly-to**: `handleNodeClickInternal` positions camera along the node's radial vector from origin at `targetDistance=90` world units, animated over 900 ms.

### Flowchart-AC Sync (v0.4)

- `dashboard/src/components/tasks/TaskDetailPanel.tsx`
  - `syncCriteriaToMermaid(body, id, checked)`: finds `<!-- node:<id> -->` markers in the body; replaces the node's `:::class` in the mermaid block.
  - `sanitizeMermaid(src)`: strips characters that break mermaid parsing.
  - Edge-line guard: `EDGE_OPS_RE` regex skips lines with flowchart edge operators during class-injection.
  - `pendingBodyRef`: `useRef<string>` initialized from `task.body`; reset when `task.body` changes from server; all successive checkbox toggles read/write this ref, not component state.
- Server: `src/server/routes/tasks.ts` PATCH body limit 1 MB; `---` at start/end of body stripped before frontmatter write.

### Brain — 3D View

- [x] `BrainSettings → Display → View` segmented control lets the user flip between `2d` (default) and `3d` modes without leaving the page.
- [x] 3D renderer (`BrainCanvas3D`) is lazy-loaded via `React.lazy` + `Suspense`; `three` + `react-force-graph-3d` ship as a separate Vite chunk (~334 KB gzip) fetched only on first toggle to 3D; initial bundle size unaffected.
- [x] Node labels in 3D mode are `THREE.Sprite` billboard objects (text-on-canvas → CanvasTexture) that always face the camera and are positioned below each node sphere. Dimmed nodes receive lower-opacity labels.
- [x] Scene fog (`THREE.Fog`) fades far nodes toward the background color, providing depth perception: near nodes pop forward, far nodes recede. Fog color is theme-aware (dark: `#0d0d10`, light: `#f7f7fa`).
- [x] Clicking a node triggers a camera fly-to animation (`cameraPosition()` over 900 ms): camera moves along the node's radial vector from origin to a fixed close distance (90 units) while looking at the node.
- [x] All shared Brain behaviors carry over to 3D: filtering, neighbor highlighting, hover-dim, `onNodeClick` → NodeDrawer, group color palette, force-simulation settings sliders, `view` persisted to `brain:settings:v1` localStorage blob (missing key falls back to `'2d'`).
- [x] `npm run build` produces a distinct `BrainCanvas3D-*.js` chunk, confirming lazy separation.

### Control Panel (v0.6)
- [x] Settings page: loads `GET /api/config`, shows platforms checkboxes + packs toggles, Save issues `PATCH /api/config` with body `{platforms, packs}` only; loading/error/success/empty states; read-only Vaults subsection (current vault highlighted).
- [x] Packs page: lists catalog packs + standalone from `GET /api/packs`; packs in `config.packs` show "Installed" indicator.
- [x] UpdateBadge: header banner surfaces `nudge` from `GET /api/version-check` when non-null (via `MarkdownPreview`); renders nothing when `nudge === null`.
- [x] `GET /api/vaults` returns `{vaults, current}` from the global registry; never 500.
- [x] `PATCH /api/config` strict-pick `{platforms, packs}`; prototype-pollution-safe (body never spread); per-element validation.
- [x] `GET /api/packs` imports from `src/lib/catalog.ts` (not `install-skill.ts`); catalog unreadable → `{packs:[], standalone:[]}` 200.
- [x] `GET /api/version-check` cache-only (no network in request path); read failure → benign payload.
- [x] `dashboard --vault <path|name>` re-roots the server to the chosen vault; invalid vault → non-zero exit + clean message.
- [x] `dashboard/tsconfig.json` has `noImplicitReturns: true`; `App.tsx` switch has explicit cases for `settings` and `packs`.

### About / Landing Page — v0.6 polish (2026-06-06)

**Component layout**: `dashboard/src/components/about/` — 9 self-contained sections. `AboutPage.tsx` composition-only. `AboutPage.css` must set `overflow-x: clip` (not `hidden`) — `hidden` creates a new scroll container which breaks `position: sticky` on descendants (sticky resolves to the wrong ancestor).

**FlowDiagram engine**: `FlowDiagram.tsx` + `FlowDiagram.css`. Types: `FlowNode`, `FlowEdge`, `FlowSpec`, props `{spec, className?, size:'full'|'mini'}`. Gradient IDs via `useId()` — referenced as inline SVG attrs (not CSS) to avoid cross-diagram collisions. Caption auto-wrap: `wrapSub(text, boxW, fontSize)` greedily breaks on ` · ` separators; widths are viewBox units (SVG font-size is user-space). Wire color: `color-mix(in srgb, var(--color-text) 38%, transparent)` — not `var(--color-border)` — so connectors are readable in light and dark.

**CSS Motion Path dots** (replaced stroke-dashoffset): each edge renders a `<circle r="5">` with `offset-path: path(edge.d)` + CSS `@keyframes fd-dot-travel { offset-distance: 0→100% }`. Compositor-class: only the ~14px dot region is dirtied per frame. Glow: per-instance `radial-gradient` fill, rasterized once. `FlowEdge.travel` deprecated/unused. Reduced-motion: dot parked at `offset-distance: 55%` (static, on-path, directional). Measured at 27 simultaneous dots: worst frame 11.2ms, 0 jank/179 frames.

**FeaturesShowcase pinned spotlight**: `FeaturesShowcase.tsx` + `.css`. Sticky `position: sticky; top: 84px`; tall scroll track below. Per-frame imperative scrub writes `opacity` + `translateY` to DOM refs (zero React re-renders per frame; React state only when centred faculty changes for ARIA + rail). Snap-to-nearest on idle: 140ms debounce → `container.scrollTo({behavior:'smooth'})` to nearest faculty centre; `SNAP_EPS = 8px` prevents loop re-entry; skips at track ends (progress ≤0.012 / ≥0.988). Mobile (<860px): track height→auto, sticky→static. Diagram animations run only on `.feat-panel--near` (≤3 from centre), rest paused. Key data: `flow-specs.ts` → `GOAL_SKILL_FLOW` (landscape 520×660 viewBox, ↻≤3 bounded-retry loops: plan-review, code-review, validator).

**Hero copy & sidebar nudge**: Hero headline "The persistent brain for AI natives." with accent gradient on "AI natives"; "Works with Claude Code" pill above install command. Sidebar: `ABOUT_SEEN_STORAGE_KEY = 'dreamcontext.dashboard.aboutSeen'`; `.sidebar-item--nudge` class = accent fill + glow dot + `about-bounce` ±4px keyframe; clears on first click, persists across reloads.

### Knowledge Fullscreen (v0.7, #21 / PR #30)

- `dashboard/src/components/layout/FullscreenOverlay.tsx` — generic, reusable overlay: fixed in-app dialog, document-capture keydown (Esc close + Tab trap with focus pull-back), `FOCUSABLE` selector excluding `:disabled`, focus restore to trigger, body scroll lock with scrollbar-width compensation. `FullscreenOverlay.css` — `:only-child` body rule to win over `.excalidraw-preview` min-height.
- `dashboard/src/pages/KnowledgePage.tsx` — ⛶ expand button next to File/Preview tabs; tab state lifted so it is shared in/out of fullscreen; pane content unmounted while overlay open (single render site).
- `e2e/knowledge-fullscreen.spec.ts` — Playwright coverage (open/close, tabs in overlay, scroll lock, list/search preservation, svg growth).
- Follow-ups deferred by owner: Core-page adoption, single-instance render, shared icon-button class.

### Taxonomy Page (v0.7)

- `dashboard/src/pages/TaxonomyPage.tsx/.css` + `dashboard/src/hooks/useTaxonomy.ts` — facet chip clusters (usage counts), alias arrows, drift/audit panel.
- `GET /api/taxonomy` (read-only): vocabulary + alias-resolved usage tallies + audit buckets. Mutations are CLI-only (`taxonomy add/alias`) — see the tag-taxonomy PRD.

### Council Page

- [x] CouncilHall: searchable grid of debates with status badge, persona count, round progress indicator
- [x] CouncilDetail: full-page view (back nav + 3 tabs: Overview, Agents, Matrix)
- [x] Overview tab: StatTile row + full final-report as hero with dynamic section parsing
- [x] Agents tab: TranscriptView with search + inline slug chips
- [x] Matrix tab: inline cell expand (no sidebar drawer)
- [x] Backend routes: GET /api/council, /api/council/:id, /api/council/:id/:slug

## Notes

- Bundle size: ~80KB gzipped (React + app). Acceptable for a CLI tool.
- The dashboard reads/writes the same _dream_context/ files as the CLI. No separate database.
- Port 4173 chosen to match Vite preview convention. Configurable with --port flag.
- The server keeps running until Ctrl+C. It does not daemonize.
- Phase 4b complete. Enhanced filters added (status, text search, date range, localStorage persistence). Phase 5 (a11y, responsive, i18n tokens, bundle audit) pending.
- The Visby CF font is commercial. Dashboard uses system font fallback if Visby CF is not installed.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-17 - Excalidraw canvas rendering + embedded image resolution + live refresh (PR #35, branch fix/dashboard-render-and-refresh)
- `ExcalidrawPreview` component switched from `exportToSvg()` static export to live `Excalidraw` canvas (view-mode, lazy-loaded). Boards are crisp at any zoom; native wheel-pan/pinch-zoom. `scrollToContent` called on mount + 100ms timer + ResizeObserver for reliable fit-and-center.
- New `GET /api/knowledge-assets/:slug` server route: resolves Obsidian `## Embedded Files` SHA1→path map, reads and down-scales images to WebP via sharp (mtime-cached, containment-guarded). Dashboard merges resolved files into scene before canvas mount so board screenshots render.
- SQL fence-concat fallback: multi-fence SQL files are joined before SqlPreview to fix partial rendering.
- Live-refresh button added to Header: `queryClient.invalidateQueries()` for active page — no full page reload.
- Nested diagram tree (PR companion, commit e110d9f): KnowledgePage renders knowledge/diagrams as recursive nested folder tree; build-all.mjs glob-based board resolution; generator require() depths fixed. 1978 tests green; dashboard + CLI builds green.

### 2026-06-12 - Knowledge fullscreen (#21/PR #30) + Taxonomy page + nested excalidraw grouping (#20)
- Generic `FullscreenOverlay` (in-app fixed dialog, not browser Fullscreen API): Esc + close button, document-capture keydown, focus trap excluding disabled elements, focus restore, body scroll lock with scrollbar-width compensation; hardened from review (capture listener, `:not(:disabled)`, `:only-child` CSS specificity).
- ⛶ expand on KnowledgePage covering markdown, SQL/ER, excalidraw, raw views; shared File/Preview tab state; single render site (doc never mounted twice). e2e: `knowledge-fullscreen.spec.ts`.
- Taxonomy page (facet chips, usage counts, alias arrows, audit panel) backed by read-only `GET /api/taxonomy`.
- Nested `diagrams/{title}/` boards group under Diagrams with basename leaf labels (#20 dashboard slice).

### 2026-06-09 - Eisenhower matrix drag & drop (#7) + SQL syntax highlighting in Knowledge view (#12)
- Eisenhower Matrix: tasks are now draggable between quadrants; drop updates both `priority` and `urgency` frontmatter fields via PATCH API. Implemented with native HTML5 drag-and-drop on `EisenhowerMatrix.tsx`; new `eisenhower.ts` util handles quadrant-to-field mapping.
- `MarkdownPreview`: SQL and code fences rendered with highlight.js (synchronous, small footprint, SQL grammar). Light/dark themes wired to `ThemeContext`. DOMPurify allowlist extended for `<span class="hljs-*">` output.
- Data-structures no longer shown under Core — moved to Knowledge view (follows `knowledge/data-structures/` canonical location from #12 migration).
- Full suite 1219 tests green.

### 2026-06-06 - Landing page v2 polish: scroll-scrubbed spotlight + Motion Path animation + hero copy
- "One brain, many faculties" features showcase rewritten as a pinned scroll-scrubbed spotlight (11 faculty panels, sticky header+stage, imperative scrub on refs, snap-to-nearest on idle).
- goal-skill promoted to flagship faculty with a landscape loop diagram (planner→plan-review↻→validator↻→shipped, ↻≤3 bounded retries per stage).
- FlowDiagram animation engine: stroke-dashoffset replaced with CSS Motion Path dots (offset-path + offset-distance); compositor-class, 0 jank at 27 simultaneous dots. Caption auto-wrap (wrapSub) so no text overflows boxes. Wire contrast fix (color-mix vs color-border).
- overflow-x: clip on .about fixes sticky behaviour (hidden was creating a scroll container and pinning sticky descendants to the wrong ancestor).
- Hero copy: "The persistent brain for AI natives." + "Works with Claude Code" pill.
- Sidebar "What is this?" nudge: accent fill + bounce animation until first click; localStorage flag retires it permanently.

### 2026-06-05 - Dashboard alignment + responsive fix
- Root cause: fixed 220px sidebar, no media queries → clipping at tablet/narrow.
- Added responsive CSS breakpoints (sidebar collapse + shell flex at 768px, 390px).
- 11 Playwright alignment tests green; full vitest suite green (1111+).

### 2026-06-04 - Landing page v2: About page rebuilt (9 sections, FlowDiagram engine)
- AboutPage rebuilt as 9 section components under `dashboard/src/components/about/`.
- FlowDiagram engine: instance-unique gradient IDs via useId(), inline SVG attrs, comet animation, reduced-motion guard.
- Hero: logo+wordmark + looping brain video (webm+mp4+poster).
- How-it-works: real 8-category diagram incl. RemSleep multi-agent node.
- Sleep flow + recall flow sub-sections; cortical-stack architecture; live usePacks() marquee; 26 collapsible feature cards.
- Built via goal-skill: 7 parallel opus implementers across 3 waves; reviewer + validator PASS.
- Build clean, tsc clean, light + dark screenshots pass (e2e/shots/).

### 2026-06-01 - v0.6 Control Panel: Settings, Packs, UpdateBadge, --vault (slices 1-2)
- Backend control-plane: `GET/PATCH /api/config`, `GET /api/packs`, `GET /api/version-check`, `GET /api/vaults` added to server.
- `src/lib/catalog.ts` extracted from `install-skill.ts` to keep `@inquirer/prompts` out of server bundle.
- `src/lib/vaults.ts` global vault registry + `resolveVaultContextRoot`; `vaults add/list/remove` CLI; `dashboard --vault` flag.
- Settings page (platforms checkboxes + packs toggles + read-only Vaults subsection), Packs page, UpdateBadge header component wired.
- 4 TanStack Query hooks: `useConfig`, `usePacks`, `useVersionCheck`, `useVaults`.
- `App.tsx` + `Shell.tsx` + `Sidebar.tsx` extended for `settings`/`packs` routes; `noImplicitReturns: true` added to `dashboard/tsconfig.json`.
- All safeChildPath guards applied to 7 route handlers; full suite: 962 tests green.

### 2026-05-23 - Brain 3D view toggle (v0.4)
- `BrainCanvas3D` component added: `react-force-graph-3d` + `three`-powered renderer, lazy-loaded as a separate Vite chunk.
- Billboard sprite labels (THREE.Sprite / CanvasTexture) always face camera, positioned below node sphere, opacity-dimmed on hover.
- Scene fog (`THREE.Fog 320–1100`) provides near/far depth perception; SpriteMaterial.fog=true ties label fade to scene fog.
- Click → camera fly-to: `cameraPosition()` over 900 ms moves camera along node's radial vector to 90-unit close distance.
- View toggle (`2d` | `3d`) persisted to `brain:settings:v1` localStorage; old state without `view` falls back to `'2d'`.
- `BrainSettings` extended with `SegmentedRow` component and View row at top of Display section.

### 2026-05-22 - v0.4 Dashboard: Flowchart-AC Sync + Design System + Bug Fixes
- Flowchart-to-acceptance-criteria sync: `<!-- node:<id> -->` markers bind mermaid nodes to checkboxes (bidirectional pending; checkbox→node live).
- Race-safe rapid checkbox toggles via `pendingBodyRef` pattern; failure reverts to `bodySourceRef`.
- Server PATCH body limit raised to 1 MB; `---` separator sanitization added.
- Mermaid edge-line corruption fix: EDGE_OPS_RE guard skips operator lines during node-class injection.
- Linear Midnight design system overhaul: Neon Lime accent, Inter Variable font, flat surfaces (glassmorphism removed), layered dark palette. Additive and non-breaking — old brand variables preserved.
- Filter persistence projectId hydration timing fix: filters no longer reset on page reload when projectId hydrates asynchronously.

### 2026-04-19 - Council UI + Brain Light Mode
- Council page: CouncilHall (searchable card grid) + CouncilDetail (back nav + Overview/Agents/Matrix tabs). Overview = dynamic final-report rendering. Agents = searchable TranscriptView with persona slug chips. Matrix = inline cell expand. Backend routes added. 3 UI iterations to reach accepted design (v1 gamified rejected, v2 report-buried rejected, v3 accepted).
- Brain graph light mode: theme-aware node color palettes (dark/light variants), link/canvas colors switch on isDark. Deeper light palette (#0d7bb8, #047857, #b45309, #6d28d9, #be185d, #475569).

### 2026-03-07 - in_review Status + Explore Agent Improvements
- Added in_review as 4th task status (workflow: todo->in_progress->in_review->completed)
- Kanban 4th column with purple color; in-review tasks included in snapshot, default tasks list, Eisenhower Matrix
- CLI, server validation, dashboard (Kanban column, TaskFilters, TaskDetailPanel, I18n), SQL schema updated
- 469 tests passing

### 2026-03-07 - Dashboard Phase 4c + Versions-as-Releases Unification
- Eisenhower Matrix view: 2×2 priority×urgency grid, excludes completed tasks, quadrant color tokens
- MultiSelectFilter: checkbox-based multi-select with type-ahead search (appears when >5 options), All/None toggle
- SubGroupSection: collapsible nested sections within Kanban columns (chevron, dot, label, count)
- urgency field (critical/high/medium/low, default medium) and version field added to tasks (CLI + API + UI)
- Group-by-urgency, group-by-version, group-by-tags (tasks appear in each applicable tag column)
- Versions unified with Releases: VERSIONS.json deleted, ReleaseEntry extended with status field (planning|released, backward compat)
- VersionManager redesigned: 680px modal, stats header, planning/released sections, Release button
- CLI: core releases add --status planning; Snapshot: Upcoming Versions section for planning entries
- File/Preview tabs: Core, Knowledge, Features pages all have MarkdownPreview + JsonPreview components
- Task slug extraction regex tightened (false positive fix — now anchored to JSON keys only)
- 468 tests passing

### 2026-02-27 - Project-Scoped localStorage + Zoom Controls + SubagentStart Fix
- Project-scoped localStorage: usePersistedState keys scoped by project hash (dreamcontext:{projectId}:{key}); legacy keys auto-migrated; theme remains global
- Zoom controls: 5 levels (85%-120%), persists globally, applied before React hydrates to prevent flash; font-size tokens use calc() with --zoom CSS var
- SubagentStart root cause analysis: additionalContext is lower priority than sub-agent system prompt; fixed by updating SKILL.md to make main agent smarter about delegation (include _dream_context/ paths in prompts)
- SubagentStart directive: IMPORTANT -> MANDATORY, named Glob/Grep, added actionable decision rule; feature format cleaned up
- sleep_history extracted to .sleep-history.json (separate file, auto-migrated on first read)
- 386 tests passing

### 2026-02-27 - Notion-Style TaskDetailPanel + Tool Count Scoring
- TaskDetailPanel redesigned: properties block (Notion-style bordered card) at top, full markdown body below via marked@^15
- Panel widened 520px → 680px; `.props-block`/`.prop-row` CSS grid (140px label / 1fr value)
- ExpandableText component: 3-line clamp with requestAnimationFrame detection, click to expand/collapse
- `body: string` field added to TaskData API response (from readFrontmatter content); backward compat maintained
- Added `marked@^15` to dashboard/package.json (~14KB gzipped, zero transitive deps)
- Tool count debt scoring: `scoreFromToolCount` added, session score = Math.max(change score, tool score)
- 336 tests passing

### 2026-02-26 - Update
- SQL parser rewrite + SubagentStart briefing restructure: fixed sql-parser.ts line-by-line parsing, added REFERENCES FK detection and JSONB sub-field collapsible groups in SqlPreview. Restructured SubagentStart briefing with directive at top to prevent sub-agents ignoring context files. 325 tests passing.
### 2026-02-26 - Enhanced Task Filters
- Status filter dropdown, text search (name+description), date range with field selector (created_at/updated_at)
- Filter state persisted via usePersistedState hook (localStorage prefix: dreamcontext:)
- Clear Filters button with active-count badge; preserves sortField and groupBy on clear

### 2026-02-26 - UI Polish + Bug Fix
- Fixed selectedTask stale snapshot: selectedSlug string + useMemo derivation from live TanStack Query data
- Animated brand gradient background with subtle-pulse, stagger entrance animations for Kanban columns
- CSS refinements: Header, Sidebar, Shell, KanbanColumn, TaskCard, TaskCreateModal, TaskDetailPanel, TaskFilters, CorePage, FeaturesPage, SleepPage, tokens
- Release discovery UI connected: releases list/show/add from dashboard API

### 2026-02-25 - Phase 4 Polish
- Error handling: ErrorBoundary, res.ok checks, mutation error feedback with auto-dismiss
- Field-level change tracking: FieldChange interface, net-change detection/folding, 19 new tests
- SQL ER diagram: sql-parser.ts, SqlPreview component with SVG bezier relationship lines, File/Preview tab toggle
- Server hardening: 1MB body size limit, graceful shutdown (SIGINT/SIGTERM), 30s socket timeout

### 2026-02-25 - Phase 1-4 Implementation
- Built complete server infrastructure: HTTP server, router, middleware, static file serving, 17 REST API endpoints
- Built change tracking: dashboard_changes array in .sleep.json, recorded on every mutating API call
- Built full React dashboard: Kanban board with drag-and-drop, filtering, sorting, grouping
- Built task CRUD: create modal, detail panel with status/priority editing, changelog entries
- Built sleep page: debt gauge, session history, dashboard changes timeline
- Built core file viewer/editor: file list, markdown split-pane editor with live preview
- Built knowledge page: search, pin/unpin, content viewer
- Built features page: list with status badges, full PRD section viewer
- Built design system: purple-magenta brand tokens, light/dark mode, 4px grid, HSL colors
- Built i18n infrastructure: English translations, t() function, ready for more languages
- Extended SleepState interface with dashboard_changes, updated sleep done to clear it
- Updated build pipeline: build:dashboard + build:cli, tsup copies dashboard output
- All 258 tests passing

### 2026-02-25 - Created
- Feature PRD created.
