import type { Series } from '../../hooks/useLab';

/** Hand-rolled SVG pie chart — one slice per series, sized by its latest value. */

const COLORS = ['#7b68ee', '#0091ff', '#ff5b36', '#4ade80', '#ffae3b', '#c8ccd9'];
const SIZE = 140;
const R = 60;
const CX = SIZE / 2;
const CY = SIZE / 2;

function arcPath(startAngle: number, endAngle: number): string {
  const toXY = (angle: number) => [CX + R * Math.cos(angle), CY + R * Math.sin(angle)];
  const [x1, y1] = toXY(startAngle);
  const [x2, y2] = toXY(endAngle);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${CX} ${CY} L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`;
}

export function PieChart({ series }: { series: Series[] }) {
  const slices = series
    .map((s) => ({ name: s.name, value: s.points.length > 0 ? s.points[s.points.length - 1].v : 0 }))
    .filter((s) => s.value > 0);
  const total = slices.reduce((a, b) => a + b.value, 0);

  if (slices.length === 0 || total <= 0) {
    return <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '24px 0' }}>No data yet.</div>;
  }

  let angle = -Math.PI / 2;
  const paths = slices.map((s, i) => {
    const frac = s.value / total;
    const start = angle;
    const end = angle + frac * 2 * Math.PI;
    angle = end;
    return { name: s.name, value: s.value, d: arcPath(start, end), color: COLORS[i % COLORS.length] };
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="img" aria-label="Pie chart">
        {paths.map((p) => <path key={p.name} d={p.d} fill={p.color} stroke="var(--color-bg)" strokeWidth={1} />)}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {paths.map((p) => (
          <span key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: p.color, display: 'inline-block' }} />
            {p.name} — {((p.value / total) * 100).toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  );
}
