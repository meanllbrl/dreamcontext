import { useState } from 'react';
import { BarList } from './BarList';
import { capRows, recolorRows } from './BarList';
import { rankRows, toBarRows, type BarRow } from './barRows';
import { ChartEmpty, ChartTooltip, formatValue, type ChartBodyProps } from './chartBody';

/**
 * `bar` render — one horizontal bar per series, sized by that series' LATEST
 * value: the "who is biggest right now" question, where a line chart answers
 * "how did each move". Drawing is the shared BarList (PieChart's ≥7-slice
 * degrade renders the same rows).
 */
export function BarBody({ summary, series, full = false, emptyHint }: ChartBodyProps) {
  const rows = toBarRows(series);
  if (rows.length === 0) return <ChartEmpty hint={emptyHint} />;
  return <BarList rows={rows} unit={summary.unit} full={full} />;
}

const WIDTH = 560;
const PAD = { top: 18, right: 8, bottom: 22, left: 8 };
/** Share of a column's width left as a gap between columns. */
const COLUMN_GAP = 0.28;

/**
 * The same rows as BarList, standing up: one column per row, value above,
 * label below. What a board `bar` block with `orientation: v` draws.
 */
export function VerticalBars({ rows, unit, height = 180 }: { rows: BarRow[]; unit: string | null; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = Math.max(24, height - PAD.top - PAD.bottom);
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;
  const columnW = innerW / Math.max(1, rows.length);
  const barW = Math.max(2, columnW * (1 - COLUMN_GAP));
  const baseY = PAD.top + innerH;
  const hovered = hover !== null ? rows[hover] ?? null : null;

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${WIDTH} ${height}`} width="100%" height={height} role="img" aria-label="Vertical bar chart" style={{ display: 'block' }}>
        <line x1={PAD.left} y1={baseY} x2={PAD.left + innerW} y2={baseY} stroke="var(--color-border)" strokeWidth={1} />
        {rows.map((r, i) => {
          const h = Math.max(1, (r.value / max) * innerH);
          const x = PAD.left + i * columnW + (columnW - barW) / 2;
          return (
            <g key={r.name} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect
                data-bar=""
                x={x}
                y={baseY - h}
                width={barW}
                height={h}
                rx={3}
                fill={r.color}
                opacity={hover === null || hover === i ? 1 : 0.45}
                style={{ transition: 'opacity 0.12s ease' }}
              />
              <text x={x + barW / 2} y={height - 6} fontSize={10} textAnchor="middle" fill="var(--color-text-tertiary)">
                {r.name.length > 12 ? `${r.name.slice(0, 11)}…` : r.name}
              </text>
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <ChartTooltip
          style={{
            top: 0,
            left: `${((PAD.left + hover * columnW + columnW / 2) / WIDTH) * 100}%`,
            transform: hover > rows.length / 2 ? 'translateX(calc(-100% - 6px))' : 'translateX(6px)',
          }}
        >
          <span style={{ fontWeight: 700, color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}>{formatValue(hovered.value, unit)}</span>
          <span style={{ color: 'var(--color-text-secondary)', marginLeft: 6 }}>{hovered.name}</span>
        </ChartTooltip>
      )}
    </div>
  );
}

/**
 * The bar chart with its board options: `orientation` (h = BarList, v =
 * VerticalBars), `colorIndex` (palette slot the first bar takes) and `ranked`
 * (false keeps a block's own `sort` order instead of ranking by value).
 */
export function BarChart({ rows, unit, full = false, orientation = 'h', colorIndex, ranked = true, height, emptyHint }: {
  rows: BarRow[];
  unit: string | null;
  full?: boolean;
  orientation?: 'h' | 'v';
  colorIndex?: number;
  ranked?: boolean;
  height?: number;
  emptyHint?: string;
}) {
  if (rows.length === 0) return <ChartEmpty hint={emptyHint} />;
  if (orientation === 'v') {
    const capped = (ranked ? rankRows(rows, full) : capRows(rows, full)).rows;
    return <VerticalBars rows={colorIndex === undefined ? capped : recolorRows(capped, colorIndex)} unit={unit} height={height} />;
  }
  return <BarList rows={rows} unit={unit} full={full} ranked={ranked} colorIndex={colorIndex} />;
}
