---
id: feat_uihUmOmu
status: in_review
created: '2026-06-14'
updated: '2026-08-01'
released_version: v0.23.0
tags:
  - 'topic:desktop'
  - frontend
  - backend
  - 'topic:federation'
related_tasks:
  - federation-read-only
type: feature
name: launcher-federation-graph
description: ''
pinned: false
date: '2026-06-14'
---

## Why

The desktop Launcher listed registered vaults as flat cards with no way to see or
manage cross-project federation relationships. Users had to open each project's
Settings page to configure which projects share their corpus, and the upgrade-vs-update
distinction (upgrading the global CLI does not refresh a project's installed
skills/agents/hooks) was invisible — a stale project silently gave agents outdated
tooling. This feature gives the Launcher two new surfaces: a per-project STATUS
indicator (green/yellow/red) that surfaces the upgrade-vs-update gap and lets the
user trigger an in-project update from the Launcher; and an interactive force-directed
graph where users drag to connect projects, creating directed "A reads B" read-only
federation edges without opening any settings page. Brain graph settings now also
survive desktop relaunches (server-side persistence for the new-origin-per-launch
localStorage gotcha).

**The Space (v0.23.0, 2026-08-01).** The force-directed graph AND the flat card list
were replaced by the Space — a unified orbital view where RADIUS is recency (last-opened
projects on inner rings, never-opened at the edge) and ANGLE is kinship (federated
projects share a contiguous arc inside a gas cloud). Chips are real buttons, the sky
rotates/zooms/drifts (pausing on hover, silent under `prefers-reduced-motion`), search
dims non-matches in place, and dragging one project onto another wires them.
Connecting a project IS the read grant — the `shareable` toggle is retired (see
Constraints & Decisions). The Space renders the card grid AND the graph in one surface;
the old Network view is gone.

**Read-only federation (updated 2026-06-15).** Following the federation read-only
pivot, the graph now shows ONLY read wires (violet). The teal sync/listen wires
(copy-based digest push) were removed from the graph and all related UI (wire-kind
toolbar, `useCreateSync`/`useRemoveSync` hooks, `SYNC_SOFT` color, `WireKind='sync'`
branch). Copy-based sync is parked on the roadmap; federation is live-reference only.

## User Stories

- [x] As a user, I can see at a glance whether each registered project is up to date
  (green), needs a `dreamcontext update` (yellow), or has a deleted folder (red), so I
  know which projects have stale agent tooling.
- [x] As a user, I can click a yellow-status project in the Launcher to run
  `dreamcontext update` in that project without opening a terminal, so stale projects
  self-heal from the UI.
- [x] As a user, I can remove a red-status (deleted-folder) project from the registry
  directly from the Launcher, so stale entries don't accumulate.
- [x] As a user, I can see an interactive graph of all my projects and the "reads"
  edges between them (who reads whom for cross-project recall — live reference, nothing
  copied), so federation relationships are visible at a glance.
- [x] As a user, I can drag from one project node to another in the graph to create a
  "reads" edge (A reads B), so I can set up cross-project live recall without opening
  any settings page.
- [x] As a user, I can see which "reads" edges are active (all connections live as of
  v0.23.0 — shareable retired) with particles flowing along wires, so federation
  relationships are visible at a glance.
- [x] As a user, the graph shows only read wires (violet) with no sync/teal wires,
  so the graph honestly represents read-only federation and is not misleading about
  copy-based sync that is not yet available.
- [x] As a user, drawing a connection to a project IS the consent (v0.23.0 — shareable
  retired), so wiring directly grants read access without a second opt-in.
- [x] As a user, my Brain graph display settings (node size, text-fade threshold,
  force parameters) survive desktop relaunches, so I don't re-configure the graph
  every time the app starts.
- [x] As a user, the Federation Settings panel uses plain-language explainers and
  self-describing direction labels (⮜ Read from / ⮞ Share to / ⇄ Two-way) so
  I understand what each direction means without a help article.
- [x] As a user, I can interact with the federation board without mode-switching — drag
  to wire, click card to inspect, click wire to edit — so the graph is direct-manipulation
  without cognitive overhead (2026-07-05 modeless redesign).

## Acceptance Criteria

- [x] `GET /api/launcher/status` returns per-vault: `exists`, `setupVersion`,
  `latestVersion`, `needsUpdate` (true iff folder exists AND `setupVersion` <
  `latestVersion`), `shareable`. Color mapping: green = exists + !needsUpdate, yellow =
  exists + needsUpdate, red = !exists.
- [x] `POST /api/launcher/update` spawns `dreamcontext update` in the project cwd
  using the `defaultCliRunner` no-shell pattern (same as scaffold), returns updated
  `VaultStatus`.
- [x] `POST /api/launcher/unregister` removes a vault from the registry (folder-agnostic;
  does NOT delete files); idempotent; returns updated vault list.
- [x] `GET /api/launcher/federation-graph` aggregates `listVaults()` + each vault's
  `listConnections()` into `{ nodes: VaultStatus[], edges: FederationEdge[] }`. An edge
  `{ source, target, active }` is emitted iff `source`'s connection to `target` has
  direction `out` or `both` AND the connection is not stale AND both vaults are
  registered.
- [x] `POST /api/launcher/connection` creates a directed `out` connection from vault
  `from` to vault `to` (stored in `from`'s `_dream_context`). `POST
  /api/launcher/connection/remove` removes it. Both are strict-pick, CSRF-guarded.
- [x] `POST /api/launcher/shareable` toggles a vault's `shareable` flag in its
  `.config.json`. STRICT-PICK; CSRF-guarded; private-by-default preserved.
- [x] `LauncherGraph.tsx` renders a `react-force-graph-2d` canvas with one node per
  vault (colored by status) and directed read edges per federation-graph response.
  Active read edges (target shareable) animate `linkDirectionalParticles` in the violet
  accent color; inactive edges are dimmed. `WireKind` is narrowed to `'reads'` only;
  sync/teal wires, `useCreateSync`/`useRemoveSync` hooks, and the wire-kind toolbar
  are removed. `GraphGuide` rewrites the explainer to read-only framing.
- [x] Drag-to-connect: in Connect mode, dragging from node A onto node B calls `POST
  /api/launcher/connection { from: A.name, to: B.name }`, then invalidates the
  federation-graph query. Two one-way `out` edges between A and B produce two
  directed arrows rendered as a two-way link. (Sync create/remove endpoints removed
  from the active surface; `useCreateSync`/`useRemoveSync` deleted.)
- [x] `GET /api/brain-settings` / `PUT /api/brain-settings` (vault-scoped, new route
  `src/server/routes/ui-settings.ts`) persists an opaque JSON blob at
  `_dream_context/state/.brain-settings.json`. Client hydrates from server on mount
  (write-through; localStorage stays a flash-free mirror). 256 KB size cap; corrupt
  file returns `{}`.
- [x] Federation Settings panel (`ConnectionsManager.tsx`) rewritten with a
  plain-language explainer block, a Sharing card, and direction controls labeled ⮜
  Read from / ⮞ Share to / ⇄ Two-way with per-option hints.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-08-02]** The Space is night in BOTH themes, and says so with one class. In
  light mode every `var(--color-*)` inside the canvas resolved to the app's dark-on-light
  palette and painted itself on a black sky — project labels measured **1.3:1**, the HUD
  hint 2.15:1, i.e. invisible. Rejected: a light "day sky" (stars, gas clouds and the core
  halo are all designed for black — that is a redesign, not a fix) and the per-rule fixed
  colours the FederationBoard uses (24 sites here, and every future rule re-litigates it —
  which is how this bug arrived in the first place). Instead `tokens.css` gained
  `.surface-night`, a second selector on the dark-theme block that republishes the SAME
  palette on one element; `.space` wears it, and the whole subtree keeps using ordinary
  tokens. A republished token cannot reach text that never asks for one, so `.space` also
  states `color: var(--color-text)` explicitly — without it the wire cockpit's head kept
  inheriting light ink from `.launcher`. After: worst on-canvas text 7.66:1, chip labels
  16.61:1. `e2e/verify-space.mjs` grew a light-mode pass that composites each label over
  its real backdrop down to the sky and fails under AA (negative control: strip the class →
  1.3:1, check fails). 28/28.
- **[2026-08-01]** The `shareable` read gate is retired (commit `6bf9871`). Drawing a
  connection IS the consent, end to end. A vault could be wired and still return nothing
  (when `shareable: false`), which read as "federation is broken" far more often than
  "privacy" — these are one person's own projects on one machine. The toggle is gone from
  the CLI, the config route, Settings, and the launcher. `.config.json` still round-trips
  the old key for compatibility, but nothing branches on it. All wires are now active by
  construction. The `/api/launcher/shareable` route still exists (no-op gate — round-trips
  the value without enforcing it); the `shareable` field in `VaultStatus` is kept for
  backward compatibility but is not rendered or consulted. User stories + ACs still
  mentioning "shareable" reflect the historical surface, not current behavior.
- **[2026-08-01]** The Space replaces the force-directed graph AND the card grid
  (commit `6bf9871`). Geometry carries meaning: RADIUS = recency (last-opened on inner
  ring, never-opened at edge, from `lastOpenedAt` registry field stamped on every open
  via `POST /api/launcher/touch`), ANGLE = kinship (federated projects in a contiguous
  arc + gas cloud). The sky is unit-tested (`spaceLayout.ts`) — pure, never a simulation.
  Interaction: chips are real buttons (tab/arrow), search dims non-matches in place, rings
  absorb new projects without crowding, the sky rotates/zooms/drifts (pausing on hover,
  silent under `prefers-reduced-motion`), clicking a chip expands its card ON THE SPOT
  (nudged on-canvas as far as edges demand). Drag one project onto another to wire. Wires
  get a 40px invisible hit band; the sky ripples when a wire is drawn/cut so changes never
  land silently. Two placement bugs fixed: SVG collapsed to zero width by `reset.css`
  `max-width: 100%` (sky painted off-canvas), and `translate(-50%, -50%)` shoved instead
  of centering (default `transform-origin` is element center — chips sat off-ring by half
  their width). `e2e/verify-space.mjs` — 26/26 checks, geometry through wiring.
- **[2026-07-05]** Modeless direct-manipulation redesign. The old Connect/View toggle is removed. All interactions are now direct: drag-to-wire (animated preview), click-card-to-inspect (detail panel with Connect arming), click-wire-to-edit (in-place popover with per-direction Remove + Make-Readable action). Card press is claimed at capture phase so d3-zoom pan only triggers on empty-canvas press. Auto-fit viewport runs only on first layout, not after mutations, to keep the viewport stable. Success/warn feedback banners with inline fix actions replace silent operations. ~50 i18n keys added (`federation.map.*`). Two bugs fixed: (1) launcher window missing I18nProvider; (2) d3-zoom pans on mousedown not pointerdown — custom drag must cancel compat mouse event. Layout tuned for sparse graphs: softened charge repulsion, added center pull + collision radius, auto-fit zoom floor 0.9. FederationBoard.tsx rewritten (1211 lines), made reusable (`variant="full"|"embedded"`).
- **[2026-06-15]** Sync/teal wires removed from the graph (read-only federation pivot). The prior `WireKind = 'reads' | 'sync'` branch, `SYNC`/`SYNC_SOFT` colors, `wireKind` state, and `useCreateSync`/`useRemoveSync` hooks are deleted. The graph now renders only violet read wires. Copy-based sync is parked on the roadmap; if it returns, `WireKind` gains a new member and the graph rendering is restored then. Dead sync CSS (harmless) deferred to a separate cleanup.
- **[2026-06-14]** Brain settings persist at `_dream_context/state/.brain-settings.json`
  (not `~/.dreamcontext/`): vault-scoped so different projects can have different graph
  configurations. The server owns the file; the client blob is opaque (the server
  validates only that it is a JSON object under the size cap, never inspects fields).
- **[2026-06-14]** `POST /api/launcher/connection` always stores an `out` edge on the
  FROM vault (not a `both` edge). Two-way federation requires two separate drags (A→B
  then B→A), which stores two independent `out` edges. The graph frontend detects the
  reciprocal pair and renders a two-way visual, but the underlying storage is always
  per-direction unidirectional.
- **[2026-06-14]** Active-edge definition: a "reads" edge is ACTIVE (particles flow)
  iff the target vault has `shareable: true` in its `.config.json`. An edge can exist
  (connection stored) even when the target is not shareable; the launcher renders it
  dimmed to signal the link is inert. This keeps private-by-default intact: a project
  is never read without an explicit opt-in.
- **[2026-06-14]** The federation graph lives in the Launcher (not in a per-project
  Settings page) because it is a cross-project concern. Per-project Settings still
  carries the text-form ConnectionsManager for users who prefer a list over a graph.
- **[2026-06-14]** `computeVaultStatus` reads `setupVersion` from `.config.json`
  (`readSetupConfig`). A project that has never run `setup` shows `setupVersion:
  '0.0.0'` and therefore always `needsUpdate: true`. This is intentional — an
  un-setup project benefits from running `update`.

## Technical Details

New server routes (`src/server/routes/launcher.ts`, registered on the shared Node server):
- `GET /api/launcher/status` → `handleLauncherStatus`
- `POST /api/launcher/update` → `handleLauncherUpdate` (spawns `['update']` via `defaultCliRunner`)
- `POST /api/launcher/unregister` → `handleLauncherUnregister`
- `GET /api/launcher/federation-graph` → `handleLauncherFederationGraph`
- `POST /api/launcher/connection` → `handleLauncherConnectionCreate` (stores `out` via `addConnection`)
- `POST /api/launcher/connection/remove` → `handleLauncherConnectionRemove`
- `POST /api/launcher/shareable` → `handleLauncherShareable` (calls `updateSetupConfig`)

New route file (`src/server/routes/ui-settings.ts`):
- `GET /api/brain-settings` → `handleBrainSettingsGet`
- `PUT /api/brain-settings` → `handleBrainSettingsPut`

Frontend files:
- `dashboard/src/pages/LauncherGraph.tsx` — force-directed canvas; drag-to-connect;
  `react-force-graph-2d` (`ForceGraph2D`); color palette uses canvas-safe hex constants
  (CSS vars unavailable on canvas). Node status color: green `#34d399`, yellow
  `#fbbf24`, red `#f87171`. Active-edge particle color: violet `#8b5cf6`.
- `dashboard/src/pages/LauncherGraph.css` — graph panel + sidebar layout.
- `dashboard/src/hooks/useLauncher.ts` — `useFederationGraph`, `useCreateConnection`,
  `useRemoveLauncherConnection`, `useToggleShareable`, `useUpdateProject`.
- `dashboard/src/components/settings/ConnectionsManager.tsx` — federation settings
  panel with plain-language explainer, Sharing card, and direction labels
  (⮜ Read from / ⮞ Share to / ⇄ Two-way) + per-option hints; new `federation.*`
  i18n keys.
- `dashboard/src/hooks/useGraphSettings.ts` — hydrates from `GET /api/brain-settings`
  on mount, writes through to `PUT /api/brain-settings`; localStorage stays a mirror
  for flash-free initial render.

Key library dependency: `react-force-graph-2d` (wraps `three.js`-free 2D canvas graph).

`VaultStatus` interface (exported from `launcher.ts`):```ts
{ name, path, exists, setupVersion, latestVersion, needsUpdate, shareable }```
`FederationEdge` interface:```ts
{ source, target, active }  // active = target.shareable```Federation read model: per `src/lib/federation-recall.ts`, vault A reads vault B iff
A's connection to B has `direction: 'out' | 'both'` AND B's `shareable` is `true`. The
launcher graph surfaces BOTH parts: the edge (connection) and the shareable gate.

**Read-only pivot changes (2026-06-15, commit e464190):**
- `LauncherGraph.tsx`: `WireKind` narrowed to `'reads'`; `SYNC`/`SYNC_SOFT` removed;
  `useCreateSync`/`useRemoveSync` imports deleted; `wireKind` state + `wireKindRef`
  removed; arc rendering simplified (one color path, one label path); `GraphGuide`
  rewrites copy to read-only framing; SVG demo reduced to single read wire.
- `dashboard/src/hooks/useLauncher.ts`: `useCreateSync`/`useRemoveSync` deleted.
- `LauncherGraph.css`: sync-keyed CSS classes left in (harmless dead code; deferred cleanup).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-05 - Modeless direct-manipulation redesign (sleep-product consolidation, in-flight)
- FederationBoard rewritten as a modeless direct-manipulation surface: drag=wire, click card=inspect, click wire=edit (in-place popover with Remove + Make-Readable), no Connect/View toggle.
- Success/warn feedback banners with inline actions ("Turn on Readable") replace silent operations.
- Layout tuned for sparse graphs: softened charge, center pull, collision radius, auto-fit floor 0.9.
- Two bugs fixed: (1) launcher window missing I18nProvider wrapper; (2) d3-zoom mousedown pan must be cancelled when card press is claimed.
- ~50 i18n keys added (`federation.map.*`): guide, hints, legend, wire/card interactions, feedback notes.
- FederationBoard made reusable (`variant="full"|"embedded"`).
- Added user story: modeless interaction (no cognitive overhead).
- Updated Technical Details and Constraints with modeless redesign changes.

### 2026-06-15 - Read-only federation pivot (sleep-product consolidation, v0.7.0)
- Sync/teal wires removed from the graph per federation read-only pivot (task: federation-read-only).
- Added user story: graph shows only read wires; added constraint documenting the removal.
- Updated Technical Details with read-only pivot changes. Added federation-read-only to related_tasks.

### 2026-06-14 - Feature PRD created (sleep-product consolidation, v0.8.3)
- All user stories and acceptance criteria verified from code (a41dc7b).
- Captures launcher status, federation graph, drag-to-connect, brain settings
  server persistence, and ConnectionsManager redesign.
