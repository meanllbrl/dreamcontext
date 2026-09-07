/**
 * The OpenRouter edge: the base URL, the model RESOLVER, and the rule that no upstream
 * response body ever leaves this module.
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

/** The three catalogues we resolve against, in preference order. First live match wins. */
export const MODEL_PREFERENCES = {
  /** Transcription. `gpt-4o-mini-transcribe` first: cheapest, and fast enough for a take. */
  transcription: [
    'openai/gpt-4o-mini-transcribe',
    'openai/gpt-4o-transcribe',
    'openai/whisper-large-v3',
    'google/chirp-3',
  ],
  /** Speech. The character lives in `instructions`, so switching voice later is a swap here. */
  speech: [
    'openai/gpt-4o-mini-tts',
    'google/gemini-3.1-flash-tts-preview',
    'mistralai/voxtral-mini-tts',
  ],
  /** The correction pass. Small and cheap — roughly $0.0001 a take. */
  correction: [
    'openai/gpt-4o-mini',
    'google/gemini-2.5-flash-lite',
    'anthropic/claude-haiku-4.5',
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
