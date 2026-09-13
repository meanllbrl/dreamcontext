import { describe, expect, it } from 'vitest';
import { CONTEXT_BAND_EDGES, contextBands } from '../../dashboard/src/lib/agentComposer';
import { CONTEXT_BAND_EDGES as OWNED_EDGES, CONTEXT_HANDOFF_DEFAULTS } from '../../src/lib/setup-config.js';

describe('contextBands', () => {
  it('splits a 1M window at 300k and 650k', () => {
    const b = contextBands(0, 1_000_000);
    expect(b.map((x) => [x.key, x.from, x.to])).toEqual([
      ['calm', 0, 300_000],
      ['caution', 300_000, 650_000],
      ['danger', 650_000, 1_000_000],
    ]);
  });

  it('fills band by band, and a filled band stays full', () => {
    const b = contextBands(500_000, 1_000_000);
    expect(b[0].frac).toBe(1);                      // 0-300k is spent
    expect(b[1].frac).toBeCloseTo(200_000 / 350_000); // 200k into a 350k band
    expect(b[2].frac).toBe(0);                      // untouched
  });

  it('never reports a band as more than full or less than empty', () => {
    for (const b of contextBands(2_000_000, 1_000_000)) expect(b.frac).toBe(1);
    for (const b of contextBands(-5, 1_000_000)) expect(b.frac).toBe(0);
  });

  // A 200k-window model must not draw two dead rings: the edges are clamped to the real
  // limit, so a window that ends before the first edge collapses to ONE band.
  it('collapses to a single band on a 200k window', () => {
    const b = contextBands(100_000, 200_000);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ key: 'calm', from: 0, to: 200_000, frac: 0.5 });
  });

  it('drops only the edges that fall outside a mid-sized window', () => {
    const b = contextBands(0, 500_000);
    expect(b.map((x) => x.to)).toEqual([300_000, 500_000]);
  });

  // ── the mirror guard ───────────────────────────────────────────────────────
  // The dashboard is a separate bundle and cannot import from `src/`, so it copies the
  // edges. They are no longer only a paint job: the SAME two numbers are where the
  // handoff nudge turns firm and where it turns severe. If these drift, the gauge says
  // "calm" at a reading the agent is already being pushed at — which is exactly what
  // happened when the bands moved off 200k while the nudge stayed there.
  // See knowledge/patterns/mirror-with-drift-test.md.
  it('mirrors CONTEXT_BAND_EDGES from src/lib/setup-config.ts exactly, in order', () => {
    expect(CONTEXT_BAND_EDGES).toEqual([...OWNED_EDGES]);
  });

  it('is the same pair the nudge escalates on', () => {
    expect(CONTEXT_BAND_EDGES).toEqual([CONTEXT_HANDOFF_DEFAULTS.nudgeAt, CONTEXT_HANDOFF_DEFAULTS.hardAt]);
  });

  it('edges are the documented thresholds', () => {
    expect(CONTEXT_BAND_EDGES).toEqual([300_000, 650_000]);
  });
});
