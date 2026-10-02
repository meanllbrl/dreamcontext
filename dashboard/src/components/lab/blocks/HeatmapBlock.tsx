import { HeatmapChart, HeatmapMatrix, toHeatScale } from '../HeatmapChart';
import { toChartFormat } from '../chart';
import { BlockEmpty, boolOption, drawableFrame, numberOption, type BlockViewProps } from './blockCommon';

/**
 * `heatmap`: intensity across two axes. Series draw the weekday grid; tables a
 * dim-by-dim matrix. Every option passes through: `scale` (sequential, or
 * diverging around a neutral zero), `cellLabels`, `color` (slot 1 = the
 * validated blue ramp, other slots a ramp of that hue), `format`. The chart
 * fills the cell and never scrolls.
 */
export function HeatmapBlock({ frame, options }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['table', 'series'] as const);
  const opts = {
    colorIndex: numberOption(options, 'color', 1, 1, 8),
    scale: toHeatScale(options.scale),
    cellLabels: boolOption(options, 'cellLabels'),
    format: toChartFormat(options.format),
  };
  let body;
  if ('empty' in drawable) {
    body = <BlockEmpty reason={drawable.empty} />;
  } else {
    const f = drawable.frame;
    body = f.kind === 'table'
      ? <HeatmapMatrix dims={f.dims} rows={f.rows} unit={f.unit} {...opts} />
      : <HeatmapChart series={f.series} unit={f.unit} granularity={f.granularity} {...opts} />;
  }
  return (
    <div className="lab-block-fill lab-chart-cell" data-color={opts.colorIndex} data-scale={opts.scale}>
      {body}
    </div>
  );
}
