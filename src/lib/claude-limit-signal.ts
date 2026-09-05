/**
 * The API's OWN rejection, read off the stream — the authoritative limit signal.
 *
 * ── Why this module exists ────────────────────────────────────────────────────────────
 * Auto-switch used to steer by ONE number: `cachedUsageUtilization`'s session/weekly
 * percent. That number is a forecast, and on 2026-09-05 it was measured lying: three
 * minutes after the CLI refused a turn with "You've hit your session limit", a live
 * `/usage` probe of that same account answered `session: 6%`. A switcher whose only input
 * is the forecast therefore never fires on the account that is actually walled.
 *
 * The rejection itself is not a forecast. It is a fact, it names its window, and it carries
 * the real reset time. This module turns that frame into a value.
 *
 * ── The frame, from a REAL transcript (CLI 2.1.260) ───────────────────────────────────
 * Copied field-for-field from a rejected turn, which is why the readers below look for
 * these exact spellings rather than a plausible guess at them:
 *
 *   { "type": "assistant",
 *     "message": { "model": "<synthetic>", "stop_reason": "stop_sequence",
 *                  "content": [{ "type": "text",
 *                                "text": "You've hit your session limit · resets 9:30pm (Europe/Istanbul)" }] },
 *     "error": "rate_limit",
 *     "isApiErrorMessage": true,
 *     "apiErrorStatus": 429,
 *     "quotaLimits": { "status": "rejected",
 *                      "resetsAt": 1788546600,
 *                      "rateLimitType": "five_hour",
 *                      "overageStatus": "rejected",
 *                      "overageDisabledReason": "group_zero_credit_limit",
 *                      "unifiedRateLimitFallbackAvailable": false } }
 *
 * ── Why FOUR readers and not one ──────────────────────────────────────────────────────
 * `quotaLimits` / `error` / `apiErrorStatus` are siblings of `message` in the TRANSCRIPT.
 * Whether a given CLI build also puts them on the stream-json frame is not something this
 * side gets to assume — but the synthetic assistant TEXT provably arrives, because the user
 * read it on screen in the chat surface, which renders nothing but stream frames.
 *
 * So the structured readers run first (they give the window and the true reset), and the
 * text reader is the floor that cannot go missing. Detection degrades; it does not vanish.
 *
 * ── Why a false positive is the expensive direction ───────────────────────────────────
 * A missed signal costs one visible limit error — the status quo. A FALSE one restarts a
 * healthy conversation on another account and bills it there. So the text reader is gated
 * on `message.model === '<synthetic>'`: an ordinary assistant turn always names a real
 * model, so an agent QUOTING a limit banner (this file's own tests do exactly that) can
 * never be mistaken for one.
 */

export type LimitWindow = 'session' | 'weekly' | 'unknown';

/** One rejection, as the switcher needs it. */
export interface LimitSignal {
  /** Which cap the API rejected on. `unknown` when only the text reader fired. */
  window: LimitWindow;
  /** Epoch ms when that window reopens, or null when the frame does not say. */
  resetsAtMs: number | null;
  /** Which reader fired — carried for the log, and for the tests that pin each one. */
  via: 'quotaLimits' | 'apiError' | 'rateLimitEvent' | 'syntheticText';
  /** The CLI's own explanation, when it gives one (e.g. `group_zero_credit_limit`). */
  detail?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * `resets_at` arrives as epoch SECONDS on this frame (`1788546600`) while the usage cache
 * uses an ISO string and the rest of our wire uses epoch MILLIS. Discriminating on
 * magnitude rather than trusting either: anything below the year-2001 millisecond mark is
 * far too small to be millis and is read as seconds.
 *
 * A value that is neither (negative, NaN, absurd) yields null — an absent reset time, which
 * the surface already knows how to render, rather than a fabricated one.
 */
const MILLIS_FLOOR = 1_000_000_000_000;
function asEpochMs(v: unknown): number | null {
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  const ms = v < MILLIS_FLOOR ? v * 1000 : v;
  // A reset more than a year out is a shape change, not a reset. Better absent than wrong.
  return ms > Date.now() + 400 * 86_400_000 ? null : ms;
}

/**
 * `rateLimitType` → our window vocabulary.
 *
 * `five_hour` is the CLI's name for what every surface here calls the SESSION window; the
 * two names have to meet somewhere and this is the seam.
 */
function toWindow(kind: unknown): LimitWindow {
  const k = str(kind)?.toLowerCase();
  if (!k) return 'unknown';
  if (k.includes('five_hour') || k.includes('5_hour') || k.includes('session')) return 'session';
  if (k.includes('seven_day') || k.includes('7_day') || k.includes('week')) return 'weekly';
  return 'unknown';
}

/** The `quotaLimits` object, wherever this build hangs it. */
function findQuota(frame: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(frame.quotaLimits)
    ?? asRecord(asRecord(frame.message)?.quotaLimits)
    ?? null;
}

/**
 * Does this text read as a limit banner?
 *
 * Deliberately NOT a loose "limit" match: the word appears in ordinary prose constantly
 * (a rate limit on someone else's API, a context limit, a spending limit in a spec). The
 * anchors below are the CLI's own sentence shapes, and each one is paired — a verb of
 * hitting/reaching AND a named cap.
 */
const LIMIT_PHRASES = [
  /\bhit your (?:session|weekly|usage|5-hour|five-hour)\b/i,
  /\b(?:session|weekly|usage) limit reached\b/i,
  /\byou(?:'|’)?ve reached your (?:session|weekly|usage)\b/i,
  /\bout of (?:session|weekly) capacity\b/i,
];

function fromText(text: string): LimitSignal | null {
  if (!LIMIT_PHRASES.some((re) => re.test(text))) return null;
  const window: LimitWindow = /\bweekly\b/i.test(text)
    ? 'weekly'
    : /\b(?:session|5-hour|five-hour)\b/i.test(text) ? 'session' : 'unknown';
  return { window, resetsAtMs: null, via: 'syntheticText' };
}

/** Every text block of an assistant frame, concatenated. */
function assistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (asRecord(b)?.type === 'text' ? str(asRecord(b)?.text) ?? '' : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Read one stream frame. Returns null for the overwhelming majority of frames, which is the
 * only reason it is cheap enough to run on every line of the relay.
 *
 * Never throws: every step is `typeof` narrowing over an already-parsed object.
 */
export function readLimitSignal(frame: unknown): LimitSignal | null {
  const obj = asRecord(frame);
  if (!obj) return null;

  // ── 1. `quotaLimits` — the richest reader: it names the window AND the true reset.
  const quota = findQuota(obj);
  if (quota && str(quota.status)?.toLowerCase() === 'rejected') {
    const detail = str(quota.overageDisabledReason) ?? str(quota.rateLimitType);
    return {
      window: toWindow(quota.rateLimitType),
      resetsAtMs: asEpochMs(quota.resetsAt),
      via: 'quotaLimits',
      ...(detail ? { detail } : {}),
    };
  }

  // ── 2. The dedicated `rate_limit_event` frame — A METER, NOT A REFUSAL.
  //
  // CAPTURED LIVE from an ordinary, entirely healthy turn (`claude -p --output-format
  // stream-json`, 2026-09-05), which is the whole point of quoting it here:
  //
  //   { "type": "rate_limit_event",
  //     "rate_limit_info": { "status": "allowed", "resetsAt": 1788643200,
  //                          "rateLimitType": "five_hour",
  //                          "overageStatus": "rejected",
  //                          "overageDisabledReason": "org_level_disabled",
  //                          "isUsingOverage": false,
  //                          "unifiedWindows": {
  //                            "five_hour": { "utilization": 0.07, "resetsAt": 1788643200 },
  //                            "seven_day": { "utilization": 0.19, "resetsAt": 1788840000 } } } }
  //
  // THE CLI EMITS ONE OF THESE ON EVERY TURN. `status` is the only field that says whether
  // the API refused anything, and on a healthy turn it reads `allowed` while the account sits
  // at 7% of its five-hour window. This reader previously fired on the frame's TYPE alone and
  // guessed the rest off `obj` itself — so every healthy turn was written down as a refusal
  // (`window: 'unknown'` came from `toWindow('rate_limit_event')`, the absent reset made the
  // cooldown a 20-minute guess), the account was disqualified, auto-switch moved to the next
  // one, and its first turn's meter exiled it too. Two accounts, both "at their limit",
  // measured 7% and 19%. That is the failure this shape is written out to prevent.
  //
  // THREE TRAPS, all of them live in the frame above:
  //   • the payload key is `rate_limit_info` — not `rate_limit`, not `event`;
  //   • `overageStatus` ALSO reads `rejected` on a healthy frame (overage is a separate,
  //     org-disabled facility), so a reader keying on it refuses everything forever;
  //   • falling back to the FRAME as its own payload is what turned a missing field into a
  //     confident wrong answer. An unrecognised shape now yields null — a missed signal costs
  //     one visible limit error, which is the status quo, and this module's header explains at
  //     length why the other direction is the expensive one.
  if (str(obj.type) === 'rate_limit_event') {
    const payload = asRecord(obj.rate_limit_info) ?? asRecord(obj.rate_limit) ?? asRecord(obj.event);
    if (!payload) return null;
    // `rejected` is the same word, in the same field, that reader 1 keys on. `allowed`,
    // `warning`, or anything else is this frame doing its ordinary job.
    if (str(payload.status)?.toLowerCase() !== 'rejected') return null;
    const detail = str(payload.overageDisabledReason) ?? str(payload.reason) ?? str(payload.rateLimitType);
    return {
      window: toWindow(payload.rateLimitType),
      resetsAtMs: asEpochMs(payload.resetsAt ?? payload.resets_at),
      via: 'rateLimitEvent',
      ...(detail ? { detail } : {}),
    };
  }

  // ── 3. The API error flags, when `quotaLimits` is absent but the 429 is stated.
  //      `error: 'rate_limit'` is the discriminator — a 429 alone could in principle be
  //      some other throttle, and `isApiErrorMessage` alone covers every API failure there
  //      is. Requiring the pair keeps this reader from catching an ordinary outage.
  const isRateLimitError = str(obj.error)?.toLowerCase() === 'rate_limit';
  if (isRateLimitError && (obj.apiErrorStatus === 429 || obj.isApiErrorMessage === true)) {
    return { window: 'unknown', resetsAtMs: null, via: 'apiError' };
  }

  // ── 4. The floor: the synthetic assistant bubble the user actually reads.
  const message = asRecord(obj.message);
  if (!message) return null;
  // The false-positive gate — see the header. A real turn never has this model.
  if (str(message.model) !== '<synthetic>') return null;
  return fromText(assistantText(message));
}
