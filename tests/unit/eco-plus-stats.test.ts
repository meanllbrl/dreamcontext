import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ecoPlusRow, readEcoPlusHistory, type EcoPlusHour } from '../../src/lib/usage-report.js';

/** Plan eco-plus criterion 9: the Stats → dreamcontext Eco Plus row. */
const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 9, 1);
const ON = T0 + 20 * D;

/** One hour per day at noon; Opus at $10/Mtok, Sonnet at $2/Mtok. */
function hours(spec: Array<{ day: number; opus: number; sonnet: number; other?: number }>): Map<number, EcoPlusHour> {
  const m = new Map<number, EcoPlusHour>();
  for (const s of spec) {
    const other = s.other ?? 0;
    m.set(T0 + s.day * D + 12 * H, {
      heavyTokens: s.opus, heavyCost: s.opus * 10 / 1e6,
      sonnetTokens: s.sonnet, sonnetCost: s.sonnet * 2 / 1e6,
      tokens: s.opus + s.sonnet + other,
    });
  }
  return m;
}
const range = (from: number, to: number, f: (day: number) => { opus: number; sonnet: number }) =>
  Array.from({ length: to - from }, (_, i) => ({ day: from + i, ...f(from + i) }));

describe('ecoPlusRow', () => {
  it('is null when Eco Plus is off and never was on', () => {
    expect(ecoPlusRow([], false, hours([{ day: 1, opus: 100, sonnet: 0 }]), ON)).toBeNull();
  });

  it('on with no history file reads as short history, no estimate', () => {
    const r = ecoPlusRow([], true, hours([{ day: 1, opus: 100, sonnet: 0 }]), ON)!;
    expect(r.short).toBe(true);
    expect(r.estSavedCost).toBeNull();
    expect(r.estShifted).toBeNull();
    expect(r.since).toBeNull();
  });

  it('counts only the share shift: native Sonnet work in both periods saves nothing', () => {
    // Before: 80% Opus (80 Opus + 20 native Sonnet). During: the Opus work was lowered (now Sonnet)
    // and the same 20 native Sonnet stays: 10 Opus, 90 Sonnet = 10%.
    const h = hours([
      ...range(6, 20, () => ({ opus: 80_000, sonnet: 20_000 })),
      ...range(20, 30, () => ({ opus: 10_000, sonnet: 90_000 })),
    ]);
    const r = ecoPlusRow([{ at: ON, on: true }], true, h, T0 + 30 * D)!;
    expect(r.short).toBe(false);
    expect(r.before).toBeCloseTo(0.8);
    expect(r.during).toBeCloseTo(0.1);
    expect(r.days).toBeCloseTo(10);
    const during = 10 * 100_000;
    expect(r.estShifted).toBeCloseTo(0.7 * during);
    // Prices are blended from what was paid: Opus $10, Sonnet $2 per Mtok.
    expect(r.estSavedCost).toBeCloseTo(0.7 * during * (10 - 2) / 1e6);
  });

  it('a rise in the Opus share is a negative saving, never clipped', () => {
    const h = hours([
      ...range(6, 20, () => ({ opus: 20_000, sonnet: 80_000 })),
      ...range(20, 30, () => ({ opus: 40_000, sonnet: 60_000 })),
    ]);
    const r = ecoPlusRow([{ at: ON, on: true }], true, h, T0 + 30 * D)!;
    expect(r.estShifted!).toBeLessThan(0);
    expect(r.estSavedCost!).toBeLessThan(0);
  });

  it('under 7 days of Eco Plus shows the shares and no estimate', () => {
    const h = hours([...range(6, 20, () => ({ opus: 80_000, sonnet: 20_000 })), ...range(20, 23, () => ({ opus: 0, sonnet: 100_000 }))]);
    const r = ecoPlusRow([{ at: ON, on: true }], true, h, T0 + 23 * D)!;
    expect(r.short).toBe(true);
    expect(r.before).toBeCloseTo(0.8);
    expect(r.during).toBe(0);
    expect(r.estSavedCost).toBeNull();
  });

  it('no 14-day baseline is short even after 7 days', () => {
    // The ledger starts 3 days before Eco Plus.
    const h = hours([...range(17, 20, () => ({ opus: 80_000, sonnet: 20_000 })), ...range(20, 30, () => ({ opus: 0, sonnet: 100_000 }))]);
    const r = ecoPlusRow([{ at: ON, on: true }], true, h, T0 + 30 * D)!;
    expect(r.short).toBe(true);
    expect(r.estSavedCost).toBeNull();
  });

  it('only on-periods count as during; an off gap is neither period', () => {
    const h = hours([
      ...range(6, 20, () => ({ opus: 50_000, sonnet: 50_000 })),
      ...range(20, 25, () => ({ opus: 0, sonnet: 100_000 })),
      ...range(25, 28, () => ({ opus: 100_000, sonnet: 0 })),
      ...range(28, 34, () => ({ opus: 0, sonnet: 100_000 })),
    ]);
    const hist = [{ at: ON, on: true }, { at: T0 + 25 * D, on: false }, { at: T0 + 28 * D, on: true }];
    const r = ecoPlusRow(hist, true, h, T0 + 34 * D)!;
    expect(r.days).toBeCloseTo(11);
    expect(r.during).toBe(0);
    expect(r.before).toBeCloseTo(0.5);
  });

  it('off now after a period keeps the row and stops the period at the off line', () => {
    const r = ecoPlusRow([{ at: ON, on: true }, { at: ON + 2 * D, on: false }], false, hours([{ day: 21, opus: 0, sonnet: 10 }]), ON + 9 * D)!;
    expect(r.on).toBe(false);
    expect(r.days).toBeCloseTo(2);
  });
});

describe('readEcoPlusHistory', () => {
  let home = '';
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = ''; });

  it('reads {at,on} lines oldest first and skips torn ones', () => {
    home = mkdtempSync(join(tmpdir(), 'dc-ecoplus-hist-'));
    mkdirSync(join(home, '.dreamcontext'));
    writeFileSync(join(home, '.dreamcontext', 'eco-plus-history.jsonl'),
      `${JSON.stringify({ at: '2026-11-03T00:00:00.000Z', on: false })}\n{"at":\n${JSON.stringify({ at: '2026-11-01T00:00:00.000Z', on: true })}\n`);
    expect(readEcoPlusHistory(home)).toEqual([
      { at: Date.parse('2026-11-01T00:00:00.000Z'), on: true },
      { at: Date.parse('2026-11-03T00:00:00.000Z'), on: false },
    ]);
  });

  it('a missing file is an empty history', () => {
    home = mkdtempSync(join(tmpdir(), 'dc-ecoplus-hist-'));
    expect(readEcoPlusHistory(home)).toEqual([]);
  });
});
