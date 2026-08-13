# Project Tabs — validated implementation plan v1

**Goal (confirmed by the user, not up for re-litigation):** turn dreamcontext's "one OS
window per project" model into a single window with a center-aligned project chip strip —
multiple projects stay LIVE in the same window, a background project's chip jumps and shows
its active-chat count when one of its chats asks a question, and multi-window remains an
escape hatch.

**Tier:** L (cross-cutting, 59+ files, 20 tasks, 4 waves).
**Validation method (agreed in Phase 0):** BOTH (A) automated — `npx tsc --noEmit` clean at
root AND in `dashboard/`; `npm test` green; NEW unit tests for `rollupProject()` and
`lib/scopedStorage.ts`; `npm run build` produces the dashboard bundle — AND (B) a 9-item
manual checklist against a real server with an isolated scratch vault.

---

## HARD CONSTRAINTS (red lines — violating any of these fails the goal)

1. An instance with a LIVE chat is NEVER unmounted. The PTY is bound to a live WebSocket;
   unmounting kills the conversation. Hiding is `display:none` + `inert`, nothing else.
2. Chat/terminal WebSockets are NEVER tied to `isActive` and are never closed for any
   reason. The only thing that pauses is page-data `refetchInterval`; the agent surface's
   own polling continues in the background.
3. `setActiveVault`/`getActiveVault` are NOT deleted until Faz 2 is complete.
   **CORRECTED during Wave 2 (raised by T6):** `setActiveVault` can never become caller-free.
   It has two LEGITIMATE remaining callers — `pages/CaptureBar.tsx:118` and
   `components/sleepy/SleepyPerch.tsx:37` — both of which are separate, genuinely single-vault
   OS windows that hard constraint #4 puts off-limits. They pin their one vault so the
   singleton `api` carries the header, which is correct for them. So the eventual cleanup is
   scoped to **`getActiveVault` only**; `setActiveVault`, the module `activeVault` and the
   singleton `api` all survive for the capture and perch windows. Acceptance criterion A7 is
   written against `getActiveVault()` for exactly this reason and needs no change.
4. Do NOT touch the launcher side: `pages/LauncherPage.tsx`, `pages/space/SpaceLauncher.tsx`,
   `pages/CaptureBar.tsx`, `hooks/useLauncher.ts`.
5. Do NOT touch `lib/checklistStore.ts` or the checklist window. (The desktop-side emit
   TARGETING still changes; the store does not.)
6. No tab persistence. Every launch opens exactly one project: the launcher's `?vault=`.
7. Ceiling: 6 live instances. At the ceiling the oldest instance with NO live session is
   torn down into a "cold chip" (rebuilt on click). If every instance has a live session,
   the new tab is refused and the reason is stated to the user.
8. The same project can never be open twice (in this window or another) — focus the
   existing one.

---

## SECTION 1 — VERIFICATION OF THE SPEC

### The 9 open gaps — decisions

#### Gap 1 — localStorage, per key

Rule applied: **scope iff the value's MEANING changes per project.** Chrome/habit
preferences stay window-global; project navigation, project content, and anything that
alters a project's git or files gets scoped. Result: **4 keys scoped, 1 hoisted, 4 left
alone** — not 9 as the spec assumed.

| # | key | file:line | decision | reason |
|---|---|---|---|---|
| 1 | `dreamcontext.dashboard.activePage` | `components/layout/Shell.tsx:8,31,89` | **SCOPE** | Which page you were on is per-project navigation; one global key is last-writer-wins on every `navigate()` across N instances. |
| 2 | `dreamcontext.dashboard.sidebarCollapsed` | `hooks/useSidebarCollapse.ts:3,15,44` | **GLOBAL + HOIST** | A rail-width preference about the *window*; two rails of different widths in one window reads as broken — but the state must move to `WindowChrome` and pass down, or N `useSidebarCollapse()` instances silently diverge on toggle. |
| 3 | `dreamcontext.agentDock.collapsed` | `components/sleepy/AgentDock.tsx:26,29,61` | **GLOBAL, untouched** | "Do I want the dock stack expanded" is one person's chrome habit; per-instance read-at-mount/write-on-toggle divergence is invisible and harmless. |
| 4 | `agent:settings:v1` | `lib/agentSettings.ts:14,115,124` | **GLOBAL — but one field is SPLIT OUT** | The blob is genuinely app-global (`writeAgentSettings` mirrors it to `~/.dreamcontext/agent-ui.json` via the vault-agnostic `/launcher/agent-settings`, `:134`, so scoping the localStorage half desyncs it from the server half). **EXCEPT `chatPermissionMode` — see below.** |
| 4b | `agent:settings:chatPermissionMode` (NEW) | split out of `lib/agentSettings.ts:69` | **SCOPE per vault** | `chatPermissionMode: 'auto' \| 'bypass'` is not a chrome habit — its own doc comment (`:65-68`) says `'bypass'` maps to `bypassPermissions`, and `AgentSurface.tsx:425` reads it (via the ref at `:250-251`) to set `effectiveBypass` for **every** chat session that instance spawns. Today it cannot cross projects because each vault is its own JS realm. In one realm, `AGENT_SETTINGS_EVENT` on `window` means flipping bypass while looking at project A silently rewrites B's remembered default and every session B spawns afterwards — agent auto-approval enabled in a project the user never touched. That is the `checklistStore.ts` class of bug applied to a permission gate. |
| 5 | `dreamcontext.dashboard.aboutSeen` | `components/layout/Sidebar.tsx:84,109,138` | **GLOBAL, untouched** | "I have read what this app is" lives in the user's head, not the project. |
| 6 | `dreamcontext.dashboard.githubSyncSeen` | `components/layout/Sidebar.tsx:86,110,146` | **SCOPE** | Unlike `aboutSeen`, the CTA's *action* (`brain enable`) is per-vault — dismissing it in a synced project must not hide it in an unsynced one. |
| 7 | `dreamcontext.cmdk.intelligent` | `components/search/CommandPalette.tsx:29,44,176` | **GLOBAL, untouched** | A search-ranking dial — a habit, not a project fact. |
| 8 | `dreamcontext.dashboard.councilShowcaseDismissed` | `components/council/CouncilShowcase.tsx:5,10,44` | **GLOBAL, untouched** | A one-time explainer banner for what Council *is*; re-showing per project is nagging. |
| 9 | `dreamcontext.dashboard.autoCheckpointOnOpen` | `lib/brainSyncPrefs.ts:7,21,29` | **SCOPE** | This one flips real **git** behaviour against a specific repo — auto-committing a WIP-heavy personal vault because you enabled it on the team brain is the worst failure on this list. |
| 10 | `dreamcontext.chat.mediaBoxes` | `components/sleepy/chat/chatEntities.ts:2024,2035,2067` | **SCOPE — see M1** | Keyed by bare path; two vaults sharing a relative path collide. |

Verified already-correct, no change: `dreamcontext-theme` (`ThemeContext.tsx:25,33`),
`dreamcontext-zoom` (`Header.tsx:12`), `announcementsSeen` (`lib/announcements.ts:40`,
version-keyed), `SLEEPY_CONFIG_KEY`, `lib/checklistStore.ts` (vault-scoped with an
**injective hex** `labelPart`, `:44`), `hooks/usePersistedState.ts` (projectId-scoped),
`stores/savedViews.ts` (projectId-keyed snapshots, `:59`).

#### Gap 2 — `lib/attention.ts:23` `lastRaise`

**Decision: per-source throttle map, plus a separate global floor for the chime alone.**
Two projects asking 1s apart are two interruptions, not one — but a klaxon is still a
klaxon. `const lastRaiseBySource = new Map<string, number>()` keyed by `alarm.source`
(verified: `source` **is** the vault name — `agentSession.ts:451` and `chatSession.ts:589`
both pass `getActiveVault()`, notwithstanding the `AskAlarm` doc block at `attention.ts:30-31`
whose line `:30` says "a session tab title, falling back to the vault name"). A separate `lastChime` keeps `MIN_INTERVAL_MS` globally, because
`lib/chime.ts:13` is one shared `AudioContext` and one voice is correct.
Touches: `lib/attention.ts:22-23,86-101`.

#### Gap 3 — `isWatchingThisWindow()`

**Decision: inject an activity predicate; do not import React state into `attention.ts`.**
`attention.ts` gains `setChipActiveProbe(probe: ((vault: string) => boolean) | null)`.
The guard at `:92` becomes:

```ts
if (isWatchingThisWindow() && (chipActiveProbe?.(key) ?? true)) return;
```

Absent probe → `?? true` → byte-identical to today (launcher, browser build, tests).
`WindowChrome` registers a ref-reading probe once, so it never goes stale. Focused window
+ background chip asking ⇒ probe `false` ⇒ banner **and** Dock bounce fire.

#### Gap 4 — `ensureOpen()` re-drive

**What drives it today** (all three inside `AgentSurface.tsx`, all three blind to instance
visibility):
1. `useLayoutEffect([panes, expanded])` — `slot.appendChild(container); s.ensureOpen()` at
   `:1355`, then a rAF `ensureOpen()+fitAndResize()` for foreground at `:1364-1366`.
2. `useEffect([expanded, fitVisible])` — rAF `fitVisible()` at `:1413-1417`.
3. `ResizeObserver` on host + slots, 150 ms debounce → `fitVisible()` at `:1430-1447`,
   **gated `if (!expanded) return`**.

**Nothing fires on "my instance became visible."** `isActive` is in no dependency array.
The ResizeObserver *might* fire on the `display:none → block` transition, but it only
exists while `expanded`, it is 150 ms-debounced, and RO's `display:none` semantics are not
a contract worth building a live PTY on.

**Decision — explicit re-drive plus two fixes that must ship with it:**

```ts
// AgentSurface.tsx, next to the existing `expanded` effect
useEffect(() => {
  if (!isActive) return;
  const raf = requestAnimationFrame(() => fitVisible());
  return () => cancelAnimationFrame(raf);
}, [isActive, fitVisible]);
```
plus `if (!expanded || !isActive) return;` on the ResizeObserver effect (`:1431`).

- **`term.focus()` at `agentSession.ts:700` steals focus.** The layout effect at `:1355`
  can now open a terminal in a *background* instance. `Session.ensureOpen` becomes
  `(opts?: { focus?: boolean }) => void`, default `true`; `AgentSurface` passes
  `{ focus: isActive }`.
- **`fitAndResize()` no-ops while `!session.opened`** (`:363`), so a session spawned in a
  hidden instance never sends `{type:'resize'}` and the PTY runs at the server's default
  grid — exactly manual check #4. The activation re-drive closes it because
  `ensureOpen → term.open → fitAndResize` runs in order.

**`chatSession.ts:500` is a genuinely different path and needs nothing.** `ensureOpen` is a
documented no-op (the React portal mount *is* "open") and `fitAndResize` is
`transcriptRepin?.()` (`:503`). A chat pane under `display:none` keeps its DOM and its
scroll height; the same activation `fitVisible()` re-pins it. **Do not add a chat-side
`ensureOpen` by symmetry.**

#### Gap 5 — Test wiring

**Decision: no config change. `npm test` already runs tests that import dashboard source.**
Root `vitest.config.ts` `exclude: ['node_modules','dist','e2e','dashboard']` excludes the
`dashboard/` **directory from the test glob** — it does not stop a test living in `tests/`
from importing dashboard source. **62 existing files already do exactly that** (e.g.
`tests/unit/agent-status.test.ts:15` imports
`../../dashboard/src/components/sleepy/agentStatus.js`), and the config's `resolve.alias`
for `marked` exists precisely to support it.

Both new tests live in `tests/unit/` and are picked up with zero wiring:
- `tests/unit/scoped-storage.test.ts` → owned by **T1**
- `tests/unit/agent-status-project-rollup.test.ts` → owned by **T18**

**Owner of the wiring decision: T1.** Statement of done includes: *"`npm test` at repo root
runs the new file green with zero edit to `vitest.config.ts`. If it does not, T1 — and only
T1 — amends `vitest.config.ts` and records why."*

#### Gap 6 — `dreamcontext-agent-open-page`

**Decision: instance bus.** The payload is `{page, id}` where `id` is a task/knowledge slug
meaningful in exactly one vault (`AgentSurface.tsx:642`), and the consumer calls
`nav.navigate()` on **one** Shell (`App.tsx:91-103`). On `window`, every mounted
`AgentPageNavBridge` fires — project A's "Open in app ↗" navigates project B's Shell to a
slug that doesn't exist there.

#### Gap 7 — `vaultWindowLabel` contract

**Full `emitTo`/`listen` enumeration.**

*`dashboard/src/` — targeted:* `lib/checklistBridge.ts:71`
`emitTo(vaultWindowLabel(p.vault), CHECKLIST_SUBMIT_EVENT)`; `:109`
`emitTo(checklistWindowLabel(vault,id), CHECKLIST_ACK_EVENT)`; `:68`
`listen(CHECKLIST_ACK_EVENT)`; `:105` `listen(CHECKLIST_SUBMIT_EVENT)`.
*`dashboard/src/` — broadcast (no target, unaffected):* `lib/sleepy.ts:98,109,121,205`
`emit('sleepy:*')`, `:163` `listen('sleepy:shown')`; `components/sleepy/SleepyPerch.tsx:53`
`emit('sleepy:toggle')`.
*`dashboard/src/` — per-window-object (unaffected):* `lib/desktop.ts:295-296`
`win.once('tauri://created'|'tauri://error')`.
*`desktop/src-tauri/src/lib.rs` — all app-wide, no target:* `:569,575,581,591`
`app.listen_any("sleepy:toggle|hide|committed|enabled")`; `:664` `app.emit("sleepy:shown")`.
*Window labels minted:* `vaultWindowLabel(name)` (`desktop.ts:312`, **lossy**),
`checklistWindowLabel(vault,id)` (`checklistStore.ts:47`, **injective hex**), `'main'`
(`desktop.ts:415,421`), `SLEEPY_LABEL`/`PERCH_LABEL` (Rust).

**Exactly one targeted bridge breaks: the checklist submit.**

**New contract — a window registry, not a new label scheme:**

```ts
// dashboard/src/lib/windowRegistry.ts  (NEW)
export const WINDOW_REGISTRY_KEY = 'dc.windows.v1';
export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 15_000;
export interface WindowRegistryEntry { label: string; vaults: string[]; ts: number }

export function thisWindowLabel(): Promise<string>;            // Tauri getCurrentWindow().label, cached; '' off-desktop
export function publishOpenVaults(vaults: string[]): void;     // upsert this window's row + ts, prune stale
export function releaseWindow(): void;                         // beforeunload

/** Registry lookup ONLY — may return a stale label. Safe for "should I add a chip or focus
 *  another window?" (worst case: a focus call at a dead label, which throws and is caught). */
export function findWindowForVault(vault: string): string | null;

/** CORROBORATED lookup — the ONLY form allowed for a payload that can carry a secret.
 *  On desktop it intersects the registry answer with the live `WebviewWindow.getAll()` list
 *  and returns null when the label is not actually alive. Off-desktop it returns null.
 *  Fails CLOSED by design: there is no optimistic fallback. */
export async function resolveLiveWindowForVault(vault: string): Promise<string | null>;
```

- **What identifies a window:** its real Tauri label (`getCurrentWindow().label`).
  `vaultWindowLabel` is retained *only* for window **creation** in `openVaultWindow`
  (`desktop.ts:323-359`); its lossiness stays the pre-existing window-reuse quirk it
  already is.
- **Shared across windows** via `localStorage` on the one shared origin — the exact
  property `checklistStore.ts`'s header establishes and relies on. A 5s heartbeat + 15s
  staleness GC survives a crashed window that never ran `beforeunload`.
- **Why a heartbeat rather than just `WebviewWindow.getAll()`.** On the desktop, `getAll()`
  (already used at `desktop.ts:90-91`) would answer "is that window still alive?" instantly.
  But the registry must also work in the plain browser dashboard, where `thisWindowLabel()`
  returns `''` and there is no Tauri window list at all. The heartbeat is the one mechanism
  that covers both. On desktop it is belt-and-braces; in the browser it is the only belt.
- **How a submit finds the right WINDOW — and why it FAILS CLOSED.** `checklistBridge.ts:71`
  becomes:
  ```ts
  const label = await resolveLiveWindowForVault(p.vault);
  if (!label) return false;              // the caller already renders its own failure strip
  await emitTo(label, CHECKLIST_SUBMIT_EVENT, p);
  ```
  **There is deliberately NO `?? vaultWindowLabel(p.vault)` fallback.** `checklistBridge.ts`'s
  own header states the invariant: *"filtering at the receiver is not isolation"* — `emitTo`
  is used precisely because a checklist's markdown "may hold a pasted API key". The registry
  is eventually consistent (5 s heartbeat, 15 s GC, unlocked read-modify-write on shared
  localStorage), so a stale row can name the wrong window. Pre-tabs that mis-delivery could
  only reach an empty window or the one correct one; **post-tabs the wrong window may host
  several unrelated live projects**, each with its own `listen(CHECKLIST_SUBMIT_EVENT)`, so
  the plaintext payload would land in every one of their callbacks before the vault check
  rejected it. The receiver-side equality check at `checklistBridge.ts:107` still runs and is
  still load-bearing for CLAIMING the submit — but it is the second line of defence, not the
  first. A submit that cannot be corroborated is not sent at all.
- **How it finds the right INSTANCE inside that window:** it already does.
  `listenForChecklistSubmits(vault, handler)` is registered per instance with that
  instance's vault and filters `payload.vault !== vault` (`checklistBridge.ts:107`). N
  listeners fire; exactly one claims it and acks. That equality check stops being
  belt-and-braces and becomes load-bearing — **its doc block spans `:83-94`, and the
  belt-and-braces sentence at `:88-90` ("`vaultWindowLabel`'s sanitizer is DELIBERATELY
  lossy… rather than a redundant no-op.") must be rewritten to say so.** The only edit on the receiving side is `AgentSurface.tsx:1042`
  `getActiveVault()` → `useVault().vault`.

#### Gap 8 — StrictMode × N instances

**Verified idempotent, with the mechanism named.** The roster hydrate effect
(`AgentSurface.tsx:321-373`) latches `hydratedRef` **and** guards the spawn behind a
per-run `cancelled` flag. Under StrictMode, run 1's cleanup sets `cancelled = true` before
its `await` resolves, so `if (!cancelled && saved.length > 0)` (`:342`) skips run 1's spawn
and only run 2 spawns (the comment at `:346` states this and the code matches). Two
`/agent/sessions` GETs happen; harmless.

The N-instance multiplier is safe because `sessions` is a per-component `useRef` Map —
nothing is shared but the monotonic counters `sessionSeq` (`agentSession.ts:216`),
`chatSessionSeq` (`:394`), `paneSeq` (`AgentSurface.tsx:105`), whose sharing makes ids
*more* unique, not less. Dormant rows use a disjoint `restored-<i>` namespace (`:362`).

**No refactor. Assert instead:** the Wave-2 gate (M-x2) runs the app with two tabs under
StrictMode and asserts exactly one PTY per session server-side.

#### Gap 9 — Duplicate-open across windows

Same registry as gap 7 — which is why it lands in **Wave 3**, not Wave 4. Order of checks
when `+`/⌘P picks a vault:
1. already a chip in **this** window → activate it, done;
2. `findWindowForVault(v)` returns another live label →
   `WebviewWindow.getByLabel(label).setFocus()`, **no chip**;
3. else → add a chip, subject to the 6-instance ceiling.

---

### Where the spec is WRONG against the real code

| # | Spec claim | Reality | Fix |
|---|---|---|---|
| S1 | §0.1 `agentFileUrl`/`graphContentUrl` "become class methods" — implied 1-line-per-file | They are module functions consumed as `<img src>`/`<iframe src>` builders in **7 files**, and **two are non-React module functions** (`chatEntities.ts:2189` `rawUrl`, `PageView.tsx:44-49` `resolveImage`) | See S11 |
| S2 | §0.3 "`useServerHealth` returns `contextRoot` — split into `useServerVersion()` + a scoped `/health`" | `useServerHealth` returns `{health, serverCurrent}` where `health = {ok, version, upgradeReady}` (`useServerHealth.ts:29-37`) — **already global-only**. `contextRoot` is fetched by a *separate* call at `context/ProjectContext.tsx:35` | No split. `useServerHealth` **stays on the singleton `api`**; only `ProjectContext` takes `useApi()` |
| S3 | (implied) `VAULT_AGNOSTIC_PREFIXES` marks routes that ignore the vault | `src/server/index.ts:659` `effRoot = hv ?? contextRoot` — **every** route receives the header-resolved root; `isVaultAgnostic` only suppresses the 400 (`:660`). `/api/embeddings` is on that list and is fully per-vault (`routes/embeddings.ts:100-155` keys every run by `contextRoot`) | State the rule for implementers: *agnostic ≠ ignores the vault*. `useEmbeddingModel` MUST be scoped |
| S4 | §1.3 "update badge → WindowChrome"; constraint "do not touch `useVersionCheck.ts`" | `/api/version-check` is **not** on the agnostic list and `routes/version-check.ts:24` does `dirname(contextRoot)` + reads that project's `setup-config` packs. Its only consumer is `UpdateBadge`, rendered **only** by `Header.tsx:164` — never by the launcher | **Constraint conflict, flagged for the user.** `useVersionCheck.ts` gets the same one-line `useApi()` as every other hook; `UpdateBadge` stays **instance-level in Header**. The constraint's intent (don't break the launcher) is preserved because `useApi()` outside a `VaultProvider` returns `new ApiClient(null)` ≡ today |
| S5 | §1.3 "sleep debt → WindowChrome" | `SleepDebtTracker` and `Header`'s manual `refetchQueries` are per-vault data on the per-instance `QueryClient` | Both stay instance-level. WindowChrome's right cluster = zoom + theme + stale-server/upgrade banners only |
| S6 | §2.2 consumer table | `dreamcontext-navigate` has **two** consumers: `AgentSurface.tsx:1613` **and** `pages/LabPage.tsx:41` | Both move to the bus |
| S7 | §3.1 "lift `KIND_RANK`'s worst-of logic to project level" | The worst-of rollup **already exists** as `rollupKind(rows)` (`agentStatus.ts:100-105`) | `rollupProject` composes `rollupKind`, never re-derives it |
| S8 | §2.5 "`useSectionCollapse.ts:22` — already scoped, just change the source" | Correct that it's scoped, but `storageKey()` is a **module function** called at read/write time, not from React (`useSectionCollapse.ts:21-23`) | Thread `vault` as a parameter from the hook; `useVault()` cannot be called inside `storageKey()` |
| S9 | §0.1 `export const api = new ApiClient(null)` | Today it is `new ApiClient()` with no constructor (`client.ts:138`) | Cosmetic; pin `constructor(private readonly vault: string \| null)` |
| S10 | §4 "one window = one vault is assumed across `desktop.ts`" | True, but the **only** targeted consumer is the checklist bridge; `sleepy:*` (JS + Rust) are app-wide broadcasts and unaffected | Faz-4 label work is one file plus a new registry |
| S11 | §0.1 make the URL builders `ApiClient` methods | A class method forces an `ApiClient` instance down through `chatEntities.ts`'s pure markdown-rendering helpers just to read one field | **Keep them module functions that take the vault**: `agentFileUrl(vault, path, opts?)` / `graphContentUrl(vault, path, opts?)`. Same one-parameter change Faz 0 already makes to `uploadAgentFile`/`mintPromptToken` — one pattern, not two. `chatEntities.ts` needs `vault` threaded anyway for M1 |

---

### Collisions BOTH the briefs and the spec missed

Sweep run over `dashboard/src/`: `^let ` (13 hits) and
`^const X = new Map|Set|WeakMap|[]` (20 hits). Constant lookup tables
(`dreamCommand.ts:48,52,68,369`, `chatProtocol.ts:204`, `sql-parser.ts:33`,
`externalLinks.ts:23`, `chatEntities.ts:620,1032,1033`, `chatViewSpec.ts:176,556`,
`sleepy.ts:176`) are immutable — safe. The live ones:

#### M0 — THE BIG ONE: there are NINE instance-level window events, not two

Full census of `window.dispatchEvent` (14 sites, **13** distinct events — 10 move to the bus, 3 stay on `window`):

| event | producer | consumer | verdict |
|---|---|---|---|
| `dreamcontext-navigate` | `Shell.tsx:87` | `AgentSurface.tsx:1613`, `LabPage.tsx:41` | → bus (spec has it, consumer list incomplete) |
| `dreamcontext-agent-open-page` | `AgentSurface.tsx:642` | `App.tsx:99` | → bus (spec has it) |
| **`dreamcontext-delegate-agent`** | `lib/delegateAgent.ts:132-136` | `AgentSurface.tsx:916` (listener registered `:918`) | **→ bus. MISSED.** Worst case in the codebase: the payload's `accepted` flag is mutated **synchronously** by the listener (`delegateAgent.ts:127`), so with N instances the *first* AgentSurface to run claims the delegate — the task is handed to Claude **in the wrong project** and the real one reports success |
| **`dreamcontext-run-sleep-agent`** | `lib/sleepAgent.ts:44` | `AgentSurface.tsx:823` | **→ bus. MISSED.** Every open project spawns a sleep consolidation |
| **`dreamcontext-sleep-pending`** | `lib/sleepAgent.ts:68,74` | `SleepDebtTracker` | **→ bus. MISSED.** Per-vault sleep state |
| **`RUN_BRAIN_RESOLVE_EVENT`** | `lib/brainResolveAgent.ts:36` | `AgentSurface.tsx:852` | **→ bus. MISSED.** Spawns a `/dream-sync` agent in every project |
| **`AUTOMATION_RUN_CHAT_EVENT`** | `lib/automationRunChat.ts:62` | `AgentSurface.tsx:1002` | **→ bus. MISSED.** Opens a run transcript in every project |
| **`CLAUDE_SIGNIN_EVENT`** | `lib/claudeAuth.ts:67` | `AgentSurface.tsx:571` | **→ bus. MISSED.** Opens an `auth login` shell tab in every project |
| **`dc-lab-route`** | `components/lab/funnel/labRoute.ts:43` | `useLabRoute`, `useLabSearchParams` | **→ bus. MISSED.** Every instance's Lab page re-reads one window URL |
| `AUTO_CHECKPOINT_EVENT` | `lib/brainSyncPrefs.ts:33` | **nobody — zero `addEventListener` in `dashboard/src`** | **DEAD CODE. Leave on `window`, do not move it.** Verified orphaned: it is dispatched and never listened to. Moving a no-op event to the bus is work with no behaviour attached. T12 scopes the KEY; the event stays exactly as it is. |
| `dreamcontext-zoom` | `Header.tsx:30` | `AgentSurface.tsx:1644` | stays on `window` — every xterm should zoom ✓ |
| `AGENT_SETTINGS_EVENT` | `lib/agentSettings.ts:135` | `AgentSurface.tsx:308`, `agentSession.ts:303` | stays on `window` — genuinely app-global ✓ |
| `ANNOUNCEMENTS_READ_EVENT` | `hooks/useAnnouncements.ts:112` | announcements UI | stays on `window` — version-keyed, global ✓ |

This roughly triples the size of Faz 2.2 and is the highest-severity finding here.

#### M1 — `chatEntities.ts:2023-2027`: the mediaBoxes MAP and its load latch, not just the key

Both briefs say "scope the storage key". If you only scope the key: `loadMediaBoxes()` sets
`mediaBoxesLoaded = true` on the **first** instance to call it (`:2031-2032`), so the second
vault's key is never read; and the shared `mediaBoxes` Map means instance B's
`rememberMediaBox` serialises instance A's entries into B's key (`:2065`). Must become
`Map<vault, Map<path, box>>` plus a `Set<vault>` latch, with `vault` threaded through
`knownMediaBox` / `rememberMediaBox`. **The most likely silent cross-project bug in the plan.**

#### M2 — nothing disposes an instance's sessions on unmount

`AgentSurface` has no unmount cleanup that disposes; `dispose()` is reached from exactly four
call sites — `closeSessionById` (`:492`), `resumeChatInTerminal` (`:581`), `resumeChatSession`
(`:598`) and `openAgentInChat` (`:658`) — none of which is an unmount cleanup. Today that is correct — the
surface outlives everything. Under the **ceiling rule** and chip-close, unmounting a
`ProjectInstance` leaks its PTYs, WebSockets, xterms, `MutationObserver`s
(`agentSession.ts:305`) and the per-session `AGENT_SETTINGS_EVENT` listener (`:303`), plus
orphaned server-side PTY processes. **The ceiling rule cannot ship without this**, so it
belongs in Wave 2 (T8), not Wave 3.

#### M3 — overlay ids: 7 call sites, 5 of which collide

**Already safe — zero edits** (ids derived from `useId()`): `components/lab/RangeControl.tsx:262`,
`components/lab/funnel/FunnelOverviewPage.tsx:505`, `components/sleepy/SkillPickerPopover.tsx:40`.

**Literal ids that collide across instances:** `'command-palette'`
(`CommandPalette.tsx:210`), `'chat-history'` (`ChatHistoryPicker.tsx:181`),
`'announcements-modal'` (`AnnouncementsModal.tsx:9`, mounted per-instance at `App.tsx:281`),
`'insight-detail-panel'` (`InsightDetailPanel.tsx:80`), `'automation-detail-panel'`
(`AutomationDetailPanel.tsx:214`). `'project-switcher'` (`ProjectSwitcher.tsx:153`) becomes
single-mount in chrome (T9) → no collision, leave as-is.

`pushOverlay` de-dupes by id (`overlayStack.ts:14-16`), so instance A closing its palette
pops instance B's entry and Esc breaks in B.

#### M4 — `ProjectSwitcher`'s ⌘1-9 targets the wrong list

Mounted **twice** today (`App.tsx:260` launcher, `:289` vault) and `:132-137` jumps to
`openable[n]` — *all registered vaults*. As "activate the Nth chip" that list is wrong.

#### M5 — `preparePrompt`'s caller chain is two hops deep

`AuthorTaskComposer.tsx:2` / `DelegateComposer.tsx:4` (React) → `authorTaskAgent.ts:80` /
`delegateAgent.ts:146` (non-React libs) → `preparePrompt` → `mintPromptToken` →
`getActiveVault()`. **Two extra non-React files** need `vault` threaded.

#### M6 — verified SAFE, no change (so nobody wastes a task on them)

`lib/chime.ts:13` one `AudioContext` (correct — one voice, N sources; preserve when the
throttle goes per-vault). `lib/mermaidRender.ts:6` `lastTheme` (theme is window-level).
`lib/excalidrawPinch.ts:98-100` — `installed` is a document-level latch and
`resolvePinchTarget(targets, event.target)` resolves by DOM containment (`:118`), so N
boards each get their own gesture. `lib/desktop.ts:32` / `lib/checklistBridge.ts:43`
dynamic-import caches. `lib/desktop.ts:225` `lastPickerError`. `stores/savedViews.ts:59,72`
(projectId-keyed). `lib/checklistStore.ts:154` `writeTimers` (keyed by the injective
`checklistStateKey`). `AgentSurface.tsx:1649-1681` ⌘D/⌘T/⌘W/⌃`/⌘⇧O — bound to `hostRef` in
capture phase, and `inert` makes focus inside a hidden subtree impossible, so a hidden host
cannot receive them.

---

## SECTION 2 — FILE-BY-FILE PLAN

### Wave 1 — Faz 0 (contracts)

#### `dashboard/src/api/client.ts` — MODIFY *(T1)*
```ts
export class ApiClient {
  constructor(private readonly vault: string | null) {}
  private async request<T>(path: string, options?: RequestInit): Promise<T>   // header from this.vault
  get<T>(p: string): Promise<T>;  post<T>(p: string, b: unknown): Promise<T>;
  patch<T>(...); put<T>(...); del<T>(...);
}
export const api = new ApiClient(null);
// S11: module functions, NOT class methods — they build a URL string and need one scalar
export function agentFileUrl(vault: string | null, path: string, opts?: { raw?: boolean }): string;
export function graphContentUrl(vault: string | null, path: string, opts?: { raw?: boolean }): string;
/** @deprecated Faz 2 */ export function setActiveVault(v: string | null): void;
/** @deprecated Faz 2 */ export function getActiveVault(): string | null;
```
Module-level `activeVault` (`:26`) survives Faz 0 solely to keep the deprecated pair working.

#### `dashboard/src/context/VaultContext.tsx` — NEW *(T1)*
```ts
export interface VaultContextValue {
  vault: string | null;
  instanceId: string;      // stable per ProjectInstance, e.g. `inst-1`
  isActive: boolean;
  bus: EventTarget;        // replaces window for the 9 instance-level events
}
export const DEFAULT_VAULT_CONTEXT: VaultContextValue;  // { vault: null, instanceId: '', isActive: true, bus: <module singleton> }
export function VaultProvider(p: VaultContextValue & { children: ReactNode }): JSX.Element;
export function useVault(): VaultContextValue;                      // DEFAULT_VAULT_CONTEXT outside a provider
export function useApi(): ApiClient;                                // useMemo(() => new ApiClient(vault), [vault])
export function emitInstance<T>(bus: EventTarget, type: string, detail?: T): void;
export function useInstanceEvent<T>(type: string, handler: (detail: T) => void): void;
```
`DEFAULT_VAULT_CONTEXT` is **load-bearing**: it makes `useApi()` outside a provider
byte-identical to today's `api`, so the launcher, `CaptureBar`, `SleepyPerch` and the
checklist window are unaffected. `isActive: true` by default so nothing outside a provider
ever thinks it is hidden.

#### `dashboard/src/lib/scopedStorage.ts` — NEW *(T1)*
```ts
export const SCOPE_PREFIX = 'dreamcontext:';
export function scopedKey(vault: string | null, key: string): string;   // null → `key` VERBATIM; else `dreamcontext:<vault>:<key>`
export interface ScopeOpts {
  /** Copy the legacy value into the scoped key WITHOUT deleting the legacy key, so EVERY
   *  vault seeds from it instead of only the first one to read. Required for any key whose
   *  unset-fallback is the UNSAFE direction — see `autoCheckpointOnOpen` below. */
  keepLegacy?: boolean;
}
export function readScopedRaw(vault: string | null, key: string, opts?: ScopeOpts): string | null;
export function writeScopedRaw(vault: string | null, key: string, value: string): void;
export function readScoped<T>(vault: string | null, key: string, fallback: T): T;  // JSON over the raw pair
export function writeScoped<T>(vault: string | null, key: string, value: T): void;
export function removeScoped(vault: string | null, key: string): void;
```
Pinned semantics:
- `scopedKey(null, k) === k` — **not** `dreamcontext:k`. A null vault means launcher/browser:
  byte-identical behaviour, no migration.
- Migration lives in the **raw** layer, so it moves the string unchanged and serves both the
  JSON keys and the `'1'`/`'0'` keys with one code path. Guarded by a module `Set<string>` of
  migrated `vault|key` pairs — idempotent.
- **Documented decision (default, `keepLegacy` absent):** the legacy value goes to whichever
  project reads it first, then the legacy key is deleted. Copy-without-delete would re-seed
  every future project from a value that belonged to whatever project happened to be open
  last. Mirrors `usePersistedState.ts:25-34`.
- **`keepLegacy: true` is MANDATORY for `autoCheckpointOnOpen`,** and the reason generalises:
  copy-once-then-delete is only safe when the unset-fallback is the SAFE direction. It is not
  here — `brainSyncPrefs.ts:18-21` returns `getItem(KEY) !== '0'`, i.e. **default ON**
  (auto-commit). Under the default policy, a user who deliberately turned auto-checkpoint OFF
  keeps that intent for exactly ONE vault; every other vault they open finds no scoped key,
  falls back to ON, and silently starts auto-committing uncommitted work — reproducing, via
  the migration mechanism, the exact failure Gap 1 #9 scoped this key to prevent. With
  `keepLegacy` the legacy key survives, so every vault seeds from the user's real choice.

#### `tests/unit/scoped-storage.test.ts` — NEW *(T1)*
Covers: scoped-key shape for null and non-null vault; legacy→scoped migration copies then
deletes; second vault reading the same legacy key gets the fallback; migration runs once;
raw and JSON layers agree; corrupt JSON falls back.

#### Migration files (mechanical: `import { api }` → `const api = useApi()` at the top of the body)

- **`dashboard/src/hooks/**` — 28 files** *(T2)*: all files under `hooks/` that import
  `api/client` **except** `useLauncher.ts` and `useServerHealth.ts`. That is:
  `useAgentCapabilities`, `useAutomations`, `useBoard`, `useBrainStatus`, `useChangelog`,
  `useConfig`, `useConnections`, `useCouncil`, `useEmbeddingModel`, `useFederation`,
  `useGraph`, `useGraphSettings`, `useKnowledge`, `useLab`, `useLabPrefs`, `useLinkedRepos`,
  `useNodeContent`, `useObjectives`, `usePacks`, `useRecall`, `useRoadmapPrefs`, `useSleep`,
  `useSleepyChat`, `useTasks`, `useTaxonomy`, `useTheses`, `useVersionCheck`, `useVersions`.
  - **`useRoadmapPrefs.ts:95`** and **`useLabPrefs.ts:106`**: `api.put` sits inside a
    `useCallback([])` — add `api` to the dep array. `useApi()` is memoized, so identity is stable.
- **`dashboard/src/components/**` — React `.tsx`** *(T3)*: `layout/UpdateBadge.tsx`,
  `layout/UpgradeRelaunchBanner.tsx`, `settings/SystemDependencies.tsx`,
  `sleepy/AgentSetup.tsx`, `sleepy/ChatHistoryPicker.tsx`, `sleepy/ChatPane.tsx`,
  `sleepy/DocContent.tsx`, `sleepy/chat/BoardEmbed.tsx`, `sleepy/chat/PageView.tsx`,
  `sleepy/chat/PdfViewer.tsx`, `sleepy/chat/SlideOver.tsx`, `sleepy/chat/TranscriptItem.tsx`.
  URL-builder call sites in this lane: `ChatPane.tsx:984`, `PageView.tsx:48` (module fn
  `resolveImage(vault, src)` — vault passed down from the component), `TranscriptItem.tsx:78,88`,
  `PdfViewer.tsx:58`, `SlideOver.tsx:95`. **Do not touch `sleepy/SleepyPerch.tsx`.**
- **`dashboard/src/pages/**` + `context/`** *(T4)*: `CorePage.tsx`, `KnowledgePage.tsx`
  (`:363` `graphContentUrl(vault, target, {raw:true})`), `SettingsPage.tsx`,
  `context/ProjectContext.tsx:35`. **Do not touch** `LauncherPage.tsx`,
  `space/SpaceLauncher.tsx`, `CaptureBar.tsx`.
- **Agent/session spine — non-React + their sole callers** *(T5)*:

| file | change | new signature |
|---|---|---|
| `components/sleepy/agentSession.ts` | `:309` `getActiveVault()` → param | `createSession(vault: string, bypass: boolean, notify: () => void, claudeId: string, resume?, kind?, initialPrompt?, model?, submitInitial?, promptToken?, deferPrompt?): Session` |
| ” | `:451` alarm source | `raiseAskAttention({ source: vault })` |
| `components/sleepy/chatSession.ts` | `:423` | `createChatSession(vault: string, bypass: boolean, notify: () => void, claudeId: string, resume?, model?, effort?, initialPrompt?, promptToken?, deferPrompt?): ChatSession` |
| ” | `:589` | `raiseAskAttention({ source: vault, detail: askSummary(entry) })` |
| `lib/agentDrop.ts` | `:21` | `uploadAgentFile(vault: string \| null, file: File \| Blob, name: string): Promise<string \| null>` |
| `lib/agentPrompt.ts` | `:64`, `:88` | `mintPromptToken(vault: string \| null, prompt: string): Promise<string>` · `preparePrompt(vault: string \| null, prompt: string): Promise<PreparedPrompt>` |
| `lib/authorTaskAgent.ts` | `:80` (**M5**) | `authorTaskWithAgent(vault: string \| null, …existing): …` |
| `lib/delegateAgent.ts` | `:146` (**M5**) | `delegateTaskToAgent(vault: string \| null, args: DelegateAgentArgs): boolean` |
| `components/tasks/detail/useSectionCollapse.ts` | `:22` (**S8**) | `storageKey(vault: string \| null): string`; hook reads `useVault().vault` and threads it |
| `components/sleepy/chat/ChatViews.tsx` | `:99` | `const { vault } = useVault()` |
| `components/sleepy/chat/chatEntities.ts` | `:2189` `rawUrl` | `rawUrl(vault: string \| null, path: string): string`; `agentFileUrl(vault, path, {raw:true})` |
| `components/sleepy/AgentSurface.tsx` | `:431`,`:437` pass `vault` first; `:1042` `useVault().vault`; `:1696` `uploadAgentFile(vault, …)` | — |
| `components/sleepy/chat/Composer.tsx` | `:257` | `uploadAgentFile(vault, file, name)` — `useVault()` |
| `components/tasks/AuthorTaskComposer.tsx`, `components/tasks/DelegateComposer.tsx` | pass `useVault().vault` | — |

### Wave 2 — Faz 1 (instance shell, still one chip)

#### `dashboard/src/ProjectInstance.tsx` — NEW *(T6)*
```tsx
export interface ProjectInstanceProps {
  vault: string;
  instanceId: string;
  isActive: boolean;
  sidebarCollapsed: boolean;            // hoisted (gap 1 key #2)
  onToggleSidebar: () => void;
  onRollup?: (vault: string, r: ProjectRollup) => void;   // wired in Wave 4
}
export function ProjectInstance(p: ProjectInstanceProps): JSX.Element;
```
Renders `<div className="project-instance" data-instance={instanceId} hidden={!isActive}
inert={!isActive}>` wrapping `QueryClientProvider(perInstanceClient) → VaultProvider →
ProjectProvider → I18nProvider → {Shell, AgentSurface}`. `bus` is
`useRef(new EventTarget()).current`. **`ThemeProvider` is NOT here** — it moves to chrome.

#### `dashboard/src/lib/instanceQueryClient.ts` — NEW *(T6)*
```ts
export function createInstanceQueryClient(): QueryClient;                  // defaults from App.tsx:59-77
export function setInstanceActive(qc: QueryClient, active: boolean): void; // refetchInterval: active ? 15_000 : false; refetchOnWindowFocus: active
```
Built in Wave 2 because at N=1 (always active) it is behaviour-identical; Wave 3 (T17) only
audits the queries that must **override** it.

#### `dashboard/src/App.tsx` — REWRITE *(T6)*
Delete the module `queryClient` (`:59-77`), the module `initialVault` + `setActiveVault`
(`:185-192`), `AgentPageNavBridge` (`:91-103`, moves to `ProjectInstance` in Wave 3). Keep
`captureMode` / `perchMode` / `checklistId` / launcher branches verbatim. The vault branch
becomes `<ThemeProvider><QueryClientProvider client={chromeClient}><WindowChrome
initialVault={initialVault}/></QueryClientProvider></ThemeProvider>`. `?vault=` now names
the **first chip**, not the window.

#### `dashboard/src/components/layout/WindowChrome.tsx` — NEW *(T7)*
```tsx
export const MAX_LIVE_INSTANCES = 6;
export interface OpenProject {
  vault: string;
  instanceId: string;
  cold: boolean;
  /** Latest rollup published by this instance, or null when it has not published yet.
   *  null is NOT the same as idle — see the ceiling rule below. */
  rollup: ProjectRollup | null;   // type from agentStatus.ts (T18, Wave 1)
}
export interface ChromeApi {
  open: OpenProject[]; activeVault: string;
  addTab(vault: string): Promise<'added'|'focused-tab'|'focused-window'|'refused-ceiling'>;
  activate(vault: string): void;
  closeTab(vault: string): void;
  detachToWindow(vault: string): Promise<void>;
}
export function WindowChrome({ initialVault }: { initialVault: string }): JSX.Element;
export function useChrome(): ChromeApi;
```
Owns: traffic-light inset (86 px), `<ProjectTabs>`, the right cluster (**zoom + theme +
`StaleServerBanner` + `UpgradeRelaunchBanner` only**), the hoisted sidebar-collapse state,
`<ProjectSwitcher>` (single mount), and `openProjects.map(p => <ProjectInstance …/>)`.
**No persistence** — mount state only.

**Ceiling rule — the null case is load-bearing.** At `MAX_LIVE_INSTANCES`, an instance is
**evictable only when `rollup !== null && rollup.live === 0`**. An instance that has not yet
published a rollup (`rollup === null` — just mounted, or Wave 4's publication not wired yet)
is **NEVER evictable**. Treating null as idle would tear down an instance with a live chat,
violating HARD CONSTRAINT #1. Evict the oldest evictable instance into `cold: true`; if none
qualifies, return `'refused-ceiling'` and the strip states the reason.

#### `dashboard/src/components/layout/ProjectTabs.tsx` + `.css` — NEW *(T7)*
```tsx
export interface ProjectChip {
  vault: string; active: boolean; cold: boolean;
  worst: SessionStatusKind; live: number; waiting: number; bounceNonce: number;
}
export function ProjectTabs(p: {
  chips: ProjectChip[];
  onActivate(v: string): void; onClose(v: string): void;
  onAdd(): void; onDetach(v: string): void;
}): JSX.Element;
```
Centre-aligned, clamped to the 86 px traffic-light threshold. **Rule 1 — freeze on
interaction:** on `pointerenter` snapshot each chip's width into an inline `--chip-w` and
set `justify-content: flex-start` with a leading spacer; release and re-centre on
`pointerleave`. **Rule 2 — fall left when it doesn't fit:** a `ResizeObserver` on the strip
flips to `flex-start` + `overflow-x: auto` once it meets the right cluster. Chip = dot ·
name · badge · ×; `+` at the end (opens the ProjectSwitcher). `data-tauri-drag-region` on
the strip's empty area only.

#### `dashboard/src/components/layout/Header.tsx` — MODIFY *(T7)*
Delete `readVaultLabel()` (`:34-41`) and the `header-vault` node (`:148`). Move
`ZOOM_LEVELS`/`ZOOM_STORAGE_KEY`/`getStoredZoom`/`applyZoom`/the zoom control
(`:11-31,90-100,165-169`) and the theme toggle (`:83-88,170-180`) to `WindowChrome`.
**Keep instance-level:** rail toggle, search pill, `SleepDebtTracker`, refresh,
`UpdateBadge` (S4/S5). Drop `startTitleBarDrag`/`toggleMaximizeWindow`.

#### `dashboard/src/components/sleepy/agentSession.ts` — MODIFY *(T8)* — gap 4
```ts
ensureOpen: (opts?: { focus?: boolean }) => void;   // was () => void; default { focus: true }
```
`:678` `function ensureOpen(opts: { focus?: boolean } = {})`; `:700`
`if (opts.focus !== false) term.focus();`.

#### M9 — the badge count was being used as the eviction test (found at Phase 5 code review)
**CRITICAL, and the root cause was the pinned contract, not any implementation.**
`ProjectRollup.live` excludes `kind === 'shell'` rows on purpose — it is the chat BADGE count,
and a shell has no agent behind it. That is right for the badge. But the ceiling rule in
`WindowChrome.tsx` also gated eviction on `rollup.live === 0`, so a project whose only live
thing is a running SHELL — a dev server, a build watch, a process the user is watching —
reported `live: 0`, was selected as the oldest idle instance, was chilled into a cold chip, and
had its PTY killed mid-process by the unmount teardown. Exactly the failure this design exists
to prevent, reached through `shell` instead of `agent`/`chat`.

Fix: `ProjectRollup` gains **`alive`** — how many sessions of ANY kind still hold a live
PTY/WebSocket (`info.kind ∉ {'saved','ended'}`, shells INCLUDED). The ceiling consults `alive`
and nothing else; `live` stays a presentation count and may never decide a teardown. A
regression test locks the exact case: a project whose only row is a live shell has
`live === 0` and `alive === 1`.

The general lesson, recorded because it is the kind of mistake that recurs: **a number computed
for display must never be reused as a safety predicate.** They drift apart the moment the
display rule gains an exclusion.

#### M8 — the sleep-pending marker was a single global key (found by T11 during Wave 3)
`lib/sleepAgent.ts` stored `dreamcontext:sleep-pending-at` as ONE unscoped key. Clicking "Run
sleep agent" in project A therefore put project B's `SleepDebtTracker` into "Waiting to sleep…"
and disabled its menu item — a visible, wrong, cross-project state change. Neither the plan nor
any of the four review lenses caught it; T11 found it while moving `SLEEP_PENDING_EVENT` to the
bus, because scoping the EVENT without scoping the KEY it guards would have been half a fix.
`markSleepPending` / `clearSleepPending` / `sleepPendingSince` all take `vault` and go through
`scopedStorage`. **No legacy migration**: the value is ephemeral and the app gets a fresh origin
per launch, so there is nothing worth carrying forward.

#### M7 — `fitVisible` must itself refuse to run while hidden (raised by T8 during Wave 2)
Guarding only the ENTRY points is not enough: two other paths funnel through `fitVisible` and
both fire while an instance is hidden — the `[expanded, fitVisible]` effect re-runs whenever
`panes` changes (which changes `fitVisible`'s identity), and an already-queued ResizeObserver
timer can land after the instance goes background. Fitting a hidden xterm measures a
`display:none` subtree.

Today that is harmless **by accident, not by design**: `.agent-pane-term` is
`position:absolute; inset:0`, so the computed height is `auto` → `NaN` → FitAddon's own isNaN
guard bails. Add one explicit `height` to that CSS rule and it silently becomes a `2×1` resize
sent to a LIVE PTY. So `fitVisible` carries `if (!isActive) return;` at the top. No-op when
active, therefore byte-identical for a one-project window.

#### `dashboard/src/components/sleepy/AgentSurface.tsx` — MODIFY *(T8)* — gap 4 + M2 + M7
- `const { isActive } = useVault()`.
- New activation effect (exact code in gap 4), placed beside `:1413`.
- `:1355` and `:1365` → `s.ensureOpen({ focus: isActive })`.
- `:1431` guard → `if (!expanded || !isActive) return;`.
- **New unmount teardown (M2):**
  `useEffect(() => () => { sessions.current.forEach(s => { try { s.dispose(); } catch {} }); sessions.current.clear(); }, [])`.

#### `dashboard/src/components/search/ProjectSwitcher.tsx` — MODIFY *(T9)*
`currentVault()` (`:21`) → `useChrome().activeVault`. `pick()` (`:72`) default →
`chrome.addTab(v.name)`; **⇧-click** → `openVaultWindow`. ⌘1-9 (`:132-137`) → activate the
Nth **chip** from `chrome.open`, **not** `openable` (**M4**). Mounted once in
`WindowChrome`; both `App.tsx` mounts removed.

### Wave 3 — Faz 2 (global collisions)

#### `dashboard/src/components/layout/Shell.tsx` — MODIFY *(T10)*
`:78` `document.documentElement.dataset.sidebar` → write onto the instance wrapper via
`data-sidebar` on `.project-instance`; `styles/tokens.css:249-259` selector
`:root[data-sidebar="collapsed"]` → `.project-instance[data-sidebar="collapsed"]`;
`components/sleepy/AgentTerminal.css:31,44` keep reading `--app-content-left` (now inherited
from the wrapper). `:63-72` ⌘K → `if (!isActive) return;`. `:87` `dreamcontext-navigate` →
`emitInstance(bus, …)`. `:8,31,89` `activePage` →
`readScoped/writeScoped(vault, 'dreamcontext.dashboard.activePage', …)`. `:16` `/lab/`
deep-link read applies only to the first instance (`instanceId === 'inst-1'`).
`useSidebarCollapse()` replaced by the hoisted `sidebarCollapsed`/`onToggleSidebar` props.

#### Instance bus consumers — MODIFY *(T11)* — M0
`AgentSurface.tsx` (`:571`, `:642`, `:823`, `:852`, `:918`, `:1002`, `:1613`) and the
producers `lib/sleepAgent.ts:44,68,74`, `lib/delegateAgent.ts:134`,
`lib/brainResolveAgent.ts:36`, `lib/automationRunChat.ts:62`, `lib/claudeAuth.ts:67`.
Producer signature change, pinned:
```ts
export function runSleepAgent(bus: EventTarget): void;
export function delegateTaskToAgent(bus: EventTarget, vault: string | null, args: DelegateAgentArgs): boolean;
export function runBrainResolveAgent(bus: EventTarget): void;
export function openAutomationRunChat(bus: EventTarget, detail: AutomationRunChatDetail): void;
export function requestClaudeSignIn(bus: EventTarget): void;
```
`ProjectInstance.tsx` absorbs `AgentPageNavBridge` (bus-scoped). `dreamcontext-zoom`,
`AGENT_SETTINGS_EVENT`, `ANNOUNCEMENTS_READ_EVENT` stay on `window`.
NOTE: `SleepDebtTracker.tsx` consumes `SLEEP_PENDING_EVENT` — it is in T11's lane.

#### localStorage — MODIFY *(T12)*
`hooks/useSidebarCollapse.ts` → returns state for the hoist, key stays global.
`components/layout/Sidebar.tsx:86,110,146` `githubSyncSeen` → `readScopedRaw/writeScopedRaw`.
`lib/brainSyncPrefs.ts:21,29` → `readAutoCheckpointOnOpen(vault)` /
`writeAutoCheckpointOnOpen(vault, enabled)` + `AUTO_CHECKPOINT_EVENT` onto the bus.
**`components/sleepy/chat/chatEntities.ts:2023-2071` (M1)** →
```ts
export function knownMediaBox(vault: string | null, path: string): { w: number; h: number } | null;
export function rememberMediaBox(vault: string | null, path: string, w: number, h: number): void;
```
backed by `Map<string, Map<string, Box>>` + `Set<string>` load latch.

#### Permission-mode split — MODIFY *(T12 owns the storage half, T11 the consumption half)*
`lib/agentSettings.ts`: REMOVE `chatPermissionMode` from `AgentSettings`,
`DEFAULT_AGENT_SETTINGS`, `coerceAgentSettings` and the server mirror. Replace with a
per-vault accessor pair:
```ts
export type ChatPermissionMode = 'auto' | 'bypass';
export const CHAT_PERMISSION_MODE_KEY = 'agent:settings:chatPermissionMode';
export const CHAT_PERMISSION_MODE_EVENT = 'dc-chat-permission-mode';   // INSTANCE BUS, not window
export function readChatPermissionMode(vault: string | null): ChatPermissionMode;
export function writeChatPermissionMode(bus: EventTarget, vault: string | null, mode: ChatPermissionMode): void;
```
- `readChatPermissionMode` reads `readScopedRaw(vault, CHAT_PERMISSION_MODE_KEY)` and returns
  `'bypass'` **only** on an exact `'bypass'` match; anything absent, stale or malformed →
  `'auto'`. This preserves the existing posture at `agentSettings.ts:107-109` ("only an
  explicit 'bypass' opts into the caution mode").
- **Migration deliberately DROPS the legacy global value** — no `keepLegacy`, no copy. This is
  the one key where copying forward would be the harm: a globally-set `'bypass'` would fan out
  to every project at once. Every vault starts at `'auto'` and the user re-opts-in per project.
  A one-time reset of a permission toggle is the correct trade.
- `pages/SettingsPage.tsx:253` must stop writing `chatPermissionMode` through
  `writeAgentSettings` — the rest of the blob keeps its global path untouched.
- `AgentSurface.tsx` (`:250-251`, `:425`, `:441`, `:620`, `:624`, `:2161`) reads the per-vault
  value and subscribes to `CHAT_PERMISSION_MODE_EVENT` **on `useVault().bus`**, never on
  `window`. `AGENT_SETTINGS_EVENT` keeps its `window` listener for every remaining field.

#### `dashboard/src/lib/attention.ts` — MODIFY *(T13)* — gaps 2 + 3
```ts
export function setChipActiveProbe(probe: ((vault: string) => boolean) | null): void;
export function raiseAskAttention(alarm?: AskAlarm): void;                 // signature unchanged
```
Internals: `lastRaiseBySource: Map<string, number>` replaces `lastRaise` (`:23`); a separate
`lastChime` keeps the global 1500 ms floor. `WindowChrome` registers the probe.

**No `subscribeAsk`.** An earlier draft exported one so the chip could bounce off the alarm.
Dropped: the rollup's `waiting` 0→>0 transition (T19) is the **single owner** of
`ProjectChip.bounceNonce`. Two independent writers to one bounce is how a chip ends up
double-bouncing or flapping, and the rollup already carries the same edge.

#### URL-as-state — MODIFY *(T14)*
`components/lab/funnel/labRoute.ts` `:50,59,66` gain an "only the active instance may write
history" gate; a background instance buffers its route in memory. `NAV_EVENT` (`:43`) → the
instance bus (**M0**). `pages/LabPage.tsx:41` navigate listener → bus. New exports:
```ts
export function setLabRouteWritable(on: boolean): void;
export function flushBufferedRoute(): void;   // chrome calls this on chip activation
```

#### Overlay id namespacing — MODIFY *(T15)* — M3
```ts
// lib/overlayStack.ts — ADD ONE FUNCTION, existing signatures UNCHANGED
export function popAllWithPrefix(prefix: string): void;
// lib/useOverlayId.ts — NEW (keeps overlayStack framework-free, keeps T1's contract frozen)
export function useOverlayId(local: string): string;   // `${instanceId}::${local}`
```
Call sites edited: `CommandPalette.tsx:210`, `ChatHistoryPicker.tsx:181`,
`AnnouncementsModal.tsx:9`, `InsightDetailPanel.tsx:80`, `AutomationDetailPanel.tsx:214`.
`RangeControl.tsx`, `FunnelOverviewPage.tsx`, `SkillPickerPopover.tsx` need **zero edits**
(`useId()` already unique). `ProjectSwitcher.tsx` keeps its literal id (single-mount after T9).

#### Window registry — NEW + MODIFY *(T16)* — gaps 7 + 9
`dashboard/src/lib/windowRegistry.ts` (API pinned in gap 7). `lib/desktop.ts`:
`openVaultWindow` unchanged; add
`export async function focusWindow(label: string): Promise<boolean>`.

`lib/checklistBridge.ts:71` → **`resolveLiveWindowForVault(p.vault)`, which FAILS CLOSED on
`null` — there is NO `vaultWindowLabel` fallback** (see Gap 7 for the full rationale: the
payload can carry a pasted secret, and post-tabs a mis-targeted window may host several
unrelated live projects):
```ts
const label = await resolveLiveWindowForVault(p.vault);
if (!label) return false;              // the caller already renders its own failure strip
await emitTo(label, CHECKLIST_SUBMIT_EVENT, p);
```
`findWindowForVault` (registry-only, may be stale) is for the NON-secret decision alone —
"add a chip here, or focus another window?" — and must never be used on this path.
Also rewrite the `:88-90` sentence inside the `:83-94` doc block.

#### Background cost — MODIFY *(T17)*
`hooks/useAgentCapabilities.ts:70` (`/agent/session-stats` per `claudeId`) and any
dock/goal-badge query must set `refetchInterval` **explicitly**, overriding the instance
default, so a background goal-skill run's badge does not freeze.
`components/layout/Header.tsx` refresh button `disabled={!isActive}`. **No code path
anywhere may close a chat/terminal WebSocket on `isActive` change.**

### Wave 1 (also) — the pure rollup function

`rollupProject()` is a pure function over `SessionRow[]` with **zero dependencies on any
other task**, and `ProjectRollup` is the type `OpenProject.rollup` (T7, Wave 2) must be
declared against. It therefore builds in **Wave 1**, not Wave 4 — otherwise Wave 2 would have
to invent a placeholder type and Wave 4 would have to go back and re-type it.

#### `dashboard/src/components/sleepy/agentStatus.ts` — MODIFY *(T18, Wave 1)*
```ts
export interface ProjectRollup {
  worst: SessionStatusKind;  // dot + badge colour
  live: number;              // badge NUMBER — active chats/agents
  waiting: number;           // asking OR attention — drives the bounce
}
export function rollupProject(rows: SessionRow[]): ProjectRollup;
```
Pinned rules: `worst = rollupKind(rows)` (**reuse `:100`, S7**). `live` counts rows with
`kind !== 'shell'` **and** `info.kind ∉ {'saved','ended'}` — `saved` is the dormant
"Resume" row and `ended` is a dead PTY, neither is an active chat; a shell has no agent
behind it (`agentStatus.ts:47-49`) and can never ask. `waiting` counts a row once if
`info.kind === 'asking' || attention`. Empty input → `{ worst: 'ended', live: 0, waiting: 0 }`.

#### `tests/unit/agent-status-project-rollup.test.ts` — NEW *(T18, Wave 1)*
Covers: worst-of ordering across mixed rows; `saved`/`ended`/`shell` excluded from `live`;
`asking` and `attention` counted once when both; empty input; a project of only dormant rows
→ `live: 0`.

### Wave 4 — Faz 3 (badge) + Faz 4 (window bridge)

#### Window bridge + rollup sink — MODIFY *(T20)*
`lib/desktop.ts:442` `goToProject` default becomes "add a chip in this window" (delegating
to `ChromeApi.addTab`); `openVaultWindow` (`:323`) unchanged as the escape hatch.
`WindowChrome` gains, in one task because it owns that file:
- registry heartbeat (`publishOpenVaults` every 5 s + on change, `releaseWindow` on
  `beforeunload`) and the three-step duplicate-open check (gap 9);
- **the rollup sink**: `const [rollups, setRollups] = useState<Record<string, ProjectRollup>>({})`,
  an `onRollup(vault, r)` callback passed down to every `<ProjectInstance>`, and
  `OpenProject.rollup` populated from it (`null` until an instance publishes). This is what
  makes the ceiling rule and the chip badge readable from one place;
- chip right-click → "Open in New Window" = `detachToWindow` = `openVaultWindow` + `closeTab`.
  **Drag-out-of-strip is deliberately NOT built** — the goal needs *an* escape hatch, and a
  second one costs real HTML5-DnD surface next to a strip that already owns pointer gestures
  for the freeze rule.

`lib/checklistStore.ts` and the checklist window: **untouched**.

#### Badge publication + render — MODIFY *(T19)*
`AgentSurface.tsx:1777-1787` already builds `dockRows: SessionRow[]`; publish
`rollupProject(dockRows)` on the instance bus as `dc-project-rollup` whenever the rollup
changes (shallow-compare the three fields — do not republish per render).
`ProjectInstance.tsx` subscribes via `useInstanceEvent` and calls `props.onRollup(vault, r)`.
`ProjectTabs.tsx`/`.css`: number = `live` (badge omitted entirely at 0); colour = `worst`
(`asking`→red, `working`→violet, else neutral); dot carries the same `worst`; one-shot CSS
bounce when `waiting` crosses 0→>0 — **T19 is the sole writer of `bounceNonce`** — colour-only
under `prefers-reduced-motion`.

---

## SECTION 3 — DEPENDENCY MAP

Same file → same lane; no file appears in two tasks in one wave. Max 3 concurrent per wave.

| task | files owned | depends on | wave | contract |
|---|---|---|---|---|
| **T1** Contracts + test wiring | `dashboard/src/api/client.ts`, `dashboard/src/context/VaultContext.tsx` (new), `dashboard/src/lib/scopedStorage.ts` (new), `tests/unit/scoped-storage.test.ts` (new) | — | 1 | `class ApiClient { constructor(vault: string\|null); get/post/patch/put/del<T> }` · `export const api = new ApiClient(null)` · **module fns** `agentFileUrl(vault, path, opts?)` / `graphContentUrl(vault, path, opts?)` (S11) · `useVault(): {vault: string\|null; instanceId: string; isActive: boolean; bus: EventTarget}` with `DEFAULT_VAULT_CONTEXT = {vault:null,instanceId:'',isActive:true,bus:<singleton>}` · `useApi(): ApiClient` · `scopedKey(vault,key)` = `key` when vault is null, else `` `dreamcontext:${vault}:${key}` `` · **`npm test` runs `tests/**` and may import `dashboard/src/**`; no `vitest.config.ts` edit unless T1 says otherwise** |
| **T2** hooks/ migration | the 28 `dashboard/src/hooks/*.ts` listed in §2, **plus `components/search/BrainSearch.tsx` and the two recall call sites in `components/search/CommandPalette.tsx`** (added mid-wave: `recallOnce`/`haikuRecallOnce` are exported non-hook fns and no task owned their callers) | T1 | 1 | `const api = useApi()` at the top of each hook body; call sites unchanged. `useRoadmapPrefs.ts:95` and `useLabPrefs.ts:106` add `api` to their `useCallback` deps. **`useVersionCheck.ts` IS migrated** (S4). `useLauncher`/`useServerHealth` untouched |
| **T3** components/ migration | the 12 `.tsx` listed in §2 under T3 | T1 | 1 | `agentFileUrl(vault, path, {raw:true})` — vault from `useVault()`; `PageView.tsx`'s `resolveImage(vault, src)` takes it as a param |
| **T4** pages/ + ProjectContext | `dashboard/src/pages/{CorePage,KnowledgePage,SettingsPage}.tsx`, `dashboard/src/context/ProjectContext.tsx` | T1 | 1 | `ProjectProvider` uses `useApi()`; `projectId = hashString(contextRoot)` unchanged. `KnowledgePage.tsx:363` → `graphContentUrl(vault, target, {raw:true})`. Launcher files untouched |
| **T5** Agent/session spine | `components/sleepy/{agentSession.ts,chatSession.ts,AgentSurface.tsx,chat/ChatViews.tsx,chat/Composer.tsx,chat/chatEntities.ts}`, `lib/{agentDrop.ts,agentPrompt.ts,authorTaskAgent.ts,delegateAgent.ts}`, `components/tasks/{AuthorTaskComposer.tsx,DelegateComposer.tsx,detail/useSectionCollapse.ts}`, **`tests/unit/delegate-agent.test.ts`** (added mid-wave: it asserts against T5's own signatures and no task owned it) | T1 | 1 | `createSession(vault, bypass, notify, claudeId, resume?, kind?, initialPrompt?, model?, submitInitial?, promptToken?, deferPrompt?)` · `createChatSession(vault, bypass, notify, claudeId, resume?, model?, effort?, initialPrompt?, promptToken?, deferPrompt?)` · `uploadAgentFile(vault, file, name)` · `preparePrompt(vault, prompt)` · `mintPromptToken(vault, prompt)` · `storageKey(vault)` · `rawUrl(vault, path)` · `raiseAskAttention({ source: vault })` |
| **T6** Instance mount spine | `dashboard/src/ProjectInstance.tsx` (new), `dashboard/src/App.tsx`, `dashboard/src/lib/instanceQueryClient.ts` (new) | T1–T5 | 2 | `ProjectInstance({vault, instanceId, isActive, sidebarCollapsed, onToggleSidebar, onRollup?})` · wrapper `div.project-instance[data-instance]` with `hidden` + `inert` when `!isActive` · `createInstanceQueryClient()` reproduces `App.tsx:59-77` verbatim; `setInstanceActive(qc, active)` sets `refetchInterval: active ? 15_000 : false` · **`ThemeProvider` lives in chrome, never in the instance** |
| **T7** WindowChrome + strip | `components/layout/WindowChrome.tsx` (new), `components/layout/ProjectTabs.tsx`+`.css` (new), `components/layout/Header.tsx` | T1, T18 | 2 | `MAX_LIVE_INSTANCES = 6` · `ChromeApi { open: OpenProject[]; activeVault; addTab(v): Promise<'added'\|'focused-tab'\|'focused-window'\|'refused-ceiling'>; activate(v); closeTab(v); detachToWindow(v) }` · `useChrome(): ChromeApi` · `ProjectChip {vault, active, cold, worst, live, waiting, bounceNonce}` · chrome owns zoom + theme + stale/upgrade banners **only** |
| **T8** xterm re-drive + teardown ⚠️ RISK | `components/sleepy/agentSession.ts`, `components/sleepy/AgentSurface.tsx` | T5 | 2 | `Session.ensureOpen: (opts?: { focus?: boolean }) => void` (default `true`) · activation effect on `[isActive, fitVisible]` · RO effect guard `if (!expanded \|\| !isActive) return` · unmount cleanup disposes `sessions.current` (**M2**) · **`chatSession.ts` is NOT touched** |
| **T9** ProjectSwitcher single-mount | `components/search/ProjectSwitcher.tsx` | T7 | 2 | `pick()` → `chrome.addTab(name)`; ⇧ → `openVaultWindow(name)`; ⌘1-9 indexes `chrome.open`, **not** `openable` (**M4**) |
| **T10** Shell becomes instance-local | `components/layout/Shell.tsx`, `styles/tokens.css`, `components/sleepy/AgentTerminal.css` | T6, T7 | 3 | `data-sidebar` moves from `<html>` to `.project-instance` · ⌘K gated on `isActive` · `emitInstance(bus,'dreamcontext-navigate',{page})` · `activePage` via `readScoped/writeScoped` |
| **T11** instance-bus events + permission-mode consumption ⚠️ M0 | `components/sleepy/AgentSurface.tsx`, `dashboard/src/ProjectInstance.tsx`, `components/layout/SleepDebtTracker.tsx`, `lib/{sleepAgent.ts,delegateAgent.ts,brainResolveAgent.ts,automationRunChat.ts,claudeAuth.ts}` | T10, T12 | 3 | `runSleepAgent(bus)` · `delegateTaskToAgent(bus, vault, args): boolean` · `runBrainResolveAgent(bus)` · `openAutomationRunChat(bus, detail)` · `requestClaudeSignIn(bus)` · `dreamcontext-agent-open-page` + `dreamcontext-navigate` on the bus; `AgentPageNavBridge` moves into `ProjectInstance` · `dreamcontext-zoom` + `AGENT_SETTINGS_EVENT` + `ANNOUNCEMENTS_READ_EVENT` **stay on `window`**; `AUTO_CHECKPOINT_EVENT` is dead code — leave it alone · **also**: `AgentSurface` reads `readChatPermissionMode(vault)` (T12's) and subscribes `CHAT_PERMISSION_MODE_EVENT` on `useVault().bus` at `:250-251,:425,:441,:620,:624,:2161` |
| **T12** localStorage scoping + permission-mode split | `hooks/useSidebarCollapse.ts`, `components/layout/Sidebar.tsx`, `lib/brainSyncPrefs.ts`, `components/sleepy/chat/chatEntities.ts`, `lib/agentSettings.ts`, `pages/SettingsPage.tsx` | T1 | 3 | Scope: `githubSyncSeen`, `autoCheckpointOnOpen`, `chat.mediaBoxes`. Global untouched: `agentDock.collapsed`, `agent:settings:v1`, `aboutSeen`, `cmdk.intelligent`, `councilShowcaseDismissed`. Hoist: `sidebarCollapsed` · **M1**: `knownMediaBox(vault, path)` / `rememberMediaBox(vault, path, w, h)` over `Map<vault, Map<path, Box>>` + `Set<vault>` latch · `autoCheckpointOnOpen` migrates with **`keepLegacy: true`** (its unset-fallback is ON = auto-commit) · **splits `chatPermissionMode` out of `agent:settings:v1`**: `readChatPermissionMode(vault)` / `writeChatPermissionMode(bus, vault, mode)` + `CHAT_PERMISSION_MODE_EVENT` on the instance bus; legacy global value DROPPED, every vault starts `'auto'` |
| **T13** attention throttle + probe | `lib/attention.ts`, `components/layout/WindowChrome.tsx` | T7 | 3 | `setChipActiveProbe(probe: ((vault: string) => boolean) \| null): void` · `raiseAskAttention(alarm?)` **unchanged** · `lastRaiseBySource: Map<string, number>`; separate global `lastChime` · guard `if (isWatchingThisWindow() && (chipActiveProbe?.(key) ?? true)) return;` · `lib/chime.ts` untouched · **no `subscribeAsk`** — the rollup's `waiting` edge (T19) is the sole owner of the chip bounce |
| **T14** URL-as-state | `components/lab/funnel/labRoute.ts`, `pages/LabPage.tsx` | T10 | 3 | `setLabRouteWritable(on)` · `flushBufferedRoute()` · `pushLabPath`/`replaceSearch`/`clearLabPath` buffer instead of writing when not writable · `NAV_EVENT` on the instance bus |
| **T15** overlay id namespacing | `lib/overlayStack.ts`, `lib/useOverlayId.ts` (new), `components/search/CommandPalette.tsx`, `components/sleepy/ChatHistoryPicker.tsx`, `components/layout/AnnouncementsModal.tsx`, `components/lab/InsightDetailPanel.tsx`, `components/automations/AutomationDetailPanel.tsx` | T9 | 3 | `useOverlayId(local): string` → `` `${instanceId}::${local}` `` · `popAllWithPrefix(prefix)` · `pushOverlay`/`popOverlay`/`isTopOverlay` signatures **unchanged** — the three `useId()` sites need zero edits |
| **T16** window registry + label contract | `lib/windowRegistry.ts` (new), `lib/desktop.ts`, `lib/checklistBridge.ts` | T1 | 3 | `thisWindowLabel(): Promise<string>` · `publishOpenVaults(vaults)` · `findWindowForVault(vault): string\|null` (registry-only, for chip/focus decisions) · **`resolveLiveWindowForVault(vault): Promise<string\|null>`** — registry ∩ `WebviewWindow.getAll()`, the ONLY form allowed for the checklist payload · `releaseWindow()` · `WINDOW_REGISTRY_KEY='dc.windows.v1'`, `HEARTBEAT_MS=5000`, `STALE_MS=15000` · checklist submit **FAILS CLOSED**: `const label = await resolveLiveWindowForVault(p.vault); if (!label) return false;` — **no `vaultWindowLabel` fallback** · `focusWindow(label)` · **`checklistStore.ts` untouched** |
| **T17** background cost audit | `hooks/useAgentCapabilities.ts`, `components/layout/Header.tsx` | T6 | 3 | Agent-surface queries set `refetchInterval` **explicitly** · Header refresh `disabled={!isActive}` · **`isActive` never reaches a WebSocket** |
| **T18** `rollupProject` + unit test | `components/sleepy/agentStatus.ts`, `tests/unit/agent-status-project-rollup.test.ts` (new) | — (pure function, no deps) | **1** | `interface ProjectRollup { worst: SessionStatusKind; live: number; waiting: number }` · `rollupProject(rows): ProjectRollup` · `worst = rollupKind(rows)` · `live` = `kind !== 'shell'` && `info.kind ∉ {'saved','ended'}` · `waiting` = `asking \|\| attention`, once · empty → `{worst:'ended',live:0,waiting:0}` · **moved to Wave 1: `ProjectRollup` is the type `OpenProject.rollup` (T7, Wave 2) declares against** |
| **T19** badge publish + render | `components/sleepy/AgentSurface.tsx`, `dashboard/src/ProjectInstance.tsx`, `components/layout/ProjectTabs.tsx`+`.css` | T18, T20, T11 | 4 | publishes bus event `'dc-project-rollup'` with `detail: ProjectRollup` from `rollupProject(dockRows)` (`AgentSurface.tsx:1777-1787`), shallow-compared so it does not fire per render · `ProjectInstance` subscribes via `useInstanceEvent` and calls `props.onRollup(vault, r)` — the prop and the sink are T20's, already in place · badge omitted at `live === 0`; colour from `worst`; **T19 is the sole writer of `bounceNonce`** (one-shot on `waiting` 0→>0); colour-only under `prefers-reduced-motion` |
| **T20** window bridge + duplicate-open + rollup sink | `components/layout/WindowChrome.tsx`, `lib/desktop.ts` | T16, T7 | 4 | `goToProject(name)` → `chrome.addTab(name)`; `openVaultWindow` unchanged · `addTab` order: this-window chip → `findWindowForVault` → `focusWindow` → ceiling → add · heartbeat + `releaseWindow` on `beforeunload` · **owns the rollup sink**: `Record<string, ProjectRollup>` state + the `onRollup` prop threaded to each `<ProjectInstance>` + `OpenProject.rollup` (null until published) · ceiling treats `rollup === null` as **NOT evictable** · right-click → `detachToWindow`; **no drag-out** |

**Intra-wave batches (≤3 concurrent):**
- Wave 1: `[T1, T18]` → `[T2, T3, T5]` → `[T4]`
- Wave 2: `[T6, T7, T8]` → `[T9]`
- Wave 3: `[T10, T12, T16]` → `[T11, T13, T15]` → `[T14, T17]`
- Wave 4: `[T20]` → `[T19]`

`T1` and `T18` run concurrently in Wave 1's first batch: disjoint files (`api/client.ts` +
2 new files + a new test vs `agentStatus.ts` + a different new test), and `T18` imports
nothing from `T1`.

**STANDING RULE for every remaining wave — added after Wave 1.** Four times in Wave 1 the map
named a lane by a SYMBOL (`getActiveVault`, the `api/client` import list) and missed the files
that merely CONSUME that symbol: `tests/unit/delegate-agent.test.ts`, `BrainSearch.tsx`, the
`api` singleton call sites inside T5's own files, and `revealPath`'s three callers. Ownership
must be derived from the changed symbol's CALL TREE, not its import graph. Every task brief
from Wave 2 on therefore carries a behavioural clause — "no vault-bound call may remain on the
singleton in your files" — instead of a symbol checklist, and every implementer is told to STOP
and report rather than edit outside its lane. Stopping is what surfaced all four.

**Files deliberately touched by more than one task** (all verified to sit in DIFFERENT waves,
so no two ever run concurrently — audited mechanically):

| file | tasks (wave) |
|---|---|
| `components/sleepy/AgentSurface.tsx` | T5 (1) · T8 (2) · T11 (3) · T19 (4) |
| `dashboard/src/ProjectInstance.tsx` | T6 (2) · T11 (3) · T19 (4) |
| `components/layout/WindowChrome.tsx` | T7 (2) · T13 (3) · T20 (4) |
| `components/layout/ProjectTabs.tsx`+`.css` | T7 (2, creates) · T19 (4) |
| `components/sleepy/agentSession.ts` | T5 (1) · T8 (2) |
| `components/sleepy/chat/chatEntities.ts` | T5 (1) · T12 (3) |
| `components/layout/Header.tsx` | T7 (2) · T17 (3) |
| `lib/desktop.ts` | T16 (3) · T20 (4) |
| `lib/delegateAgent.ts` | T5 (1) · T11 (3) |
| `hooks/useAgentCapabilities.ts` | T2 (1) · T17 (3) |
| `components/sleepy/ChatHistoryPicker.tsx` | T3 (1) · T15 (3) |
| `pages/SettingsPage.tsx` | T4 (1) · T12 (3) |
| `components/search/CommandPalette.tsx` | T2 (1, recall call sites only) · T15 (3, overlay id) |

`lib/delegateAgent.ts` evolves its signature in TWO steps on purpose and each step is the
contract for its own wave — Wave 1 (T5): `delegateTaskToAgent(vault, args)`; Wave 3 (T11):
`delegateTaskToAgent(bus, vault, args)`. A T5 implementer must ship the two-arg form and
must NOT anticipate the bus parameter.

---

## SECTION 4 — ACCEPTANCE CRITERIA

### A — Automated (every wave gate)

| # | criterion | command | binary pass |
|---|---|---|---|
| A1 | Root typecheck | `npx tsc --noEmit` at repo root | exit 0, zero diagnostics |
| A2 | Dashboard typecheck | `cd dashboard && npx tsc --noEmit` | exit 0, zero diagnostics |
| A3 | Unit + integration suite | `npm test` at repo root | exit 0, **0 failed, 0 skipped** |
| A4 | `rollupProject()` unit test | `npm test` names `tests/unit/agent-status-project-rollup.test.ts` | listed and green |
| A5 | `scopedStorage` unit test | `npm test` names `tests/unit/scoped-storage.test.ts` | listed and green |
| A6 | Dashboard bundle builds | `npm run build` at repo root | exit 0; `dist/dashboard/` refreshed |
| A7 | No stray global api client | `grep -rn "getActiveVault()" dashboard/src` | **after Wave 3**: only inside `dashboard/src/api/client.ts` |
| A8 | No instance event left on `window` | `grep -rn "window.dispatchEvent(new CustomEvent" dashboard/src` | **after Wave 3**: only `dreamcontext-zoom`, `AGENT_SETTINGS_EVENT`, `ANNOUNCEMENTS_READ_EVENT` |
| A9 | Red line — no WS tied to visibility | `grep -rn "isActive" dashboard/src/components/sleepy/{agentSession.ts,chatSession.ts}` | zero matches |

Wave gates: **W1** = A1+A2+A3+A5+A6 and the app is observably identical to today.
**W2** = A1–A3, A6, plus M-x1/M-x2. **W3** = A1–A3, A6–A9. **W4** = all of A.

### B — Manual, against a real server with an isolated scratch vault

| # | check | pass condition |
|---|---|---|
| B1 | Register two vaults, open both as chips | Both chips render centred; both instances mounted and live with their own data; zero `no_vault`/`invalid_vault` in the server log |
| B2 | Start a chat in A, switch to B | A's chat keeps streaming; its WebSocket never entered `closed` (no PTY exit in the log); B's page data loaded independently |
| B3 | A's chat asks while you are on B | A's chip dot turns **red**, bounces **exactly once**, badge shows A's **active chat count**; a native banner fires **even though the window is focused** (gap 3); B's chip unchanged |
| B4 | Return to A | `term.cols`/`term.rows` match the visible grid, no clipped/wrapped TUI, scrollback intact |
| B4b | Return to A with a CHAT (not terminal) session mid-transcript | The transcript is where you left it — not jumped to the bottom, not stuck mid-scroll. **Raised by T8:** a scroller with no measurable height while hidden can mis-latch "at bottom", and `transcriptRepin()` alone may not correct it. `ChatPane`/`chat/*` scroll anchoring is owned by no task; if this fails, the fix belongs in Wave 3 alongside T11 |
| B5 | Close one chip | Only that project's sessions end (its PTYs exit); the other project's chat still streaming; no orphaned `claude` process |
| B6 | Open the same project twice (⌘P, `+`, and from a second window) | In-window: existing chip focused, no second chip. From another window: **that** window focused, no chip added here. `state/.agent-sessions.json` has exactly one writer |
| B7 | Open a 7th tab | If any instance has `live === 0`, the **oldest such** is torn down into a cold chip (sessions disposed) and the tab opens. If **all** are busy, the tab is **refused** with a stated reason |
| B8 | Add a 3rd chip, then close one with the cursor over the strip | Adding re-centres. Pointer inside the strip → layout **frozen** on close (slot stays empty). Pointer leaves → re-centres. Overflow → left-aligned + horizontally scrollable |
| B9 | Quit and relaunch | Exactly **one** project returns (the launcher's `?vault=`). No tab list on disk or in localStorage |

**Wave-2-only manual gate** (before Wave 3 starts):
- **M-x1** — two tabs, switch back and forth 5×: every switch leaves the terminal correctly
  fitted (B4's condition) and `ensureOpen` never steals focus from the active instance.
- **M-x2** — under `StrictMode` (dev build) with two tabs, each restored session spawns
  **exactly one** PTY server-side (gap 8); assert by counting `claude` child processes.

---

## OPEN QUESTIONS FOR THE USER (flagged, not blocking)

1. **S4 constraint conflict.** The hard constraints say don't touch
   `hooks/useVersionCheck.ts`, but `/api/version-check` reads `dirname(contextRoot)` and its
   only consumer is vault-side. The plan migrates it and keeps `UpdateBadge` instance-level.
   The alternative is to honour the constraint literally and accept the badge answering for
   the server's pinned root.
2. **Gap 1 key #9.** `autoCheckpointOnOpen` is scoped against Brief B's recommendation,
   because it flips real git behaviour per repo.
