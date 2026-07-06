import { useState } from 'react';
import type { Series } from '../../hooks/useLab';

/** Hand-rolled SVG pie chart — one slice per series, sized by its latest value.
 *  Interactive: hovering a slice (or its legend row) lifts it and reads out
 *  name, value, and share. */

const COLORS = ['#7b68ee', '#0091ff', '#ff5b36', '#4ade80', '#ffae3b', '#c8ccd9'];

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const toXY = (angle: number) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  const [x1, y1] = toXY(startAngle);
  const [x2, y2] = toXY(endAngle);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

export function PieChart({ series, size = 140, unit = null }: { series: Series[]; size?: number; unit?: string | null }) {
  const [hovered, setHovered] = useState<string | null>(null);

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.43;

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
    return { name: s.name, value: s.value, frac, d: arcPath(cx, cy, r, start, end), color: COLORS[i % COLORS.length] };
  });

  const active = paths.find((p) => p.name === hovered) ?? null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="Pie chart">
          {paths.map((p) =>
            // A lone slice is a full circle — its arc's endpoints coincide, and
            // per the SVG spec a coincident-endpoint arc segment renders nothing.
            paths.length === 1 ? (
              <circle
                key={p.name}
                cx={cx}
                cy={cy}
                r={r}
                fill={p.color}
                stroke="var(--color-bg)"
                strokeWidth={1}
                onPointerEnter={() => setHovered(p.name)}
                onPointerLeave={() => setHovered(null)}
              />
            ) : (
              <path
                key={p.name}
                d={p.d}
                fill={p.color}
                stroke="var(--color-bg)"
                strokeWidth={1}
                opacity={hovered === null || hovered === p.name ? 1 : 0.45}
                style={{ transition: 'opacity 0.12s ease', cursor: 'default' }}
                onPointerEnter={() => setHovered(p.name)}
                onPointerLeave={() => setHovered(null)}
              />
            ),
          )}
        </svg>
        {active && (
          <div
            style={{
              position: 'absolute', top: -6, left: '50%', transform: 'translate(-50%, -100%)',
              pointerEvents: 'none', zIndex: 5, whiteSpace: 'nowrap',
              background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
              borderRadius: 8, boxShadow: 'var(--shadow-md)', padding: '6px 10px', fontSize: 12,
            }}
          >
            <span style={{ fontWeight: 700, color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}>
              {active.value.toLocaleString()}{unit ? ` ${unit}` : ''}
            </span>
            <span style={{ color: 'var(--color-text-secondary)', marginLeft: 6 }}>
              {active.name} · {(active.frac * 100).toFixed(1)}%
            </span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {paths.map((p) => (
          <span
            key={p.name}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
              color: hovered === p.name ? 'var(--color-text)' : 'var(--color-text-secondary)',
            }}
            onPointerEnter={() => setHovered(p.name)}
            onPointerLeave={() => setHovered(null)}
          >
            <span style={{ width: 9, height: 9, borderRadius: 3, background: p.color, display: 'inline-block' }} />
            {p.name} — {(p.frac * 100).toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  );
}
