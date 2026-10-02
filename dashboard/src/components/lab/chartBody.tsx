import { useEffect, useState, type ReactNode } from 'react';
import type { InsightCache, InsightSummary, Series } from '../../hooks/useLab';
import './chartBody.css';

/**
 * The one contract every chart body in the registry honours (chartRegistry.ts).
 *
 * A body gets the whole insight — summary + cache — instead of a per-render prop
 * list, so the card and the detail panel mount ANY render the same way and a new
 * chart type needs no shell change. `full` is the main variance: the card is a
 * thumbnail, the panel is the whole story. On a board the `insight` block gives a
 * chart render (registry `fit: 'fill'`) a box of definite size with no scroll, and
 * passes its measured `height`: the body draws to that box instead of a fixed height.
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
  /**
   * The measured height of the box the host gives the body, in CSS px, when the
   * host has one (the board's `insight` block for `fit: 'fill'` renders). Absent =
   * the body sizes itself (the detail panel). A chart body fills its parent then.
   */
  height?: number;
  /**
   * An OPENING view a caller wants this body to start from, when the body has axes to
   * choose (today: `breakdown`). Purely initial state — the body's own controls stay live
   * and win from the first interaction, and nothing here is written back to the insight's
   * stored tweaks. Added for the Chat surface's `{"type":"insight"}` block, which composes
   * an existing insight the way a report item does and must never re-configure it.
   */
  pivot?: { rows?: string; cols?: string; filter?: Record<string, string> };
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

/**
 * A change, never told by colour alone: an arrow icon (up, down, or a flat bar),
 * the sign, and the absolute value written by `format`. `colored` adds the status
 * ink (up = success, down = error; the table's `deltaColor`), which is the only
 * place a status colour appears in a lab figure. `suffix` follows the value
 * (a percent change, "vs previous day").
 */
export function DeltaMark({ delta, format, colored = true, suffix, className }: {
  delta: number | null;
  format: (abs: number) => string;
  colored?: boolean;
  suffix?: ReactNode;
  className?: string;
}) {
  const dir = delta === null || !Number.isFinite(delta) ? 'none' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const cls = className ? `lab-delta ${className}` : 'lab-delta';
  if (dir === 'none') return <span className={cls} data-dir="none">-</span>;
  const abs = Math.abs(delta as number);
  const sign = dir === 'up' ? '+' : dir === 'down' ? '\u2212' : '';
  return (
    <span className={cls} data-dir={dir} data-colored={colored ? '' : undefined}>
      <svg className="lab-delta-icon" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
        {dir === 'up' && <path d="M5 1.5 9 8.5H1z" />}
        {dir === 'down' && <path d="M5 8.5 1 1.5h8z" />}
        {dir === 'flat' && <rect x="1.5" y="4" width="7" height="2" rx="1" />}
      </svg>
      <span className="lab-delta-value">{`${sign}${format(abs)}`}</span>
      {suffix}
    </span>
  );
}

/**
 * The size of an element that may mount late (a block's root once its frame
 * arrives, a stat's spark slot once its series or option does): a callback
 * ref, so the observer follows the element that is actually there.
 */
export function useMeasured<T extends HTMLElement>(): [(el: T | null) => void, { width: number; height: number }] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, size];
}
