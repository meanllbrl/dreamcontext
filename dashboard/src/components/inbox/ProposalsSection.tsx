import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import {
  useAcceptProposal,
  useAnswerChange,
  useKeepFiled,
  useRejectItem,
  useRevertRule,
  useTaskProposals,
  type ChangeSuggestion,
  type FeedbackReason,
  type FiledBySleep,
  type FilingBasis,
  type ProposalsPayload,
  type RuleChangeRow,
  type TaskProposal,
  type WeekTrend,
} from '../../hooks/useTaskProposals';
import './ProposalsSection.css';

/**
 * The Proposals section of the Inbox (owner decision 8; it moved off the Tasks board in
 * plan r3 § 5d, with its accept and reject unchanged).
 *
 * Sleep files a new top-level task only on the owner's ask or a proven defect;
 * everything else it would have filed waits here, and so does every task it did
 * open itself ("opened by sleep"). Accept is one tap (the task lands in Next),
 * reject is one tap on a reason chip (with an optional note first), and an
 * edit before accepting is recorded as feedback. Below the cards: how often the
 * owner kept sleep's work week by week, and the task-filing rules it learned
 * from the rejects, each revertible in one tap.
 *
 * The task migration's uncertain reorganisations (merge, cancel, under a parent,
 * Later) wait here too, as change cards: apply, or keep the task as it is.
 *
 * Renders nothing until sleep has proposed, filed or learned anything, so a
 * project that never sleeps keeps a clean board.
 */

const COLLAPSE_KEY = 'dc.tasks.proposals.collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

export function ProposalsSection() {
  const { t } = useI18n();
  const { data } = useTaskProposals();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  if (!data) return null;
  // Counted from the cards themselves, so the header can never promise a card it does not draw.
  const changes = data.changes ?? [];
  const waiting = data.proposals.length + data.filed.length + changes.length;
  const hasVerdicts = data.trend.some((w) => w.kept + w.rejected > 0);
  if (waiting === 0 && !hasVerdicts && data.rules.length === 0) return null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* private mode: not remembered */ }
  };
  const thisWeek = data.trend[data.trend.length - 1];

  return (
    <section className="tp-section" aria-labelledby="tp-title">
      <header className="tp-head">
        <button type="button" className="tp-toggle" onClick={toggle} aria-expanded={!collapsed} aria-controls="tp-body">
          <span className={`tp-chevron${collapsed ? '' : ' tp-chevron--open'}`} aria-hidden="true">›</span>
          <span id="tp-title" className="tp-title">{t('proposals.title')}</span>
          {waiting > 0 && <span className="tp-count">{waiting}</span>}
        </button>
        <span className="tp-summary">
          {waiting > 0 ? t('proposals.waiting').replace('{n}', String(waiting)) : t('proposals.nothingWaiting')}
          {thisWeek && thisWeek.rate !== null && (
            <> · {t('proposals.keptThisWeek').replace('{pct}', String(Math.round(thisWeek.rate * 100)))}</>
          )}
        </span>
        {!data.brake.open && (
          <span className="tp-brake" title={t('proposals.brakeHint')}>{t('proposals.brakeOff')}</span>
        )}
        <TrendBars trend={data.trend} />
      </header>

      {!collapsed && (
        <div id="tp-body" className="tp-body">
          {waiting === 0 ? (
            <p className="tp-empty">{t('proposals.empty')}</p>
          ) : (
            <ul className="tp-grid">
              {data.proposals.map((p) => (
                <li key={p.id}><ProposalCard proposal={p} reasons={data.reasons} /></li>
              ))}
              {data.filed.map((f) => (
                <li key={f.slug}><FiledCard task={f} reasons={data.reasons} /></li>
              ))}
              {changes.map((c) => (
                <li key={c.id}><ChangeCard suggestion={c} /></li>
              ))}
            </ul>
          )}
          <RulesStrip rules={data.rules} ruleCount={data.ruleCount} />
        </div>
      )}
    </section>
  );
}

// ─── Cards ───────────────────────────────────────────────────────────────────

function BasisChip({ basis }: { basis: FilingBasis }) {
  const { t } = useI18n();
  return <span className={`tp-chip tp-chip--${basis}`}>{t(`proposals.basis.${basis}`)}</span>;
}

function CardBody({ name, why, quote, parentName }: { name: string; why: string; quote: string; parentName: string | null }) {
  const { t } = useI18n();
  return (
    <>
      <h3 className="tp-name">{name}</h3>
      <p className="tp-why">{why}</p>
      {quote && (
        <blockquote className="tp-quote">
          <span className="tp-quote-label">{t('proposals.fromSession')}</span>
          “{quote}”
        </blockquote>
      )}
      {parentName && <p className="tp-parent">↳ {t('proposals.under').replace('{parent}', parentName)}</p>}
    </>
  );
}

function ProposalCard({ proposal, reasons }: { proposal: TaskProposal; reasons: ProposalsPayload['reasons'] }) {
  const { t } = useI18n();
  const accept = useAcceptProposal();
  const reject = useRejectItem();
  const [mode, setMode] = useState<'idle' | 'edit' | 'reject'>('idle');
  const [name, setName] = useState(proposal.name);
  const [why, setWhy] = useState(proposal.why);
  const [underParent, setUnderParent] = useState(true);
  const busy = accept.isPending || reject.isPending;
  const failed = accept.error ?? reject.error;

  const doAccept = (edited: boolean) => accept.mutate({
    id: proposal.id,
    ...(edited && name.trim() !== proposal.name ? { name: name.trim() } : {}),
    ...(edited && why.trim() !== proposal.why ? { why: why.trim() } : {}),
    ...(edited && proposal.parent && !underParent ? { parent: null } : {}),
  });

  return (
    <article className="tp-card" aria-busy={busy}>
      <div className="tp-labels">
        <span className="tp-chip tp-chip--proposal">{t('proposals.label.proposal')}</span>
        <BasisChip basis={proposal.basis} />
      </div>
      {mode === 'edit' ? (
        <div className="tp-edit">
          <label className="tp-field">
            <span>{t('proposals.edit.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </label>
          <label className="tp-field">
            <span>{t('proposals.edit.why')}</span>
            <textarea value={why} rows={4} onChange={(e) => setWhy(e.target.value)} disabled={busy} />
          </label>
          {proposal.parentName && (
            <label className="tp-check">
              <input type="checkbox" checked={underParent} onChange={(e) => setUnderParent(e.target.checked)} disabled={busy} />
              {t('proposals.under').replace('{parent}', proposal.parentName)}
            </label>
          )}
          <div className="tp-actions">
            <button type="button" className="btn btn--primary btn--sm" disabled={busy || !name.trim() || !why.trim()} onClick={() => doAccept(true)}>
              {t('proposals.acceptEdited')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setMode('idle')}>{t('proposals.cancel')}</button>
          </div>
        </div>
      ) : (
        <CardBody name={proposal.name} why={proposal.why} quote={proposal.quote} parentName={proposal.parentName} />
      )}
      {mode === 'reject' && (
        <RejectPanel reasons={reasons} busy={busy} onCancel={() => setMode('idle')}
          onReject={(reason, note) => reject.mutate({ id: proposal.id, filed: false, reason, note })} />
      )}
      {mode === 'idle' && (
        <div className="tp-actions">
          <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => doAccept(false)}>{t('proposals.accept')}</button>
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => setMode('edit')}>{t('proposals.edit')}</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setMode('reject')}>{t('proposals.reject')}</button>
        </div>
      )}
      {failed && <p className="tp-error" role="alert">{(failed as Error).message || t('proposals.failed')}</p>}
    </article>
  );
}

function FiledCard({ task, reasons }: { task: FiledBySleep; reasons: ProposalsPayload['reasons'] }) {
  const { t } = useI18n();
  const keep = useKeepFiled();
  const reject = useRejectItem();
  const [rejecting, setRejecting] = useState(false);
  const busy = keep.isPending || reject.isPending;
  const failed = keep.error ?? reject.error;
  return (
    <article className="tp-card tp-card--filed" aria-busy={busy}>
      <div className="tp-labels">
        <span className="tp-chip tp-chip--filed">{t('proposals.label.filed')}</span>
        <BasisChip basis={task.basis} />
      </div>
      <CardBody name={task.name} why={task.why} quote={task.quote} parentName={task.parentName} />
      {rejecting ? (
        <RejectPanel reasons={reasons} busy={busy} onCancel={() => setRejecting(false)}
          onReject={(reason, note) => reject.mutate({ id: task.slug, filed: true, reason, note })} />
      ) : (
        <div className="tp-actions">
          <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => keep.mutate(task.slug)}>{t('proposals.keep')}</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setRejecting(true)}>{t('proposals.reject')}</button>
        </div>
      )}
      {failed && <p className="tp-error" role="alert">{(failed as Error).message || t('proposals.failed')}</p>}
    </article>
  );
}

/**
 * A reorganisation the task migration was not sure enough to apply: merge this
 * task into another, cancel it, put it under a parent, link it to a feature, or
 * move it to Later. The task stays as it is until the owner answers; nothing is
 * deleted either way.
 */
function ChangeCard({ suggestion }: { suggestion: ChangeSuggestion }) {
  const { t } = useI18n();
  const answer = useAnswerChange();
  const busy = answer.isPending;
  const target = suggestion.targetName ?? suggestion.target ?? '';
  return (
    <article className="tp-card tp-card--change" aria-busy={busy}>
      <div className="tp-labels">
        <span className="tp-chip">{t('proposals.label.change')}</span>
      </div>
      <h3 className="tp-name">{suggestion.name}</h3>
      <p className="tp-change">{t(`proposals.change.${suggestion.change}`).replace('{target}', target)}</p>
      <p className="tp-why">{suggestion.why}</p>
      <div className="tp-actions">
        <button type="button" className="btn btn--primary btn--sm" disabled={busy}
          onClick={() => answer.mutate({ slug: suggestion.slug, id: suggestion.id, apply: true })}>
          {t(`proposals.change.apply.${suggestion.change}`)}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
          onClick={() => answer.mutate({ slug: suggestion.slug, id: suggestion.id, apply: false })}>
          {t('proposals.change.keep')}
        </button>
      </div>
      {answer.error && <p className="tp-error" role="alert">{(answer.error as Error).message || t('proposals.failed')}</p>}
    </article>
  );
}

/** One tap on a reason rejects; the note (optional) rides along when typed first. */
function RejectPanel({ reasons, busy, onReject, onCancel }: {
  reasons: ProposalsPayload['reasons'];
  busy: boolean;
  onReject: (reason: FeedbackReason, note?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  return (
    <div className="tp-reject" role="group" aria-label={t('proposals.rejectWhy')}>
      <p className="tp-reject-q">{t('proposals.rejectWhy')}</p>
      <input className="tp-note" value={note} placeholder={t('proposals.notePlaceholder')} onChange={(e) => setNote(e.target.value)} disabled={busy} />
      <div className="tp-reasons">
        {reasons.map((r) => (
          <button key={r.key} type="button" className="tp-reason" disabled={busy} onClick={() => onReject(r.key, note.trim() || undefined)}>
            {t(`proposals.reason.${r.key}`)}
          </button>
        ))}
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onCancel}>{t('proposals.cancel')}</button>
      </div>
    </div>
  );
}

// ─── Trend and rules ─────────────────────────────────────────────────────────

function TrendBars({ trend }: { trend: WeekTrend[] }) {
  const { t } = useI18n();
  if (!trend.some((w) => w.kept + w.rejected > 0)) return null;
  return (
    <span className="tp-trend" role="img" aria-label={t('proposals.trendLabel')}>
      {trend.map((w) => (
        <span
          key={w.week}
          className={`tp-bar${w.rate === null ? ' tp-bar--none' : ''}`}
          title={t('proposals.trendWeek').replace('{week}', w.week).replace('{kept}', String(w.kept)).replace('{rejected}', String(w.rejected))}
        >
          <span className="tp-bar-fill" style={{ height: `${w.rate ? Math.max(8, Math.round(w.rate * 100)) : 0}%` }} />
        </span>
      ))}
    </span>
  );
}

function RulesStrip({ rules, ruleCount }: { rules: RuleChangeRow[]; ruleCount: number }) {
  const { t } = useI18n();
  const revert = useRevertRule();
  if (rules.length === 0) return null;
  return (
    <div className="tp-rules">
      <h4 className="tp-rules-title">
        {t('proposals.rules.title')} <span className="tp-rules-count">{ruleCount}</span>
      </h4>
      <ul>
        {rules.map((r) => (
          <li key={`${r.id}-${r.at}`} className="tp-rule">
            <span className="tp-rule-id">{r.id}</span>
            <span className={`tp-rule-title${r.removed ? ' tp-rule-title--gone' : ''}`}>{r.title}</span>
            <span className="tp-rule-meta">
              {t(`proposals.rules.action.${r.action}`)} · {t(`proposals.rules.by.${r.by}`)} · {t('proposals.rules.rests').replace('{n}', String(r.restsOn))}
            </span>
            {/* Undo of the latest change: on a reverted row that brings the rule back. */}
            <button type="button" className="btn btn--ghost btn--sm" disabled={revert.isPending} onClick={() => revert.mutate({ id: r.id, at: r.at })}>
              {t(r.action === 'revert' ? 'proposals.rules.restore' : 'proposals.rules.revert')}
            </button>
          </li>
        ))}
      </ul>
      {revert.error && <p className="tp-error" role="alert">{(revert.error as Error).message}</p>}
    </div>
  );
}
