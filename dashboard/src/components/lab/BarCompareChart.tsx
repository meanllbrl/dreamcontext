import { useState } from 'react';
import { CHART_COLORS } from './chartColors';
import { ChartEmpty, ChartTooltip, formatValue, unionTimeKeys, type ChartBodyProps } from './chartBody';

/**
 * `bar_compare` render — grouped vertical bars: one group per time bucket, one
 * bar per series inside it. The before/after comparison (plan vs actual, this
 * week vs last), which a line chart blurs and a pie cannot express at all.
 *
 * Only the LAST few buckets are drawn: comparing more than a handful of groups
 * side by side stops being a comparison and becomes an unreadable line chart.
 */

const WIDTH = 560;
const PAD = { top: 10, right: 8, bottom: 22, left: 8 };
/** Buckets compared side by side — the card has less room than the panel. */
const BUCKETS = { card: 4, full: 6 };
/** Series drawn before the rest collapse into a "+k more" note (color scale size). */
const SERIES_CAP = 6;
/** Share of a group's width left as breathing room between groups. */
const GROUP_GAP = 0.22;

export function BarCompareBody({ summary, series, full = false, emptyHint }: ChartBodyProps) {
  const [hover, setHover] = useState<{ key: string; name: string; value: number; x: number } | null>(null);

  const height = full ? 260 : 150;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const drawn = series.slice(0, SERIES_CAP);
  const hiddenSeries = series.length - drawn.length;
  const keys = unionTimeKeys(drawn).slice(-(full ? BUCKETS.full : BUCKETS.card));

  if (keys.length === 0) return <ChartEmpty hint={emptyHint} />;

  const values = drawn.flatMap((s) => s.points.filter((p) => keys.includes(p.t)).map((p) => p.v));
  // Bars are read against a zero baseline — a negative value must grow downward
  // from it, not rescale the axis so it looks positive.
  const maxV = Math.max(...values, 0);
  const minV = Math.min(...values, 0);
  const range = maxV - minV || 1;
  const yFor = (v: number) => PAD.top + innerH - ((v - minV) / range) * innerH;
  const zeroY = yFor(0);

  const groupW = innerW / keys.length;
  const barsW = groupW * (1 - GROUP_GAP);
  const barW = barsW / drawn.length;

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Grouped bar chart"
        style={{ display: 'block' }}
      >
        <line x1={PAD.left} y1={zeroY} x2={PAD.left + innerW} y2={zeroY} stroke="var(--color-border)" strokeWidth={1} />
        {keys.map((key, gi) => {
          const groupX = PAD.left + gi * groupW + (groupW - barsW) / 2;
          return (
            <g key={key}>
              {drawn.map((s, si) => {
                const point = s.points.find((p) => p.t === key);
                if (!point) return null;
                const x = groupX + si * barW;
                const y = Math.min(yFor(point.v), zeroY);
                const h = Math.max(1, Math.abs(zeroY - yFor(point.v)));
                const active = hover !== null && hover.key === key && hover.name === s.name;
                return (
                  <rect
                    key={s.name}
                    x={x}
                    y={y}
                    width={Math.max(1, barW - 1.5)}
                    height={h}
                    rx={2}
                    fill={CHART_COLORS[si % CHART_COLORS.length]}
                    opacity={hover === null || active ? 1 : 0.45}
                    style={{ transition: 'opacity 0.12s ease' }}
                    onPointerEnter={() => setHover({ key, name: s.name, value: point.v, x: x + barW / 2 })}
                    onPointerLeave={() => setHover(null)}
                  />
                );
              })}
              <text
                x={PAD.left + gi * groupW + groupW / 2}
                y={height - 6}
                fontSize={9.5}
                textAnchor="middle"
                fill="var(--color-text-tertiary)"
              >{key}</text>
            </g>
          );
        })}
      </svg>

      {hover && (
        <ChartTooltip
          style={{
            top: 0,
            left: `${(hover.x / WIDTH) * 100}%`,
            transform: hover.x > WIDTH / 2 ? 'translateX(calc(-100% - 6px))' : 'translateX(6px)',
          }}
        >
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>{hover.key}</div>
          <span style={{ fontWeight: 700, color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}>
            {formatValue(hover.value, summary.unit)}
          </span>
          <span style={{ color: 'var(--color-text-secondary)', marginLeft: 6 }}>{hover.name}</span>
        </ChartTooltip>
      )}

      {drawn.length > 1 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
          {drawn.map((s, i) => (
            <span key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: CHART_COLORS[i % CHART_COLORS.length], display: 'inline-block' }} />
              {s.name}
            </span>
          ))}
          {hiddenSeries > 0 && (
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>+{hiddenSeries} more</span>
          )}
        </div>
      )}
    </div>
  );
}
