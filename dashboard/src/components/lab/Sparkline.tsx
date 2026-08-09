import type { SeriesPoint } from '../../hooks/useLab';

/**
 * A trend GLYPH, not a chart: no axes, no labels, no hover — just the shape of
 * the last N points, sized to sit inline next to a number or in a table cell.
 * Anything that needs to be read precisely is what LineChart is for.
 */
export function Sparkline({ points, width = 68, height = 18, color = 'var(--chart-1)' }: {
  points: SeriesPoint[];
  width?: number;
  height?: number;
  color?: string;
}) {
  // One point has no shape to draw — an empty glyph beats a misleading flat line.
  if (points.length < 2) return null;

  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  // Inset by the dot radius so the end marker is never clipped by the viewBox.
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const xy = points.map((p, i) => [
    pad + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW),
    pad + innerH - ((p.v - min) / range) * innerH,
  ]);
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
      <polyline
        points={xy.map(([x, y]) => `${x},${y}`).join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last[0]} cy={last[1]} r={2} fill={color} />
    </svg>
  );
}
