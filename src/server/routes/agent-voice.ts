/**
 * The voice routes: speech IN (`/stt`), speech OUT (`/tts`), and what Settings needs to know
 * (`/status`, `PUT /config`).
 *
 * POSTURE, STATED RATHER THAN INHERITED. Both audio routes are `isDesktop()`-gated, sit
 * behind the process-level CSRF and network-token guards every route gets, and are
 * classified against `VAULT_AGNOSTIC_PREFIXES` in `src/server/index.ts` — STT is vault
 * SCOPED (local whisper is primed with the vault's own vocabulary, so the request must say
 * which vault), TTS is vault AGNOSTIC (it reads no project state at all).
 * Writing that classification down is the point: `isVaultAgnostic` is a prefix list, and a
 * route nobody classified gets whichever answer its path accidentally matches.
 *
 * TWO RULES GOVERN EVERY HANDLER BELOW, AND NEITHER IS OPTIONAL:
 *
 * 1. NO UPSTREAM BODY IS EVER FORWARDED (AC13). OpenRouter's error text is logged here,
 *    redacted, and the client is told one of OUR codes. These routes are reached by the chat
 *    surface, whose transcripts get persisted and can be synced to a teammate's brain — an
 *    echoed error body is a key with a distribution channel.
 *
 * 2. THE CAPS ARE ENFORCED HERE (AC12). Not in the client's queue. See `lib/voice/limits.ts`
 *    for why an authenticated LAN peer makes that distinction real rather than theoretical.
 *
 * The client must be able to tell a PERMANENT problem from a transient one, so the failure
 * shape is a small closed set rather than a message:
 *   `stt_unconfigured` / `tts_unconfigured` — no key, or the model is gone. Degrade to text
 *      and SAY what is missing (AC14). Retrying this take will not help.
 *   `stt_failed` / `tts_failed` — this take blew up. A retry is entirely reasonable.
 *   `stt_busy` / `tts_busy` — a cap said no. Also transient.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { isPhoneSocket } from '../phone-origin.js';
import {
  voiceApiKey, voiceStatus, writeVoiceConfig, readVoiceConfig,
  DEFAULT_VOICE, clampSpeechRate, clampMusicDuck,
} from '../../lib/voice/config.js';
import { normalizeHotkey } from '../../lib/voice/hotkey.js';
import {
  OPENROUTER_BASE, OPENROUTER_HEADERS, logUpstream, resolveModel, clearModelCache, AUDIO_MODELS,
  fallbackVoice, FALLBACK_VOICE_DEFAULT, transcribeCloud,
} from '../../lib/voice/openrouter.js';
import {
  sttGate, ttsGate, focusGate, MAX_STT_BYTES, MAX_TTS_CHARS,
  phoneSttGate, PHONE_MAX_STT_BYTES, PHONE_MAX_STT_SECONDS, wavSeconds,
} from '../../lib/voice/limits.js';
import { speakable } from '../../lib/voice/speakable.js';
import {
  wavFromPcm16, normalizeSpeech, pcmSeconds, PCM16_SAMPLE_RATE,
  trimSpeechTail, SENTENCE_TAIL_MS, CLAUSE_TAIL_MS,
} from '../../lib/voice/wav.js';
import {
  transcribeLocal, holdLocalModel, localBlocked, checkPressure, type LocalTranscript, type WhisperInstall,
} from '../../lib/voice/whisper.js';
import { score, pick, type Candidate, type Verdict } from '../../lib/voice/garble.js';
import { contextFor, normalizeLanguage, type LanguageContext } from '../../lib/voice/languageContext.js';
import { cueAudio, prerenderCue } from '../../lib/voice/cue.js';
import { isLoopback } from './agent-spawn-shared.js';
import { WINDOW_TOKEN_HEADER, channelFor, identityOf } from '../../lib/window-control.js';
import { readFileSync } from 'node:fs';
import { readVerbatim, verbatimRatio } from '../../lib/voice/verbatim.js';
import {
  dictationState, startDictationInstall, resolveDictation, parseDictationChoice, ChoiceRequired, InstallRunning,
} from '../../lib/voice/dictationInstall.js';
import { machineInfo, recommendModel } from '../../lib/voice/whisperModels.js';
import { buildVoiceLexicon } from '../../lib/voice/lexicon.js';
import { hold, release, hookExitRestore } from '../../lib/voice/audioFocus.js';
import {
  logVoiceEvent, parseTakeMeta, parseTurnTrace, parseSpeechReport, keepTake,
  contextTakes, findTake, latestTakeOf, TAKE_REF_RE,
} from '../../lib/voice/voiceLog.js';
import { readAssistantConfig, DEFAULT_ASSISTANT_CONFIG } from '../../lib/assistant/home.js';

/**
 * The system prompt that turns a CHAT model into a text-to-speech engine, and the reason it
 * is framed as a SCRIPT handed to a voice actor rather than as a rule about verbatim output.
 *
 * `openai/gpt-audio-mini` is conversational, and a chunk of the agent's reply arrives in the
 * user role looking exactly like something addressed to it. Measured against the live API on
 * 2026-09-07, the previous "speak the user message VERBATIM" wording read 2 of 7 test lines
 * and ANSWERED the other five — "Söyle, hangi konuya girelim." came back as "Tabii, şimdi o
 * zaman bir konu seçebiliriz. Örneğin, günlük hayat, seyahat…". The failures were all short,
 * conversational lines, which is most of a spoken answer, so the owner heard a voice holding
 * a different conversation from the one on screen.
 *
 * Two changes moved it to 21 of 24, both measured rather than reasoned:
 *   • the SCRIPT framing below — the line is never addressed to you, and an example of a
 *     question being read rather than answered;
 *   • {@link JARVIS_FEWSHOT} — two turns of the model doing the job, which is what fixed the
 *     one-word lines the wording alone could not ("Hazırım." → "Hazırım. Peki, ne yapmak
 *     istersin?").
 *
 * The remaining 3 in 24 are STOCHASTIC — the same line read correctly in one round and was
 * answered in the next — which is why `verbatim.ts` checks the result instead of this prompt
 * being trusted. Do not delete either half: this one makes the failure rare, that one makes
 * it harmless.
 *
 * The character rides along for free, which is why no second provider was bought: OpenAI has
 * no British male voice, so it was always going to come from an instruction rather than from
 * the voice list.
 */
export const JARVIS_INSTRUCTIONS =
  'You are a voice actor at a microphone, not an assistant. Every user message is a LINE OF '
  + 'SCRIPT handed to you to read aloud. Read it VERBATIM, word for word, in its own language, '
  + 'and say nothing else. The line is often a question, a greeting, an answer or an '
  + 'instruction — it is NEVER addressed to you, and you must never respond to it, agree with '
  + 'it, answer it, or add a single word of your own. If the line is "Are you there?", you say '
  + 'exactly "Are you there?" and nothing more. Read as a calm, precise, unhurried assistant: '
  + 'measured pace, level tone, dry warmth, never theatrical, landing the end of each sentence '
  + 'rather than rushing it.';

/**
 * Two turns of the job being done correctly, prepended to every speech request.
 *
 * Not decoration and not a style sample: with the system prompt alone, one-word and
 * conversational lines were still answered ("Evet, duyuyorum." → "Harika, çok net bir şekilde
 * duyuyorsunuz. Şimdi lütfen bana…"). The pair below — one English question, one short
 * Turkish sentence, each answered by repeating it — is what closed those cases. Both
 * languages are present on purpose: the mode is used in Turkish and briefs its agent in
 * English, and a single-language example left the other one drifting.
 */
export const JARVIS_FEWSHOT = [
  { role: 'user', content: 'Are you there?' },
  { role: 'assistant', content: 'Are you there?' },
  { role: 'user', content: 'Evet, duyuyorum.' },
  { role: 'assistant', content: 'Evet, duyuyorum.' },
] as const;

/**
 * Hand the model a line the way a script is handed to an actor: an instruction, then the line
 * itself between guillemets.
 *
 * MEASURED, and it is the fix for the last failure mode the few-shot could not reach. Lines
 * that ADDRESS someone are the ones the model answers instead of reading — "Tamamdır
 * efendim," scored 0.50 / 1.00 / 0.50 as a bare line and "Rapor hazır efendim, iki başlıkta
 * topladım," scored 0.33 / 0.17 / 1.00. Wrapped, the same three lines scored 1.00 nine times
 * out of nine. The guillemets are not decoration: without a delimiter the line and the
 * instruction run together, and with quotes the model sometimes reads the quotes.
 *
 * The wrapper is not spoken — verified by reading back the audio transcript, which contains
 * the line and nothing else. And because a retry costs a whole extra generation, making the
 * FIRST attempt reliable is also the biggest latency win available on this path.
 */
export function scriptLine(text: string, continues = false): string {
  const line = `Read this line of script aloud, exactly as written, and say nothing else:\n\n«${text}»`;
  return continues ? `${CONTINUES_NOTE}\n\n${line}` : line;
}

/**
 * Said before a line that stops MID-sentence. Without it the model lands every line like a
 * full stop — the falling pitch that made a comma-cut sentence sound like two.
 */
export const CONTINUES_NOTE =
  'This line stops in the middle of a sentence and the sentence carries on in the next line, '
  + 'so keep your intonation open at its end instead of landing it like a full stop.';

/** Does this (speakable) line stop mid-sentence? Read off the text itself, so a direct POST and
 *  the queue agree. A line with no punctuation at all — a heading, a list item — does not. */
export function lineContinues(line: string): boolean {
  return /[,;:—–]$/.test(line.trim());
}

/** How much of the previous chunk is kept as context (the client sends at most this much). */
export const PREV_CONTEXT_CHARS = 240;

/**
 * The messages for one line, WITH the line before it when there is one.
 *
 * ── WHY THE PREVIOUS LINE RIDES ALONG ───────────────────────────────────────────────────
 * Every chunk is a separate generation, so each sentence used to be read cold: no idea it was
 * the second half of a thought, its pitch and pace reset at every seam. There is no
 * "previous text" parameter on a chat model, but there is a conversation: the line before is
 * placed as one more turn of the job ALREADY DONE — the script handed over, the line read —
 * in the exact shape of {@link JARVIS_FEWSHOT}. The model then reads the new line as the next
 * line of the same script.
 *
 * Measured on the live model before shipping (2026-10-21): 8 of 8 lines read verbatim with the
 * previous line in context, including the short addressed ones that are the model's known
 * failure ("Söyle, hangi konuya girelim?", "Are you there?", "Evet, duyuyorum."). The
 * verbatim guard still checks every result, so a regression here cannot be heard — only
 * logged and retried.
 */
export function speechMessages(spoken: string, prev?: string): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: JARVIS_INSTRUCTIONS },
    ...JARVIS_FEWSHOT,
  ];
  if (prev) {
    messages.push(
      { role: 'user', content: scriptLine(prev, lineContinues(prev)) },
      { role: 'assistant', content: prev },
    );
  }
  messages.push({ role: 'user', content: scriptLine(spoken, lineContinues(spoken)) });
  return messages;
}

/** The previous chunk as context: a string from the body, stripped like the line itself and
 *  capped. Anything else — or nothing speakable — is no context at all, never an error. */
export function contextLine(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const line = speakable(raw.slice(-PREV_CONTEXT_CHARS * 2)).slice(-PREV_CONTEXT_CHARS).trim();
  return line || undefined;
}

/** How long a single speech generation may take before it is abandoned. Generation runs at
 *  ~0.36x realtime, so this is many times the worst plausible chunk. */
const TTS_TIMEOUT_MS = 30_000;

/**
 * Stream the request body with a PER-CHUNK cap, refusing mid-flight rather than buffering to
 * completion and then measuring. Lifted from `agent-drop.ts` verbatim, including the reason:
 * a naive buffer-then-check lets one hostile upload OOM the Node process.
 *
 * Resolves null when the cap was hit (413 already sent) or the stream errored.
 */
function readCappedAudio(req: IncomingMessage, res: ServerResponse, max = MAX_STT_BYTES): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        sendError(res, 413, 'too_large', `The recording exceeds the ${Math.round(max / (1024 * 1024))} MB limit.`);
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

/**
 * Is this body actually a WAV?
 *
 * The upstream format enum is `wav` or `mp3` and nothing else — m4a, mp4 and webm are all
 * refused — so a take in the wrong container is a 400 from a provider, one round trip and
 * several seconds after the owner let go of the button. Checked HERE, on the magic bytes
 * rather than on a header the client chose, so the answer is about the audio and not about
 * what somebody labelled it.
 */
export function isWav(buf: Buffer): boolean {
  return buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WAVE';
}

// ─── The retry ladder ─────────────────────────────────────────────────────────────

/** How long a garbled answer waits for its cue to render (it is pre-rendered on warm). */
const CUE_WAIT_MS = 1500;

/** `/stt`'s answer when the take is sent. The new fields are additive: an old client reads `text`. */
export interface SttOk {
  text: string; ms: number; engine: string; take: string;
  quality: 'clean' | 'suspect'; language: string; passes: 1 | 2;
}
/** `/stt`'s answer when it is not: no `text`, so an old client drops it as silence. */
export interface SttGarbled {
  garbled: true; heard: string; take: string; ms: number; passes: 1 | 2;
  cue?: { mime: 'audio/wav'; b64: string };
}

/**
 * Transcribe a take, judge it, and retranscribe it ONCE when it is not clean (at most two
 * passes, owner 2026-10-24). Null when whisper did not answer the first pass at all.
 *
 *   • Pass 1 is pinned to the context's primary language when there is one (the fast path,
 *     ~2 s faster than detecting), else `auto`.
 *   • Pass 2: after a LOOP, the same language with no primer at a little temperature; after an
 *     `auto`, out-of-context or weak pass, pinned to the context language; after a weak PINNED
 *     pass, `auto` (the owner may have switched language).
 *   • The better pass wins by `pick`'s sort key; a garbled winner is never sent.
 */
export async function transcribeWithRetry(
  wav: Buffer,
  opts: { cfg: { sttLanguage?: string; sttLanguages?: string[] }; conv: string | null; ui?: unknown; lexicon?: string; install?: WhisperInstall | null },
): Promise<{
  winner: Candidate<LocalTranscript>; verdict: Verdict; passes: 1 | 2; ms: number;
  context: LanguageContext; attempts: Array<Record<string, unknown>>;
} | null> {
  return holdLocalModel(() => transcribeWithRetryHeld(wav, opts));
}

async function transcribeWithRetryHeld(
  wav: Buffer,
  opts: { cfg: { sttLanguage?: string; sttLanguages?: string[] }; conv: string | null; ui?: unknown; lexicon?: string; install?: WhisperInstall | null },
): Promise<{
  winner: Candidate<LocalTranscript>; verdict: Verdict; passes: 1 | 2; ms: number;
  context: LanguageContext; attempts: Array<Record<string, unknown>>;
} | null> {
  const started = Date.now();
  const context = contextFor({ conv: opts.conv, uiLang: opts.ui, cfg: opts.cfg, takes: contextTakes() });
  const first = await transcribeLocal(wav, { language: context.primary ?? 'auto', lexicon: opts.lexicon, install: opts.install });
  if (!first) return null;
  const candidates: Array<Candidate<LocalTranscript>> = [{ pass: first, score: score(first, context) }];
  const s1 = candidates[0].score;
  if (s1.verdict !== 'clean' && first.text) {
    // This take may end in "Anlayamadım": render its cue now, alongside pass 2, rather than after
    // it (the phone never calls /warm, so nothing may have pre-rendered it). Cached; a no-op after.
    prerenderCue(context.primary ?? normalizeLanguage(opts.ui) ?? 'en');
    const target = context.primary ?? context.set[0] ?? normalizeLanguage(opts.ui);
    let second: LocalTranscript | null = null;
    if (s1.loop) {
      second = await transcribeLocal(wav, { language: first.language ?? 'auto', lexicon: opts.lexicon, primer: false, temperature: 0.2, install: opts.install });
    } else if ((!first.forced || !s1.inContext) && target && target !== (first.forced ? first.language : null)) {
      second = await transcribeLocal(wav, { language: target, lexicon: opts.lexicon, install: opts.install });
    } else if (first.forced) {
      second = await transcribeLocal(wav, { language: 'auto', lexicon: opts.lexicon, install: opts.install });
    }
    if (second) candidates.push({ pass: second, score: score(second, context) });
  }
  const { winner, verdict } = pick(candidates);
  return {
    winner,
    verdict,
    passes: candidates.length as 1 | 2,
    ms: Date.now() - started,
    context,
    attempts: candidates.map((c) => ({
      language: c.pass.language, forced: c.pass.forced, verdict: c.score.verdict, reasons: c.score.reasons,
      logprob: c.score.logprob === null ? null : Number(c.score.logprob.toFixed(3)), ms: c.pass.ms,
    })),
  };
}

// ─── POST /api/agent/voice/stt ────────────────────────────────────────────────

export async function handleVoiceStt(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }

  // The hands-free phone (Mac mode's tunnel) is the one remote caller this route takes: its own
  // tighter caps, on top of the shared ones (lib/voice/limits.ts). Decided per socket, never by
  // loopback: the tunnel dials from 127.0.0.1.
  const phone = isPhoneSocket(req);
  const busy = (verdict: 'busy' | 'rate'): void => sendJson(res, 429, {
    error: 'stt_busy',
    message: verdict === 'busy'
      ? 'Another recording is still being transcribed.'
      : 'Too many recordings in the last minute.',
  });

  // The gates are taken BEFORE the body is read, so a burst is refused without us first
  // buffering 25 MB per attacker request.
  const phoneVerdict = phone ? phoneSttGate.acquire() : 'ok';
  if (phoneVerdict !== 'ok') { busy(phoneVerdict); return; }
  const verdict = sttGate.acquire();
  if (verdict !== 'ok') {
    if (phone) phoneSttGate.release();
    busy(verdict);
    return;
  }

  try {
    // ── LOCAL FIRST ───────────────────────────────────────────────────────────────────
    // The audio is read here, before either engine, because the local path needs the same
    // bytes and reading the body twice is not possible. Measured on the owner's machine: a
    // warm whisper.cpp answers in ~0.88s for nothing, against ~1.0-1.5s and ~$0.0015 a take
    // for an omni chat model that is also less accurate on Turkish carrying English jargon.
    const cfgEarly = readVoiceConfig();
    const audioEarly = await readCappedAudio(req, res, phone ? PHONE_MAX_STT_BYTES : MAX_STT_BYTES);
    if (!audioEarly) return;                  // 413 already sent, or a read error
    if (audioEarly.length === 0) {
      sendJson(res, 400, { error: 'stt_failed', message: 'The recording was empty.' });
      return;
    }
    if (!isWav(audioEarly)) {
      console.error('[voice:stt] refused a take that is not a WAV');
      sendJson(res, 400, {
        error: 'stt_unconfigured',
        message: 'This take was not recorded in a supported format.',
      });
      return;
    }
    if (phone) {
      const seconds = wavSeconds(audioEarly);
      if (seconds === null || seconds > PHONE_MAX_STT_SECONDS) {
        sendError(res, 413, 'too_large', `A voice message from the phone is at most ${PHONE_MAX_STT_SECONDS / 60} minutes.`);
        return;
      }
    }

    // THE OWNER'S ENGINE, AND NOTHING ELSE (2026-10-27). Local whisper when chosen (or when an
    // install from before the choice is here and fits this Mac); OpenRouter's transcription
    // endpoint when the cloud was chosen. A take is never re-sent to the other engine: a local
    // failure is reported, never quietly billed, and a cloud failure never loads a model.
    const meta = parseTakeMeta(req.headers['x-dreamcontext-take']);
    const route = resolveDictation();
    const unconfigured = (failed: string, message: string): void => {
      logVoiceEvent({ kind: 'stt', ...meta, bytes: audioEarly.length, failed });
      sendJson(res, 400, { error: 'stt_unconfigured', message });
    };
    const tooBig = (model: string): string => {
      const m = machineInfo();
      return `The ${model} speech model is too large for this Mac's memory (${Math.round(m.memBytes / 1024 ** 3)} GB), so it was not loaded. Choose ${recommendModel(m)} or the cloud in Settings → Voice.`;
    };

    if (route.engine === 'none') {
      unconfigured('stt_unconfigured', 'Dictation is not set up yet. Choose where it runs in Settings → Voice: on this Mac (a model sized for it) or in the cloud.');
      return;
    }

    if (route.engine === 'cloud') {
      if (!route.ready) {
        unconfigured('stt_unconfigured', 'Cloud dictation needs an OpenRouter key. Add it in Settings → Voice.');
        return;
      }
      const cloud = await transcribeCloud(audioEarly, { language: cfgEarly.sttLanguage });
      if (!cloud.ok) {
        if (cloud.reason === 'auth' || cloud.reason === 'no_key') {
          unconfigured('stt_unconfigured', 'OpenRouter refused the key (wrong, revoked or out of credit). Check it in Settings → Voice.');
          return;
        }
        logVoiceEvent({ kind: 'stt', ...meta, bytes: audioEarly.length, failed: 'stt_failed' });
        if (cloud.reason === 'rejected') {
          // 400: this take, not retried — the same bytes would be refused the same way.
          sendJson(res, 400, { error: 'stt_failed', message: 'The cloud could not transcribe this take. Try a shorter one.' });
          return;
        }
        sendJson(res, 503, { error: 'stt_failed', message: 'Cloud transcription did not answer. Try again in a moment.' });
        return;
      }
      console.info(`[voice:stt] cloud ${cloud.model} ${cloud.ms}ms`);
      const record = { kind: 'stt', ...meta, bytes: audioEarly.length, engine: `cloud:${cloud.model}`, ms: cloud.ms, chars: cloud.text.length };
      logVoiceEvent(record);
      keepTake(audioEarly, { ...record, contextRoot, quality: 'clean', language: cfgEarly.sttLanguage || 'auto', text: cloud.text });
      sendJson(res, 200, { text: cloud.text, ms: cloud.ms, engine: `cloud:${cloud.model}` });
      return;
    }

    const install = route.install;
    if (!install) {
      unconfigured('stt_unconfigured', 'The chosen speech model is not installed yet. Finish it in Settings → Voice.');
      return;
    }
    if (route.blocked === 'too_big') { unconfigured('stt_too_big', tooBig(install.modelName)); return; }
    if (route.blocked === 'load_failed') {
      unconfigured('stt_load_failed', `The ${install.modelName} speech model could not be loaded on this Mac. Choose a smaller model or the cloud in Settings → Voice.`);
      return;
    }

    // Under load (memory, swap or heat — the Super Agent's own reading), the model stays out of
    // RAM: a loaded one is unloaded by `checkPressure`, and none is loaded until the load is gone.
    const pressure = await checkPressure();
    if (pressure.pressed) {
      const what = pressure.why === 'heat' ? 'running hot' : 'short on memory';
      // THIS take only (409, its own code): not `stt_unconfigured`, which the composer reads as
      // "dictation is not set up" until Settings changes, and not retryable — the load will
      // not be gone in the composer's retry window.
      logVoiceEvent({ kind: 'stt', ...meta, bytes: audioEarly.length, failed: 'stt_pressure' });
      sendJson(res, 409, {
        error: 'stt_pressure',
        message: `This Mac is ${what} right now, so local dictation is paused to keep it responsive. Try again in a minute, or switch dictation to the cloud in Settings → Voice.`,
      });
      return;
    }

    // Loaded HERE, on the first take, never at launch — and unloaded again after idle.
    const ladder = await transcribeWithRetry(audioEarly, {
      cfg: cfgEarly,
      conv: typeof meta.conv === 'string' ? meta.conv : null,
      ui: meta.ui,
      install,
      // The vault's own vocabulary, biasing the decoder toward the words this project
      // actually uses. Vault-scoped, which is why `/stt` is classified vault-SCOPED.
      lexicon: buildVoiceLexicon(contextRoot),
    });
    if (ladder) {
      const { winner, verdict, passes, ms, context, attempts } = ladder;
      const engine = `local:${winner.pass.model}`;
      console.info(`[voice:stt] local ${winner.pass.model} ${ms}ms ${verdict} (${passes} pass${passes > 1 ? 'es' : ''})`);
      const record = {
        kind: 'stt', ...meta, bytes: audioEarly.length, engine, ms, chars: winner.pass.text.length,
        quality: verdict, passes, language: winner.pass.language ?? 'auto', attempts,
      };
      logVoiceEvent(record);
      const take = keepTake(audioEarly, {
        ...record,
        contextRoot,
        primary: context.primary,
        // A garbled take feeds no context and binds to no message; its text stays for replay.
        text: winner.pass.text,
      }) ?? '';
      if (verdict === 'garbled') {
        // NOTHING IS SENT (owner, 2026-10-24): the page shows "Anlayamadım" and plays the cue.
        // `heard` is what whisper made of it, for the dimmed line under the notice.
        // At most CUE_WAIT_MS inside the gate: a cold render goes on in the background and is
        // cached for the next garbled take; this one shows the written notice alone.
        const cue = await Promise.race([
          cueAudio(context.primary ?? meta.ui ?? 'en').catch(() => null),
          new Promise<null>((r) => { const t = setTimeout(() => r(null), CUE_WAIT_MS); t.unref?.(); }),
        ]);
        const body: SttGarbled = { garbled: true, heard: winner.pass.text.slice(0, 200), take, ms, passes };
        if (cue && cue.length < 400_000) body.cue = { mime: 'audio/wav', b64: cue.toString('base64') };
        sendJson(res, 200, body);
        return;
      }
      const ok: SttOk = {
        text: winner.pass.text, ms, engine, take, quality: verdict,
        language: winner.pass.language ?? '', passes,
      };
      sendJson(res, 200, ok);
      return;
    }
    // The model never came up (out of memory, a bad file): PERMANENT for this choice, so the
    // composer stops retrying a load that would only fail again, and the owner is told why.
    if (localBlocked(install) === 'load_failed') {
      unconfigured('stt_load_failed', `The ${install.modelName} speech model could not be loaded on this Mac. Choose a smaller model or the cloud in Settings → Voice.`);
      return;
    }
    logVoiceEvent({ kind: 'stt', ...meta, bytes: audioEarly.length, failed: 'stt_failed' });
    // Loaded but silent is a TRANSIENT failure (a busy whisper server): the composer retries it.
    sendJson(res, 503, { error: 'stt_failed', message: 'Local transcription did not answer. Try again in a moment.' });
  } finally {
    sttGate.release();
    if (phone) phoneSttGate.release();
  }
}

// ─── POST /api/agent/voice/retranscribe ───────────────────────────────────────────────────

/** Retranscribes per take, and per session per minute. */
export const RETRANSCRIBE_PER_TAKE = 2;
export const RETRANSCRIBE_PER_MINUTE = 6;
const retranscribed = new Map<string, number>();
const sessionMinute = new Map<string, number[]>();

/** Forget the caps (tests). */
export function resetRetranscribeCaps(): void { retranscribed.clear(); sessionMinute.clear(); }

/**
 * A chat's agent asks for ONE more pass over a take it received (`dreamcontext voice retry`),
 * forced to the language the conversation is in — the second layer behind the `/stt` ladder
 * (owner, 2026-10-24: "önce dene, olmazsa sor").
 *
 * WHO MAY: only the chat process holding a live window token, from this machine, never over
 * the phone's tunnel (refused here AND in the route policy). WHAT: only a take bound to that
 * chat (`session`) in that chat's own vault; the lexicon comes from the token's vault, never
 * from a `?vault=`. HOW OFTEN: {@link RETRANSCRIBE_PER_TAKE} per take and
 * {@link RETRANSCRIBE_PER_MINUTE} per session a minute, counted before the pass starts.
 */
export async function handleVoiceRetranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (isPhoneSocket(req) || !isLoopback(req)) {
    sendError(res, 403, 'local_only', 'Retranscribing a take is only possible from a chat on this machine.');
    return;
  }
  const token = channelFor(req.headers[WINDOW_TOKEN_HEADER]);
  const who = token ? identityOf(token) : null;
  if (!who) {
    sendError(res, 401, 'not_a_chat', 'Only an agent running in a dreamcontext chat can retranscribe its own voice takes.');
    return;
  }
  const body = (await parseJsonBody(req).catch(() => null)) ?? {};
  const rawLang = typeof body.language === 'string' ? body.language.trim() : '';
  const forcedLang = rawLang ? normalizeLanguage(rawLang) : null;
  if (rawLang && !forcedLang) {
    sendError(res, 400, 'bad_language', 'That is not a language dictation knows (use a code like tr or en).');
    return;
  }
  let take;
  if (body.ref === undefined || body.ref === null || body.ref === '') {
    const latest = latestTakeOf(who.sessionId, who.contextRoot);
    take = latest ? findTake(latest.ref) : null;
  } else {
    if (typeof body.ref !== 'string' || !TAKE_REF_RE.test(body.ref)) {
      sendError(res, 404, 'unknown_take', 'No such voice take (or it has expired).');
      return;
    }
    take = findTake(body.ref);
  }
  if (!take) {
    sendError(res, 404, 'unknown_take', 'No such voice take (or it has expired).');
    return;
  }
  if (take.session !== who.sessionId || take.contextRoot !== who.contextRoot) {
    sendError(res, 403, 'not_your_take', 'That voice take was not sent to this chat.');
    return;
  }
  // The caps, checked and counted synchronously before anything awaits.
  const now = Date.now();
  const recent = (sessionMinute.get(who.sessionId) ?? []).filter((t) => now - t < 60_000);
  if ((retranscribed.get(take.ref) ?? 0) >= RETRANSCRIBE_PER_TAKE || recent.length >= RETRANSCRIBE_PER_MINUTE) {
    sendError(res, 429, 'retry_capped', 'This take has been retranscribed enough; ask the owner to say it again.');
    return;
  }
  retranscribed.set(take.ref, (retranscribed.get(take.ref) ?? 0) + 1);
  sessionMinute.set(who.sessionId, [...recent, now]);

  const verdict = sttGate.acquire();
  if (verdict !== 'ok') {
    sendJson(res, 429, { error: 'stt_busy', message: 'Another recording is still being transcribed.' });
    return;
  }
  try {
    const language = forcedLang ?? take.primary ?? take.language ?? 'auto';
    let wav: Buffer;
    try { wav = readFileSync(take.wavPath); } catch {
      sendError(res, 404, 'unknown_take', 'No such voice take (or it has expired).');
      return;
    }
    // The owner's chosen model, and never one this Mac cannot carry or that failed to load.
    const route = resolveDictation();
    const install = route.engine === 'local' && !route.blocked ? route.install : null;
    if (install) {
      const pressure = await checkPressure();
      if (pressure.pressed) {
        sendJson(res, 409, { error: 'stt_pressure', message: `This Mac is ${pressure.why === 'heat' ? 'running hot' : 'short on memory'}; the speech model stays unloaded for now. Try again in a moment.` });
        return;
      }
    }
    const pass = install ? await transcribeLocal(wav, { language, install, lexicon: buildVoiceLexicon(who.contextRoot) }) : null;
    if (!pass) {
      sendJson(res, 503, { error: 'stt_failed', message: 'Local transcription did not answer. Try again in a moment.' });
      return;
    }
    const judged = score(pass, { set: pass.language ? [pass.language] : [] });
    const quality = judged.scriptFlag ? 'garbled' : judged.verdict;
    logVoiceEvent({ kind: 'retranscribe', language: pass.language, quality, reasons: judged.reasons, ms: pass.ms });
    sendJson(res, 200, { ref: take.ref, text: pass.text, language: pass.language ?? language, quality, reasons: judged.reasons });
  } finally {
    sttGate.release();
  }
}

/** The pcm16 the model produced, and the words it says it is speaking. */
export interface StreamedSpeech {
  audio: Buffer;
  /** Concatenated `delta.audio.transcript`. Empty when the provider sent none — see
   *  `verbatim.ts` for why that must degrade to "unverified", never to "silent". */
  transcript: string;
}

/**
 * Drain an SSE completion stream and return the concatenated pcm16 WITH the transcript that
 * came alongside it.
 *
 * Two details are not obvious and both were found against the live API: an audio delta may
 * carry `transcript` and no `data`, and an error can arrive INSIDE the stream with a 200
 * already on the wire — so a failure here is not something the status line can be trusted for.
 *
 * The transcript was previously dropped as "the words being spoken, useless to us". It is the
 * opposite of useless: it is the only evidence of what the owner is about to HEAR, and this
 * model answers the line instead of reading it often enough that speech has to be checked
 * rather than assumed (`verbatim.ts`).
 */
export async function collectStreamedAudio(upstream: Response, key?: string | null): Promise<StreamedSpeech> {
  const reader = upstream.body?.getReader();
  if (!reader) return { audio: Buffer.alloc(0), transcript: '' };
  const decoder = new TextDecoder();
  const parts: Buffer[] = [];
  let transcript = '';
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      let frame: {
        error?: unknown;
        choices?: Array<{ delta?: { audio?: { data?: unknown; transcript?: unknown } } }>;
      };
      try { frame = JSON.parse(payload); } catch { continue; }
      if (frame.error) {
        logUpstream('tts', 200, JSON.stringify(frame.error), key);
        throw new Error('upstream error mid-stream');
      }
      const delta = frame.choices?.[0]?.delta?.audio;
      const data = delta?.data;
      if (typeof data === 'string' && data) parts.push(Buffer.from(data, 'base64'));
      if (typeof delta?.transcript === 'string') transcript += delta.transcript;
    }
  }
  return {
    audio: parts.length ? Buffer.concat(parts) : Buffer.alloc(0),
    transcript: transcript.trim(),
  };
}

// ─── POST /api/agent/voice/tts ────────────────────────────────────────────────

export async function handleVoiceTts(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }

  const verdict = ttsGate.acquire();
  if (verdict !== 'ok') {
    // Logged, because a refusal used to be the one fate of a chunk voice.jsonl never showed:
    // the queue turned it into a silent skip (2026-10-21). The client now waits a 429 out.
    logVoiceEvent({ kind: 'tts', outcome: verdict === 'busy' ? 'refused-busy' : 'refused-rate' });
    sendJson(res, 429, { error: 'tts_busy', message: 'Too many speech requests.' });
    return;
  }

  // ── THE CALLER WENT AWAY ──────────────────────────────────────────────────────────────
  // A barge-in aborts the page's requests, and the generation behind each one used to run on
  // regardless — holding its gate slot for seconds (a retry and the fallback could triple it).
  // The next turn's first sentences then met a full gate. Now the upstream call is aborted
  // and the slot handed back as soon as the response closes unfinished.
  const gone = new AbortController();
  const onClose = (): void => { if (!res.writableFinished) gone.abort(); };
  res.on('close', onClose);

  try {
    const body = await parseJsonBody(req);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    // The page's name for this chunk, so its `speech` line and this `tts` line can be matched.
    const id = typeof body?.id === 'string' && /^[\w-]{1,48}$/.test(body.id) ? body.id : undefined;
    const idField = id ? { id } : {};
    if (!text) {
      sendJson(res, 400, { error: 'tts_failed', message: 'No text to speak.' });
      return;
    }
    if (text.length > MAX_TTS_CHARS) {
      // The client chunks to roughly a sentence, so this is only ever reached by a direct
      // POST — which is exactly the case AC12 is about.
      logVoiceEvent({ kind: 'tts', outcome: 'refused-too-long', chars: text.length, ...idField });
      sendJson(res, 413, { error: 'tts_busy', message: 'That chunk is too long to speak.' });
      return;
    }

    // The LAST line of defence, applied here rather than in the client. The chunker never
    // sends a fenced block in the first place (`speechQueue.ts` excludes them outright), so
    // what this catches is the residue of ordinary prose: a stray URL, a file path, an em
    // dash. Applied AFTER the character cap, so a hostile direct POST cannot pad its way
    // under the limit with markup that strips away.
    const spoken = speakable(text);
    // Context, never content: the chunk before this one, so the voice reads on rather than
    // starting cold (`speechMessages`). It is not spoken and not verbatim-checked.
    const prev = contextLine(body?.prev);
    // The pause this chunk leaves before the next: a breath after a sentence, almost none in
    // the middle of one (`trimSpeechTail`).
    const tailMs = lineContinues(spoken) ? CLAUSE_TAIL_MS : SENTENCE_TAIL_MS;
    const startedAt = Date.now();
    // One line per chunk in voice.jsonl: which were spoken, rescued, or dropped, and why —
    // and how long the speech took to make (`genMs`), the number a seam gap is made of.
    const chunkLog = (outcome: string, extra: Record<string, unknown> = {}) =>
      logVoiceEvent({
        kind: 'tts', outcome, chars: text.length, spokenChars: spoken.length, ...idField,
        ...(prev ? { context: true } : {}), genMs: Date.now() - startedAt, ...extra,
      });
    if (!spoken) {
      // Nothing speakable survived — a chunk that was only a link, or only a fence. This is
      // not a failure, so it is not `tts_failed`: the queue treats 204 as "skip this one and
      // keep going", the same as it treats a failed chunk (AC10), but without logging noise.
      chunkLog('nothing-speakable');
      res.writeHead(204).end();
      return;
    }

    const key = voiceApiKey();
    if (!key) {
      chunkLog('unconfigured');
      sendJson(res, 400, {
        error: 'tts_unconfigured',
        message: 'No OpenRouter key is set. The mode still works as text.',
      });
      return;
    }

    const model = await resolveModel('speech', { key });
    if (!model.ok) {
      chunkLog(model.reason === 'unreachable' ? 'failed' : 'unconfigured');
      sendJson(res, model.reason === 'unreachable' ? 502 : 400, {
        error: model.reason === 'unreachable' ? 'tts_failed' : 'tts_unconfigured',
        message: model.detail,
      });
      return;
    }

    const cfg = readVoiceConfig();
    // CHAT COMPLETIONS again, and STREAMING is not optional: the API refuses audio output
    // without `stream: true`, and refuses `mp3` WITH it. So speech arrives as headerless
    // pcm16 at 24 kHz, in SSE deltas, and is given its RIFF header here.
    /**
     * The last resort when the chat model will not read the line: a REAL text-to-speech
     * model, on the same key.
     *
     * `google/gemini-3.1-flash-tts-preview` cannot "answer the line instead of reading it" —
     * it has no conversation to have — so it ends the one failure mode the verbatim guard
     * could otherwise only turn into silence. Measured at 0.75-1.37x realtime against the
     * chat model's 0.31-0.55x, which is why it is the fallback rather than the default: 2.4x
     * slower is worth paying on the rare chunk that would otherwise be dropped, and not on
     * every chunk. It detects the language itself and takes no language parameter.
     */
    const speakWithRealTts = async (): Promise<Buffer | null> => {
      // The owner's pick, translated — this model has its own voice list and would refuse
      // `onyx` outright. A REFUSED voice is retried once with the known-good one rather than
      // dropping the chunk: the rescue path exists to stop a sentence going missing, and it
      // must not become a new way for one to go missing over a preference.
      const voices = [fallbackVoice(cfg.voice || DEFAULT_VOICE), FALLBACK_VOICE_DEFAULT];
      for (const candidate of AUDIO_MODELS.speechFallback) {
        for (const voice of [...new Set(voices)]) {
          try {
            const r = await fetch(`${OPENROUTER_BASE}/audio/speech`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...OPENROUTER_HEADERS },
              signal: untilGoneOr(TTS_TIMEOUT_MS, gone.signal),
              // `pcm` is the ONLY format this model accepts, and it is the same 24 kHz mono
              // pcm16 the chat path returns — so the WAV wrapper below serves both.
              body: JSON.stringify({ model: candidate, input: spoken, voice, response_format: 'pcm' }),
            });
            if (!r.ok) {
              logUpstream('tts-fallback', r.status, await r.text().catch(() => ''), key);
              continue;
            }
            return Buffer.from(await r.arrayBuffer());
          } catch (err) {
            if (gone.signal.aborted) return null;
            console.error('[voice:tts] fallback failed', err);
          }
        }
      }
      return null;
    };

    const generate = async (): Promise<StreamedSpeech> => {
      const upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...OPENROUTER_HEADERS,
        },
        signal: untilGoneOr(TTS_TIMEOUT_MS, gone.signal),
        body: JSON.stringify({
          model: model.id,
          stream: true,
          modalities: ['text', 'audio'],
          audio: { voice: cfg.voice || DEFAULT_VOICE, format: 'pcm16' },
          // The few-shot sits between the system prompt and the line, and is what makes a
          // one-word line get READ rather than answered. See `JARVIS_FEWSHOT`.
          // The previous line rides along as context — see `speechMessages`.
          messages: speechMessages(spoken, prev),
        }),
      });
      if (!upstream.ok) {
        logUpstream('tts', upstream.status, await upstream.text().catch(() => ''), key);
        throw new Error(`upstream ${upstream.status}`);
      }
      return collectStreamedAudio(upstream, key);
    };

    // ── GENERATE, THEN CHECK WHAT WAS ACTUALLY SAID ────────────────────────────────────
    //
    // The model answers the line instead of reading it often enough that speech cannot be
    // taken on trust (`verbatim.ts` holds the measurements). The check is cheap — the words
    // it is speaking ride along in the same stream — and the retry is worth its cost because
    // the failure is STOCHASTIC: the same sentence that was answered in one round is read
    // correctly in the next, so a second attempt usually lands.
    let speech: StreamedSpeech;
    let retried = false;
    try {
      speech = await generate();
      if (!readVerbatim(spoken, speech.transcript) && !gone.signal.aborted) {
        retried = true;
        console.warn(
          `[voice:tts] the model answered the line instead of reading it `
          + `(match ${verbatimRatio(spoken, speech.transcript).toFixed(2)}) — retrying`,
        );
        speech = await generate();
      }
    } catch (err) {
      if (gone.signal.aborted) {
        // Nobody is waiting for this chunk any more: the slot goes back now, not in seconds.
        chunkLog('abandoned', { retried });
        return;
      }
      console.error('[voice:tts] request failed', err);
      chunkLog('failed', { retried });
      sendJson(res, 502, { error: 'tts_failed', message: 'Speech failed for this chunk.' });
      return;
    }

    if (gone.signal.aborted) {
      chunkLog('abandoned', { retried });
      return;
    }
    if (!readVerbatim(spoken, speech.transcript)) {
      // Twice over. The chunk is DROPPED rather than played, and the distinction is the whole
      // point of this route: a missing sentence is a gap in speech the owner can still read on
      // screen, while a played one is the agent saying something it never wrote. 204 is the
      // queue's "skip and keep going" (AC10), so the rest of the answer is unaffected.
      // TWICE the chat model answered instead of reading. Rather than drop the sentence —
      // a hole in the speech the owner can only find by reading the screen — hand it to a
      // real TTS, which cannot make this mistake.
      console.warn('[voice:tts] the chat model would not read the line — using the TTS model');
      const rescued = await speakWithRealTts();
      if (gone.signal.aborted) {
        chunkLog('abandoned', { retried });
        return;
      }
      if (!rescued || rescued.length === 0) {
        chunkLog('dropped-not-read', { ratio: Number(verbatimRatio(spoken, speech.transcript).toFixed(2)) });
        res.writeHead(204).end();
        return;
      }
      const wav = wavFromPcm16(normalizeSpeech(trimSpeechTail(rescued, tailMs)), PCM16_SAMPLE_RATE);
      console.info(`[voice:tts] ${pcmSeconds(rescued).toFixed(1)}s spoken by the fallback`);
      chunkLog('spoken-by-fallback', { seconds: Number(pcmSeconds(rescued).toFixed(1)) });
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': wav.length,
        'Cache-Control': 'no-store',
      });
      res.end(wav);
      return;
    }

    const pcm = speech.audio;
    if (pcm.length === 0) {
      // The model answered in text only — a refusal, or a chunk it decided was nothing to
      // say. Treated exactly like an unspeakable chunk: skip it and keep the queue moving.
      chunkLog('dropped-no-audio', { retried });
      res.writeHead(204).end();
      return;
    }

    // NORMALISED BEFORE IT IS WRAPPED. This is the only point in the path where the answer
    // can actually be made louder: after this it is a WAV played through a master volume the
    // app does not own. See `normalizeSpeech` for why the client's gain node cannot do it.
    // The seam first: the model's half-second tail cut to a breath (`trimSpeechTail`).
    const trimmed = trimSpeechTail(pcm, tailMs);
    const audio = wavFromPcm16(normalizeSpeech(trimmed), PCM16_SAMPLE_RATE);
    console.info(`[voice:tts] ${pcmSeconds(pcm).toFixed(1)}s spoken`);
    chunkLog('spoken', {
      retried,
      seconds: Number(pcmSeconds(trimmed).toFixed(1)),
      trimmedMs: Math.round((pcmSeconds(pcm) - pcmSeconds(trimmed)) * 1000),
      // Below 1 means the voice left words out (a full read scores 1.00, measured 2026-10-13).
      ratio: speech.transcript ? Number(verbatimRatio(spoken, speech.transcript).toFixed(2)) : null,
    });
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': audio.length,
      // Never cached to disk by an intermediary: it is the owner's conversation.
      'Cache-Control': 'no-store',
    });
    res.end(audio);
  } catch (err) {
    console.error('[voice:tts] unexpected failure', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'tts_failed', message: 'Speech failed for this chunk.' });
    }
  } finally {
    res.off('close', onClose);
    ttsGate.release();
  }
}

/**
 * Aborts after `ms`, or as soon as `gone` does — whichever comes first. (`AbortSignal.any` is
 * Node 20.3+, and the CLI still runs on 18.)
 */
function untilGoneOr(ms: number, gone: AbortSignal): AbortSignal {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), ms);
  timer.unref?.();
  const onGone = (): void => { clearTimeout(timer); ctl.abort(new Error('client gone')); };
  if (gone.aborted) onGone();
  else gone.addEventListener('abort', onGone, { once: true });
  return ctl.signal;
}

// ─── POST /api/agent/voice/warm ──────────────────────────────────────────────────────────

/**
 * Kept as a route for clients from before 0.35.1, and deliberately a NO-OP.
 *
 * It used to load the local model whenever assistant mode opened — at every launch — and on an
 * 8 GB MacBook Air that load took the app down (owner, 2026-10-27). The model now loads on the
 * first take only (`whisper.ts`), so warming answers "nothing" and touches nothing.
 */
export async function handleVoiceWarm(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }
  // The "Anlayamadım" cue for the language the next take will most likely be in, rendered now
  // so a garbled take does not wait on `say`. No model is loaded here.
  prerenderCue(contextFor({ cfg: readVoiceConfig(), takes: contextTakes() }).primary ?? 'en');
  sendJson(res, 200, { warming: null });
}

// ─── POST /api/agent/voice/log ────────────────────────────────────────────────────────

/** What the notch may report about a presentation (Notch.tsx `openForPresentation`). */
const NOTCH_ACTIONS = new Set(['opened', 'kept-open', 'already-open', 'switched-off', 'peeked', 'folded']);

/**
 * One line from the page into voice.jsonl: what the notch DID with a reply it was asked to show.
 * The server sees the take and the chunk; only the notch knows whether it opened for an answer,
 * and "the window never opens" (owner, 2026-10-13) cannot be checked against nothing. A fixed
 * vocabulary of known fields — the page's own claim, only ever logged.
 *
 * `{kind:"turn"}` is the other record: one voice turn timed from the hotkey's release to the
 * first audible chunk (`parseTurnTrace`), the measurement the 2026-10-13 speed work starts from.
 * `{kind:"speech"}` is one spoken chunk's fate (`parseSpeechReport`): the line per sentence
 * that shows which one was played, skipped or cut, and why.
 */
export async function handleVoiceLog(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }
  const body = await parseJsonBody(req).catch(() => null) as Record<string, unknown> | null;
  if (body?.kind === 'speech') {
    // One spoken chunk's fate from the page's queue (played / skipped / cut, and why).
    const chunk = parseSpeechReport(body);
    if (!chunk) {
      sendError(res, 400, 'bad_request', 'Unknown speech record.');
      return;
    }
    logVoiceEvent(chunk);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (body?.kind === 'turn') {
    // A voice turn's timing (dashboard/src/lib/voice/turnTrace.ts), plus what the page cannot
    // know: the model and effort the Assistant is configured to run.
    const turn = parseTurnTrace(body);
    if (!turn) {
      sendError(res, 400, 'bad_request', 'Unknown turn record.');
      return;
    }
    const config = readAssistantConfig() ?? DEFAULT_ASSISTANT_CONFIG;
    logVoiceEvent({ ...turn, configModel: config.model ?? null, effort: config.effort ?? null });
    sendJson(res, 200, { ok: true });
    return;
  }
  const action = typeof body?.action === 'string' && NOTCH_ACTIONS.has(body.action) ? body.action : null;
  if (!action) {
    sendError(res, 400, 'bad_request', 'Unknown notch action.');
    return;
  }
  logVoiceEvent({
    kind: 'notch',
    action,
    cue: body?.cue === 'progress' || body?.cue === 'present' ? body.cue : null,
    stay: body?.stay === true,
    seat: body?.seat === 'window' || body?.seat === 'notch' ? body.seat : null,
    chars: typeof body?.chars === 'number' && Number.isFinite(body.chars) ? Math.max(0, Math.round(body.chars)) : null,
  });
  sendJson(res, 200, { ok: true });
}

// ─── POST /api/agent/voice/focus ──────────────────────────────────────────────────────

/**
 * Take or release the SPEAKER — and, with it, whatever the machine was playing.
 *
 * One route for two things on purpose; `lib/voice/audioFocus.ts` opens with why a floor
 * released without restoring the music (and the reverse) is the failure a second route would
 * invite.
 *
 * SHAPE: `{ session, hold: boolean }`. `hold: true` is IDEMPOTENT and also a heartbeat — the
 * client calls it as each chunk starts playing, which both extends the lease and keeps the
 * music paused exactly ONCE for the whole turn rather than stuttering at every sentence.
 *
 * IT SPENDS NO MONEY AND IT IS GATED ANYWAY. "Costs nothing" was the wrong axis, and review
 * caught it: this route spawns `osascript` processes and mutates the owner's machine — their
 * music player, their system volume. The LAN peer the paid routes were gated against reaches
 * this one just as easily, and a `hold`/`release` loop is unbounded churn. It never puts a
 * caller-supplied string into a script (the player table is a module constant, and there is no
 * shell), and it is desktop-gated like the audio routes.
 *
 * A FAILURE HERE MUST NEVER COST THE ANSWER. Every error path answers 200 with
 * `granted: true` and no ducking: the worst case for a broken focus call is an answer read
 * over music, and the worst case for a 500 the client treats as "do not speak" is a mode that
 * has gone silent for a reason nobody can see.
 */
export async function handleVoiceFocus(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }
  const body = await parseJsonBody(req);
  const raw = typeof body?.session === 'string' ? body.session.trim() : '';
  // Bounded because it is a caller-supplied key held in module state. It never reaches a
  // script (see the header), so this is a hygiene bound, not an injection defence: a session
  // id is a UUID, and anything longer is not one.
  const session = raw.slice(0, 128);
  if (!session) {
    sendError(res, 400, 'bad_session', 'A session id is required to hold the speaker.');
    return;
  }
  const verdict = focusGate.acquire();
  if (verdict !== 'ok') {
    // TRANSIENT, and the client treats it as such: a refused focus call costs at most an
    // answer read over music, never a silent turn.
    sendError(res, 429, 'focus_busy', 'Too many speaker requests at once.');
    return;
  }
  hookExitRestore();
  try {
    if (body?.hold === false) {
      await release(session);
      sendJson(res, 200, { granted: false, holder: null, ducked: false, gain: 1, paused: [] });
      return;
    }
    sendJson(res, 200, await hold(session));
  } catch (err) {
    // Logged, never forwarded (rule 1 at the top of this file) — and FAIL OPEN, per the note
    // above: speak, over music if it comes to that.
    console.warn('[voice:focus] failed', err);
    sendJson(res, 200, {
      granted: true, holder: session, ducked: false, gain: 1, paused: [], denied: false,
    });
  } finally {
    focusGate.release();
  }
}

// ─── GET /api/agent/voice/status · PUT /api/agent/voice/config ────────────────

export async function handleVoiceStatus(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Deliberately NOT desktop-gated: the web dashboard renders no mic button, but its
  // Settings page still has to be able to say "voice is a desktop feature" truthfully rather
  // than showing a card in an unknown state.
  sendJson(res, 200, {
    ...voiceStatus(),
    desktop: isDesktop(),
    // What a take would use, so the engine row can say "Local · small" instead of offering a
    // choice the owner cannot verify.
    localWhisper: localModelName(),
  });
}

export async function handleVoiceConfigPut(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'bad_body', 'Expected a JSON object.');
    return;
  }
  const patch: Record<string, string | string[] | number | boolean | null | undefined> = {};
  // `null` clears; `undefined` (an absent field) leaves the stored value alone — so the
  // Settings card can save the voice picker without blanking a key it never rendered.
  if ('openRouterKey' in body) patch.openRouterKey = body.openRouterKey === null ? null : String(body.openRouterKey ?? '');
  if ('voice' in body) patch.voice = String(body.voice ?? '');
  if ('sttLanguage' in body) {
    // `auto` or a language from the fixed table; anything else is refused, never stored.
    const raw = String(body.sttLanguage ?? '').trim();
    const code = normalizeLanguage(raw);
    if (raw && raw !== 'auto' && !code) {
      sendError(res, 400, 'bad_language', 'That is not a language dictation knows.');
      return;
    }
    patch.sttLanguage = raw === 'auto' || !raw ? raw : code;
  }
  if ('sttLanguages' in body) {
    // "Languages I speak": unknown entries are dropped, the rest normalized and deduplicated.
    if (!Array.isArray(body.sttLanguages)) {
      sendError(res, 400, 'bad_languages', 'Languages I speak is a list of language codes.');
      return;
    }
    const list = body.sttLanguages;
    patch.sttLanguages = [...new Set(list.map(normalizeLanguage).filter((l): l is string => !!l))].slice(0, 12);
  }
  if ('speech' in body) patch.speech = Boolean(body.speech);
  if ('pushToTalkMode' in body) {
    if (body.pushToTalkMode !== 'hold' && body.pushToTalkMode !== 'toggle') {
      sendError(res, 400, 'bad_mode', 'Push-to-talk is either held or toggled.');
      return;
    }
    patch.pushToTalkMode = body.pushToTalkMode;
  }
  if ('speechRate' in body) patch.speechRate = clampSpeechRate(Number(body.speechRate));
  if ('musicPause' in body) patch.musicPause = Boolean(body.musicPause);
  if ('musicDuck' in body) patch.musicDuck = clampMusicDuck(Number(body.musicDuck));
  if ('pushToTalk' in body) {
    if (body.pushToTalk === null || body.pushToTalk === '') {
      patch.pushToTalk = null;              // back to the default chord
    } else {
      // REFUSED rather than clamped, and this is the one field where that is right: a rate
      // out of range still plays, but a chord the composer cannot match is a mode with no
      // input. Saying so here is the only place the owner can be told.
      const chord = normalizeHotkey(String(body.pushToTalk ?? ''));
      if (!chord) {
        sendError(res, 400, 'bad_hotkey', 'That key combination cannot be used for push-to-talk.');
        return;
      }
      patch.pushToTalk = chord;
    }
  }

  try {
    writeVoiceConfig(patch);
  } catch (err) {
    console.error('[voice:config] write failed', err);
    sendError(res, 500, 'write_failed', 'Could not save the voice settings.');
    return;
  }
  // A new key means the previous "no model / no key" resolution is stale.
  clearModelCache();
  sendJson(res, 200, {
    ...voiceStatus(), desktop: isDesktop(), localWhisper: localModelName(),
  });
}

function localModelName(): string | null {
  const route = resolveDictation();
  return route.engine === 'local' && route.install ? route.install.modelName : null;
}

// ─── GET/POST /api/agent/voice/dictation ──────────────────────────────────────────────
/**
 * Local dictation's install state, and the button that installs it (`lib/voice/dictationInstall.ts`
 * decides HOW: Homebrew for the engine, a model already on disk or a one-time download).
 * Desktop-only like every voice route; vault-agnostic, because the engine and the model belong
 * to the machine. POST starts the install (or joins a running one) and answers at once — the
 * UI polls GET for progress rather than holding a request open for a 1.6 GB download.
 */
export async function handleDictationStatus(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }
  sendJson(res, 200, dictationState());
}

export async function handleDictationInstall(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }
  // The owner's choice is REQUIRED: a bare POST (what setup used to send on open) installs
  // nothing and downloads nothing.
  let choice;
  try {
    choice = parseDictationChoice(await parseJsonBody(req).catch(() => null));
  } catch (err) {
    if (err instanceof ChoiceRequired) { sendError(res, 400, 'choice_required', err.message); return; }
    throw err;
  }
  try {
    sendJson(res, 202, startDictationInstall(choice));
  } catch (err) {
    if (err instanceof InstallRunning) { sendError(res, 409, 'install_running', err.message); return; }
    throw err;
  }
}
