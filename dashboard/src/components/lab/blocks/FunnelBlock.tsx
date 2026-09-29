import { FunnelBars } from '../funnel/FunnelBars';
import { BlockEmpty, boolOption, drawableFrame, type BlockViewProps } from './blockCommon';

/**
 * `funnel`: step-by-step conversion, one bar list per funnel in the set.
 * `compact` draws the dense bars and only the first funnel; the card opens
 * the funnel pages for the rest.
 */
export function FunnelBlock({ frame, options }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['funnel'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const compact = boolOption(options, 'compact');
  const funnels = compact ? drawable.frame.funnels.slice(0, 1) : drawable.frame.funnels;
  if (funnels.length === 0) return <BlockEmpty />;
  return (
    <div className="lab-block-scroll lab-block-funnel" data-compact={compact ? '' : undefined}>
      {funnels.map((f) => (
        <section key={f.id} className="lab-block-funnel-item">
          {funnels.length > 1 && <h4 className="lab-block-funnel-name">{f.name}</h4>}
          <FunnelBars steps={f.steps} dense={compact} />
        </section>
      ))}
    </div>
  );
}
