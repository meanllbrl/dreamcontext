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

describe('buildForecasts — dated tasks are the schedule of record (lock-step with roadmap-model.ts)', () => {
  const task = (start: string | null, due: string | null) => ({ start_date: start, due_date: due });

  it('THE FIX: a rollup sharing its dependency’s member tasks does NOT stack effort (phantom slip gone)', () => {
    // `child` owns a dated task (Jul 1 → Aug 1). `rollup` depends_on `child`, SHARES that
    // same task, and carries a 4-week effort estimate over a Jul 1 → Aug 15 window.
    // The old committed-window+effort engine stacked rollup's 28 days AFTER child's Aug 1
    // finish → Aug 29, a phantom slip past Aug 15 that disagreed with the CLI forecast.
    // With the task-date basis the shared task is the schedule of record: no effort added,
    // work finishes Aug 1 on track and the bar clamps to the committed Aug 15 end —
    // exactly what roadmap-model.ts computes.
    const shared = [task('2026-07-01', '2026-08-01')];
    const m = buildForecasts([
      obj('child', '2026-07-01', '2026-08-01', { tasks: shared }),
      obj('rollup', '2026-07-01', '2026-08-15', { effort: 4, depends_on: ['child'], tasks: shared }),
    ]);
    expect(m.get('child')!.forecast_end).toBe('2026-08-01');
    const r = m.get('rollup')!;
    expect(r.basis).toBe('tasks');
    expect(r.forecast_start).toBe('2026-08-01'); // pushed to the dependency finish
    expect(r.forecast_end).toBe('2026-08-15');   // envelope: bar never ends before the committed end
    expect(r.slipping).toBe(false);              // work ends Aug 1 ≤ Aug 15 target → on track
    expect(r.slipDays).toBe(-14);                // 14 days of buffer, not a 14-day slip
  });

  it('a task-bearing objective forecasts from its task span; effort is not re-added on top', () => {
    // Effort 4 (28d) is set, but dated tasks win — work ends at the task span (Jul 20),
    // NOT start + effort (which would be Jul 29); the bar clamps to the committed Jul 31
    // end (envelope). Mirrors the server’s hasDates branch.
    const f = buildForecasts([
      obj('a', '2026-07-01', '2026-07-31', { effort: 4, tasks: [task('2026-07-01', '2026-07-20')] }),
    ]).get('a')!;
    expect(f.basis).toBe('tasks');
    expect(f.forecast_start).toBe('2026-07-01');
    expect(f.forecast_end).toBe('2026-07-31'); // committed end, not Jul 29 (start + effort)
    expect(f.slipping).toBe(false);
    expect(f.slipDays).toBe(-11); // work ends Jul 20 → 11 days of buffer before the target
  });

  it('REGRESSION (Tilki board): start-only dated tasks must not collapse the committed window', () => {
    // Real-world shape: member tasks carry only start dates (no dues). The old tasks
    // basis made forecast_start = forecast_end = the task start, so the bar collapsed
    // to an 8px stub and the PO's 1-month committed window vanished from the timeline.
    // The window is an ENVELOPE — the bar renders the full committed span.
    const f = buildForecasts([
      obj('a', '2026-06-03', '2026-07-07', { effort: 12, tasks: [task('2026-06-27', null)] }),
    ]).get('a')!;
    expect(f.basis).toBe('tasks');
    expect(f.forecast_start).toBe('2026-06-03'); // committed start (earlier than the task start)
    expect(f.forecast_end).toBe('2026-07-07');   // committed target — full window, no point-collapse
    expect(f.slipping).toBe(false);
  });

  it('a dependent consumes the envelope end (deadline), not an early task finish', () => {
    // `act` has a start-only task at Jul 11 but its committed window runs to Jul 27 —
    // a predecessor isn't "done" until its own target passes, so `mkt` starts Jul 27
    // (its own committed start, agreeing with the pushed dep finish), not Jul 11.
    const m = buildForecasts([
      obj('act', '2026-07-10', '2026-07-27', { effort: 2, tasks: [task('2026-07-11', null)] }),
      obj('mkt', '2026-07-27', '2026-08-26', { effort: 4, depends_on: ['act'], tasks: [task('2026-06-27', null)] }),
    ]);
    expect(m.get('act')!.forecast_end).toBe('2026-07-27');
    const mkt = m.get('mkt')!;
    expect(mkt.forecast_start).toBe('2026-07-27');
    expect(mkt.forecast_end).toBe('2026-08-26');
    expect(mkt.slipping).toBe(false);
  });

  it('a task-bearing objective slips when its OWN tasks overrun the committed target', () => {
    const f = buildForecasts([
      obj('a', '2026-07-01', '2026-08-01', { tasks: [task('2026-07-01', '2026-08-11')] }),
    ]).get('a')!;
    expect(f.basis).toBe('tasks');
    expect(f.forecast_end).toBe('2026-08-11');
    expect(f.slipping).toBe(true);
    expect(f.slipDays).toBe(10); // Aug 11 − Aug 1
  });

  it('an objective with only dated tasks (no committed window, no deps) is forecastable from them', () => {
    // Previously this rendered as an "unforecastable — no dates" ghost row on the timeline
    // even though the CLI forecast it from its tasks; now the two agree.
    const f = buildForecasts([
      obj('a', null, null, { tasks: [task('2026-07-01', '2026-07-20')] }),
    ]).get('a')!;
    expect(f.forecastable).toBe(true);
    expect(f.basis).toBe('tasks');
    expect(f.forecast_start).toBe('2026-07-01');
    expect(f.forecast_end).toBe('2026-07-20');
  });

  it('an upstream slip still cascades into a task-bearing dependent (finish-to-start clamp holds)', () => {
    // `up` finishes late (Dec 1, own task); `down` shares a fine task (due Aug 1) but must
    // start after `up`, so its span is clamped forward and it slips past its Sep 1 target.
    const m = buildForecasts([
      obj('up', null, null, { tasks: [task('2026-07-01', '2026-12-01')] }),
      obj('down', '2026-07-01', '2026-09-01', { depends_on: ['up'], tasks: [task('2026-07-01', '2026-08-01')] }),
    ]);
    const d = m.get('down')!;
    expect(d.basis).toBe('tasks');
    expect(d.forecast_start).toBe('2026-12-01'); // clamped to the dep finish
    expect(d.forecast_end).toBe('2026-12-01');
    expect(d.slipping).toBe(true);
  });

  it('an undated member task does not trigger the task basis (falls back to the committed window)', () => {
    // A task with neither start nor due is not a schedule of record — the objective keeps
    // its committed-window + effort forecast, exactly as before this change.
    const f = buildForecasts([
      obj('a', '2026-07-01', '2026-07-25', { tasks: [task(null, null)] }),
    ]).get('a')!;
    expect(f.basis).toBe('window');
    expect(f.forecast_start).toBe('2026-07-01');
    expect(f.forecast_end).toBe('2026-07-25');
  });
});
