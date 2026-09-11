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
updated: '2026-09-11'
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
related_tasks:
  - jarvis-konusurken-muzik-kendiliginden-susar-ve-cevap-bitince-geri-gelir
  - >-
    jarvis-composer-bir-durum-rayi-canli-ses-olcer-ve-kelime-ustu-duzeltme-kazanir
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
- [ ] As an owner, I can run the whole mode offline on local whisper with no key at all —
      `local` and `auto` engines exist and are wired, but the offline path has not been through
      the owner's own end-to-end checklist.
- [ ] Manual owner checklist: a full spoken conversation in Turkish and in English, a deliberate
      mis-hearing to confirm it does not auto-submit, and the mode with speech off.

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

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

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
and rate caps). One route: `src/server/routes/agent-voice.ts`.

**Client** (`dashboard/src/lib/voice/`): `useVoiceCapture.ts` (gesture-scoped `AudioContext`, the
single ScriptProcessor, the fail-open silence gate), `wavEncoder.ts` (the 16 kHz WAV),
`pushToTalkScope.ts` (the single-owner election), `speechQueue.ts` (the continuous playback queue),
`hotkey.ts` + `hotkeyDefaults.ts` (physical-`code` bindings), `voicePrefs.ts`.

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

**Open, offered but not built:** end-to-end TTS streaming (~300ms to first audio, free, and the
agent's own recommended next step), and an ElevenLabs path.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-09-10 - Created
- Feature PRD created retrospectively at sleep from `3d86451e` (the mode) and `e425dc02` (real
  transcriber, real script, settings home), the sessions of 2026-09-07/08, and
  `[[plans/jarvis-mode-plan-v7]]`. Grounded against `src/lib/voice/config.ts` rather than the plan
  or the session summaries — both of which still carried the superseded "default is local whisper"
  and "OpenRouter serves no audio models" claims. `status: in_review`, `released_version: null`:
  the mode is not in 0.27.0 (which shipped 2026-09-06, before both commits) and the owner's manual
  checklist is unticked.
