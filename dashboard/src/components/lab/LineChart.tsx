import { useMemo, useRef, useState } from 'react';
import type { Series } from '../../hooks/useLab';

/** Hand-rolled SVG line chart — no chart library exists in the dashboard, and
 *  none is added for this MVP (locked plan assumption A1).
 *
 *  Interactive: a vertical crosshair snaps to the nearest data position and one
 *  tooltip reads out EVERY series at that x — the pointer aims at a date, never
 *  at a 2px line. */

const COLORS = ['#7b68ee', '#0091ff', '#ff5b36', '#4ade80', '#ffae3b'];
const WIDTH = 560;
const PAD = { top: 12, right: 12, bottom: 24, left: 12 };

interface Props {
  series: Series[];
  unit?: string | null;
  height?: number;
}

export function LineChart({ series, unit = null, height = 200 }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  // All geometry is hover-independent — memoized so pointer-move renders only
  // rebuild the crosshair/tooltip overlay, not every axis key and path string.
  const { xKeys, xFor, yFor, polylines, hasData } = useMemo(() => {
    const allPoints = series.flatMap((s) => s.points);
    // x-axis: union of all time keys, sorted — every series maps onto the same axis.
    const keys = Array.from(new Set(allPoints.map((p) => p.t))).sort();
    const keyIndex = new Map(keys.map((k, i) => [k, i]));
    const values = allPoints.map((p) => p.v);
    const minV = Math.min(...values, 0);
    const maxV = Math.max(...values, 1);
    const range = maxV - minV || 1;
    const xForFn = (t: string): number => {
      const idx = keyIndex.get(t) ?? 0;
      return keys.length <= 1 ? PAD.left + innerW / 2 : PAD.left + (idx / (keys.length - 1)) * innerW;
    };
    const yForFn = (v: number): number => PAD.top + innerH - ((v - minV) / range) * innerH;
    const lines = series.map((s, i) => ({
      name: s.name,
      color: COLORS[i % COLORS.length],
      path: s.points.map((p) => `${xForFn(p.t)},${yForFn(p.v)}`).join(' '),
    }));
    return { xKeys: keys, xFor: xForFn, yFor: yForFn, polylines: lines, hasData: allPoints.length > 0 };
  }, [series, innerW, innerH]);

  if (!hasData) {
    return <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '24px 0' }}>No data yet.</div>;
  }

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || xKeys.length === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const vx = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const frac = (vx - PAD.left) / innerW;
    const idx = Math.round(frac * (xKeys.length - 1));
    setHoverIdx(Math.max(0, Math.min(xKeys.length - 1, idx)));
  };

  const first = xKeys[0];
  const last = xKeys[xKeys.length - 1];

  // `?? null`: hoverIdx can go stale when a refresh/tweak shrinks the series
  // while the pointer is stationary — an out-of-range index must read as
  // "no hover", not leak undefined past the !== null guards below.
  const hoverKey = hoverIdx !== null ? xKeys[hoverIdx] ?? null : null;
  const hoverX = hoverKey !== null ? xFor(hoverKey) : null;
  // The readout lists every series at the hovered x (a series may skip a key).
  const hoverRows = hoverKey !== null
    ? series.map((s, i) => ({
        name: s.name,
        color: COLORS[i % COLORS.length],
        point: s.points.find((p) => p.t === hoverKey) ?? null,
      }))
    : [];
  // Tooltip flips sides past the midpoint so it never overflows the card.
  const tooltipOnLeft = hoverX !== null && hoverX > WIDTH / 2;

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Line chart"
        style={{ display: 'block', touchAction: 'pan-y' }}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <line x1={PAD.left} y1={PAD.top + innerH} x2={PAD.left + innerW} y2={PAD.top + innerH} stroke="var(--color-border)" strokeWidth={1} />
        {polylines.map((l) => (
          <polyline key={l.name} points={l.path} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {hoverX !== null && (
          <g pointerEvents="none">
            <line x1={hoverX} y1={PAD.top} x2={hoverX} y2={PAD.top + innerH} stroke="var(--color-text-tertiary)" strokeWidth={1} strokeDasharray="3 3" />
            {hoverRows.map((r) =>
              r.point ? (
                <circle key={r.name} cx={hoverX} cy={yFor(r.point.v)} r={4} fill={r.color} stroke="var(--color-bg-secondary)" strokeWidth={2} />
              ) : null,
            )}
          </g>
        )}
        <text x={PAD.left} y={height - 4} fontSize={10} fill="var(--color-text-tertiary)">{first}</text>
        <text x={PAD.left + innerW} y={height - 4} fontSize={10} fill="var(--color-text-tertiary)" textAnchor="end">{last}</text>
      </svg>

      {hoverX !== null && hoverKey !== null && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: `${(hoverX / WIDTH) * 100}%`,
            transform: tooltipOnLeft ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            pointerEvents: 'none',
            zIndex: 5,
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-md)',
            padding: '7px 10px',
            minWidth: 90,
            fontSize: 12,
          }}
        >
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>{hoverKey}</div>
          {hoverRows.map((r) => (
            <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1px 0' }}>
              <span style={{ width: 10, height: 2, borderRadius: 1, background: r.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 700, color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}>
                {r.point ? r.point.v.toLocaleString() : '—'}{r.point && unit ? ` ${unit}` : ''}
              </span>
              {series.length > 1 && <span style={{ color: 'var(--color-text-secondary)', fontSize: 11.5 }}>{r.name}</span>}
            </div>
          ))}
        </div>
      )}

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
