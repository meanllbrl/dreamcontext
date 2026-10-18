import type { AuditEntry } from '../../hooks/useInbox';
import { useI18n } from '../../context/I18nContext';

/**
 * The records of every owner override the task system kept: approvals, send-backs, accepts,
 * applies, forced completions and exemptions, each with the task, who, through what and when.
 * A write that reached the server with no browser Origin (`via: no-origin`) sits on a warning
 * tint and says so: the shape a scripted call has, possibly an agent (a detective control).
 */
export function InboxRecords({ records, onOpenTask }: { records: AuditEntry[]; onOpenTask: (slug: string) => void }) {
  const { t } = useI18n();
  if (records.length === 0) return <p className="ibx-empty">{t('inbox.records.empty')}</p>;
  return (
    <ul className="ibx-list">
      {records.map((r) => {
        const noOrigin = r.via === 'no-origin';
        return (
          <li key={r.id} className={`ibx-row${noOrigin ? ' ibx-row--warn' : ''}`} data-inbox-record={r.id} data-via={r.via}>
            <div className="ibx-row-head">
              <span className="ibx-tag">{t(`inbox.records.kind.${r.kind}`)}</span>
              <button type="button" className="ibx-link" onClick={() => onOpenTask(r.slug)}>{r.slug}</button>
              <span className="ibx-meta">{r.at.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <p className="ibx-meta">
              {t('inbox.records.by').replace('{actor}', r.actor).replace('{via}', t(`inbox.records.via.${r.via}`))}
            </p>
            {noOrigin && <p className="ibx-warn-label">{t('inbox.records.noOrigin')}</p>}
            {r.note && <p className="ibx-text">{r.note}</p>}
          </li>
        );
      })}
    </ul>
  );
}
