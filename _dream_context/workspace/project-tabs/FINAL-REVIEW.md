# Final pre-commit review — 2026-08-10

Four narrow lenses, dispatched clean, after the first BROAD reviewer died mid-sweep with no
verdict. That is the third time on this goal that a wide-scope judge produced nothing and a
narrow question-list produced a verdict; the pattern is now reliable enough to plan around.

| lens | verdict |
|---|---|
| eviction ceiling + rollup + badge | **PASS** — 7/7 with file:line |
| the live-conversation red line | **PASS** — 6/6 with file:line |
| cross-project leak paths | **FAIL** — 1 Major (below) |
| hooks + query-cache correctness | died mid-sweep; **closed mechanically instead** (below) |

## The Major, and why the fix is not the one that was proposed

`popAllWithPrefix` in `overlayStack.ts` was written for exactly this defect and then never
called — dead code carrying a comment that says "Not called yet". The reviewer found it and
proposed wiring it into the chip-background transition.

Wiring it would not have worked. The overlays live in instances that stay MOUNTED; popping a
backgrounded project's entries would leave its still-open panel on screen with no stack entry
at all, so Escape would be just as dead when the user came back — the same bug, moved.

The defect is that one flat LIFO now spans several concurrently-mounted projects and has no
notion of which one is on screen. It fails in **both** directions:

- **Esc goes deaf.** Panel open in A, switch to B, panel open in B, switch back to A. A's
  panel is the one on screen; B's entry is topmost; Esc in A does nothing.
- **Esc hits the wrong project.** Same two panels, background pushed last: Esc in B closes
  A's invisible panel and leaves B's open.

Fix shipped: entries record the scope (active instance) they were pushed in, and Esc is
answered per scope — topmost AMONG ITS OWN SCOPE, and never for a background project.
`WindowChrome` sets the scope on every chip switch. `popAllWithPrefix` is deleted.

Capturing scope at PUSH time rather than parsing it out of the id matters: three popovers
(`RangeControl`, `FunnelOverviewPage`, `SkillPickerPopover`) build ids from `useId()` and know
nothing about vaults. They are fixed too, without becoming vault-aware.

`scope === null` — no `WindowChrome` above: the launcher, the browser build, the tests — keeps
the old flat behaviour byte-for-byte. That path is what every single-surface window still runs.

Locked by `tests/unit/overlay-stack-scope.test.ts`, 12 tests. The two named REGRESSION cases
both fail against the old implementation.

## Hooks lens, closed mechanically

The judge died mid-sweep, so these were answered by grep rather than restated as its verdict:

- **152** `useApi()` call sites, every one the plain `const api = useApi();` top-of-hook form.
  None conditional, none after an early return.
- `api` **is** in ~10 dependency arrays, so stability is load-bearing — and it is
  `useMemo(() => new ApiClient(vault), [vault])`. No render loop.
- Cache isolation is **structural**, not key-based: one `QueryClient` per `ProjectInstance`.
  A shared client would have served B's `['tasks']` to A regardless of key hygiene.
- All 8 `agentFileUrl`/`graphContentUrl` call sites pass a vault explicitly.
- 7 files still import the singleton `api`. Every route they call is on the server's own
  `VAULT_AGNOSTIC_PREFIXES` (`src/server/index.ts:550`): `/health`, `/launcher/*`, `/sleepy/*`,
  `/agent/capabilities`, `/agent/session-model`, `/agent/prompt` (which passes the vault in its
  body anyway). `useSleepyChat.ts` has zero importers — dead module, inert either way.

## Non-blocking, recorded not fixed

`brainSyncPrefs.ts:43` dispatches `AUTO_CHECKPOINT_EVENT` on `window` with no vault in the
payload. It has zero listeners today, and the acceptance criteria (A8) name it as deliberately
left alone. It is a landmine for whoever adds the first listener, not a live leak.
