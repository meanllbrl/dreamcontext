import { describe, it, expect } from 'vitest';
import { deriveConfidence } from '../../src/lib/theses/confidence.js';
import type { EvidenceEvent } from '../../src/lib/theses/types.js';

function ev(
  verdict: EvidenceEvent['verdict'],
  overrides: Partial<EvidenceEvent> = {},
): EvidenceEvent {
  return {
    date: '2026-07-19',
    cycle: 1,
    source: 'insight',
    ref: null,
    note: '',
    quantitative: false,
    verdict,
    ...overrides,
  };
}

describe('deriveConfidence — empty/degenerate ledgers', () => {
  it('an empty ledger derives exactly 0.5 (undecided)', () => {
    const b = deriveConfidence([]);
    expect(b.confidence).toBe(0.5);
    expect(b).toEqual({ confidence: 0.5, ws: 0, wc: 0, supports: 0, contradicts: 0, noSignal: 0 });
  });

  it('a single-entry ledger uses weight 1 (L <= 1 convention), not a NaN from division by zero', () => {
    const supports = deriveConfidence([ev('supports')]);
    expect(supports.ws).toBe(1);
    expect(supports.confidence).toBeCloseTo(1.4 / 1.8, 10);

    const contradicts = deriveConfidence([ev('contradicts')]);
    expect(contradicts.wc).toBe(1);
    expect(contradicts.confidence).toBeCloseTo(0.4 / 1.8, 10);
  });

  it('a single no-signal entry contributes 0 to both sums and stays at 0.5', () => {
    const b = deriveConfidence([ev('no-signal')]);
    expect(b).toEqual({ confidence: 0.5, ws: 0, wc: 0, supports: 0, contradicts: 0, noSignal: 1 });
  });
});

describe('deriveConfidence — the pinned formula', () => {
  it('computes (ws + 0.4) / (ws + wc + 0.8) from the recency-weighted sums', () => {
    // L=4: weights at i/(L-1) = 0, 1/3, 2/3, 1 => 0.55, 0.7, 0.85, 1.0
    const b = deriveConfidence([ev('supports'), ev('supports'), ev('supports'), ev('contradicts')]);
    const ws = 0.55 + 0.7 + 0.85;
    const wc = 1.0;
    expect(b.ws).toBeCloseTo(ws, 10);
    expect(b.wc).toBeCloseTo(wc, 10);
    expect(b.confidence).toBeCloseTo((ws + 0.4) / (ws + wc + 0.8), 10);
    expect(b.supports).toBe(3);
    expect(b.contradicts).toBe(1);
  });

  it('confidence always lands strictly between 0 and 1', () => {
    const allContradict = deriveConfidence([ev('contradicts'), ev('contradicts'), ev('contradicts')]);
    expect(allContradict.confidence).toBeGreaterThan(0);
    expect(allContradict.confidence).toBeLessThan(1);

    const allSupport = deriveConfidence([ev('supports'), ev('supports'), ev('supports')]);
    expect(allSupport.confidence).toBeGreaterThan(0);
    expect(allSupport.confidence).toBeLessThan(1);
  });
});

describe('deriveConfidence — recency weighting', () => {
  it('a recent contradiction can outweigh an older support (same counts, different order)', () => {
    // L=2: weights are 0.55 (oldest) and 1.0 (newest).
    const oldSupportNewContradict = deriveConfidence([ev('supports'), ev('contradicts')]);
    expect(oldSupportNewContradict.ws).toBeCloseTo(0.55, 10);
    expect(oldSupportNewContradict.wc).toBeCloseTo(1.0, 10);
    expect(oldSupportNewContradict.confidence).toBeCloseTo((0.55 + 0.4) / (0.55 + 1.0 + 0.8), 10);
    expect(oldSupportNewContradict.confidence).toBeLessThan(0.5);

    const oldContradictNewSupport = deriveConfidence([ev('contradicts'), ev('supports')]);
    expect(oldContradictNewSupport.wc).toBeCloseTo(0.55, 10);
    expect(oldContradictNewSupport.ws).toBeCloseTo(1.0, 10);
    expect(oldContradictNewSupport.confidence).toBeCloseTo((1.0 + 0.4) / (1.0 + 0.55 + 0.8), 10);
    expect(oldContradictNewSupport.confidence).toBeGreaterThan(0.5);
  });

  it('no-signal entries shift the recency fraction of surrounding entries even though they score 0', () => {
    // With a no-signal wedged between two supports and a trailing contradict,
    // L=4 spreads the first support's weight further from the last entry than
    // it would be without the no-signal entry (L=3).
    const withNoSignal = deriveConfidence([
      ev('supports'),
      ev('supports'),
      ev('no-signal'),
      ev('contradicts'),
    ]);
    const withoutNoSignal = deriveConfidence([ev('supports'), ev('supports'), ev('contradicts')]);

    // L=4: weights 0.55, 0.7, 0.85(no-signal, 0-weight), 1.0
    const wsWith = 0.55 + 0.7;
    const wcWith = 1.0;
    expect(withNoSignal.ws).toBeCloseTo(wsWith, 10);
    expect(withNoSignal.wc).toBeCloseTo(wcWith, 10);
    expect(withNoSignal.noSignal).toBe(1);

    // L=3: weights 0.55, 0.775, 1.0
    const wsWithout = 0.55 + 0.775;
    const wcWithout = 1.0;
    expect(withoutNoSignal.ws).toBeCloseTo(wsWithout, 10);
    expect(withoutNoSignal.wc).toBeCloseTo(wcWithout, 10);

    // The no-signal entry measurably changes ws (0.7 vs 0.775 for the second
    // support) and therefore the derived confidence, despite contributing 0
    // itself.
    expect(withNoSignal.ws).not.toBeCloseTo(withoutNoSignal.ws, 5);
    expect(withNoSignal.confidence).not.toBeCloseTo(withoutNoSignal.confidence, 5);
  });
});

describe('deriveConfidence — verdict counts', () => {
  it('counts supports/contradicts/noSignal independently of their weights', () => {
    const b = deriveConfidence([
      ev('supports'),
      ev('contradicts'),
      ev('no-signal'),
      ev('no-signal'),
      ev('supports'),
    ]);
    expect(b.supports).toBe(2);
    expect(b.contradicts).toBe(1);
    expect(b.noSignal).toBe(2);
  });
});
