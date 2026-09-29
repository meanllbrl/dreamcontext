import { PieChart } from '../PieChart';
import { BlockEmpty, boolOption, drawableFrame, useBlockSize, type BlockViewProps } from './blockCommon';
import { frameToBarRows } from './frameAdapters';

/**
 * `pie`: shares of a total, `donut` draws a ring. Seven or more slices still
 * degrade to the bar list (PieChart's own rule, kept).
 */
export function PieBlock({ frame, options }: BlockViewProps) {
  const [ref, size] = useBlockSize();
  const drawable = drawableFrame(frame, ['table', 'series'] as const);
  // PieChart ranks single-point series by value; each share row becomes one.
  const series = 'frame' in drawable
    ? frameToBarRows(drawable.frame).map((r) => ({ name: r.name, points: [{ t: '', v: r.value }] }))
    : [];
  const pieSize = size.height > 0 ? Math.max(96, Math.min(240, Math.floor(size.height - 40))) : 140;
  return (
    <div ref={ref} className="lab-block-fill">
      {'empty' in drawable ? <BlockEmpty reason={drawable.empty} /> : (
        <PieChart series={series} unit={drawable.frame.unit} size={pieSize} donut={boolOption(options, 'donut')} full />
      )}
    </div>
  );
}
