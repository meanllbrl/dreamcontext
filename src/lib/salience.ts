import type { DistilledSection } from '../cli/commands/transcript.js';

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
export const CORRECTION_RE = /\b(no|actually|wrong|instead|hayır|yanlış|değil)\b/i;
export const DECISION_RE = /\b(decided|chose|switched to|will use|karar|seçtik)\b/i;

const MAX_MOMENTS = 5;
const MAX_MESSAGE_CHARS = 200;

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

  // 1. User corrections (salience 2).
  for (const msg of distilled.userMessages) {
    if (CORRECTION_RE.test(msg)) {
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
  const decisionSources = [
    ...distilled.agentDecisions.filter((d) => !d.startsWith('[thinking]')),
    ...distilled.userMessages,
  ];
  for (const src of decisionSources) {
    if (DECISION_RE.test(src)) {
      push(`Decision: ${src}`, 2);
    }
  }

  return moments.slice(0, MAX_MOMENTS);
}
