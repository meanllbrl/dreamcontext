/**
 * The window model behind the shared date-range control.
 *
 * It has to mirror the ENGINE (`resolveTweaks`), and every rule here exists
 * because breaking it produced a visible bug:
 *
 *   - explicit `from`/`to` OUT-RANK the `range` enum, so the control must report
 *     "custom" whenever both are set — and must remember the preset underneath,
 *     because that is the only value Clear can safely write back;
 *   - a curated `range` enum governs what may be written, so a fallback the enum
 *     does not list is a hard `LabError`, not a graceful default;
 *   - the URL codec must never leave both forms in the query at once, or the
 *     leftover `from`/`to` silently pins a link that asked for a preset.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RANGE_PRESETS,
  ENGINE_FALLBACK_RANGE,
  activeRange,
  fallbackPreset,
  formatISO,
  isRelativeRange,
  nonWindowTweaks,
  quickWindows,
  rangePresets,
  writeRangeParams,
} from '../../dashboard/src/components/lab/rangeModel.js';
import { DEFAULT_RANGE_OPTIONS } from '../../src/lib/lab/store.js';
import { parseRelativeRange, resolveTweaks } from '../../src/lib/lab/tweaks.js';
import type { PublicTweak } from '../../dashboard/src/hooks/useLab.js';

/** The public tweak shape the API serves (`toPublicTweaks`). */
function tw(over: Partial<PublicTweak> & { key: string }): PublicTweak {
  return { type: 'string', label: null, options: null, default: null, value: null, ...over } as PublicTweak;
}

const CURATED = ['last_7_days', 'last_28_days', 'last_90_days'];

/** The CalBuddy funnels manifest, which is where this was reported. */
function curatedFunnel(value: string, from = '', to = ''): PublicTweak[] {
  return [
    tw({ key: 'range', type: 'enum', options: CURATED, default: 'last_28_days', value }),
    tw({ key: 'from', type: 'date', value: from }),
    tw({ key: 'to', type: 'date', value: to }),
  ];
}

describe('rangePresets', () => {
  it("uses the author's curated enum when there is one", () => {
    expect(rangePresets(curatedFunnel('last_7_days'))).toEqual(CURATED);
  });

  it('falls back to the shared defaults when a manifest declares none', () => {
    expect(rangePresets([])).toEqual(DEFAULT_RANGE_PRESETS);
    expect(rangePresets([tw({ key: 'range', type: 'enum', options: ['', ' '] })])).toEqual(DEFAULT_RANGE_PRESETS);
  });

  it('mirrors the engine list exactly (one drift, two different boards)', () => {
    expect(DEFAULT_RANGE_PRESETS).toEqual([...DEFAULT_RANGE_OPTIONS]);
  });
});

describe('activeRange — the same precedence resolveTweaks applies', () => {
  it('reports the preset when no custom window is set', () => {
    expect(activeRange(curatedFunnel('last_7_days'))).toEqual({ kind: 'preset', value: 'last_7_days' });
  });

  it('reports custom when BOTH halves are set — from/to out-rank the enum', () => {
    const tweaks = curatedFunnel('last_7_days', '2026-01-01', '2026-01-05');
    expect(activeRange(tweaks)).toEqual({
      kind: 'custom', from: '2026-01-01', to: '2026-01-05', masked: 'last_7_days',
    });
  });

  it('half a window is not a window — one date alone stays on the preset', () => {
    expect(activeRange(curatedFunnel('last_28_days', '2026-01-01')).kind).toBe('preset');
    expect(activeRange(curatedFunnel('last_28_days', '', '2026-01-05')).kind).toBe('preset');
  });

  it('agrees with the engine about which window is in force', () => {
    const manifest = {
      slug: 'f', title: 'f', render: 'funnel', unit: null, path: '', body: '',
      refresh: { ttl_minutes: 60 }, credentials_used: [], binding: null,
      tweaks: [
        { key: 'range', type: 'enum' as const, options: CURATED, value: 'last_7_days' },
        { key: 'from', type: 'date' as const, value: '2026-01-01' },
        { key: 'to', type: 'date' as const, value: '2026-01-05' },
      ],
    } as any;
    const resolved = resolveTweaks(manifest, new Date('2026-03-10T12:00:00Z'));
    const active = activeRange(curatedFunnel('last_7_days', '2026-01-01', '2026-01-05'));
    expect(active.kind).toBe('custom');
    expect([resolved.range.fromISO, resolved.range.toISO]).toEqual(['2026-01-01', '2026-01-05']);
  });
});

describe('fallbackPreset — what Clear is allowed to write', () => {
  it('returns the preset the custom window is masking', () => {
    expect(fallbackPreset(curatedFunnel('last_7_days', '2026-01-01', '2026-01-05'))).toBe('last_7_days');
  });

  it('never proposes a value a curated enum would reject', () => {
    for (const value of ['', 'last_7_days', 'last_90_days']) {
      const chosen = fallbackPreset(curatedFunnel(value, '2026-01-01', '2026-01-05'));
      expect(CURATED, `fallbackPreset offered "${chosen}", which this enum rejects`).toContain(chosen);
    }
  });

  it('uses the declared default when the enum holds no value yet', () => {
    expect(fallbackPreset([tw({ key: 'range', type: 'enum', options: CURATED, default: 'last_28_days' })]))
      .toBe('last_28_days');
  });

  it('uses the first curated option when there is no value and no default', () => {
    expect(fallbackPreset([tw({ key: 'range', type: 'enum', options: CURATED })])).toBe('last_7_days');
  });

  it("reaches the engine's own default only when nothing is curated", () => {
    expect(fallbackPreset([])).toBe(ENGINE_FALLBACK_RANGE);
    expect(parseRelativeRange(ENGINE_FALLBACK_RANGE)).toBe(30);
  });
});

describe('writeRangeParams — a deep link carries one form, never both', () => {
  it('a preset drops a stale custom window from the query', () => {
    const p = new URLSearchParams('from=2026-01-01&to=2026-01-05&vault=hf');
    writeRangeParams(p, { range: 'last_7_days' });
    expect(p.get('range')).toBe('last_7_days');
    expect(p.get('from')).toBeNull();
    expect(p.get('to')).toBeNull();
    expect(p.get('vault'), 'foreign params must survive').toBe('hf');
  });

  it('a custom window drops the preset', () => {
    const p = new URLSearchParams('range=last_90_days');
    writeRangeParams(p, { from: '2026-01-01', to: '2026-01-05' });
    expect(p.get('range')).toBeNull();
    expect(p.get('from')).toBe('2026-01-01');
    expect(p.get('to')).toBe('2026-01-05');
  });
});

describe('quickWindows — one click instead of stepping the calendar', () => {
  const TODAY = new Date(2026, 7, 26); // 2026-08-26, local calendar

  it('resolves to explicit, in-order from→to windows', () => {
    for (const q of quickWindows(TODAY)) {
      expect(q.from, `${q.key} must be a calendar date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(q.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(q.from <= q.to, `${q.key} is inverted (${q.from} → ${q.to})`).toBe(true);
    }
  });

  it('counts trailing days the way the engine counts a relative range', () => {
    const d14 = quickWindows(TODAY).find((q) => q.key === 'd14')!;
    expect([d14.from, d14.to]).toEqual(['2026-08-12', '2026-08-26']);
    // `last_14_days` in the engine is the same arithmetic: to − 14 days.
    expect(parseRelativeRange('last_14_days')).toBe(14);
  });

  it('bounds the calendar windows to real month edges', () => {
    const byKey = Object.fromEntries(quickWindows(TODAY).map((q) => [q.key, q]));
    expect([byKey.thisMonth.from, byKey.thisMonth.to]).toEqual(['2026-08-01', '2026-08-26']);
    expect([byKey.lastMonth.from, byKey.lastMonth.to]).toEqual(['2026-07-01', '2026-07-31']);
    expect([byKey.ytd.from, byKey.ytd.to]).toEqual(['2026-01-01', '2026-08-26']);
  });

  it('crosses a year boundary without inventing a month 0', () => {
    const byKey = Object.fromEntries(quickWindows(new Date(2026, 0, 15)).map((q) => [q.key, q]));
    expect([byKey.lastMonth.from, byKey.lastMonth.to]).toEqual(['2025-12-01', '2025-12-31']);
    expect(byKey.ytd.from).toBe('2026-01-01');
  });

  it('lands on February 29 in a leap year, not March 1', () => {
    const byKey = Object.fromEntries(quickWindows(new Date(2028, 2, 5)).map((q) => [q.key, q]));
    expect([byKey.lastMonth.from, byKey.lastMonth.to]).toEqual(['2028-02-01', '2028-02-29']);
  });
});

describe('the window keys stay with the range control', () => {
  it('a generic tweak editor never renders a competing date picker', () => {
    const tweaks = [...curatedFunnel('last_7_days'), tw({ key: 'country', value: 'tr' })];
    expect(nonWindowTweaks(tweaks).map((t) => t.key)).toEqual(['country']);
  });
});

describe('isRelativeRange mirrors the engine grammar', () => {
  it('accepts exactly what parseRelativeRange accepts', () => {
    for (const v of ['last_7_days', 'last_1_year', 'last_2_weeks', 'last_6_months', 'last_1_day']) {
      expect(isRelativeRange(v), v).toBe(true);
      expect(parseRelativeRange(v), v).not.toBeNull();
    }
    for (const v of ['', 'custom', 'last_days', 'next_7_days', '2026-01-01', 'last_7_decades']) {
      expect(isRelativeRange(v), v).toBe(false);
      expect(parseRelativeRange(v), v).toBeNull();
    }
  });
});

describe('formatISO uses the LOCAL calendar', () => {
  it('never shifts the day for a reader east or west of UTC', () => {
    // 23:30 local on the 26th is the 26th, whatever toISOString() would say.
    expect(formatISO(new Date(2026, 7, 26, 23, 30))).toBe('2026-08-26');
    expect(formatISO(new Date(2026, 7, 26, 0, 30))).toBe('2026-08-26');
    expect(formatISO(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
});
