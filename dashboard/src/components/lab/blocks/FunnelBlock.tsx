import { useI18n } from '../../../context/I18nContext';
import { useMeasured } from '../chartBody';
import { FunnelBars } from '../funnel/FunnelBars';
import { BlockEmpty, boolOption, drawableFrame, type BlockViewProps } from './blockCommon';
import './dataBlocks.css';

/** Natural heights (px, FunnelBars.css / blocks.css) the fit check plans with. */
const ROW_PX = { normal: 22, dense: 18 };
const ROW_GAP_PX = 4;
const NAME_PX = 22;
const SECTION_GAP_PX = 12;
const MORE_PX = 18;

/** The px a list of funnels needs at a density: their rows, row gaps, names (when several) and section gaps. */
export function funnelNaturalHeight(stepCounts: readonly number[], dense: boolean): number {
  const row = dense ? ROW_PX.dense : ROW_PX.normal;
  return stepCounts.reduce((h, n, i) => h
    + (stepCounts.length > 1 ? NAME_PX : 0)
    + n * row + Math.max(0, n - 1) * ROW_GAP_PX
    + (i > 0 ? SECTION_GAP_PX : 0), 0);
}

/**
 * What a funnel block draws in a cell `height` px tall (0 = not measured yet:
 * the options alone decide). `compact` = dense bars and only the first funnel.
 * Otherwise the block goes dense by itself when the funnels would not fit at
 * their natural height, then keeps as many funnels as fit (always the first;
 * its rows shrink to the cell rather than scroll).
 */
export function funnelFit(stepCounts: readonly number[], height: number, compact: boolean): { dense: boolean; auto: boolean; count: number; note: boolean } {
  if (compact) return { dense: true, auto: false, count: Math.min(1, stepCounts.length), note: false };
  if (!(height > 0)) return { dense: false, auto: false, count: stepCounts.length, note: false };
  const auto = funnelNaturalHeight(stepCounts, false) > height;
  let count = stepCounts.length;
  while (count > 1 && funnelNaturalHeight(stepCounts.slice(0, count), auto) + SECTION_GAP_PX + MORE_PX > height) count--;
  // The "+N more" line only where it does not squeeze the bars.
  const note = count < stepCounts.length && funnelNaturalHeight(stepCounts.slice(0, count), auto) + SECTION_GAP_PX + MORE_PX <= height;
  return { dense: auto, auto, count, note };
}

/**
 * `funnel`: step-by-step conversion, one bar list per funnel in the set. It
 * fills its cell and never scrolls: `compact` draws the dense bars and only
 * the first funnel (the card opens the funnel pages for the rest), and a short
 * cell turns compact by itself. The percent beside each count keeps its old
 * meaning (share of the first step); `showConversion` ADDS the step-to-step
 * conversion as a separately labelled marker ("50% of prev. step").
 */
export function FunnelBlock({ frame, options }: BlockViewProps) {
  const { t } = useI18n();
  const [ref, box] = useMeasured<HTMLDivElement>();
  const drawable = drawableFrame(frame, ['funnel'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const compact = boolOption(options, 'compact');
  const showConversion = boolOption(options, 'showConversion', true);
  const all = drawable.frame.funnels;
  if (all.length === 0) return <BlockEmpty />;
  const fit = funnelFit(all.map((f) => f.steps.length), box.height, compact);
  const funnels = all.slice(0, Math.max(1, fit.count));
  const more = fit.note ? all.length - funnels.length : 0;
  const stepLabel = (pct: string) => t('lab.blocks.funnel.ofPrev').replace('{pct}', pct);
  return (
    <div
      ref={ref}
      className="lab-block-funnel lab-block-funnel--fit"
      data-compact={compact ? '' : undefined}
      data-auto-compact={fit.auto ? '' : undefined}
      data-step-conversion={showConversion ? '' : undefined}
    >
      {funnels.map((f) => (
        <section key={f.id} className="lab-block-funnel-item">
          {funnels.length > 1 && <h4 className="lab-block-funnel-name">{f.name}</h4>}
          <FunnelBars steps={f.steps} dense={fit.dense} fill stepLabel={showConversion ? stepLabel : null} />
        </section>
      ))}
      {more > 0 && <div className="lab-block-funnel-more">{t('lab.blocks.funnel.more').replace('{n}', String(more))}</div>}
    </div>
  );
}
