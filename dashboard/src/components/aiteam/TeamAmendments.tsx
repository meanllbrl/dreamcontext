import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAgentAmendments, useRevertAmendment, type AgentAmendment } from '../../hooks/useAgents';
import { amendmentDiff, amendmentFieldKey } from './teamModel';

/**
 * WHAT THE SUPER AGENT CHANGED IN THIS MEMBER. A correction goes through without a card, so this
 * is where the owner reads it afterwards: why, what it replaced, and one click to take it back.
 * Neutral on purpose: nothing here waits for him, a change he never opens is fine.
 */
export function TeamAmendments({ slug, onToast }: { slug: string; onToast: (msg: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const list = useAgentAmendments(slug).data ?? [];
  if (list.length === 0) return null;
  const newest = list[0];
  return (
    <div className="aiteam-amend" data-team-amendments role="region" aria-label={t('aiteam.amend.aria')}>
      <div className="aiteam-amend-line">
        <span className="aiteam-amend-text">
          <span className="aiteam-amend-lead">{t('aiteam.amend.lead')}</span>
          {' '}{newest.why}
        </span>
        {newest.revertedAt && <span className="aiteam-tag aiteam-tag--muted">{t('aiteam.amend.reverted')}</span>}
        <button type="button" className="agent-btn aiteam-approval-btn" aria-expanded={open} onClick={() => setOpen(!open)} data-amend-toggle>
          {open ? t('aiteam.approval.hide') : t('aiteam.amend.show').replace('{n}', String(list.length))}
        </button>
      </div>
      {open && <div className="aiteam-amend-list">{list.map((a) => <AmendmentRow key={a.id} slug={slug} item={a} onToast={onToast} />)}</div>}
    </div>
  );
}

function AmendmentRow({ slug, item, onToast }: { slug: string; item: AgentAmendment; onToast: (msg: string) => void }) {
  const { t } = useI18n();
  const revert = useRevertAmendment(slug);
  const [error, setError] = useState<string | null>(null);
  const when = new Date(item.at).toLocaleString();
  return (
    <div className="aiteam-amend-row" data-amendment={item.id}>
      <div className="aiteam-amend-meta">
        <span>{when}</span>
        {item.revertedAt && <span className="aiteam-tag aiteam-tag--muted" data-amend-reverted>{t('aiteam.amend.reverted')}</span>}
      </div>
      <p className="aiteam-amend-why">{item.why}</p>
      {item.changes.map((c) => (
        <div key={`${c.field}:${c.routine ?? ''}`}>
          <p className="aiteam-approval-lead">{t(amendmentFieldKey(c.field)).replace('{routine}', c.routine ?? '')}</p>
          <pre className="aiteam-approval-pre">
            {amendmentDiff(c.before, c.after).map((l, i) => (
              <span key={i} className={l.added ? 'aiteam-amend-add' : 'aiteam-amend-del'}>{l.added ? '+ ' : '- '}{l.text}{'\n'}</span>
            ))}
          </pre>
        </div>
      ))}
      {error && <p className="agp-error" role="alert">{error}</p>}
      {!item.revertedAt && (
        <div className="aiteam-approval-foot">
          <button
            type="button"
            className="agent-btn"
            disabled={revert.isPending}
            data-amend-revert
            onClick={() => {
              setError(null);
              revert.mutate(item.id, {
                onSuccess: () => onToast(t('aiteam.amend.done')),
                onError: (err) => setError((err as Error).message),
              });
            }}
          >
            {t('aiteam.amend.revert')}
          </button>
        </div>
      )}
    </div>
  );
}
