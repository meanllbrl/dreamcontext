import type { ReactNode } from 'react';
import type { InsightCache, InsightSummary, Series } from '../../hooks/useLab';

/**
 * The one contract every chart body in the registry honours (chartRegistry.ts).
 *
 * A body gets the whole insight — summary + cache — instead of a per-render prop
 * list, so the card and the detail panel mount ANY render the same way and a new
 * chart type needs no shell change. `full` is the only variance: the card is a
 * thumbnail (bounded by `.lab-card-body`'s 280px cap), the panel is the whole story.
 */
export interface ChartBodyProps {
  summary: InsightSummary;
  /** The cached snapshot behind this insight — null until the first sync. */
  cache: InsightCache | null;
  /** `cache.series`, already defaulted to `[]`. */
  series: Series[];
  /** Detail-panel variant: a bigger canvas, uncapped legends/rows. */
  full?: boolean;
  /** The registry's per-render copy for the no-data state. */
  emptyHint?: string;
}

/** The shared "nothing to draw" body — one idiom across every render. */
export function ChartEmpty({ hint }: { hint?: string }) {
  return (
    <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '24px 0' }}>
      {hint || 'No data yet.'}
    </div>
  );
}

/** The floating readout the hand-rolled charts share (positioned by the caller). */
export function ChartTooltip({ style, children }: { style?: React.CSSProperties; children: ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        zIndex: 5,
        whiteSpace: 'nowrap',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-md)',
        padding: '7px 10px',
        fontSize: 12,
        ...style,
      }}
    >{children}</div>
  );
}

/** The last observation of a series, or null when it has none. */
export function latestPoint(series: Series): { t: string; v: number } | null {
  return series.points.length > 0 ? series.points[series.points.length - 1] : null;
}

/** The shared x axis: the union of every series' time keys, sorted (LineChart's
 *  rule — a series may skip a bucket, the axis may not). */
export function unionTimeKeys(series: Series[]): string[] {
  return Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.t)))).sort();
}

/** Value + unit, formatted the way every lab readout formats it. */
export function formatValue(v: number | null, unit: string | null): string {
  if (v === null) return '—';
  return `${v.toLocaleString()}${unit ? ` ${unit}` : ''}`;
}
