import { PivotBody } from '../BreakdownPivot';
import { BlockEmpty, drawableFrame, stringOption, type BlockViewProps } from './blockCommon';
import { frameToMatrixSet } from './frameAdapters';
import './dataBlocks.css';

/**
 * `pivot`: one dim down (`rows`), another across (`cols`), the dataset fed straight to
 * the breakdown view. It fills its cell: the filter chips and the total stay put and
 * only the table scrolls, with its header stuck to the top of that scroll box.
 */
export function PivotBlock({ frame, options, full }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['table'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  return (
    <div className="lab-block-pivot">
      <PivotBody
        set={frameToMatrixSet(drawable.frame)}
        unit={drawable.frame.unit}
        rows={stringOption(options, 'rows')}
        cols={stringOption(options, 'cols')}
        full={full}
        fit
      />
    </div>
  );
}
