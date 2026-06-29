# design-sync notes — dreamcontext dashboard

Repo-specific gotchas for syncing this design system to claude.ai/design. Read this before any re-sync.

## What this DS actually is
- `dreamcontext` is a CLI tool; the only design surface is `dashboard/` — a **private Vite + React 19 application** (the Tauri desktop UI), NOT a packaged component library. There is no library `dist/`, no published `.d.ts`, no Storybook.
- So this runs in the converter's **`package` shape, synth-entry sub-mode** (bundle built from `src/` directly, not from a built dist).
- **Scope is deliberate**: 16 reusable presentational primitives only (council badges + task primitives). Heavyweight/coupled components were intentionally excluded: the 3D brain canvas, Excalidraw canvases, force-graphs, Tauri/react-query-coupled settings & modals, and all full-page screens. Don't add those without a reason — most won't render standalone.

## The custom bundle entry (load-bearing)
- `dashboard/_ds_entry.tsx` is a **sync artifact** (committed) that re-exports exactly the 16 scoped components and imports the CSS foundation. `cfg.entry` points at it; `componentSrcMap` pins the same 16.
- It MUST live under `dashboard/` (not under `.design-sync/`) for two reasons:
  1. `PKG_DIR` is derived by walking up from `--entry` to the nearest named `package.json` → must land on `dashboard/package.json` (name `dreamcontext-dashboard`), which makes `srcDir`/`componentSrcMap` resolve correctly.
  2. esbuild's tsconfig auto-discovery (the converter passes no `tsconfig` esbuild option) finds `dashboard/tsconfig.json` (`jsx: "react-jsx"`) → automatic JSX runtime → the converter's reactShim handles `react/jsx-runtime`. Move the entry out of `dashboard/` and JSX breaks.
- The synth entry the converter would auto-generate is NOT used (it `export *`s the ENTIRE `src/` tree, pulling in pages + `api/client` + Tauri side-effects). The custom entry keeps the bundle to the 16 components + their minimal deps.

## CSS architecture
- The entry imports, in order: `_ds_fonts.css` → `src/styles/tokens.css` → `src/styles/reset.css` → `src/components/council/_ds-council-primitives.css`. esbuild bundles these (+ each component's own co-located `import './X.css'`) into `_ds_bundle.css`; `styles.css` `@import`s only `_ds_bundle.css`, so designs get the whole closure.
- `global.css` is **deliberately NOT imported** — it carries app-shell rules that shouldn't leak into designs (`body { overflow: hidden }`, mermaid `!important` overrides, scrollbar styling, stagger animations). Only its tokens+reset (which the entry imports directly) are wanted.
- Two **extraction** sync artifacts hold styles that synced components reference but don't co-locate (the rules live in page/parent stylesheets that aren't otherwise bundled). The entry imports both:
  - `src/components/council/_ds-council-primitives.css` — `.council-*` badge styles for StatusBadge/ModelBadge/StatTile/PersonaAvatar, extracted from `src/pages/CouncilPage.css`.
  - `src/components/tasks/_ds-task-controls.css` — `.filter-chip*` trigger styles (from `TaskFilters.css`, needed by MultiSelectFilter & VersionFilter) + `.field-input`/`.field-select` form-control styles (from `TaskCreateModal.css`, needed by CustomFieldInput).
  If any of those classes change upstream, re-extract. (We extract scoped rule-blocks rather than importing the whole 500-line page stylesheets, to keep the design closure from filling with selectors for non-synced components.)

## Component authoring notes (for re-authoring previews)
- **Render clock is ~1 month behind the shell** and is NOT the fictional project date. Date-windowed viz (ActivityHeatmap; also any gantt/calendar/timeline) must generate dates as **day-offsets from `new Date()` evaluated in the preview module** (esbuild doesn't run top-level `new Date()` at build time, so it resolves to the render runtime). Absolute ISO dates render an empty heatmap. MiniCalendar's empty-range cell likewise defaults its view month to the render clock.
- **ModelBadge** `modelHue()` only varies on names containing `opus`/`sonnet`/`haiku`; everything else collapses to violet 280. Use those names so the hue axis visibly varies.
- **RiceScatter** needs `task.rice = {reach,impact,confidence,effort,score}` all non-null (else the task drops to the "Unscored" tray); completed tasks are filtered out. Encoding: X=effort (low-effort RIGHT), Y=impact, radius=reach, opacity=confidence, color=status.
- **SearchableSelect** open state is INTERNAL (no `isOpen` prop) — previews can only show the closed trigger; the dropdown can't render statically. MultiSelectFilter/VersionFilter/FilterPopover take `isOpen` as a prop, so their open popovers DO render (and fit their card cells — no cardMode override needed).

## Fonts
- The dashboard loads Inter / Plus Jakarta Sans / JetBrains Mono from **Google Fonts at runtime** (a `<link>` in `dashboard/index.html`). `dashboard/_ds_fonts.css` carries the equivalent `@import url(...)`, imported first so esbuild hoists it to the top of `_ds_bundle.css` (a remote `@import` must precede other rules — verified it lands at line 1).
- `cfg.runtimeFontPrefixes` lists the families so `[FONT_MISSING]` is suppressed (they're served at runtime, not shipped as woff2). The `[FONT_REMOTE] "IBM Plex Mono"` warn is benign (a fallback family named in `--font-mono`).
- The `Assistant-*.woff2` files under `dashboard/dist/assets/` are an i18n font, not part of the core brand — not shipped.

## SearchableSelect regex (app source was edited — intentional, user-approved)
- `dashboard/src/components/tasks/SearchableSelect.tsx` `fold()` had accent-folding regexes written with **literal combining-mark / Turkish bytes** (`/[̀-ͯ]/g` etc.). That made the whole compiled bundle crash ("Range out of order in character class") whenever it wasn't served as UTF-8 (the bundle was the ONLY non-ASCII in the build). Fixed in source to escaped code points (`̀-ͯ`, `ı`, ...) — byte-identical behavior, ASCII-clean bundle. This is a real latent portability fix, kept in the app source.

## dtsPropsFor (all 16 hand-written)
- Synth-entry mode couldn't extract per-component prop types — every `.d.ts` came out as `[key: string]: unknown`. `cfg.dtsPropsFor` supplies the real prop bodies for all 16, pulled from each component's source interface.
- Task-consuming components inline the full `Task` shape (from `src/hooks/useTasks.ts`) once for their primary `task`/`tasks` prop, and use TS indexed-access self-refs (`<Name>Props['tasks'][number]`) for callback params to stay DRY. If the real `Task`/`CustomFieldDef`/`VersionFilterItem` interfaces change, update the matching `dtsPropsFor` entry.

## Build / validate commands
```
node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules dashboard/node_modules --entry ./dashboard/_ds_entry.tsx --out ./ds-bundle
node .ds-sync/package-validate.mjs ./ds-bundle
```
- `--node-modules dashboard/node_modules` (where `react` resolves), `--entry` the custom entry.
- Render check uses the repo's own `playwright@1.60.0` (pins chromium-1223, already cached at `~/.cache/ms-playwright/`). No install needed.

## Known render warns (triaged-legitimate)
- `[FONT_REMOTE] "IBM Plex Mono"` — benign (runtime/fallback font family). Not new on re-sync.

## Re-sync risks (what can silently go stale)
- **`dashboard/_ds_entry.tsx`, `dashboard/_ds_fonts.css`, `dashboard/src/components/council/_ds-council-primitives.css`** are committed sync inputs OUTSIDE `.design-sync/`. A re-sync depends on them existing; don't delete them. If a council badge's classes change, re-extract the primitives CSS.
- **`dtsPropsFor` is a hand-written snapshot** of the source prop interfaces — it does NOT auto-track source changes. If a component's props change, its `.d.ts` here goes stale until the entry is updated.
- **The `Task` shape is inlined** in several `dtsPropsFor` entries — same staleness risk.
- The bundle's ASCII-cleanliness depends on the SearchableSelect source fix staying in place; if that regex reverts to literal bytes, the bundle will crash under non-UTF-8 serving again.
