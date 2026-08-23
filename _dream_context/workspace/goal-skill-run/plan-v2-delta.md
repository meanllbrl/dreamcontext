I've read the delta in full and verified its load-bearing claims against the code: `@playwright/test` is a devDependency (`package.json:81`) and 16 of 19 `scripts/verify/*.mjs` launch Chromium; `chat-scroll.mjs:423` already holds a row "to the pixel"; `ACTION_GLYPH` is `Record<ChatActionKind, string>` (`ActionRow.tsx:15-24`), so adding a kind is a compile break; `MarkdownPreview` sanitizes via DOMPurify (`core/MarkdownPreview.tsx:44`); `.chat-pane` has **no** `container:` declaration (only `.agent-pane` does, `AgentTerminal.css:458`, and it is `inline-size` — so `cqh` would not resolve, which changes p-n3's resolution).

---

# PLAN v2 — revisions

## (1) What changed

| Finding | Change |
|---|---|
| **R1** | **P9 overturned.** New `src/lib/claude-usage.ts` reads `~/.claude.json` → `cachedUsageUtilization`; new **`GET /api/agent/usage-limits`** (justified over extending `session-stats`) feeds `UsageMenu`. `UsageLimit` reshaped to **percent + `resetsAt`**, matching the real source. Staleness rules pinned (`fetchedAtMs`, `resets_at` rollover). `weekly_scoped` folded into one weekly bar unless it is the *binding* cap. New task **D1-B** owns it. A1 rewritten as resolved. |
| **S1** | `sanitizeLoopbackUrl` rewritten: post-parse normalized loopback (`127.1`, `0177.0.0.1`, `0x7f000001`, `①27。0。0。1`) is **accepted deliberately** and documented as safe by construction. `0.0.0.0` rejected explicitly with its reason. Accept/reject lists in §2.1, M2.9 and the tests all realigned. |
| **S2** | (a) `search`+`hash` stripped with a notice, mirroring `sanitizeImageSrc`. (b) **§2.2 deleted** — the `url` *action* stays https-only; the carve-out is pin-facts-only. (c) `.pin-chip.is-link` gets `title={fact.url}`. Criteria M2.9a-c added. |
| **S3** | `handoffToDevelop` spawns with `bp=false, explicitBypass=true` — a handoff can never escalate. AC 21 asserts `auto` regardless of the remembered mode. |
| **P1** | D1-C declares `mode?: ChatMode = 'basic'` / `onModeChange?` (no-op default); D1-E1 wires them in w3. **Build-green-between-waves rule** added to the map notes. |
| **P2 / C2 / C3** | "No Playwright" premise **retracted**. New browser-driven `scripts/verify/chat-shelf-ui.mjs` (D2-C) covers resting state, row open/close, ceiling, **scroll-invariance geometry** and the M2b y-invariance; new `scripts/verify/chat-composer-ui.mjs` (D1-E1) covers the composer menus. M1's geometry criterion is **restored, not replaced**; M1.2a stays as defence in depth. A6 corrected. §3.2 no longer claims an instrument substitution. |
| **P3** | `resumeChatSession` and `changeChatMode` pass model (pos 6), effort (pos 10) and mode (pos 12). AC 20 extended. |
| **P4** | `MAX_TAG_LABEL_CHARS` enforced in `validatePin`; `MAX_TAGS_PER_LINE` enforced in `layoutShelf` before the measured fold; both with notices and both asserted. |
| **C1** | `ContextUsage` declared in `agentComposer.ts` (D1-A, wave 1); D1-C imports it from there when it deletes `ContextReadout.tsx`. |
| **C4** | Loopback cases move to `tests/unit/chat-view-pin.test.ts` (D2-A, w4) against `sanitizeLoopbackUrl`; `chat-actions.test.ts` (D1-E2, w2) keeps only `develop` and asserts `url` **rejects** `http://localhost:5173`. D2-A no longer owns `chatActions.ts` at all. |
| s-n1 | `ActionRow.tsx` added to D1-E2 with a `develop` glyph (`⇥`). |
| s-n2 | `SAFE_SLUG_RE` gains a 64-char cap; the comment no longer claims traversal-safety. |
| s-n3 | `pinStore` no-ops on a falsy vault/conversation id; `sweepExpiredPins` scoped to `PIN_PREFIX`. |
| s-n4 | Task-progress: malformed slug → **HTTP 400**; well-formed-but-missing → **HTTP 200 `unknown-slug`**. |
| s-n5 | Pin `detail` renders through `MarkdownPreview` (DOMPurify); no new `innerHTML` path. |
| p-n1 | `chatDefault*` read only inside `spawn`'s `kind === 'chat'` arm. |
| p-n3 | **`cqh` rejected** — `.chat-pane` has no size container and adding one collapses its flex height. Instead the shelf's existing ResizeObserver writes `--pin-detail-max: {0.4 × paneH}px`, the same idiom `Composer`'s `paneHeight()` already uses (Composer.tsx:351-354). |
| p-n4 | `SESSION_FACTS_TTL_MS = 12_000` (< the 15s poll, so every poll is fresh); the memo's stated job is collapsing **concurrent panes**, not the cadence. |
| p-n5 | Shared dismiss/overlay effect extracted to `dashboard/src/lib/useDismissOnOutside.ts`, consumed by both `Popover` and `useAnchoredMenu`. |
| c-n1 | §1.9 rationale corrected — the lockstep scan greps the literal `CHAT_SURFACE_BRIEFING`; keeping `modeBriefing` out of `routes/` is hygiene, not a test constraint. |
| c-n2 | `CHAT_MODE_ROWS` moved to a React-free `dashboard/src/lib/chatModes.ts` + MIRRORED comments + a mirror test. |
| c-n3 | Anchors corrected to full paths throughout. |
| c-n5 | §2.6 restated as "the existing assertions stay green". |

---

## (2) Revised sections

### §0 — Decisions (changed / added rows)

| # | Question | Decision | Why / evidence |
|---|---|---|---|
| ~~P9~~ | 5h / weekly usage limits | **OVERTURNED — ship all three bars.** `~/.claude.json` → `cachedUsageUtilization` carries `utilization.five_hour`, `utilization.seven_day` and a `limits[]` array (percent + `resets_at` + `is_active` + optional `scope.model.display_name`). | Orchestrator-verified on disk, 2026-08-23. Read the same way `buildModelConfig` reads `~/.claude/settings.json` (agent-terminal.ts:977). |
| **P14** | New route or extend `session-stats`? | **New `GET /api/agent/usage-limits`**, vault-agnostic. | `session-stats` is per-`claudeId` and polled at 5s **per pane** — usage is account-global and would be re-read N× per tick. It also has a tested `EMPTY_STATS` contract (`computeSessionStats`, agent-terminal.ts:1107) that three unrelated fields would muddy. The new route polls at 60s and is shared. Registered in `VAULT_AGNOSTIC_PREFIXES` beside `/api/agent/model-config` (index.ts:550). |
| **P15** | `weekly_scoped` — third bar or folded? | **Folded into one weekly bar**, unless a scoped entry's percent **exceeds** `seven_day` — then it becomes the weekly bar and its `scope.model.display_name` is appended to the title ("Weekly · Fable"). | In the live sample weekly_all=47 and weekly_scoped=44: two bars three points apart is noise. The user needs the **binding** constraint, named. This is "show what's found, hide what isn't" applied to redundancy. |
| **P16** | Stale usage data | Bar hidden entirely when `Date.now() - fetchedAtMs > USAGE_MAX_AGE_MS` (6 h) **or** `Date.parse(resets_at) <= now` (the window already rolled over, so the percent describes a dead window). Between `USAGE_STALE_MS` (30 min) and 6 h it renders with an "as of HH:MM" label. | A percent from a rolled-over window is not stale data, it is wrong data. |
| **P17** | Playwright | **Available and used.** `@playwright/test` is a devDependency (package.json:81); 16/19 verify scripts launch Chromium. Phase-6 method clarified: verify scripts use the repo's own harness. | Verified. v1's premise was false; every criterion it caused me to downgrade is restored. |
| **P18** | `.chat-pane` size container for the 40% cap | **No `container-type: size`.** JS measurement writes `--pin-detail-max`. | `.chat-pane` (ChatPane.css:14-26) declares no container; `.agent-pane` (AgentTerminal.css:458) is `inline-size` only, so `cqh` resolves against nothing. Adding block-axis containment collapses the pane's flex height. `Composer.paneHeight()` already measures this exact box. |

### §1.1 `dashboard/src/lib/agentComposer.ts` — MODIFY *(D1-A)*

Additions to v1:
```ts
/** The session's context-window reading. Declared HERE, not in a component: `CONTEXT_TIGHT_PCT`
 *  already lives in this file, and the composer's usage ring, the usage popover and the
 *  shelf-free fallback all need it after ContextReadout.tsx is deleted. */
export type ContextUsage = { used: number; limit: number; pct: number };

/** MIRRORED in `src/lib/claude-usage.ts` — the wire shape of GET /api/agent/usage-limits.
 *  Change one, change the other; `tests/unit/claude-usage.test.ts` pins the pair. */
export interface UsageLimitWire {
  key: 'session' | 'weekly';
  /** 0-100, straight from the source — it is percent-based, not token-based. */
  percent: number;
  /** Epoch ms when this window resets. */
  resetsAt: number;
  /** e.g. "Fable", when a per-model cap is the binding one. */
  scope?: string;
}
export interface UsageLimitsResponse { limits: UsageLimitWire[]; fetchedAtMs: number | null }

/** What one bar in the usage popover renders. */
export interface UsageLimit {
  key: 'context' | 'session' | 'weekly';
  title: string;
  percent: number;                       // 0-100
  resetsAt: number | null;               // context has none
  detail?: { used: number; limit: number };  // context only — the raw reading
  scope?: string;
}
export const USAGE_STALE_MS = 30 * 60_000;
export const USAGE_MAX_AGE_MS = 6 * 60 * 60_000;

/** Context first, then every limit that is BOTH fresh and un-rolled-over. A limit with no
 *  source, stale past USAGE_MAX_AGE_MS, or whose window already reset is ABSENT from the
 *  array — never a zeroed bar (owner delta 4). Pure; `now` is injected for testability. */
export function usageLimits(
  ctx: ContextUsage | null,
  res: UsageLimitsResponse | null,
  now: number,
): { limits: UsageLimit[]; staleAsOf: number | null };
```
Everything else in §1.1 (`MODEL_INSIGHTS`, `modelNoteFor`, `splitModels`, `effortIndex`, `effortAt`, `ModelOption.priceIn`) is unchanged.

### §1.2 `src/server/routes/agent-terminal.ts` — MODIFY *(now owned by D1-B)*
Unchanged in content: `buildModelConfig()` (974-983) maps each model to `{...m, priceIn: priceForModel(m.id).in}`.

### §1.2b `src/lib/claude-usage.ts` — CREATE *(D1-B)*
```ts
/** MIRRORED in `dashboard/src/lib/agentComposer.ts` (UsageLimitWire/UsageLimitsResponse). */
export interface UsageLimitWire { key: 'session' | 'weekly'; percent: number; resetsAt: number; scope?: string }
export interface UsageLimitsResponse { limits: UsageLimitWire[]; fetchedAtMs: number | null }

/**
 * Read Claude Code's own cached account-usage blob from `~/.claude.json`
 * (`cachedUsageUtilization`). Total function — an absent file, an absent key, malformed
 * JSON, a non-numeric percent or an unparseable `resets_at` all degrade to
 * `{ limits: [], fetchedAtMs: null }`. NEVER throws, never partially-fills a bar.
 *
 * Primary read is the summary (`utilization.five_hour` / `utilization.seven_day`); the
 * `limits[]` array is consulted only to (a) fill a missing summary key and (b) discover a
 * `weekly_scoped` entry whose percent EXCEEDS `seven_day`, in which case that entry becomes
 * the weekly bar and its `scope.model.display_name` rides along as `scope` (P15).
 */
export function readUsageLimits(home?: string): UsageLimitsResponse;
```
- Percent clamped to `[0,100]`; a value outside that range drops the entry rather than clamping silently (a >100 percent means the shape changed).
- `resets_at` → `Date.parse`; `NaN` drops the entry.
- No caching here — the route is polled at 60s and the file is small; a memo would only add a staleness dimension on top of `fetchedAtMs`.

### §1.2c `src/server/routes/agent-usage.ts` — CREATE + `src/server/index.ts` — MODIFY *(D1-B)*
```ts
/** GET /api/agent/usage-limits — the account's 5-hour and weekly caps, from Claude Code's
 *  own cache. Vault-agnostic (it reads ~/.claude.json, exactly like /agent/model-config).
 *  Off-desktop it answers 200 with an EMPTY list rather than 403, so the popover renders
 *  nothing instead of surfacing an error the user cannot act on. */
export async function handleAgentUsageLimits(req, res, params, contextRoot): Promise<void>;
```
`index.ts`: `router.get('/api/agent/usage-limits', handleAgentUsageLimits);` beside `/api/agent/model-config` (line 357), and `'/api/agent/usage-limits'` appended to `VAULT_AGNOSTIC_PREFIXES` (line 550).

### §1.2d `dashboard/src/hooks/useAgentCapabilities.ts` — MODIFY *(D1-A)*
```ts
/** Account-global and slow-moving: one 60s poll, shared by every pane's usage popover. */
export function useUsageLimits(enabled: boolean): UseQueryResult<UsageLimitsResponse>;
// refetchInterval 60_000, staleTime 55_000, retry false, placeholderData { limits: [], fetchedAtMs: null }
```

### §1.3 `dashboard/src/lib/useDismissOnOutside.ts` — CREATE + `chat/useAnchoredMenu.ts` — CREATE *(D1-C)*
```ts
// useDismissOnOutside.ts — extracted VERBATIM from SkillPickerPopover.tsx:42-61 so the
// overlay-stack arbitration exists once, not twice.
export function useDismissOnOutside(
  open: boolean,
  onClose: () => void,
  refs: Array<React.RefObject<HTMLElement | null>>,
): void;
```
`dashboard/src/components/sleepy/SkillPickerPopover.tsx` — MODIFY: `Popover`'s effect (42-61) replaced by a call to `useDismissOnOutside(open, () => setOpen(false), [anchorRef, menuRef])`. Behaviour byte-identical; `AgentComposerBar.tsx:5,138` is unaffected.

```ts
// chat/useAnchoredMenu.ts
export type ComposerMenuId = 'mode' | 'model' | 'usage' | null;
export function useAnchoredMenu(): {
  open: ComposerMenuId;
  toggle: (id: Exclude<ComposerMenuId, null>) => void;  // opening one closes the others
  close: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;      // attach to `.chat-cmp`
};
```
Built on `useDismissOnOutside`.

### §1.4 `dashboard/src/components/sleepy/chat/ComposerMenus.tsx` — CREATE *(D1-C)*
As v1, with three changes:
- `CHAT_MODE_ROWS` **moved out** to `dashboard/src/lib/chatModes.ts` (§1.4b) and imported.
- `UsageMenu` signature reshaped:
  ```ts
  export function UsageMenu(p: {
    limits: UsageLimit[];          // context + whatever was found; an absent limit is absent
    staleAsOf: number | null;      // renders "as of HH:MM" when set; null = fresh
    costUsd: number | null;
  }): JSX.Element;
  ```
  One `.chat-cmp-usagerow` + `.chat-cmp-usagebar` + `.chat-cmp-usagemeta` per entry. Context's meta is `used / limit · free` (from `detail`); a session/weekly meta is `resets in Xh Ym`. The nested-bars stack IS the owner's Apple-Health request.
- `ModeMenu` unchanged (still no set-default).

### §1.4b `dashboard/src/lib/chatModes.ts` — CREATE *(D1-C)*
```ts
/** MIRRORED in `src/server/chat-modes.ts` (CHAT_MODES). Kept React-free so the mirror test
 *  can import both sides under root vitest's plain-Node environment. */
export type ChatMode = 'basic' | 'plan' | 'develop' | 'jarvis';
export const CHAT_MODE_ROWS: ReadonlyArray<{
  id: ChatMode; name: string; insight: string; badge?: string; disabled?: boolean;
}> = [
  { id: 'basic',   name: 'Basic',      insight: 'Plain Claude. No mode enabled.' },
  { id: 'plan',    name: 'Plan',       insight: 'Asks the questions, ends with a task.' },
  { id: 'develop', name: 'Develop',    insight: 'Implements in waves, with evidence.' },
  { id: 'jarvis',  name: 'J.A.R.V.I.S', insight: 'Talk with the agent.', badge: 'Soon', disabled: true },
];
```

### §1.5 `dashboard/src/components/sleepy/chat/Composer.tsx` — MODIFY *(D1-C)*
As v1, with **P1's build-green fix** and C1:
```ts
/** OPTIONAL with a safe default so this file compiles and renders green in wave 2, before
 *  ChatPane wires it in wave 3. `onModeChange` defaults to a no-op, so the trigger opens its
 *  menu and shows "Basic" but selecting is inert until wired. */
mode?: ChatMode;                       // default 'basic'
onModeChange?: (m: ChatMode) => void;  // default () => {}
shelved?: boolean;                     // default false — D2 squares the card's top corners
```
`ContextUsage` now imported from `../../../lib/agentComposer` (C1), not from the deleted `ContextReadout.tsx`. Usage ring + popover fed by `usageLimits(ctx, useUsageLimits(connected).data, Date.now())`. Everything else (skill removal, toolbar order, placeholder, the three send buttons) is unchanged from v1.

### §1.9 `src/server/routes/agent-spawn-shared.ts` — MODIFY *(D1-D)* — rationale corrected
`sanitizeChatMode` lives here **because this is where every other URL-param sanitizer lives** (`sanitizeUuid`/`sanitizeModel`/`sanitizeEffort`, lines 71-88) — one place to audit the trust boundary. It imports only `CHAT_MODES` from `../chat-modes.js`. *(c-n1: v1 justified this by the lockstep scan, which is wrong — `chat-surface-lockstep.test.ts:92-96` greps the literal string `CHAT_SURFACE_BRIEFING`, so importing `modeBriefing` here would not have tripped it. Keeping `modeBriefing` out of `routes/` is hygiene: prose belongs with prose.)*

### §1.11 `chat/chatActions.ts` — MODIFY *(D1-E2)*
```ts
/** A dreamcontext slug, capped. NOTE: this class also matches '..' — that is acceptable here
 *  ONLY because a `develop` slug never becomes a path on this side: it is interpolated into a
 *  prompt string, and the server's task-progress route applies `isSafeTaskSlug` independently.
 *  Do not reuse this regex for anything that builds a path. */
const SAFE_SLUG_RE = /^[A-Za-z0-9._-]{1,64}$/;
```
`ChatActionKind` / `ACTION_KINDS` gain `'develop'`; `toAction` gains its case. **`isHttpsUrl` is NOT touched** — the `url` action stays https-only (S2b).

### §1.11b `chat/ActionRow.tsx` — MODIFY *(D1-E2)* — NEW
`ACTION_GLYPH` (ActionRow.tsx:15-24) is `Record<ChatActionKind, string>`, so adding a kind without a glyph is a **compile error**. Add `develop: '⇥'` (a mono glyph, per the file's own glyph-set note at line 12).

### §1.13 `chatSession.ts` / §1.14 `AgentSurface.tsx` — MODIFY *(D1-E1)*
As v1, with three corrections:

**`spawn` signature** — positional, 12 params. Because a dead positional argument is exactly the defect S3 found, D1-E1 must add an explicit order comment above the definition and every new call site is pinned in the criteria:
```
spawn(bp, claudeId?, resume, kind, initialPrompt, model, submitInitial, promptToken, deferPrompt, effort, explicitBypass, mode)
//    1    2          3       4     5              6      7             8            9            10      11              12
```

**`resumeChatSession` (AgentSurface.tsx:755-765)** — P3. Today it calls `spawn(cs.bypass, cs.claudeId, true, 'chat')`, silently dropping model and effort (a pre-existing defect this task inherits by touching the line). Corrected:
```ts
spawn(cs.bypass, cs.claudeId, true, 'chat', '',
      sessionModel[cs.id] || cs.model, true, '', false,
      sessionEffort[cs.id] || cs.effort, false, cs.mode);
```
`sessionModel`/`sessionEffort` first, mirroring the authority order at AgentSurface.tsx:2438-2439 (an explicit picker choice outranks what `system:init` last reported). `changeChatMode(sid, mode)` writes the roster row then calls the same path with the new mode.

**`handoffToDevelop(cs, taskSlug)`** — S3:
```ts
const { inline, token } = await preparePrompt(vault, developKickoffPrompt(taskSlug));
// bp=false WITH explicitBypass=true. Without the explicit flag, spawn's chat arm
// (AgentSurface.tsx:572) overrides `bp` with the vault's REMEMBERED mode — so an
// agent-authored button could have launched a bypassPermissions session. A handoff carries
// no permission decision of its own, so it takes the safe one, using the same documented
// exemption the Delegate composer uses (AgentSurface.tsx:555-565).
const s = spawn(false, undefined, false, 'chat', inline,
                sessionModel[cs.id] || cs.model, true, token, false,
                sessionEffort[cs.id] || cs.effort, true, 'develop');
```
Then insert its roster entry at the plan tab's index in the plan tab's pane, and only then `closeSessionById(cs.id)`.

**p-n1:** `agentSettings.chatDefaultModel` / `chatDefaultEffort` are read **only inside `spawn`'s `kind === 'chat'` arm** (AgentSurface.tsx:567-582), and only when the caller passed no model/effort — a terminal agent still inherits the CLI's own defaults untouched.

**c-n3 anchors:** `<ChatPaneHost>` is rendered from `chatPanes.map(...)` at **AgentSurface.tsx:2426-2451** (`permissionMode` at :2445) — `mode` is inserted beside it.

### §1.17 Deletions *(D1-C)*
- `chat/PermissionModeMenu.tsx`, `chat/ContextReadout.tsx` — deleted. **`ContextUsage` is not deleted with it**: it moves to `agentComposer.ts` in wave 1 (C1), so wave 2's deletion has nothing to orphan.
- `.chat-permmode-*` swept from `sleepy/ChatPane.css`, `sleepy/chat/overlays.css`, `sleepy/chat/composer.css:709-711`.
- `dashboard/src/components/sleepy/SkillPickerPopover.tsx` is **kept and edited** (p-n5) — `AgentComposerBar.tsx:5,138` still consumes `SkillBrowser` and `Popover` still serves the Attach menu.

### §2.1 `dashboard/src/lib/chatViewSpec.ts` — MODIFY *(D2-A)*

Caps block — `MAX_TAG_LABEL_CHARS` is now **enforced** (P4):
```ts
export const MAX_PINS_PER_CONVERSATION = 24;
export const MAX_PIN_FACTS = 6;
export const MAX_PIN_LEDE_CHARS = 160;
export const MAX_PIN_DETAIL_CHARS = 4000;
export const MAX_TAG_LABEL_CHARS = 48;   // enforced in validatePin, with a notice
export const MAX_TAGS_PER_LINE = 12;     // enforced in layoutShelf (shelfModel.ts), with a notice
```

The carve-out, rewritten per S1 + S2a:
```ts
/**
 * The DELIBERATE loopback carve-out to this surface's https-only rule — for PIN FACTS ONLY.
 * The `url` ACTION (chatActions.ts) is deliberately NOT widened: nothing in the goal asked
 * for it, and a narrower carve-out is a smaller thing to get wrong.
 *
 * The gate is post-parse, and that is a DELIBERATE choice with a consequence worth stating:
 * WHATWG `URL` normalizes `127.1`, `0177.0.0.1`, `0x7f000001` and the IDNA forms
 * `①27.0.0.1` / `127。0。0。1` all to hostname `127.0.0.1`. Those are therefore ACCEPTED, and
 * that is safe by construction — the browser and the OS opener will resolve the identical
 * normalized host we compared against, so an obfuscated spelling of loopback cannot reach
 * anywhere loopback does not. A pre-parse string match would have been the unsafe design:
 * it would reject the obfuscated spellings while still letting the browser resolve them.
 *
 * Rejected, each for its own reason:
 *   • any hostname that does not normalize to exactly `localhost` / `127.0.0.1` / `[::1]`
 *     — `localhost.evil.com` and `127.0.0.1.evil.com` are ordinary public names;
 *   • `0.0.0.0` — it is NOT loopback, but on Linux and Windows a connection to it lands on
 *     loopback anyway, so it is the one non-loopback host that behaves like one. Rejected
 *     explicitly rather than left to the hostname compare;
 *   • userinfo (`http://user:pass@localhost/`) — mirrors sanitizeImageSrc's rule;
 *   • protocol-relative `//host` and any scheme but http/https.
 *
 * `search` and `hash` are STRIPPED (mirroring sanitizeImageSrc, chatViewSpec.ts:140-170) —
 * a pinned dev URL is an origin and a path, never a parameter payload. The caller emits a
 * notice when anything was stripped.
 */
export function sanitizeLoopbackUrl(raw: string): { url: string | null; strippedQuery: boolean };
```
Same control-character strip + `//`-reject preamble as `sanitizeImageSrc`.

`validatePin` additionally: each fact `label` clamped to `MAX_TAG_LABEL_CHARS` **with a notice** naming how many were shortened; a fact whose `url` fails the gate keeps its label and drops the link, with a notice; `strippedQuery` raises `"A pinned URL's query string was removed — a pinned link is an address, not a payload."`; `ledeClamped` is stripped from author input.

`validateProgress` unchanged from v1 (agent-supplied `percent`/`pct`/`done`/`total` dropped **with** the notice).

### ~~§2.2~~ — **DELETED** (S2b)
`chat/chatActions.ts` is **not** touched by D2. `isHttpsUrl` stays exactly as it is (chatActions.ts:85-91). Consequence: `chatActions.ts` is owned by D1-E2 alone, and C4's wave conflict disappears.

### §2.3 `dashboard/src/lib/shelfModel.ts` — CREATE *(D2-A)*
As v1, plus P4 and p-n3:
```ts
/** Fraction of the PANE height a user-opened detail may occupy. The component multiplies the
 *  MEASURED `.chat-pane` height by this and writes `--pin-detail-max` — `cqh` is unavailable
 *  because `.chat-pane` declares no container and giving it block-axis containment would
 *  collapse its flex height. Same idiom as Composer's COMPOSER_PANE_FRACTION. */
export const SHELF_DETAIL_PANE_FRACTION = 0.4;

export interface ShelfLayout {
  row: ShelfEntry | null;
  tags: ShelfTag[];        // capped at MAX_TAGS_PER_LINE
  overflowTags: ShelfTag[];// the count-capped excess — folded, never dropped
  demotedIds: string[];
  notices: string[];
}
/** `layoutShelf` enforces MAX_TAGS_PER_LINE BEFORE the component's measured width fold:
 *  the cap is about COUNT, the fold is about WIDTH, and both feed the same `+N` chip so the
 *  total is always visible. A capped tag raises a notice naming how many were folded. */
export function layoutShelf(entries: ShelfEntry[], facts: ShelfFact[]): ShelfLayout;
```
All other signatures (`effectiveWeight`, `clampLede`, `foldAt`, `foldViews`, `SHELF_MAX_ROWS`) unchanged.

### §2.4 `dashboard/src/lib/pinStore.ts` — CREATE *(D2-A)*
As v1, plus s-n3:
```ts
/** Every export NO-OPS on a falsy vault or conversationId. `labelPart('')` returns '', which
 *  would collapse two different scopes onto one key — the exact cross-project leak
 *  checklistStore.ts's header exists to prevent. Absence is the only safe reading. */
export function readPins(vault: string, conversationId: string): ShelfEntry[];   // [] when either is falsy
export function writePins(vault: string, conversationId: string, entries: ShelfEntry[]): void;  // no-op
/** Iterates via Storage.length/key(i) and touches ONLY keys under PIN_PREFIX — it must never
 *  reach a checklist envelope or any other module's key. */
export function sweepExpiredPins(now: number): void;
```

### §2.6 `tests/unit/chat-surface-lockstep.test.ts` — MODIFY *(D2-A)*
The **existing assertions stay green** once §2.1 and §2.5 land in the same wave (five in the lockstep describe, three in the surface-gate describe). *(c-n5: v1 said "four".)* One assertion is added — the no-percent lock from v1 §2.6.

### §2.8 `src/lib/session-facts.ts` — CREATE *(D2-B)*
As v1, with p-n4:
```ts
/** Collapses CONCURRENT panes, not the poll cadence: four split panes each fire their own
 *  15s poll, and without this that is four `git` forks in the same tick. Deliberately SHORTER
 *  than the 15s poll interval, so a real branch switch is never masked by the memo. */
export const SESSION_FACTS_TTL_MS = 12_000;
```
Branch via `git.currentBranch` (**`src/lib/git-sync/git.ts:123`** — `symbolic-ref --short HEAD`, which survives an unborn branch, unlike `rev-parse --abbrev-ref`). **[Δ]**

### §2.9 `src/server/routes/agent-shelf.ts` — CREATE *(D2-B)*
As v1, with s-n4 and c-n4:
- **Both handlers** take `contextRoot: string | null` and early-return the empty shape when it is null, following `handleAgentGoalLive` (`src/server/routes/agent-terminal.ts:1456-1459`).
- **Both handlers** carry the `isDesktop()` gate, so §5.2's "gate off ⇒ empty, never 500" holds for both.
- Task-progress slug arms, unambiguous:
  - `!isSafeTaskSlug(slug)` (malformed / traversal / empty) → **HTTP 400** `{error:'invalid_slug'}`, matching `handleTasksGet` (`src/server/routes/tasks.ts:699`). It never reaches the filesystem.
  - well-formed slug, no such file → **HTTP 200** `{ state:'unknown-slug', percent:null, notice:… }`. This is a renderable state, not a client error.

### §2.13 `chat/PinShelf.tsx` — CREATE *(D2-C)*
As v1, plus:
- **s-n5:** a pin's `detail` renders through **`dashboard/src/components/core/MarkdownPreview.tsx`**, which sanitizes every block with DOMPurify (`:44`). Progress detail renders as structured `.pin-task` rows from typed data. **No `dangerouslySetInnerHTML` anywhere in this component.**
- **S2c:** `.pin-chip.is-link` carries `title={fact.url}` so the destination is readable before the click, plus `aria-label={`Open ${fact.url}`}`.
- **p-n3:** the same `ResizeObserver` that measures the tag row also reads `rootRef.current?.closest('.chat-pane')`'s height and writes `--pin-detail-max: ${Math.round(h * SHELF_DETAIL_PANE_FRACTION)}px` on `.pin-shelf`; `.pin-body { max-height: var(--pin-detail-max, 34vh) }` keeps the design's value as the pre-measurement fallback.

### §4 — Assumptions & open questions (corrected rows)

| # | Statement | Status |
|---|---|---|
| **A1** | ~~No local source for the 5h/weekly limits.~~ **RESOLVED — a source exists.** `~/.claude.json` → `cachedUsageUtilization` (`utilization.five_hour`, `utilization.seven_day`, `limits[]` with `percent`/`resets_at`/`is_active`/`scope`). | **Closed.** v1's assumption came from a sandbox denial (`~/.claude` is outside this session's allowed directory), not from evidence of absence — I should have flagged it as *unverifiable here* rather than reasoning from the failed lookup. All three bars ship (P9 overturned); `UsageLimit` models the source's real percent shape. |
| **A6** | Vitest runs in plain Node — no jsdom. | **Still true and still load-bearing**: every shelf/composer *rule* lives in a pure module. **Consequence corrected**: the components are NOT uncovered — `@playwright/test` is a devDependency (package.json:81) and 16/19 verify scripts drive real Chromium, so the repo's own harness covers them, including pixel-level geometry (`chat-scroll.mjs:423`). |
| **A11** *(new)* | `readUsageLimits` is written against a **single live sample** of `cachedUsageUtilization`. | **Assumption.** Mitigated by construction: the reader prefers the two summary keys, treats `limits[]` as optional enrichment, drops any entry with a non-finite percent or unparseable `resets_at`, and degrades the whole read to an empty list on any surprise. A shape change hides bars; it can never show a wrong one. `tests/unit/claude-usage.test.ts` fixtures the live sample verbatim plus six malformed variants. |
| **A12** *(new)* | WHATWG `URL` in this runtime normalizes `127.1` / `0177.0.0.1` / `0x7f000001` / IDNA forms to `127.0.0.1`. | **Asserted, not assumed** — `tests/unit/chat-view-pin.test.ts` checks each accepted form yields hostname exactly `127.0.0.1`. If a runtime differs, the test fails loudly and the gate has failed *closed* (reject), which is the safe direction. |

All other v1 assumptions (A2-A5, A7-A10) stand unchanged.

---

## (3) Full corrected dependency map

**Notes that bind every row:**
- **Build-green-between-waves (P1):** every wave must leave `npm test` and `npm run build` green on its own. A prop a later wave wires is declared **optional with a safe default** by the wave that introduces it.
- **Same file → same lane** within a wave; a file may be revisited in a *later* wave.
- **Route registration** in `src/server/index.ts` happens twice, in waves 1 and 4 — different waves, so no lane conflict.
- **Mirrored declarations** (`ChatMode`, `UsageLimitWire`) carry the repo's MIRRORED comment on both sides and a test pinning the pair.

| task | files owned | depends on | wave | contract |
|---|---|---|---|---|
| **D1-A** composer data (client) | `dashboard/src/lib/agentComposer.ts`; `dashboard/src/hooks/useAgentCapabilities.ts`; `tests/unit/agent-composer-model-menu.test.ts` (new) | — | 1 | `type ContextUsage = { used: number; limit: number; pct: number }`; `ModelOption.priceIn?: number \| null`; `modelNoteFor(id: string): ModelNote \| null`; `splitModels(config: ModelConfig, current: string, primaryCount?: number): { primary: ModelOption[]; other: ModelOption[] }`; `effortIndex(efforts: string[], level: string): number`; `effortAt(efforts: string[], index: number): string`; `interface UsageLimit { key:'context'\|'session'\|'weekly'; title:string; percent:number; resetsAt:number\|null; detail?:{used:number;limit:number}; scope?:string }`; `usageLimits(ctx: ContextUsage \| null, res: UsageLimitsResponse \| null, now: number): { limits: UsageLimit[]; staleAsOf: number \| null }`; `useUsageLimits(enabled: boolean)` |
| **D1-B** usage + price (server) | `src/lib/claude-usage.ts` (new); `src/server/routes/agent-usage.ts` (new); `src/server/routes/agent-terminal.ts` (`buildModelConfig` only); `src/server/index.ts`; `tests/unit/claude-usage.test.ts` (new) | — | 1 | `readUsageLimits(home?: string): UsageLimitsResponse`; `GET /api/agent/usage-limits` → `{ limits: Array<{key:'session'\|'weekly'; percent:number; resetsAt:number; scope?:string}>; fetchedAtMs: number \| null }`, vault-agnostic, 200-with-empty off-desktop; `GET /api/agent/model-config` gains `models[].priceIn: number` |
| **D1-D** mode transport (server) | `src/server/chat-modes.ts` (new); `src/lib/worktree-gate.ts` (new); `src/server/routes/agent-spawn-shared.ts`; `src/server/routes/agent-chat.ts`; `tests/unit/chat-modes.test.ts` (new); `scripts/verify/chat-modes.mjs` (new) | — | 1 | `type ChatMode = 'basic'\|'plan'\|'develop'\|'jarvis'`; `CHAT_MODES`; `sanitizeChatMode(v: string \| null): ChatMode`; `modeBriefing(mode: ChatMode, opts: { worktreeAllowed: boolean }): string`; `worktreeIsolationAllowed(projectRoot: string): boolean`; WS URL param `&mode=` |
| **D1-C** composer chrome | `dashboard/src/lib/chatModes.ts` (new); `dashboard/src/lib/useDismissOnOutside.ts` (new); `dashboard/src/components/sleepy/SkillPickerPopover.tsx`; `chat/useAnchoredMenu.ts` (new); `chat/ComposerMenus.tsx` (new); `chat/Composer.tsx`; `chat/composer.css`; `chat/PermissionModeMenu.tsx` (del); `chat/ContextReadout.tsx` (del); `sleepy/ChatPane.css`, `chat/overlays.css` (dead `.chat-permmode-*` only); `tests/unit/chat-mode-mirror.test.ts` (new) | D1-A, D1-B, D1-D | 2 | `Composer` props gain **optional** `mode?: ChatMode` (default `'basic'`), `onModeChange?: (m: ChatMode) => void` (default no-op), `shelved?: boolean` (default `false`); `ModeMenu`/`ModelMenu`/`UsageMenu(p:{limits:UsageLimit[]; staleAsOf:number\|null; costUsd:number\|null})`; `useAnchoredMenu(): { open, toggle, close, rootRef }`; `useDismissOnOutside(open, onClose, refs)`; `CHAT_MODE_ROWS` (React-free) |
| **D1-E2** develop action | `chat/chatActions.ts`; `chat/ActionRow.tsx`; `dashboard/src/lib/agentPrompt.ts`; `tests/unit/chat-actions.test.ts` (extend) | — | 2 | `ChatActionKind` gains `'develop'` (payload `id`, `/^[A-Za-z0-9._-]{1,64}$/`); `ACTION_GLYPH.develop`; `developKickoffPrompt(taskSlug: string): string`; **`url` remains https-only** |
| **D1-E3** defaults persistence | `src/server/routes/launcher.ts`; `dashboard/src/lib/agentSettings.ts`; `tests/unit/agent-ui-settings.test.ts` (extend/new) | — | 2 | `AgentUiSettings` gains `chatDefaultModel: string`, `chatDefaultEffort: string` (both `''` = inherit CLI) |
| **D1-E1** mode wiring (client) | `dashboard/src/components/sleepy/chatSession.ts`; `sleepy/AgentSurface.tsx`; `sleepy/ChatPaneHost.tsx`; `sleepy/ChatPane.tsx`; `src/server/routes/agent-sessions.ts`; `tests/unit/agent-sessions-roster.test.ts` (extend); `scripts/verify/chat-composer-ui.mjs` (new) | D1-C, D1-D, D1-E2, D1-E3 | 3 | `createChatSession(…, mode?: ChatMode)`; `ChatSession.mode: ChatMode`; `spawn(…, explicitBypass, mode)` — 12 positional params, order comment mandatory; `ChatSurfaceActions` gains `changeMode: (sid: string, mode: ChatMode) => void` and `handoffToDevelop: (cs: ChatSession, taskSlug: string) => void`; `SavedMeta.mode?: ChatMode` (round-trips only alongside `kind:'chat'`) |
| **D2-A** spec + model + store + briefing | `dashboard/src/lib/chatViewSpec.ts`; `dashboard/src/lib/shelfModel.ts` (new); `dashboard/src/lib/pinStore.ts` (new); `src/server/chat-surface.ts`; `tests/unit/chat-surface-lockstep.test.ts`; `tests/unit/chat-view-pin.test.ts` (new); `tests/unit/shelf-model.test.ts` (new); `tests/unit/pin-store.test.ts` (new) | — | 4 | `PinViewSpec`, `ProgressViewSpec`; `sanitizeLoopbackUrl(raw: string): { url: string \| null; strippedQuery: boolean }`; `ShelfEntry`, `ShelfFact`, `ShelfTag`, `ShelfLayout` (with `overflowTags`); `layoutShelf(entries: ShelfEntry[], facts: ShelfFact[]): ShelfLayout`; `effectiveWeight(e: ShelfEntry): PinWeight`; `clampLede(text: string): { lede: string; clamped: boolean }`; `foldAt(chipRights: number[], rowWidth: number, foldChipWidth: number): number`; `foldViews(prev, views, at): { entries: ShelfEntry[]; evicted: number }`; `SHELF_DETAIL_PANE_FRACTION`; `readPins/writePins/sweepExpiredPins` |
| **D2-B** shelf server | `src/server/routes/agent-shelf.ts` (new); `src/lib/session-facts.ts` (new); `src/lib/markdown.ts`; `src/server/index.ts`; `tests/unit/task-progress.test.ts` (new); `tests/unit/session-facts.test.ts` (new); `scripts/verify/chat-shelf.mjs` (new) | — | 4 | `GET /api/agent/task-progress?slug=` → `TaskProgress` (400 on a malformed slug, 200 `unknown-slug` on a missing file); `GET /api/agent/session-facts` → `SessionFacts`; `firstUnticked(sectionBody: string): string \| null`; `readSessionFacts(projectRoot: string): SessionFacts`; `SESSION_FACTS_TTL_MS = 12_000` |
| **D2-C** shelf UI | `chat/PinShelf.tsx` (new); `chat/pinShelf.css` (new); `chat/useShelf.ts` (new); `chat/ChatViews.tsx`; `chat/Composer.tsx`; `sleepy/ChatPane.tsx`; `dashboard/src/hooks/useAgentCapabilities.ts`; `tests/unit/chat-shelf-placement.test.ts` (new); `scripts/verify/chat-shelf-ui.mjs` (new) | D2-A, D2-B | 5 | `useShelf(session: ChatSession, vault: string \| null): ShelfHandle`; `<PinShelf shelf={ShelfHandle} onOpenUrl={(url: string) => void} />`; `useTaskProgress(slug: string \| null, enabled: boolean)`; `useSessionFacts(enabled: boolean)`; `Composer` receives `shelved` |
| **INT** integration wiring | `skill/SKILL.md`; `skill/references/integrations.md`; `agents/goal-implementer.md`, `agents/goal-planner.md`; `package.json` | D2-C | 6 | skill docs name both `dream-view` types + the three chat modes **with the surface gate**; `npm run verify:chat-modes`, `verify:chat-composer-ui`, `verify:chat-shelf`, `verify:chat-shelf-ui` |

**Lane check.** Wave 1 = 3 tasks; wave 2 = 3; wave 3 = 1; wave 4 = 2; wave 5 = 1; wave 6 = 1 — all ≤ 3. ✓ Cross-wave file shares only: `src/server/index.ts` (w1 D1-B / w4 D2-B), `useAgentCapabilities.ts` (w1 D1-A / w5 D2-C), `Composer.tsx` (w2 D1-C / w5 D2-C), `ChatPane.tsx` (w3 D1-E1 / w5 D2-C). No file appears twice in one wave. ✓ D1 waves 1-3 strictly precede D2 waves 4-5. ✓ `chatActions.ts` is now single-owner (D1-E2), resolving C4. ✓

---

## (4) Full corrected acceptance criteria

### 3.1 — Additions to `chat-density-shrink-chrome-and-demote-the-context-meter-…` (D1)
Existing criteria 1-8 stand unchanged. Append:

- [ ] **9 · The toolbar is the design's five controls, in order** — mode trigger (mode name + permission), attach icon, spacer, usage ring, model+effort trigger, send. `.chat-cmp-pill`, `.chat-cmp-readout` and `.chat-cmp-ctxcard` no longer exist in `composer.css` or in the rendered DOM.
- [ ] **10 · The context meter is a 16px ring** carrying `role="meter"`, `aria-valuenow` and an `aria-valuetext` with the full `X / Y · N%` reading, plus a `title` with the same text. Criterion 6's "demoted, never deleted" holds: the arithmetic is one click away in the usage popover and one hover away in the title.
- [ ] **11 · Escalation survives the redesign** — past `CONTEXT_TIGHT_PCT` (a named constant, criterion 7) the ring goes `data-tight` **and** the `/compact` button appears in the toolbar without hover or focus.
- [ ] **12 · Four menus, one at a time** — usage, model+effort, mode+permission open upward, anchored to `.chat-cmp`; opening one closes the others; Esc closes only the top overlay (LIFO via the shared `useDismissOnOutside`, extracted from `SkillPickerPopover`'s effect so the arbitration exists once) and an outside pointerdown closes.
- [ ] **13 · The mode menu has NO "Set as default"**; the model+effort menu HAS one, and it persists `chatDefaultModel`/`chatDefaultEffort` to `~/.dreamcontext/agent-ui.json`, which a subsequent **chat** spawn reads — the terminal agent's CLI defaults are untouched.
- [ ] **14 · Skills are gone from the composer** — no Skills popover, no `skillChip` state, no `.chat-cmp-skillchip`. The idle placeholder names the slash path, and the existing `/` menu still opens at any token boundary.
- [ ] **15 · Effort is a slider** — `min=0 max={efforts.length-1}`, ticked with every level, the active tick marked; `effortIndex`/`effortAt` clamp rather than return `-1` for an unknown level.
- [ ] **16 · No behaviour regressed** — auto-grow (`--chat-cmp-h`), the drag handle floor, the slash menu, attachments (paste + file/folder/task pick), the queue/stop/send trio, ↑/↓ history and the one-row toolbar at 740px, 470px and 380px all behave exactly as before. A unit test asserts `composerBodyHeight`'s bounds are unchanged.
- [ ] **17 · Modes are real behaviour** — `basic` adds nothing beyond `CHAT_SURFACE_BRIEFING`; `plan` and `develop` each append a mode briefing at spawn through the SAME `--append-system-prompt-file` (one temp file, one cleanup); `jarvis` renders disabled with a "Soon" badge and can never be selected or transmitted (`sanitizeChatMode('jarvis') === 'basic'`).
- [ ] **18 · Develop's worktree permission is gated, not assumed** — the worktree sentence appears only when `worktreeIsolationAllowed(projectRoot)` (brain `full-repo` **or** a present linked repo); otherwise the briefing explicitly forbids a worktree. A unit test drives all four combinations.
- [ ] **19 · Mode travels and persists** — client → `&mode=` → `sanitizeChatMode` → briefing; the selected mode is stored per session on the roster (`SavedMeta.mode`, only alongside `kind:'chat'`, whitelisted to `CHAT_MODES`) and survives an app relaunch. There is no user-settable mode default: a fresh chat is `basic`.
- [ ] **20 · Changing mode mid-session is honest and lossless** — it respawns the conversation with `--resume` under the new briefing (the transcript is kept) and the menu says so in one line. **The respawn preserves the session's model (`spawn` position 6), effort (position 10) and permission mode** — a mode switch must not silently reset the picker. The same fix applies to the pre-existing "Session ended → Resume" path, which drops both today.
- [ ] **21 · Plan → Develop opens a NEW session, and never escalates** — a `dream-actions` `{"action":"develop","id":"<slug>"}` button mints a prompt token (`POST /api/agent/prompt`), spawns a fresh chat with `mode=develop` carrying the slug, inherits the plan session's model and effort, places the tab at the plan tab's index, and closes the plan tab. Spawn precedes close, so the pane never empties. **The Develop session runs under `auto`, never `bypass`, regardless of the vault's remembered permission mode** — asserted with the remembered mode set to `bypass`. No in-place `/clear` variant exists.
- [ ] **22 · The usage popover shows three nested bars — context, 5-hour session, weekly** — read from `~/.claude.json`'s `cachedUsageUtilization` via `GET /api/agent/usage-limits`. Each bar carries its percent and, for the timed windows, when it resets.
- [ ] **23 · Absent, stale and rolled-over readings render nothing** — no entry at all (no file, no key, malformed JSON, a non-finite percent, an unparseable `resets_at`) means that bar is absent, not zeroed. A reading older than 6 h is hidden; a reading whose `resets_at` has already passed is hidden; between 30 min and 6 h it renders with an "as of HH:MM" label. `readUsageLimits` never throws on any of six malformed fixtures.
- [ ] **24 · Weekly is one bar, and it is the binding one** — `seven_day` normally; a `weekly_scoped` entry replaces it **only** when its percent is higher, and then its model name is shown in the title ("Weekly · Fable"). Two near-identical weekly bars are never drawn.
- [ ] **25 · The usage route is account-scoped, not session-scoped** — `/api/agent/usage-limits` is vault-agnostic, polled once at 60s regardless of how many panes are open, and answers 200 with an empty list (never 403, never 500) off-desktop.
- [ ] **26 · The develop action compiles and renders** — `ACTION_GLYPH` gains a mono glyph for `develop`, so `Record<ChatActionKind, string>` stays exhaustive and the button draws like every other action.
- [ ] **27 · The `url` action is NOT widened** — it remains https-only. A `{"action":"url","url":"http://localhost:5173"}` button is dropped, asserted explicitly. The loopback carve-out exists only for pin facts (D2).
- [ ] **28 · Both `ChatMode` declarations agree** — a test asserts `CHAT_MODE_ROWS.map(r => r.id)` equals the server's `CHAT_MODES`, and both carry the MIRRORED comment.
- [ ] **29 · Every wave builds green** — `npm test` and `npm run build` pass after each wave in isolation. In particular `mode`/`onModeChange`/`shelved` are optional with safe defaults when introduced in wave 2, before `ChatPane` wires them in wave 3.

### 3.2 — Refinements to `two-new-agent-actions-pinned-session-facts-…` (D2)

**No existing criterion is weakened, and none is re-instrumented.** M1's "a test asserts the shelf's geometry is byte-identical at scroll-top, mid-scroll and scroll-bottom" is satisfied **as written** by a browser-driven verify script in the repo's existing Chromium harness (`scripts/verify/chat-shelf-ui.mjs`, the `dream-actions.mjs` pattern; `chat-scroll.mjs:423` already holds a row to the pixel). Everything below is an addition.

- [ ] **M1.7 · The empty shelf renders nothing** — no tags and no row ⇒ `PinShelf` returns `null`. It never contributes a zero-height strip or a stray border.
- [ ] **M1.8 · The dock seam is one object** — with an open row, `.pin-shell.has-rows` carries the 12px top corners and no bottom border while `.chat-cmp-card.is-shelved` squares its top corners. At rest (tag line only) the composer keeps its full radius.
- [ ] **M1.9 · The shelf has no scroll input at all** — a structural test asserts `PinShelf.tsx` and `useShelf.ts` contain no `scroll` / `scrollTop` / `onScroll` / `IntersectionObserver` token, and that `<PinShelf` is mounted in `ChatPane.tsx` after `.chat-transcript` closes. *(Defence in depth alongside the browser geometry assertion — a component that cannot observe scroll cannot react to it.)*
- [ ] **M1.10 · The tag-count cap is enforced and loud** — `layoutShelf` caps the tag line at `MAX_TAGS_PER_LINE` before the component's measured width fold, moves the excess to `overflowTags` with a notice, and both counts sum into the visible `+N`. The cap is about count, the fold is about width, and neither drops a tag.
- [ ] **M2.8 · Session facts are server-derived and not dismissable** — branch and the worktree marker come from `GET /api/agent/session-facts` (`git symbolic-ref --short HEAD`; worktree via `--git-common-dir` ≠ `--absolute-git-dir`, `mainRoot = dirname(commonDir)`) and carry no `×`. The dev-server port is an AGENT-pinned fact with a loopback `url`, because no local source can attribute a listening port to a session. Both appear on the same tag line.
- [ ] **M2.9 · The loopback carve-out is post-parse, and its accept list is deliberate** — `sanitizeLoopbackUrl` compares the WHATWG-normalized hostname against exactly `localhost` / `127.0.0.1` / `[::1]`. It therefore **accepts** the normalizing spellings `http://127.1`, `http://0177.0.0.1`, `http://0x7f000001`, `http://①27.0.0.1` and `http://127。0。0。1` — each asserted to yield hostname `127.0.0.1`, which is safe by construction because the OS opener resolves the same normalized host. It **rejects** `http://localhost.evil.com`, `http://127.0.0.1.evil.com`, `http://user:pass@localhost/`, `http://evil.com#@localhost`, `//localhost`, `javascript:`, and — explicitly, by its own post-parse check — `http://0.0.0.0`, because it is not loopback yet routes there on several OSes.
- [ ] **M2.9a · A pinned URL is an address, not a payload** — `search` and `hash` are stripped, mirroring `sanitizeImageSrc`, and a notice says so when anything was removed.
- [ ] **M2.9b · The carve-out is pin-facts-only** — `chatActions.ts`'s `url` action is untouched and stays https-only (see D1 criterion 27). The narrower blast radius is the point.
- [ ] **M2.9c · The destination is visible before the click** — `.pin-chip.is-link` carries `title={fact.url}` and an `aria-label` naming the URL.
- [ ] **M2.10 · Dismissal is a removal, not a tombstone** — dismissing a pin removes it from state and from `pinStore`; a later message re-sending the same `id` re-creates it (the agent re-asserting), and no other pin is reordered, disturbed or resurrected.
- [ ] **M2.11 · The store is vault- AND conversation-scoped, and refuses an unscoped write** — `pinStoreKey(vault, conversationId)` is hex-encoded per part (reusing `checklistStore`'s `labelPart`); every export **no-ops on a falsy vault or conversation id** rather than collapsing onto a `labelPart('')` key. `sweepExpiredPins` touches only keys under `PIN_PREFIX`. TTL 7 days, debounced writes at 300ms.
- [ ] **M2.12 · Eviction is loud** — past `MAX_PINS_PER_CONVERSATION` the oldest entries are evicted and the count is reported on the tag line; nothing disappears silently. A tag label past `MAX_TAG_LABEL_CHARS` is clamped **with a notice**, never truncated in silence.
- [ ] **M2.13 · Pin prose is sanitized** — a pin's `detail` renders through `MarkdownPreview` (DOMPurify); `PinShelf.tsx` contains no `dangerouslySetInnerHTML`.
- [ ] **M2b.6 · Expansion moves nothing below it** — a browser assertion: `.pin-tags` and `.chat-cmp-card` have identical `boundingBox().y` between a pin's collapsed and expanded states, at 740px and 470px.
- [ ] **M2b.7 · The 40% cap is measured against the real pane** — the shelf's ResizeObserver writes `--pin-detail-max: 0.4 × .chat-pane` height; `34vh` remains only as the pre-measurement fallback. (`cqh` is unavailable: `.chat-pane` declares no container, and adding block-axis containment would collapse its flex height.)
- [ ] **M3.8 · The progress row reads the LOCAL task file, not the task backend** — `_dream_context/state/<slug>.md` via `readSection('Acceptance Criteria')` + `countCheckboxes`, so the number matches `tasks doctor` even when the project syncs to ClickUp or GitHub.
- [ ] **M3.9 · Progress wins the row slot; the pin it displaces demotes, it does not close** — the displaced pin becomes a `⌃` tag and promotes back when the run ends.
- [ ] **M3.10 · The run's end is observable** — when the route reports `all-done` **and** the session is idle, the progress entry is removed: the row closes, the tag line does not move. While the run is still live, `all-done` renders 100% **with** the loud notice (both M3 bullets hold at once).
- [ ] **M3.11 · The slug arms are unambiguous** — a malformed/traversal slug is **HTTP 400 `invalid_slug`** and never reaches the filesystem; a well-formed slug with no file is **HTTP 200 `state:'unknown-slug'`** with a notice. Both routes take `contextRoot: string | null` with an early empty-shape return and both carry the `isDesktop()` gate.
- [ ] **X.4 · The shelf never renders inline** — `ChatViews`' switch returns `null` for `pin` and `progress`; their notices still render in the transcript under the existing degradation contract.
- [ ] **X.5 · The briefing never demonstrates a percent** — the lockstep test asserts no `percent`/`pct`/`done`/`total` key appears in any `progress` example, so "derived, never asserted" is mechanically pinned, not just documented.
- [ ] **X.6 · Integration wiring lands awake** — `skill/SKILL.md` (capability row **with the surface gate**), the reference section (schemas, caps, weight semantics, loopback rule, the `develop` action, the three modes), the goal-skill agent contracts, and `dreamcontext update` — all in the same cycle, per `feature-integration-pattern.md`.

---

## (5) Full corrected validation plan

**Method (Phase 6, clarified).** vitest unit tests for every pure module + `scripts/verify/` scripts against the real server — **including the repo's existing Playwright/Chromium harness**, which `@playwright/test` (devDependency, package.json:81) and 16 of 19 existing verify scripts already use — plus a short manual visual checklist for the owner. v1's "Playwright is not available" premise was wrong and is retracted; every criterion it caused me to downgrade is restored.

### 5.1 Unit tests (vitest, `npm test`, plain-Node environment)

| File | Asserts | Criteria |
|---|---|---|
| `tests/unit/agent-composer-model-menu.test.ts` *(new, D1-A)* | `splitModels` keeps the current model primary even when it's an "other"; `modelNoteFor` family-matches a full CLI id and returns `null` for an unknown one; `effortIndex`/`effortAt` clamp at both ends and never return `-1`; `usageLimits(ctx, null, now)` returns context only; a limit with `resetsAt <= now` is absent; a response older than `USAGE_MAX_AGE_MS` yields context only; one between 30 min and 6 h yields `staleAsOf ≠ null` | D1 · 15, 22, 23 |
| `tests/unit/claude-usage.test.ts` *(new, D1-B)* | The live `cachedUsageUtilization` sample verbatim → session 20% + weekly 47% with parsed `resetsAt`; `weekly_scoped` at 44 is **folded away**; the same sample with scoped at 55 → weekly becomes 55 with `scope:'Fable'`; six malformed fixtures (absent file, absent key, `"{"`, `percent:"20"`, `percent:140`, `resets_at:"soon"`) each → `{limits:[], fetchedAtMs:null}` and **no throw**; `UsageLimitWire` matches the client mirror field-for-field | D1 · 22, 23, 24 |
| `tests/unit/chat-modes.test.ts` *(new, D1-D)* | `sanitizeChatMode` maps `null`/`''`/`'JARVIS'`/`'plan; rm -rf'`/`'jarvis'` → `'basic'` and passes `plan`/`develop`; `modeBriefing('basic')===''`; the develop briefing contains a worktree permission **only** when `worktreeAllowed` and an explicit prohibition otherwise (all four combinations); the plan briefing names the `develop` action | D1 · 17, 18 |
| `tests/unit/chat-mode-mirror.test.ts` *(new, D1-C)* | `CHAT_MODE_ROWS.map(r => r.id)` deep-equals the server's `CHAT_MODES`; both files contain the MIRRORED comment | D1 · 28 |
| `tests/unit/agent-ui-settings.test.ts` *(extend, D1-E3)* | `coerceAgentSettings` rejects a shell-metacharacter `chatDefaultModel` and an off-list `chatDefaultEffort`, both → `''` | D1 · 13 |
| `tests/unit/agent-sessions-roster.test.ts` *(extend, D1-E1)* | `coerceMeta` round-trips `mode` only for a known `CHAT_MODES` value **and** `kind:'chat'`; drops it otherwise | D1 · 19 |
| `tests/unit/chat-actions.test.ts` *(extend, D1-E2)* | `develop` accepted with a safe slug; dropped for `''`, a 65-char slug, `a/b`, `../x`; **`url` rejects `http://localhost:5173`** and every other non-https target, and still accepts `https://` — the narrowed design asserted as correctness, not omission. *(No loopback cases here — they moved to `chat-view-pin.test.ts`, C4.)* | D1 · 26, 27 |
| `tests/unit/chat-composer-height.test.ts` *(unchanged, must stay green)* | `composerBodyHeight` bounds are byte-identical after the redesign | D1 · 16 |
| `tests/unit/chat-view-pin.test.ts` *(new, D2-A)* | **`sanitizeLoopbackUrl` accept table** — `http://localhost:5173`, `http://127.0.0.1:3000`, `http://[::1]:8080`, `http://127.1`, `http://0177.0.0.1`, `http://0x7f000001`, `http://①27.0.0.1`, `http://127。0。0。1` each return a URL whose hostname is exactly `localhost`/`127.0.0.1`/`[::1]`. **Reject table** — `http://localhost.evil.com`, `http://127.0.0.1.evil.com`, `http://user:pass@localhost/`, `http://evil.com#@localhost`, `//localhost`, `javascript:alert(1)`, `http://0.0.0.0:5173`. **Strip** — `http://localhost:5173/x?tok=1#f` → `http://localhost:5173/x` with `strippedQuery:true`. `validatePin`: id grammar, `weight` default + notice, facts capped with a notice, **label clamped at `MAX_TAG_LABEL_CHARS` with a notice**, a rejected `url` drops the link but keeps the label, `ledeClamped` stripped from author input, lede/detail clamped with notices. `validateProgress`: slug grammar; an agent-supplied `percent`/`pct`/`done`/`total` dropped **with** the notice | D2 M2.9, M2.9a, M2.12 · M3 (derived) |
| `tests/unit/shelf-model.test.ts` *(new, D2-A)* | `layoutShelf` never returns more than one row for any input (20 row-weight pins → 1 row + 19 demoted tags); **the tag line is capped at `MAX_TAGS_PER_LINE` with the excess in `overflowTags` and a notice**; `effectiveWeight` demotes a `row` with no detail and a tag-sized lede; `clampLede` marks a clamp; `foldAt` folds at the right index and the folded count is non-zero; `foldViews` updates in place by id and reports `evicted` past the cap; server facts sort first and are `dismissable:false` | D2 M1 (ceiling, overflow, resting), M1.10, M2 (weight, in-place), M2b (clamp) |
| `tests/unit/pin-store.test.ts` *(new, D2-A)* | Vault A and vault B with the same pin id do not collide; **`readPins('', id)` → `[]` and `writePins('', id, [x])` writes nothing** (the `labelPart('')` hole); a tampered envelope reads as absent; `sweepExpiredPins` drops expired pin keys and **leaves a `dc.checklist.*` key untouched**; the write is debounced | D2 M2 (survive reload) · M2.11 |
| `tests/unit/task-progress.test.ts` *(new, D2-B)* | `firstUnticked` returns the first `- [ ]` with emphasis stripped, `null` when all ticked; the handler's states — 11 criteria / 7 ticked → `percent:64, state:'ok'`; zero criteria → `percent:null, state:'no-criteria'` + notice; all ticked → `state:'all-done', now:null` + notice; **missing file → HTTP 200 `unknown-slug`**; **`../../etc/passwd`, `''`, `a/b` → HTTP 400 `invalid_slug`, no filesystem access**; `contextRoot: null` → empty shape, no throw | D2 M3, M3.11 |
| `tests/unit/session-facts.test.ts` *(new, D2-B)* | In a temp repo: branch reported; `worktree:false`; after `git worktree add`, from the worktree: `worktree:true` and `mainRoot` = the original root; a non-repo dir → all-null, `isRepo:false`, no throw; **two calls inside `SESSION_FACTS_TTL_MS` fork git once** (the concurrent-pane case), and a call past the TTL re-reads | D2 M2.8 |
| `tests/unit/chat-surface-lockstep.test.ts` *(extend, D2-A)* | The existing assertions stay green with five `VIEW_TYPES` (five in the lockstep describe, three in the surface-gate describe), plus the new no-percent lock | D2 X.2, X.5 |
| `tests/unit/chat-shelf-placement.test.ts` *(new, D2-C)* | `<PinShelf` appears in `ChatPane.tsx` after `.chat-transcript` closes; `PinShelf.tsx` + `useShelf.ts` contain no `scroll`/`scrollTop`/`onScroll`/`IntersectionObserver` token; `PinShelf.tsx` contains no `dangerouslySetInnerHTML` | D2 M1.9, M2.13 |

### 5.2 HTTP + WebSocket verify scripts (real server, no browser)

**`scripts/verify/chat-modes.mjs`** *(new, D1-D — `past-chats.mjs` setup + a scripted `claude` stand-in that echoes its `--append-system-prompt-file` contents back; drives the chat WS with the root `ws` dependency, package.json:78)*
1. `mode=basic` → the echo is exactly `CHAT_SURFACE_BRIEFING`. → D1 · 17
2. `mode=plan` → the echo contains the planning half **and** the `develop` action. → D1 · 17, 21
3. `mode=develop` with `brainRepo.mode:'in-tree'` and no linked repo → the echo **forbids** worktrees. → D1 · 18
4. Same with `brainRepo.mode:'full-repo'` → the echo **permits** them. → D1 · 18
5. `mode=jarvis` and `mode=%3Brm` → the echo is the basic briefing. → D1 · 17
6. `POST /api/agent/prompt` → token → upgrade with `sessionId=<fresh>&mode=develop&promptToken=<t>` → the stand-in receives the kickoff prompt naming the slug as its first user frame. → D1 · 21
7. `GET /api/agent/usage-limits` with a fixtured `~/.claude.json` → session 20 / weekly 47, `fetchedAtMs` set; with the key removed → `{limits:[], fetchedAtMs:null}`; without `DREAMCONTEXT_DESKTOP` → **200 with an empty list, never 403/500**. → D1 · 22, 23, 25
8. `GET /api/agent/model-config` → every `models[]` entry carries a numeric `priceIn`. → D1 · 9

**`scripts/verify/chat-shelf.mjs`** *(new, D2-B — HTTP only, `past-chats.mjs` pattern)*
1. Fixture task, 11 criteria / 7 ticked → `{percent:64, done:7, total:11, state:'ok'}`, `now` = the 8th criterion, `last` = the newest changelog bullet. → M3
2. Tick an 8th on disk, re-GET → `73`, `updatedAt` advanced. → M3 (refreshes from disk)
3. Zero-criteria task → `{percent:null, state:'no-criteria', notice ≠ null}`. → M3
4. All-ticked task → `{percent:100, state:'all-done', now:null, notice ≠ null}`. → M3
5. Well-formed missing slug → **200 `unknown-slug`**; `slug=../../etc/passwd`, `slug=`, `slug=a/b` → **400 `invalid_slug`**. → M3.11
6. `GET /api/agent/session-facts` → branch matches `git symbolic-ref`, `worktree:false`, `mainRoot:null`. → M2.8
7. `git worktree add` a second checkout, restart the server rooted there → `worktree:true`, `mainRoot` = the original. → M2.8
8. Server without `DREAMCONTEXT_DESKTOP` → **both** routes answer the empty shape, never a 500. → M3.11

### 5.3 Browser verify scripts (real server + real Chromium, `dream-actions.mjs` pattern)

**`scripts/verify/chat-composer-ui.mjs`** *(new, D1-E1 — light/dark, 740px and 470px)*
1. The toolbar renders exactly `.chat-cmp-modeltrigger` ×2, `.chat-cmp-iconbtn`, `.chat-cmp-usagebtn`, `.chat-cmp-send`; `.chat-cmp-pill` / `.chat-cmp-readout` / `.chat-cmp-ctxcard` count 0. → D1 · 9
2. The toolbar's `boundingBox().height` is unchanged between 740px and 470px — it never wraps. → D1 · 16
3. Each trigger opens its menu; opening a second closes the first; Esc closes only the menu; an outside click closes. → D1 · 12
4. The mode menu has 4 rows, J.A.R.V.I.S is `disabled` with a "Soon" badge, and contains **no** `.chat-cmp-setdefault`; the model menu **does**. → D1 · 13, 17
5. Dragging the effort slider moves the active tick through all five levels. → D1 · 15
6. The usage popover renders 3 `.chat-cmp-usagebar` with the fixture present; with `cachedUsageUtilization` removed it renders exactly 1 (context) and **zero empty bars**. → D1 · 22, 23
7. `.chat-cmp-skillchip` and any "Skills" trigger count 0; the placeholder contains `"/"`; typing `/` still opens `.chat-cmp-slash`. → D1 · 14
8. Selecting Develop: the conversation respawns, the trigger reads "Develop", **and the model + effort triggers read the same values as before the switch**. → D1 · 20
9. A `develop` action button renders with its glyph; clicking it opens a second tab and closes the first, with the new tab's permission chip reading **`auto`** while the vault's remembered mode is `bypass`. → D1 · 21, 26
10. At 470px the mode trigger keeps its name and drops the permission word; at 380px the model trigger drops the effort word and Send's box is unchanged. → D1 · 16

**`scripts/verify/chat-shelf-ui.mjs`** *(new, D2-C — 740px and 470px; **dark only for geometry** (a box is theme-independent), both themes for the visual states)*
1. **rest** — `.pin-tags` present with the branch chip; `.pin-row` count 0; `.pin-shell.has-rows` count 0; `.chat-cmp-card.is-shelved` count 0. → M1 (resting state), M1.7, M1.8
2. **active** — a progress pin opens exactly one `.pin-row`; `.pin-track-fill` width matches the reported percent; `.pin-now` names the in-flight criterion. → M3
3. **ceiling** — after sending five row-weight pins, `.pin-row` count is still ≤ 1 and `.pin-chip.is-demoted` count is 4. No sequence produces a third row. → M1 (hard ceiling), M3.9
4. **scroll invariance (the restored geometry assertion)** — capture `boundingBox()` for `.pin-tags` and `.chat-cmp-card` at scroll-top, mid-scroll and scroll-bottom of a long conversation; all three boxes are identical. → M1 bullet 2
5. **M2b y-invariance** — capture the same two boxes with a long pin collapsed and expanded; `y` identical in both. The expanded `.pin-body` height ≤ 0.4 × `.chat-pane` height and its `scrollHeight > clientHeight` when the detail is long. → M2b, M2b.6, M2b.7
6. **one at a time** — opening a second pin collapses the first (`.pin-body` count is always ≤ 1). → M2b
7. **overflow** — with 20 tags, `.pin-chip.is-more` reads `+N`; clicking opens `.pin-fold` **above** the tag line, and `.pin-tags`' `y` is unchanged; the folded count matches the hidden tags. → M1 (overflow), M1.10
8. **close** — when the progress task's criteria are all ticked on disk and the turn ends, `.pin-row` count returns to 0 and `.pin-tags`' `y` is unchanged. → M3.10
9. **loopback chip** — `.pin-chip.is-link` carries `title` equal to the pinned URL; a pin fact with `http://evil.com` renders as a plain chip with no link affordance. → M2.9, M2.9c
10. **persistence** — reload the page; the same pins are present with the same ids. Dismissing one leaves the others' `x` positions unchanged. → M2 (survive reload), M2.10
11. **coexistence** — the goal-skill live panel (`.chat-live-rail`) still renders above the shelf and its poll still resolves. → cross-cutting
12. Screenshots of all four states × both themes × both widths written to `VERIFY_SHOTS` for the owner's checklist.

### 5.4 Manual visual checklist (owner)
The browser scripts assert geometry and state; this pass is for judgement the scripts cannot make. Each item at **740px and 470px**, **dark and light**.

1. The composer reads as one calm card — the ring, the two triggers and the send disc feel like one row, not a tray of parts.
2. Each menu's copy is right: model insights read as guidance, the permission note matches the selected mode, the mode-switch reload line is reassuring rather than alarming.
3. The usage popover's three bars read as one stack (the Apple-Health intent), and the "resets in Xh" text is legible at both widths.
4. The four shelf states from the design doc match the reference screenshots produced in 5.3 §12 — clamp `…` vs authored, the `⌃` demote chip, the `+N` fold, the accent spent only on the port chip / progress fill / open caret.
5. Scroll a long conversation top→bottom: the shelf and composer feel nailed down (the script proves the pixels; you're checking it *feels* stable, not just measures stable).
6. A `http://localhost:PORT` chip opens the right page in the OS browser.
7. Plan mode end-to-end: it asks real questions, ends with a task doc, and "Go to development" lands you in a Develop session that already knows the task.
