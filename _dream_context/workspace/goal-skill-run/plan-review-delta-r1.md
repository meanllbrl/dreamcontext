# Plan review round 1 — deltas to fold into plan v2

Three clean reviewers (pragmatist / critic / security) returned NEEDS_WORK. Every finding
below was verified against the real code by the reviewer that raised it. Revise the plan
to resolve ALL of them, and re-emit ONLY the changed sections (plus the full corrected
dependency map and the full corrected acceptance-criteria section, since both are copied
verbatim into task docs).

## R1 — A1 is RESOLVED: the 5h/weekly limit source EXISTS (orchestrator verified on disk)

`~/.claude.json` → key `cachedUsageUtilization` holds (live sample, 2026-08-23):

```json
{ "fetchedAtMs": 1787493899524,
  "utilization": {
    "five_hour": { "utilization": 20, "resets_at": "2026-08-23T17:20:00+00:00" },
    "seven_day": { "utilization": 47, "resets_at": "2026-08-25T03:59:59+00:00" },
    "limits": [
      { "kind": "session",       "group": "session", "percent": 20, "severity": "normal", "resets_at": "…", "is_active": false },
      { "kind": "weekly_all",    "group": "weekly",  "percent": 47, "severity": "normal", "resets_at": "…", "is_active": true },
      { "kind": "weekly_scoped", "group": "weekly",  "percent": 44, "severity": "normal", "resets_at": "…",
        "scope": { "model": { "display_name": "Fable" } }, "is_active": false } ] } }
```

Overturn P9: the usage popover DOES ship the nested bars (context / 5h session / weekly —
the owner's Apple-Health-style request). Plan the server side: a reader for
`cachedUsageUtilization` (tolerate absent key, absent file, malformed JSON, and staleness —
surface `fetchedAtMs` so the client can label stale data or hide it; "show what's found,
hide what isn't" still governs), exposed via a route (extend `session-stats` or add
`/api/agent/usage-limits` — your call, justify), feeding `UsageMenu`. NOTE the shape is
PERCENT-based (0-100) + `resets_at`, not used/limit tokens — adjust the `UsageLimit`
interface accordingly (this also answers pragmatist N2: the interface should model what
the source provides, not a hypothetical). `weekly_scoped` (per-model) may be shown as a
third bar or folded into weekly — your call, justify briefly. Reading `~/.claude.json`
follows the same pattern as the existing settings read in `buildModelConfig`.

## R2 — Security findings (all three blocking)

S1. `sanitizeLoopbackUrl` self-contradiction: WHATWG `URL` normalizes `127.1`,
`0177.0.0.1`, `0x7f000001`, `①27.0.0.1`, `127。0。0。1` → hostname `127.0.0.1`, so a
parse-then-compare gate ACCEPTS them while the plan/criteria/tests list them as rejects.
Resolution: accept post-parse normalized loopback DELIBERATELY — move `127.1` /
`0177.0.0.1` etc. to the ACCEPT list in M2.9 and the tests, and document in the doc
comment that normalization-to-loopback is safe by construction. Keep rejecting `0.0.0.0`
EXPLICITLY (post-parse hostname check) and say why (routes to loopback on several OSes),
plus userinfo, `//`-relative, and non-http(s) schemes.

S2. Harden + narrow the carve-out:
  (a) strip `search` and `hash` in `sanitizeLoopbackUrl`, mirroring `sanitizeImageSrc`
      (chatViewSpec.ts:140-170), with a notice when stripped;
  (b) the carve-out applies to PIN FACTS ONLY — drop the §2.2 widening of
      `chatActions.ts`'s `url` action; it stays https-only (the goal never asked for it);
  (c) show the destination: `.pin-chip.is-link` gets `title={fact.url}`; and since §2.2
      is dropped, ActionRow changes for `url` are no longer needed — but ActionRow IS
      still touched for the `develop` glyph (see P-note 1 below).
  Add criteria asserting (a)-(c).

S3. `handoffToDevelop` privilege posture: in `spawn`, `explicitBypass=false` makes the
leading `false` DEAD — the fresh Develop session would inherit the remembered permission
mode (possibly bypass) from an agent-authored button click. Pin it: pass
`explicitBypass=true, bp=false` so a handoff can never escalate (matches the documented
delegate exemption at AgentSurface.tsx:555-565). AC 21 must assert the Develop session
lands in `auto`, never bypass, regardless of the remembered mode.

Security non-blocking to fold in:
  s-n1. `ActionRow.tsx:15` `ACTION_GLYPH: Record<ChatActionKind, string>` — adding
        `'develop'` breaks compilation; add `ActionRow.tsx` to D1-E2's owned files with a
        glyph.
  s-n2. `SAFE_SLUG_RE` matches `'..'` — fix the comment (slug only reaches a prompt
        string, but don't claim traversal-safety from the regex) and add a 64-char cap.
  s-n3. `pinStore`: no-op (or throw) on falsy vault (the `labelPart('')` hole), and scope
        `sweepExpiredPins` to `PIN_PREFIX` only.
  s-n4. task-progress route: the UNSAFE-slug arm answers HTTP 400 (not a 200
        `unknown-slug` shape) — make the route spec + tests unambiguous.
  s-n5. Pin `detail` renders through `MarkdownPreview` (DOMPurify) — name it in §2.13;
        never a new innerHTML path.

## R3 — Pragmatist findings (all four blocking)

P1. Wave-2 build red: D1-C makes `mode`/`onModeChange` REQUIRED Composer props but the
only call site (`ChatPane.tsx:1649-1668`) is wired in wave 3 under strict TS. Fix: D1-C
declares `mode?: ChatMode` (default `'basic'`) and `onModeChange?: (m) => void` (default
no-op); D1-E1 wires them in w3. State the build-green-between-waves rule in the map notes.

P2. D2 cross-cutting criterion 3 (a `scripts/verify/` script driving resting state, row
open/close, ceiling, scroll-invariance against the real server) has NO owner — and the
"no Playwright" premise is FALSE: `@playwright/test` is a devDependency and 16 of 19
existing verify scripts drive a real browser (e.g. `dream-actions.mjs:20-22`). Add
`scripts/verify/chat-shelf-ui.mjs` in the literal `dream-actions.mjs` pattern covering
those four properties (this is the repo's OWN harness, so it fits the agreed validation
method; Phase-6 method is hereby clarified: verify scripts MAY use the existing
Playwright harness). Also correct A6's conclusion accordingly, and add the same-pattern
UI coverage for the composer menus if cheap (your call). Keep M1.2a (structural test) —
it is defence in depth, not redundant.

P3. Mode-switch respawn silently drops model/effort: `resumeChatSession` / `changeChatMode`
must pass `cs.model` / `cs.effort` (positions 6 and 10). Criterion 20 gains: model,
effort and permission mode are preserved across the mode respawn.

P4. Dead caps: `MAX_TAG_LABEL_CHARS` and `MAX_TAGS_PER_LINE` are declared but never
enforced. Enforce both with notices (label clamp in `validatePin`; tag-count clamp in
`layoutShelf` before the measured fold) and assert in the named tests — or delete them
and rewrite the criterion; prefer enforcement (the criterion names tags-per-line).

Pragmatist non-blocking to fold in:
  p-n1. `chatDefault*` read only inside the `kind === 'chat'` arm of `spawn` — say so.
  p-n2. (superseded by R1 — `UsageLimit` now models the real percent-based source.)
  p-n3. `SHELF_DETAIL_MAX_VH`: use `cqh` against the pane container (the surface already
        uses container queries), matching "40% of the PANE height" as written.
  p-n4. `SESSION_FACTS_TTL_MS = 5_000` vs a 15s poll — raise the TTL to ≥ poll interval
        or restate the justification (concurrent panes).
  p-n5. Extract the shared dismiss/overlay effect (pushOverlay/popOverlay/isTopOverlay +
        outside-pointerdown) from `SkillPickerPopover` instead of re-implementing it in
        `useAnchoredMenu`.

## R4 — Critic findings (all four blocking)

C1. `ContextUsage` orphaned: it is declared ONLY in `ContextReadout.tsx:33`, which D1-C
deletes in wave 2, yet D1-A's `usageLimits` contract (wave 1) references it. Fix: declare
`export type ContextUsage = { used: number; limit: number; pct: number }` in
`agentComposer.ts` as part of D1-A's contract (natural home — `CONTEXT_TIGHT_PCT` lives
there), and note in §1.5/§1.17 that D1-C imports it from there. (Reconcile with R1: the
percent-based `UsageLimit` reshape happens in the same file, same task.)

C2 + C3 (merge with R3/P2 — one resolution): the "Playwright unavailable" premise is
false (`@playwright/test` devDependency; 16/19 verify scripts launch Chromium;
`verify/chat-scroll.mjs` already holds a row "to the pixel" across mutations — the exact
harness M1 bullet 2 needs). The Phase-6 method is hereby CLARIFIED: verify scripts use
the repo's existing Chromium harness. Consequences to plan:
  - `scripts/verify/chat-shelf.mjs` (or a sibling `chat-shelf-ui.mjs`) goes browser-driven
    in the `dream-actions.mjs` pattern and drives ALL of: the resting state, the row
    opening and closing, the ceiling, the scroll-invariance (`boundingBox()` on
    `.pin-tags` and `.chat-cmp-card` at scroll top/middle/bottom), AND the M2b assertion
    (tag line + composer `y` unchanged between a pin's collapsed and expanded states).
    Cover 740px and 470px; dark is enough for geometry (state which).
  - The HTTP-only checks 1-8 stay (they are good route coverage) — same script or split;
    your call.
  - M1.2a (structural token-scan test) STAYS as defence in depth; M1.2b (manual item)
    stays; the criterion's geometry assertion is RESTORED, not replaced.
  - Correct A6's consequence ("components covered by verify scripts + manual checklist"
    becomes true again).
  - §3.2's "no existing criterion is weakened" must be actually true after this revision.

C4. `tests/unit/chat-actions.test.ts` wave conflict: the loopback `url` assertions require
wave-4 code but the file is owned only by D1-E2 (wave 2). Fix per S2(b): since the
carve-out no longer touches `chatActions.ts`, the loopback URL cases move to
`tests/unit/chat-view-pin.test.ts` (D2-A, wave 4) against `sanitizeLoopbackUrl` directly;
`chat-actions.test.ts` keeps only the `develop` cases (wave 2) and asserts `url` REMAINS
https-only (including rejecting `http://localhost:5173` — now a correctness assertion of
the narrowed design).

Critic non-blocking to fold in:
  c-n1. §1.9's rationale is wrong (the lockstep scan greps the literal
        `CHAT_SURFACE_BRIEFING`, not `modeBriefing`) — keep the decision, fix the stated
        reason.
  c-n2. `ChatMode` exists client-side and server-side — add the repo's MIRRORED-comment
        convention plus a one-line test asserting `CHAT_MODE_ROWS` ids ==
        server `CHAT_MODES`.
  c-n3. Anchor slips to correct: `src/lib/git-sync/git.ts:123` (not `git.ts`),
        `SkillPickerPopover.tsx` is in `sleepy/` (not `sleepy/chat/`), `<ChatPaneHost>`
        at AgentSurface.tsx:2446 (not 2426).
  c-n4. Both new routes take `contextRoot: string | null` with an early null-return
        (pattern: `handleAgentGoalLive`, agent-terminal.ts:1456-1459), and BOTH get the
        `isDesktop()` gate so §5.2 check 8 holds for both.
  c-n5. §2.6's "four existing assertions" count is wrong (five + three in the surface-gate
        describe) — restate as "the existing assertions stay green".
