import { useCallback, useMemo, useState } from 'react';
import type { KeyShape } from './Tooltip';

export const LEGEND_POSITIONS = ['top', 'bottom', 'right', 'none'] as const;
export type LegendPosition = (typeof LEGEND_POSITIONS)[number];

export function toLegendPosition(v: unknown, fallback: LegendPosition = 'bottom'): LegendPosition {
  return (LEGEND_POSITIONS as readonly unknown[]).includes(v) ? (v as LegendPosition) : fallback;
}

export interface LegendItem {
  id: string;
  /** Untrusted data: rendered as text only. */
  label: string;
  color: string;
  /** Mirror the mark: 'rect' for bars/areas/slices, 'line' for lines. */
  shape?: KeyShape;
}

export interface LegendProps {
  items: readonly LegendItem[];
  /** Ids currently hidden (toggled off). */
  hidden?: ReadonlySet<string>;
  /** Click / Enter / Space on an item. Omit for a static legend. */
  onToggle?(id: string): void;
}

/**
 * The series legend. Each item is a real <button> with aria-pressed, so it is
 * reachable by Tab and toggled by Enter or Space as well as by click; a hidden
 * series keeps its row, struck through with a faded key (state is never colour
 * alone). The key mirrors the mark; the label wears a text token.
 */
export function Legend({ items, hidden, onToggle }: LegendProps) {
  if (items.length === 0) return null;
  return (
    <ul className="lab-chart-legend" data-chart-legend="">
      {items.map((it) => {
        const on = !hidden?.has(it.id);
        const key = <span className="lab-chart-key" data-shape={it.shape ?? 'rect'} style={{ color: it.color }} aria-hidden="true" />;
        const text = <span className="lab-chart-legend-label" title={it.label}>{it.label}</span>;
        return (
          <li key={it.id} style={{ minWidth: 0, maxWidth: '100%', display: 'flex' }}>
            {onToggle ? (
              <button
                type="button"
                className="lab-chart-legend-item"
                aria-pressed={on}
                data-series={it.id}
                onClick={() => onToggle(it.id)}
              >
                {key}
                {text}
              </button>
            ) : (
              <span className="lab-chart-legend-item" data-series={it.id}>
                {key}
                {text}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Which of `ids` are hidden after toggling `id` (hiding the last visible one shows all again). */
export function toggleHidden(hidden: ReadonlySet<string>, id: string, ids: readonly string[]): Set<string> {
  const next = new Set(hidden);
  if (next.has(id)) {
    next.delete(id);
    return next;
  }
  next.add(id);
  // A chart with every series hidden is a blank card: turning off the last one resets.
  if (ids.every((x) => next.has(x))) return new Set();
  return next;
}

/**
 * Legend toggle state for a chart: `hidden` ids, `visible(id)`, and `toggle`
 * to hand the Legend. Ids that leave the data are forgotten on their own
 * (only ids still in `ids` count as hidden).
 */
export function useSeriesToggle(ids: readonly string[]) {
  const [raw, setRaw] = useState<ReadonlySet<string>>(() => new Set());
  const idKey = ids.join('\u0000');
  const hidden = useMemo(() => new Set(ids.filter((id) => raw.has(id))), [raw, idKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = useCallback((id: string) => setRaw((prev) => toggleHidden(prev, id, ids)), [idKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useCallback((id: string) => !hidden.has(id), [hidden]);
  return { hidden: hidden as ReadonlySet<string>, toggle, visible };
}
