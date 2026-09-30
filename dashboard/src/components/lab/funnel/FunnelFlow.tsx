import { Fragment } from 'react';
import { useI18n } from '../../../context/I18nContext';
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

/**
 * The funnel as a flow: one centred stage per step whose width is proportional
 * to its users, and between every two stages a link row with the drop badge
 * (share lost, users lost). `markWorst` washes the link with the largest drop
 * (stepDrops decides; ties to the first) and names it. `dense` thins the rows
 * for a short cell, `narrow` drops the lost-users count: nothing scrolls.
 * Step labels are script-authored and render as text only.
 */
export function FunnelFlow({ steps, markWorst = false, dense = false, narrow = false }: {
  steps: readonly { key: string; label: string; users: number }[];
  markWorst?: boolean;
  dense?: boolean;
  narrow?: boolean;
}) {
  const { t } = useI18n();
  const drops = stepDrops(steps);
  if (drops.length === 0) return null;
  const max = Math.max(0, ...drops.map((d) => d.users));
  const rows = drops.flatMap((_, i) => (i === 0 ? ['stage'] : ['link', 'stage']));
  return (
    <div
      className="funnel-flow"
      data-lab-flow=""
      data-dense={dense ? '' : undefined}
      data-narrow={narrow ? '' : undefined}
      style={{ gridTemplateRows: rows.map((r) => (r === 'stage' ? 'minmax(0, 1fr)' : 'minmax(0, auto)')).join(' ') }}
    >
      {drops.map((d, i) => {
        const worst = markWorst && d.worst;
        const lost = i > 0 ? drops[i - 1].users - d.users : 0;
        const dropSentence = d.dropPct === null ? null : t('lab.blocks.funnel.drop').replace('{pct}', `${d.dropPct < 0 ? '-' : ''}${pctText(d.dropPct)}`);
        const ofTop = d.ofTop === null ? '' : ` · ${pctText(d.ofTop)}`;
        return (
          <Fragment key={d.key}>
            {i > 0 && (
              <div
                className="funnel-flow-link"
                data-lab-drop={d.key}
                data-drop-pct={d.dropPct === null ? undefined : d.dropPct.toFixed(1)}
                data-severity={dropSeverity(d.ofPrev)}
                data-lab-worst={worst ? d.key : undefined}
                title={`${drops[i - 1].label} → ${d.label}${dropSentence ? `: ${dropSentence}` : ''}${d.dropPct !== null ? ` (${lost > 0 ? '−' : '+'}${Math.abs(lost).toLocaleString('en-US')})` : ''}`}
              >
                <span className="funnel-flow-link-rail" aria-hidden="true" />
                <span className="funnel-flow-badge">
                  <span className="funnel-flow-badge-pct">{dropBadgeText(d)}</span>
                  {!narrow && d.dropPct !== null && lost !== 0 && (
                    <span className="funnel-flow-badge-lost">{lost > 0 ? '−' : '+'}{Math.abs(lost).toLocaleString('en-US')}</span>
                  )}
                </span>
                <span className="funnel-flow-worst">{worst ? t('lab.blocks.funnel.worst') : ''}</span>
              </div>
            )}
            <div
              className="funnel-flow-stage"
              data-lab-flow-stage={d.key}
              data-users={d.users}
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
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
