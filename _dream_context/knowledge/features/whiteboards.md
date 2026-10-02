---
id: feat_nquc4W_e
type: feature
name: whiteboards
description: >-
  Editable Excalidraw control panels with live widgets that the user and the
  agent edit together (dashboard page + dreamcontext whiteboard CLI)
pinned: false
date: '2026-09-29'
status: in_review
created: '2026-09-29'
updated: '2026-10-02'
released_version: null
tags:
  - 'topic:dashboard'
  - 'topic:cli'
  - 'topic:excalidraw'
  - frontend
  - backend
related_tasks:
  - >-
    whiteboard-modulu-her-board-ajanin-ve-kullanicinin-birlikte-cizdigi-canli-widget-tasiyan-bir-excalidraw-kontrol-paneli-olur
---

## Why

The owner wanted one place that gathers the brain: a control panel, wiki and brainstorming wall where insights, knowledge, tasks, todos and interactive HTML sit together and an agent or automation can read and rewrite it. Before this, Excalidraw was a read-only viewer; nothing could write a board and no CLI let an agent edit one.

## User Stories

- [x] As the owner, I want a board where insights, knowledge, tasks, todos, notes and HTML blocks sit together, so the brain has one control panel I can arrange by hand.
- [x] As the owner, I want to tick a todo on the board and have the agent read it back, so I never have to tell it what I finished.
- [x] As an agent or automation, I want to clear yesterday's items and write today's in the same place with two commands, so a daily board keeps its layout.
- [x] As a teammate, I want boards to travel with brain sync and merge per element, so two people editing one board never lose each other's work.

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
- [ ] Owner sign-off in the installed .app closes the task (`verify:whiteboard` in both themes is green).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

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

**Key files**
- `src/lib/whiteboards/`: `format.ts` (parse/serialize, deterministic), `merge.ts` (`mergeElements`), `store.ts` (paths, lock, `mutateWhiteboard`, rev, git hygiene files), `widgets.ts` (`WIDGET_KINDS`, `makeWidgetElement`), `validate.ts` (slug/ref/tag/url/element/PUT body), `ops.ts` (show, update, remove, draw import), `errors.ts`
- `src/cli/commands/whiteboard.ts`, `src/server/routes/whiteboards.ts`, `src/lib/git-sync/semantic-merge.ts`
- `dashboard/src/pages/WhiteboardsPage.tsx`, `dashboard/src/hooks/useWhiteboards.ts`, `dashboard/src/components/whiteboard/**`, `dashboard/src/lib/whiteboardWidgets.ts` (mirror of `WIDGET_KINDS`, drift-tested)
- Docs: `skill/references/whiteboards.md`

## Notes

**Phase 2 scope (separate task):**
- An assistant chat panel embedded in the board.
- Recall and the knowledge index over whiteboards (today `whiteboard list` is the only way to find one).
- Widgets rendered in chat's read-only `BoardEmbed` viewer.
- Real-time multi-user editing (Phase 1 polls and merges).
- An image paste/asset pipeline.
- Tombstone garbage collection, with a GC watermark and clock-skew rules, if a real board ever gets heavy.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-10-02 — Phase 1 shipped in 0.30.0: editable boards, live widgets, a switcher and Apple-style sizes

- **Shipped** `86bff520`: the editable `WhiteboardCanvas` with seven embeddable widget kinds (payload in `customData.dc`), S/M/L/XL sizes on a 180/16 grid with snap-on-release and adaptive content, the `dreamcontext whiteboard list|create|show|add|update|remove|draw` CLI with locked, per-element-merged, atomic writes and kept tombstones, the `/api/whiteboards` routes (strict body picking, 5 MB cap, image refusal, server-side payload and own-origin checks), the dashboard page with a header board switcher, a 2s rev poll reconciled through `restoreElements(remote, null)` and a one-in-flight save loop, the `whiteboard-md` git merge class plus nested `.gitattributes merge=binary`, and docs (skill reference, CLI reference, a daily-board automation recipe).
- **Polish** `8b00f332`: one chart per large insight widget instead of a sparkline plus a second chart; titles on knowledge/task ref cards; no inner frame on HTML blocks (a srcdoc reset, with the D6 sandbox — `allow-scripts`, `SANDBOX_CSP`, `HEIGHT_BRIDGE` only, no `REACH_BRIDGE` — unchanged). `verify:whiteboard` gained A19 checks.
- **Rail naming:** the Packs/Settings group became "System"; the Workspace entry is "Whiteboard" opening the default board "Control Panel".
- **PRD reconciliation:** all four user stories and the Phase 1 criteria ticked (the task's 19 substantive criteria are ticked with evidence; only owner sign-off in the installed .app is open). `updated` → 2026-10-02, `status` `in_progress` → `in_review` (every criterion but owner sign-off is met; Phase 2 scope in Notes is untouched), `released_version` left `null` — 0.30.0 has not reached the registry.

### 2026-09-29 - Created
- Feature PRD created.
