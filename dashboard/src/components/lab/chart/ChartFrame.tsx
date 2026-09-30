import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { Legend, type LegendPosition, type LegendProps } from './Legend';
import { Tooltip, type TooltipSpec } from './Tooltip';
import './chart.css';

export interface ChartFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The plot element's ref from `useChartSize()`: the frame gives it all the room the legend leaves. */
  plotRef: RefObject<HTMLDivElement | null>;
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
 * plot into the legend's room but never the cell.
 */
export function ChartFrame({ plotRef, legend, tooltip, children, className, ...rest }: ChartFrameProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0, plotLeft: 0, plotTop: 0 });
  const position: LegendPosition = legend && legend.items.length > 0 ? legend.position : 'none';

  // The plot's offset inside the frame (layout px, so zoom-proof), read before paint
  // whenever a tooltip is up: it converts the plot-local anchor to frame-local.
  useLayoutEffect(() => {
    if (!tooltip) return;
    const root = rootRef.current;
    const plot = plotRef.current;
    if (!root || !plot) return;
    const next = { width: root.clientWidth, height: root.clientHeight, plotLeft: plot.offsetLeft, plotTop: plot.offsetTop };
    setFrame((prev) => (prev.width === next.width && prev.height === next.height && prev.plotLeft === next.plotLeft && prev.plotTop === next.plotTop
      ? prev
      : next));
  });

  const legendEl = position !== 'none' && legend ? <Legend items={legend.items} hidden={legend.hidden} onToggle={legend.onToggle} /> : null;
  return (
    <div ref={rootRef} className={className ? `lab-chart ${className}` : 'lab-chart'} data-legend={position} {...rest}>
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
        />
      )}
    </div>
  );
}
