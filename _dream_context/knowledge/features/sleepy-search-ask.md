---
id: feat_t9fQ1w-A
status: in_review
created: '2026-06-27'
updated: '2026-06-29'
released_version: null
tags:
  - frontend
  - backend
  - 'topic:recall'
  - 'topic:dashboard'
  - 'topic:desktop'
related_tasks:
  - >-
    feat-desktop-in-app-conversational-agent-surface-bm25-search-claude-chat-embedded-terminal
  - sleepy-intelligent-search-toggle-real-claude-code-ask-chat
type: feature
name: sleepy-search-ask
description: ''
pinned: false
date: '2026-06-27'
---

## Why

Developers using dreamcontext need a fast, in-app way to query their project brain without opening a terminal, switching apps, or spending LLM tokens. The Sleepy Search/Ask view brings the BM25 recall engine — already proven in the CLI — directly into the dashboard as the primary workspace surface. It lets users search their entire brain (knowledge, features, tasks, memory, changelog) in milliseconds, open any result in its native rendered form, and get a grounded extractive answer synthesized from the top recall hits, all with zero token cost. It also establishes the visual identity of "Sleepy" as dreamcontext's in-app assistant persona and sets the stage for a future Claude chat mode and embedded terminal.

## User Stories

- [x] As a user, I can type a query into the Sleepy Search view and see ranked brain hits instantly (debounced BM25, all types), so that I find context without leaving the app or paying for an LLM call.
- [x] As a user, I can filter hits by type (Knowledge, Features, Tasks, Core, Memory) so that I narrow results when I know roughly where the answer lives.
- [x] As a user, I can open a hit into a side panel and see the full document rendered with the same components as the dedicated pages (Markdown, Excalidraw canvas, SQL ER view), so that search results are as readable as the original page.
- [x] As a user, I can switch to Ask mode, ask a question, and get a grounded extractive answer synthesized from the top recall hits with inline citations, without any LLM call or token cost.
- [x] As a user, I see the context-constellation idle animation (dot particles orbiting the Sleepy logo) when no query is active, giving the surface a distinctive rest state.
- [x] As a user, the Sleepy view is the first item in the Workspace navigation and the default landing page, so it is always one click away.
- [x] As a user, I can ask a follow-up question in a multi-turn chat and get Claude's answer grounded in my project context, so that I get explanations and reasoning, not just search hits. (Phase 3 — shipped)
- [x] As a power user, I can open an embedded Agent terminal in the app and run an interactive Claude Code session against this vault, with session persistence across page navigation and a bypass-permissions opt-in toggle. (Phase 4, beta — shipped)
- [x] As a user, closing or restarting a live Claude session shows a native confirmation sheet so I never accidentally kill a running task without a chance to cancel. (Phase 4 UX — shipped)
- [x] As a user, each split pane has a persistent header (label, status dot, restart, close) so I always know which pane I am acting on. (Phase 4 UX — shipped)
- [x] As a user, I can double-click a tab to rename it so I can label agent sessions meaningfully. (Phase 4 UX — shipped)
- [x] As a user, an ended session shows a prominent Reconnect card overlaid on the dead pane so I never hunt for a tiny icon. (Phase 4 UX — shipped)

## Acceptance Criteria

### Shipped — Search (BM25, no LLM)
- [x] `GET /api/recall?q=&types=&top=` endpoint wraps `bm25Search`/`buildCorpus` from `src/lib/recall.ts`; registered in `src/server/index.ts`; returns ranked hits with `type`, `slug`, `title`, `path`, `description`, `tags`, `snippet`, `body`, `score`, `rankScore`.
- [x] 8-second in-memory corpus cache keyed by `contextRoot::sortedTypes` prevents redundant disk scans on debounced keystrokes.
- [x] `useRecall(query, types, topK)` React hook (debounced) and `recallOnce(query, types, topK)` one-shot async helper in `dashboard/src/hooks/useRecall.ts`.
- [x] Query box in SleepyPage drives `useRecall`; results render as a flat or type-grouped hit list with query-term highlighting.
- [x] Type-filter buttons (Knowledge, Features, Tasks, Core, Memory) filter both the `types` param sent to `/api/recall` and re-map `changelog` + `memory` to their display labels.
- [x] Clicking a hit opens a side panel with `DocContent` rendering the full document.

### Shipped — DocContent type-aware rendering
- [x] `DocContent` (`dashboard/src/components/sleepy/DocContent.tsx`) detects the hit's type and fetches the canonical full record: `GET /api/knowledge/<slug>` (content field), `GET /api/features/<slug>` (feature.content), `GET /api/tasks/<slug>` (task.body). Memory and changelog render from the recall hit's `body` field directly (no detail endpoint).
- [x] Excalidraw knowledge hits render via `ExcalidrawPreview` (detected by `isExcalidrawSlug()`).
- [x] `data-structures/` knowledge hits extract SQL fences and render via `SqlPreview`; all other knowledge and everything else renders via `MarkdownPreview`.
- [x] While the detail fetch is in-flight, a loading indicator is shown; on error, falls back to the recall hit's `body` (graceful degradation).

### Shipped — Grounded Extractive Ask (no LLM)
- [x] Ask mode: user enters a question; `recallOnce` fires once (top 4 hits); `composeAnswer()` synthesizes a short answer from snippet/description of the top 3 sources with inline `[1]` `[2]` `[3]` citation markers.
- [x] Citation markers are interactive — clicking `[N]` opens the cited source in the DocContent side panel.
- [x] Answer is purely extractive: text is assembled from stored brain fields, zero LLM tokens spent.
- [x] If no hits are found, a friendly "I searched across your whole brain but didn't find anything on that yet." message is shown.

### Shipped — UX / branding
- [x] Sleepy view is first in the Workspace nav section and is the default landing page (`/sleepy` route).
- [x] Context-constellation idle animation shown when query is empty (animated dot particles orbiting the Sleepy brand mark).
- [x] Query-term highlighting: matched tokens are highlighted in violet (`#bcacff` with soft background) in hit titles and snippets.

### Shipped — Phase 3: Real Claude Code Chat + Intelligent Search Toggle
- [x] Glowing default-OFF "Intelligent" toggle on Search: switches BM25 recall → Haiku re-ranking on submit; off by default (BM25 always fast and free).
- [x] NavIcons stroke family replaces unicode type glyphs throughout the Sleepy view; new Memory icon added.
- [x] `POST /api/sleepy/chat` spawns headless `claude` (stream-json output) in the vault project directory; session ID captured from `init` event.
- [x] `GET /api/sleepy/chat/stream` is SSE: events `meta`, `thinking`, `text`, `tool`, `done`, `error`; rendered live in the chat UI (thinking trace, read-only tool chips, Markdown answer).
- [x] `GET /api/sleepy/chat` returns conversation history; `POST /api/sleepy/chat/reset` clears it.
- [x] Session continuity: subsequent messages pass `--resume <session_id>` so Claude recalls prior turns.
- [x] Model selection hidden from user: Normal = Sonnet, Intelligent = Opus; no model name exposed in UI.
- [x] Read-only enforcement via three layers: `--permission-mode plan` (gates Bash/Edit/Write/MCP writes), `--disallowedTools` (Task/Skill/Agent/etc., prevents SessionStart consolidation hijack), `--append-system-prompt` guard.
- [x] Transcript persisted per-vault at `_dream_context/state/.sleepy-chat.json` (gitignored); cleared on reset.
- [x] History hydrated on page load; reset button clears both server state and UI.

### Shipped — Phase 4: Embedded Agent Terminal (beta, 2026-06-28)
- [x] PTY backend: `node-pty` spawned server-side, bridged to webview over loopback WebSocket (`/api/agent/terminal?vault=&bypass=`); gated on `DREAMCONTEXT_DESKTOP=1` and strict loopback remote-address checks.
- [x] `xterm.js` terminal panel running an interactive `claude` session scoped to the active vault; `@xterm/addon-webgl` GPU renderer with automatic canvas-renderer fallback on WebGL context-loss.
- [x] Session persistence: `AgentTerminal` hoisted above `App.tsx` page switch and rendered with `display:none` when inactive; WebSocket + PTY stay open across page navigation, torn down only on explicit Close/Restart.
- [x] BETA badge on the "Agent" tab, consistent with Council's LAB badge / Settings' BETA badge styling.
- [x] `bypassPermissions` toggle (default OFF) with a standing warning chip when armed; read-only Chat mode (Phase 3) unaffected.
- [x] Drag-to-split: dragging one agent tab onto another creates a side-by-side split terminal layout; `⌘D` also splits.
- [x] Desktop-only feature gated by `GET /api/agent/capabilities` — returns `{available: false}` in non-desktop builds so the terminal surface degrades gracefully.
- [x] Sometype Mono font loaded and committed before `term.open()` so WebGL glyph atlas builds with correct cell metrics (fixes thin/stretched text rendering).
- [x] Agent tab selection persists across Sleepy tab navigation (Search/Ask/Agent); switching pages and returning restores the last active Sleepy tab.

### Shipped — Phase 4 UX Rebuild: Agent Section polish (2026-06-29, `AgentSurface.tsx`)
- [x] **First-click close reliability**: close/restart controls on tabs and panes call `stopPropagation` + `preventDefault` on `mousedown` so drag on a `draggable` tab does not eat the click. Hit targets enlarged (tab ✕ 16→20px, pane buttons 18→24px). Active tab's ✕ always visible (no hover-hunt).
- [x] **Middle-click close**: middle-click on a tab closes it (native terminal muscle-memory).
- [x] **Confirmation sheet before killing a live session**: closing or restarting a tab/pane where Claude is still running (`status === 'open'`) surfaces a native-style `ConfirmRequest` dialog ("End this session?"; Enter confirms, Esc/backdrop-click cancels). Already-ended sessions tear down instantly with no nag. Multi-pane tabs state the number of live sessions at stake.
- [x] **`⌘W` guarded close**: keyboard close routes through the same confirm path.
- [x] **Persistent split-pane headers**: each split pane has a sticky header (label · status dot · restart · close) so the focused pane is always identifiable. Focused pane brightens via a CSS `data-focused` attribute.
- [x] **Status dots**: green = live/open, amber (pulsing) = connecting, red = ended — visible at all times in both tab strip and pane headers.
- [x] **Double-click tab to rename**: inline `<input>` with glow ring; Enter or blur commits, Esc cancels without saving.
- [x] **Active-tab auto-scroll**: the active tab auto-scrolls into view in the tab strip when switched.
- [x] **Reconnect overlay on ended panes**: a centered card ("Session ended → ↻ Reconnect / Close pane") replaces the dead terminal area, discoverable without hunting for a small hover icon.
- [x] **Accessibility**: `role="alertdialog"`, `aria-modal`, `aria-label` on the confirm dialog; `aria-pressed` on tab close; `prefers-reduced-motion` guard disables all pulse/animation keyframes for the tab strip and pane headers.
- [x] **Tab strip native polish**: active tab lifted with accent top-edge + violet wash; `border-radius` + `overflow: clip` so items never bleed.

## Constraints & Decisions

- **[2026-06-29]** **Agent terminal UX — confirmation-sheet scope rule.** The confirm sheet fires ONLY when the session `status === 'open'` (Claude still running). Already-ended sessions (`status === 'closed'`) tear down instantly. This prevents nag fatigue when the user is cleaning up a finished terminal. For multi-pane tabs, the tab-close confirm counts live sessions (`liveCount()`) and surfaces the number. `⌘W` is routed through the same `askClosePane` / `askCloseTab` guarded path so keyboard shortcuts are equally safe.
- **[2026-06-29]** **Close-button drag-eat fix (root cause).** The tab strip renders its items with `draggable="true"` for drag-to-reorder. A `mousedown` on a child button (the ✕) starts the drag event sequence and consumes the pointer — the click never fires. Fix: `stopPropagation + preventDefault` on `mousedown` in the close button handler. This applies to EVERY control inside a draggable container; the pattern is reusable. Also enlarging hit targets (16→20px tab ✕, 18→24px pane buttons) so accidental near-miss clicks are rarer.
- **[2026-06-28]** **Session persistence via display:none hoist above App.tsx page switch.** `App.tsx` uses `switch (nav.page)` returning one mounted page at a time; navigating away unmounts `SleepyPage` → unmounts `AgentTerminal` → kills the WebSocket and PTY. Fix: `AgentTerminal` is instantiated ABOVE the page switch as a single persistent owner, toggled via `display:none` (not unmounted) when Sleepy is not the active page. The xterm DOM node is shown/re-fit on reveal; the WebSocket and PTY stay alive the whole time.
- **[2026-06-28]** **WebGL renderer (`@xterm/addon-webgl`) with canvas fallback.** GPU-composited text (crisp at any DPR, comparable to Zed). Automatic fallback to the default canvas renderer on WebGL context-loss. Sometype Mono must be pre-loaded before `term.open()` so the WebGL glyph atlas builds with correct cell-width metrics — loading after open produces thin/stretched characters because the atlas is already committed.
- **[2026-06-28]** **`bypassPermissions` default OFF.** The terminal runs real `claude` with full write access (same as a terminal session). The bypass flag is opt-in with a persistent warning chip when armed. Phase 3 read-only Chat (`--permission-mode plan`) is always available and unaffected by this toggle.
- **[2026-06-28]** **Desktop-only, loopback-only.** `/api/agent/terminal`, `/api/agent/capabilities`, `/api/agent/open-terminal` all gate on `DREAMCONTEXT_DESKTOP=1` and reject non-loopback remotes. `node-pty` is declared as an `optionalDependency` + external in tsup; the npm CLI package degrades gracefully (capabilities endpoint returns `{available: false}`).
- **[2026-06-28]** **Three-layer read-only enforcement for the chat backend.** `--permission-mode plan` gates all write tools at the Claude Code level. `--disallowedTools` removes Task/Skill/Agent/Workflow/TaskCreate so the project's SessionStart "consolidate now" directive cannot hijack a Q&A. `--append-system-prompt` adds an explicit read-only guard. The combination is intentionally redundant — any single layer could fail (e.g. custom tools circumventing permission mode) but three together are robust.
- **[2026-06-28]** **SSE (stream-json) via `GET /api/sleepy/chat/stream`, not polling.** The `claude` process emits JSON lines; the server SSE route pipes them as typed events (`meta`, `thinking`, `text`, `tool`, `done`, `error`). Long-poll or the captureRuns polling pattern (used in the notch) would add perceptible latency on each token — SSE gives sub-100ms token delivery. Trade-off: persistent HTTP connection per active chat turn.
- **[2026-06-28]** **Session continuity via `--resume <session_id>`.** The `init` event from `claude --stream-json` carries a session ID; subsequent turns pass `--resume <id>`. This is the same continuity mechanism Claude Code itself uses — no custom state serialization required.
- **[2026-06-28]** **Intelligent toggle switches BM25 → Haiku recall, not model quality.** The Intelligent toggle in Search fires a Haiku re-ranking pass over the BM25 hits, not a more expensive model. This is intentionally distinct from the chat's Normal/Intelligent model toggle (Sonnet/Opus). Keep these semantically separate: Search Intelligent = better ranking; Chat Intelligent = deeper reasoning.
- **[2026-06-27]** **Extractive Ask is NOT a Claude chat.** The shipped Ask mode (`composeAnswer()`) assembles its answer from stored `snippet`/`description` fields of the top recall hits — no LLM call, no token cost, no latency. It is intentionally named "Ask" to signal the intended future direction (Phase 3 Claude chat) while shipping immediate value. Do not conflate the two in copy or technical decisions.
- **[2026-06-27]** **DocContent fetches full records, not recall bodies, for knowledge/feature/task types.** Recall stores only extracted text (boards lose scene JSON, bodies may be truncated). DocContent must fetch the canonical API endpoint to get renderable content (scene JSON for Excalidraw, full markdown, full task body). Memory and changelog have no detail endpoint; they render from the recall body, which is complete for those types.
- **[2026-06-27]** **Corpus cache is server-side, per `contextRoot::types` key, 8s TTL.** This prevents debounced keystrokes from hammering disk on every keystroke. 8s is short enough that edits show up promptly; long enough to absorb a burst of searches. The cache lives in the process; no persistence.
- **[2026-06-27]** **Desktop-first, but /api/recall is shared infrastructure.** The Sleepy Search/Ask view is built for and ships in the desktop app. However, `/api/recall` is designed to be consumed by both the local desktop search and any future hosted "Ask" surface (the multi-tenant read-only view in `feat-web-hosted-*`).
- **[2026-06-27]** **Sleepy is the assistant persona name, not a product rename.** "dreamcontext" remains the product name. "Sleepy" names the in-app assistant/mascot persona and the search surface. Copy should read "dreamcontext's Sleepy" or just "Search" — not a standalone brand.

## Technical Details

**Route:** `src/server/routes/recall.ts` — `handleRecallGet`, registered at `GET /api/recall` in `src/server/index.ts`. Imports `buildCorpus` and `bm25Search` directly from `src/lib/recall.ts`. Module-level `corpusCache` Map (key: `contextRoot::types`, value: `{corpus, builtAt}`, TTL 8s).

**Hook:** `dashboard/src/hooks/useRecall.ts` — `useRecall(query, types, topK=12)` uses `@tanstack/react-query` with `staleTime: 5_000`; `recallOnce(query, types, topK=4)` is a plain `fetch` for one-shot Ask usage.

**Page:** `dashboard/src/pages/SleepyPage.tsx` + `SleepyPage.css`. Uses `BrandMark` (the violet folded-diamond logo) for the constellation idle. Type labels: `Knowledge` (`knowledge`), `Features` (`feature`), `Tasks` (`task`), `Core` (`changelog`), `Memory` (`memory`). `composeAnswer()` builds an extractive answer string from `snippet || description || title` of top-3 hits. `renderAnswer()` splits on `[N]` citation markers and renders them as clickable spans that open `DocContent`.

**DocContent:** `dashboard/src/components/sleepy/DocContent.tsx`. The `detailPlan()` helper maps hit type to a fetch URL + a JSON path extractor (`pick()`). Query: `['docdetail', hit.type, hit.path, hit.slug]`; `staleTime: 30_000`. Falls back to `hit.body` on error. Renderer choice: `isExcalidrawSlug()` → `ExcalidrawPreview`; `data-structures/` slug with SQL fences → `SqlPreview`; everything else → `MarkdownPreview`. These are the SAME components used by the KnowledgePage, FeaturesPage, and TasksPage — no new renderer code.

**Brand:** `dashboard/src/components/brand/BrandMark.tsx` — the violet folded-diamond "dream gem" logo used as the Sleepy constellation center. New favicon and regenerated Tauri app icon set match this mark.

### Phase 3 — Claude Code Chat (shipped 2026-06-28)

**Backend routes (`src/server/routes/sleepy-chat.ts`):**
- `POST /api/sleepy/chat` — spawns `claude --stream-json` in the vault path. Read-only enforced via `--permission-mode plan`, `--disallowedTools` (Task/Skill/Agent/TaskCreate/Workflow/...), and `--append-system-prompt`. Model: Normal→Sonnet, Intelligent→Opus (hidden from UI). Returns `{ok}` immediately; stream delivered via SSE.
- `GET /api/sleepy/chat/stream` — SSE endpoint. Events: `meta` (session_id, model), `thinking`, `text`, `tool`, `done`, `error`. Pipes `claude` stdout JSON lines. Subsequent messages use `--resume <session_id>`.
- `GET /api/sleepy/chat` — returns conversation history from `_dream_context/state/.sleepy-chat.json` (gitignored).
- `POST /api/sleepy/chat/reset` — clears the persisted chat file.

**Frontend (`dashboard/src/pages/SleepyPage.tsx`):**
- Intelligent toggle (glowing, default-OFF): flips the Search recall mode BM25↔Haiku on submit.
- NavIcons stroke family (`TypeIcons.tsx`) replaces unicode glyphs; new Memory icon.
- Ask chat UI: message thread, SSE streaming via `useSleepyChat.ts`, thinking-trace display, read-only tool chips, Markdown rendering via `MarkdownPreview`.
- Normal/Intelligent model selector (hidden mapping: Sonnet/Opus).
- History hydrated on mount; reset clears both `.sleepy-chat.json` and UI thread.

**`dashboard/src/hooks/useSleepyChat.ts`:** manages SSE connection lifecycle, chat history state, streaming partial text accumulation.

### Phase 4 UX — AgentSurface.tsx / AgentTerminal.css

**`AgentSurface.tsx`** (new types and state added):
- `ConfirmRequest` interface: `{ title, message, confirmLabel, tone: 'danger'|'accent', onConfirm }` — the pending destructive action.
- `confirm: ConfirmRequest | null` state — when non-null, the overlay renders.
- `renamingId: string` state — tab being inline-renamed (double-click to enter, blur/Enter to commit, Esc to cancel).
- `isLive(sid)` / `liveCount(sids[])` — derived from `sessions.current.get(sid)?.status === 'open'`.
- `askClosePane(tabId, sid)` / `askCloseTab(tabId)` — guard wrappers that either close directly (ended) or raise `confirm`.
- `commitRename(id, raw)` — trims and sets the tab title.
- Close/restart buttons: `onMouseDown: stopPropagation+preventDefault` to prevent drag-eat of the click.
- `⌘W` handler routes through `askCloseTab`.
- `ConfirmDialog` rendered as a fixed overlay with `role="alertdialog"`, `aria-modal`, `aria-label`; `Escape` and backdrop-click cancel.
- `PaneFragment` receives a `label` prop; renders a persistent sticky header (label · status dot · restart button · close button). Ended pane renders a `ReconnectCard` overlay instead of the dead terminal.

**`AgentTerminal.css`** (changes):
- Active tab: accent top-edge (`border-top: 2px solid var(--color-accent)`), violet wash (`--color-accent-soft` background).
- Tab close button: always visible on active tab; 20px × 20px.
- Rename input: glow ring on focus.
- Split-pane header: sticky, `z-index` above terminal; focused pane gets `background: var(--color-surface-raised)`.
- Status dot CSS classes: `.dot-open` (green), `.dot-connecting` (amber, `@keyframes pulse`), `.dot-closed` (red).
- Reconnect overlay: centered card, auto-height.
- `@media (prefers-reduced-motion: reduce)`: pauses all `pulse`/`breath` keyframes.

## Notes

- The "Ask" name is forward-looking. The current implementation is grounded-extractive (zero LLM); Phase 3 adds real Claude chat. Keep these distinct in product communication.
- Phase 3's multi-turn continuity (`claude --resume`) is the genuinely new engineering challenge vs the notch's one-shot `-p` Ask. Reuse the `captureRuns` spawn/track/poll pattern; the chat threading is the new piece.
- Phase 4 (embedded terminal) shipped. See `knowledge/desktop-beta-tauri-multivault.md` — "In-app Agent Terminal" section for the full architecture (backend routes, `AgentTerminal.tsx`, persistence hoist, WebGL, font-metrics fix, drag-to-split).
- The `/api/recall` endpoint default `top=12` (changed from CLI's `top=5`) because the UI renders a scrollable hit list where showing more hits upfront is useful.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-29 - Phase 4 Agent UX rebuild (AgentSurface.tsx + AgentTerminal.css)
- First-click close fix: `stopPropagation`+`preventDefault` on `mousedown` in draggable tab strip; hit targets enlarged (tab ✕ 20px, pane buttons 24px); active tab ✕ always visible.
- Middle-click tab close.
- Native-style confirmation sheet before killing a live Claude session (`status=open`); `⌘W` routed through same guard.
- Persistent split-pane headers (label · status dot · restart · close); focused pane brightens.
- Status dots: green (live/pulsing amber for connecting/red ended) in tab strip and pane headers.
- Double-click tab to inline-rename (glowing input, Enter/blur commits, Esc cancels).
- Active-tab auto-scroll in tab strip.
- Reconnect overlay card on ended panes (replaces tiny hover icon).
- a11y: `role="alertdialog"`, `aria-modal`, `aria-label` on confirm; `prefers-reduced-motion` disables all pulse/animation.
- Build: tsc clean, `npm run build` exit 0; visual render verified via static harness with real stylesheets.

### 2026-06-28 - Phase 4 shipped: embedded Agent terminal (beta)
- `AgentTerminal.tsx`: xterm.js + `@xterm/addon-webgl` (GPU renderer, canvas fallback) + node-pty WS bridge (`/api/agent/terminal?vault=&bypass=`).
- Session persistence: `AgentTerminal` hoisted above `App.tsx` page switch via `display:none` — PTY and WebSocket survive page navigation.
- BETA badge on Agent tab. `bypassPermissions` opt-in toggle (default OFF) with standing warning.
- Drag-to-split tab layout (`⊟` button / `⌘D`). Sometype Mono font pre-loaded for correct WebGL glyph metrics.
- All agent routes desktop-only (`DREAMCONTEXT_DESKTOP=1` gate) + loopback-only.

### 2026-06-28 - Phase 3 shipped: real Claude Code chat + Intelligent search toggle
- Glowing Intelligent toggle (BM25→Haiku) on Search. NavIcons stroke family.
- `POST /api/sleepy/chat` + `GET /api/sleepy/chat/stream` (SSE) + history + reset routes.
- Multi-turn chat with `--resume` session continuity. Read-only via 3-layer enforcement. Model hidden (Normal=Sonnet, Intelligent=Opus).
- `useSleepyChat.ts` hook; streaming chat UI with thinking trace + tool chips + Markdown.
- Status: in_review.

### 2026-06-27 - Search + Extractive Ask + DocContent shipped
- Phase 1 (BM25 search) and extractive Ask mode shipped: SleepyPage, /api/recall endpoint, useRecall hook, DocContent type-aware rendering, context-constellation idle, violet brand mark integration.
- Status: in_progress (phases 3 and 4 remain planned).

### 2026-06-27 - Created
- Feature PRD created.
