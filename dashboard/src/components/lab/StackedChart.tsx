import { useState } from 'react';
import { CHART_COLORS } from './chartColors';
import { ChartEmpty, ChartTooltip, formatValue, unionTimeKeys, type ChartBodyProps } from './chartBody';

/**
 * `stacked` render — one stacked bar per time bucket: composition over time
 * (which series make up the total, and how that mix moves).
 *
 * Same x axis as LineChart (the sorted union of every series' keys), and the
 * same readout contract: hovering a column reads out EVERY layer at that x, so
 * the pointer aims at a date rather than at a 3px band.
 */

const WIDTH = 560;
const PAD = { top: 10, right: 8, bottom: 22, left: 8 };
/** Share of a column's width left as a gap, so the bars read as buckets. */
const COLUMN_GAP = 0.18;

export function StackedBody({ summary, series, full = false, emptyHint }: ChartBodyProps) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const height = full ? 280 : 150;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const keys = unionTimeKeys(series);
  if (keys.length === 0) return <ChartEmpty hint={emptyHint} />;

  // A stack has no meaning below zero — a negative contribution is drawn as no
  // segment, while the hover readout still reports the value the adapter sent.
  const valueAt = (seriesIndex: number, key: string): number | null => {
    const point = series[seriesIndex].points.find((p) => p.t === key);
    return point ? point.v : null;
  };
  const totals = keys.map((key) =>
    series.reduce((sum, _s, i) => sum + Math.max(0, valueAt(i, key) ?? 0), 0),
  );
  const max = Math.max(...totals, 1);

  const columnW = innerW / keys.length;
  const barW = Math.max(1, columnW * (1 - COLUMN_GAP));
  const baseY = PAD.top + innerH;
  const hoverIndex = hoverKey === null ? -1 : keys.indexOf(hoverKey);

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Stacked bar chart"
        style={{ display: 'block', touchAction: 'pan-y' }}
        onPointerLeave={() => setHoverKey(null)}
      >
        <line x1={PAD.left} y1={baseY} x2={PAD.left + innerW} y2={baseY} stroke="var(--color-border)" strokeWidth={1} />
        {keys.map((key, ki) => {
          const x = PAD.left + ki * columnW + (columnW - barW) / 2;
          let top = baseY;
          return (
            <g key={key}>
              {series.map((s, si) => {
                const v = Math.max(0, valueAt(si, key) ?? 0);
                if (v <= 0) return null;
                const h = (v / max) * innerH;
                top -= h;
                return (
                  <rect
                    key={s.name}
                    x={x}
                    y={top}
                    width={barW}
                    height={h}
                    fill={CHART_COLORS[si % CHART_COLORS.length]}
                    opacity={hoverKey === null || hoverKey === key ? 1 : 0.45}
                    style={{ transition: 'opacity 0.12s ease' }}
                  />
                );
              })}
              {/* Full-height hit area: the bars are too thin to aim at. */}
              <rect
                x={PAD.left + ki * columnW}
                y={PAD.top}
                width={columnW}
                height={innerH}
                fill="transparent"
                onPointerEnter={() => setHoverKey(key)}
              />
            </g>
          );
        })}
        <text x={PAD.left} y={height - 6} fontSize={10} fill="var(--color-text-tertiary)">{keys[0]}</text>
        <text x={PAD.left + innerW} y={height - 6} fontSize={10} fill="var(--color-text-tertiary)" textAnchor="end">
          {keys[keys.length - 1]}
        </text>
      </svg>

      {hoverKey !== null && hoverIndex >= 0 && (
        <ChartTooltip
          style={{
            top: 0,
            left: `${(((PAD.left + hoverIndex * columnW + columnW / 2) / WIDTH) * 100)}%`,
            transform: hoverIndex > keys.length / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
          }}
        >
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>{hoverKey}</div>
          {series.map((s, si) => (
            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1px 0' }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: CHART_COLORS[si % CHART_COLORS.length], flexShrink: 0 }} />
              <span style={{ fontWeight: 700, color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}>
                {formatValue(valueAt(si, hoverKey), summary.unit)}
              </span>
              {series.length > 1 && <span style={{ color: 'var(--color-text-secondary)', fontSize: 11.5 }}>{s.name}</span>}
            </div>
          ))}
          {series.length > 1 && (
            <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', fontSize: 11.5 }}>
              Total <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}>
                {formatValue(totals[hoverIndex], summary.unit)}
              </span>
            </div>
          )}
        </ChartTooltip>
      )}

      {series.length > 1 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
          {series.map((s, i) => (
            <span key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: CHART_COLORS[i % CHART_COLORS.length], display: 'inline-block' }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
