import { useState } from 'react';
import type { Series } from '../../hooks/useLab';
import { BarList } from './BarList';
import { degradesToBars, rankRows, fmtPct, toBarRows, type BarRow } from './barRows';
import { ChartEmpty, type ChartBodyProps } from './chartBody';

/** Hand-rolled SVG pie chart — one slice per series, sized by its latest value.
 *  Interactive: hovering a slice (or its legend row) lifts it and reads out
 *  name, value, and share.
 *
 *  Two bounds keep a card from being stretched by its own data: the legend is
 *  capped (top N + one "+k more" row) unless the caller asks for the `full`
 *  legend, and past BAR_THRESHOLD slices (barRows.ts — `degradesToBars`) the pie
 *  stops being readable at all and degrades to the shared horizontal bar list
 *  (BarList.tsx — the same component the `bar` render draws). */

/** Reserved strip above the pie for the absolutely-positioned readout: the card
 *  body clips its overflow (InsightCard.css), so the bubble must stay inside. */
const READOUT_GUTTER = 32;

type Slice = BarRow;

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const toXY = (angle: number) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  const [x1, y1] = toXY(startAngle);
  const [x2, y2] = toXY(endAngle);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

export function PieChart({ series, size = 140, unit = null, full = false, emptyHint }: {
  series: Series[];
  size?: number;
  unit?: string | null;
  /** Detail panel: show every row instead of the card's top-N + "+k more". */
  full?: boolean;
  emptyHint?: string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.43;

  const slices: Slice[] = toBarRows(series);

  if (slices.length === 0) {
    return <ChartEmpty hint={emptyHint} />;
  }

  if (degradesToBars(slices.length)) {
    return <BarList rows={slices} unit={unit} full={full} />;
  }

  let angle = -Math.PI / 2;
  const paths = slices.map((s) => {
    const start = angle;
    const end = angle + s.frac * 2 * Math.PI;
    angle = end;
    return { ...s, d: arcPath(cx, cy, r, start, end) };
  });

  const active = paths.find((p) => p.name === hovered) ?? null;
  const { rows, restCount, restFrac } = rankRows(slices, full);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingTop: full ? 0 : READOUT_GUTTER }}>
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
              {active.name} · {fmtPct(active.frac)}
            </span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        {rows.map((p) => (
          <span
            key={p.name}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, minWidth: 0,
              color: hovered === p.name ? 'var(--color-text)' : 'var(--color-text-secondary)',
            }}
            onPointerEnter={() => setHovered(p.name)}
            onPointerLeave={() => setHovered(null)}
          >
            <span style={{ width: 9, height: 9, borderRadius: 3, background: p.color, display: 'inline-block', flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.name} — {fmtPct(p.frac)}
            </span>
          </span>
        ))}
        {restCount > 0 && (
          <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }} title="Open the insight to see every slice">
            +{restCount} more — {fmtPct(restFrac)}
          </span>
        )}
      </div>
    </div>
  );
}

/** Registry body (`pie`). The panel gets the bigger pie and the full legend. */
export function PieBody({ summary, series, full = false, emptyHint }: ChartBodyProps) {
  return (
    <PieChart
      series={series}
      unit={summary.unit}
      size={full ? 240 : 140}
      full={full}
      emptyHint={emptyHint}
    />
  );
}
