import { useMemo } from 'react';
import { Axis, Crosshair, Grid, HitArea } from './Axis';
import { ChartFrame } from './ChartFrame';
import { formatTimeKey, formatValue, tickFormatter, timeTickFormatter, type ChartFormat } from './format';
import { cartesianLayout, type AxisTick } from './layout';
import type { LegendPosition } from './Legend';
import { useSeriesToggle } from './Legend';
import { colorScale } from './palette';
import { allTimeKeys, keyGrain, linearScale, parseTimeKey, pointPositions, tickCountFor, timeScale, timeTicks } from './scales';
import { useChartHover } from './useChartHover';
import { useChartSize } from './useChartSize';

/**
 * The foundation's reference composition: every piece of chart/ wired together
 * the way a Wave 2 chart should (sizing -> layout -> scales -> axis + grid ->
 * marks -> hover -> tooltip -> legend). It is deliberately plain (straight 2px
 * lines, no options beyond the essentials): the line lane owns the real
 * LineChart and its curve/points/area/reference options. Used by the unit test
 * render and by the foundation's browser proof.
 */

export interface RefSeries { name: string; points: { t: string; v: number }[] }

export interface ReferenceLineChartProps {
  series: readonly RefSeries[];
  unit?: string | null;
  format?: ChartFormat;
  locale?: string;
  legend?: LegendPosition;
  /** The block `color` option: 1-based slot of the first series. */
  colorStart?: number;
  /** Include zero in the y domain. */
  zero?: boolean;
  showX?: boolean;
  showY?: boolean;
  grid?: boolean;
  ariaLabel?: string;
}

export function ReferenceLineChart({
  series, unit = null, format = 'auto', locale, legend = 'bottom', colorStart = 1, zero = false,
  showX = true, showY = true, grid = true, ariaLabel,
}: ReferenceLineChartProps) {
  const size = useChartSize();
  const names = useMemo(() => series.map((s) => s.name), [series]);
  // Colours are assigned over EVERY series, before the legend hides any: a toggle never repaints.
  const colors = useMemo(() => colorScale(names, { start: colorStart }), [names, colorStart]);
  const toggle = useSeriesToggle(names);
  const hidden = toggle.hidden;
  const shown = useMemo(() => series.filter((s) => !hidden.has(s.name)), [series, hidden]);

  // Time keys sort chronologically; category keys keep their source order (a ranked list stays ranked).
  const keys = useMemo(() => {
    const seen = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.t))));
    return allTimeKeys(seen) ? seen.sort((a, b) => (parseTimeKey(a) as number) - (parseTimeKey(b) as number)) : seen;
  }, [series]);
  const isTime = allTimeKeys(keys);
  const times = useMemo(() => (isTime ? keys.map((k) => parseTimeKey(k) as number) : []), [isTime, keys]);

  const geo = useMemo(() => {
    if (!size.ready || keys.length === 0) return null;
    const values = shown.flatMap((s) => s.points.map((p) => p.v));
    const fmtOpts = { format, unit, locale };
    const yFor = (h: number) => linearScale(values.length ? values : [0], { range: [h, 0], tickCount: tickCountFor(h, size.fontPx * 3), zero });
    const inset = isTime ? 0 : Math.min(24, size.fontPx);
    const xPositions = (w: number): number[] => {
      if (!isTime) return pointPositions(keys.length, [0, w], inset);
      const ts = timeScale([times[0], times[times.length - 1]], [0, w]);
      return times.map((t) => ts(t));
    };
    const layout = cartesianLayout({
      width: size.width,
      height: size.height,
      fontPx: size.fontPx,
      measure: size.measure,
      showX,
      showY,
      xLabelMode: isTime ? 'thin' : 'rotate',
      yTicks: (h) => {
        const y = yFor(h);
        const f = tickFormatter(y.ticks, y.step, fmtOpts);
        return y.ticks.map((v) => ({ pos: y(v), label: f(v), value: v }));
      },
      xTicks: (w): AxisTick[] => {
        if (!isTime) {
          const ps = xPositions(w);
          return keys.map((k, i) => ({ pos: ps[i], label: k }));
        }
        const ts = timeScale([times[0], times[times.length - 1]], [0, w]);
        const maxCount = Math.max(2, Math.floor(w / (size.fontPx * 6)));
        const tt = timeTicks(times[0], times[times.length - 1], maxCount, keyGrain(keys));
        const f = timeTickFormatter(tt.unit, locale);
        return tt.ticks.map((t, i) => ({ pos: ts(t), label: f(t, i, tt.ticks), value: t }));
      },
    });
    const { plot } = layout;
    const y = yFor(plot.height);
    const xs = xPositions(plot.width);
    const indexOf = new Map(keys.map((k, i) => [k, i] as [string, number]));
    const lines = shown.map((s) => ({
      name: s.name,
      color: colors.color(s.name),
      d: s.points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${(plot.left + xs[indexOf.get(p.t) ?? 0]).toFixed(1)},${(plot.top + y(p.v)).toFixed(1)}`)
        .join(''),
    }));
    return { layout, plot, y, xs, lines, baseline: zero || y.domain[0] <= 0 ? Math.min(plot.height, Math.max(0, y(0))) : plot.height };
  }, [size.ready, size.width, size.height, size.fontPx, size.measure, keys, isTime, times, shown, colors, format, unit, locale, zero, showX, showY]);

  const hover = useChartHover({ positions: geo?.xs ?? [], plotWidth: geo?.plot.width ?? 0, plotHeight: geo?.plot.height ?? 0 });
  const hi = hover.index;
  const hoverKey = hi !== null ? keys[hi] : null;

  const tooltip = geo && hi !== null && hoverKey !== null ? {
    anchor: { x: geo.plot.left + geo.xs[hi], y: geo.plot.top + (hover.pointer?.y ?? geo.plot.height / 2) },
    title: isTime ? formatTimeKey(hoverKey, times[hi], locale) : hoverKey,
    rows: shown.map((s) => {
      const p = s.points.find((q) => q.t === hoverKey);
      return {
        id: s.name,
        label: shown.length > 1 ? s.name : '',
        value: p ? formatValue(p.v, { format, unit, locale }) : '-',
        color: colors.color(s.name),
        shape: 'line' as const,
        dim: !p,
      };
    }),
  } : null;

  return (
    <ChartFrame
      plotRef={size.ref}
      data-chart="reference-line"
      data-hover-index={hi ?? ''}
      legend={series.length > 1 ? { position: legend, items: series.map((s) => ({ id: s.name, label: s.name, color: colors.color(s.name), shape: 'line' as const })), hidden: toggle.hidden, onToggle: toggle.toggle } : null}
      tooltip={tooltip}
    >
      {geo && (
        <svg
          className="lab-chart-svg"
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="img"
          aria-label={ariaLabel}
          {...hover.focusProps}
        >
          {grid && <Grid plot={geo.plot} y={geo.layout.y.ticks} dpr={size.dpr} />}
          {showY && <Axis orientation="y" axis={geo.layout.y} plot={geo.plot} dpr={size.dpr} />}
          <Axis orientation="x" axis={geo.layout.x} plot={geo.plot} baseline={showX ? geo.baseline : null} dpr={size.dpr} />
          {geo.lines.map((l) => (
            <path key={l.name} d={l.d} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" data-series={l.name} />
          ))}
          {hi !== null && <Crosshair plot={geo.plot} x={geo.xs[hi]} dpr={size.dpr} />}
          {hi !== null && shown.map((s) => {
            const p = s.points.find((q) => q.t === hoverKey);
            return p ? (
              <circle
                key={s.name}
                cx={geo.plot.left + geo.xs[hi]}
                cy={geo.plot.top + geo.y(p.v)}
                r={4}
                fill={colors.color(s.name)}
                stroke="var(--viz-surface)"
                strokeWidth={2}
                pointerEvents="none"
              />
            ) : null;
          })}
          <HitArea plot={geo.plot} {...hover.hitProps} />
        </svg>
      )}
    </ChartFrame>
  );
}
