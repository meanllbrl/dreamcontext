import { useTaskJournal, type TaskJournalEntry } from '../../hooks/useTasks';
import { useI18n } from '../../context/I18nContext';

/** A long entry (an evidence tail, a handoff) is clipped here; the journal keeps it whole. */
const BODY_CLIP = 400;

function clip(body: string): string {
  return body.length > BODY_CLIP ? `${body.slice(0, BODY_CLIP).trimEnd()}…` : body;
}

function heading(e: TaskJournalEntry): string {
  return e.label && e.label.toLowerCase() !== e.kind ? `${e.kind} · ${e.label}` : e.kind;
}

/**
 * The task's newest journal entries, under the card. History left the card for
 * `state/journal/<slug>.md`; bodies render as plain text (a pulled remote comment
 * is data, never markup).
 */
export function TaskJournalStrip({ slug }: { slug: string }) {
  const { t } = useI18n();
  const { data, isLoading } = useTaskJournal(slug);
  if (isLoading) return null;
  const entries = data?.entries ?? [];
  if (entries.length === 0) return <p className="detail-empty">{t('tasks.history_empty')}</p>;
  return (
    <ol className="journal-strip" aria-label={t('tasks.changelog')}>
      {entries.map((e) => (
        <li key={e.id} className={`journal-entry journal-entry--${e.kind}`}>
          <div className="journal-entry-head">
            <span className="journal-entry-kind">{heading(e)}</span>
            <span className="journal-entry-meta">{[e.date, e.actor].filter(Boolean).join(' · ')}</span>
          </div>
          {e.body && <p className="journal-entry-body">{clip(e.body)}</p>}
        </li>
      ))}
      {data && data.total > entries.length && (
        <li className="journal-entry-more">{t('tasks.history_more').replace('{n}', String(data.total - entries.length))}</li>
      )}
    </ol>
  );
}
