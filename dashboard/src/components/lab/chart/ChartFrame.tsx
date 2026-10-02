import { useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import type { ChartFit } from './fit';
import { Legend, type LegendPosition, type LegendProps } from './Legend';
import { Tooltip, type TooltipSpec } from './Tooltip';
import './chart.css';

export interface ChartFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The plot element's ref from `useChartSize()`: the frame gives it all the room the legend leaves. */
  plotRef: RefObject<HTMLDivElement | null>;
  /** The frame root's ref from a second `useChartSize()`: the size policy (fit.ts) reads the whole frame. */
  frameRef?: (node: HTMLDivElement | null) => void;
  /**
   * The size policy's verdict for this frame (`chartFit`): where the legend
   * goes, in which form, how many items before "+N"; a compact frame's
   * tooltip floats outside the card. Absent = the legend exactly as asked.
   */
  fit?: ChartFit | null;
  /** The legend and where it goes; `none` (or no items) draws none. */
  legend?: (LegendProps & { position: LegendPosition }) | null;
  /** The live tooltip (anchor in PLOT px), or null. */
  tooltip?: TooltipSpec | null;
  /** The drawing: an <svg className="lab-chart-svg"> sized to the measured plot. */
  children?: ReactNode;
}

/**
 * The chart container every lab chart mounts in. It FILLS its cell (100% x
 * 100%, min-size 0, overflow hidden) and splits it between the legend and the
 * plot: the plot is a flex child whose drawing is absolutely positioned, so
 * the SVG never drives the size it is measured from and nothing ever scrolls
 * inside a chart. The tooltip lives at frame level, so it may overhang the
 * plot into the legend's room but never the cell; in a compact frame (too
 * short to hold one) it floats over the page instead, next to the datum.
 */
export function ChartFrame({ plotRef, frameRef, fit, legend, tooltip, children, className, ...rest }: ChartFrameProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0, plotLeft: 0, plotTop: 0 });
  const asked: LegendPosition = legend && legend.items.length > 0 ? legend.position : 'none';
  const position: LegendPosition = fit && asked !== 'none' ? fit.legend : asked;
  const floating = fit?.size === 'compact';

  const setRoot = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    // A test double may hand a plain object: only a callable ref is called.
    if (typeof frameRef === 'function') frameRef(node);
  }, [frameRef]);

  // The plot's offset inside the frame (layout px, so zoom-proof), read before paint
  // whenever a tooltip is up: it converts the plot-local anchor to frame-local. A
  // floating tooltip is placed in the viewport: the plot's client box is the offset.
  useLayoutEffect(() => {
    if (!tooltip) return;
    const root = rootRef.current;
    const plot = plotRef.current;
    if (!root || !plot) return;
    let next = { width: root.clientWidth, height: root.clientHeight, plotLeft: plot.offsetLeft, plotTop: plot.offsetTop };
    if (floating) {
      const r = plot.getBoundingClientRect();
      next = { width: window.innerWidth, height: window.innerHeight, plotLeft: r.left, plotTop: r.top };
    }
    setFrame((prev) => (prev.width === next.width && prev.height === next.height && prev.plotLeft === next.plotLeft && prev.plotTop === next.plotTop
      ? prev
      : next));
  });

  let legendEl: ReactNode = null;
  if (position !== 'none' && legend) {
    const cap = fit ? Math.max(1, Math.min(legend.items.length, fit.capacity)) : legend.items.length;
    legendEl = (
      <Legend
        items={legend.items.slice(0, cap)}
        hidden={legend.hidden}
        onToggle={legend.onToggle}
        more={legend.items.length - cap + (legend.more ?? 0)}
        form={fit?.form ?? legend.form ?? (position === 'right' ? 'column' : 'wrap')}
      />
    );
  }
  return (
    <div
      ref={setRoot}
      className={className ? `lab-chart ${className}` : 'lab-chart'}
      data-legend={position}
      data-size={fit?.size ?? 'regular'}
      {...rest}
    >
      {position === 'top' && legendEl}
      <div ref={plotRef} className="lab-chart-plot">
        {children}
      </div>
      {(position === 'bottom' || position === 'right') && legendEl}
      {tooltip && (
        <Tooltip
          anchor={{ x: tooltip.anchor.x + frame.plotLeft, y: tooltip.anchor.y + frame.plotTop }}
          bounds={{ width: frame.width, height: frame.height }}
          title={tooltip.title}
          rows={tooltip.rows}
          footer={tooltip.footer}
          floating={floating}
        />
      )}
    </div>
  );
}
