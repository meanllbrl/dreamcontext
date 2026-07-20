import type { EvidenceEvent } from './types.js';

/**
 * Derived-confidence arithmetic (proactive-learning-layer, A2). Confidence is
 * NEVER asserted by an agent — it is computed from the evidence ledger so an
 * LLM nudging 0.6 → 0.65 on vibes (self-confirmation bias, the authoring agent
 * validating its own thesis) is structurally impossible.
 *
 * Evidence is scored chronologically (oldest → newest; `evidence[0]` is the
 * OLDEST entry) with a per-entry recency weight, so a recent contradiction can
 * outweigh several stale supports:
 *
 *   w_i = 0.55 + 0.45 * (i / (L - 1))     for i = 0..L-1, L = evidence.length
 *
 * With L <= 1 there is no spread to interpolate across (division by zero) —
 * by explicit convention the single/zero-entry weight is 1 (full weight).
 *
 * `no-signal` entries still occupy an index (they shift the recency fraction
 * of neighbouring entries) but contribute weight 0 to both sums.
 *
 *   ws = sum of weights over `supports` entries
 *   wc = sum of weights over `contradicts` entries
 *   confidence = (ws + 0.4) / (ws + wc + 0.8)
 *
 * The +0.4 / +0.8 Laplace-style smoothing keeps an empty ledger at exactly 0.5
 * (undecided) and prevents a single early entry from swinging to 0 or 1.
 * Range: (0, 1). 0.5 = undecided, >0.5 leans supports, <0.5 leans contradicts.
 */
export interface ConfidenceBreakdown {
  confidence: number;
  ws: number;
  wc: number;
  supports: number;
  contradicts: number;
  noSignal: number;
}

export function deriveConfidence(evidence: EvidenceEvent[]): ConfidenceBreakdown {
  const L = evidence.length;
  let ws = 0;
  let wc = 0;
  let supports = 0;
  let contradicts = 0;
  let noSignal = 0;

  evidence.forEach((event, i) => {
    // L <= 1 => weight 1 (no spread to interpolate a recency curve across).
    const weight = L <= 1 ? 1 : 0.55 + 0.45 * (i / (L - 1));
    if (event.verdict === 'supports') {
      ws += weight;
      supports += 1;
    } else if (event.verdict === 'contradicts') {
      wc += weight;
      contradicts += 1;
    } else {
      noSignal += 1;
    }
  });

  const confidence = (ws + 0.4) / (ws + wc + 0.8);
  return { confidence, ws, wc, supports, contradicts, noSignal };
}
