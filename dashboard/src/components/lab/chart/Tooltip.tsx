import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placeTooltip } from './hover';

/** How a row's key mirrors its mark: a short stroke for lines, a square for fills, a dot for points. */
export type KeyShape = 'line' | 'rect' | 'dot';

export interface TooltipRow {
  /** Stable React key (the series/entity id). */
  id: string;
  /** Series or category name: untrusted data, rendered as text only. */
  label: string;
  /** The formatted value: the strong element of the row. */
  value: string;
  /** The key swatch's colour (a palette token). */
  color?: string;
  shape?: KeyShape;
  /** Dim a row (a series with no value at this x). */
  dim?: boolean;
}

export interface TooltipSpec {
  /** Where the tooltip points, in the drawing's px (the SVG / plot element box; ChartFrame shifts it into the frame). */
  anchor: { x: number; y: number };
  /** The x value / category (a date, a slice name). */
  title?: string;
  rows: TooltipRow[];
  /** A footer line (a stacked total, a share). */
  footer?: ReactNode;
}

interface TooltipProps extends Omit<TooltipSpec, 'anchor'> {
  /** The anchor in the frame's layout px. */
  anchor: { x: number; y: number };
  /** The frame's size: the tooltip never leaves it. */
  bounds: { width: number; height: number };
  /**
   * Float over the page (a portal on <body>, fixed position): a compact frame is
   * too short to hold a tooltip, so `anchor` and `bounds` are viewport px then.
   */
  floating?: boolean;
}

/**
 * The chart tooltip: values lead (strong, text token), the series name
 * follows (secondary), each row keyed by a small mark in the series colour.
 * Text never wears the series colour. Measured before paint and placed beside
 * the anchor, flipping sides at the frame's edge.
 */
export function Tooltip({ anchor, bounds, title, rows, footer, floating = false }: TooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: string } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = placeTooltip(anchor, { width: el.offsetWidth, height: el.offsetHeight }, bounds);
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.side === next.side ? prev : next));
  });

  const el = (
    <div
      ref={ref}
      className="lab-chart-tooltip"
      role="status"
      data-chart-tooltip={floating ? 'floating' : ''}
      data-floating={floating ? 'true' : undefined}
      data-side={pos?.side ?? 'right'}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {title && <div className="lab-chart-tooltip-title">{title}</div>}
      {rows.map((r) => (
        <div key={r.id} className="lab-chart-tooltip-row" data-dim={r.dim ? 'true' : undefined} data-series={r.id}>
          {r.color && <span className="lab-chart-key" data-shape={r.shape ?? 'line'} style={{ color: r.color }} aria-hidden="true" />}
          <span className="lab-chart-tooltip-value" data-value="">{r.value}</span>
          {r.label && <span className="lab-chart-tooltip-label">{r.label}</span>}
        </div>
      ))}
      {footer != null && <div className="lab-chart-tooltip-foot">{footer}</div>}
    </div>
  );
  return floating && typeof document !== 'undefined' ? createPortal(el, document.body) : el;
}
