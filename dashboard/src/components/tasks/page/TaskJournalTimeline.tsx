import { useState, type FormEvent } from 'react';
import { useAddTaskChangelog, useTaskJournal, type TaskJournalEntry } from '../../../hooks/useTasks';
import { useI18n } from '../../../context/I18nContext';
import { MarkdownBlock } from './MarkdownBlock';
import { fill } from '../../../lib/fill';

/** The server's page size (`PANEL_JOURNAL_LIMIT`): every page before the last one is full. */
const PAGE = 5;

function heading(e: TaskJournalEntry): string {
  return e.label && e.label.toLowerCase() !== e.kind ? `${e.kind} · ${e.label}` : e.kind;
}

/** One page of entries; the last page offers the next one. */
function JournalPage({ slug, before, shownBefore, isLast, onOlder }: {
  slug: string;
  before: string | null;
  shownBefore: number;
  isLast: boolean;
  onOlder: (lastId: string) => void;
}) {
  const { t } = useI18n();
  const { data, isLoading, isError } = useTaskJournal(slug, before);
  if (isLoading) return <li className="tkp-meta">{t('taskPage.loading')}</li>;
  // A failed read is not an empty history: say so, before the empty and the list. A failed
  // background refetch keeps the entries already shown.
  if (isError && !data) return <li className="tkp-error" role="alert">{t('taskPage.journal.loadFailed')}</li>;
  const entries = data?.entries ?? [];
  if (before === null && entries.length === 0) return <li className="tkp-empty">{t('tasks.history_empty')}</li>;
  const older = data ? data.total - shownBefore - entries.length : 0;
  return (
    <>
      {entries.map((e) => (
        <li key={e.id} className={`tkp-entry tkp-entry--${e.kind}`}>
          <div className="tkp-entry-head">
            <span className="tkp-entry-kind">{heading(e)}</span>
            <span className="tkp-meta">{[e.date, e.actor].filter(Boolean).join(' · ')}</span>
          </div>
          {e.body && <MarkdownBlock text={e.body} idPrefix={`tkp-je-${e.id}`} className="tkp-entry-body" />}
        </li>
      ))}
      {isLast && older > 0 && entries.length > 0 && (
        <li>
          <button type="button" className="tkp-btn" onClick={() => onOlder(entries[entries.length - 1].id)}>
            {fill(t('taskPage.journal.older'), { n: String(older) })}
          </button>
        </li>
      )}
    </>
  );
}

/**
 * The task's journal as a timeline, lazy: the newest five, then "Show older" a page at a time
 * (`GET /api/tasks/:slug/journal?before=<je_id>`). Bodies go through the sanitizing renderer
 * (a pulled remote comment is data, never markup). Below it, the owner adds an entry.
 */
export function TaskJournalTimeline({ slug, onError }: { slug: string; onError: (err: Error) => void }) {
  const { t } = useI18n();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const addEntry = useAddTaskChangelog();
  const [entry, setEntry] = useState('');
  const inputId = `tkp-journal-add-${slug}`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!entry.trim()) return;
    addEntry.mutate(
      { slug, content: entry.trim() },
      { onSuccess: () => { setEntry(''); setCursors([null]); }, onError },
    );
  };

  return (
    <div className="tkp-journal">
      <ol className="tkp-timeline" aria-label={t('tasks.changelog')}>
        {cursors.map((before, i) => (
          <JournalPage
            key={before ?? 'newest'}
            slug={slug}
            before={before}
            shownBefore={i * PAGE}
            isLast={i === cursors.length - 1}
            onOlder={(lastId) => setCursors((c) => [...c, lastId])}
          />
        ))}
      </ol>
      <form onSubmit={submit} className="tkp-journal-add">
        <label className="tkp-label" htmlFor={inputId}>{t('taskPage.journal.addLabel')}</label>
        <div className="tkp-row">
          <input
            id={inputId}
            className="tkp-input"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            placeholder={t('tasks.history_placeholder')}
          />
          <button type="submit" className="tkp-btn tkp-btn--primary" disabled={!entry.trim() || addEntry.isPending}>
            {t('tasks.add_entry')}
          </button>
        </div>
      </form>
    </div>
  );
}
