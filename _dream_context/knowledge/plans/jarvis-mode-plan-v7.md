# PLAN v7 — J.A.R.V.I.S mode (dreamcontext chat surface)

Repo: /Users/mehmetnuraydin/projects/dreamcontext

REVISION HISTORY — three full review rounds by four lenses (critic, pragmatist, edge-cases,
security), 32 blocking findings raised and addressed:
- **v1** → all four NEEDS_WORK, 15 findings.
- **v2** — local whisper dropped after a cost measurement showed it saved ~$1/month.
- **v3** — everything moved to OpenRouter at the owner's direction. Because OpenRouter
  documents the transcription `prompt` as "accepted but ignored", the keyword lexicon moved
  into a NEW transcript correction pass. Round 2: 9 findings.
- **v6** — round 3: pragmatist SOLID; critic, edge-cases and security each found more.
- **v7 (this)** — the safety model CHANGED. An adversarial search broke the 0.75 phonetic
  veto (11 bypasses of 21 dangerous pairs), and the same finding came from two independent
  lenses. The owner's call replaced the numeric control with a behavioural one: a corrected
  transcript that differs from the raw one in ANY way is never auto-submitted. That removed a
  whole defensive subsystem and closed four findings at once.

## CORRECTION — 2026-09-07, from the owner's first real push-to-talk

**The transport in this plan was wrong, and the plan's own escape hatch caught it.** Every
model id below came from an announcement blog post rather than the models API, which the plan
said out loud — but the mistake was one layer deeper than "an id was renamed": on OpenRouter
today there is **no transcription or TTS model at all**. Both OpenAI-compatible routes ANSWER
(`/audio/transcriptions` and `/audio/speech` validate a `model` field), and every id we asked
for returns "Model … does not exist". Measured against the live API on the owner's key.

What shipped instead, verified end to end through our own routes:

| | Plan said | Actually |
|---|---|---|
| STT | `POST /audio/transcriptions`, multipart, `gpt-4o-mini-transcribe` | `POST /chat/completions`, base64 `input_audio` part, `openai/gpt-audio-mini` |
| TTS | `POST /audio/speech`, mp3 out, `instructions` parameter | `POST /chat/completions`, `stream:true` + `modalities:['text','audio']`, pcm16 out |
| Container | whatever `MediaRecorder` produced, "no conversion step anywhere" | the browser encodes its **own 16 kHz WAV** — upstream accepts `wav`/`mp3` only |

Three consequences worth carrying forward:

1. **The prompt is what makes a chat model a TTS engine — and it is NOT ENOUGH.** With a weak
   instruction `gpt-audio-mini` ANSWERS the text instead of reading it ("Systems online." came
   back as "Understood, everything seems stable…"). The verbatim rule fixed the one sentence
   it was measured against, and that sample was too small: see the correction below.
### Correction, 2026-09-07 — the prompt was never going to be enough on its own

The owner's first real conversation in the mode surfaced three defects that one round of
measurement had hidden. All three are the SAME failure underneath: when this model does not
do the job it was asked to do, it answers the prompt instead — and nothing downstream could
tell the difference.

| Symptom the owner met | What was measured | What it is now |
|---|---|---|
| The voice "kept saying UNDERSTOOD" over a reply that said something else | 5 of 7 conversational lines came back as a fresh ANSWER, not a reading — every short sentence in a reply, so a whole answer's worth | Script framing + a two-turn few-shot (21/24), and `verbatim.ts` CHECKS the `audio.transcript` against the line: mismatch → one retry → drop the chunk |
| The transcription prompt appeared in the chat as the owner's own message | 1.5 s of room tone, three takes, three verbatim echoes of the ask — submitted to a tool-enabled agent | The ask names a `NO_SPEECH` sentinel (3/3), and `echo.ts` drops a reply that is the ask, the sentinel, or commentary |
| The chord opened the microphone in other tabs, and in another project's window | Every live chat pane is portaled and never unmounts, so N J.A.R.V.I.S sessions meant N `window` listeners and N microphones per press | `pushToTalkScope.ts` picks ONE owner per press: focused pane → the only visible one → last touched → nobody |

Two lessons worth carrying past this feature:

- **The residue is stochastic, so a prompt cannot be the fix.** The same sentence was read
  correctly in one round and answered in the next. A prompt makes the failure rare; only a
  check makes it harmless. Both halves ship, and neither is redundant.
- **The `transcript` field on an audio delta was documented as "useless to us".** It is the
  only evidence of what the owner is about to HEAR, and discarding it is what let a voice hold
  a different conversation from the transcript for a whole session.

What the fixes do NOT cover, measured and left honest: takes under about a second are
unreliable on this provider whatever the prompt says ("Tamam" came back as "Tomorrow",
"Thamar" and "afternoon" across prompts, part orderings and both audio models). A hallucinated
word is undetectable from the server; the correction pass and the confirmation row are what
stand behind it.

2. **The silence gate had been vetoing every take**, and not because of the room: the meter's
   `AudioContext` was created after `await getUserMedia`, so WebKit left it `suspended` and
   the analyser returned zeroes. The context is now opened inside the gesture, and the tape
   and the meter read the SAME frames, so the two can no longer disagree.
3. **Measured cost and latency, on the owner's key:** a 3s take transcribes in ~1.3s for
   ~$0.00007; 4.75s of speech generates in 1.7s (0.36x realtime, so the queue stays ahead of
   playback). The `$15/1M characters` floor argument below is obsolete — this is priced in
   audio tokens.

Also changed at the owner's request, same day: the push-to-talk binding is configurable
(Settings → Agents → Voice, folded, BETA), and a **latch** binding is supported — Caps Lock
starts and ends the take, because macOS reports it as on/off rather than held, which makes the
keyboard light the recording indicator. Everything below this line is the plan as it was
approved; read it with this correction in hand.

---

## Goal
The chat composer's fourth mode becomes real: push-to-talk voice IN, spoken voice OUT
(sentence-batched into a continuous queue), and a SHORT briefing that makes the agent speak
two or three human sentences while putting the structure on screen as a `dream-html` block.

## Decisions taken by the owner (settled — do not re-litigate)
1. Push-to-talk. No VAD, no always-listening, no wake word.
2. **Everything runs through OpenRouter — the owner's existing key. Never ask for an OpenAI
   key.** OpenRouter shipped both audio endpoints in July 2026 and both are OpenAI-compatible.
   Measured first: local whisper saves ~$1/month, and OpenAI-via-anyone at $15/1M characters
   is already the floor of hosted TTS (Cartesia and ElevenLabs 3x, premium voices 15x). Local
   whisper (whisper.cpp) and local TTS (Kokoro-82M) go on a shared "later, opt-in in Settings"
   shelf — two things on one shelf is one job, cheaper than two.
3. TTS uses the **`instructions` parameter** for the JARVIS character rather than buying a
   different provider. A deep voice plus a persona instruction is the accepted trade for the
   absent British male voice.
4. **The keyword lexicon moves from whisper's decoder prompt to a post-transcription
   CORRECTION PASS**, because OpenRouter's transcription endpoint documents `prompt` as
   "accepted but ignored". This is new in v3 and is the biggest thing to review.
5. J.A.R.V.I.S is a separate MODE (revives the existing disabled stub).
6. It gets its **own mascot gear** (owner's call — Plan and Develop each have one).
7. Validation = unit tests + a manual checklist.

## Verified facts this plan rests on
- OpenRouter exposes `POST https://openrouter.ai/api/v1/audio/transcriptions` (OpenAI-
  compatible multipart: `file`, `model`, `language`, `temperature`, `response_format`; 25 MB
  cap; wav, mp3, flac, m4a, ogg, webm, aac) and `POST .../audio/speech` (`model`, `input`,
  `voice`, `response_format` mp3|pcm, and **`instructions` for tone** — the parameter the
  JARVIS character depends on). **This is why there is no ffmpeg in this plan at all**:
  whatever container the WebView's MediaRecorder produces is uploadable as-is.
- **OpenRouter's transcription endpoint documents `prompt` as "accepted but ignored."** This
  is the constraint that reshapes v3: the brain lexicon cannot bias the decoder, so it moves
  downstream into a correction pass (Wave 1b).
- **MEASURED, and it is why Wave 1b is a model call and not a string match.** A local fuzzy
  matcher (Levenshtein over Turkish-folded tokens) was run against a real 608-term lexicon
  built from this brain's own task files, on the cases this plan cites:
  `Sırıp`→sleep MISSED (top candidate `script` at 0.33; `sleep` not even in the top three),
  `lag`→lab MISSED (`flag` at 0.25 — the WRONG answer scores closer than the right one),
  `dram`→dreamcontext MISSED, `konsolide`→konsolidasyon found only at rank 2,
  `insayt`→insight tied with `install`, `vorktri`→worktree found. Three of eight tokens, two
  of those not ranked first, and a total miss on the motivating case.
  The failure is STRUCTURAL, not a tuning problem: "Sırıp" is a cross-language phonetic
  confusion, not a typo, and edit distance cannot see it. Worse, `lag`→`flag` shows a
  threshold loose enough to catch the real cases would actively CORRUPT correct transcripts.
  The cheap option was tried first and measured insufficient; this is evidence, not an
  assumption.
- Model ids seen in OpenRouter's own announcement — speech: `openai/gpt-4o-mini-tts-*`,
  `google/gemini-3.1-flash-tts-preview`, `mistralai/voxtral-mini-tts-*`; transcription:
  `openai/gpt-4o-mini-transcribe`, `openai/gpt-4o-transcribe`, `openai/whisper-large-v3`,
  `google/chirp-3`. These came from a blog post, NOT from the models API. **Wave 1 resolves
  the real ids from OpenRouter's models endpoint at implementation time and never hardcodes
  one on faith.** A wrong id is a 404 on the first push-to-talk.
- No streaming on the speech endpoint. Our design does not depend on it — sentence batching
  IS the substitute, and that was true before this was known.
- Precedent in a connected project (Tilki): OpenRouter primary with a direct-provider key as
  fallback is a pattern this owner already runs in production.
- Measured on this machine, and the reason the lexicon is load-bearing rather than a nicety:
  the phrase "Sleep başlat" transcribed as **"Sırıp başlat"** with no keyword prompt and
  **"sleep, başlat"** with one. Same audio, same model, only the prompt differed.
- `wry 0.55.1` grants WKWebView media capture unconditionally, **discarding `_origin` and
  `_frame`** (`wry_web_view_ui_delegate.rs:126-137` → `WKPermissionDecision::Grant`). The app
  is non-sandboxed (`desktop/src-tauri/entitlements.plist`), so the only missing macOS piece
  is `NSMicrophoneUsageDescription` in `desktop/src-tauri/Info.plist` — and the unconditional
  grant is a security problem in its own right, handled in Wave 0.
- The agent-authored HTML iframe carries `sandbox={CHAT_HTML_SANDBOX}` and no `allow`
  attribute (`dashboard/src/components/sleepy/chat/HtmlView.tsx:200-205`).
  `CHAT_HTML_SANDBOX` re-exports `SANDBOX_GRANT = 'allow-scripts'`
  (`dashboard/src/lib/sandboxHtml.ts:51`), shared with the Lab. `SANDBOX_CSP` (:47-48) has no
  `Permissions-Policy` — CSP governs fetch, not device permissions.
- The jarvis stub exists in SIX places, not four (v1 missed the last two):
  `src/server/chat-modes.ts:26` (`CHAT_MODES`) and its `modeBriefing` `case 'jarvis'` → `''`;
  `src/server/routes/agent-spawn-shared.ts:113` (`sanitizeChatMode` coerces to basic);
  `dashboard/src/lib/chatModes.ts` (row `disabled` + `Soon` badge);
  `tests/unit/chat-modes.test.ts:40` and `:126`; `tests/unit/chat-mode-mirror.test.ts`;
  **`dashboard/src/components/sleepy/AgentSurface.tsx:220-227`** (`knownChatMode()` filters on
  `!r.disabled`, with a doc comment stating an invariant this plan makes false); and
  **`dashboard/src/components/sleepy/SleepyMascot.tsx:26-30`** (`gearForMode` maps jarvis to
  `null`) with `tests/unit/mascot-mode-gear.test.ts:26-30` pinning it.
- `mode` is a `readonly` field on a chat session (`chatSession.ts:301-313`): changing it goes
  through `AgentSurface.changeChatMode`, which produces a NEW session object. There is no
  mid-session mode switch to defend against; a session's mode is fixed for its lifetime.
- Briefings reach the CLI as ONE temp file at mode 0o600:
  `src/server/routes/agent-chat.ts:577-596` writes `CHAT_SURFACE_BRIEFING + modeBriefing(…)`
  and passes `--append-system-prompt-file`.
- Client frame vocabulary (`dashboard/src/lib/chatProtocol.ts`): `text_delta` → `text-delta`
  (:531); a short reply may arrive with NO deltas at all, making the `assistant-text` echo the
  only guaranteed carrier of the full block (:147-151, :587).
- **`frameParent()` (`chatProtocol.ts:495`) is the single sub-agent gate, and
  `fromAssistant` computes `parentToolUseId` at :683 but attaches it ONLY to the `tool_use`
  and `tool_result` branches — the TEXT branch at :705 omits it**, and the reducer's
  `assistant-text` arm (`chatSession.ts:869`) has no parent guard, unlike the tool arms at
  :801 and :850. Confirmed by reading both files.
- Reducer arms: `block-start` :786 (creates a NEW item per stream index), `text-delta` :818,
  `block-stop` :830, `assistant-text` :869, `result` :1180, `subscribe` :683,
  `interrupt()` :1447, `steer()` :1309.
- Composer submit: `dashboard/src/components/sleepy/chat/Composer.tsx:755`.
- Binary-upload precedent: `src/server/routes/agent-drop.ts` — desktop-gated, vault-scoped by
  `X-Dreamcontext-Vault`, per-chunk cap that never buffers past the limit, TTL prune.
  Registered `src/server/index.ts:424`. `VAULT_AGNOSTIC_PREFIXES` at `src/server/index.ts:625`
  requires every new route to be explicitly classified.
- Global guards: `isCrossSiteWrite` (`src/server/middleware.ts:65-71`) and the network token
  (`src/server/network-auth.ts:46-70`) are process-level and apply to any new route — but
  neither stops an authenticated LAN peer.
  **The next sentence is the PLAN'S OWN REASONING, not a citation.** An earlier draft claimed
  `_dream_context/knowledge/dashboard-server-security.md:70-78` "documents that the threat
  model treats that peer as trusted for FREE operations". Re-reading that file: it describes
  the token gate for read/write FILE operations and makes no free-versus-paid distinction
  anywhere. The inference is mine and is stated as mine: the existing threat model was scoped
  to no-cost file operations, so a money-spending route is a blast radius that document never
  considered. The mitigation (server-side concurrency and rate caps, AC12) stands on its own
  and does not depend on the citation.

- Secret-file precedent: `src/lib/claude-account-sandbox.ts:139` (atomic write at 0o600).
- Settings groups: `dashboard/src/pages/SettingsPage.tsx:131` (`settings.group.machine`).
- Project HARD RULE (`_dream_context/core/0.soul.md:33`): every change updates skill +
  references, agents/packs, and README + DEEP-DIVE. `skill/SKILL.md:100` and
  `skill/references/integrations.md:303` both currently say J.A.R.V.I.S is disabled/Soon.

## Wave 0 — the two one-line prerequisites, FIRST

Moved to the front because nothing downstream is testable in the real app without them
(pragmatist P1), and because one of them is the most serious finding any lens returned.

1. `desktop/src-tauri/Info.plist`: add `NSMicrophoneUsageDescription`. Without it a
   non-sandboxed WKWebView's `getUserMedia` is denied, so every later wave would be
   unverifiable until the very end.
2. **Close the mic path from agent-rendered HTML — at ALL THREE render sites (security S1).**
   wry's delegate discards origin and frame and always grants
   (`wry_web_view_ui_delegate.rs:126-137`), so after ONE legitimate push-to-talk satisfies the
   process-wide TCC prompt, nothing at the OS or WebKit layer stands between rendered HTML and
   the microphone.
   **`sandbox` and `allow` are INDEPENDENT iframe attributes**, so defining a constant changes
   nothing until each JSX site uses it — an earlier draft claimed "Chat and Lab both get it"
   from a single shared-constant edit, and that claim was FALSE. A grep for `allow=` on any
   iframe in the dashboard returns zero matches today. Add `allow=""` (via a new
   `SANDBOX_ALLOW` in `dashboard/src/lib/sandboxHtml.ts`) at every site:
   - `dashboard/src/components/sleepy/chat/HtmlView.tsx:204` — the `dream-html` block.
   - `dashboard/src/components/lab/LabAppFrame.tsx:268` — imports `SANDBOX_GRANT` directly.
   - `dashboard/src/components/lab/HtmlInsightBody.tsx:54` — via `labHtmlKit.ts`'s own re-export.
   The Lab pair matters MORE, not less: `lab/scripts/<slug>.mjs` output is the same
   "a teammate can sync it into the repo" trust class as the lexicon, and it renders
   automatically every session with no user-attention moment like pressing a mic button.
   AC11 covers all three surfaces, not just `dream-html`.

## Wave 1 — STT route

NEW `src/server/routes/agent-voice.ts`, registered in `src/server/index.ts` beside
`/api/agent/drop`, and **explicitly classified** against `VAULT_AGNOSTIC_PREFIXES`
(security S2): vault-SCOPED, because the lexicon is read from the vault's brain.

- `POST /api/agent/voice/stt` — `isDesktop()`-gated, vault-scoped by `X-Dreamcontext-Vault`,
  behind the existing CSRF and network-token guards. Body: raw audio bytes. Per-chunk cap
  copied verbatim from `agent-drop.ts` (never buffers past the limit), set to OpenAI's own
  25 MB ceiling.
- Forwards to OpenRouter `/api/v1/audio/transcriptions` as multipart: the bytes as-is (no
  conversion — every container MediaRecorder can produce is on the accepted list) and
  `model` = a transcription id RESOLVED from OpenRouter's models endpoint, not hardcoded.
- **No `prompt` is sent** — OpenRouter documents it as ignored. Sending it would be a lie in
  the code about where accuracy comes from. Accuracy comes from Wave 1b.
- **Server-side caps, not client-side (security S2):** a cap on concurrent in-flight STT
  requests (reject past N with 429) and a per-time-window request cap. These are money-
  spending and must not be enforceable only in `speechQueue.ts`.
- **Upstream errors are never forwarded verbatim (security S3):** any OpenRouter error is
  logged server-side and translated to a generic `{ error: 'stt_failed' }`, so a key can never
  ride an echoed request body into a transcript that gets persisted or synced to a team brain.
- Returns `{ text, ms }`. The failure shape is `{ error: 'stt_unconfigured' | 'stt_failed' |
  'stt_busy' }` — the client must distinguish "no key, degrade to text permanently" from
  "this take failed, retry is fine" (edge-cases nit).
- **Language:** omitted (auto) by default, overridable in Settings. Explicitly UNPROVEN for
  short clips (pragmatist P2 — the only benchmark ever run used an explicit `-l tr` against
  LOCAL whisper, which is not this code path at all). An acceptance criterion measures
  auto-detect on short Turkish and short English takes; if it misfires, the default becomes a
  Settings-pinned language before ship.

## Wave 1b — the correction pass (NEW IN v3 — the lexicon's new home)

The owner's own requirement is that the agent understands project vocabulary. Measured, with
local whisper: "Sleep başlat" transcribed as "Sırıp başlat" unbiased and "sleep, başlat" with
a keyword prompt. OpenRouter ignores that prompt, so the bias moves downstream.

NEW `src/lib/voice/correct.ts`:
- Input: the raw transcript plus `buildVoiceLexicon(contextRoot)`. Output: the transcript with
  project jargon repaired. Runs on OpenRouter `/api/v1/chat/completions` with a small cheap
  model — roughly $0.0001 per take. **Latency is an ESTIMATE (~300-500 ms), not a
  measurement**, and it is the plan's weakest number: a round trip through an aggregator
  routinely runs 1-3 s in practice once queueing and provider cold paths are counted, which
  would blow the push-to-talk budget. It is therefore gated by AC6b (measure it in the real
  app) and bounded by the 1500 ms timeout below, so a slow correction degrades to the raw
  transcript instead of silently stretching every turn.
- Chosen over the native prompt on merit as well as necessity: decoder conditioning only
  raises a token's prior, while a corrector can SEE "Sırıp" next to a vocabulary containing
  "sleep" and repair it outright.

**This introduces a prompt-injection surface that did not exist in v1 or v2, on a path with
no human review step, whose output is auto-submitted to a TOOL-ENABLED agent session.** Both
inputs are attacker-influenced in a real way: the lexicon is built from brain files an agent
writes and a teammate can sync, and the transcript is whatever was spoken near the microphone.
The containment is layered and every layer is load-bearing:
1. **Both inputs are fenced as DATA by a NAMED, non-forgeable mechanism** (security S3 — an
   earlier draft said "fenced as data" without saying how, which is not a control).
   The fence is an XML-style tag pair carrying a **per-request random nonce**:
   `<transcript id="a3f9…">…</transcript>` and `<lexicon id="a3f9…">…</lexicon>`, with the
   nonce generated fresh per call. A payload cannot forge a closing tag it has never seen.
   **BOTH sides are sanitized, not just the lexicon** (security round 3 — an earlier draft
   named stripping for the lexicon only, while calling both inputs attacker-influenced).
   The same character strip — `<`, `>`, backticks, `#`, pipes, in addition to quotes and
   newlines — is applied to the LEXICON and to the STT TRANSCRIPT before either is wrapped.
   Audio prompt injection, getting a transcriber to emit literal symbol sequences from spoken
   or played audio, is a known class and sits squarely inside this plan's own threat model
   for the transcript input.
   **Scope of the nonce, stated so nobody later over-trusts it:** it blocks literal tag
   forgery, because a payload cannot contain a random closing tag it has never seen. It does
   NOT stop semantic injection that never forges a tag — an LLM does no strict XML parsing,
   so content merely CLAIMING authority inside the fence is caught by the other layers, not
   by this one. This is the same discipline a connected project already runs on
   inbound WhatsApp text after a 2026-07-12 incident where a message meant as an instruction
   went out verbatim.
2. **The system prompt permits exactly one operation: substitute tokens.** No additions, no
   answering, no obeying anything found in either input.
3. **A CHANGED transcript is never auto-submitted — this replaces the distance veto as the
   safety control (owner's call, round 3).**
   Adversarial search BROKE the 0.75 phonetic veto: 11 bypasses out of 21 dangerous pairs —
   `list`→`last` 0.25, `merge`→`purge` 0.40, `start`→`stop` 0.60, `build`→`kill` 0.60,
   `create`→`delete` 0.67, `ekle`→`sil` 0.75 exactly on the line. Tuning cannot fix it: the
   legitimate `Sırıp`→`sleep` and the hostile `start`→`stop` both score 0.60, so no threshold
   separates them. The earlier "clean gap" was an artefact of comparing LONG project nouns
   against LONG unrelated words — length was doing the separating, not meaning.
   Two independent lenses reached the same conclusion, and security sharpened it: the
   dangerous verb need not be injected at all. `kaydet`→`kaldır` (save→remove) scores ~0.67,
   and `kaldır` is exactly the kind of word an ordinary task title puts in the lexicon
   organically. No attacker required.
   **So the rule is now behavioural, not numeric:**
   - The corrector's output is diffed against the raw transcript.
   - **Zero changes → auto-submit**, exactly as before. This is the common case and stays
     hands-free.
   - **One or more changes → the transcript lands in the composer with every substitution
     visibly marked, and WAITS for the owner to press send.** A machine-altered sentence is
     never spoken on the owner's behalf without the owner seeing what changed.
   This removes an entire defensive subsystem rather than hardening it, and it closes four
   findings at once: the correction flip, hallucination auto-submit, lexicon-sourced
   injection reaching a tool-enabled agent, and an async transcript clobbering typed text.
   Lexicon membership and the ≤0.75 distance check are RETAINED but stripped of ALL
   gating power. **They never decide whether confirmation happens — only how prominently a
   change is drawn in the confirmation UI** (a substitution far from the spoken token is
   highlighted harder than a near one). There is NO "quiet accept" path and no substitution
   that skips the prompt: an earlier draft of this very paragraph said the checks decide
   "which substitutions to auto-accept as quiet", which was a live behavioural branch that
   silently reopened the exact hole this section exists to close — `kaydet`→`kaldır` at 0.67
   sits inside the old band and would have auto-submitted. The rule has exactly one form:
   **any difference from the raw transcript requires the owner's keypress.**

4. **Token alignment is SPECIFIED, not assumed** (edge-cases). A per-token diff presumes
   1:1 correspondence, and the plan's own example breaks it — raw `Sırıp başlat` versus
   corrected `sleep, başlat` inserts a comma, desyncing every later position under a naive
   zip. There is no diff/alignment library in this repo to fall back on, so the spec is:
   casefold and strip punctuation from both sequences, run an LCS alignment producing
   insert / delete / substitute ops, and then:
   - `substitute` ops are changes requiring confirmation, like every other op; the distance
     and lexicon checks only rank how loudly each one is drawn;
   - **`insert` ops are always treated as a change requiring confirmation** — an inserted
     token has no raw counterpart, so nothing can vouch for it. Because EVERY op now requires
     confirmation, the token-count shape guard and the under-12-character carve-out that v6
     needed are both gone: they existed to bound an auto-submit path that no longer exists;
   - `delete` ops are always a change requiring confirmation — the corrector must not
     silently drop spoken content.

5. **Turkish suffix forms are matched, not rejected** (edge-cases). Turkish attaches suffixes
   to loanwords constantly — `task'ın`, `sleep'i`, `lab'da` — and the mode's briefing requires
   mirroring Turkish. Lexicon membership matches when the lexicon term equals the token, is a
   prefix of it up to an apostrophe, or matches after stripping a trailing `'<suffix>`.
   Exact-match-only would revert the most common real shape of correct output and quietly
   defeat the whole point of Wave 1b.

6. **The generation itself is bounded, not just validated after the fact** (security): the
   `/chat/completions` call carries an explicit `max_tokens` sized to the transcript, because
   every validator in this list fires only AFTER a jailbroken model's output has been billed.
   An OpenRouter per-key spend limit is recommended as defence in depth, since one key now
   buys arbitrary chat completions in addition to STT and TTS — a materially larger abuse
   surface than v1's audio-only key, for both the leaked-key and the authenticated-LAN-peer
   case (`src/server/network-auth.ts:46-70` gates by a single boolean, not per operation).
7. **The pass is skippable** — a Settings toggle and an automatic bypass on error or on a
   hard **1500 ms timeout**. A failed, slow or refused correction degrades to the raw
   transcript; it never blocks or fails the take. The timeout is a stated number so the
   degrade path is testable rather than a guess.
8. The lexicon stays sanitized to identifier-like tokens (below), so the corrector's own
   prompt cannot be steered by a poisoned task title.
9. **The downstream session is told the text passed through a correction step, by a NAMED
   carrier** (security round 3 — an earlier draft asserted the requirement without saying
   how, which is the same defect pattern the fencing item already had to fix once).
   The carrier is the JARVIS briefing itself: it states that voice input reaching this
   session may have been jargon-corrected against the project vocabulary, so the agent treats
   an odd-looking command as worth confirming rather than as certainly verbatim. A
   server-side log flag would NOT satisfy this — the whole point is that the text lands in
   the MODEL's context. Note this matters less now that a changed transcript requires the
   owner's own keypress (containment item 3). The briefing is static and cannot know whether a
   given turn was corrected, so it says "may have been" — which is the honest and cheap
   framing, and it still earns its place on the byte-identical path where the owner saw no
   prompt at all.

NEW `src/lib/voice/lexicon.ts`:
- `buildVoiceLexicon(contextRoot): string` — project name, active task names, feature names,
  knowledge index titles, taxonomy vocab, people names. Newest-first, deduped, hard-truncated
  to a char budget.
- **Sanitized to identifier-like tokens**: quotes, newlines and prose punctuation stripped, so
  a poisoned brain file cannot smuggle a sentence into the corrector's prompt.
- Cached in memory, invalidated on the brain dir's mtime.

## Wave 2 — TTS route

- `POST /api/agent/voice/tts` — **the same posture as STT, stated explicitly** (security S2):
  `isDesktop()`-gated, classified against `VAULT_AGNOSTIC_PREFIXES` (vault-AGNOSTIC — it
  reads no project state), behind CSRF and the network token. Body `{ text }` → `audio/mpeg`.
- OpenRouter `/api/v1/audio/speech`: `model` (id resolved from the models endpoint, not
  hardcoded), `input`, `voice`, `response_format: 'mp3'`, and a fixed `instructions` string
  carrying the JARVIS persona (calm, precise, unhurried, dry). The instruction is where the
  character lives; it costs nothing and is the reason no second provider is being bought.
  Because Gemini Flash TTS and Voxtral sit behind the SAME endpoint, changing voice later is
  a model-id change, not an integration.
- **Server-side enforcement** of the per-call character cap and a per-window call cap.
  Rejecting past the cap returns `{ error: 'tts_busy' }`.
- **ONE key for all three calls** (STT, correction, TTS): `~/.dreamcontext/voice.json`
  (atomic write at 0o600, matching `claude-account-sandbox.ts:139`) → `OPENROUTER_API_KEY`
  env. No OpenAI key is read or requested anywhere — owner's explicit instruction. The key
  stays server-side; `voiceStatus()` reports only `key: boolean`. Upstream errors are
  translated, never forwarded (security S3).
- NEW `src/lib/voice/speakable.ts` — a pure, tested function stripping markdown, URLs, file
  paths and em dashes. It is the LAST line of defence, not the first: the client chunker
  never sends it a fenced block in the first place (see Wave 3).

## Wave 3 — client capture, chunking, playback

NEW `dashboard/src/lib/voice/useVoiceCapture.ts`:
- **`MediaRecorder.isTypeSupported()` probe with a fallback chain** (edge-cases E1 — the
  single highest-risk unverified assumption in v1, which hardcoded `audio/webm;codecs=opus`).
  WebKit historically produces `audio/mp4`/AAC rather than webm/opus, there is ZERO existing
  `MediaRecorder` usage in this codebase to copy, and an unsupported mimeType throws
  synchronously, killing voice-in on the first press. Both containers are on OpenAI's
  accepted list, so the probe is the whole fix — no conversion anywhere.
- **A silence gate before upload** (edge-cases E2): reject a take under ~300 ms (the
  tap-instead-of-hold case) and reject one whose RMS energy never crosses a floor. This is
  the ONLY defence available: `gpt-4o-mini-transcribe` returns `json`/`text` only, so there
  is no `no_speech_prob` to check (that is `whisper-1` + `verbose_json`). Without it, a
  hallucinated sentence is auto-submitted to a tool-enabled agent as if the owner said it.
  An empty or whitespace transcript is likewise never submitted.
- Tracks stopped after every take so the macOS mic indicator does not stay lit.

NEW `dashboard/src/lib/voice/speechQueue.ts`:
- **Fence-aware chunking** (edge-cases E3): the chunker tracks fence state and excludes
  ```dream-html```, ```dream-view```, ```dream-actions``` and ordinary code fences ENTIRELY —
  never emitting them as speech. This is not optional polish: the Wave 4 briefing instructs
  the agent to emit a `dream-html` block for any structured answer, so most real replies
  contain one. `speakable.ts` cannot fix this after the fact, because by then the tag soup has
  already been carved into nonsense "sentences".
- Sentence splitting on `.!?…` and newline, emitting on a closed sentence or ≥ 40 chars.
  Turkish abbreviation and decimal handling is a refinement, not a gate — a naive splitter
  adds a pause, it does not break the feature (pragmatist nit; ship naive, refine if audibly
  bad).
- Strictly ordered playback; chunk N+1 fetched while chunk N plays.
- **Explicit chunk-failure semantics** (edge-cases E5): a failed chunk is logged and SKIPPED
  and the queue continues. One 429 never stalls or deadlocks the reply.
- **One stop-and-clear entry point**, called from three places (edge-cases E6): the mic press
  (barge-in), `interrupt()` (`chatSession.ts:1447`), and `steer()` (:1309). Without the last
  two, hitting Stop leaves the stale answer playing to the end.
- An autoplay unlock `play()` issued inside the synchronous mic-press handler, so WebKit's
  user-activation rule cannot block the first chunk (edge-cases nit).

Wire-up in `dashboard/src/components/sleepy/chatSession.ts`:
- **Fix the sub-agent leak FIRST, before wiring anything to it** (edge-cases E7, confirmed by
  direct reading): attach `parentToolUseId` to `fromAssistant`'s text branch
  (`chatProtocol.ts:705`) and guard the reducer's `assistant-text` arm (`chatSession.ts:869`)
  the way the tool arms at :801 and :850 already are. Today a sub-agent's text block arriving
  as a top-level `assistant` frame would render in the main transcript — and, once wired,
  be SPOKEN as the main conversation's own words, out of order with the real turn.
- **Spoken-offset tracking is keyed to the reducer's own per-ITEM bookkeeping, never to the
  raw stream `index`** (edge-cases E8; refined by critic). `block-start` (:786) creates a new
  item per index, and indices restart at 0 for every message — a tool round-trip produces a
  second text block at index 0, so index-keyed state would diff block B against block A's
  leftovers. Per item: feed deltas live, and on the echo speak only the tail beyond what that
  item has already contributed.
  Note the no-delta case is TWO items, not one upgraded item: `block-stop` marks the empty
  item `done` before `assistant-text` arrives, the reducer's "last non-done item" match at
  :882 fails, and it APPENDS a new item (:890-895). Per-item tracking gives the right result
  either way — the first item contributed 0 chars, the second is spoken in full, exactly once.
- `result` (:1180) flushes a trailing partial chunk.
- Gated on `mode === 'jarvis'`. Redundant given `mode` is `readonly` and a mode change
  respawns the session (so the queue dies with it), but kept as a cheap explicit guard.

`Composer.tsx`:
- A mic button in the toolbar, rendered only in jarvis mode and only on desktop.
  Press-and-hold plus a keyboard chord. On transcript: fill the textarea and go through the
  EXISTING `submit()` (:755) so attachments, queueing and steering keep working untouched.
- States: recording (elapsed seconds), transcribing, **correcting**, **awaiting-confirmation**,
  too-short, error. The correction pass is a visible state, not a silent 300-500 ms dead gap
  after release.
- **`awaiting-confirmation` is a real state in the busy guard, not a gap between states**
  (edge-cases, confirmation round). Confirm-on-change created a TERMINAL pending state the
  earlier guard wording never modelled: it scoped itself to "still in STT or correction", so
  the moment corrected text landed in the composer the guard released and a second mic press
  was unprotected. The policy, stated rather than left to the implementer:
  - **Pending text untouched → a new mic press DISCARDS it and starts a fresh take.** Tapping
    the mic while looking at a bad correction IS the owner choosing to redo; refusing there
    would be obstruction. The discarded transcript is logged.
  - **Pending text hand-edited → a new mic press is REFUSED with a notice.** Once the owner
    has typed into it, it is the owner's text, and AC3f's promise (an async transcript never
    overwrites what the owner typed) extends to machine-produced pending text too.
  This also resolves the hand-edit-versus-late-arrival race: there is never a second take in
  flight while an edited pending take exists, so no precedence rule is needed.
- **The mic is BUSY-GUARDED for the whole post-release pipeline** (edge-cases): push-to-talk
  only blocks re-recording during capture, but STT plus correction is a ~1-2 s window where a
  habitual double-tap lands. A second press while a take is unresolved is refused, not
  queued, so two `fill textarea → submit()` paths can never race and an async result can
  never clobber text the owner typed manually while waiting. Modelled on the existing
  `awaitingUpload` gate in `Composer.tsx:1242,1260`, which solves exactly this shape for
  attachments.

## Wave 4 — the mode itself

- `agent-spawn-shared.ts:113` — drop the `v === 'jarvis'` coercion.
- `dashboard/src/lib/chatModes.ts` — drop `disabled` and the `Soon` badge.
- `chat-modes.ts` — `case 'jarvis'` returns `JARVIS_BRIEFING + worktree`.
- `tests/unit/chat-modes.test.ts:40` and `:126` — both assertions invert.
- **`AgentSurface.tsx:220-227`** (critic C2a) — `knownChatMode()` starts accepting jarvis the
  moment `disabled` is removed. The change is correct but its doc comment then states a false
  invariant ("the spawn can never honour it"); rewrite the comment to say the filter now
  tracks a mode's real spawnability.
- **`SleepyMascot.tsx:26-30` + `tests/unit/mascot-mode-gear.test.ts:26-30`** (critic C2b) —
  J.A.R.V.I.S gets its OWN gear (owner's call). `SleepyGear` gains a third member, a new
  overlay is drawn in the same idiom as plan/develop (a motion that reads at 26px), and the
  test's "bare face for Basic, J.A.R.V.I.S and absent" case is rewritten. This was going to
  ship silently undecided because the test passes either way.

The briefing, deliberately SHORT (a long brief in a spoken mode is the failure this mode
exists to avoid):

```
# Mode: J.A.R.V.I.S

You are being SPOKEN to, and everything you write is read back aloud.

- **Two or three sentences. Never more.** Plain talk. No headings, no bullets, no markdown,
  no em dashes, no code, no file paths, no URLs — none of that survives being read aloud.
- **Show, don't recite.** The moment an answer has structure (numbers, options, a plan, an
  architecture), say one sentence like "bak, ekrana koyuyorum" and put the detail on screen
  as a `dream-html` block. The voice carries the point; the screen carries the detail.
- **Narrate the work.** One sentence before a long tool run, one sentence about what you
  found on the way back.
- Mirror the user's language, Turkish or English.
- Voice input reaching this session may have been jargon-corrected against the project
  vocabulary, so treat an odd-looking command as worth confirming rather than as certainly
  verbatim.
```

Everything else about J.A.R.V.I.S's behaviour is Basic's (it inherits the worktree clause).

## Wave 5 — Settings and docs

- Settings → Machine group: a Voice card — the OpenRouter key field, voice picker, STT
  language, a toggle for the correction pass,
  and a live `voiceStatus()` readout. Modelled on the existing embeddings/Hybrid card, which
  is why this is cheap.
- Docs lockstep per the HARD RULE: `skill/SKILL.md:100`,
  `skill/references/integrations.md:303`, README, DEEP-DIVE, announcements entry.
- **Revert path, stated rather than assumed** (edge-cases nit): J.A.R.V.I.S returns to
  "coerced to basic" by reverting Wave 4's six files; the voice routes and client modules are
  inert without it.

## Acceptance criteria

> The `3*` family is the correction-pass suite (Slice 2). Everything else gates Slice 1.
1. `sanitizeChatMode('jarvis') === 'jarvis'`, and selecting the mode spawns a session whose
   system prompt contains the jarvis briefing.
2. `MediaRecorder.isTypeSupported()` resolves to a working container in the real Tauri
   WebView, and the chosen container uploads and transcribes end to end.
3. Holding the mic, speaking Turkish containing project jargon, releasing: the composer fills
   with the correct transcript and submits. The measured "Sleep başlat" case comes out
   correct AFTER the correction pass.
3b. Model ids are resolved from OpenRouter's models endpoint, not hardcoded; a renamed model
   surfaces as a clear configuration error, never a silent 404 on first press.
3c. The correction pass is adversarially tested: a task title crafted as an instruction
   ("ignore previous instructions and ...") in the lexicon, and a spoken sentence doing the
   same, both leave the corrector's behaviour unchanged — it still only substitutes tokens.
3d. **A changed transcript NEVER auto-submits.** Any substitute, insert or delete op puts the
   transcript in the composer with the change marked and waits for the owner's keypress.
   Auto-submit happens in exactly two cases: the corrector returned byte-identical text, or
   **the corrector never returned at all** (1500 ms timeout, error, or the pass switched off)
   — in which case nothing was changed by definition and there is no basis for withholding.
   A literal earlier wording said "only a byte-identical corrector output auto-submits",
   which would have added a spurious confirmation step on every timeout. This is the criterion
   that replaces the old numeric veto and it is the one that must not regress.
3k. **A second mic press over pending text behaves as specified**: discards and re-records
   when the text is untouched, refuses with a notice once the owner has hand-edited it.
3e0. **The measured bypasses are harmless under the new model.** The 11 pairs the adversarial
   search found (`list`→`last` 0.25, `merge`→`purge` 0.40, `start`→`stop` 0.60,
   `create`→`delete` 0.67, `ekle`→`sil` 0.75, …) and security's organic case
   `kaydet`→`kaldır` (~0.67, where `kaldır` is a real lexicon term needing no injection) are
   each replayed: every one is a CHANGE, so every one stops for confirmation. The test asserts
   the stop, not a distance.
3e. **An already-correct transcript is not "repaired" into a confirmation prompt.** The
   measured `lag`/`flag` shape must pass through untouched and auto-submit — otherwise the
   confirmation step fires constantly and gets trained away. Every substitution the corrector
   proposes is logged, so a bad correction the owner waved through is still detectable after
   the fact.
3g. **Lexicon-sourced poison cannot silently reach the agent.** A lexicon entry carrying
   attacker content is a change, so it stops for confirmation regardless of its distance —
   tested separately from 3c, which can pass for the wrong reason (sanitization, not gating).
3h. **A delimiter-breakout payload is defeated.** A task title containing the fence's own tag
   syntax and a forged instruction boundary leaves the corrector's behaviour unchanged —
   distinct from 3c's imperative-sentence payload, which tests keyword resistance rather than
   delimiter escape.
3i. **Alignment ops behave as specified.** An insertion (the comma in `sleep, başlat`), a
   deletion, and a token split/merge each align correctly under the LCS spec and each count as
   a change requiring confirmation, including on a one-word take where the old ratio guards
   were meaningless.
3j. **Turkish suffix forms survive.** `task'ın`, `sleep'i` and `lab'da` match their lexicon
   terms and are not reverted; exact-match-only would defeat the feature on its most common
   real shape.
3f. A second mic press while a take is still in STT or correction is refused, and an async
   transcript never overwrites text the owner typed manually in the meantime.
4. STT auto language-detect measured on short Turkish AND short English takes. If it
   misfires, the default is a Settings-pinned language before ship.
5. A tap (under 300 ms) and a silent take are both rejected client-side and never submitted.
   No hallucinated sentence ever reaches the agent.
6. The reply starts being spoken within ~1.5 s of its first sentence, continuously and in
   order, with no gap between chunks.
6b. Correction-pass latency is MEASURED end to end in the real app, not estimated. If the
   measured push-to-talk-to-submit time exceeds the budget, the pass moves behind an explicit
   opt-in rather than shipping on by default.
7. A reply containing a `dream-html` block is spoken WITHOUT any of the block's contents.
8. A short reply that arrives with NO text deltas is spoken exactly once, with no duplication.
9. Pressing the mic, hitting Stop, and steering mid-speech each silence the audio immediately.
10. A failed TTS chunk is skipped and the rest of the reply still plays.
11. After a legitimate push-to-talk has satisfied the process-wide mic prompt, a
    `getUserMedia` call is REFUSED from ALL THREE sandboxed surfaces — a `dream-html` block
    (`HtmlView.tsx`), a Lab app frame (`LabAppFrame.tsx`) and an HTML insight body
    (`HtmlInsightBody.tsx`) — not just from Chat.
12. Server-side caps hold when the client is bypassed: a direct POST over the cap is rejected.
13. No OpenRouter error body is ever forwarded to the client or written to a transcript, and
    the key appears in no response, log line, or transcript.
14. With no key, the mode still works as text and says what is missing; a single failed take
    is retryable rather than a permanent degrade.
15. The mic is absent outside jarvis mode and outside the desktop app.
16. Unit tests: fence-aware chunker, speakable stripper, lexicon budget + sanitization,
    correction-pass output validation (accept a substitution, reject an injected instruction,
    reject an over-long reply), the inverted mode assertions, the mode mirror, the rewritten
    mascot gear test, and the `assistant-text` parent guard.
17. Validation method: unit tests plus a manual checklist run in the real desktop app.

## Delivery order — SLICE 1 is shippable on its own

The waves are not one indivisible unit (pragmatist). Slice 1 is the smallest thing that lets
the owner actually talk to his agent and hear it answer, and it is validated on its own:

**Slice 1** = Wave 0 (both items) + Wave 1 (STT, raw transcript, no correction) + Wave 2
(TTS) + Wave 3 (capture, chunking, playback, barge-in, busy guard) + Wave 4's mode wiring
(briefing, `sanitizeChatMode`, `chatModes.ts`, `AgentSurface.tsx`, the mode tests) + a
bare-bones Voice card (key field and `voiceStatus()` readout only).
Gated by acceptance criteria 1, 2, 4, 5, 6, 7, 8, 9, **3f**, **10**, **11**, 12, 13, 14, 15,
the Slice-1 half of 16, and 17. **3f is in SLICE 1** (edge-cases round 3): the busy guard's code ships in Wave 3,
which is entirely inside Slice 1, and STT alone is already a non-zero race window — gating its
only acceptance criterion to Slice 2 would ship the guard unverified.

**Slice 2** = Wave 1b (the correction pass and its full containment), gated by 3, 3b, 3c, 3d,
3e0, 3e, 3g, 3h, 3i, 3j, **3k**, **6b**, the Slice-2 half of 16, and 17 (critic round 3: Wave 1b's own text names 6b as its latency gate,
so omitting it from this list would let Slice 2 ship without ever measuring it); plus the bespoke mascot gear and its rewritten test; plus the voice picker, the STT
language control and the correction toggle in Settings.

Slice 1 deliberately ships on the RAW transcript. Jargon repair is an accuracy refinement,
not a "can I talk to it" blocker, and holding the whole mode behind the most speculative half
of the plan is what the pragmatist lens exists to prevent. Slice 1 keeps Basic's mascot face;
the dedicated gear is a fast-follow, not a prerequisite for speech working.

## Explicitly out of scope
VAD / always-listening; streaming STT; wake word; any direct-to-OpenAI path (everything goes
through OpenRouter); local STT (whisper.cpp) and local TTS (Kokoro-82M), both deferred to one
shared later "run it locally" Settings option; Windows and
Linux microphone paths (the web dashboard has no mic button); voice in the terminal surface,
the Meeting Room, or automations.
