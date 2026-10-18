import { useState } from 'react';
import type { LearnedItem } from '../../hooks/useInbox';
import { useRevertLearned } from '../../hooks/useInbox';
import { confirmAction } from '../../lib/desktop';
import { useI18n } from '../../context/I18nContext';

/**
 * What sleep learned: a rule from the owner's repeated corrections, or a task-filing rule
 * change. Each shows its title, the pattern it lives in, the owner's quotes with their dates
 * (React text: a quote is data), and where it came from. Revert is one click behind a
 * confirmation, owner-only; a filing-rule revert sends `expectAt` so a rule changed since
 * this list loaded is refused rather than overwritten.
 */
export function InboxLearned({ items, onOpenPattern }: { items: LearnedItem[]; onOpenPattern: (pattern: string) => void }) {
  const { t } = useI18n();
  const revert = useRevertLearned();
  const [error, setError] = useState<string | null>(null);
  if (items.length === 0) return <p className="ibx-empty">{t('inbox.learned.empty')}</p>;

  const onRevert = async (item: LearnedItem) => {
    setError(null);
    const ok = await confirmAction({
      title: t('inbox.learned.revertTitle').replace('{title}', item.title),
      body: t('inbox.learned.revertBody'),
      confirmLabel: t('inbox.learned.revert'),
      destructive: true,
    });
    if (!ok) return;
    revert.mutate(
      { id: item.id, ...(item.source === 'filing-rule' ? { expectAt: item.at } : {}) },
      { onError: (err: Error) => setError(err.message) },
    );
  };

  return (
    <>
      <ul className="ibx-list">
        {items.map((item) => (
          <li key={item.id} className="ibx-row" data-inbox-learned={item.id}>
            <div className="ibx-row-head">
              <span className="ibx-title">{item.title}</span>
              <span className="ibx-tag">{t(item.source === 'filing-rule' ? 'inbox.learned.sourceFiling' : 'inbox.learned.sourceCorrection')}</span>
              <span className="ibx-meta">{item.at.slice(0, 10)}</span>
            </div>
            {item.source === 'correction' && item.pattern && (
              <button type="button" className="ibx-link" onClick={() => onOpenPattern(item.pattern)}>
                {t('inbox.learned.pattern').replace('{pattern}', item.pattern)}
              </button>
            )}
            {item.quotes.length > 0 && (
              <ul className="ibx-quotes" aria-label={t('inbox.learned.quotes')}>
                {item.quotes.map((q, i) => (
                  <li key={`${item.id}-${i}`} className="ibx-quote">
                    <q>{q.text}</q>
                    <span className="ibx-meta">{q.date}</span>
                  </li>
                ))}
              </ul>
            )}
            {item.reverted ? (
              <p className="ibx-meta">{t('inbox.learned.reverted').replace('{date}', item.reverted.at.slice(0, 10)).replace('{by}', item.reverted.by)}</p>
            ) : (
              <div>
                <button type="button" className="ibx-btn" disabled={revert.isPending} onClick={() => void onRevert(item)}>
                  {t('inbox.learned.revert')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="ibx-error" role="alert">{error}</p>}
    </>
  );
}
