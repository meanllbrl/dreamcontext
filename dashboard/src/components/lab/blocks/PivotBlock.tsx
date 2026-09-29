import { PivotBody } from '../BreakdownPivot';
import { BlockEmpty, drawableFrame, stringOption, type BlockViewProps } from './blockCommon';
import { frameToMatrixSet } from './frameAdapters';

/** `pivot`: one dim down (`rows`), another across (`cols`), the dataset fed straight to the breakdown view. */
export function PivotBlock({ frame, options, full }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['table'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  return (
    <div className="lab-block-scroll">
      <PivotBody
        set={frameToMatrixSet(drawable.frame)}
        unit={drawable.frame.unit}
        rows={stringOption(options, 'rows')}
        cols={stringOption(options, 'cols')}
        full={full}
      />
    </div>
  );
}
