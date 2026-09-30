import type { EndLabels } from './fit';

/**
 * A compact chart's direct end labels (fit.ts `compactEndLabels`): each one a
 * key in the series colour, then the name (secondary) and the last value
 * (strong), in text tokens; "+N" after the last when some did not fit (the
 * tooltip still reads every series). Frame px, drawn in the chart's SVG.
 */
export function EndLabelMarks({ labels }: { labels: EndLabels }) {
  if (labels.placed.length === 0 && labels.more === 0) return null;
  return (
    <g className="lab-chart-end-labels" data-end-labels="" aria-hidden="true" pointerEvents="none">
      {labels.placed.map((l) => (
        <g key={l.id} data-end-label={l.id}>
          {l.shape === 'line'
            ? <line x1={l.x} x2={l.x + 10} y1={l.y} y2={l.y} stroke={l.color} strokeWidth={2} strokeLinecap="round" />
            : <rect x={l.x + 1} y={l.y - 4} width={8} height={8} rx={2} fill={l.color} />}
          <text className="lab-chart-end-label" x={l.x + 14} y={l.y} dy="0.32em">
            {l.shownName && <tspan className="lab-chart-end-name">{l.shownName}</tspan>}
            {l.value && <tspan className="lab-chart-end-value" dx={l.shownName ? '0.3em' : undefined}>{l.value}</tspan>}
          </text>
        </g>
      ))}
      {labels.more > 0 && labels.moreAt && (
        <text className="lab-chart-end-label" data-end-more="" x={labels.moreAt.x} y={labels.moreAt.y} dy="0.32em">
          {`+${labels.more}`}
        </text>
      )}
    </g>
  );
}
