---
id: know_dashboard_knowledge_rendering
name: dashboard-knowledge-rendering
description: >-
  How the dreamcontext dashboard renders knowledge files: Excalidraw boards via
  live @excalidraw/excalidraw canvas (not exported SVG), SQL via SqlPreview ER
  view, Markdown via MarkdownPreview, and the /api/knowledge-assets route for
  resolving Obsidian board embedded images (SHA1→path→base64 WebP via sharp).
  Also covers the live-refresh header button and SQL fence-concat fallback.
type: knowledge
tags:
  - architecture
  - decisions
  - frontend
  - topic:excalidraw
  - topic:dashboard
pinned: false
created: '2026-06-17'
updated: '2026-06-17'
---

## Why this exists

The dashboard Knowledge page renders three distinct file types (Markdown, SQL/ER, Excalidraw) via different strategies. This file documents the rendering architecture, the key tradeoffs, and the invariants that must be preserved when modifying either the server routes or the React components.

## Rendering pipeline

### Excalidraw boards: live canvas, not exported SVG

**Problem with SVG export:** `@excalidraw/excalidraw`'s `exportToSvg()` rasterizes the board once (WebKit/WKWebView samples a 2556×4646 px SVG down to the viewport) — soft edges on high-DPI screens, and no sharp recovery on zoom because the exported SVG is a rasterized bitmap, not vector.

**Current implementation (PR #35, commit d106c5c):** The dashboard now uses the real `@excalidraw/excalidraw` `Excalidraw` component in **view-mode** (`viewModeEnabled={true}`, `zenModeEnabled={true}`). Each zoom re-draws via the canvas — crisp at any scale. Native wheel-pan and pinch-zoom work without panzoom. The board auto-centers via `excalidrawAPI.scrollToContent({ fitToViewport: true })` on:

1. Mount (once the API ref is ready).
2. A 100 ms layout-settle timer (catches flex-pane final dimensions).
3. `ResizeObserver` on the container (catches fullscreen toggle / panel resize).

**Lazy load:** `@excalidraw/excalidraw` is a large bundle. It is imported via `React.lazy()` + `<Suspense>` so the initial dashboard bundle is unaffected.

**Key files:**
- `dashboard/src/components/core/ExcalidrawPreview.tsx` — canvas component, lazy-load, scrollToContent orchestration, ResizeObserver.
- `dashboard/src/lib/excalidraw.ts` — `extractExcalidrawScene()` (parses `## Drawing` fenced block, handles both `json` and `compressed-json`); `isExcalidrawSlug()`.

**INVARIANT:** The server knowledge detail route (`GET /api/knowledge/:slug`) ALWAYS returns the RAW board body (scene JSON intact). The memory/index/recall paths use extracted text only (`extractExcalidrawText()` from `src/lib/excalidraw-text.ts`). Never merge these two surfaces — one is for rendering, one is for memory.

### Embedded images in Excalidraw boards

**Problem:** Obsidian-authored boards reference embedded screenshots via `## Embedded Files` section: `<sha1>: [[vault/path/to/image.png]]`. The `files` map in the `## Drawing` scene JSON is empty (Obsidian resolves at render time via the vault). A non-Obsidian renderer receives image elements whose `fileId=<sha1>` cannot resolve.

**Solution (PR #35):** New server route `GET /api/knowledge-assets/:slug` (`src/server/routes/knowledge.ts`):
1. Reads the board file for the given slug.
2. Parses `## Embedded Files` to extract the `sha1 → vault-relative-path` map.
3. Resolves each path under the vault root (containment-guarded via `safeChildPath()`; image extensions only: png/jpg/jpeg/gif/webp/svg).
4. Reads the image file, down-scales to WebP via `sharp` (tier-aware compression: small board ≤5 images = lossless; large boards use lossy quality 80).
5. Returns `{ files: { [sha1]: { mimeType: 'image/webp', dataURL: 'data:image/webp;base64,...' } } }`.

The React component merges these resolved files into the scene before mounting the `Excalidraw` canvas: `setScene({ ...parsed, files: { ...resolved } })`.

**Caching:** responses are cached by `path+mtime` (stat-based) so repeated renders don't re-compress.

### SQL / data-structures: SqlPreview ER view

Files whose slug starts with `data-structures/` go to `SqlPreview` — the same relational/ER component used by the old Core page. A `fenceConcat` fallback concatenates multiple ` ```sql ` fenced blocks (covers multi-table files that have per-table fences) before passing to the SQL parser. Files with no `sql` fence fall back to raw MarkdownPreview.

**Key file:** `dashboard/src/components/core/SqlPreview.tsx`, `dashboard/src/components/core/SqlPreview.css`.

### Live refresh

The Knowledge page and all other pages now have a **refresh button in the header** (`dashboard/src/components/layout/Header.tsx`). Clicking it calls `queryClient.invalidateQueries()` for the current page's query key — no full page reload. This resolves a UX gap where sleep debt, task changes, and knowledge edits were not reflected without navigating away.

**Key file:** `dashboard/src/components/layout/Header.tsx`, `dashboard/src/components/layout/Header.css`.

## Decisions log

- **Canvas over SVG (2026-06-17):** `exportToSvg()` was the prior approach (cheaper — no live canvas mount). Replaced because rasterization at export time produces soft results on retina screens and zoom does not re-sharpen. The live canvas option is more expensive but gives crisp rendering at any zoom level and native pan/pinch.
- **scrollToContent triple-trigger (2026-06-17):** A single `onMount` call fires before the flex-pane reaches its final layout dimensions (board lands off-center). Adding a 100 ms timer + ResizeObserver guarantees the board is fit-and-centered after any layout change, including fullscreen transitions.
- **knowledge-assets route is image-only, containment-guarded (2026-06-17):** The route resolves paths embedded in board files. It enforces `safeChildPath()` and an explicit image-extension allowlist to prevent path traversal and arbitrary file exposure. See `dashboard-server-security.md` for the broader security model.

## Sources

- Commit `d106c5c` — `feat(dashboard): Excalidraw canvas rendering + board image resolution, SQL fences, live refresh`
- PR #35 (open, branch `fix/dashboard-render-and-refresh`)
- Session `b9137911-a9d0-42f7-863d-f8d56831ba5d`
- Related: `dashboard-server-security.md` (security invariants), `knowledge-base` feature PRD (memory/render invariant)

## Last verified

2026-06-17 (PR #35 open; commit d106c5c on branch fix/dashboard-render-and-refresh)
