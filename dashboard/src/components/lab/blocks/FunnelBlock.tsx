import { useCallback, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { funnelSlice, selectionKey, stepDrops, type FunnelFrame, type Selection } from '../../../generated/frameOps';
import { useMeasured } from '../chartBody';
import { FunnelBars, type FunnelStepMode } from '../funnel/FunnelBars';
import { FunnelFlow, pctText } from '../funnel/FunnelFlow';
import { FunnelLanes, MAX_DRAWN_LANES } from '../funnel/FunnelLanes';
import { computeStepRows, selectionLabel } from '../funnel/funnelModel';
import { elementFont, textWidth } from '../textMeasure';
import { BlockEmpty, boolOption, drawableFrame, stringOption, type BlockViewProps } from './blockCommon';
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

/** The row grid (FunnelBars.css): label column minmax(72px, 32%), two 8px gaps, and the least track worth drawing. */
const LABEL_MIN_PX = 72;
const LABEL_SHARE = 0.32;
const ROW_GAPS_PX = 16;
const TRACK_MIN_PX = 24;
/** The step marker's margin, arrow and gap (FunnelBars.css .funnel-bars-step). */
const STEP_CHROME_PX = 22;

/** The widths (px) the value column needs: the count and share alone, and with the full and short step marker. */
export interface FunnelValueWidths { value: number; full: number; short: number }

/**
 * How the step-to-step marker fits a row `width` px wide: the labelled
 * sentence when the value column has room for it, else the arrow and percent,
 * else nothing (the row's tooltip still says it). Unmeasured (0) = full.
 */
export function funnelStepMode(width: number, need: FunnelValueWidths): FunnelStepMode | 'none' {
  if (!(width > 0)) return 'full';
  const room = width - Math.max(LABEL_MIN_PX, width * LABEL_SHARE) - ROW_GAPS_PX - TRACK_MIN_PX;
  if (need.value + need.full <= room) return 'full';
  if (need.value + need.short <= room) return 'short';
  return 'none';
}

/**
 * `funnel`: step-by-step conversion, one bar list per funnel in the set. It
 * fills its cell and never scrolls: `compact` draws the dense bars and only
 * the first funnel (the card opens the funnel pages for the rest), and a short
 * cell turns compact by itself. The percent beside each count keeps its old
 * meaning (share of the first step); `showConversion` ADDS the step-to-step
 * conversion as a separately labelled marker ("50% of prev. step"), written
 * short (arrow and percent) or left to the tooltip when the block is narrow.
 */
export function FunnelBlock({ frame, options, selection, lanes }: BlockViewProps) {
  const { t } = useI18n();
  const [measure, box] = useMeasured<HTMLDivElement>();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => { measure(node); setEl(node); }, [measure]);
  const drawable = drawableFrame(frame, ['funnel'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const explorer = explorerView(drawable.frame, options, selection ?? {}, lanes ?? []);
  if (explorer) return <FunnelExplorer frame={drawable.frame} view={explorer} measureRef={measure} box={box} />;
  const compact = boolOption(options, 'compact');
  const showConversion = boolOption(options, 'showConversion', true);
  const all = drawable.frame.funnels;
  if (all.length === 0) return <BlockEmpty />;
  const fit = funnelFit(all.map((f) => f.steps.length), box.height, compact);
  const funnels = all.slice(0, Math.max(1, fit.count));
  const more = fit.note ? all.length - funnels.length : 0;
  const stepLabel = (pct: string) => t('lab.blocks.funnel.ofPrev').replace('{pct}', pct);
  const widths = valueWidths(el, funnels, stepLabel);
  const mode = showConversion ? funnelStepMode(box.width, widths) : 'none';
  // Every row's value column as wide as the widest, so the tracks end together.
  const valueWidth = widths.value > 0 ? widths.value + (mode === 'full' ? widths.full : mode === 'short' ? widths.short : 0) : undefined;
  return (
    <div
      ref={ref}
      className="lab-block-funnel lab-block-funnel--fit"
      data-compact={compact ? '' : undefined}
      data-auto-compact={fit.auto ? '' : undefined}
      data-step-conversion={showConversion ? '' : undefined}
      data-step-mode={showConversion ? mode : undefined}
    >
      {funnels.map((f) => (
        <section key={f.id} className="lab-block-funnel-item">
          {funnels.length > 1 && <h4 className="lab-block-funnel-name">{f.name}</h4>}
          <FunnelBars steps={f.steps} dense={fit.dense} fill stepLabel={mode === 'none' ? null : stepLabel} stepMode={mode === 'none' ? 'full' : mode} valueWidth={valueWidth} />
        </section>
      ))}
      {more > 0 && <div className="lab-block-funnel-more">{t('lab.blocks.funnel.more').replace('{n}', String(more))}</div>}
    </div>
  );
}

/** What the explorer mode draws; null = none of its options or state is in play (today's render, untouched). */
export interface ExplorerView {
  /** The picked funnel id, or null (the first funnel). */
  pick: string | null;
  layout: 'bars' | 'flow';
  markWorst: boolean;
  compact: boolean;
  showConversion: boolean;
  selection: Selection;
  lanes: readonly Selection[];
}

/**
 * The explorer mode switch. The block keeps today's render exactly unless a
 * funnel is picked, the layout is flow, markWorst is on, or the card holds a
 * selection or lanes naming at least one dim the frame declares (a selection
 * on dims this frame lacks changes nothing).
 */
export function explorerView(frame: FunnelFrame, options: Record<string, unknown>, selection: Selection, lanes: readonly Selection[]): ExplorerView | null {
  const pick = stringOption(options, 'funnel');
  const layout = options.layout === 'flow' ? 'flow' : 'bars';
  const markWorst = boolOption(options, 'markWorst');
  const effective = (sel: Selection) => Object.keys(funnelSlice(frame, pick, sel).selection).length > 0;
  const liveLanes = lanes.filter((l) => l && typeof l === 'object').slice(0, MAX_DRAWN_LANES);
  const hasSelection = effective(selection);
  if (pick === null && layout === 'bars' && !markWorst && !hasSelection && liveLanes.length === 0) return null;
  return {
    pick,
    layout,
    markWorst,
    compact: boolOption(options, 'compact'),
    showConversion: boolOption(options, 'showConversion', true),
    selection,
    lanes: liveLanes,
  };
}

/** The px a flow of `n` stages needs before it thins (stage 28, link 22). */
const FLOW_STAGE_PX = 28;
const FLOW_LINK_PX = 22;
/** Below this width the flow's badges drop the lost-users count. */
const FLOW_NARROW_PX = 360;

/**
 * Explorer mode: ONE funnel (the pick, else the first; an unknown pick says so
 * and shows the first) as the card's selection sees it, looked up through
 * funnelSlice so a lookup set is never summed. Pinned lanes draw side by side;
 * an unmeasured slice says "Not measured for {sel}: {reason}" and draws no
 * number. Every script-authored string is rendered as text.
 */
function FunnelExplorer({ frame, view, measureRef, box }: {
  frame: FunnelFrame;
  view: ExplorerView;
  measureRef: (el: HTMLDivElement | null) => void;
  box: { width: number; height: number };
}) {
  const { t } = useI18n();
  const slice = funnelSlice(frame, view.pick, view.selection);
  const funnel = frame.funnels.find((f) => f.id === slice.funnelId) ?? frame.funnels[0];
  if (!funnel) return <BlockEmpty />;
  const dims = frame.dimensions ?? [];
  const nameOf = (sel: Selection) => selectionLabel(sel, dims) ?? t('lab.blocks.breakdown.all');
  const notes: { key: string; text: string; tone?: 'caution'; attr: Record<string, string> }[] = [];
  if (view.pick !== null && view.pick !== slice.funnelId) {
    notes.push({
      key: 'unknown',
      text: t('lab.blocks.explorer.unknownFunnel').replace('{id}', view.pick).replace('{name}', slice.funnelName),
      tone: 'caution',
      attr: { 'data-lab-unknown-funnel': view.pick },
    });
  }
  const dense = view.compact || (box.height > 0 && box.height < 240);
  let body: ReactNode;
  if (view.lanes.length > 0) {
    const laneInputs = view.lanes.map((sel) => {
      const s = funnelSlice(frame, slice.funnelId, sel);
      return { slice: s, label: nameOf(s.selection) };
    });
    body = <FunnelLanes lanes={laneInputs} base={funnel.steps} markWorst={view.markWorst} dense={dense} />;
  } else if (!slice.measured) {
    body = (
      <div className="funnel-explorer-unmeasured" data-lab-not-measured={nameOf(slice.selection)} role="note">
        {t('lab.blocks.explorer.notMeasured').replace('{sel}', nameOf(slice.selection)).replace('{reason}', slice.reason ?? t('lab.blocks.breakdown.noPath'))}
      </div>
    );
  } else {
    if (slice.lowSample && Object.keys(slice.selection).length > 0) {
      notes.push({
        key: 'low',
        text: t('lab.blocks.explorer.lowSample').replace('{n}', slice.users.toLocaleString('en-US')),
        tone: 'caution',
        attr: { 'data-lab-low-sample': String(slice.users) },
      });
    }
    const n = slice.steps.length;
    if (view.layout === 'flow') {
      const flowDense = dense || (box.height > 0 && box.height < n * FLOW_STAGE_PX + Math.max(0, n - 1) * FLOW_LINK_PX);
      body = <FunnelFlow steps={slice.steps} markWorst={view.markWorst} dense={flowDense} narrow={box.width > 0 && box.width < FLOW_NARROW_PX} />;
    } else {
      const fit = funnelFit([n], box.height, view.compact);
      const stepLabel = (pct: string) => t('lab.blocks.funnel.ofPrev').replace('{pct}', pct);
      const mode = view.showConversion ? (box.width > 0 && box.width < FLOW_NARROW_PX ? 'short' : 'full') : null;
      const worst = view.markWorst ? stepDrops(slice.steps).find((d) => d.worst) ?? null : null;
      const prevLabel = worst ? slice.steps[slice.steps.findIndex((s) => s.key === worst.key) - 1]?.label ?? '' : '';
      body = (
        <>
          {worst && worst.dropPct !== null && (
            <div
              className="funnel-explorer-worst"
              data-lab-worst={worst.key}
              data-drop-pct={worst.dropPct.toFixed(1)}
              title={`${t('lab.blocks.funnel.worst')}: ${prevLabel} → ${worst.label}, ${t('lab.blocks.funnel.drop').replace('{pct}', pctText(worst.dropPct))}`}
            >
              <span className="funnel-explorer-worst-tag">{t('lab.blocks.funnel.worst')}</span>
              <span className="funnel-explorer-worst-step">{prevLabel} → {worst.label}</span>
              <span className="funnel-explorer-worst-pct">{t('lab.blocks.funnel.drop').replace('{pct}', pctText(worst.dropPct))}</span>
            </div>
          )}
          <FunnelBars steps={slice.steps} dense={fit.dense} fill stepLabel={mode === null ? null : stepLabel} stepMode={mode ?? 'full'} />
        </>
      );
    }
  }
  return (
    <div
      ref={measureRef}
      className="lab-block-funnel funnel-explorer"
      data-lab-funnel-explorer={view.layout}
      data-lab-funnel={slice.funnelId}
      data-lab-selection={selectionKey(slice.selection) || undefined}
      data-lab-measured={slice.measured ? 'true' : 'false'}
    >
      {notes.map((n) => (
        <div key={n.key} className="funnel-explorer-note" data-tone={n.tone} title={n.text} {...n.attr}>{n.text}</div>
      ))}
      <div className="funnel-explorer-body">{body}</div>
    </div>
  );
}

/** The value column's widths in the block's rendered font (as FunnelBars writes the texts); zero until mounted. */
function valueWidths(
  el: HTMLElement | null,
  funnels: readonly { steps: { key: string; label: string; users: number }[] }[],
  stepLabel: (pct: string) => string,
): FunnelValueWidths {
  const probe = el?.querySelector('.funnel-bars-value');
  if (!probe) return { value: 0, full: 0, short: 0 };
  const font = elementFont(probe);
  const w = (s: string) => textWidth(s, font);
  const pct = (v: number) => `${v.toFixed(v >= 10 ? 0 : 1)}%`;
  let value = 0;
  let full = 0;
  let short = 0;
  for (const f of funnels) {
    for (const row of computeStepRows(f.steps)) {
      value = Math.max(value, w(`${row.users.toLocaleString('en-US')}${row.ofTop !== null ? ` · ${pct(row.ofTop)}` : ''}`));
      const p = pct(row.ofPrev ?? 100);
      full = Math.max(full, STEP_CHROME_PX + w(stepLabel(p)));
      short = Math.max(short, STEP_CHROME_PX + w(p));
    }
  }
  // A little air so rounding never tips a fit into a clip.
  return { value: Math.ceil(value) + 4, full: Math.ceil(full), short: Math.ceil(short) };
}
