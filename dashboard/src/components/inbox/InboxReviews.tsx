import type { Task } from '../../hooks/useTasks';
import { useI18n } from '../../context/I18nContext';
import { TaskVerdictBar } from '../tasks/page/TaskVerdictBar';

/** Every criterion ticked: the review can be approved, and it counts in the Inbox badge. */
export function isFullyEvidenced(t: Task): boolean {
  return t.criteria.total > 0 && t.criteria.done === t.criteria.total;
}

/**
 * Tasks waiting for the owner's verdict. Each row opens its task page and carries the verdict
 * bar inline. A review with an unticked criterion says "evidence incomplete": it is listed, but
 * the badge does not count it (the server counts the same way, `GET /api/inbox/count`).
 */
export function InboxReviews({ reviews, onOpenTask }: { reviews: Task[]; onOpenTask: (slug: string) => void }) {
  const { t } = useI18n();
  if (reviews.length === 0) return <p className="ibx-empty">{t('inbox.reviews.empty')}</p>;
  return (
    <ul className="ibx-list">
      {reviews.map((r) => {
        const ready = isFullyEvidenced(r);
        return (
          <li key={r.slug} className="ibx-row" data-inbox-review={r.slug} data-evidenced={ready || undefined}>
            <div className="ibx-row-head">
              <button type="button" className="ibx-link" onClick={() => onOpenTask(r.slug)} lang="und">{r.name || r.slug}</button>
              <span className="ibx-meta">
                {t('inbox.reviews.criteria').replace('{done}', String(r.criteria.done)).replace('{total}', String(r.criteria.total))}
              </span>
              {!ready && <span className="ibx-tag ibx-tag--warn">{t('inbox.reviews.incomplete')}</span>}
            </div>
            <TaskVerdictBar slug={r.slug} />
          </li>
        );
      })}
    </ul>
  );
}
