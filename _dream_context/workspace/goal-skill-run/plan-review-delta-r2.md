# Plan review round 2 — deltas for plan v3 (final amendment)

Round 2 confirmed: R1/S1/S2/P1-P4/C1-C4 all genuinely resolved. Four NEW blocking
findings (one found independently by two lenses) + notes. All fixes are fully
prescribed — apply them exactly; do not redesign anything else.

## B1 (critic + pragmatist, identical) — ChatViews.tsx breaks wave 4

`ChatViewItem`'s switch (ChatViews.tsx:60-68) is exhaustive with no default and no
trailing return; `noImplicitReturns` + `tsc -b` means widening `ChatViewSpec` in wave 4
(D2-A) leaves `npm run build` RED until D2-C (wave 5). Empirically confirmed (TS7030).
Fix: move `dashboard/src/components/sleepy/chat/ChatViews.tsx` into D2-A's owned files
(wave 4) with `case 'pin': case 'progress': return null;` landing in the same commit
that widens the union; re-point criterion X.4 to D2-A/wave 4; drop ChatViews.tsx from
D2-C's owned files (no remaining edit); update the lane-check line accordingly.

## B2 (security) — the permission display must show the SESSION's truth

The composer's permission indicator is currently fed the vault-wide remembered mode
(`AgentSurface.tsx:2464` `permissionMode={chatPermissionMode}` → ChatPaneHost →
ChatPane:1660 → Composer). ChatPane itself already computes the session truth at
ChatPane.tsx:709-714 (`conv.permissionMode ? conv.permissionMode === 'bypassPermissions'
: session.bypass`) and warns the prop "would mislabel a session". With the handoff fix
(auto spawn) inside a bypass-remembered vault, the new mode trigger would render
"bypass" for a session running `--permission-mode auto` — a lying security indicator.
Fix: (a) feed the mode trigger's permission word and the ModeMenu's segment from the
session-truth expression, not the remembered prop; add a criterion: the trigger shows
the SESSION's permission, not the vault default. (b) Re-target AC 21's assertion to
observable truth: the WS upgrade carries `bypass=0` for a handoff spawn AND
`chat-modes.mjs`'s scripted stand-in echoes its own `--permission-mode` argv (it already
echoes the briefing path) — assert `auto` there.

## B3 (security) — changeChatMode must not re-inherit the vault default

v2's corrected respawn call passes `explicitBypass=false`, so `cs.bypass` is discarded
and `chatPermissionModeRef.current` adopted — the first mode switch (or Resume) silently
raises an auto-spawned handoff session to bypass. AC 20 ("permission mode preserved")
and this code cannot both be true.
Fix: in `changeChatMode` (and the mode-preserving arm of `resumeChatSession`), pass
`explicitBypass=true, bp = cs.bypass` — `chatSession.ts:1333` keeps `session.bypass` in
lockstep with live `set_permission_mode`, so `cs.bypass` IS the session's current mode.
State explicitly which semantics the "Session ended → Resume" path keeps and make AC 20
say it. Add the criterion: "a session spawned under `auto` cannot be raised to `bypass`
by a mode switch or a resume — only an explicit user permission change can."

## B4 (security) — verify fixtures never touch the real ~/.claude.json

5.2 §7 / 5.3 §6 fixture a file that really holds oauthAccount/machineID/accountUuid/
spend. Fix, two pins: (a) §1.2b: `readUsageLimits(home?: string)` defaults to
`os.homedir()` (honours $HOME) — never `os.userInfo().homedir`; the route handler calls
it with NO argument (the param is a test seam only; no request-derived value reaches
it). (b) §5.2/§5.3: the scripts write `join(HOME, '.claude.json')` under their scratch
HOME (the `dream-actions.mjs:34,160` / `past-chats.mjs:34,146` env pattern) and an
explicit rule: no verify script ever reads or writes the real `~/.claude.json`.

## Notes to fold in (non-blocking, all cheap)

n1. `claude-usage.test.ts` asserts the wire shape at RUNTIME: `Object.keys(wire)` ===
    `['key','percent','resetsAt']` (+ optional `scope` as a STRING), and the serialized
    route body contains neither `accountUuid` nor `spend`.
n2. Anchor corrections, third attempt — write these EXACT numbers: `chatPanes.map` at
    AgentSurface.tsx:2445, `<ChatPaneHost` at :2446, `permissionMode={chatPermissionMode}`
    at :2464, model-authority at :2457-2458.
n3. Geometry assertions in chat-shelf-ui.mjs use the repo's own ±2px tolerance
    (chat-scroll.mjs:423-425 precedent), not exact equality.
n4. Criterion 25 reworded: "one poll per pane per 60s, deduped when concurrent — never
    per-claudeId at the 5s session-stats cadence" (TanStack dedupes only concurrent
    fetches; no singleton-poller requirement).
n5. P18: drop the "collapses its flex height" justification (the pane is abspos inset:0);
    keep the decision on its strong ground (no container exists + paneHeight() reuse).
n6. `useDismissOnOutside` extraction: add one manual-checklist line (or one browser-script
    assertion) that the TERMINAL composer's skill picker still opens/closes/Escs
    (AgentComposerBar consumes SkillPickerPopover).
n7. §1.2b documents: summary keys carry percent under `utilization` (not `percent`);
    `resets_at` may be null; reuse agent-terminal.ts:914's `readJsonSafe` pattern rather
    than a third JSON reader (export or mirror it deliberately).
n8. `sanitizeLoopbackUrl` doc comment: `http://[::ffff:127.0.0.1]` normalizes to
    `[::ffff:7f00:1]` and is REJECTED — fail-closed on purpose; do not "fix" it into the
    accept list without re-deriving the safety argument.
n9. §2.13 names `openExternalUrl` (desktop.ts:573-582) as `onOpenUrl`'s implementation
    (keeps the Rust-side scheme validator in the chain); note S2a's query strip also
    stops a pinned chip carrying `?vault=`/`?token=` at the dashboard's own port.
n10. chatActions.ts:9-10 header comment naming the three view types goes stale in wave 4 —
     D2-A touches that one comment line.
