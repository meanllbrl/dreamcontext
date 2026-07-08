import { describe, it, expect } from 'vitest';
// The dashboard's pure forecast engine (no React/DOM deps) — the live cascade under
// the interactive timeline. Kept in lock-step with src/lib/roadmap-model.ts.
import {
  buildForecasts,
  effortToDays,
  type ForecastInput,
} from '../../dashboard/src/components/roadmap/roadmap-forecast';

const obj = (slug: string, start: string | null, target: string | null, extra: Partial<ForecastInput> = {}): ForecastInput => ({
  slug, start_date: start, target_date: target, depends_on: [], ...extra,
});

describe('effortToDays', () => {
  it('weeks → calendar days; null/undefined/0/negative → 0', () => {
    expect(effortToDays(null)).toBe(0);
    expect(effortToDays(undefined)).toBe(0);
    expect(effortToDays(0)).toBe(0);
    expect(effortToDays(-3)).toBe(0);
    expect(effortToDays(1)).toBe(7);
    expect(effortToDays(4)).toBe(28);
  });
});

describe('buildForecasts — committed window, effort-aware, envelope-clamped', () => {
  it('a lone window (no effort, no deps) forecasts start→target, on track with full runway', () => {
    const f = buildForecasts([obj('a', '2026-07-10', '2026-07-25')]).get('a')!;
    expect(f.forecastable).toBe(true);
    expect(f.forecast_start).toBe('2026-07-10');
    expect(f.forecast_end).toBe('2026-07-25');
    expect(f.slipping).toBe(false);
    expect(f.slipDays).toBe(-15); // 15 days of runway (negative = buffer)
  });

  it('THE FIX: an on-time dependency consumes slack, not the deadline — no spurious slip', () => {
    // "app" finishes at its Jul 16 target; "live" is planned Jul 10→Jul 25, no effort.
    // The old engine slid live's full 15-day window to Jul 16→Jul 31 and lit it red.
    const m = buildForecasts([
      obj('app', '2026-07-01', '2026-07-16'),
      obj('live', '2026-07-10', '2026-07-25', { depends_on: ['app'] }),
    ]);
    expect(m.get('app')!.forecast_end).toBe('2026-07-16');
    expect(m.get('app')!.slipping).toBe(false);
    expect(m.get('live')!.forecast_start).toBe('2026-07-16'); // start pushed to dep finish
    expect(m.get('live')!.forecast_end).toBe('2026-07-25');   // clamps to target — NOT slid to Jul 31
    expect(m.get('live')!.slipping).toBe(false);
    expect(m.get('live')!.slipDays).toBe(-9); // 9 days of buffer
  });

  it('slips only when a dependency pushes the achievable start PAST the target', () => {
    const m = buildForecasts([
      obj('up', '2026-07-01', '2026-07-30'),
      obj('down', '2026-07-10', '2026-07-25', { depends_on: ['up'] }),
    ]);
    expect(m.get('down')!.forecast_start).toBe('2026-07-30');
    expect(m.get('down')!.forecast_end).toBe('2026-07-30');
    expect(m.get('down')!.slipping).toBe(true);
    expect(m.get('down')!.slipDays).toBe(5); // Jul 30 − Jul 25
  });

  it('effort drives the forecast: work that cannot fit before the target slips proportionally', () => {
    const f = buildForecasts([obj('biz', '2026-08-24', '2026-09-05', { effort: 4 })]).get('biz')!;
    expect(f.forecast_start).toBe('2026-08-24');
    expect(f.forecast_end).toBe('2026-09-21'); // Aug 24 + 28 days
    expect(f.slipping).toBe(true);
    expect(f.slipDays).toBe(16); // Sep 21 − Sep 5
  });

  it('effort that fits inside the window stays on track (bar clamps to committed end)', () => {
    const f = buildForecasts([obj('c', '2026-07-01', '2026-07-31', { effort: 2 })]).get('c')!;
    expect(f.forecast_end).toBe('2026-07-31'); // work (14d) done Jul 15, bar clamps to target
    expect(f.slipping).toBe(false);
    expect(f.slipDays).toBe(-16);
  });

  it('effort + an on-time dependency combine to a sized slip (matches the UX preview)', () => {
    const m = buildForecasts([
      obj('app', '2026-07-01', '2026-07-16'),
      obj('live', '2026-07-10', '2026-07-25', { effort: 2, depends_on: ['app'] }),
    ]);
    expect(m.get('live')!.forecast_start).toBe('2026-07-16');
    expect(m.get('live')!.forecast_end).toBe('2026-07-30'); // Jul 16 + 14 days
    expect(m.get('live')!.slipping).toBe(true);
    expect(m.get('live')!.slipDays).toBe(5);
  });

  it('a pure milestone (no own dates) inherits its forecast from its dependencies', () => {
    const m = buildForecasts([
      obj('backend', '2026-08-01', '2026-08-20'),
      obj('launch', null, null, { depends_on: ['backend'] }),
    ]);
    expect(m.get('launch')!.forecastable).toBe(true);
    expect(m.get('launch')!.forecast_start).toBe('2026-08-20');
    expect(m.get('launch')!.forecast_end).toBe('2026-08-20');
    expect(m.get('launch')!.slipping).toBe(false); // no committed target → nothing to slip against
  });

  it('a drag override re-runs the whole cascade (dragging a predecessor slips its dependent)', () => {
    const inputs = [
      obj('app', '2026-07-01', '2026-07-16'),
      obj('live', '2026-07-10', '2026-07-25', { depends_on: ['app'] }),
    ];
    // Drag "app"'s target out to Jul 28 → pushes live's start past its Jul 25 target.
    const overrides = new Map([['app', { start: '2026-07-01', target: '2026-07-28' }]]);
    const m = buildForecasts(inputs, overrides);
    expect(m.get('app')!.forecast_end).toBe('2026-07-28');
    expect(m.get('live')!.forecast_start).toBe('2026-07-28');
    expect(m.get('live')!.slipping).toBe(true);
    expect(m.get('live')!.slipDays).toBe(3); // Jul 28 − Jul 25
  });

  it('no dates and no forecastable dependency → unforecastable (non-blocking)', () => {
    const f = buildForecasts([obj('x', null, null)]).get('x')!;
    expect(f.forecastable).toBe(false);
    expect(f.forecast_end).toBeNull();
    expect(f.slipping).toBe(false);
  });

  it('a bare target with no start coalesces to a point at the deadline, on track', () => {
    const f = buildForecasts([obj('y', null, '2026-09-01')]).get('y')!;
    expect(f.forecastable).toBe(true);
    expect(f.forecast_start).toBe('2026-09-01');
    expect(f.forecast_end).toBe('2026-09-01');
    expect(f.slipping).toBe(false);
  });

  it('a malformed committed date degrades to unforecastable, never NaN', () => {
    const f = buildForecasts([obj('bad', 'not-a-date', 'also-bad')]).get('bad')!;
    expect(f.forecastable).toBe(false);
    expect(f.forecast_end).toBeNull();
  });
});
