/**
 * The chart foundation's scales, formatters and layout (dashboard/src/components/lab/chart/):
 * nice ticks whose count follows the pixels, band/point/time scales, number and date
 * formatting, and the cartesian layout's promise that no two tick labels overlap and
 * none leaves the cell.
 */
import { describe, expect, it } from 'vitest';
import {
  allTimeKeys, bandScale, keyGrain, linearScale, niceDomain, niceStep, niceTicks, parseTimeKey, pointPositions,
  tickCountFor, timeScale, timeTicks,
} from '../../dashboard/src/components/lab/chart/scales.js';
import {
  currencyCode, formatNumber, formatTimeKey, formatValue, stepDecimals, tickFormatter, timeTickFormatter, toChartFormat, unitSuffix,
} from '../../dashboard/src/components/lab/chart/format.js';
import {
  cartesianLayout, estimateTextWidth, thinStride, truncateToWidth, type AxisTick, type PlacedLabel,
} from '../../dashboard/src/components/lab/chart/layout.js';

describe('nice ticks', () => {
  it('uses 1/2/5 x 10^k steps', () => {
    expect(niceStep(0, 100, 5)).toBe(20);
    expect(niceStep(0, 1, 5)).toBe(0.2);
    expect(niceStep(0, 7, 4)).toBe(2);
    expect(niceStep(0, 1234, 4)).toBe(200);
    expect(niceStep(3, 3, 5)).toBe(0);
  });

  it('ticks land on whole steps inside the range, without float noise', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0.1, 0.35, 5)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
    expect(niceTicks(-12, 37, 5)).toEqual([-10, 0, 10, 20, 30]);
    expect(niceTicks(5, 5, 5)).toEqual([5]);
    expect(niceTicks(NaN, 5, 5)).toEqual([]);
  });

  it('niceDomain extends outward to labelled ends; a flat series gets room', () => {
    expect(niceDomain(3, 97, 5)).toEqual([0, 100]);
    expect(niceDomain(-12, 37, 5)).toEqual([-20, 40]);
    expect(niceDomain(0, 0, 5)).toEqual([0, 1]);
    const [lo, hi] = niceDomain(50, 50, 5);
    expect(lo).toBeLessThan(50);
    expect(hi).toBeGreaterThan(50);
  });

  it('tick count follows the pixels available', () => {
    expect(tickCountFor(300, 36)).toBe(9);
    expect(tickCountFor(60, 36)).toBe(2);
    expect(tickCountFor(0, 36)).toBe(2);
    const tall = linearScale([0, 1000], { range: [400, 0], tickCount: tickCountFor(400, 36) });
    const short = linearScale([0, 1000], { range: [80, 0], tickCount: tickCountFor(80, 36) });
    expect(tall.ticks.length).toBeGreaterThan(short.ticks.length);
    expect(short.ticks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('linear scale', () => {
  it('maps the nice domain onto the range and inverts', () => {
    const y = linearScale([3, 97], { range: [200, 0], tickCount: 5 });
    expect(y.domain).toEqual([0, 100]);
    expect(y(0)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y(50)).toBe(100);
    expect(y.invert(100)).toBe(50);
    expect(y.ticks[0]).toBe(0);
    expect(y.ticks[y.ticks.length - 1]).toBe(100);
    expect(y.step).toBe(20);
  });

  it('zero pulls 0 into the domain (yMin: zero); off keeps the data extent', () => {
    expect(linearScale([40, 60], { range: [100, 0], tickCount: 4, zero: true }).domain[0]).toBe(0);
    expect(linearScale([40, 60], { range: [100, 0], tickCount: 4 }).domain[0]).toBe(40);
  });

  it('ignores non-finite values and survives an empty list', () => {
    const y = linearScale([NaN, 10, Infinity], { range: [100, 0] });
    expect(Number.isFinite(y(5))).toBe(true);
    expect(linearScale([], { range: [100, 0] }).domain).toEqual([0, 1]);
  });
});

describe('band and point scales', () => {
  it('bands are evenly spaced, capped in thickness and centred in their slot', () => {
    const b = bandScale(4, [0, 400], { maxBandwidth: 24 });
    expect(b.count).toBe(4);
    expect(b.bandwidth).toBe(24);
    const centers = [0, 1, 2, 3].map((i) => b.center(i));
    const gaps = centers.slice(1).map((c, i) => c - centers[i]);
    for (const g of gaps) expect(g).toBeCloseTo(b.step);
    expect(b.start(0) + b.bandwidth / 2).toBeCloseTo(b.center(0));
    expect(b.center(0)).toBeGreaterThan(0);
    expect(b.center(3)).toBeLessThan(400);
  });

  it('indexAt maps every pixel to its slot and clamps at the ends', () => {
    const b = bandScale(5, [0, 500]);
    for (let i = 0; i < 5; i++) expect(b.indexAt(b.center(i))).toBe(i);
    expect(b.indexAt(-50)).toBe(0);
    expect(b.indexAt(9999)).toBe(4);
    expect(bandScale(0, [0, 100]).indexAt(10)).toBe(-1);
  });

  it('points span the range; one point sits in the middle', () => {
    expect(pointPositions(3, [0, 100])).toEqual([0, 50, 100]);
    expect(pointPositions(3, [0, 100], 10)).toEqual([10, 50, 90]);
    expect(pointPositions(1, [0, 100])).toEqual([50]);
    expect(pointPositions(0, [0, 100])).toEqual([]);
  });
});

describe('time', () => {
  it('parses every key shape the lab stores (UTC)', () => {
    expect(parseTimeKey('2026-09-03')).toBe(Date.UTC(2026, 8, 3));
    expect(parseTimeKey('2026-09')).toBe(Date.UTC(2026, 8, 1));
    expect(parseTimeKey('2026')).toBe(Date.UTC(2026, 0, 1));
    expect(parseTimeKey('2026-W01')).toBe(Date.UTC(2025, 11, 29)); // ISO week 1 of 2026 starts Mon Dec 29
    expect(parseTimeKey('2026-09-03T14:30:00Z')).toBe(Date.UTC(2026, 8, 3, 14, 30));
    expect(parseTimeKey('organic')).toBeNull();
    expect(allTimeKeys(['2026-09-01', '2026-09-02'])).toBe(true);
    expect(allTimeKeys(['2026-09-01', 'x'])).toBe(false);
    expect(keyGrain(['2026-09-01'])).toBe('day');
    expect(keyGrain(['2026-09'])).toBe('month');
    expect(keyGrain(['2026-W03'])).toBe('week');
  });

  it('picks the finest calendar interval that fits the tick budget', () => {
    const start = Date.UTC(2026, 8, 1);
    const month = timeTicks(start, Date.UTC(2026, 8, 30), 8, 'day');
    expect(month.ticks.length).toBeLessThanOrEqual(8);
    expect(['week', 'day']).toContain(month.unit);
    const year = timeTicks(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31), 6, 'day');
    expect(year.unit).toBe('month');
    expect(year.ticks.every((t) => new Date(t).getUTCDate() === 1)).toBe(true);
    expect(year.ticks.length).toBeLessThanOrEqual(6);
    // Daily data never gets hour ticks, however wide the axis.
    expect(timeTicks(start, Date.UTC(2026, 8, 3), 50, 'day').unit).toBe('day');
  });

  it('weekly ticks fall on Mondays', () => {
    const w = timeTicks(Date.UTC(2026, 8, 1), Date.UTC(2026, 10, 1), 10, 'day');
    if (w.unit === 'week') expect(w.ticks.every((t) => new Date(t).getUTCDay() === 1)).toBe(true);
  });

  it('timeScale maps linearly; a single instant sits mid-range', () => {
    const s = timeScale([0, 100], [0, 200]);
    expect(s(50)).toBe(100);
    expect(s.invert(100)).toBe(50);
    expect(timeScale([5, 5], [0, 200])(5)).toBe(100);
  });
});

describe('formatters', () => {
  it('auto: grouped digits below 10k, compact from there; unit follows', () => {
    expect(formatValue(1204, { unit: 'users', locale: 'en' })).toBe('1,204 users');
    expect(formatValue(12345, { locale: 'en' })).toBe('12.3K');
    expect(formatValue(3_400_000, { unit: 'visits', locale: 'en' })).toBe('3.4M visits');
    expect(formatValue(12, { unit: '%', locale: 'en' })).toBe('12%');
  });

  it('number / compact / percent / currency', () => {
    expect(formatNumber(1234.567, { format: 'number', locale: 'en' })).toBe('1,234.57');
    expect(formatNumber(1234, { format: 'compact', locale: 'en' })).toBe('1.2K');
    expect(formatValue(0.235, { format: 'percent', unit: 'users', locale: 'en' })).toBe('23.5%');
    expect(formatValue(1200.5, { format: 'currency', unit: 'EUR', locale: 'en' })).toBe('€1,200.50');
    expect(formatValue(3, { format: 'currency', unit: 'users', locale: 'en' })).toBe('$3.00');
    expect(currencyCode('try')).toBe('TRY');
    expect(unitSuffix('currency', 'EUR')).toBe('');
    expect(toChartFormat('nope')).toBe('auto');
    expect(formatValue(NaN)).toBe('');
  });

  it('respects the locale (TR groups with dots)', () => {
    expect(formatNumber(1234.5, { format: 'number', locale: 'tr' })).toBe('1.234,5');
  });

  it('tick precision comes from the step, shared across the axis', () => {
    expect(stepDecimals(0.25)).toBe(2);
    expect(stepDecimals(5)).toBe(0);
    expect(stepDecimals(0.1 + 0.2)).toBe(1);
    const ticks = [0, 0.5, 1, 1.5];
    const f = tickFormatter(ticks, 0.5, { format: 'number', locale: 'en' });
    expect(ticks.map(f)).toEqual(['0.0', '0.5', '1.0', '1.5']);
    const big = [0, 5000, 10000, 15000];
    const g = tickFormatter(big, 5000, { locale: 'en' });
    // auto resolves once from the largest tick: no "5,000" beside "10K".
    expect(big.map(g)).toEqual(['0', '5K', '10K', '15K']);
    const pct = tickFormatter([0, 0.25, 0.5], 0.25, { format: 'percent', locale: 'en' });
    expect([0, 0.25, 0.5].map(pct)).toEqual(['0%', '25%', '50%']);
    // float noise never prints as -0
    expect(tickFormatter([-1, 0, 1], 1, { locale: 'en' })(-1e-17)).toBe('0');
  });

  it('time tick labels are short and calendar-aware; tooltip titles are full', () => {
    const months = [Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1), Date.UTC(2027, 0, 1)];
    const f = timeTickFormatter('month', 'en');
    expect(months.map((t, i) => f(t, i, months))).toEqual(['Nov 2026', 'Dec', 'Jan 2027']);
    const days = [Date.UTC(2026, 8, 3)];
    expect(timeTickFormatter('day', 'en')(days[0], 0, days)).toBe('Sep 3');
    expect(formatTimeKey('2026-09-03', parseTimeKey('2026-09-03'), 'en')).toBe('Sep 3, 2026');
    expect(formatTimeKey('2026-09', parseTimeKey('2026-09'), 'en')).toBe('Sep 2026');
    expect(formatTimeKey('organic', null)).toBe('organic');
  });
});

describe('cartesian layout', () => {
  const fontPx = 12;
  const measure = (s: string) => estimateTextWidth(s, fontPx);

  function overlaps(labels: PlacedLabel[], plotLeft: number): boolean {
    const boxes = labels.map((l) => {
      const w = measure(l.label);
      const c = plotLeft + l.pos + l.dx;
      return [c - w / 2, c + w / 2];
    });
    return boxes.some((b, i) => i > 0 && b[0] < boxes[i - 1][1]);
  }

  function layoutFor(width: number, keys: string[], mode: 'thin' | 'rotate' = 'thin') {
    return cartesianLayout({
      width, height: 220, fontPx, measure, showX: true, showY: true, xLabelMode: mode,
      yTicks: (h) => {
        const y = linearScale([0, 12345], { range: [h, 0], tickCount: tickCountFor(h, fontPx * 3) });
        const f = tickFormatter(y.ticks, y.step, { locale: 'en' });
        return y.ticks.map((v) => ({ pos: y(v), label: f(v) }));
      },
      xTicks: (w): AxisTick[] => {
        const ps = pointPositions(keys.length, [0, w]);
        return keys.map((k, i) => ({ pos: ps[i], label: k }));
      },
    });
  }

  const keys = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);

  it('thins x labels so none overlap, at a narrow and a wide cell', () => {
    for (const width of [240, 480, 1200]) {
      const l = layoutFor(width, keys);
      expect(l.x.labels.length).toBeGreaterThan(1);
      expect(overlaps(l.x.labels, l.plot.left), `width ${width}`).toBe(false);
      expect(l.x.ticks.length).toBe(30); // the grid keeps every tick
    }
    expect(layoutFor(240, keys).x.labels.length).toBeLessThan(layoutFor(1200, keys).x.labels.length);
  });

  it('keeps edge labels inside the cell', () => {
    const l = layoutFor(300, keys);
    for (const lab of l.x.labels) {
      const w = measure(lab.label);
      const c = l.plot.left + lab.pos + lab.dx;
      expect(c - w / 2).toBeGreaterThanOrEqual(-0.01);
      expect(c + w / 2).toBeLessThanOrEqual(300.01);
    }
  });

  it('reserves the y label width and the x band inside the cell', () => {
    const l = layoutFor(400, keys);
    expect(l.plot.left).toBeGreaterThanOrEqual(measure('12K'));
    expect(l.plot.left + l.plot.width).toBeLessThanOrEqual(400);
    expect(l.plot.top + l.plot.height + l.x.band).toBeLessThanOrEqual(220);
    // y labels never collide either
    const ys = l.y.labels.map((t) => t.pos).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(fontPx * 1.3 - 0.01);
  });

  it('rotate mode rotates crowded category labels and truncates what the band cannot hold', () => {
    const cats = Array.from({ length: 14 }, (_, i) => `A long category name ${i}`);
    const l = layoutFor(360, cats, 'rotate');
    expect(l.x.rotate).toBe(true);
    expect(l.x.band).toBeLessThanOrEqual(220 * 0.4);
    expect(l.x.labels.some((x) => x.label.endsWith('…'))).toBe(true);
    // a roomy axis stays horizontal
    expect(layoutFor(1400, ['a', 'b', 'c'], 'rotate').x.rotate).toBe(false);
  });

  it('hides an axis entirely when toggled off', () => {
    const l = cartesianLayout({
      width: 300, height: 200, fontPx, measure, showX: false, showY: false,
      yTicks: () => [{ pos: 0, label: '100' }], xTicks: () => [{ pos: 0, label: 'a' }],
    });
    expect(l.x.labels).toEqual([]);
    expect(l.y.labels).toEqual([]);
    expect(l.plot.left).toBe(0);
  });

  it('thinStride and truncate', () => {
    const ticks = [0, 10, 20, 30, 40].map((pos) => ({ pos, label: 'x' }));
    expect(thinStride(ticks, [8, 8, 8, 8, 8], 2)).toBe(1);
    expect(thinStride(ticks, [30, 30, 30, 30, 30], 2)).toBe(4);
    const t = truncateToWidth('A very long label', 40, measure);
    expect(t.endsWith('…')).toBe(true);
    expect(measure(t)).toBeLessThanOrEqual(40);
    expect(truncateToWidth('ok', 40, measure)).toBe('ok');
  });
});
