---
id: feat_nquc4W_e
type: feature
name: whiteboards
description: >-
  Editable Excalidraw control panels with live widgets that the user and the
  agent edit together, plus a wiki side of it: any file is a page, wiki cards
  hold their own page lists, and pages read in a side panel beside the board
  (dashboard page + dreamcontext whiteboard CLI)
pinned: false
date: '2026-09-29'
status: in_review
created: '2026-09-29'
updated: '2026-10-05'
released_version: null
tags:
  - 'topic:dashboard'
  - 'topic:cli'
  - 'topic:excalidraw'
  - 'topic:whiteboard'
  - frontend
  - backend
related_tasks:
  - >-
    whiteboard-modulu-her-board-ajanin-ve-kullanicinin-birlikte-cizdigi-canli-widget-tasiyan-bir-excalidraw-kontrol-paneli-olur
  - >-
    whiteboard-wiki-olur-sayfalar-board-dan-cikmadan-popup-ta-wiki-menusunde-ve-tuval-wiki-modunda-okunur
  - whiteboard-sekmeleri-chrome-gibi-yan-yana-durur-renkli-gruplara-ayrilir
  - >-
    whiteboard-a-ajan-karti-eklenir-board-u-bilen-yalniz-kendi-board-una-yazan-ustune-birakilan-widget-i-soran-otomasyon-ajani
  - >-
    a-whiteboard-shows-a-funnel-as-its-explorer-any-lab-card-as-a-widget-and-the-date-window-on-the-card
  - >-
    whiteboard-kartlari-cilalanir-sekme-yeniden-adlandirilir-insight-basligi-tekrarsiz-kartlar-dip-dibe-durur-karta-renk-verilir-html-kutusuna-sigar
  - >-
    whiteboard-sayfasi-kaldigin-yerden-acilir-board-ajani-sayfalar-arasi-canli-kalan-yan-panelde-yasar-sag-alttaki-ajan-dock-u-whiteboard-da-gorunmez
---

## Why

The owner wanted one place that gathers the brain: a control panel, wiki and brainstorming wall where insights, knowledge, tasks, todos and interactive HTML sit together and an agent or automation can read and rewrite it. Before this, Excalidraw was a read-only viewer; nothing could write a board and no CLI let an agent edit one.

## User Stories

- [x] As the owner, I want a board where insights, knowledge, tasks, todos, notes and HTML blocks sit together, so the brain has one control panel I can arrange by hand.
- [x] As the owner, I want to tick a todo on the board and have the agent read it back, so I never have to tell it what I finished.
- [x] As an agent or automation, I want to clear yesterday's items and write today's in the same place with two commands, so a daily board keeps its layout.
- [x] As a teammate, I want boards to travel with brain sync and merge per element, so two people editing one board never lose each other's work.
- [x] As the owner, I want clicking a card to open the page **beside** the board instead of throwing me off the whiteboard, so reading a knowledge page never costs me my canvas, my zoom or my unsaved strokes.
- [x] As the owner, I want a wiki card that holds the page list I chose — sections I name, pages I drag into order — so one board can carry several little wikis instead of one automatic knowledge tree.
- [x] As the owner, I want any file to be a page (knowledge markdown, a PDF, an HTML export), so the board reads the things I actually keep in the project, not only brain entries.
- [x] As the owner, I want to drag a widget to the exact box I need (a phone-width web embed), so the sizes help me instead of springing my box back to a preset.
- [x] As the owner, I want my open boards side by side like Chrome tabs, in named and coloured groups I can fold away, so moving between boards is one click instead of a dropdown and a search.
- [x] As the owner, I want closing a tab to ask first and say plainly that the board stays, so I never lose a board to a reflex click on an ×.
- [x] As the owner, I want a deleted board to come back, so a delete is a mistake I can undo rather than a loss.
- [x] As the owner, I want the wheel to keep panning the board even when the pointer drifts over a live HTML or web block, so a pan is not swallowed mid-gesture.

## Acceptance Criteria

Phase 1 (task `whiteboard-modulu-…`, criteria A1-A14 there are canonical):

- [x] `dreamcontext whiteboard create "Günlük"` writes `_dream_context/whiteboards/gunluk/gunluk.excalidraw.md` with the name verbatim; the dashboard parses it.
- [x] `add`/`update`/`remove`/`draw`/`show` work for all seven widget kinds; `show --json` reports a UI-ticked todo as `done: true`; `remove --tag` prints the removed bbox.
- [x] A CLI write and a stale browser PUT both survive the per-element merge; an unchanged PUT rewrites nothing.
- [x] Whiteboard is in the Workspace rail (alpha), opening the default board "Control Panel"; a board is created, edited and persists across reloads; a CLI edit shows within 3s without dropping unsaved strokes.
- [x] Right-click on empty canvas (or + Add) opens the widget palette; right-click on an element keeps Excalidraw's menu.
- [x] HTML blocks run sandboxed with no input bridge; web embeds are https-only and click-to-load.
- [x] A board that does not parse is never overwritten; images are refused visibly.
- [x] A header **switcher** (search, + new, inline delete) moves between boards without leaving the page, and the rail entry opens the default board.
- [x] Widgets carry **S/M/L/XL sizes** on a 180/16 grid with snap-on-release, and their content adapts to the size instead of being scaled: an L/XL insight draws one full-card line chart with its date axis, M the number plus a sparkline, S the number alone.
- [x] Knowledge and task cards show the entry's **title** (humanised slug as the fallback); a dangling ref still reads "not found".
- [x] An HTML block draws no inner bordered box inside the card chrome.
- [x] An L/XL insight's chart stays inside its card at any box height (the chart measures its own box instead of being handed a height).
- [x] A widget shows no Excalidraw link icon floating past its corner; ordinary linked drawings keep theirs.
- [x] A metric put on a board by an agent lands as a live insight widget, never as a drawn chart with today's numbers baked in (skill rule, excalidraw pack exclusion).
- [ ] Owner sign-off in the installed .app closes the task (`verify:whiteboard` in both themes is green).

Phase 1.5 — pages, wiki cards and the side panel (task `whiteboard-wiki-olur-…`, criteria F1-F3 there are canonical):

- [x] A knowledge/task card, a page card, a `dreamcontext://` link or a wiki card's page opens the page in a panel on the board's **right** that pushes the canvas aside; the app page never changes, unsaved strokes and zoom/pan survive, and the board slug stays in the URL hash.
- [x] The panel has back/forward, Esc and ×, Expand to the full board width, a title-only header, a `⋯` menu for secondary actions (open in Knowledge/Tasks, open on the computer, reveal in Finder, copy path) and one family of line icons.
- [x] The reader looks like a page, not a card: no frame, body text ≥15px, ~70-character measure, generous margins — the same in the panel and in an L/XL wiki card, in both themes.
- [x] `MarkdownPreview` turns `[[target]]` and `[[target|label]]` into links the reader follows in place, saying "not found" when a target does not resolve.
- [x] A PDF opens embedded with its title printed once; when the engine cannot draw it, "open on the computer" is always reachable.
- [x] Opening the panel pans the board by the least amount that shows the whole opener with a margin (zoom never changes; a card already in view never moves; a card wider than the canvas aligns its left edge). Closing restores the pre-open pan **only** if the user did not pan or zoom while reading; Expand and in-panel navigation never pan.
- [x] Any file is a page: a page card takes a knowledge slug **or** a project-relative `.md`/`.pdf`/`.html` path, wears the file's own type label (not "KNOWLEDGE"), shows a readable title, and old knowledge widgets keep working without migration. The palette picker searches knowledge + project files and labels them Knowledge / MD / PDF / HTML.
- [x] `agentFileKind` returns `html` for `.html`/`.htm`; an HTML page draws in chat's strict sandbox (`allow-scripts`, no network, CSP `default-src 'none'`) with a one-line note that outside css/images are not loaded.
- [x] A `wiki` widget kind carries its own title and ordered sections of pages in `customData.dc.sections`, so a board can hold several; every write path validates the list (pages-less sections refused, page refs checked), a tombstone drops the sections, and the list survives element-merge and git sync.
- [x] At S/M a wiki card IS the list (whole rows only, "+N more" when rows are hidden) and a page opens the side panel; at L/XL the list sits beside an in-card `DocumentReader` with its own back/forward and a single selection highlight.
- [x] The list is edited in the card: add/rename/delete a section, add/remove a page, reorder sections and pages by drag-and-drop or Alt+Arrow, all written to the board file.
- [x] The left wiki menu, the Canvas | Wiki mode switch, the wiki URL state and board-level nav (`dreamcontext-wiki` frontmatter + nav routes) are **removed**; the canvas is full width again.
- [x] CLI: `whiteboard add <slug> wiki --title`, `whiteboard nav list|add|remove|move --card <id>` edits a card's list under the board lock, `show --json` reports every wiki card under `wikis`; `GET /api/whiteboards/pages` searches knowledge + project files (symlinks skipped).
- [x] A drag-resize keeps the box the user dragged it to (4px step, 120×96 floor) instead of springing to the nearest preset; `dc.size` records the nearest preset for content layout, the size control shows no current preset on a free-form box and snaps back on a pick; todo rows follow the real box height.
- [x] A plain click anywhere on an inactive widget activates it **and** hands that same click to the control under the pointer (a todo ticks in one click).
- [x] Unit tests (wikilinks, `agentFileKind` html, wiki payload/merge/reorder, nav CLI, board hash, panel pan rules) plus `verify:whiteboard` in both themes: 679 checks.
- [ ] Owner sign-off on the panel and the wiki card in the installed .app.

Phase 1.6 — board tabs, a close that asks, and a local trash (task `whiteboard-sekmeleri-…`):

- [x] The header dropdown is replaced by a **Chrome-style tab strip**: open boards side by side, drag to reorder, and a close that is not a delete. Tabs can be grouped with a name and one of 8 colours (chart tokens); the chip is solid with dark ink (≥4.4:1 on every hue), one group line runs under chip + tabs, an open grouped tab is outlined in the group colour, and clicking the chip collapses the group. The layout is per machine + vault in `localStorage`.
- [x] Every close path (×, middle click, Close tab, Close other tabs, Close group) asks in an in-app popover that states the board stays, with Cancel and Close and **nothing red** — nothing is lost.
- [x] "All boards" carries a folding **Recently deleted** section: the trash listed with a relative time and Restore, which reopens the board (under `<slug>-2` when the old slug was taken since). `trash` is a reserved slug.
- [x] The trash never syncs: `whiteboards/.trash/` carries its own `*` `.gitignore`, so a delete history stays on the machine that made it.
- [x] A wheel pan that started on the canvas keeps panning **through** an active HTML or web block (the latch drops after 250 ms of quiet), instead of being eaten by the iframe's own document.
- [x] Old `.wbs-*` selectors are kept so `scripts/verify/whiteboard.mjs` still drives the header. Evidence: `tests/unit/whiteboard-tab-strip.test.ts` 16/16, the whiteboard unit set 339/339, `scripts/verify/whiteboard-tabs.mjs` (21/21 ×3 for the strip, extended for close + trash), `verify:whiteboard` 679/679, root + dashboard `tsc` 0.
- [ ] Owner sign-off on the tab strip, the close popover and Restore in the installed .app.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-10-04]** **A number on a whiteboard is a live insight widget, never a drawing.** An agent asked to put MRR and revenue on the Control Panel loaded the excalidraw pack and drew charts with that day's values frozen into them, because nothing routed it to widgets: the pack's description triggered on "KPI tiles"/"dashboard board" with no whiteboard exclusion. The exclusion now leads the pack's description (the listing truncates near 1000 chars) with a STOP block for whiteboard targets, and `skill/references/whiteboards.md` + the SKILL.md router row state the rule; drawn recipes are for data-free diagrams only.
- **[2026-10-04]** **Widget link icons are removed by patching Excalidraw at build time, guarded.** Excalidraw paints a link icon past the top-right corner of every linked element and offers no option to turn it off; on a widget the `dreamcontext://` link is its identity, not a link to follow, and the icon sat over the neighbouring card. A Vite plugin (`dashboard/excalidraw-widget-link-icon.ts`) rewrites the one guard before that paint to skip widget links only. Because it is a source patch on a dependency, a production build **fails** if the guard is not found exactly once, and a unit test pins it in both the dev and prod builds — an Excalidraw upgrade cannot silently bring the icon back or break the patch.

- **[2026-10-04]** **Close is not delete, and delete is not loss.** Closing a tab never touched the board, but nothing on screen said so, so every close now asks in a popover that states the board stays — and deliberately uses no destructive red, because the dialog's whole job is to say nothing is lost. A delete already moved the board into `whiteboards/.trash/`, which had no way back; the trash is now listed under "All boards" with Restore (re-slugged to `<slug>-2` if the name was taken since). The trash keeps its own `*` `.gitignore`: a delete history is one machine's business and must never reach the team's repo.
- **[2026-10-04]** **An active widget must not swallow a gesture that started on the canvas.** An active HTML or web block takes pointer events, so a wheel that drifted over it landed in the iframe and the pan died mid-gesture. The pan itself (wheel on canvas, momentum included) latches widgets open to the wheel, and the latch drops after 250 ms of quiet — the gesture's owner is where it STARTED, not where the pointer happens to be.
- **[2026-10-03]** The board switcher became a **tab strip**, not a prettier dropdown: open boards are the state the owner wants to see, so they are side by side, draggable, and groupable with a name + colour; the group chip is a solid tinted chip with dark ink (≥4.4:1 on all 8 chart hues) and collapses its group. The layout is per machine + vault in `localStorage` — a tab arrangement is a workspace habit, not shared brain content. Old `.wbs-*` selectors are kept so the existing verify script keeps driving the header; closing the open tab remounts the strip, so the layout is written **synchronously** rather than from a state updater that the remount discards (caught by `verify:whiteboard-tabs`, not by review).
- **[2026-10-03]** The opener stays visible: because the panel pushes the canvas, opening pans the board by the minimum that shows the whole opening card (zoom untouched), and closing restores the pre-open pan **unless** the user panned or zoomed while reading — in which case their board is the new place to return to. The rules are pure functions in `pagePopupModel.ts`, measured by `verify:whiteboard` in both themes.
- **[2026-10-03]** A drag-resize is authoritative: the box stays where the user dragged it (4px step, 120×96 floor) and `dc.size` becomes a derived *content-layout* hint (nearest preset), not a geometry constraint. A free-form box shows no current preset; picking one snaps back deliberately.
- **[2026-10-02]** The side panel **pushes** the canvas rather than overlaying it: overlaid it hid Excalidraw's + Add, Library and the right half of the toolbar. Expand still lays the panel over the full board width. The look stays the Brain `.brain-drawer` pattern (slide in from the right, border-left, shadow).
- **[2026-10-02]** **The wiki is a card, not a mode** (owner, after reviewing the first build and calling it ugly). This supersedes the earlier "Canvas | Wiki mode" decision, which mis-carried the intent: a wiki is a `wiki` widget whose pages are the list the owner chose (`customData.dc.sections`), several per board; an automatic folder tree over all knowledge was explicitly NOT wanted; the left wiki menu, the mode switch and the wiki URL state are removed and the canvas is full width.
- **[2026-10-02]** One reader, reused: `ViewerWindow`'s type routing (md / pdf / media / board) is extracted into a shared `DocumentReader` that the viewer window, the side panel and the L/XL wiki card all mount — extracted, not rewritten (component-reuse-over-reimplementation).
- **[2026-10-02]** One vocabulary across picker, cards and panel: a knowledge page is labelled "Knowledge"; project files keep MD / PDF / HTML. "Open in Knowledge" is not removed, it demotes to a secondary action — the primary click no longer leaves the board.
- **[2026-10-02]** URL: the wiki parts of the hash (`wbmode`, `wbpage`) are gone; the board itself stays in `#wb=<slug>` so a reload lands on the same board (`pages/whiteboards/boardHash.ts`).
- **[2026-10-02]** `.html` pages render in the **strict** chat sandbox (no network, CSP `default-src 'none'`, no assets from their own folder), with a one-line note in the panel saying so.
- **[2026-10-02]** Every UI wave closes with the lead looking at real screenshots in both themes before the reviewer, and the owner on the last wave. Reviewers read code only; they did not catch the first build's appearance.
- **[2026-09-30]** The feature is named **Whiteboard** (owner): the Workspace rail entry says "Whiteboard" (key `nav.whiteboard`, page id `whiteboards` unchanged). "Control Panel" names only the default board (slug `control-panel`); the Packs/Settings group is "System".
- **[2026-09-29]** Named `whiteboard` in code, CLI and routes: `board` already means Tasks saved views (`src/server/routes/board.ts`) and chat's `ref.kind === 'board'` (a read-only excalidraw file). UI label was "Whiteboards" (now "Whiteboard", 2026-09-30 above).
- **[2026-09-29]** Storage inside the brain, git-tracked, in the Obsidian Excalidraw format with a plain json fence; a nested `whiteboards/.gitattributes` (`* merge=binary`) routes every git divergence to the `whiteboard-md` element-merge handler instead of a line splice. A nested `.gitignore` keeps `.locks/` and `*.tmp` out.
- **[2026-09-29]** Widgets are Excalidraw `embeddable` elements (`link: dreamcontext://<kind>/<id>`, payload in `customData.dc`); a tag on a plain drawn element lives in `customData.dcTag`. `validateEmbeddable` rejects every other link, so Excalidraw's native iframe embed never runs.
- **[2026-09-29]** Concurrency is Excalidraw's own reconcile rule per element (higher `version`, then lower `versionNonce`), with tombstones kept forever in Phase 1; live updates by a 2s rev poll, not SSE. The poll runs `restoreElements(remote, null)` so an unsaved local edit is never bumped over.
- **[2026-09-29]** HTML blocks reuse chat's sandbox without `REACH_BRIDGE` (a shared-repo block must not be able to send ⌘A+Backspace to the board) and without `KIT_BEHAVIOUR` (no `dc-tabs` switching; authors write their own inline script). `onLinkOpen` always `preventDefault`s first.
- **[2026-09-29]** No images in Phase 1: `UIOptions.tools.image=false`, and the CLI, PUT validator and `draw` refuse `image` elements and a `files` key.
- **[2026-09-29]** A compressed (Obsidian-saved) board is refused rather than decompressed; the user runs "Decompress current Excalidraw file" in Obsidian.

## Technical Details

**What shipped in Phase 1**
- Canvas (`WhiteboardCanvas`, editable, separate from the read-only `ExcalidrawCanvas` viewer) with self-hosted Excalidraw fonts, the right-click widget palette and pickers, and seven widgets: insight card, knowledge link, task link, todo list, sanitized markdown note, sandboxed HTML block, click-to-load web embed.
- **Sizes are a widget property, not a scale.** S/M/L/XL on a 180/16 grid with snap-on-release; each widget renders a form appropriate to its size rather than a zoomed copy of one layout (an L/XL insight is a single full-card line chart with its date axis — the first pass drew `InsightView`'s corner sparkline AND a second chart in the same card). Knowledge/task cards resolve and show the entry title, falling back to a humanised slug, and a dangling ref says "not found".
- **Board switcher** in the header (search, + new, inline delete) plus a `/api/whiteboards/default` route behind the rail entry.
- `dreamcontext whiteboard list|create|show|add|update|remove|draw`.
- Server routes: `GET/POST /api/whiteboards`, `GET/PUT/DELETE /api/whiteboards/:slug`, `GET /api/whiteboards/:slug/rev`. PUT is strict-picked to `{elements}`, capped at 5MB, merged under the board lock, and returns `{rev, elements?}` (elements only when disk contributed). A missing board is 404 and never re-created; a corrupt one is 422. DELETE moves the board to `whiteboards/.trash/<slug>-<ts>/`.
- Dashboard page with list grid, save loop (800ms debounce, one PUT in flight, retry with backoff, sticky "Not saved", flush on hide/unmount, deleted-board and corrupt-board states), and chat references to `_dream_context/whiteboards/…` opening the page.
- Git sync `whiteboard-md` merge class (add/add union, delete/modify, 3-way frontmatter, corrupt side → agent).

**What shipped in Phase 1.5 — the wiki side (2026-10-02/03)**
- **Sizes are now free-form.** A drag-resize keeps the dragged box (4px step, 120×96 floor); `dc.size` is the nearest preset kept only as a content-layout hint, so a web widget can be phone-width. A plain click on an inactive widget activates it and forwards the click to the control under the pointer.
- **One shared reader.** `DocumentReader` holds the md / pdf / media / board routing that used to live inside `ViewerWindow`; the viewer window, the whiteboard side panel and the L/XL wiki card all mount it. `PdfViewer` gained an embedded mode, `.html`/`.htm` became their own kind drawn in chat's strict sandbox, and `MarkdownPreview` renders `[[wikilinks]]` as links the reader follows in place.
- **A side panel beside the board.** `PagePopup` slides in from the right and **narrows** the canvas (not an overlay), with back/forward, Esc, ×, Expand to full board width, a title-only header and a `⋯` overflow menu. `pagePopupModel.ts` holds the pure geometry: the minimum pan that keeps the opening card fully visible, and the restore-on-close rule that yields to a pan/zoom the user made while reading.
- **Any file is a page.** A page card's ref is a knowledge slug or a project-relative `.md`/`.pdf`/`.html` path; the card wears the file's type label and a humanised title; the palette picker searches both through `GET /api/whiteboards/pages` (`src/lib/whiteboards/pages.ts`, symlinks skipped).
- **The `wiki` widget kind.** Title plus ordered `sections[{id,title,pages[{ref,label?}]}]` in `customData.dc`, several cards per board, validated on every write path, stripped by a tombstone, element-merged like any widget. S/M renders the list (whole rows, "+N more"); L/XL renders list + in-card reader. The list is edited in the card (sections add/rename/delete, pages add/remove, DnD and Alt+Arrow reorder) through `host.commitWidget`.
- **Removed:** the left wiki menu, the Canvas | Wiki mode switch, the `dreamcontext-wiki` frontmatter and the board-level nav routes. Only `#wb=<slug>` remains in the hash.
- CLI: `whiteboard add <slug> wiki --title`, `whiteboard nav list|add|remove|move --card <id>`, `show --json` reporting `wikis`.
- The default **Control Panel** board and its folder now ship inside the brain (`dbf94fd8`).

**What shipped in Phase 1.6 — tabs, a close that asks, a local trash (2026-10-03/04)**
- **The header is a tab strip.** `BoardTabs.{tsx,css}` with the pure `tabStripLogic.ts` replaced `BoardSwitcher`'s dropdown as the primary surface: tabs side by side, drag reorder, close ≠ delete, groups with a name and 8 chart-token colours, one group line under chip + tabs, an outline in the group colour on the open grouped tab, and a chip click that collapses the group. The arrangement is per machine + vault in `localStorage`, written synchronously because closing the open tab remounts the strip.
- **Closing asks.** Every close path (×, middle click, Close tab, Close other tabs, Close group) opens an in-app popover: the question, one sentence that the board stays, Cancel and Close, nothing red.
- **The trash is real and local.** `trash` / `list` / `restore` live in `src/lib/whiteboards/store.ts` under the board lock, exposed as `GET /api/whiteboards/trash` and `POST /api/whiteboards/trash/:id/restore`, with `trash` reserved as a slug; "All boards" grows a folding "Recently deleted" section (relative time + Restore, re-slugged to `<slug>-2` on a collision). `whiteboards/.trash/` carries its own `*` `.gitignore`.
- **Pan beats an active widget.** While a canvas-started wheel pan runs (momentum included), widgets let the wheel through; the latch drops after 250 ms of quiet, so a pan is never swallowed by an active HTML or web block's iframe.
- Verification: `tests/unit/whiteboard-tab-strip.test.ts`, `scripts/verify/whiteboard-tabs.mjs` (strip + close + trash), with `verify:whiteboard` unchanged at 679 checks because the `.wbs-*` selectors were kept.
- **Card polish (2026-10-04).** `InsightWidget` passes no height to `LineChart` (which now takes layout pixels, not the old `560*h/w` viewBox contract) and lets it measure its own box, so an L/XL chart no longer runs off the card bottom. The widget link icon is suppressed by the build-time Excalidraw patch in `dashboard/excalidraw-widget-link-icon.ts` (wired in `dashboard/vite.config.ts`, pinned by `tests/unit/whiteboard-link-icon-plugin.test.ts`).

**Key files**
- `src/lib/whiteboards/`: `format.ts` (parse/serialize, deterministic), `merge.ts` (`mergeElements`), `store.ts` (paths, lock, `mutateWhiteboard`, rev, git hygiene files), `widgets.ts` (`WIDGET_KINDS` incl. `wiki`, `makeWidgetElement`), `validate.ts` (slug/ref/tag/url/element/wiki-sections/PUT body), `nav.ts` (a wiki card's section+page list ops under the board lock), `pages.ts` (knowledge + project-file page search and title resolution), `ops.ts` (show incl. `wikis`, update, remove, draw import), `errors.ts`
- `src/cli/commands/whiteboard.ts`, `src/server/routes/whiteboards.ts` (incl. `GET /api/whiteboards/pages`), `src/lib/git-sync/semantic-merge.ts`
- `dashboard/src/components/appLink/DocumentReader.{tsx,css}` (shared reader, mounted by `ViewerWindow` too), `dashboard/src/lib/wikilinks.ts`, `dashboard/src/lib/agentFileKind.ts`, `dashboard/src/components/core/MarkdownPreview.tsx`, `dashboard/src/components/sleepy/chat/PdfViewer.tsx` (embedded mode)
- `dashboard/src/pages/WhiteboardsPage.tsx`, `dashboard/src/pages/whiteboards/boardHash.ts`, `dashboard/src/pages/whiteboards/BoardTabs.{tsx,css}` + `tabStripLogic.ts` (tab strip, groups, close popover), `dashboard/src/pages/whiteboards/BoardSwitcher.{tsx,css}` ("All boards" + Recently deleted), `dashboard/src/hooks/useWhiteboards.ts`, `dashboard/src/hooks/useWhiteboardPages.ts`
- `dashboard/src/components/whiteboard/**`: `PagePopup.{tsx,css}` + `pagePopupModel.ts` (panel + pan rules), `wikiCardModel.ts`, `widgets/WikiWidget.tsx` + `wikiWidget.css`, `PanelIcons.tsx`, `widgetSize.ts` (free-form resize), `widgets/{KnowledgeWidget,TaskWidget,WidgetFrame}.tsx`, `pageCard.css`
- `dashboard/src/lib/whiteboardWidgets.ts` (mirror of `WIDGET_KINDS`, drift-tested)
- Verification: `scripts/verify/whiteboard.mjs` (679 checks, both themes), `tests/unit/whiteboard-{nav,nav-cli,wiki-model,page-popup,page-title,board-hash,widget-size,widget-mirror}.test.ts`, `tests/unit/wikilinks.test.ts`, `tests/unit/agent-file-kind-html.test.ts`
- Docs: `skill/references/whiteboards.md`, `skill/references/cli-reference.md`

## Notes

**In build:** an **agent card** (task `whiteboard-a-ajan-karti-eklenir-…`, `in_progress`): an automation agent placed on a board as a widget, which knows the board, writes only to its own board, reads anywhere, and is asked about a widget by dropping that widget on it. Its criteria (AC1-AC12+) live in the task; nothing has shipped, so nothing here is ticked.

**Phase 2 scope (separate task):**
- An assistant chat panel embedded in the board.
- Recall and the knowledge index over whiteboards (today `whiteboard list` is the only way to find one).
- Widgets rendered in chat's read-only `BoardEmbed` viewer.
- Real-time multi-user editing (Phase 1 polls and merges).
- An image paste/asset pipeline.
- Tombstone garbage collection, with a GC watermark and clock-skew rules, if a real board ever gets heavy.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-10-04 — Cards stay inside their frames, and a metric stays live

- **L/XL insight chart fits** `e8a26dd4`: `LineChart` moved to layout-pixel heights while `InsightWidget` still sized it for the old viewBox contract, so a 250px card got a ~407px chart; the chart now measures its own box.
- **No floating link icon** `8f314817`: a guarded build-time patch skips Excalidraw's link-icon paint for widget links only; the build fails if the guard is not found exactly once.
- **Metrics are widgets** `45da14ba` (skill docs): the excalidraw pack excludes whiteboard targets up front and the whiteboard reference opens with "a number is an insight widget".
- **PRD reconciliation:** three Phase 1 criteria added and ticked from the commits and their tests; two decisions recorded; `related_tasks` += the agent-card task (already in the working tree), noted under Notes as in build. `status` stays `in_review`, `released_version` stays `null`.

### 2026-10-04 — Phase 1.6: boards became tabs, a close asks, and a delete comes back

- **Chrome-style board tabs** `0979ec13`: the switcher dropdown gave way to `BoardTabs` + `tabStripLogic` — tabs side by side, drag reorder, close ≠ delete, named groups in 8 chart-token colours with a collapsing chip, the arrangement per machine + vault in `localStorage` (written synchronously, since closing the open tab remounts the strip). Old `.wbs-*` selectors kept so `verify:whiteboard` still drives the header. 16/16 unit, `verify:whiteboard-tabs` 21/21 ×3, 679/679 whiteboard verify.
- **A close that asks, and a trash with a way back** `51a44d9c`: every close path opens an in-app popover saying the board stays (nothing red); "All boards" grows a folding "Recently deleted" with relative times and Restore (`<slug>-2` on a collision); `trash`/`list`/`restore` in the store under the board lock behind `GET /api/whiteboards/trash` and `POST /api/whiteboards/trash/:id/restore`, `trash` reserved as a slug, and `whiteboards/.trash/` given its own `*` `.gitignore` so a delete history never syncs to the team.
- **A pan survives an active widget** `f12cb471`: a canvas-started wheel pan latches widgets open to the wheel (dropped after 250 ms of quiet), so the gesture is not eaten by an HTML or web block's iframe.
- **PRD reconciliation:** four user stories and a Phase 1.6 criteria block ticked from the shipped code and tests; three decisions recorded (close-is-not-delete / delete-is-not-loss with the local-only trash, a gesture belongs to where it started, and the tab strip as workspace-local state with the synchronous-write bug the verify script caught); Technical Details and Key files extended; `related_tasks` += the tabs task. `status` stays `in_review` and `released_version` stays `null` — owner sign-off in the installed .app is still open.

### 2026-10-03 — Phase 1.5: the board grew a wiki side, and reading a page stopped costing you the board

- **Free-form resize** `127422a6`: a dragged box stays where it was dragged (4px step, 120×96 floor) and `dc.size` demotes to a content-layout hint, so a web widget can be phone-width; a plain click on an inactive widget activates it and hands the same click to the control under the pointer (one-click todo).
- **The default board ships** `dbf94fd8`: the Control Panel whiteboard and its folder live in the brain.
- **One shared reader** `e84e0639`: `ViewerWindow`'s type routing extracted into `DocumentReader` (reused by the window, the side panel and the wiki card), `PdfViewer` embedded mode, `.html` as its own kind in the strict sandbox, and `[[wikilinks]]` as links the reader follows in place.
- **The `wiki` widget kind** `aa9d4778`: title + ordered sections of pages in `customData.dc`, several cards per board, validated on every write path and stripped by a tombstone; `whiteboard add <slug> wiki`, `whiteboard nav list|add|remove|move --card <id>`, `show --json` → `wikis`, and `GET /api/whiteboards/pages` searching knowledge + project files.
- **Pages open beside the board** `b755ea71`: a pushing (not overlaying) right-hand panel with back/forward, Esc, ×, Expand, a title-only header and a `⋯` menu; any file is a page (knowledge slug or `.md`/`.pdf`/`.html` path) with its own type label and a readable title; the wiki card lists at S/M and reads in-card at L/XL, with in-card section/page editing, DnD and Alt+Arrow reorder written to the board file. The left wiki menu, the Canvas | Wiki mode and the board-level nav routes were removed.
- **The opener stays in view** `f30642f2`: opening pans the board by the minimum that shows the whole opening card (zoom untouched, a visible card never moves); closing restores the pre-open pan unless the user panned or zoomed while reading. Pure functions in `pagePopupModel.ts`, measured in both themes (679 checks).
- **PRD reconciliation:** four new user stories and a Phase 1.5 criteria block ticked from shipped code, tests and `verify:whiteboard`; the "wiki is a card, not a mode" owner reversal recorded as superseding the earlier mode decision; Technical Details rewritten for the shared reader, the panel, page refs and the wiki card; `related_tasks` += the wiki task. Only owner sign-off in the installed .app is open, so `status` stays `in_review` and `released_version` stays `null`.

### 2026-10-02 — Phase 1 shipped in 0.30.0: editable boards, live widgets, a switcher and Apple-style sizes

- **Shipped** `86bff520`: the editable `WhiteboardCanvas` with seven embeddable widget kinds (payload in `customData.dc`), S/M/L/XL sizes on a 180/16 grid with snap-on-release and adaptive content, the `dreamcontext whiteboard list|create|show|add|update|remove|draw` CLI with locked, per-element-merged, atomic writes and kept tombstones, the `/api/whiteboards` routes (strict body picking, 5 MB cap, image refusal, server-side payload and own-origin checks), the dashboard page with a header board switcher, a 2s rev poll reconciled through `restoreElements(remote, null)` and a one-in-flight save loop, the `whiteboard-md` git merge class plus nested `.gitattributes merge=binary`, and docs (skill reference, CLI reference, a daily-board automation recipe).
- **Polish** `8b00f332`: one chart per large insight widget instead of a sparkline plus a second chart; titles on knowledge/task ref cards; no inner frame on HTML blocks (a srcdoc reset, with the D6 sandbox — `allow-scripts`, `SANDBOX_CSP`, `HEIGHT_BRIDGE` only, no `REACH_BRIDGE` — unchanged). `verify:whiteboard` gained A19 checks.
- **Rail naming:** the Packs/Settings group became "System"; the Workspace entry is "Whiteboard" opening the default board "Control Panel".
- **PRD reconciliation:** all four user stories and the Phase 1 criteria ticked (the task's 19 substantive criteria are ticked with evidence; only owner sign-off in the installed .app is open). `updated` → 2026-10-02, `status` `in_progress` → `in_review` (every criterion but owner sign-off is met; Phase 2 scope in Notes is untouched), `released_version` left `null` — 0.30.0 has not reached the registry.

### 2026-09-29 - Created
- Feature PRD created.
