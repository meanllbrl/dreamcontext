import { Fragment } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useMeasured } from '../chartBody';
import { stepDrops, type StepDrop } from '../../../generated/frameOps';
import { dropSeverity } from './funnelModel';
import './FunnelFlow.css';

/** `46%` / `4.5%`: whole percents from 10 up, one decimal below. */
export function pctText(v: number): string {
  const a = Math.abs(v);
  return `${a.toFixed(a >= 10 ? 0 : 1)}%`;
}

/** A drop badge's short text: `▼ 46%` for a loss, `▲ 12%` when users grew, a dash when no rate exists. */
export function dropBadgeText(d: Pick<StepDrop, 'dropPct'>): string {
  if (d.dropPct === null) return '—';
  return `${d.dropPct < 0 ? '▲' : '▼'} ${pctText(d.dropPct)}`;
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
  steps: readonly { key: string; label: string; users: number }[];
  markWorst?: boolean;
  dense?: boolean;
  narrow?: boolean;
}) {
  const { t } = useI18n();
  const [measure, box] = useMeasured<HTMLDivElement>();
  const drops = stepDrops(steps);
  if (drops.length === 0) return null;
  const max = Math.max(0, ...drops.map((d) => d.users));
  const mode = flowMode(drops.length, box.height);
  const compact = mode === 'compact';
  const tight = compact && flowTight(drops.length, box.height);
  const rows = compact
    ? drops.map(() => `minmax(${tight ? FLOW_PX.tight : FLOW_PX.line}px, 1fr)`)
    : drops.flatMap((_, i) => (i === 0 ? [`minmax(${FLOW_PX.line}px, 1fr)`] : ['auto', `minmax(${FLOW_PX.line}px, 1fr)`]));
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
      {drops.map((d, i) => {
        const worst = markWorst && d.worst;
        const lost = i > 0 ? drops[i - 1].users - d.users : 0;
        const dropSentence = d.dropPct === null ? null : t('lab.blocks.funnel.drop').replace('{pct}', `${d.dropPct < 0 ? '-' : ''}${pctText(d.dropPct)}`);
        const ofTop = d.ofTop === null ? '' : ` · ${pctText(d.ofTop)}`;
        const link = i > 0 && (
          <div
            className={compact ? 'funnel-flow-link funnel-flow-link--inline' : 'funnel-flow-link'}
            data-lab-drop={d.key}
            data-drop-pct={d.dropPct === null ? undefined : d.dropPct.toFixed(1)}
            data-severity={dropSeverity(d.ofPrev)}
            data-lab-worst={worst ? d.key : undefined}
            title={`${drops[i - 1].label} → ${d.label}${dropSentence ? `: ${dropSentence}` : ''}${d.dropPct !== null ? ` (${lost > 0 ? '−' : '+'}${Math.abs(lost).toLocaleString('en-US')})` : ''}`}
          >
            {!compact && <span className="funnel-flow-link-rail" aria-hidden="true" />}
            <span className="funnel-flow-badge">
              <span className="funnel-flow-badge-pct">{dropBadgeText(d)}</span>
              {!narrow && !compact && d.dropPct !== null && lost !== 0 && (
                <span className="funnel-flow-badge-lost">{lost > 0 ? '−' : '+'}{Math.abs(lost).toLocaleString('en-US')}</span>
              )}
            </span>
            <span className="funnel-flow-worst">{worst ? t('lab.blocks.funnel.worst') : ''}</span>
          </div>
        );
        return (
          <Fragment key={d.key}>
            {!compact && link}
            <div
              className="funnel-flow-stage"
              data-lab-flow-stage={d.key}
              data-users={d.users}
              data-worst={compact && worst ? '' : undefined}
              title={`${d.label}: ${d.users.toLocaleString('en-US')}${ofTop}`}
            >
              <span className="funnel-flow-label">{d.label}</span>
              <span className="funnel-flow-track">
                <span className="funnel-flow-shape" style={{ width: `${stageWidthPct(d.users, max)}%` }} />
              </span>
              <span className="funnel-flow-value">
                {d.users.toLocaleString('en-US')}
                {ofTop && <span className="funnel-flow-pct">{ofTop}</span>}
              </span>
              {compact && (link || <span className="funnel-flow-link funnel-flow-link--inline funnel-flow-link--none" aria-hidden="true" />)}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
