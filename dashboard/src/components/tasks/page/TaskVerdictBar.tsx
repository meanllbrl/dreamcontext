import { useState, type FormEvent } from 'react';
import { useTaskVerdict } from '../../../hooks/useTasks';
import { useI18n } from '../../../context/I18nContext';

/**
 * The owner's verdict on a task in review: Approve, or Send back with a note (the note is
 * required — it is what the agent works from next). Both go to the owner-only
 * `POST /api/tasks/:slug/verdict`; the browser sends its Origin, so the server records `via`.
 * Used on the task page header and inline on the Inbox's review rows.
 */
export function TaskVerdictBar({ slug, onDone }: { slug: string; onDone?: (verdict: 'approve' | 'send_back') => void }) {
  const { t } = useI18n();
  const verdict = useTaskVerdict();
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const noteId = `verdict-note-${slug}`;

  const submit = (kind: 'approve' | 'send_back') => {
    setError(null);
    verdict.mutate(
      { slug, verdict: kind, ...(kind === 'send_back' ? { note: note.trim() } : {}) },
      {
        onSuccess: () => { setSendingBack(false); setNote(''); onDone?.(kind); },
        onError: (err: Error) => setError(err.message),
      },
    );
  };

  const onSendBack = (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    submit('send_back');
  };

  return (
    <div className="tp-verdict" data-verdict-bar={slug}>
      {!sendingBack ? (
        <div className="tp-verdict-row">
          <button type="button" className="tp-btn tp-btn--primary" disabled={verdict.isPending} onClick={() => submit('approve')}>
            {t('taskPage.verdict.approve')}
          </button>
          <button type="button" className="tp-btn" disabled={verdict.isPending} onClick={() => setSendingBack(true)}>
            {t('taskPage.verdict.sendBack')}
          </button>
        </div>
      ) : (
        <form className="tp-verdict-form" onSubmit={onSendBack}>
          <label className="tp-label" htmlFor={noteId}>{t('taskPage.verdict.noteLabel')}</label>
          <textarea
            id={noteId}
            className="tp-input tp-textarea"
            rows={3}
            value={note}
            required
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('taskPage.verdict.notePlaceholder')}
          />
          <div className="tp-verdict-row">
            <button type="submit" className="tp-btn tp-btn--primary" disabled={!note.trim() || verdict.isPending}>
              {t('taskPage.verdict.sendBackConfirm')}
            </button>
            <button type="button" className="tp-btn" onClick={() => { setSendingBack(false); setNote(''); }}>
              {t('taskPage.cancel')}
            </button>
          </div>
        </form>
      )}
      {error && <p className="tp-error" role="alert">{error}</p>}
    </div>
  );
}
