/**
 * The OpenRouter edge: the base URL, the model RESOLVER, and the rule that no upstream
 * response body ever leaves this module.
 *
 * ── WHAT OPENROUTER ACTUALLY SERVES, MEASURED AGAINST THE LIVE API (2026-09-07) ─────────
 * The plan this feature was built from said both OpenAI-compatible audio endpoints were
 * available. They ANSWER — `/audio/transcriptions` and `/audio/speech` both validate a
 * `model` field — but no model exists behind either: every id we asked for came back
 * "Model … does not exist", and the catalogue holds no transcription or TTS model at all.
 * The owner's first real push-to-talk is how we found out, exactly the failure mode AC3b was
 * written to prevent, one layer further down than it was looking.
 *
 * Audio on OpenRouter today is CHAT COMPLETIONS on an omni model:
 *   • IN  — a `input_audio` content part, base64, and the format enum is `wav` or `mp3`
 *           ONLY (m4a/mp4/webm are refused, which is why the browser now records WAV).
 *   • OUT — `stream: true` plus `modalities: ['text','audio']`; `mp3` is rejected while
 *           streaming, so it arrives as headerless `pcm16` at 24 kHz and gets its RIFF
 *           header back on this side (`wav.ts`).
 * Measured on the owner's key: a 3-second take transcribes in ~1.2s for $0.00007, and 4.75s
 * of speech generates in 1.7s — 0.36x realtime, so the queue stays ahead of playback.
 *
 * WHY MODEL IDS ARE RESOLVED AND NEVER HARDCODED (AC3b). Every audio model id this plan
 * quotes came from an announcement blog post, not from the models API, and several were
 * written with a version suffix wildcard (`openai/gpt-4o-mini-tts-*`). A hardcoded id that
 * gets renamed upstream fails as a 404 on the owner's FIRST push-to-talk — the worst possible
 * place to discover it, because it looks like "the microphone is broken". Resolving against
 * the live catalogue turns that into a configuration error that names what it looked for.
 *
 * WHY PREFIXES. The preference lists below are PREFIXES matched against live ids, so a
 * provider bumping `-2026-07` to `-2026-11` resolves without a code change, while a genuine
 * rename still surfaces loudly.
 *
 * WHY NOTHING FROM UPSTREAM IS FORWARDED (AC13). An error body is logged here, once, with
 * the key redacted, and the caller receives one of OUR codes. The reason is concrete: this
 * server writes transcripts that a team sync can push to somebody else's brain, so an echoed
 * request body is a key with a distribution channel.
 */

import { voiceApiKey } from './config.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Groq's OpenAI-compatible base. The transcription request is byte-identical to
 * OpenRouter's — same multipart, same field names — so supporting it is a base URL and a
 * key, not an integration.
 */
export const GROQ_BASE = 'https://api.groq.com/openai/v1';

/** Groq's id for the same model. Providers namespace differently; this one has no prefix. */
export const GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';

/** Sent on every call so usage is attributable in the owner's OpenRouter dashboard. */
export const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://dreamcontext.dev',
  'X-Title': 'dreamcontext',
} as const;

/**
 * Remove the API key from any text about to be logged.
 *
 * Belt and braces: an upstream error body has no business containing our key, and the one
 * time that assumption is wrong is the time it lands in a log file. Also strips anything
 * shaped like an OpenRouter key, so a key OTHER than the configured one (an old one in a
 * quoted request echo) is caught too.
 */
export function redactKey(text: string, key?: string | null): string {
  let out = text;
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/sk-or-[A-Za-z0-9._-]{8,}/g, '[redacted]');
}

/**
 * Log an upstream failure server-side, redacted and truncated, and return nothing. The
 * CALLER decides which of our generic codes the client sees; this function deliberately
 * cannot hand it an upstream string to pass on.
 */
export function logUpstream(scope: string, status: number, body: string, key?: string | null): void {
  const safe = redactKey(body, key).slice(0, 500);
  console.error(`[voice:${scope}] upstream ${status}: ${safe}`);
}

// ─── Model resolution ─────────────────────────────────────────────────────────

/**
 * ── THE AUDIO ENDPOINTS HAVE THEIR OWN NAMESPACE, AND `/models` DOES NOT LIST IT ─────────
 *
 * This cost a wrong conclusion, so it is written down rather than left to be rediscovered.
 * `GET /models` returns CHAT models. The ids that `/audio/transcriptions` and `/audio/speech`
 * accept are NOT in it — `openai/whisper-large-v3-turbo` transcribes perfectly well while
 * being absent from the catalogue, and `google/gemini-3.1-flash-tts-preview` speaks while
 * being absent from it too. Resolving an audio model against `/models` therefore reports
 * "no model matched" for models that exist, which is exactly the error the owner saw.
 *
 * So the audio ids below are NOT resolved. They are tried in order against the endpoint
 * itself, which is the only thing that actually knows.
 */
export const AUDIO_MODELS = {
  /**
   * Transcription, measured on the owner's key against the same Turkish take:
   *
   *   whisper-large-v3-turbo   704-1087ms   $0.000111   "Dremontext Taskını güncelle ve…"
   *   gpt-4o-transcribe        1111ms       $0.000172   "Durayan jontext taskını…"
   *   gpt-4o-mini-transcribe   1009ms       $0.000172   "Gramjon text taskını…"
   *
   * Whisper is both the cheapest and the most accurate here, and it is a REAL speech
   * recogniser rather than an omni chat model doing its best — it needs no language hint, no
   * anti-echo sentinel and no "please only transcribe" prompt.
   */
  transcription: [
    'openai/whisper-large-v3-turbo',
    'openai/gpt-4o-transcribe',
  ],
  /**
   * Speech, also measured head to head, with the output fed BACK through whisper to score
   * how faithfully each read the line:
   *
   *   gpt-audio-mini            1.4-1.8s for ~4.5s of audio (0.31-0.55x realtime)  fidelity 0.86-1.00
   *   gemini-3.1-flash-tts      3.4-4.3s for ~4.5s of audio (0.75-1.37x realtime)  fidelity 0.80-1.00
   *
   * The chat model is 2.4x faster at equal fidelity, so it stays first. Gemini is a REAL TTS
   * and cannot "answer the line instead of reading it", which is why it is second rather than
   * absent: it is what the verbatim guard falls back to instead of dropping a chunk.
   */
  speech: ['openai/gpt-audio-mini', 'openai/gpt-audio'],
  speechFallback: ['google/gemini-3.1-flash-tts-preview'],
} as const;

/**
 * The picked voice, translated for the FALLBACK model — which does not share the chat
 * model's voice list and would 400 on `onyx`.
 *
 * WHY THIS EXISTS AT ALL. The rescue path used to send a hardcoded `Charon` whatever the
 * owner had chosen, so a chunk the chat model refused to read came back in a different
 * voice from the sentence before it — the one place in the feature where the Voice setting
 * was silently ignored.
 *
 * MATCHED BY MEASUREMENT, not by the provider's adjectives. Median fundamental frequency of
 * the same Turkish line through each voice, 2026-09-11:
 *
 *   chat model   onyx 103   ash 114   echo 138   fable 155   alloy 157   shimmer 157   nova 192
 *   fallback     Charon 122   Schedar 152   Puck 163   Orus 176   Leda 186   Iapetus 189   Achernar 202
 *
 * Each voice below is its nearest neighbour in that table. Pitch is not timbre and this is
 * not a clone — it is the difference between "the rescued sentence is in a nearby register"
 * and "the rescued sentence is a different person". Every id was verified live against the
 * endpoint; an unknown key falls back to `Charon`, which is also what a failed request
 * retries with.
 */
export const FALLBACK_VOICES: Record<string, string> = {
  onyx: 'Charon',
  ash: 'Charon',
  echo: 'Schedar',
  fable: 'Schedar',
  alloy: 'Schedar',
  shimmer: 'Schedar',
  nova: 'Iapetus',
};

/** The fallback model's known-good voice, and the retry when a mapped one is refused. */
export const FALLBACK_VOICE_DEFAULT = 'Charon';

/** Translate a chat-model voice into one the fallback model accepts. */
export function fallbackVoice(voice: string | undefined): string {
  return FALLBACK_VOICES[(voice ?? '').toLowerCase()] ?? FALLBACK_VOICE_DEFAULT;
}

/** The catalogues we resolve against, in preference order. First live match wins. */
/** The three catalogues we resolve against, in preference order. First live match wins. */
export const MODEL_PREFERENCES = {
  /** Kept only so a caller asking for a chat-catalogue model still resolves; the AUDIO ids
   *  live in {@link AUDIO_MODELS} and are deliberately not resolved. */
  transcription: ['openai/gpt-audio-mini'],
  speech: ['openai/gpt-audio-mini'],
  /**
   * The correction pass, ordered by MEASUREMENT on the owner's key rather than by reputation.
   * `gemini-2.5-flash-lite` answered in 615ms against `gpt-4o-mini`'s 1891ms — and it was
   * also the more CONSERVATIVE of the two, fixing the one mangled product name and leaving
   * the rest of the sentence alone, where gpt-4o-mini rewrote "insight" into "şifreler"
   * (passwords). Both properties point the same way, which is unusual and worth writing down:
   * the fast model is the safe one here, because this pass must repair jargon, not rephrase.
   */
  correction: [
    'google/gemini-2.5-flash-lite',
    'anthropic/claude-haiku-4.5',
    'openai/gpt-4o-mini',
  ],
} as const;

export type ModelKind = keyof typeof MODEL_PREFERENCES;

/** Resolution either names a live model id, or says precisely what is missing. */
export type ModelResolution =
  | { ok: true; id: string }
  | { ok: false; reason: 'no_key' | 'unreachable' | 'no_match'; detail: string };

interface CacheEntry { at: number; value: ModelResolution }

const CACHE_TTL_MS = 10 * 60 * 1000;      // a successful resolution is stable for 10 minutes
const CACHE_TTL_FAIL_MS = 30 * 1000;      // a failure is re-tried soon — the key may just be new
const cache = new Map<ModelKind, CacheEntry>();

/** Drop the memo. Exported for tests and for the Settings card, which changes the key. */
export function clearModelCache(): void { cache.clear(); }

/** Injectable fetch, so the resolver is testable without the network. */
export type FetchLike = typeof globalThis.fetch;

/**
 * Resolve `kind` to a live OpenRouter model id.
 *
 * The result is memoised — a resolution per push-to-talk would add a network round trip to
 * every take, which is exactly the latency this feature cannot afford.
 */
export async function resolveModel(
  kind: ModelKind,
  opts: { key?: string | null; fetchImpl?: FetchLike; home?: string; now?: number } = {},
): Promise<ModelResolution> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(kind);
  if (hit) {
    const ttl = hit.value.ok ? CACHE_TTL_MS : CACHE_TTL_FAIL_MS;
    if (now - hit.at < ttl) return hit.value;
  }

  const key = opts.key !== undefined ? opts.key : voiceApiKey(opts.home);
  const remember = (value: ModelResolution): ModelResolution => {
    cache.set(kind, { at: now, value });
    return value;
  };

  if (!key) {
    return remember({ ok: false, reason: 'no_key', detail: 'No OpenRouter key is configured.' });
  }

  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  let ids: string[];
  try {
    const res = await doFetch(`${OPENROUTER_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}`, ...OPENROUTER_HEADERS },
    });
    if (!res.ok) {
      logUpstream('models', res.status, await res.text().catch(() => ''), key);
      return remember({
        ok: false,
        reason: 'unreachable',
        detail: 'The OpenRouter model catalogue could not be read.',
      });
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    ids = Array.isArray(body?.data)
      ? body.data.map((m) => m?.id).filter((id): id is string => typeof id === 'string')
      : [];
  } catch (err) {
    console.error(`[voice:models] ${kind} catalogue fetch failed`, err);
    return remember({
      ok: false,
      reason: 'unreachable',
      detail: 'The OpenRouter model catalogue could not be reached.',
    });
  }

  const prefs = MODEL_PREFERENCES[kind];
  for (const prefix of prefs) {
    // Exact id first, so a bare `openai/gpt-4o-mini` is not beaten by a longer variant that
    // merely starts with the same string.
    const exact = ids.find((id) => id === prefix);
    if (exact) return remember({ ok: true, id: exact });
    const suffixed = ids.find((id) => id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}:`));
    if (suffixed) return remember({ ok: true, id: suffixed });
  }

  // A rename. This is the case AC3b exists for: it must read as a configuration problem
  // naming what was looked for, never as a silent failure on the first press.
  return remember({
    ok: false,
    reason: 'no_match',
    detail: `No OpenRouter ${kind} model matched any known id (${prefs.join(', ')}). The model may have been renamed.`,
  });
}
