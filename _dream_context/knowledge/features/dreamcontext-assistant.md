---
id: feat_lWnraM5v
type: feature
name: dreamcontext-assistant
description: >-
  An assistant above every project: a hidden vault
  (`~/.dreamcontext/assistant/`) with one long-lived Claude Code session,
  summoned into the notch by a global hotkey. Opens projects, drives and watches
  their chats, broadcasts rules, sees the screen, talks by voice; autonomy
  ask/auto/bypass. Succeeds Jarvis mode and the Meeting Room.
pinned: false
date: '2026-09-26'
status: in_review
product: desktop
created: '2026-09-26'
updated: '2026-10-04'
released_version: null
tags:
  - 'topic:desktop'
  - 'topic:agents'
  - 'topic:assistant'
  - 'topic:cli'
  - 'domain:security'
  - 'layer:backend'
related_tasks:
  - >-
    a-dreamcontext-assistant-lives-in-the-notch-wakes-on-a-hotkey-and-drives-every-project-as-the-owner-s-replica
  - >-
    the-notch-assistant-answers-without-the-15-40-s-of-plumbing-in-front-of-every-turn
  - >-
    the-assistant-is-woken-by-an-event-whenever-a-session-it-delegated-asks-finishes-a-turn-or-closes
  - >-
    desktop-windows-move-and-resize-in-one-smooth-animation-instead-of-frame-by-frame-jumps
  - sesli-asistan-ekrani-gorur-ve-acik-sekmedeki-projeye-baglanir
  - >-
    the-notch-becomes-a-notification-center-and-the-assistant-decides-how-each-reply-is-shown
---

## Why

Everything the owner does across N projects is manual window-hunting: find the
window that holds a vault, open a chat there, type the prompt, come back later to
see whether it asked something. A rule stated once ("from now on, do X") has to be
re-typed in every project. Two earlier attempts each covered one slice of this and
neither covered the whole: the **Meeting Room** (talk to several projects at once)
and the composer's **Jarvis mode** (talk to one chat by voice). Both retire into
this feature rather than being maintained alongside it.

The assistant is the owner's replica standing above the projects: it knows every
connected vault, opens and tiles their windows, starts a chat in one and sends the
prompt, watches a session and summarizes it, follows up or answers a question for
another agent, adds and connects projects, and can be spoken to. It is summoned from
the notch by a hotkey and answers there in two or three sentences.

## User Stories

- [ ] As the owner, I hold a hotkey and speak to the assistant from any app, and it answers in the notch without stealing focus from what I was doing.
- [ ] As the owner, I ask "what happened in project X this week" and get an answer, without opening X's window myself.
- [ ] As the owner, I say "start a chat in X and ask it to do Y" and the assistant opens that project and sends the prompt.
- [ ] As the owner, I say a rule once and it is written into all N projects by each project's OWN agent, and the assistant comes back with "written in all N".
- [x] As the owner, I see at a glance from the collapsed pill how many sessions are working, queued or waiting on me across every project — the pill tickers what needs me ("korus needs you", "tilki finished"), draws a busy hairline while any project works and tints amber when something waits.
- [x] As the owner, I read what the Assistant handed off — the brief it gave, where it stands, how old it is and the project's last reply — without opening any project window.
- [x] As the owner, I answer a project's permission prompt from the notch itself (Allow / Deny, Y / N) instead of hunting the window that is asking.
- [x] As the owner, my earlier notch conversations are kept and I can pick one to resume, or start a fresh one without losing the current one.
- [ ] As the owner, I choose how much the assistant may do on its own — `ask` (every follow-up, answer or broadcast needs my approval), `auto`, or `bypass` — and I am warned about what I am turning on.
- [ ] As the owner, I set the assistant up in a Launcher wizard (name, avatar, character, hotkey, autonomy, voice key, permissions) and it can wake at login.
- [x] As the owner, I switch the Assistant off from its Launcher card without deleting it (notch hidden, hotkey released, Login Item removed; switching back on resumes the same conversation).
- [x] As the owner, a session the Assistant delegated wakes it when that session asks a question, finishes a turn, or closes, so I hear back without polling.
- [ ] As the owner, the assistant's own memory improves: its hidden vault sleeps like any other, so what it learned about me persists.
- [x] As the owner, I hand a project's work to that project's OWN agent and am told when it asks something, finishes its turn or closes — without watching its window.
- [x] As the owner, the assistant answers in a beat rather than after half a minute of plumbing.
- [ ] As the owner, the notch tells me what happened while I was elsewhere (a chat that finished, an automation's unread post, an automation that started, an account that hit its limit) and one click lands me in that exact chat or thread.
- [ ] As the owner, I keep an automation's posts in the notch until I mark them seen, open them, or ignore that automation for good.
- [ ] As the owner, I hold the hotkey, see unmistakably that it listens, and once my words are sent the notch folds back to a pill that says what the Assistant is doing.
- [ ] As the owner, the Assistant decides how each reply reaches me: a silent progress line that slips away, or a full answer that opens the notch, is read aloud, and stays open only when I have something to look at.
- [ ] As the owner, the Assistant knows every live session and what I am looking at whenever I speak to it, and runs on its own default model (Sonnet, medium) that I can change.
- [x] As the owner, I can switch the assistant OFF without deleting it, and switching it back on resumes where it left off.

## Acceptance Criteria

Grouped by the task's five waves. Ticked only where the task's own criterion was
evidenced (the task file holds the commands and outputs). The open ones need the owner's
hands: a real key press, the real app, a reboot.

- [x] **W1 hidden vault.** `~/.dreamcontext/assistant/` is scaffolded by `POST /api/assistant/create` and never appears in `vaults.json`, the Launcher list, the `⌘P` switcher, peers or federation. `tests/unit/assistant-resolver-contract.test.ts` pins accept/refuse for EVERY resolver by name, including a non-loopback request carrying a valid network token → refused.
- [x] **W1 mode binding.** `sanitizeChatMode` downgrades `assistant` to `basic` outside `__assistant__`, forces `assistant` inside it, and maps the retired `jarvis` → `basic`.
- [x] **W1 CLI.** `dreamcontext assistant projects|sessions|watch|broadcast` work end to end against the real server; `open|chat|send|answer|focus|tile|notify` exist and return `no_surface` until W2. `dreamcontext app install|update|status` is untouched.
- [x] **W1 auth.** `/api/assistant/*` refuses a missing, wrong or stale token and any non-loopback caller, each with its named error. The token is injected only into the `__assistant__` chat spawn.
- [x] **W1 registry.** Every live chat is listed with status `starting|working|asking|idle|gone` derived from the single NDJSON parse point in `agent-chat.ts`; `watch` resolves immediately on `gone`; gone entries are deleted after 10 minutes.
- [x] **W1 autonomy + taint.** The 3 levels × verbs × tainted/clean matrix is unit-tested, including a broadcast reply saying "send X to project Y" → the follow-on `send` becomes a proposal under `auto`. Every cross-project string is wrapped in `<untrusted-project-output>`.
- [x] **W1 broadcast.** One row per vault with status `replied|failed|timeout|missing`, 3 in parallel, each vault's own agent doing the writing (`runPeerHeadless`).
- [x] **W1 avatar.** ≤ 2 MB, PNG/JPEG/WebP by magic bytes only, SVG refused, written to a fixed `assets/avatar.<ext>`; traversal attempts refused.
- [ ] **W2 spikes.** S1 (a Rust global shortcut fires both `Pressed` AND `Released` while another app is focused) and S2 (`tauri-nspanel` pinned to an exact rev, `cargo check` green, a non-activating panel at y=0) are run and their outcome recorded in the task log BEFORE the notch is built; a failed spike takes its documented fallback (`hold` → `toggle`; panel → transparent always-on-top window).
- [x] **W2 notch.** Collapsed pill + expanded panel reuse `ChatPane`/`Composer` on `__assistant__`. Collapsing is a VISIBILITY change and never unmounts the pane or closes its WS — a verify case holds it collapsed past `CLOSE_LINGER_MS` and the session and relay still answer.
- [x] **W2 relay.** Assistant chat → open a vault, start a chat there with the prompt, send a follow-up, answer a question, focus — proven in `scripts/verify/assistant.mjs`. A refused tab ceiling falls back to its own window, then to `{error:'ceiling'}`.
- [x] **W2 anti-forgery.** Forged `dream://assistant-command` events (unknown id, reused id, id minted for another vault, wrong window nonce) emitted from a vault window make nothing land in the target pane (Playwright case).
- [~] **W2 Launcher.** "Create dreamcontext Assistant" wizard: name, avatar, character → soul, hotkey with live registration result, autonomy with bypass and bypass+autostart warnings, voice key via the secret field, permissions checklist, "Wake up". An autostart launch opens only the notch, and the notch can still open project windows. *(BUILT — `AssistantWizard.tsx` / `assistantWizardLogic.ts`, with `assistant-wizard.test.ts` pinning the chord vocabulary against the server's own `sanitizeConfigPatch` so client and server cannot disagree on what a legal global shortcut is. Open only on the owner running it in the real app.)*
- [x] **W3 voice.** Hold-to-talk from the Rust shortcut (or the toggle fallback) transcribes in the notch with a lexicon that knows the registered project names; TTS, music pause/resume and Hush work there; a corrected transcript waits for the owner.
- [x] **W4 tile + detail clicks.** Two or more vaults are placed side by side / rows / grid in their own windows on the current monitor (measured bounds in verify); a detail click in a notch answer opens that project window at the right pane.
- [x] **W5 retirement.** The `jarvis` chat mode and the Meeting Room are gone from code (routes, components, hooks, capability, verify script, i18n, tests); `runPeerHeadless` stays; records on disk are untouched. `jarvis-voice-mode.md` and `meeting-room.md` carry RETIRED banners and `status: deprecated`; skill references and `cli-manifest.json` are updated.
- [ ] **Validation method.** Unit/integration tests (`npm test`, tsc root + dashboard) + `scripts/verify/assistant.mjs` on an isolated HOME + the owner's manual checklist for the native parts (notch placement incl. external monitor, hotkey from another app, TR+EN hold-to-talk, music, autostart after reboot, "what happened in X this week" end to end, rule broadcast to all vaults, ask-mode approval, add + connect projects by voice).

### After the first week of real use (2026-09-27 → 29)

- [x] **A DELEGATED SESSION WAKES THE ASSISTANT** (`11f18123`). Delegation was write-only: the Assistant could start a chat in a project and then had no way to learn that it asked something. `watch --until settled` (idle **or** asking) is now the default, the chat registry reports every change through `onChatChange`, and `src/lib/assistant/delegations.ts` tracks sessions the Assistant started or sent/answered into — **asking wakes at once, idle after a 2 s debounce, gone once after 3 s** unless a respawn under the same id is live. The wake lands in an inbox on the owner's `switchGate` chain: a wake TAINTS and never clears taint, and a wake held for an account switch is never handed back as `pendingText` (it would be typed into the composer as if the owner wrote it). Project text stays fenced in `wrapUntrusted`. With no Assistant chat open, events QUEUE (one per session, cap 20) and flush once on attach — `pattern-every-store-key-needs-a-death` applied to a queue. The briefing tells Spidey to end its turn and relay the question to the owner rather than answering for them.
- [x] **THE ASSISTANT ANSWERS WITHOUT 15–40 s OF PLUMBING IN FRONT OF EVERY TURN** (`e174cb67`, task `the-notch-assistant-answers-without-…`). Measured: the recall hook took **16.9 s in its own vault and 28.4 s in a delegated project** before a single token — the notch's whole premise is a two-sentence answer, so this was the feature failing, not slow. Four causes, four fixes: (1) recall for the Assistant, and for haiku-mode vaults it DELEGATES to, runs `hybrid` when the embedding model is already on disk and `raw` otherwise — never a cloud call in front of a notch turn (→ **1.2 s** and **0.8 s**); the delegation marker (`origin=assistant`) survives a resume, so a resumed delegated chat does not silently fall back to the slow path. (2) The Assistant's embedding index builds in the BACKGROUND at spawn: single-flight, a 30-minute cooldown after a failed build, and it **never downloads the model** (a first-run model fetch in front of a hotkey press is the same defect wearing a different hat). (3) Embedding-cache writes are serialized per vault by a lockfile (`src/lib/file-lock.ts`) and the recall hook never waits on it. (4) The model loads OFFLINE once it is on disk. Also: `--allowedTools 'Bash(dreamcontext assistant:*)'` only under autonomy `auto`, and an autonomy change respawns the live Assistant IN PLACE without losing a message. Effort comes from `AssistantConfig.effort` (default `medium`); a delegated basic chat defaults to `medium`. `tests/unit/assistant-latency.test.ts`, `embedder-offline.test.ts`, `embeddings-lock.test.ts`; `verify:assistant` 135 passing.
- [x] **THE NOTCH STEPS OUT WHILE IT WORKS, AND SPEECH KEEPS ITS PITCH** (`42ff5c02`). A turn starting pops the notch out to a **480×620 side seat** (top-right, never takes focus) with a thin dreamcontext-coloured loading line along the top edge; when the turn AND its speech end it animates back into the collapsed notch (1.5 s, or 8 s with read-aloud off — an owner who cannot hear the answer needs longer to read it). Clicking or typing into it keeps it open. The open notch grew 460×400 → 580×560. Speech rate no longer raises pitch (the "helium" defect): chunks are time-stretched with **WSOLA** (`timeStretch.ts`) and played at rate 1, with the element fallback keeping `preservesPitch`. New notch chats open on the saved **"Set as default"** model/effort instead of the CLI's own `xhigh`, and a default set in one window reaches every other through the storage event.
- [x] **THE OWNER CAN SWITCH THE ASSISTANT OFF WITHOUT DELETING IT** (`e79500cc`). The Launcher's assistant card carries an on/off switch: off hides the notch, releases the global hotkey and removes the Login Item, while the hidden vault and the conversation are KEPT, so switching back on resumes where it left off. An `enabled` flag in `config.json` (default **on**, so older configs stay on) decides whether boot seats the notch, the hotkey registers, and a login launch opens only the notch. The notch webview stops re-seating itself while it is off (the seat guard would otherwise fight the hide), and the wizard's "Wake up" switches it back on.
- [x] **EVERY WINDOW MOVE IS ONE ANIMATION, NOT A RUN OF VISIBLE FRAMES** (`1412f266`, task `desktop-windows-move-and-resize-…`). Notch pop-out, dock, expand and assistant tiling jumped through several frames — separate `setSize`/`setPosition` IPCs, a min-size grow BEFORE the move, sequential tiling, new windows born at 1280×800 — and the chat re-laid out every diagram on each width change. Rust `set_frames` (`desktop/src-tauri/src/frames.rs`) moves **every window of a call in ONE eased `NSAnimationContext` group (~200 ms)**. Instant frames go through `animator()` in a ZERO-duration group, because a plain `setFrame` does not cancel an animation already in flight and the older one would land last. All-or-nothing on labels, per-label generations gate everything after start, a 50 ms spam bound, a hard deadline so the call always resolves, and min size as a preset (`window-seat` / `clear`) applied AFTER the frame lands. Granted only in `capabilities/assistant.json`; `apply_seat` no longer sets it. `seatGuard.ts` steps the heal guard aside while a move is in flight; overlapping tiles serialize, missing windows are created AT their tile rect, and one `setFrames` moves the rest together. Diagrams fit-scale during a resize and re-lay out 150 ms after it stops. `prefers-reduced-motion` makes every move instant. `cargo test` 12/12; `assistant-window-frames` + `chat-html` + `window-capabilities` 196/196. Owner's manual desktop checklist still open.

### The notch becomes a status surface (2026-10-03, `76f144a2`)

- [x] **Two faces when open: Now and Chat.** Now lists what every project is doing — **asking first** — the pending proposals, and every hand-off the Assistant made: the brief it gave, where it stands (on it / waiting / done / closed), its age and the project's last reply.
- [x] **A permission prompt is answered in place.** Allow / Deny buttons and the Y / N keys in the notch; `POST /api/assistant/answer` is owner-gated and **refuses a prompt that is no longer waiting**.
- [x] **Conversations are kept.** A menu lists the hidden vault's earlier chats; picking one resumes it, and `+` starts a fresh one without losing the current one.
- [x] **The collapsed pill speaks.** A ticker of what needs the owner, a busy hairline while any project works, amber when something waits and green when the last turn ends.
- [x] **A peek, never stealing focus.** The pill grows a peek on hover, by itself on a new prompt (until answered or waved away), and for a few seconds when a hand-off finishes.
- [x] **Server side is read-gated and taint-safe.** `GET /api/assistant/glance` is owner-gated and wraps project text as untrusted; `POST /api/assistant/delegations/dismiss` closes a hand-off; `delegations.ts` keeps the brief and remembers closed hand-offs (last 10, one hour — `pattern-every-store-key-needs-a-death`). `tests/unit/assistant-notch-glance.test.ts`.
- [ ] Owner sign-off on the ticker, the peek and the Conversations menu in the installed .app.

### The notch as a notification center; the Assistant decides how it is shown (2026-10-04)

Task `the-notch-becomes-a-notification-center-and-the-assistant-decides-how-each-reply-is-shown`.
Built and unit-tested, committed in `55c6ff92`; open on the owner running it in the installed .app.

- [ ] No automatic pop-out (the side seat is gone); Pop out / Dock stay the owner's.
- [ ] Inbox: finished chats off screen (presence-gated), unread automation posts until seen / opened / ignored, running automations with photos, account limit + switch as one row; clicks route through `dreamcontext://`.
- [ ] Live context on every owner turn, with no project text (never taints).
- [ ] Notch cues progress / present / present stay; voice take folds after send; the pill names what the Assistant is doing.
- [ ] Listening state + earcons; STT retried twice; a silent whisper is `stt_failed` (503), not `stt_unconfigured`.
- [ ] The Assistant's own default model sonnet + medium, persisted from the notch composer.

### The notch after its first day as a notification center (2026-10-04)

- [x] **The Assistant closes chats in other projects** (`31f22c57`): `dreamcontext assistant close <sessionId>` or `--vault <v> [--status idle]`; an idle chat closes directly, a working/asking one needs `--force`, and a forced close of a busy chat is a notch proposal below `bypass`. Status is re-read after approval (a chat that became busy meanwhile is skipped); the Assistant's own chat and ended chats are never targets; the notch relays `close` to an open project window and never builds one. `tests/unit/assistant-close.test.ts`, `assistant-doorbell-close.test.ts`, `assistant-command-executor.test.ts`.
- [x] **No finished-chat peek is lost** (`ab02990a`): arrivals queue until the peek is free (one at a time, cap 3) instead of being listed silently under a prompt or the open notch; an event peek holds 20 s (was 6.5 s) and the pill names a finish for 10 min. `tests/unit/assistant-notch-inbox.test.ts`.
- [ ] **A peek never folds under the pointer, and Esc folds the open notch over any app** (`ab02990a`): the notch asks the OS where the cursor is, and holds Esc (Carbon hotkey) only while open, replaying it into the webview so open menus take it first. Native; awaiting the owner's in-app check.
- [ ] **The tick is heard and the tap is felt from the first notification** (`e6371858`): a native system sound via `assistant_haptic(sound)` instead of autoplay-suspended WebAudio, and the trackpad actuator driven directly (MultitouchSupport, dlopen'd; AppKit fallback). Native; awaiting the owner's in-app check.
- [ ] **Files reach the notch** (`2a6451a4`): the Attach picker works (`pick_paths` granted; the notch does not fold on the focus loss the sheet causes), a file dragged over the folded notch opens it on the chat and drops into the composer as a path, and the hover peek fires reliably from native mouse-move monitors (`assistant://hover`). Native; awaiting the owner's in-app check.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-10-04] A non-activating panel gets nothing the OS reserves for the active app — ask the OS, or go native.** The notch is a non-activating panel of an app usually not in front, so WKWebView hover tracking (key window only), `NSHapticFeedbackManager` (active app only), WebAudio (suspended until a click) and Tauri's default drag-drop handler all silently failed in it. Each was replaced by a native path (cursor-position query, mouse-move monitors, direct actuator, system sound, drag-drop handler off). Platform facts behind it: `knowledge/desktop-beta-tauri-multivault.md` § "macOS activation and focus".
- **[2026-10-04] Closing another project's chat is graded by what it would interrupt.** Idle closes freely; working or asking needs `--force`, and a forced close of a busy chat is a proposal below `bypass`. The status is re-read AFTER approval, because the owner's decision takes time and the chat may have started working in it.

- **[2026-10-04] The Assistant, not the notch, decides how a reply is shown, by a cue it writes.** Owner: "the agent decides … so that the experience is seamless." Each text block opens with an invisible `<!-- notch:progress|present[ stay] -->` line; the client strips it at its single text-update point and from the replay, and a progress block never reaches the speech queue. An HTML comment so an unparsed cue renders as nothing anywhere. No auto pop-out any more: the notch opens and folds in place, and the owner touching it makes it theirs.
- **[2026-10-04] The live context carries no project text, by construction.** Session titles, replies and questions are other agents' words; putting them in the owner's own turn would either launder them as the owner's voice or taint every turn (turning every `auto` verb into a proposal). Ids, enums, durations and sanitised names only; the Assistant reads words through `assistant sessions`, which taints as designed.
- **[2026-10-04] "Not in that window" is a presence report, not a guess.** The focused window reports the project it shows (60 s TTL, heartbeat 20 s); a finish in that project is not news, and looking at it later clears it. A delegated session's finish stays a hand-off row, never a second notice.

- **[2026-09-28] A latency budget is a product requirement for this surface, not an optimisation.** The notch's premise is "hold a key, get two sentences" — 16.9 s of recall in front of that is the feature not working. The rule that came out of it: **nothing in a notch turn's critical path may do network I/O or a cold model download.** Recall degrades to `raw` rather than waiting, the embedding index builds in the background or not at all, and a lockfile serializes cache writes so the hook never blocks on another vault's build. A delegated project inherits the same budget, which is why the `origin=assistant` marker has to survive a resume.
- **[2026-09-28] Delegation is only half a channel until the delegate can wake you.** The Assistant could start work in a project and then had to be asked what happened. Wakes are therefore pushed (asking immediately, idle debounced 2 s, gone after 3 s unless respawned), but every wake TAINTS the session and never clears the taint, and a wake is never handed back as `pendingText` — a project's own words must never arrive in the composer wearing the owner's voice. Spidey relays a question; it does not answer one on the owner's behalf.
- **[2026-09-28] Off is a state, not a deletion.** The owner asked to stop the notch without losing the conversation, so `enabled: false` hides the notch, releases the hotkey and removes the Login Item while the hidden vault and its conversation stay untouched. The flag defaults to ON so every config written before it existed keeps working.
- **[2026-09-28] Window motion belongs in ONE native call, not a sequence of IPCs.** Each `setSize`/`setPosition` round trip is its own visible frame, and a min-size grow before a move shows the wrong rect first. `set_frames` takes every window of a move at once inside a single `NSAnimationContext` group; an "instant" frame still goes through `animator()` in a zero-duration group, because `setFrame` does not cancel an in-flight animation and the older one would win. The capability is granted to the assistant surface alone.

- **[2026-09-26] Security invariants, four-lens reviewed.** `__assistant__` is loopback + desktop ONLY, and the chat WS branch runs BEFORE the `isTrustedRemotePeer` OR so the tailnet phone surface structurally cannot reach it. UI commands relay DOWN the assistant's own chat WS; the Tauri event is a **doorbell, never the command** — it carries only a single-use 128-bit `commandId` with a 30s TTL, which the receiving vault window must claim from the server with its own per-window nonce, because Tauri v2 cannot scope `emitTo` by target label. The server wraps every project-derived string in `<untrusted-project-output>` and marks the session TAINTED until the owner's next message.
- **[2026-09-26] The token is an honest, LIMITED boundary — write it down rather than overstate it.** `DREAMCONTEXT_ASSISTANT_TOKEN` stops remote use and accidental use by other vaults' agents. It is NOT a defense against a malicious same-user process: sub-agents and MCP servers the assistant itself spawns inherit it and are equally privileged.
- **[2026-09-26] Autonomy is the owner's dial, and `bypass` passes tainted actions by explicit choice.** `ask` turns `send`/`answer`/`broadcast` into proposals; `auto` passes them unless the session is tainted, and answering ANOTHER agent's tool-permission prompt always needs approval; `bypass` passes everything, with wizard warnings and a second warning when bypass + autostart are both on. Free verbs at every level: `projects`, `sessions`, `watch`, `open`, `chat` (with the owner's own words), `focus`, `tile`, `notify`.
- **[2026-09-26] Build order: dashboard → CLI → `dreamcontext update` → Tauri LAST** (`pattern-build-and-propagate`). New Tauri deps are pinned to exact versions/revs — the removed notch (`8596538`) had `tauri-nspanel` on a floating `branch = "v2"`.
- **[2026-09-26] Notch collapse is a visibility change, never an unmount** (the `WindowChrome` instance-retention rule). An unmounted pane closes the socket, `onSocketGone` kills the child after `CLOSE_LINGER_MS`, and the relay would lose its only channel.
- **[2026-09-26] Out of scope:** other apps' windows, a wake word, remote (tailnet/phone) access to the assistant, persisting pending proposals across app quit (they are declined), offline local-whisper as a requirement.
- **[2026-09-26] Owner decisions, not to relitigate:** one task in five waves; a hidden vault plus a long-lived Claude Code chat session; autonomy as a user setting `ask|auto|bypass`; tiling ONLY dreamcontext's own windows (no Accessibility API); voice is hotkey hold-to-talk with no wake word and no always-listening; the `jarvis` mode and the Meeting Room are retired IN CODE while `~/.dreamcontext/meeting-room/` and `voice.json` stay on disk; a broadcast rule is written by each project's own agent; the assistant can do anything the owner can, including adding and connecting projects.

## Technical Details

**Built 2026-09-26 (task `a-dreamcontext-assistant-lives-in-the-notch-…`). The task file
holds the wave-by-wave evidence; `scripts/verify/assistant.mjs` (`npm run verify:assistant`)
drives all of it against the real built server on an isolated HOME.**

```
 hotkey (Rust global shortcut, Pressed/Released) ──► notch window (label `assistant`)
                                                        │ mounts the SAME ChatPane/Composer on vault `__assistant__`
                                                        ▼
            WS /api/agent/chat?vault=__assistant__ (LOOPBACK ONLY) ──► claude (cwd = hidden vault)
                                                                        │ Bash: dreamcontext … / dreamcontext assistant …
                                                                        ▼
                                  /api/assistant/* (loopback + desktop + token)
                                     ├─ read: projects, sessions, watch  ← chat registry
                                     ├─ broadcast → runPeerHeadless × N
                                     ├─ autonomy + taint gate → proposals (approved in the notch)
                                     └─ UI verbs: relayed as a `dc_meta` command DOWN the assistant's
                                        own chat socket → notch executes → emitTo(target window) + ack
```

- **Hidden vault.** `src/lib/assistant/home.ts`: `assistantProjectRoot(home)`, `ASSISTANT_VAULT = '__assistant__'`, `isAssistantVault(name)`. A normal `_dream_context/` scaffolded by the existing init code — soul = character, memory = what it learned about the owner. Config at `~/.dreamcontext/assistant/config.json` (0600). Sleep works on it like any vault; its debt shows in the notch, not the Launcher. `upgrade`/`doctor` iterate `vaults.json` and so skip it — the server runs the per-vault update routine at assistant spawn when its recorded version differs.
- **Resolver contract, per resolver.** `resolveVaultProjectRoot` maps `__assistant__` to the hidden root and `attachAgentChat` requires `isLoopback && isDesktop` unconditionally, branching BEFORE the `isTrustedRemotePeer` OR; `agent-terminal.ts` REFUSES it (no terminal on the hidden vault); `resolveRequestVault` maps it only under loopback + desktop, else 403; every other resolver (the six `launcher.ts` sites, `resolveVaultContextRoot` with an explicit early refusal so its raw-path fallback cannot resolve it, peer/federation/connections/snapshot) keeps rejecting it unchanged.
- **Runtime.** A new chat mode `assistant` in `src/server/chat-modes.ts`, absent from the composer's picker and enforced server-side. Its briefing carries identity, autonomy level, notch surface rules (2–3 spoken sentences, structure as `dream-html`, details as `dream-actions`), the tool contract, the UNTRUSTED-CONTENT rule, and a ROSTER of every registered vault (name, path, whatItIs, activeTask, topTags, federation connections, live session rollup) capped at 6,000 chars. Continuity through `config.conversationId`, resumed on every summon.
- **Tools.** The whole existing CLI plus `src/cli/commands/assistant.ts`, a thin HTTP client: `projects`, `sessions`, `watch`, `open`, `chat`, `send`, `answer`, `focus`, `tile`, `broadcast`, `notify`. Auth env (`DREAMCONTEXT_ASSISTANT_URL` + a random per-boot token) is injected only at the `__assistant__` spawn.
- **Server** (`src/server/routes/assistant.ts`, `src/lib/assistant/*`): the chat registry fed from `agent-chat.ts`'s single parse point (gone entries die after 10 min — `pattern-every-store-key-needs-a-death`), long-poll `watch`, the `dc_meta` relay (25s, inside the 30s claim TTL so a cold window can still claim; no surface → `no_surface`; no new WS endpoint), the autonomy + taint gate, and `broadcast` over `runPeerHeadless`. Owner route `POST /api/assistant/open` mints an ordinary `open` command for a clicked detail button, so a click and a verb reach a window by one path.
- **Notch** (`dashboard/src/components/assistant/`): `Notch.tsx` (pill ↔ panel, hidden never unmounted, hotkey edges), `commandExecutor.ts` (delegated verbs: find the project's live window or open its OWN via `openVaultWindow`, bind the id by label, `emitTo` the doorbell; `ceiling` when even that fails), `tile.ts` (pure `tileRects` + `tileWindows` on the notch monitor's work area), `useAssistantDoorbell.ts` (the project side: `runVerb` — chat / send / answer / focus / open with a page), `lib/assistantBridge.ts` (per-window nonce in a module closure, claim on doorbell). `AgentSurface` mounts the doorbell once per project instance.
- **Notch shell.** `desktop/src-tauri/src/assistant.rs`, window label `assistant`, shortcut registered IN RUST from `config.hotkey`, `tauri-plugin-autostart`, capability `capabilities/assistant.json` (window chrome, webview creation, size/position/focus, `emit-to`/`listen`, notification, global-shortcut listen — NO `shell:*`).
- **Voice** reuses `/api/agent/voice/stt` with `vault=__assistant__`, `/correct`, `/tts`, SpeechQueue, audioFocus and Hush through the notch's Composer (mode `assistant`). The Rust hotkey's edges reach it through `lib/voice/externalPushToTalk.ts` (a pure `pushToTalkAction` table: hold / toggle); the summoning press un-hides the panel synchronously first so the composer owns the chord. `src/lib/voice/lexicon.ts` puts every registered project name FIRST in the Assistant's vocabulary (only for the hidden vault). The voice key is written by the wizard to the same `~/.dreamcontext/voice.json`; Settings → Voice stays where it was.
- **Shape, pop-out, truthful counts, opt-in speech (W6/W7, owner 2026-09-26).** Open, the notch is one black shape (`--notch-surface`, `.surface-night` inside, lifted surfaces `color-mix`ed from the black) flush with the camera housing, 460x400; the reused chat pane is anchored by `.dc-notch__chat { position: relative }` (the pane is `position:absolute; inset:0` and used to cover the pill). **Pop out / Dock** moves the SAME webview between the notch seat and a 720x640 resizable floating window (`assistant://seat` event, handled in `assistant.rs`; payload is only `window|notch`), remembered for the app run. The pill's right ear wears the project tab strip's bubbles (green ring = working, grey = idle + stale, counts in words in the aria-label). The registry's `activityOf` is the truth behind them: a chat opened but never sent a message is idle after a 30 s grace (the 7 tabs reopened with `--resume` on relaunch were the "10 working"), a working chat silent for 3 min (11 min with a tool call open) is `stale`, `asking` never goes stale; `/api/assistant/rollup` = `{starting, working, stale, asking, idle, proposals}`, the roster uses the same rule. **Read-aloud is opt-in**: a composer toggle (`.chat-cmp-readaloud`, `lib/voice/readAloud.ts`, localStorage, default OFF) gates `speak()` in `chatSession.ts` before `speech.push`, so off means no `/tts` request; switching off mid-reply stops speech.
- **Where a project is open (2026-09-28).** `commandExecutor.findOpenProject` asks the server (`relay.ts windowLabelsForVault`, fed by every instance's registration and emptied by `POST /api/assistant/windows/release`), intersected with `WebviewWindow.getAll()`, before the browser registry; a registry window the server does not list holds the project as a COLD tab and is woken with `dream://assistant-wake` (`WindowChrome` only re-activates a tab it already holds). A new window only for a project open nowhere.
- **`look` (2026-09-28).** `src/lib/assistant/screen.ts`: `screencapture -x -t jpg` with one path per display (max 4, or `-D n`), `sips -Z 1920`, into the hidden vault's `tmp/screens/`, pruned after 30 min. Gate: `decide()` treats `look` like `chat` (free while clean, a proposal once tainted, bypass passes). No permission → `screen_permission` and the Privacy pane opens; the wizard's permissions step lists Screen Recording.
- **Retirements** (`pattern-retire-shipped-capability`): the `jarvis` mode became `assistant` (server maps a saved `jarvis` to Basic), and the Meeting Room's components/hooks/routes/lib/capability/verify script/i18n/tests were removed. `runPeerHeadless` (in `peer-delivery.ts`) STAYS. Voice modules were kept and rewired to the notch.

- **Off switch, delegation wakes, notch hardening (2026-09-27/28).** *Off:* `enabled` in the assistant `config.json` (default on, so older configs stay on) decides whether boot seats the notch, registers the hotkey and keeps the Login Item; the Launcher card's switch flips it, the wizard's Wake up turns it back on; the hidden vault and conversation are kept (`assistant.rs`, `AssistantEntryCard.tsx`). *Delegation wakes:* `src/lib/assistant/delegations.ts` tracks sessions the Assistant started or sent/answered into (fed by the registry's `onChatChange`); `asking` wakes at once, `idle` after a 2 s debounce, `gone` once after 3 s unless a respawn under the same id is live. A wake always taints (never clears taint), project text stays in `wrapUntrusted`, and with no Assistant chat attached events queue (one per session, cap 20) and flush on attach. `assistant watch --until settled` is the default. *Latency:* recall for the Assistant and the vaults it delegates to runs hybrid when the embedding model is on disk, else raw (hook 16.9 s -> 1.2 s); `--allowedTools 'Bash(dreamcontext assistant:*)'` only under `auto`; effort defaults to medium. *Window motion (`1412f266`):* Rust `set_frames` (`desktop/src-tauri/src/frames.rs`) moves every window of a call in ONE eased NSAnimationContext group (~200 ms); instant frames go through `animator()` in a zero-duration group so they cancel an in-flight animation; all-or-nothing on labels, per-label generations, a 50 ms spam bound, a hard deadline; granted only in `capabilities/assistant.json`, used by pop-out, dock, expand and tiling. *Notch:* a turn pops it out to a 480x620 side seat and it animates back when the turn ends; the summoning hotkey opens the panel first and only then starts a take (`summonTakeDue`), since WebKit audio start blocked the webview 1.6-3 s; a click outside closes the non-activating panel via NSEvent monitors (`assistant://outside-click`); `seatGuard.ts guardHeal` re-arms after giving up (seat change or 30 s cooldown); speech rate is time-stretched (WSOLA) so pitch holds; the briefing tells the Assistant to delegate project work to that project's own agent.

- **The notch as a status surface (2026-10-03, `76f144a2`).** The open notch has two faces: **Now** (`GlanceList.tsx`) and **Chat**. Now is fed by `GET /api/assistant/glance` — owner-gated, project text wrapped as untrusted — and orders projects by what needs the owner first, then proposals (`ProposalList.tsx`), then the Assistant's own hand-offs with the brief it gave, their state (on it / waiting / done / closed), age and the project's last reply. A waiting permission prompt is answered from the notch through `POST /api/assistant/answer`, which **refuses a prompt that is no longer waiting** (the state is the safety predicate, not the rendered card). `POST /api/assistant/delegations/dismiss` closes a hand-off; `src/lib/assistant/delegations.ts` now stores the brief and keeps closed hand-offs for one hour, capped at 10. `ConversationMenu.tsx` lists the hidden vault's earlier chats — picking one resumes it, `+` starts a fresh one without losing the current. Collapsed, the pill is a ticker with a busy hairline while any project works, amber when something waits, green when the last turn ends; `NotchPeek.tsx` grows a peek on hover, by itself on a new prompt (until answered or waved away) and for a few seconds after a hand-off finishes, and the peek **never takes focus**. The decision logic is pure in `notchModel.ts` (`tests/unit/assistant-notch-glance.test.ts`).

- **The notch inbox and cues (2026-10-04).** Server: `src/lib/assistant/notch-inbox.ts` (presence, finished events from `onChatChange` working→idle debounced 2.5 s, account events from `agent-chat.ts decideAndAnnounce` + `claude-account-limits.json` refusals since boot merged within 2 min, the mute list), `src/server/assistant-inbox.ts` (per-project running = `agentActivities`, unread posts = `buildFeed` unread && post/error/needs-you minus muted; cached 4 s / 15 s), routes `GET /api/assistant/inbox`, `POST /inbox/dismiss|seen|mute`, `POST /presence`; `src/lib/assistant/live-context.ts` appended as a second text block to each owner turn; `spawnModelFor` + `AssistantConfig.model` (default sonnet). Client: `lib/notchCue.ts`, `chatSession.onPresent`, `InboxList.tsx`, `ListeningOverlay.tsx` (+ `lib/voice/voiceActivity.ts` bus, `chime.ts playMicEarcon`), `lib/presence.ts` from `WindowChrome`, `useVoiceCapture` retries (`STT_RETRIES = 2`, `sttRetryable`). Tests: `tests/unit/assistant-notch-inbox.test.ts`, `voice-server.test.ts` (503), `chat-modes.test.ts`, `assistant-window-frames.test.ts`.

## Notes

- **Open question the owner has not settled:** under `bypass`, should the assistant also act on text coming from OTHER projects without asking? The plan currently says yes, with warnings in the wizard.
- `jarvis-voice-mode.md` and `meeting-room.md` are `deprecated` with RETIRED banners (W5).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-10-04 (later) - The Assistant can close chats, and the notch stops losing things

- **Close** `31f22c57`: `dreamcontext assistant close`, graded idle / `--force` / proposal, re-checked after approval; CLI manifest regenerated, briefing carries the verb.
- **Notch fixes** `ab02990a`, `e6371858`, `2a6451a4`: queued peeks with longer holds, a pointer-aware fold, Esc over any app, native sound + haptics, attach and drag-drop, native hover.
- **PRD reconciliation:** a new criteria block — two ticked from unit tests, three native ones left for the owner's in-app check; two decisions recorded; the 10-04 notification-center block noted as committed in `55c6ff92` but left unticked (owner check). `status` stays `in_review`.

### 2026-10-04 - The notch becomes a notification center, and the Assistant decides how each reply is shown

- **Built** (task `the-notch-becomes-a-notification-center-…`): the side seat and automatic pop-out are removed; an inbox of finished chats (presence-gated), unread automation posts (seen / open / ignore), running automations with photos and account limit switches, each a peek and a "Now" row that routes through `dreamcontext://`; a `<live-context>` block on every owner turn with no project text; notch cues (`progress` / `present` / `present stay`) deciding peek vs. open-and-speak vs. stay; a voice take that folds to a pill naming what the Assistant does; a listening state with earcons; transcription retried twice and a silent whisper reported as retryable; the Assistant's own default model (sonnet, medium). Briefing ceiling 4100 → 4900. Owner sign-off in the installed .app still open.

### 2026-10-03 — The notch stops being only a chat: it tells you what needs you, and you answer from it

- **Shipped** `76f144a2`: two faces when open (Now / Chat), `GET /api/assistant/glance` (owner-gated, project text wrapped, asking first) behind a list of projects, proposals and the Assistant's hand-offs with their brief, state, age and last reply; `POST /api/assistant/answer` answering a project's permission prompt in place (Allow / Deny, Y / N) and refusing a prompt that is no longer waiting; `POST /api/assistant/delegations/dismiss`; a Conversations menu that resumes an earlier hidden-vault chat or starts a fresh one; and a collapsed pill that tickers, draws a busy hairline, tints amber/green and grows a never-focusing peek on hover, on a new prompt and when a hand-off lands. `delegations.ts` keeps the brief plus the last 10 closed hand-offs for an hour; `notchModel.ts` holds the pure rules with `tests/unit/assistant-notch-glance.test.ts`.
- **PRD reconciliation:** the "at a glance from the collapsed pill" story ticked at last, three new owner stories added (hand-off ledger, answering a permission from the notch, conversations kept), a new criteria block for the status surface, Technical Details extended. `status` stays `in_review` (owner sign-off on the native peek/ticker still open), `released_version` stays `null`.

### 2026-09-28/29 - The first week of real use: it wakes you, it answers fast, it moves smoothly, and it can be switched off
- **Woken by its delegates** (`11f18123`): `watch --until settled`, `onChatChange`, and a delegations module that wakes the Assistant when a session it started asks, finishes a turn or closes. Events queue (cap 20, one per session) when no Assistant chat is attached.
- **Latency** (`e174cb67`): the recall hook went 16.9 s → 1.2 s in its own vault and 28.4 s → 0.8 s in a delegated project — hybrid-when-on-disk recall, a background single-flight embedding build that never downloads the model, and a per-vault lockfile the hook never waits on. `verify:assistant` 135 passing.
- **Notch behaviour** (`42ff5c02`): a working turn pops out to a 480×620 side seat that never takes focus and animates home when the turn and its speech end; WSOLA time-stretching ends the "helium" voice; new chats open on the saved default model/effort; the briefing tells Spidey to delegate project work rather than run `gh`/`git`/`grep` itself.
- **On/off** (`e79500cc`): an `enabled` flag and a Launcher switch that hides the notch, releases the hotkey and drops the Login Item while keeping the vault and the conversation.
- **Smooth windows** (`1412f266`): `set_frames` in Rust moves every window of a call in one ~200 ms eased group, with generations, a spam bound, a hard deadline and `prefers-reduced-motion` honoured.

### 2026-09-29 - Off switch, delegated sessions wake it, notch hardening (sleep reconcile)
- Folded commits `e79500cc` (off switch), `11f18123` (delegation wakes), `e174cb67` (latency), `aa5cca65`/`2343ef78`/`35636bc5`/`42ff5c02` (notch hotkey, outside click, seat guard, side seat) into Technical Details; two owner stories ticked from shipped code + unit tests. Native owner checklist still open, status stays `in_review`.

### 2026-09-28 - `look` sees the owner's screen; a command lands in the tab that is already open
- Owner: "şu ekranıma bak" must work, and a project already open as a tab must not get a second window. The notch read "where is X open?" only from the localStorage heartbeat, which goes stale when macOS throttles a background window; it now asks the server's live-instance list first (`GET /api/assistant/windows`, released on unmount, earlier page loads dropped), and wakes a cold tab in place (`dream://assistant-wake`). `look` screenshots every display (gated like `chat`, Screen Recording permission reported as `screen_permission`). Task `sesli-asistan-ekrani-gorur-ve-acik-sekmedeki-projeye-baglanir`.

### 2026-09-27 - W6/W7: black compact notch, pop-out window, truthful working/stale, opt-in read-aloud
- Owner verdicts on the real app ("aynı renk olsun, küçük olsun, notch ile perfect"; "sığması lazım, pencere olarak açılabilmeli, gerçekten working/stale göstermeli"; "okuma modu sadece açıksa okusun"). Built by Develop-mode builders, each wave reviewed clean; `verify:assistant` 107/107 (fit, bubbles, pop-out same node + socket, read-aloud off → zero TTS).

### 2026-09-26 - Built (W1–W5)
- W1 headless contract, W2 notch + relay + anti-forgery + Launcher wizard, W3 voice from the Rust hotkey, W4 tile + detail buttons, W5 retirements. Evidence in the task log; `verify:assistant` covers relay, forgery, the collapsed-notch linger, hotkey → mic → corrected transcript, speech + music + Hush, tile rects and the detail click. Open: the S1/S2 native spike sign-off, the wizard in the real app, and the owner's manual checklist.

### 2026-09-26 - Created
- PRD written from the settled design in task `a-dreamcontext-assistant-lives-in-the-notch-wakes-on-a-hotkey-and-drives-every-project-as-the-owner-s-replica` (planning session `660823b8`, review round 1 complete, W1 in progress). Nothing shipped; every criterion open. The task's own W5 criterion asks for exactly this file.
