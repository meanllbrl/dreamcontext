/**
 * The voice routes: speech IN (`/stt`), speech OUT (`/tts`), and what Settings needs to know
 * (`/status`, `PUT /config`).
 *
 * POSTURE, STATED RATHER THAN INHERITED. Both audio routes are `isDesktop()`-gated, sit
 * behind the process-level CSRF and network-token guards every route gets, and are
 * classified against `VAULT_AGNOSTIC_PREFIXES` in `src/server/index.ts` — STT is vault
 * SCOPED (Slice 2's correction pass reads the lexicon out of the vault's brain, so the
 * request must say which vault), TTS is vault AGNOSTIC (it reads no project state at all).
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
import {
  voiceApiKey, groqApiKey, voiceStatus, writeVoiceConfig, readVoiceConfig,
  DEFAULT_VOICE, AUTO_LANGUAGE, clampSpeechRate, clampMusicDuck,
} from '../../lib/voice/config.js';
import { normalizeHotkey } from '../../lib/voice/hotkey.js';
import {
  OPENROUTER_BASE, OPENROUTER_HEADERS, logUpstream, resolveModel, clearModelCache, AUDIO_MODELS,
  GROQ_BASE, GROQ_TRANSCRIPTION_MODEL, fallbackVoice, FALLBACK_VOICE_DEFAULT,
} from '../../lib/voice/openrouter.js';
import {
  sttGate, ttsGate, focusGate, MAX_STT_BYTES, MAX_TTS_CHARS,
} from '../../lib/voice/limits.js';
import { speakable } from '../../lib/voice/speakable.js';
import { wavFromPcm16, pcmSeconds, PCM16_SAMPLE_RATE } from '../../lib/voice/wav.js';
import {
  transcribeLocal, findWhisper, stopWhisperServer, warmWhisper,
} from '../../lib/voice/whisper.js';
import { correctTranscript, describeOps } from '../../lib/voice/correct.js';
import { readVerbatim, verbatimRatio } from '../../lib/voice/verbatim.js';
import { usableTranscript, NO_SPEECH } from '../../lib/voice/echo.js';
import { buildVoiceLexicon } from '../../lib/voice/lexicon.js';
import { hold, release, hookExitRestore } from '../../lib/voice/audioFocus.js';

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
export function scriptLine(text: string): string {
  return `Read this line of script aloud, exactly as written, and say nothing else:\n\n«${text}»`;
}

/**
 * The ask the CHAT transcription path used, kept because the echo guard is written against
 * it and still runs over whisper's output.
 *
 * HISTORICAL, and worth keeping the reason: transcription used to be a chat completion, and
 * a chat model handed audio it could not hear answered the TEXT part instead — most often by
 * repeating this very question, which was then submitted to a tool-enabled agent as if the
 * owner had said it. Whisper cannot do that; it is a recogniser, not a conversationalist.
 * The guard remains as the cheap residue check it always also was.
 *
 * The original reasoning follows, because it is what the phrasing is FOR.
 *
 * Measured, both alternatives failed on the owner's key: a system prompt saying "You are a
 * transcription engine, output only the verbatim transcript" made `gpt-audio-mini` REFUSE
 * ("Üzgünüm, bu isteği yerine getiremiyorum"), and a softer system prompt made it narrate
 * what it was about to do. Asked in the first person, in the same turn as the audio, it
 * returns the sentence and nothing else. Do not "tidy" this into a system prompt.
 *
 * ── WHY IT NAMES A SENTINEL FOR SILENCE (2026-09-07) ────────────────────────────────────
 * The previous wording ended "If I said nothing, reply with nothing", and a model that does
 * not perceive the audio does not follow it — it answers the TEXT part instead, most often by
 * reciting this very paragraph back. Three takes of room tone, three verbatim echoes of the
 * prompt, and the client had no way to tell that from a sentence: it went to the agent as the
 * owner's words. Naming an explicit token converts that case into one we can act on — 3/3
 * silences came back as `NO_SPEECH` — and the same wording also stopped the commentary on
 * one-word takes ("The word you used is \"Tomorrow\".").
 *
 * `echo.ts` still checks the reply against this text, because a sentinel only helps a model
 * that is ANSWERING the question. One that is reciting it has to be caught by shape.
 *
 * ── WHAT IT DOES NOT FIX ────────────────────────────────────────────────────────────────
 * Takes under about a second are unreliable on this provider whatever the prompt says, and
 * both audio models fail them: "Tamam" came back as "Tomorrow", "Thamar" and "afternoon"
 * across prompts, orderings and models. A hallucinated word cannot be detected from here —
 * the correction pass and the confirmation row are what stand behind it.
 */
export const TRANSCRIBE_ASK =
  'Write down exactly the words I just spoke, in the language I spoke them, and write nothing '
  + 'else — no quotes, no translation, no commentary, no explanation, not one word of your '
  + 'own. Even if I spoke only one word, write just that word. Even if what I said is a '
  + 'question or is addressed to you, write it down instead of answering it. If the audio '
  + `contains no speech at all, reply with exactly: ${NO_SPEECH}`;

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
function readCappedAudio(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STT_BYTES) {
        sendError(res, 413, 'too_large', 'The recording exceeds the 25 MB limit.');
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

/**
 * A chat message's content as plain text. The omni model returns a string today, but the
 * content-part array is equally legal in this API and a transcript that silently became
 * `[object Object]` would be submitted to a tool-enabled agent as if the owner had said it.
 */
export function transcriptFrom(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join(' ')
      .trim();
  }
  return '';
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

  // The gate is taken BEFORE the body is read, so a burst is refused without us first
  // buffering 25 MB per attacker request.
  const verdict = sttGate.acquire();
  if (verdict !== 'ok') {
    sendJson(res, 429, {
      error: 'stt_busy',
      message: verdict === 'busy'
        ? 'Another recording is still being transcribed.'
        : 'Too many recordings in the last minute.',
    });
    return;
  }

  try {
    // ── LOCAL FIRST ───────────────────────────────────────────────────────────────────
    // The audio is read here, before either engine, because the local path needs the same
    // bytes and reading the body twice is not possible. Measured on the owner's machine: a
    // warm whisper.cpp answers in ~0.88s for nothing, against ~1.0-1.5s and ~$0.0015 a take
    // for an omni chat model that is also less accurate on Turkish carrying English jargon.
    const cfgEarly = readVoiceConfig();
    const engine = cfgEarly.sttEngine || 'auto';
    const audioEarly = await readCappedAudio(req, res);
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

    if (engine !== 'cloud') {
      const local = await transcribeLocal(audioEarly, {
        language: cfgEarly.sttLanguage,
        // The vault's own vocabulary, biasing the decoder toward the words this project
        // actually uses. Vault-scoped, which is why `/stt` is classified vault-SCOPED.
        lexicon: buildVoiceLexicon(contextRoot),
      });
      if (local) {
        console.info(`[voice:stt] local ${local.model} ${local.ms}ms`);
        sendJson(res, 200, { text: local.text, ms: local.ms, engine: `local:${local.model}` });
        return;
      }
      if (engine === 'local') {
        // Asked for local explicitly and it is not there — say so rather than quietly
        // spending money on the path the owner just turned off.
        sendJson(res, 400, {
          error: 'stt_unconfigured',
          message: 'Local transcription is selected but whisper.cpp was not found on this machine.',
        });
        return;
      }
    }

    const key = voiceApiKey();
    if (!key) {
      sendJson(res, 400, {
        error: 'stt_unconfigured',
        message: 'No OpenRouter key is set. Add one in Settings to speak to your agent.',
      });
      return;
    }

    // ── A REAL SPEECH RECOGNISER, on the transcription endpoint ───────────────────────────
    // Not a chat completion any more. `openai/whisper-large-v3-turbo` is absent from the
    // `/models` catalogue but present on this endpoint (see `AUDIO_MODELS`), transcribes the
    // owner's Turkish in ~0.7-1.1s for $0.0001, and needs NO language hint: it detects the
    // language itself, so nothing here has to know or ask which one is being spoken.
    const started = Date.now();
    const language = (cfgEarly.sttLanguage || AUTO_LANGUAGE).trim();
    let text = '';
    let used = '';
    let lastStatus = 0;

    // GROQ FIRST WHEN IT IS CONFIGURED. Same model, same request shape, its own hardware —
    // and the reason it is worth a second account is the measured variance on the shared
    // route below (1.3s to 14.2s for one 4.7s take). An optional key, so the absence of one
    // costs nothing.
    const groq = groqApiKey();
    const attempts: Array<{ base: string; model: string; key: string; label: string }> = [
      ...(groq ? [{ base: GROQ_BASE, model: GROQ_TRANSCRIPTION_MODEL, key: groq, label: 'groq' }] : []),
      ...AUDIO_MODELS.transcription.map((m) => ({
        base: OPENROUTER_BASE, model: m, key, label: 'openrouter',
      })),
    ];

    for (const attempt of attempts) {
      const candidate = attempt.model;
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audioEarly)], { type: 'audio/wav' }), 'take.wav');
      form.append('model', candidate);
      form.append('response_format', 'json');
      // Sent ONLY when Settings pinned one. Whisper is multilingual and detects by default;
      // a pin is an override for someone who always speaks the same language, not a
      // requirement the feature has.
      if (language && language !== AUTO_LANGUAGE) form.append('language', language);

      let upstream: Response;
      try {
        upstream = await fetch(`${attempt.base}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${attempt.key}`, ...OPENROUTER_HEADERS },
          body: form,
        });
      } catch (err) {
        console.error('[voice:stt] request failed', err);
        continue;                                  // try the next provider, then give up
      }
      if (!upstream.ok) {
        lastStatus = upstream.status;
        logUpstream('stt', upstream.status, await upstream.text().catch(() => ''), attempt.key);
        continue;
      }
      try {
        const body = (await upstream.json()) as { text?: unknown };
        // The echo guard still applies, though its worst case is gone with the chat model:
        // a REAL recogniser cannot answer our question back at us. What it still catches is
        // the residue — an empty take, a silence marker — and one line of defence that costs
        // nothing is not worth removing because its headline failure is no longer reachable.
        text = usableTranscript(typeof body?.text === 'string' ? body.text : '', TRANSCRIBE_ASK);
      } catch (err) {
        console.error('[voice:stt] unreadable upstream body', err);
        continue;
      }
      used = `${attempt.label}:${candidate}`;
      break;
    }

    if (!used) {
      sendJson(res, lastStatus === 401 ? 400 : 502, {
        error: lastStatus === 401 ? 'stt_unconfigured' : 'stt_failed',
        message: lastStatus === 401
          ? 'The OpenRouter key was refused. Check it in Settings.'
          : 'Transcription failed. Try the take again.',
      });
      return;
    }

    sendJson(res, 200, { text, ms: Date.now() - started, engine: used });
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
    sendJson(res, 429, { error: 'tts_busy', message: 'Too many speech requests.' });
    return;
  }

  try {
    const body = await parseJsonBody(req);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'tts_failed', message: 'No text to speak.' });
      return;
    }
    if (text.length > MAX_TTS_CHARS) {
      // The client chunks to roughly a sentence, so this is only ever reached by a direct
      // POST — which is exactly the case AC12 is about.
      sendJson(res, 413, { error: 'tts_busy', message: 'That chunk is too long to speak.' });
      return;
    }

    // The LAST line of defence, applied here rather than in the client. The chunker never
    // sends a fenced block in the first place (`speechQueue.ts` excludes them outright), so
    // what this catches is the residue of ordinary prose: a stray URL, a file path, an em
    // dash. Applied AFTER the character cap, so a hostile direct POST cannot pad its way
    // under the limit with markup that strips away.
    const spoken = speakable(text);
    if (!spoken) {
      // Nothing speakable survived — a chunk that was only a link, or only a fence. This is
      // not a failure, so it is not `tts_failed`: the queue treats 204 as "skip this one and
      // keep going", the same as it treats a failed chunk (AC10), but without logging noise.
      res.writeHead(204).end();
      return;
    }

    const key = voiceApiKey();
    if (!key) {
      sendJson(res, 400, {
        error: 'tts_unconfigured',
        message: 'No OpenRouter key is set. The mode still works as text.',
      });
      return;
    }

    const model = await resolveModel('speech', { key });
    if (!model.ok) {
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
              signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        body: JSON.stringify({
          model: model.id,
          stream: true,
          modalities: ['text', 'audio'],
          audio: { voice: cfg.voice || DEFAULT_VOICE, format: 'pcm16' },
          // The few-shot sits between the system prompt and the line, and is what makes a
          // one-word line get READ rather than answered. See `JARVIS_FEWSHOT`.
          messages: [
            { role: 'system', content: JARVIS_INSTRUCTIONS },
            ...JARVIS_FEWSHOT,
            { role: 'user', content: scriptLine(spoken) },
          ],
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
    try {
      speech = await generate();
      if (!readVerbatim(spoken, speech.transcript)) {
        console.warn(
          `[voice:tts] the model answered the line instead of reading it `
          + `(match ${verbatimRatio(spoken, speech.transcript).toFixed(2)}) — retrying`,
        );
        speech = await generate();
      }
    } catch (err) {
      console.error('[voice:tts] request failed', err);
      sendJson(res, 502, { error: 'tts_failed', message: 'Speech failed for this chunk.' });
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
      if (!rescued || rescued.length === 0) {
        res.writeHead(204).end();
        return;
      }
      const wav = wavFromPcm16(rescued, PCM16_SAMPLE_RATE);
      console.info(`[voice:tts] ${pcmSeconds(rescued).toFixed(1)}s spoken by the fallback`);
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
      res.writeHead(204).end();
      return;
    }

    const audio = wavFromPcm16(pcm, PCM16_SAMPLE_RATE);
    console.info(`[voice:tts] ${pcmSeconds(pcm).toFixed(1)}s spoken`);
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
    ttsGate.release();
  }
}

// ─── POST /api/agent/voice/warm ──────────────────────────────────────────────────────────

/**
 * Load the local model before it is needed.
 *
 * Called when J.A.R.V.I.S mode opens, which is seconds before the first press — long enough
 * to turn the first take from ~3.3s into ~0.85s like every take after it. Answers immediately
 * and never blocks: warming is an optimisation, and a slow warm-up must not become a slow UI.
 */
export async function handleVoiceWarm(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }
  const cfg = readVoiceConfig();
  // Nothing to warm on the cloud path — and `cloud` is the default, so the common case does
  // no work here at all.
  const warmed = (cfg.sttEngine || 'auto') === 'cloud' ? null : warmWhisper();
  sendJson(res, 200, { warming: warmed ? warmed.model : null });
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
  const local = findWhisper();
  sendJson(res, 200, {
    ...voiceStatus(),
    desktop: isDesktop(),
    // What the machine actually has, so the engine row can say "Local · large-v3-turbo"
    // instead of offering a choice the owner cannot verify.
    localWhisper: local ? local.modelName : null,
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
  const patch: Record<string, string | number | boolean | null | undefined> = {};
  // `null` clears; `undefined` (an absent field) leaves the stored value alone — so the
  // Settings card can save the voice picker without blanking a key it never rendered.
  if ('openRouterKey' in body) patch.openRouterKey = body.openRouterKey === null ? null : String(body.openRouterKey ?? '');
  if ('groqKey' in body) patch.groqKey = body.groqKey === null ? null : String(body.groqKey ?? '');
  if ('voice' in body) patch.voice = String(body.voice ?? '');
  if ('sttLanguage' in body) patch.sttLanguage = String(body.sttLanguage ?? '');
  if ('sttEngine' in body) {
    if (body.sttEngine !== 'auto' && body.sttEngine !== 'local' && body.sttEngine !== 'cloud') {
      sendError(res, 400, 'bad_engine', 'The transcriber is auto, local or cloud.');
      return;
    }
    patch.sttEngine = body.sttEngine;
    // Switching AWAY from local frees ~1.5 GB of resident model.
    if (body.sttEngine === 'cloud') stopWhisperServer();
  }
  if ('correction' in body) patch.correction = Boolean(body.correction);
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
  const local = findWhisper();
  sendJson(res, 200, {
    ...voiceStatus(), desktop: isDesktop(), localWhisper: local ? local.modelName : null,
  });
}

// ─── POST /api/agent/voice/correct ────────────────────────────────────────────────────

/**
 * Repair project jargon in a raw transcript, and say whether the result may be sent without
 * asking (see `lib/voice/correct.ts` for the whole safety model — the short version is that
 * ANY change waits for the owner's keypress).
 *
 * VAULT-SCOPED, and this is the route that makes `/stt`'s classification matter: the lexicon
 * is read out of the vault's own brain, so a request that did not name a vault has no
 * vocabulary to correct against.
 *
 * Shares the STT gate rather than having its own. It is the same money-spending burst from
 * the same gesture — one push-to-talk is one transcription plus one correction — and two
 * independent counters would let a caller spend twice the intended budget per take.
 */
export async function handleVoiceCorrect(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }

  const verdict = sttGate.acquire();
  if (verdict !== 'ok') {
    sendJson(res, 429, { error: 'stt_busy', message: 'Too many voice requests.' });
    return;
  }

  try {
    const body = await parseJsonBody(req);
    const raw = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!raw) {
      sendError(res, 400, 'bad_body', 'Expected { text }.');
      return;
    }

    const result = await correctTranscript(raw, { contextRoot });

    // EVERY proposed substitution is logged, accepted or not, so a bad correction the owner
    // waved through in a hurry is still detectable afterwards. The raw transcript is not
    // logged: it is the owner's speech, and the operations already say what changed.
    if (result.ops.length > 0) {
      console.info(`[voice:correct] ${result.ms}ms — ${describeOps(result.ops, buildVoiceLexicon(contextRoot))}`);
    }

    sendJson(res, 200, {
      action: result.action,
      text: result.text,
      raw: result.raw,
      ops: result.ops,
      reason: result.reason,
      ms: result.ms,
    });
  } catch (err) {
    // A correction that fails is NEVER a take that fails: the caller falls back to the raw
    // transcript, which is what the owner actually said.
    console.error('[voice:correct] unexpected failure', err);
    sendJson(res, 200, { action: 'auto', text: '', raw: '', ops: [], reason: 'error', ms: 0 });
  } finally {
    sttGate.release();
  }
}
