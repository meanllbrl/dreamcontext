import { Fragment, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useMeasured } from '../chartBody';
import { stepDrops, type StepDrop } from '../../../generated/frameOps';
import { fmtCount, fmtDrop, fmtPercent } from '../explorer/explorerFormat';
import type { FunnelBarStep } from './FunnelBars';
import { dropSeverity } from './funnelModel';
import './FunnelBars.css';
import './FunnelFlow.css';

/**
 * `46%` / `4.5%`: whole percents from 10 up, one decimal below, in the reader's number format
 * (TR "%46" / "%4,5"). Without a locale it is the original English form.
 */
export function pctText(v: number, locale = 'en'): string {
  const a = Math.abs(v);
  return fmtPercent(a, locale, a >= 10 ? 0 : 1);
}

/** A drop badge's short text: `▼ 46%` for a loss, `▲ 12%` when users grew, a dash when no rate exists. */
export function dropBadgeText(d: Pick<StepDrop, 'dropPct'>, locale = 'en'): string {
  if (d.dropPct === null) return '—';
  return `${d.dropPct < 0 ? '▲' : '▼'} ${pctText(d.dropPct, locale)}`;
}

/** A stage's width, % of the widest stage: users over the max, exactly (the verify run measures it within 1%). */
export function stageWidthPct(users: number, max: number): number {
  return max > 0 ? Math.max(0, Math.min(100, (users / max) * 100)) : 0;
}

/** Heights (px, FunnelFlow.css): a full stage row and link row, and the compact one-line step row. */
export const FLOW_PX = { stage: 24, link: 22, line: 16, tight: 12 } as const;

/**
 * Which flow a cell `height` px tall draws for `n` stages (0 = not measured
 * yet: full). Full = a stage row per step with a link row (the drop badge)
 * between; compact = one line per step (label, stage shape, users, the drop
 * into it), so labels and users stay readable in a small cell.
 */
export function flowMode(n: number, height: number): 'full' | 'compact' {
  if (!(height > 0)) return 'full';
  return height >= n * FLOW_PX.stage + Math.max(0, n - 1) * FLOW_PX.link ? 'full' : 'compact';
}

/** A compact flow whose 16px lines do not all fit tightens to 12px lines (the 12px type, no leading). */
export function flowTight(n: number, height: number): boolean {
  return height > 0 && height < n * FLOW_PX.line;
}

/** A flow longer than this collapses its middle run behind one "N more steps" row. */
export const FLOW_COLLAPSE_AT = 16;
/** Steps a collapsed flow keeps at each end. */
export const FLOW_KEEP = 6;

export type FlowItem = { kind: 'step'; index: number } | { kind: 'more'; from: number; to: number; count: number };

/**
 * What a flow of `n` steps draws: every step, or (over FLOW_COLLAPSE_AT and not expanded) the
 * first and last FLOW_KEEP steps plus the `keep` indexes (the worst drop and the step before
 * it), each hidden run replaced by one `more` item that names how many steps it holds. A
 * 25-step quiz reads as its shape, not as a 5000px column.
 */
export function flowItems(n: number, keep: readonly number[], expanded: boolean): FlowItem[] {
  if (expanded || n <= FLOW_COLLAPSE_AT) return Array.from({ length: n }, (_, index) => ({ kind: 'step', index }));
  const shown = new Set<number>();
  for (let i = 0; i < Math.min(FLOW_KEEP, n); i++) shown.add(i);
  for (let i = Math.max(0, n - FLOW_KEEP); i < n; i++) shown.add(i);
  for (const k of keep) if (Number.isInteger(k) && k >= 0 && k < n) shown.add(k);
  const out: FlowItem[] = [];
  let gap = -1;
  for (let i = 0; i < n; i++) {
    if (shown.has(i)) {
      if (gap !== -1) {
        out.push({ kind: 'more', from: gap, to: i - 1, count: i - gap });
        gap = -1;
      }
      out.push({ kind: 'step', index: i });
    } else if (gap === -1) gap = i;
  }
  if (gap !== -1) out.push({ kind: 'more', from: gap, to: n - 1, count: n - gap });
  return out;
}

/**
 * The funnel as a flow: one centred stage per step whose width is proportional
 * to its users, and between every two stages a link row with the drop badge
 * (share lost, users lost). `markWorst` washes the link with the largest drop
 * (stepDrops decides; ties to the first) and names it. A short cell draws the
 * compact form: one line per step with its drop badge inline, never a stage
 * row squeezed to nothing. `narrow` drops the lost-users count. Nothing
 * scrolls. Step labels are script-authored and render as text only.
 */
export function FunnelFlow({ steps, markWorst = false, dense = false, narrow = false }: {
  steps: readonly FunnelBarStep[];
  markWorst?: boolean;
  dense?: boolean;
  narrow?: boolean;
}) {
  const { t, locale } = useI18n();
  const [measure, box] = useMeasured<HTMLDivElement>();
  const [expanded, setExpanded] = useState(false);
  const drops = stepDrops(steps);
  if (drops.length === 0) return null;
  const max = Math.max(0, ...drops.filter((d) => d.measured).map((d) => d.users));
  const worstAt = drops.findIndex((d) => d.worst);
  const items = flowItems(drops.length, markWorst && worstAt > 0 ? [worstAt - 1, worstAt] : [], expanded);
  const mode = flowMode(items.length, box.height);
  const compact = mode === 'compact';
  const tight = compact && flowTight(items.length, box.height);
  const rows = compact
    ? items.map(() => `minmax(${tight ? FLOW_PX.tight : FLOW_PX.line}px, 1fr)`)
    : items.flatMap((it, n) => (it.kind === 'more'
      ? ['auto']
      : n === 0 ? [`minmax(${FLOW_PX.line}px, 1fr)`] : ['auto', `minmax(${FLOW_PX.line}px, 1fr)`]));
  const reasonOf = (key: string) => steps.find((s) => s.key === key)?.reason ?? null;
  return (
    <div
      ref={measure}
      className="funnel-flow"
      data-lab-flow=""
      data-flow-mode={mode}
      data-flow-tight={tight ? '' : undefined}
      data-dense={dense ? '' : undefined}
      data-narrow={narrow ? '' : undefined}
      style={{ gridTemplateRows: rows.join(' ') }}
    >
      {items.map((it, n) => {
        if (it.kind === 'more') {
          const text = t('lab.explorer.flowMore').replace('{n}', String(it.count));
          return (
            <button
              key={`more-${it.from}`}
              type="button"
              className="funnel-flow-more"
              data-lab-flow-more={it.count}
              title={`${drops[it.from].label} … ${drops[it.to].label}`}
              onClick={() => setExpanded(true)}
            >
              {text}
            </button>
          );
        }
        const i = it.index;
        const d = drops[i];
        const worst = markWorst && d.worst;
        // Users lost into this step, from the last MEASURED step before it (an unmeasured one is skipped).
        const lost = d.measured && d.prevUsers !== null ? d.prevUsers - d.users : 0;
        const unmeasuredText = d.measured ? null : t('lab.explorer.notMeasuredWhy').replace('{reason}', reasonOf(d.key) ?? t('lab.blocks.breakdown.noPath'));
        const derived = d.basis === 'derived' ? (
          <span className="funnel-flow-derived" data-lab-derived="" title={t('lab.explorer.derivedTitle')}>{t('lab.explorer.derived')}</span>
        ) : null;
        const dropSentence = d.dropPct === null ? null : fmtDrop(d.dropPct, locale);
        // One decimal for every share of the first step, so the column reads in one rhythm.
        const ofTop = d.ofTop === null ? '' : ` · ${fmtPercent(d.ofTop, locale, 1)}`;
        const prevLabel = drops.slice(0, i).reverse().find((x) => x.measured)?.label ?? drops[i - 1]?.label ?? '';
        const link = i > 0 && n > 0 && d.measured && (
          <div
            className={compact ? 'funnel-flow-link funnel-flow-link--inline' : 'funnel-flow-link'}
            data-lab-drop={d.key}
            data-drop-pct={d.dropPct === null ? undefined : d.dropPct.toFixed(1)}
            data-severity={dropSeverity(d.ofPrev)}
            data-lab-worst={worst ? d.key : undefined}
            title={`${prevLabel} → ${d.label}${dropSentence ? `: ${dropSentence}` : ''}${d.dropPct !== null && lost !== 0 ? ` (${lost > 0 ? '−' : '+'}${fmtCount(Math.abs(lost), locale)})` : ''}${worst ? ` · ${t('lab.blocks.funnel.worst')}` : ''}`}
          >
            {!compact && <span className="funnel-flow-link-rail" aria-hidden="true" />}
            {/* The worst word rides INSIDE the badge, in the wide track column: it can never be cut at the card's edge. */}
            <span className="funnel-flow-badge">
              <span className="funnel-flow-badge-pct">{dropBadgeText(d, locale)}</span>
              {!narrow && !compact && d.dropPct !== null && lost !== 0 && (
                <span className="funnel-flow-badge-lost">{lost > 0 ? '−' : '+'}{fmtCount(Math.abs(lost), locale)}</span>
              )}
              {worst && <span className="funnel-flow-worst">{t('lab.blocks.funnel.worst')}</span>}
            </span>
          </div>
        );
        return (
          <Fragment key={d.key}>
            {!compact && link}
            <div
              className="funnel-flow-stage"
              data-lab-flow-stage={d.key}
              data-users={d.measured ? d.users : undefined}
              data-measured={d.measured ? undefined : 'false'}
              data-basis={d.basis === 'derived' ? 'derived' : undefined}
              data-worst={compact && worst ? '' : undefined}
              title={unmeasuredText ? `${d.label}: ${unmeasuredText}` : `${d.label}: ${fmtCount(d.users, locale)}${ofTop}`}
            >
              <span className="funnel-flow-label">{d.label}{derived}</span>
              <span className="funnel-flow-track">
                {d.measured && <span className="funnel-flow-shape" style={{ width: `${stageWidthPct(d.users, max)}%` }} />}
              </span>
              {unmeasuredText ? (
                <span className="funnel-flow-value funnel-flow-unmeasured" data-lab-not-measured={d.key}>{t('lab.explorer.notMeasured')}</span>
              ) : (
                <span className="funnel-flow-value">
                  {fmtCount(d.users, locale)}
                  {ofTop && <span className="funnel-flow-pct">{ofTop}</span>}
                </span>
              )}
              {compact && (link || <span className="funnel-flow-link funnel-flow-link--inline funnel-flow-link--none" aria-hidden="true" />)}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
