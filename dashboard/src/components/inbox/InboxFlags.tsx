import { useState } from 'react';
import type { AuditEntry } from '../../hooks/useInbox';
import { useInboxSeen } from '../../hooks/useInbox';
import { useI18n } from '../../context/I18nContext';

/**
 * Parents a sync held open (closed on the remote while their sub-tasks are open, kept open
 * here), each with "Seen". Seen is owner-only: the browser sends its Origin and the server
 * records who cleared it and through what.
 */
export function InboxFlags({ flags, onOpenTask }: { flags: AuditEntry[]; onOpenTask: (slug: string) => void }) {
  const { t } = useI18n();
  const seen = useInboxSeen();
  const [error, setError] = useState<string | null>(null);
  if (flags.length === 0) return <p className="ibx-empty">{t('inbox.flags.empty')}</p>;
  return (
    <>
      <ul className="ibx-list">
        {flags.map((f) => (
          <li key={f.id} className="ibx-row" data-inbox-flag={f.id}>
            <div className="ibx-row-head">
              <button type="button" className="ibx-link" onClick={() => onOpenTask(f.slug)}>{f.slug}</button>
              <span className="ibx-meta">{f.at.slice(0, 10)}</span>
            </div>
            {f.note && <p className="ibx-text">{f.note}</p>}
            <div>
              <button
                type="button"
                className="ibx-btn"
                disabled={seen.isPending}
                onClick={() => { setError(null); seen.mutate(f.id, { onError: (err: Error) => setError(err.message) }); }}
              >
                {t('inbox.flags.seen')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="ibx-error" role="alert">{error}</p>}
    </>
  );
}
