---
id: feat_WTD0oQC7
type: feature
name: jarvis-voice-mode
description: >-
  The chat composer's fourth mode, made real: push-to-talk in, spoken answers
  out, and a short briefing that makes the agent say two or three plain
  sentences while putting any structure on screen as a dream-html block instead
  of reading it aloud. One OpenRouter key, per-machine, never in a vault.
pinned: false
date: '2026-09-10'
status: in_review
created: '2026-09-10'
updated: '2026-09-13'
released_version: null
product: desktop
tags:
  - 'topic:voice'
  - 'topic:desktop'
  - 'topic:agents'
  - 'topic:dashboard'
  - 'domain:security'
  - 'layer:frontend'
  - 'layer:backend'
related_tasks: []
---

## Why

The composer had four chat modes and one of them was a lie: `jarvis` sat in `CHAT_MODES` with a
"Soon" badge, was coerced to `basic` by `sanitizeChatMode`, and was answered by an empty briefing.
The stub existed in **six** places, not the four a first pass found.

The capability it stands for is not a novelty. Dictation is the fastest input a laptop has, and
the owner's working language (Turkish, heavy with this project's own jargon) is exactly the case
a generic recogniser handles worst. The mode's real design problem is therefore not "can we play
audio" but **can a spoken turn be trusted**: a mis-heard word that auto-submits reaches a
tool-enabled agent, and a text-to-speech model that answers a sentence instead of reading it
produces a lie the user cannot detect because they only ever hear the output.

## User Stories

- [x] As an owner, I hold one key (⌥Space by default, or the mic button) and speak, and what I
      said arrives in the composer — so dictation is the fast path into the agent.
- [x] As an owner, I hear the agent's answer spoken back while any structure in it is drawn on
      screen, so a table is something I look at rather than something read to me.
- [x] As an owner whose speech contains this project's jargon, a correction pass repairs the
      terms the recogniser mangled — but **anything it changed waits for me to press send**.
- [x] As an owner, I can tell when the correction pass altered my words, because the change is
      marked in the composer rather than applied silently.
- [x] As an owner, I choose my own push-to-talk binding, and I choose whether it is
      *hold-to-speak* or *press-to-start / press-to-send*, because a latch key like Caps Lock
      cannot be held.
- [x] As an owner, I set this up in one place — a collapsed BETA group at the bottom of
      Settings → Agents — with the key, the transcriber, the speak toggle and the speed.
- [x] As an owner, I can turn speech OFF and keep dictation, because the mode is still worth
      having on a call, and dictation is the cheap half.
- [x] As an owner with several chat panes open, one keypress records into exactly ONE of them.
- [x] As an owner, I can SEE that the microphone heard me while I speak — a live level meter in the
      composer — because a take that heard nothing and a take that was never recorded used to be
      pixel-identical, and I only found out by waiting for a transcript that never arrived.
- [x] As an owner, the composer tells me its state without moving anything: the card's own edge
      carries the colour, so the send button does not jump while I aim at it.
- [x] As an owner, a repaired word is marked ON the word, so I do not have to map a list of changes
      back onto my own sentence.
- [x] As an owner, when the agent starts speaking, whatever the machine was already playing gets out
      of the way by itself, and comes back exactly as I left it when the answer ends.
- [x] As an owner with two J.A.R.V.I.S panes open, only ONE of them speaks — and the one that stayed
      quiet says so on screen rather than losing its answer silently.
- [x] As an owner, I can silence an answer I no longer want read (**Hush**) without killing the turn
      that is producing it.
- [ ] As an owner, I can run the whole mode offline on local whisper with no key at all —
      `local` and `auto` engines exist and are wired, but the offline path has not been through
      the owner's own end-to-end checklist.
- [ ] Manual owner checklist: a full spoken conversation in Turkish and in English, a deliberate
      mis-hearing to confirm it does not auto-submit, and the mode with speech off. The audio-focus
      half was run LIVE on 2026-09-11 against real macOS volume and passed the machine-facing
      items; three remain and are named with their reason in the acceptance criteria below.

## Acceptance Criteria

### The mode

- [x] `jarvis` is a real mode in all SIX stub sites — `src/server/chat-modes.ts` (`CHAT_MODES` +
      a non-empty `modeBriefing`), `agent-spawn-shared.ts` (`sanitizeChatMode` no longer coerces
      it), `dashboard/src/lib/chatModes.ts` (row no longer `disabled`/`Soon`),
      `AgentSurface.tsx` (`knownChatMode`), `SleepyMascot.tsx` (`gearForMode`), and the tests
      pinning each.
- [x] The briefing is deliberately SHORT and asks for two or three plain spoken sentences with
      any structure emitted as a `dream-html` block — the structure is looked at, not read.
- [x] A session's `mode` is `readonly`; changing it produces a NEW session object, so there is no
      mid-session mode switch to defend against.

### Capture

- [x] Push-to-talk only — no VAD, no always-listening, no wake word (owner's call).
- [x] The binding is stored as a PHYSICAL `code`, not `key`: on macOS ⌥+V arrives as `√`, so a
      `key`-based binding is unreproducible. Bare letters are REFUSED (a window-level listener
      would swallow them in the composer); F1–F20 are allowed alone.
- [x] `hold` and `toggle` are both offered per binding (`DEFAULT_PUSH_TO_TALK_MODE = 'hold'` —
      the one that cannot leave the microphone open by accident). `toggle` exists because a latch
      key reports on/off and is never "held", and because holding a modifier chord to speak is
      genuinely unpleasant.
- [x] One keypress has exactly ONE owner, chosen at press time: focused pane → sole visible pane
      → last touched → none. Chat panes never unmount, so without this N sessions = N microphones
      per keypress (`dashboard/src/lib/voice/pushToTalkScope.ts`).
- [x] The browser encodes its own **16 kHz WAV**. The transcription path takes `wav`/`mp3` only,
      `MediaRecorder` produces neither, and a webview has no converter — so there is no container
      probe and no ffmpeg anywhere in this feature.
- [x] The `AudioContext` is opened INSIDE the user gesture. Created after an `await
      getUserMedia`, WebKit leaves it `suspended` and its analyser returns zeroes, so the silence
      gate refused every take however loudly it was spoken. One `ScriptProcessor` now both records
      and measures, so the tape and the meter cannot disagree; the silence gate **fails open**
      when no measurement exists.
- [x] macOS prerequisite: `NSMicrophoneUsageDescription` in `desktop/src-tauri/Info.plist`.

### Trust — the part that is actually the feature

- [x] **A CHANGED transcript is NEVER auto-submitted.** Auto-submit is reachable only when the
      corrector's output is byte-identical to the raw transcript, or when the corrector never
      returned — in which case nothing was changed by definition. Anything else waits in the
      composer with the change marked.
- [x] The phonetic-distance check survives with ALL gating power removed: it decides only how
      loudly a change is drawn. A test reads the source to prove `correct.ts` branches on no
      distance at all.
- [x] Speech is CHECKABLE, not hoped-for: the returned `audio.transcript` is compared against the
      sentence that was meant to be read, retried once, and otherwise **refused rather than
      played** (`src/lib/voice/verbatim.ts`). That field — previously discarded — is the only
      evidence of what the user will actually hear.
- [x] An echo guard exists because on silence the speech model echoed the prompt back as though it
      were user speech, and that reached a tool-enabled agent (`src/lib/voice/echo.ts`).
- [x] Server-side concurrency and rate caps on the voice routes (`src/lib/voice/limits.ts`): these
      are the app's first routes that SPEND MONEY, and the existing threat model (loopback binding,
      network token, CSRF check) was scoped to no-cost file operations. An authenticated LAN peer
      is not stopped by any of the global guards.

### The composer — the HUD rail (2026-09-11)

- [x] The microphone is a DRAWN glyph (`MicIcon`, stroked SVG on `currentColor`), not the 🎙 emoji:
      an emoji is a different picture on every platform and **cannot take the state colour**, which
      is the one job the button now has.
- [x] The card's state is ONE attribute — `data-voice` on `.chat-cmp-card` — and the rail is an
      **inset box-shadow** keyed off it. No new element, no height change, nothing below the
      composer re-flows. The focus ring COMPOSES with the rail rather than replacing it.
- [x] The live meter takes the slot the placeholder already occupies (absolutely positioned over the
      textarea, `pointer-events: none`), so a take over half-typed text moves nothing.
- [x] The level NEVER goes through React state: `useVoiceCapture` publishes it through a ref'd
      callback and the composer fans it out (a **Set** — the meter mounts/unmounts with the take,
      the audio graph must not care) to a canvas on its own rAF. `levelSlices()` is pure and tested:
      four real measurements per 4096-sample frame (~47 Hz, not 12), trailing partial slice dropped.
- [x] Normalisation is FIXED (`FULL_SCALE`), never auto-gain — an auto-gained meter shows a loud bar
      for room tone, which is the exact lie the meter exists to prevent. A take the silence gate
      will refuse draws visible stubs. Transcription keeps the last picture DIMMED, never blank.
- [x] A repaired word is underlined WHERE IT SITS, through the pre-existing `.chat-cmp-hl` mention
      mirror — no second mirror was built. Marks are recomputed from the draft every render, never
      stored, so editing the sentence away drops the mark instead of pointing at moved text.
- [x] **`AlignOp.at` carries the corrected-token index**, recorded by the alignment walk and
      surviving `changedOps`. `changedOps` discards the `equal` ops, so without it the client has NO
      positional information at all; a mutation test proves the naive client-side `indexOf` picks
      the wrong word the moment a sentence repeats one ("taskini ac sonra taskini kapat").
- [x] A DELETION is never marked — there is nothing on screen to underline, and marking the gap or a
      neighbour would claim a word the owner CAN see was touched. Deletions are reported in words.
- [x] The four notice rows that appeared and vanished below the composer collapsed into the rail
      plus a two-job chip row (what was heard, what was dropped). The rule is unchanged: a changed
      transcript still never auto-sends.
- [ ] DEPARTURE, deliberate: per-word hover ("what was heard") is NOT built. `.chat-cmp-hl` is
      `pointer-events: none` because it is a mirror UNDER the textarea; giving a mark
      `pointer-events: auto` would swallow the caret click for that word. A real hover needs
      caret-position-from-point — worth doing, its own piece of work.

### Speaking — and the machine's own sound (2026-09-11)

- [x] `SpeechQueue` publishes a speaking signal (`onSpeaking` → `ChatSession` → `ComposerHost`) that
      hangs on the **FOCUS HOLD, not on playback**: the reply is still being written while it is
      read, so the queue empties repeatedly mid-answer and a play-time flag would flicker off in
      every gap. Pinned by a test that pushes three sentences and asserts ONE rise and no fall.
      It falls in `releaseFocus()` — the single place barge-in, interrupt, steer, disposal and the
      grace expiry all already reach — and is edge-triggered, firing on subscribe so a composer
      mounting mid-answer is not told the room is quiet.
- [x] A **Hush** control silences the answer and lets the turn finish — NOT Stop, which kills it.
      The capability existed (the mic press barges in) but nothing on screen said so. Hush and the
      rate readout live in the toolbar's flex SPACER, so nothing left or right of them moves when
      they appear — the same defect as the notice rows this direction replaced.
- [x] `--color-speaking` is a real token in BOTH themes. The obvious purple was unavailable:
      `--color-accent` IS Deep Violet here, so speaking would have looked identical to listening.
      The playback rate is shown WHERE IT APPLIES, hidden at 1x, tracking Settings live.
- [x] **The server owns the speaker** (`src/lib/voice/audioFocus.ts`, `POST /api/agent/voice/focus`):
      a single holder per turn, a second pane denied BY NAME (`granted:false, holder:"pane-A"`) so
      the composer can say why it is quiet, and a 120s watchdog that reclaims a turn whose heartbeat
      stopped. Server-side rather than a client module singleton because two app windows cannot see
      each other's `pushToTalkScope`.
- [x] Ownership is per TURN, not per chunk: taken at the first `enqueue` (inside the ~1.3s
      generation window, so the measured ~120ms osascript spawn never lands on the first word) and
      released **800ms after the queue empties**, so a late chunk does not re-pause the music.
- [x] Two levers in order of precision: a known player (Spotify) is PAUSED and resumed; anything we
      cannot address — a browser tab — only leaves the system output volume, which lowers OUR voice
      too, so the duck is paired with a compensating Web Audio `duckGain` **clamped at 3x** plus a
      limiter. `musicDuck = 1` means never duck and the graph is never built. Apple Music is out of
      scope by the owner's call; the player table grows by one row.
- [x] Only what WE paused/ducked is restored, and only if still in that state — a value the owner
      changed mid-answer is left alone, and a machine already muted or at 0 is skipped entirely.
      `process.on('exit')` does a synchronous best-effort restore; `stop()`, `dispose()` and every
      steer/interrupt path release both the floor and the music.
- [x] Permission failure (-1743) **fails open toward SPEAKING**, and the refusal is remembered rather
      than retried every turn. A focus route that is down or slow costs at most an answer read over
      music; treating a failed hold as "you may not speak" turns a cosmetic problem into a silent
      mode, and a silent mode is indistinguishable from a broken one (`OPEN_GRANT`, 4s
      `HOLD_TIMEOUT_MS`, a `keepalive` release that is never awaited — the most important release is
      the one sent while the page is being torn down).
- [x] Non-macOS: the music half is a no-op, but **the speaking floor works everywhere** — two voices
      over each other is not a macOS-specific problem. `NSAppleEventsUsageDescription` added to
      `desktop/src-tauri/Info.plist` beside `NSMicrophoneUsageDescription`.
- [x] `/focus` is gated (`focusGate`, 4 concurrent / 600 min, `session` bounded to 128 chars) because
      it spawns processes and changes the machine's volume. The real tooth is `MAX_SILENCE_MS`: the
      cap limits SILENCE, not the floor, because a renewable lease let a patient caller hold music
      paused forever under every rate limit.
- [ ] Owner checklist, three items open with their reason: Spotify pause/resume (Spotify.app is not
      installed on this machine — the duck path is the real path here, and it passed live), the
      compensation SOUNDING right (approximate by design — macOS's scale is assumed linear in
      amplitude, confirmed by ear not by measurement), and the two-pane "not read aloud" notice
      (client draws it only inside the Tauri webview, so it needs the real app).

### The key

- [x] ONE OpenRouter key serves all three calls (transcription, correction, speech). No OpenAI key
      is read, requested, or fallen back to anywhere.
- [x] The key lives at `~/.dreamcontext/voice.json`, written atomically at 0600, **per machine and
      never in a vault** — a vault-stored key would sync to a teammate's brain on the first team
      sync. An optional Groq key (transcription only) sits beside it.
- [x] The key NEVER leaves the server: `voiceStatus` reports a BOOLEAN plus the non-secret
      preferences. There is no route, no log line and no error path that returns the key itself.

### Settings

- [x] A collapsed **BETA** group at the bottom of Settings → Agents: key entry, optional Groq key,
      transcriber engine, push-to-talk binding + hold/toggle, speak on/off, speech rate
      (`0.75`–`1.75`, clamped rather than refused — every value in range still produces audio).
- [x] Two more rows in the same group (2026-09-11): `musicPause` (pause a known player) and
      `musicDuck` (lower everything else; **off-by-value — `1` means never duck**, so the setting is
      one number instead of a number plus a toggle that can disagree with it). Stored in
      `voice.json`, reported by `/status`.

- [x] AUDIO FOCUS: THE SERVER OWNS THE SPEAKER. `src/lib/voice/audioFocus.ts` holds a single holder, a watchdog that reclaims a turn whose heartbeat stopped, and a ledger of what was paused or ducked so the machine is put back exactly as it was found. A second pane asking for the floor is denied BY NAME (`granted:false, holder:"pane-A"`) rather than queued silently, so the composer can say why it is quiet — two panes in one window no longer answer on top of each other.

- [x] TWO LEVERS, IN ORDER OF PRECISION: a known player (Spotify, Music) is PAUSED and resumed; anything unaddressable (a browser tab) leaves only the system output volume. The app-running probe is TWO-STAGE — `return (application "X" is running)` needs no dictionary and compiles everywhere — because AppleScript resolves an app's own terms (`player state`) at COMPILE time, so a single combined script dies at -2741 when that app is absent and the is-running guard never runs. Measured both ways 2026-09-11. The probe does not LAUNCH the app.

- [x] THE DUCK NO LONGER TAKES ITS OWN VOICE DOWN. macOS output volume is the DEVICE master and our speech leaves through the same device, so ducking to 35% asked ~+9 dB of compensation on a signal already peaking near full scale — straight into the limiter, and the answer came out QUIETER than with the feature off. Default duck is now 1 (never touch the master) with a 0.5 floor below which compensation cannot give it back; `PLAYERS` gained `Music`, since pausing is the only lever that lowers everything EXCEPT us; and each chunk is levelled by `normalizeSpeech` before wrapping — the one point in the path where "louder" is actually achievable, since after it the audio is a WAV played through a volume this app does not own.

- [x] GAPLESS PLAYBACK, SCHEDULED IN WEB AUDIO. `ended` is the DECODER's verdict, not the speaker's, and assigning the next chunk's `src` runs the media-element load algorithm immediately, discarding whatever was still in the output buffer — every sentence was clipped at the end. Each chunk is now decoded and started at the exact sample the previous one ends on, ahead of its own playback, so the seam is a sample boundary rather than a race. The element survives as a fallback, guarded so a mid-turn fallback chunk cannot play on top of audio still scheduled.

- [x] THE SPOKEN SENTENCE IS MARKED IN THE MESSAGE IT CAME FROM, via the CSS Custom Highlight API — no node is inserted into a DOM React re-renders on every token. The chunk is raw markdown and the screen holds rendered text, so both sides are reduced to letters and single spaces before the search, and the match is mapped back to real DOM offsets.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-09-13]** **[2026-09-11] `duckGain` is clamped at 3x and the 0.35 default was chosen against that ceiling, not for roundness** — a speech signal already near full scale multiplied by 4 lives in the limiter, and pumping on the voice is worse than music audible under it. (Superseded 2026-09-12: the default duck became 1; the clamp reasoning stands.) A guard that needs the app's dictionary is not a guard — unit tests could never have caught the AppleScript compile-time failure, because the runner was stubbed.
- **[2026-09-13]** **[2026-09-12] `stop()` that neither resolves nor rejects is a permanent silent mode.** Pausing the element and clearing its `src` fires NEITHER `ended` NOR `error`, so the play loop awaited a promise that never settled: after the first barge-in the mode went permanently silent with nothing on screen to say so. A silent mode is indistinguishable from a broken one — which is also why the focus layer FAILS OPEN, toward speaking: a focus route that is down, slow or 403 costs at most an answer read over music, while treating a failed hold as "you may not speak" turns a cosmetic problem into a dead feature.
- **[2026-09-13]** **[2026-09-12] Dictation quality was never the model — it was the audio handed to it.** `getUserMedia({audio: true})` does not hand over the microphone; it hands over the microphone AFTER the browser's voice-call chain, and echo cancellation is the worst of the three here. The same model run by hand on clean audio was markedly better. Fix the capture constraints, not the transcription model.
- **[2026-09-11] The composer's direction was chosen from two drawn boards, and the REJECTED one is
  the half worth keeping.** `jarvis-composer-a-reactor` put a radial meter around the mic — and
  measured, it grew the composer's body slot by **104px** on every mic press, which is the exact
  re-flow (four notice rows appearing and vanishing under the composer while the owner aims at
  send) the redesign exists to END, reintroduced in a prettier and more frequent form. `-b-hud`
  won because every one of its signals is carried by something already in the layout: the state is
  an `inset` box-shadow on the card (no element, no height), the meter takes the placeholder's own
  slot, the repair marks reuse the mention mirror, and the speaking controls sit in the toolbar's
  flex spacer. **Rule that generalises: in a composer, a new signal must be paid for out of space
  that already exists — anything that grows the card is a regression however good it looks.** Both
  boards stay in `_dream_context/inbox/jarvis-composer-ui/` (see Notes for why they were not
  promoted).
- **[2026-09-11] The repair mark needed a SERVER field, and that is why the diff is on the words at
  all.** `AlignOp.at` (the corrected-token index) is recorded by the alignment walk and survives
  `changedOps` — which throws the `equal` ops away, leaving the client with no positional
  information whatsoever. The naive client-side fix (search the draft for the word) is wrong on the
  first sentence that repeats one, and a mutation test pins exactly that case
  (`[[pattern-mutation-test-assertions]]`). A deletion is still never marked: there is nothing on
  screen to underline, and marking the gap would claim a visible word was touched.
- **[2026-09-11] The speaking signal hangs on the FOCUS HOLD, not on playback — the queue is empty
  for most of an answer.** The reply is still being written while it is being read, so the chunk
  queue drains repeatedly mid-answer and a play-time flag would flicker off in every gap and take
  the button with it. Holding the signal on the turn-scoped floor gives one rise and no fall across
  three sentences, and it falls in `releaseFocus()` — the one place barge-in, interrupt, steer,
  disposal and the grace expiry ALL already converge, so there is no new path to forget.
- **[2026-09-11] One ledger owns both the speaker and the music, because two ownership books break
  in two different ways.** The floor (which pane may speak) and the machine's own sound (what was
  paused or ducked) are the same lifetime — taken at the first chunk, released 800ms after the last
  — so they are one server-side holder with one watchdog, not a client singleton (two app windows
  cannot see each other's) and not two routes. Concurrency forced a **mutex, not an epoch**: the
  problem was never only bookkeeping, it was two osascript conversations about the same Spotify at
  once, which produced music playing at full volume under an answer with no ledger entry able to
  stop it. **Fail open toward SPEAKING** throughout — a failed hold costs an answer read over music,
  while the opposite turns a cosmetic problem into a silent mode, and a silent mode is
  indistinguishable from a broken one.
- **[2026-09-11] An AppleScript guard cannot protect its own script.**
  `if application "Spotify" is running then tell application "Spotify" … player state …` does not
  compile when Spotify is absent: `player state` is Spotify's own dictionary term, AppleScript
  resolves it at COMPILE time, and compilation happens before a single line runs — so the safe
  looking is-running guard never executes and the whole thing dies at -2741 for every user without
  the app. Verified both ways the same day: the identical script compiled and returned "no" for
  installed Music, and exploded for absent Spotify. The probe is therefore two stages —
  `return (application "X" is running)` needs no dictionary, compiles everywhere, answers false for
  an absent app and does **not LAUNCH it** (measured: `tell application "Music"` started Music even
  with the Apple event REFUSED, so an agent saying one sentence would have opened a music player).
  **Unit tests could never have caught this — the runner was stubbed.**
- **[2026-09-11] The duck is paired with a compensating gain, clamped at 3x, because the naive fix
  inverts the feature.** Lowering system output lowers J.A.R.V.I.S by the same amount, so ducking
  alone makes the mode QUIETER than not having it. The compensation is approximate on purpose
  (macOS's volume scale is assumed linear in amplitude) and the 0.35 default was chosen against the
  3x ceiling, not for roundness: speech already near full scale multiplied by 4 lives in the
  limiter, and pumping on the voice is worse than music audible under it.
- **[2026-09-11] The speaking-speed setting never once took effect, and the reason is one
  line of ordering.** `SpeechQueue.play()` set `el.playbackRate` and THEN `el.src = url`.
  Assigning `src` runs the media element load algorithm, whose last step is "set the
  `playbackRate` attribute to the value of the `defaultPlaybackRate` attribute" —
  unconditionally, on every load. So the rate was erased by the very next statement and every
  chunk played at 1x, while the value was stored, PUT, reported by `/status` and rendered in
  the Settings row correctly the whole time. **Rule that generalises: a media property written
  before `src` is not configuration, it is a guess** — `defaultPlaybackRate` is the one the
  load survives. The regression test fakes the reset rather than the field, because a fake
  that merely stored `playbackRate` passes on the broken code and proves nothing
  (`[[pattern-mutation-test-assertions]]`).
- **[2026-09-11] The rescue path ignored the Voice setting, and the voices are now matched by
  MEASURED pitch.** `speakWithRealTts` sent a hardcoded `Charon`, so a chunk the chat model
  refused to read came back as a different person from the sentence before it. The fallback
  model does not share the chat model's voice list — it would 400 on `onyx` — so the fix is a
  translation table built from median F0 of the same Turkish line through every voice
  (`FALLBACK_VOICES`, `openrouter.ts`), not from the provider's adjectives. A refused voice
  retries once with `Charon`: the rescue path exists so a sentence is not lost, and must not
  become a new way to lose one over a preference. Measured the same day: the chat path honours
  the picked voice correctly (onyx 103 Hz → nova 192 Hz) and the verbatim guard passed 8/8 on
  short conversational chunks, so the fallback is rare — this was a latent bug, not the one
  the owner heard.

- **[2026-09-08] The default transcriber is `cloud`, and the earlier "no audio models on
  OpenRouter" conclusion was WRONG.** The audio endpoints have their **own namespace, invisible in
  `/models`** — so resolving an audio model against that catalogue reports "no model matched" for
  models that work perfectly well. That is the error the owner saw, and it produced one wrong
  correction before the right one. The real recogniser is `openai/whisper-large-v3-turbo` on the
  transcription endpoint: ~0.7–1.1s, ~$0.0001 a take, detects its own language, no 1.5 GB resident
  model and no laptop CPU. `local` (whisper.cpp) and `auto` remain wired for offline/free-forever
  use. **Rule that generalises: a provider's model catalogue is not the authority on what its
  non-chat endpoints accept.**
- **[2026-09-08] Groq is an optional SECOND provider purely because OpenRouter's routing is not
  something a push-to-talk key can trust.** Measured: the same file returned 1.3s / 9.2s / 14.2s /
  1.3s. The model is right; the routing is not. Groq serves the same `whisper-large-v3-turbo` on
  its own hardware at ~200x realtime with a free tier covering this feature's whole usage. Optional
  because it is a second account — without it everything still works.
- **[2026-09-08] Speech stays `openai/gpt-audio-mini` because it MEASURED faster** — 0.31–0.55x
  realtime against `google/gemini-3.1-flash-tts-preview`'s 0.75–1.37x, at equal fidelity when the
  output is fed back through whisper and compared. Gemini is wired as the **rescue path** instead: a
  real TTS cannot answer a line instead of reading it, so a chunk the chat model refuses twice is
  spoken rather than dropped into silence.
- **[2026-09-08] The correction model is `gemini-2.5-flash-lite`, switched from `gpt-4o-mini` for
  speed AND for safety** — 1891ms → 615ms, and `gpt-4o-mini` rewrote "lab insight'larını" as
  "labın şifrelerini". A corrector that invents a plausible different sentence is worse than none.
- **[2026-09-08] Two measured traps in hinting whisper with the project lexicon**, both
  counter-intuitive enough to be worth the record: (1) the hint improves accuracy but **breaks
  language detection** (Turkish read as English), so the hint may only be sent AFTER the language is
  known; (2) the hint must be a **punctuated sentence** — a bare word list makes whisper emit
  unpunctuated text, which is exactly what the chunker splits on.
- **[2026-09-08] Wrapping the line to be read as a script in «...» took verbatim reads from 1/3 to
  9/9**, and chunk boundaries moved to punctuation (sentence end → comma/semicolon/dash → space
  only past 240 chars).
- **[2026-09-07] A PROMPT CAN NEVER BE THE FIX for a chat model asked to behave as a TTS engine.**
  Measured: 5 of 7 sentences were *answered* instead of read. Prompt engineering reached 21/24 — and
  the residual failures are STOCHASTIC, which is the whole point. The verifier separates cleanly
  (worst good read 0.70 vs best bad read 0.27), so the answer was to make the output checkable
  rather than to write a better instruction. Sub-1s takes are unreliable on any prompt or model
  ("Tamam" → "Tomorrow" / "Thamar").
- **[2026-09-07] The numeric phonetic veto was REPLACED by a behavioural rule, and that removed a
  whole defensive subsystem.** An adversarial search broke the 0.75 threshold in **11 of 21**
  dangerous pairs, and the finding came from two independent review lenses. No threshold separates
  the classes: the legitimate `Sırıp`→`sleep` and the hostile `start`→`stop` score the same, and
  `kaydet`→`kaldır` needs no attacker at all because `kaldır` is a word an ordinary task title puts
  in the lexicon. Replacing the number with "a changed transcript never auto-submits" closed four
  findings at once. **The general lesson: when a numeric safety threshold keeps losing to
  adversarial input, look for the behavioural rule that makes the number unnecessary.**
- **[2026-09-07] The chunker is fence-aware, and that is not polish.** The briefing asks for a
  `dream-html` block on every structured answer, so most replies contain one; `speakable.ts` cannot
  repair that afterwards, because by then the tag soup has already been carved into "sentences".
- **[2026-09-07] Spoken offsets are keyed to the reducer's own item ids, never the raw stream.**
- **[2026-09-06] The keyword lexicon lives in a post-transcription CORRECTION PASS, not in the
  decoder prompt** — OpenRouter documents the transcription `prompt` as "accepted but ignored".
- **[2026-09-06] The correction pass is a MODEL CALL, not a string match, and that was measured
  before it was chosen.** A local fuzzy matcher (Levenshtein over Turkish-folded tokens) against a
  real 608-term lexicon built from this brain's own task files got 3 of 8, two of them not ranked
  first, and missed the motivating case outright (`Sırıp`→`sleep`: top candidate `script` at 0.33;
  `sleep` not in the top three). The failure is STRUCTURAL — a cross-language phonetic confusion is
  not a typo and edit distance cannot see it — and `lag`→`flag` showed that a threshold loose enough
  to catch the real cases would actively CORRUPT correct transcripts.
- **[2026-09-06] Push-to-talk, no VAD/wake word; J.A.R.V.I.S is a separate MODE reviving the
  disabled stub; it gets its own mascot gear; validation is unit tests plus a manual checklist**
  (owner's calls, settled — do not re-litigate).
- **[2026-09-06] Local whisper and local TTS were measured and SHELVED, not rejected.** Local
  whisper saves ~$1/month, and OpenAI-via-anyone at $15/1M characters is already the floor of hosted
  TTS (Cartesia and ElevenLabs 3x, premium voices 15x). Both go on one "later, opt-in in Settings"
  shelf — two things on one shelf is one job.
- **Known and not fixed:** `wry 0.55.1` grants WKWebView media capture **unconditionally**,
  discarding `_origin` and `_frame` (`wry_web_view_ui_delegate.rs:126-137` →
  `WKPermissionDecision::Grant`). The app is non-sandboxed, so nothing below us gates the
  microphone by origin. Recorded as a security property of the host, not of this feature.

## Technical Details

**Server** (`src/lib/voice/`): `config.ts` (the `voice.json` schema, the 0600 atomic write reused
from `claude-account-sandbox.ts:139`, and every default), `openrouter.ts` (the three upstream
calls), `whisper.ts` (the local whisper.cpp engine — note its default is ENGLISH, not detect),
`correct.ts` (the correction pass; branches on no phonetic distance at all), `lexicon.ts` (the
project-term lexicon built from the brain's own task files), `verbatim.ts` (the read-back check),
`echo.ts` (the silence-echo guard), `speakable.ts` (fence-aware chunking), `align.ts`, `wav.ts`,
`hotkey.ts` (canonical chord form, `normalizeHotkey` / `effectiveMode`), `limits.ts` (concurrency
and rate caps, incl. `FOCUS_LIMITS`), `align.ts` (the alignment walk — `AlignOp.at` is the corrected
-token index), `audioFocus.ts` (the single speaker holder + the pause/duck ledger, serialised behind
a mutex, watchdog, synchronous exit restore). Routes: `src/server/routes/agent-voice.ts`, including
`POST /api/agent/voice/focus`.

**Client** (`dashboard/src/lib/voice/`): `useVoiceCapture.ts` (gesture-scoped `AudioContext`, the
single ScriptProcessor, the fail-open silence gate, the ref'd `onLevel` publisher and the pure
`levelSlices()`), `wavEncoder.ts` (the 16 kHz WAV), `pushToTalkScope.ts` (the single-owner election
*within one window*), `speechQueue.ts` (the continuous playback queue, the turn-scoped focus hold,
the 800ms grace, `onSpeaking`, `ensureAudible()` and the duck-gain compensation),
`audioFocus.ts` (client half + the "not read aloud" announcement), `repairMarks.ts` (pure; rebuilds
the draft byte-for-byte and returns marks by position), `hotkey.ts` + `hotkeyDefaults.ts`
(physical-`code` bindings), `voicePrefs.ts`.

**Composer** (`dashboard/src/components/sleepy/chat/`): `Composer.tsx` (`MicIcon`, derived
`voiceState` → `data-voice`, the level fan-out Set, the repair segments on the existing
`.chat-cmp-hl` mention mirror, Hush + the rate readout in the toolbar's flex spacer),
`VoiceMeter.tsx` (canvas + its own rAF, subscribe-based, fixed normalisation, right-aligned ring
history), `composer.css` (`--cmp-rail`, the four state rules, `.chat-cmp-meter`), `chatSession.ts`
(the queue is keyed by `claudeId`).

**Two known defects this work closed that were NOT in its brief:** the speaking-rate setting had
never taken effect (the `playbackRate`/`src` ordering above), and two panes in one window each built
a `SpeechQueue` and spoke over each other — panes never unmount, so that had always been reachable.

**Defaults:** voice `onyx` (deep — the closest this provider gets to the character), push-to-talk
`Alt+Space` in `hold` mode, speech rate `1` clamped to `0.75`–`1.75`, `sttLanguage: 'auto'` (sends
no `language` at all), `sttEngine: 'cloud'`, correction on.

**Not yet proven:** `sttLanguage: 'auto'` on SHORT takes is unproven on this code path — the only
benchmark ever run used an explicit `-l tr` against LOCAL whisper, which is a different path. The
documented escape hatch is pinning a language in `voice.json` rather than a code change.

## Notes

**Plan review record.** `[[plans/jarvis-mode-plan-v7]]` — three full rounds by four lenses
(critic / pragmatist / edge-cases / security), 32 blocking findings. v2 dropped local whisper on a
cost measurement; v3 moved everything to OpenRouter and relocated the lexicon into a correction
pass; v7 changed the SAFETY MODEL itself after the adversarial search broke the phonetic veto.

**The plan's own escape hatch is what caught its biggest error.** Every model id in the plan came
from an announcement blog post rather than the models API — and the plan said so out loud, and
required Wave 1 to resolve real ids at implementation time. That written caveat is the only reason
the wrong-transport premise was caught on the owner's first real push-to-talk rather than shipped.

**The exploration boards, and why they stayed dark.** `_dream_context/inbox/jarvis-composer-ui/`
holds `jarvis-composer-a-reactor.excalidraw.md` (rejected) and `jarvis-composer-b-hud.excalidraw.md`
(chosen), plus their generators. They were NOT promoted into a `knowledge/` context folder: they are
pre-build mockups of a question that is now answered in shipped code, so they begin drifting from
the implementation the moment they are canonised, and a stale mockup in knowledge is worse than no
board. **The durable half — the rejected direction's measured 104px body growth and the rule it
produced — is prose in Constraints & Decisions above, where it cannot go stale.** Promote a board
here only if one is redrawn to describe what the composer actually IS.

**This feature was built by two sessions in one checkout**, which is why `b25a168a` deliberately
held back five files (`Composer.tsx`, `speechQueue.ts`, `chatSession.ts`, `agent-voice.ts`,
`voice-chunker.test.ts`) and `c69ed2c1` landed them jointly: there was no commit containing this
feature's UI that did not also contain the other session's audio-focus work. See
`[[patterns/multi-session-checkout-safety]]`, whose Rule 5 this window added.

**Open, offered but not built:** end-to-end TTS streaming (~300ms to first audio, free, and the
agent's own recommended next step), and an ElevenLabs path.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-09-11 - Reconciled: the composer HUD rail and the audio-focus layer
- Reconciled at sleep against `b25a168a` (mic glyph, `data-voice` rail, live meter, `AlignOp.at`
  repair marks, `--color-speaking`, the playbackRate ordering fix) and `c69ed2c1` (the audio-focus
  layer: single speaker owner per turn, Spotify pause or system duck with Web Audio compensation,
  800ms grace, watchdog, `/focus`), plus the two tasks that shipped them. +8 user stories, +2
  acceptance-criteria sections (23 ticked, 4 explicitly open with their reason), +6 constraints,
  Technical Details replaced. `status: in_review` and `released_version: null` UNCHANGED: three
  owner-checklist items remain and are open for stated reasons (no Spotify.app on this machine, the
  compensation is ear-confirmed by design, the two-pane notice needs the real Tauri webview).
- Deliberately NOT done: no second PRD, and no knowledge file for the HUD-rail direction — the
  dedup pass returned the PRD itself as its nearest neighbour, and this feature is that content's
  home. The two exploration boards stayed in `inbox/` (reasoning in Notes).

### 2026-09-10 - Created
- Feature PRD created retrospectively at sleep from `3d86451e` (the mode) and `e425dc02` (real
  transcriber, real script, settings home), the sessions of 2026-09-07/08, and
  `[[plans/jarvis-mode-plan-v7]]`. Grounded against `src/lib/voice/config.ts` rather than the plan
  or the session summaries — both of which still carried the superseded "default is local whisper"
  and "OpenRouter serves no audio models" claims. `status: in_review`, `released_version: null`:
  the mode is not in 0.27.0 (which shipped 2026-09-06, before both commits) and the owner's manual
  checklist is unticked.
