---
id: "feat_t7P6EZZS"
type: "feature"
name: "opt-in-context-handoff"
description: >-
  Past ~300k tokens the agent is handed a note with its own numbers and told it
  may write its state into the task and continue in a fresh session — its own
  call, never forced. The note ESCALATES: firm from 300k, and from 650k it must
  hand off or tell the user why it didn't. `tasks handoff` records the request,
  desktop Chat rotates itself with /clear, and the next session opens on a
  HANDOFF banner naming the task. Off by default, per pane, remembered per vault
  per machine.
pinned: false
date: "2026-09-13"
status: "in_review"
created: "2026-09-13"
updated: "2026-09-13"
released_version: null
product: desktop
tags:
  - 'topic:context'
  - 'topic:agents'
  - 'topic:desktop'
  - 'topic:task'
  - 'layer:frontend'
  - 'layer:backend'
related_tasks:
  - >-
    opt-in-context-handoff-the-agent-is-told-at-200k-that-it-may-move-its-state-into-the-task-and-continue-in-a-fresh-session
  - composer-in-kullanim-paneli-mod-gostergesi-ve-baglam-halkasi-premium-bir-tasarima-gecer
---

## Why

Context is not paid for once. `cache_read` is **97.4% of billed input tokens**, so every turn re-reads the entire prefix and the bill is the *area under the context curve*. Measured on 120 real sessions of this vault (10,917 API calls): replaying the same work under a 200k reset bills **2.2–2.6x fewer input tokens** (~1.5x fewer dollars, same ratio in Max-plan quota burn) than letting the window grow to 1M. The threshold dominates — 150–250k is a flat optimum — while compact-vs-restart at an equal threshold is only a ~20% effect. Real sessions routinely climbed to 500–775k with **nothing telling the agent it was past the knee**, so a long build session silently paid two to three times for the same task.

The fix is a nudge, not a ceiling. And because the state has to go *somewhere* to survive the reset, the natural destination is the task file — which makes tasks richer and genuinely resumable as a side effect.

Full measurement, model parameters and raw data: `knowledge/context-ceiling-economics.md`.

## User Stories

- [x] As an agent past the knee, I want to be told my own context number and what it costs, so I can decide whether to carry my state into a fresh session.
- [x] As an agent, I want the choice to remain mine — an explicit "if the task is nearly done or moving context is not worth it, keep going" clause — so nothing forces a rotation mid-thought.
- [x] As an agent, I want one command (`tasks handoff`) to write my state into the task and record the request, so the handoff is a single atomic act rather than a ritual I might get wrong.
- [x] As a fresh session, I want a banner above the snapshot naming the task I am continuing, so my first act is reading the handoff rather than rediscovering it.
- [x] As a user in desktop Chat, I want the rotation to happen by itself at the turn boundary, so I never have to type `/clear` at the right moment.
- [x] As a user, I want the switch on the pane I am reading, not app-global, so turning it on in one vault does not switch it on everywhere.
- [x] As a user, I want the context gauge to SHOW where the threshold is, so "past the knee" is visible rather than a number I have to interpret.
- [x] As a team, I want it off by default and configurable in the vault, so nobody inherits a rotation policy they did not choose.
- [x] As an operator, I want sub-agents and headless automation runs excluded, so a fan-out or a scheduled job can never be hijacked by a pending handoff.

## Acceptance Criteria

- [x] `.config.json` `contextHandoff {enabled,nudgeAt,hardAt,remindEvery}` defaults `{false, 300000, 650000, 100000}` — the two thresholds ARE `CONTEXT_BAND_EDGES`; invalid values fall back and `hardAt` is clamped `>= nudgeAt`; `dreamcontext config context-handoff on|off [--nudge-at N] [--hard-at N] [--remind-every N]` round-trips and `config show` prints both. Ladders below 20k/10k are refused at the CLI write boundary.
- [x] With the feature on and main-chain context ≥ `nudgeAt`, the next Edit/Write (PostToolUse) or user prompt (UserPromptSubmit) injects the nudge via `additionalContext` exactly once, then again every `remindEvery` tokens. Disabled ⇒ zero output, zero extra work.
- [x] The nudge never fires inside a sub-agent — `agent_id`/`agent_type` on the payload (pinned against a real captured payload), `/subagents/` in the transcript path, or an `isSidechain` tail record all skip it.
- [x] `dreamcontext tasks handoff <slug> [note]` logs the note to the task changelog, sets the task `in_progress`, writes `state/.handoff-requests/<key>.json`, writes a partial session digest, and appends a `CompactionRecord {trigger:'handoff', context_tokens}`. It writes **no** global active-task pointer.
- [x] Desktop Chat: at the next main-chain result frame after a handoff record appears for the tab, the server stamps `actedAt`, sends `/clear` then the continue prompt as user frames, and shows a system notice; SessionStart fires with `source=clear` and the agent-session-map records the rotated id.
- [x] SessionStart banner printed before the snapshot on a tab match, or on `source=clear` without a tab for the newest unconsumed record < 15 min; a startup/resume session without a tab id never receives or consumes a record (automation-hijack test). `consumedAt` set once, never re-printed.
- [x] `contextTokensFromUsage` is the single formula (`computeSessionStats` imports it); `liveTranscriptPath` is shared between CLI and server; a 7-day prune covers `.context-watch/` and `.handoff-requests/` from SessionStart only; both dirs gitignored.
- [x] Per-pane toggle in the composer's usage popover, sending `setContextHandoff`; the server writes the pane's tab file and the state echoes back; the switch reflects server truth on resume via the augmented init.
- [x] Remembered per vault per machine: the last toggle is stored in `BrainLocalState.contextHandoffDefault` (gitignored `.brain-local.json`) and seeds every NEW pane at spawn (brain-local > `.config.json` > off) BEFORE the child starts. Turning it on in vault A leaves a new pane in vault B off.
- [x] Hook resolution order: per-tab file > `.config.json` `contextHandoff` > off. A `/clear` rotation keeps the pane's toggle (tab file keyed by pane) while the nudge ladder restarts (nudge state keyed by session_id).
- [x] The gauge shows the threshold: marker tick at `nudgeAt/limit`, lighter track beyond, warning-tone fill once past, and a matching notch on the composer ring. Design tokens only; the existing `/compact` button is untouched.
- [x] Docs per `feature-integration-pattern`: SKILL.md "Context handoff" section, `core/6.system_flow.md` hook row, CHANGELOG entry.
- [x] Live proof in this vault: the nudge fired in a real session at ~389k with correct next-rung math; `tasks handoff` recorded 388,283 tokens; the rotation and banner completed (`actedAt` + `consumedAt` both stamped); the fresh session measured **105,462** against the old session's **429,471** — **4.07x smaller, −75.4%** — using the shipped `lastMainChainContext`.
- [ ] **[open]** The gauge redesign (Health rings + ECO lamp, `1bf194ad`) has not been through a release cut; `released_version` is unset pending the owner's call.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-09-14]** **The first threshold is 300k, and it is the same number the gauge paints.** `CONTEXT_BAND_EDGES` moved to `src/lib/setup-config.ts` and IS the shipped ladder, mirrored in the dashboard under a drift test that asserts both halves (mirror ≡ owner, and the pair ≡ the nudge's thresholds) — because for one release the ring said "calm" to 350k while the nudge pushed from 200k. 300k over 350k was measured three ways, not chosen: the cost optimum is 200–250k (300k sits 5% above it, 350k 10%); a nudge is not a cap, so the effective cap is `threshold + lag` and at +50k lag 300k costs +10% while 350k costs +18%; and across 434 real sessions the noise rate is flat (29% vs 27%), so moving up silences 32 sessions of which 21 were the useful ones. The original "a normal session runs the whole first band" still holds — median peak 153k, p75 319k, so 71% of sessions never leave the calm band.
- **[2026-09-14]** **Two registers, because one register measured zero.** Six real sessions were nudged between 204k and 458k and requested ZERO handoffs; the mechanism fired correctly every time. The single note ended on "keep going and ignore this", which made declining the cheap default. FIRM now names the only two ways out and disqualifies "I am in the middle of something" BY NAME — that is what the `log` carries, and it was true of every session that ignored the old note. SEVERE (past `hardAt`) is imperative and grows the only tooth that does not break *agent-decided, never forced*: continue if you must, but **tell the user and say why**. The repeat cadence was deliberately NOT shortened — a message that doubles in frequency reads as broken rather than urgent.
- **[2026-09-14]** **The tab file is a SWITCH, not a ladder.** Nothing in the UI ever set a per-pane threshold, yet every `tab-<pane>.json` had one written at birth, which pinned ten live panes to a 200k ladder nobody chose the moment the vault's edges moved. `resolveHandoffFor` now takes only `enabled` from the pane and the thresholds from `.config.json` — re-pointing every existing pane with no migration — and the server re-resolves before echoing the toggle so a tuned vault cannot show one number and nudge on another.

- **[2026-09-13]** **The gauge became three concentric rings, not one zoned arc.** A single arc split into three bands (0–200k / 200k–500k / 500k–1M) was built first and photographed at true size: at 18px it read as a bullseye and 402k could not be told from 640k. Three rings, each filling its own 0–100% with its own tone (Apple Health's activity rings), need thickness and air — which is why the button grew to 28px, the smallest box measured in which the third ring is still a ring. Each track is tinted in its OWN ring's colour so an empty ring still says which band it stands for.
- **[2026-09-13]** **The handoff switch became an ECO lamp.** The popover was rejected three times for the same reason in different words ("çok text heavy", "ara altyazılardan uzaklaş", "ölü muhabbetleri var"), so the captions were removed rather than shortened a fourth time: a leaf, the word ECO, and what it does, all on the badge; the full sentence lives in the `title`. A car does not print a paragraph under its ECO lamp. Every popover selector is scoped under `.chat-cmp-usagemenu` after model/mode menus were confirmed unaffected in the real app.
- **[2026-09-13]** **`shouldRotateForHandoff(record) = !!record && !actedAt && !consumedAt`.** The original condition checked `actedAt` only, but the two stamps say different things: `actedAt` = *we* rotated (a latch against a `/clear` loop), `consumedAt` = the handoff was already delivered some other way (a manual `/clear`, or the resume banner on app restart). With only the first check, a record delivered by the banner queued a **second** rotation that `/clear`ed the session the user was actively working in. Observed exactly once in the real app across a server restart — a class of defect a scratch vault structurally cannot produce, because there the server is reborn every run.
- **[2026-09-12]** **Per pane, remembered per vault per machine — never app-global.** A pragmatist review blocked the `AgentSettings`/`agent-ui.json` version because it would have switched the nudge on in every vault on the machine, overriding a team that opted out in `.config.json`. `BrainLocalState.contextHandoffDefault` (gitignored, vault-scoped) is the memory; `.config.json` stays the vault default and the only switch for terminal/CLI sessions. Two panes toggling opposite ways: last toggle wins the vault default, each pane keeps its own tab file.
- **[2026-09-12]** **Agent-decided, never forced.** No hard ceiling, no server-forced compaction, no change to Claude Code's own auto-compact. Default OFF. Fresh session rather than compact-in-place. Out of scope: terminal/PTY automation (instruction + banner only), compact-in-place mode, and a global `.active-task` pointer — the last was removed after edge-case review because it raced across tabs and broke auto-sleep's hands-off union.
- **[2026-09-12]** **No eighth hook.** `npx dreamcontext` costs ~1.0s per hook call, so an all-tools PostToolUse would add a second to every tool call. The nudge rides the two hooks that already exist; nudge granularity is therefore "the next Edit/Write or user prompt", by design.
- **[2026-09-12]** **A tab-less session may claim a pending handoff only on `source=clear`** — never on startup/resume — so a headless automation run can neither receive nor consume a handoff meant for a human's pane.

## Technical Details

**`src/lib/context-watch.ts`** (new, ~700 lines) is the core:
- `contextTokensFromUsage(u)` = `input + cache_creation + cache_read + output` — extracted from `agent-terminal.ts` and imported back there, so CLI and server share one formula.
- `lastMainChainContext(transcriptPath, tail=512KiB)` reads only the file tail, walks backwards, skips `isSidechain === true`, first usage record wins, `null` on missing/parse error.
- `isMainChainHookInput(input)` — the sub-agent guard (path, `agent_id`/`agent_type`, sidechain tail).
- `shouldNudge(state, ctx, cfg)` = `ctx >= nudgeAt && (state == null || crossedIntoSevere || ctx >= state.lastNudgedAt + remindEvery)`; the escalation clause outranks the cadence so the crossing into `hardAt` is announced at the crossing. Per-session state in `state/.context-watch/<session_id>.json`, now carrying `lastTone`.
- `renderNudge(ctx, cfg, activeSlug)` — the note: tokens vs threshold, "every further turn re-reads all of it", the two commands, the explicit *you decide* clause, and the next reminder level.
- `pruneContextWatch(root)` — 7-day sweep over `.context-watch/` and `.handoff-requests/`, plus tab files older than 30 days.

**Hooks** (`src/cli/commands/hook.ts`): `post-tool-use` runs `maybeNudge` for every Edit/Write and appends to the existing `hookSpecificOutput.additionalContext`, wrapped so formatter behaviour and exit code never change; `user-prompt-submit` appends after the debt line; `session-start` prints the `>> HANDOFF:` banner before the snapshot and stamps `consumedAt`; `pre-compact` fills `CompactionRecord.context_tokens` from the transcript tail.

**`tasks handoff`** (`src/cli/commands/tasks.ts`): resolves the slug like `tasks log`, writes `state/.handoff-requests/<key>.json` keyed on `DREAMCONTEXT_TAB_SESSION ?? CLAUDE_CODE_SESSION_ID ?? manual-<ts>`, schema `{task,title,at,contextTokens,fromSession,tab,actedAt?,consumedAt?}` — `actedAt` written only by `agent-chat.ts`, `consumedAt` only by session-start.

**Server** (`src/server/routes/agent-chat.ts`): at the main-chain result frame, `shouldRotateForHandoff()` gates the rotation; on pass it stamps `actedAt`, sends `/clear` and the continue prompt as user frames (verified to rotate in-process and fire SessionStart `source=clear` on CLI 2.1.261), and emits the system notice. Tab seeding happens at spawn from `readBrainLocal().contextHandoffDefault ?? readSetupConfig().contextHandoff?.enabled ?? false`.

**UI**: `ClientControl {type:'setContextHandoff'}` in `chatProtocol.ts`; `UsageMenu` in `ComposerMenus.tsx` draws the three concentric rings, the marker tick and the ECO lamp; `composer.css` carries the classes, design tokens only. `scripts/verify/usage-panel-shot.mjs` boots the real server against an isolated HOME and photographs six frames in both themes — three traps recorded in it: the empty state's buttons fail Playwright's visibility heuristic, a started chat opens DOCKED so `.chat-cmp` mounts with a zero box, and `locator.screenshot` needs handling accordingly.

**Tests**: `tests/unit/context-watch.test.ts` (64), `tests/unit/tasks-handoff.test.ts` (9), plus additions to `hook.test.ts` and `agent-session-stats.test.ts`. The `shouldRotateForHandoff` regression test was mutation-verified (removing the `consumedAt` check turns exactly that test red).

## Notes

- **Learned the hard way**: `readSetupConfig` and `updateSetupConfig` both rebuild `SetupConfig` field by field — a new field added to only one of them is silently dropped. Two real bugs came from this; both are now pinned by tests.
- **Learned the hard way**: `npx dreamcontext` under a fake `HOME` downloads the *published* version. Hook commands in a test harness must be pinned to `node <repo>/dist/index.js`.
- Terminal/PTY sessions get the nudge and the banner but no automatic rotation — the user runs `/clear` themselves. Automating that is deliberately out of scope for v1.
- The **article-grade write-up** of the underlying research is an open deliverable, tracked in `knowledge/context-ceiling-economics.md`, not here.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-09-13 - Created
- PRD written retrospectively at sleep from task `opt-in-context-handoff…`, commits `1e12c855` (the feature) and `1bf194ad` (Health rings + ECO lamp), and the live handoff record in `state/.handoff-requests/`.
