import type { Series } from '../../hooks/useLab';

/** Hand-rolled SVG line chart — no chart library exists in the dashboard, and
 *  none is added for this MVP (locked plan assumption A1). */

const COLORS = ['#7b68ee', '#0091ff', '#ff5b36', '#4ade80', '#ffae3b'];
const WIDTH = 560;
const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 12 };

export function LineChart({ series }: { series: Series[] }) {
  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    return <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '24px 0' }}>No data yet.</div>;
  }

  const values = allPoints.map((p) => p.v);
  const minV = Math.min(...values, 0);
  const maxV = Math.max(...values, 1);
  const range = maxV - minV || 1;

  // x-axis: union of all time keys, sorted — every series maps onto the same axis.
  const xKeys = Array.from(new Set(allPoints.map((p) => p.t))).sort();
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const xFor = (t: string): number => {
    const idx = xKeys.indexOf(t);
    return xKeys.length <= 1 ? PAD.left : PAD.left + (idx / (xKeys.length - 1)) * innerW;
  };
  const yFor = (v: number): number => PAD.top + innerH - ((v - minV) / range) * innerH;

  const first = xKeys[0];
  const last = xKeys[xKeys.length - 1];

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label="Line chart">
        <line x1={PAD.left} y1={PAD.top + innerH} x2={PAD.left + innerW} y2={PAD.top + innerH} stroke="var(--color-border)" strokeWidth={1} />
        {series.map((s, i) => {
          const color = COLORS[i % COLORS.length];
          const path = s.points.map((p) => `${xFor(p.t)},${yFor(p.v)}`).join(' ');
          return <polyline key={s.name} points={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />;
        })}
        <text x={PAD.left} y={HEIGHT - 4} fontSize={10} fill="var(--color-text-tertiary)">{first}</text>
        <text x={PAD.left + innerW} y={HEIGHT - 4} fontSize={10} fill="var(--color-text-tertiary)" textAnchor="end">{last}</text>
      </svg>
      {series.length > 1 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
          {series.map((s, i) => (
            <span key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: COLORS[i % COLORS.length], display: 'inline-block' }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
