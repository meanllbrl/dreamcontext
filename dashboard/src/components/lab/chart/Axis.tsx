import type { SVGProps } from 'react';
import type { Rect, ResolvedAxis } from './layout';
import { crisp } from './useChartSize';

/** Pixels between the plot edge and a tick label (matches layout.ts' band maths). */
const TICK_GAP = 6;

interface AxisProps {
  orientation: 'x' | 'y';
  /** The resolved axis from `cartesianLayout` (labels already thinned/rotated/clamped). */
  axis: ResolvedAxis;
  plot: Rect;
  /** x axis: draw the baseline rule, at this plot-local y (default: the plot bottom). */
  baseline?: number | null;
  dpr?: number;
}

/**
 * A recessive axis: muted tick labels in text tokens (never a series colour),
 * tabular figures, no tick marks (the grid carries them) and, for x, one
 * hairline baseline. Labels are drawn at real pixels; `cartesianLayout`
 * already guaranteed they neither overlap nor leave the cell.
 */
export function Axis({ orientation, axis, plot, baseline, dpr = 1 }: AxisProps) {
  if (axis.labels.length === 0 && baseline == null) return null;
  if (orientation === 'y') {
    const x = plot.left - TICK_GAP;
    return (
      <g className="lab-chart-axis" data-axis="y" aria-hidden="true">
        {axis.labels.map((l) => (
          <text key={`${l.pos}-${l.label}`} className="lab-chart-tick" x={x} y={plot.top + l.pos} dy="0.32em" textAnchor="end">
            {l.label}
          </text>
        ))}
      </g>
    );
  }
  const top = plot.top + plot.height + TICK_GAP;
  const ruleY = baseline == null ? null : crisp(plot.top + baseline, dpr);
  return (
    <g className="lab-chart-axis" data-axis="x" data-rotated={axis.rotate ? 'true' : 'false'} aria-hidden="true">
      {ruleY !== null && (
        <line className="lab-chart-axis-line" x1={plot.left} x2={plot.left + plot.width} y1={ruleY} y2={ruleY} />
      )}
      {axis.labels.map((l) => {
        const x = plot.left + l.pos + l.dx;
        return axis.rotate ? (
          <text
            key={`${l.pos}-${l.label}`}
            className="lab-chart-tick"
            x={x}
            y={top}
            dy="0.32em"
            textAnchor="end"
            transform={`rotate(-45 ${x} ${top})`}
          >
            {l.label}
          </text>
        ) : (
          <text key={`${l.pos}-${l.label}`} className="lab-chart-tick" x={x} y={top} dy="0.71em" textAnchor="middle">
            {l.label}
          </text>
        );
      })}
    </g>
  );
}

interface GridProps {
  plot: Rect;
  /** Horizontal gridlines at these plot-local y positions (the y axis's ticks). */
  y?: readonly { pos: number }[];
  /** Vertical gridlines at these plot-local x positions (rare: heat or dense time grids). */
  x?: readonly { pos: number }[];
  dpr?: number;
}

/** Solid hairline gridlines one step off the surface. Never dashed, never loud. */
export function Grid({ plot, y = [], x = [], dpr = 1 }: GridProps) {
  if (y.length === 0 && x.length === 0) return null;
  return (
    <g className="lab-chart-grid" aria-hidden="true">
      {y.map((t) => {
        const py = crisp(plot.top + t.pos, dpr);
        return <line key={`y${t.pos}`} x1={plot.left} x2={plot.left + plot.width} y1={py} y2={py} />;
      })}
      {x.map((t) => {
        const px = crisp(plot.left + t.pos, dpr);
        return <line key={`x${t.pos}`} x1={px} x2={px} y1={plot.top} y2={plot.top + plot.height} />;
      })}
    </g>
  );
}

/** The crosshair: a solid hairline at the hovered datum's x (plot-local), full plot height. */
export function Crosshair({ plot, x, dpr = 1 }: { plot: Rect; x: number | null; dpr?: number }) {
  if (x === null) return null;
  const px = crisp(plot.left + x, dpr);
  return <line className="lab-chart-crosshair" data-crosshair="" x1={px} x2={px} y1={plot.top} y2={plot.top + plot.height} />;
}

/**
 * The transparent hit area over exactly the plot. Spread `useChartHover`'s
 * `hitProps` onto it: its bounding box IS the plot, which is what makes the
 * pointer mapping zoom- and width-proof.
 */
export function HitArea({ plot, ...handlers }: { plot: Rect } & Omit<SVGProps<SVGRectElement>, 'x' | 'y' | 'width' | 'height'>) {
  return (
    <rect
      className="lab-chart-hit"
      data-chart-hit=""
      x={plot.left}
      y={plot.top}
      width={Math.max(0, plot.width)}
      height={Math.max(0, plot.height)}
      {...handlers}
    />
  );
}
