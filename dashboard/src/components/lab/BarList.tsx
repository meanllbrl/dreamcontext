import { useState } from 'react';
import { CHART_COLORS } from './chartColors';
import { fmtPct, rankRows, ROW_CAP, type BarRow } from './barRows';

/**
 * The horizontal bar list: one row per series — label in its own gutter, a
 * proportional bar, then value + share.
 *
 * Two renders draw it: `bar` (the render type) and `pie` when it degrades past
 * BAR_THRESHOLD slices. Same rows, same ranking, same cap — the pie's degrade is
 * literally the bar render, so there is one implementation of it. The row math
 * itself (ranking, cap, the degrade threshold) lives in barRows.ts.
 */

/** Rows in the given order (no ranking), capped unless `full` like {@link rankRows}. */
export function capRows(rows: BarRow[], full: boolean): { rows: BarRow[]; restCount: number; restFrac: number } {
  if (full || rows.length <= ROW_CAP) return { rows, restCount: 0, restFrac: 0 };
  const rest = rows.slice(ROW_CAP);
  return { rows: rows.slice(0, ROW_CAP), restCount: rest.length, restFrac: rest.reduce((a, s) => a + s.frac, 0) };
}

/** Rows recolored from palette slot `colorIndex` (1-based) in display order. */
export function recolorRows(rows: BarRow[], colorIndex: number): BarRow[] {
  const offset = Math.max(0, Math.round(colorIndex) - 1);
  return rows.map((r, i) => ({ ...r, color: CHART_COLORS[(offset + i) % CHART_COLORS.length] }));
}

export function BarList({ rows, unit, full = false, ranked = true, colorIndex }: {
  rows: BarRow[];
  unit: string | null;
  /** Detail panel: every row instead of the card's top-N + "+k more". */
  full?: boolean;
  /** Rank by value (the default). False keeps the caller's order (a board block's `sort`). */
  ranked?: boolean;
  /** Recolor from this palette slot (1-8) in display order; absent keeps each row's color. */
  colorIndex?: number;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const capped = ranked ? rankRows(rows, full) : capRows(rows, full);
  const shown = colorIndex === undefined ? capped.rows : recolorRows(capped.rows, colorIndex);
  const { restCount, restFrac } = capped;
  const max = shown.reduce((m, s) => Math.max(m, s.value), 0) || 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }} role="img" aria-label="Share by series">
      {shown.map((s) => (
        <div
          key={s.name}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, minWidth: 0,
            opacity: hovered === null || hovered === s.name ? 1 : 0.55,
            transition: 'opacity 0.12s ease',
          }}
          onPointerEnter={() => setHovered(s.name)}
          onPointerLeave={() => setHovered(null)}
        >
          <span
            style={{
              flex: '0 0 34%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: hovered === s.name ? 'var(--color-text)' : 'var(--color-text-secondary)',
            }}
            title={s.name}
          >{s.name}</span>
          <span style={{ flex: 1, minWidth: 0, height: 8, borderRadius: 4, background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${(s.value / max) * 100}%`, background: s.color, borderRadius: 4 }} />
          </span>
          <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-text)' }}>
            {s.value.toLocaleString()}{unit ? ` ${unit}` : ''}
            <span style={{ color: 'var(--color-text-tertiary)' }}> · {fmtPct(s.frac)}</span>
          </span>
        </div>
      ))}
      {restCount > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }} title="Open the insight to see every series">
          +{restCount} more — {fmtPct(restFrac)}
        </div>
      )}
    </div>
  );
}
