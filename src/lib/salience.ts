import type { DistilledSection } from '../cli/commands/transcript.js';
import { isSystemNoiseMessage } from './transcript-records.js';

export interface SalientMoment {
  message: string;
  salience: 1 | 2 | 3;
}

// ── Structural detectors over a parsed DistilledSection ──────────────────────
// These are PURE pattern matchers — no AI. They look for the three highest-value
// signals a session leaves behind:
//   1. user corrections  → salience 2 (a preference/constraint just changed)
//   2. error → fix        → salience 1 (a bug was hit and code changed after)
//   3. explicit decisions → salience 2 (an architectural choice was made)
// EN + TR vocabulary, word-boundary anchored to avoid substring false positives.

// Exported (WS-DEBT) so the Stop/SessionStart substance scorer can reuse the
// SAME decision/correction vocabulary that auto-salience uses — one source of
// truth for "this line carries a decision/correction signal".
// Anchored to genuine correction phrasing rather than bare negation words, so a
// stray "no"/"not"/"değil" inside ordinary prose or (residual) tool output can't
// seed a false 'User correction' bookmark. Matches: a LEADING no/nope/hayır;
// the discourse marker "actually"; "instead of"; a standalone wrong/incorrect/
// yanlış; or the Turkish "öyle değil". A bare mid-sentence "no"/"değil" does NOT
// match. See task_OwbFN_IV.
export const CORRECTION_RE =
  /^(no|nope|hayır)\b|\bactually\b|\binstead of\b|\b(wrong|incorrect)\b|\byanlış\b|öyle değil/i;
export const DECISION_RE = /\b(decided|chose|switched to|will use|karar|seçtik)\b/i;

const MAX_MOMENTS = 5;
const MAX_MESSAGE_CHARS = 200;

/**
 * Longest user message whose FULL text is scanned for correction and decision
 * phrases. Past this, only the leading clause is scanned (see {@link leadingClause}).
 */
export const CORRECTION_SCAN_MAX_CHARS = 280;

/**
 * The part of a user message worth scanning for a correction or a decision.
 *
 * A real correction leads with its marker ("no, use…", "actually…", "that's wrong").
 * A 5k-char orchestrator brief ("You are builder w1-A on task …") carries "instead of"
 * or "actually" somewhere in its body, and an unanchored scan over the whole brief
 * filed every one of them as a ★★ 'User correction': 24 of 24 bookmarks in the
 * 2026-09-27..29 cycle. Short messages are scanned whole; longer ones only up to the
 * end of their first sentence (`.`, `!`, `?` or a newline), capped at
 * CORRECTION_SCAN_MAX_CHARS.
 */
export function leadingClause(message: string): string {
  const text = message.trim();
  if (text.length <= CORRECTION_SCAN_MAX_CHARS) return text;
  const end = text.search(/[.!?\n]/);
  const clause = end === -1 ? text : text.slice(0, end + 1);
  return clause.slice(0, CORRECTION_SCAN_MAX_CHARS);
}

function clamp(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= MAX_MESSAGE_CHARS
    ? oneLine
    : oneLine.slice(0, MAX_MESSAGE_CHARS - 1) + '…';
}

/**
 * Detect salient moments structurally from a distilled session.
 *
 * - User-correction: a user message containing a correction marker → salience 2.
 * - Error→fix: any error present AND at least one code change present → salience 1
 *   (the session hit an error and then changed code — a recurring-bug signal).
 * - Decision: an agent decision (excluding `[thinking]`) or user message with a
 *   decision keyword → salience 2.
 *
 * Deduped by message text and capped at 5. A clean session (no markers) yields
 * an empty array — the detectors are deliberately conservative to avoid noise.
 */
export function detectSalience(distilled: DistilledSection): SalientMoment[] {
  const moments: SalientMoment[] = [];
  const seen = new Set<string>();

  const push = (message: string, salience: 1 | 2 | 3): void => {
    const clamped = clamp(message);
    if (!clamped) return;
    const key = `${salience}::${clamped.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    moments.push({ message: clamped, salience });
  };

  // 1. User corrections (salience 2). Defense-in-depth: skip system-injected
  //    coordination noise (sub-agent notifications, agent-resume JSON, skill
  //    headers) even if it reached userMessages — it is never a real correction.
  //    Only the leading clause is tested: a correction leads with its marker,
  //    and a long brief carries the same words deep in its body.
  for (const msg of distilled.userMessages) {
    if (isSystemNoiseMessage(msg)) continue;
    if (CORRECTION_RE.test(leadingClause(msg))) {
      push(`User correction: ${msg}`, 2);
    }
  }

  // 2. Error → fix (salience 1). One bookmark for the pairing, anchored on the
  //    first error, only when a code change also occurred in the session.
  if (distilled.errors.length > 0 && distilled.codeChanges.length > 0) {
    const firstError = distilled.errors[0];
    push(`Error resolved by code change: ${firstError}`, 1);
  }

  // 3. Explicit decisions (salience 2) — from agent decisions and user messages.
  //    Excluded: `[thinking]` blocks, and `[subagent…` entries (a sub-agent's
  //    brief-echo or report handed back to its orchestrator is agent-to-agent
  //    paperwork, not a decision made with the user). User messages are tested on
  //    their leading clause, like corrections.
  const decisionSources = [
    ...distilled.agentDecisions
      .filter((d) => !d.startsWith('[thinking]') && !d.startsWith('[subagent'))
      .map((d) => ({ text: d, scanned: d })),
    ...distilled.userMessages.map((m) => ({ text: m, scanned: leadingClause(m) })),
  ];
  for (const src of decisionSources) {
    if (isSystemNoiseMessage(src.text)) continue;
    if (DECISION_RE.test(src.scanned)) {
      push(`Decision: ${src.text}`, 2);
    }
  }

  return moments.slice(0, MAX_MOMENTS);
}

/** Cap on auto-bookmarks harvested from a bare `last_assistant_message` (AC2). */
export const MESSAGE_ONLY_MOMENT_CAP = 2;

/**
 * Salience detection over a BARE `last_assistant_message` — used when the Stop
 * hook fires with no transcript on disk yet (Claude Code's lazy flush). Wraps
 * the message as a single `agentDecisions` entry so the SAME DECISION_RE
 * vocabulary `detectSalience` already uses applies here too — no new detector,
 * per AC2. CORRECTION_RE deliberately does not apply: this is the AGENT's own
 * closing message, not something the user typed, so "user correction" framing
 * would misattribute it. Empty/whitespace-only input yields `[]`.
 */
export function detectSalienceFromMessage(message: string | null): SalientMoment[] {
  if (!message || !message.trim()) return [];
  const distilled: DistilledSection = {
    userMessages: [],
    agentDecisions: [message],
    codeChanges: [],
    errors: [],
    bookmarks: [],
  };
  return detectSalience(distilled).slice(0, MESSAGE_ONLY_MOMENT_CAP);
}
