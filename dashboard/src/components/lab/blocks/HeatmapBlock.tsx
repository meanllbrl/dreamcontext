import { HeatmapChart, HeatmapMatrix } from '../HeatmapChart';
import { BlockEmpty, drawableFrame, numberOption, type BlockViewProps } from './blockCommon';

/** `heatmap`: intensity across two axes. Series draw the weekday grid; tables a dim-by-dim matrix. `color` picks the tint. */
export function HeatmapBlock({ frame, options }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['table', 'series'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const colorIndex = numberOption(options, 'color', 1, 1, 8);
  const f = drawable.frame;
  return (
    <div className="lab-block-scroll" data-color={colorIndex}>
      {f.kind === 'table'
        ? <HeatmapMatrix dims={f.dims} rows={f.rows} unit={f.unit} colorIndex={colorIndex} />
        : <HeatmapChart series={f.series} unit={f.unit} granularity={f.granularity} colorIndex={colorIndex} />}
    </div>
  );
}
