import type { SeriesPoint } from '../../hooks/useLab';
import { curvePath, xDomainOf, xPositionsOf, type LineCurve } from './LineChart';
import { linearScale } from './chart';

/**
 * A trend GLYPH, not a chart: no axes, no labels, no hover, just the shape of
 * the last N points, sized to sit inline next to a number or in a table cell.
 * It shares LineChart's x placement (dates spaced by time, other keys evenly)
 * and the foundation's linear scale, so a sparkline and the line it summarises
 * bend the same way. Anything that needs to be read precisely is LineChart's job.
 */
export function Sparkline({ points, width = 68, height = 18, color = 'var(--viz-cat-1)', dot = true, curve = 'linear' }: {
  points: SeriesPoint[];
  width?: number;
  height?: number;
  color?: string;
  /** Mark the latest point (the value the number beside it reports). */
  dot?: boolean;
  curve?: LineCurve;
}) {
  // One point has no shape to draw: an empty glyph beats a misleading flat line.
  if (points.length < 2) return null;

  // Inset by the dot radius (and the stroke) so neither end is clipped by the box.
  const pad = 2;
  const domain = xDomainOf([{ name: '', points }]);
  const xs = xPositionsOf(domain, width - pad * 2, 0);
  const at = new Map(domain.keys.map((k, i) => [k, xs[i]] as [string, number]));
  // No nice rounding: a glyph spends all of its few pixels on the data's own range.
  const y = linearScale(points.map((p) => p.v), { range: [height - pad, pad], nice: false });
  const xy = points
    .filter((p) => Number.isFinite(p.v))
    .map((p) => [pad + (at.get(p.t) ?? 0), y(p.v)] as const)
    .sort((a, b) => a[0] - b[0]);
  const last = xy[xy.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label="Trend"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <path d={curvePath(xy, curve)} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {dot && last && <circle data-spark-dot="" cx={last[0]} cy={last[1]} r={2} fill={color} />}
    </svg>
  );
}
