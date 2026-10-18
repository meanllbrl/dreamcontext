import type { Task } from '../../../hooks/useTasks';
import { useStatusModel } from '../../../hooks/useTasks';
import { useI18n } from '../../../context/I18nContext';

/**
 * The sub-tasks: the n/m roll-up (cancelled ones left out, as the server counts) and one row
 * per child that opens its own page.
 */
export function TaskChildren({ items, onOpen }: { items: Task[]; onOpen: (slug: string) => void }) {
  const { t } = useI18n();
  const sm = useStatusModel();
  if (items.length === 0) return null;
  const counted = items.filter((c) => !sm.isCancelled(c.status) && c.status !== 'cancelled');
  const done = counted.filter((c) => sm.isDone(c.status)).length;
  return (
    <section className="tp-block" aria-labelledby="tp-children-title">
      <h2 className="tp-block-title" id="tp-children-title">
        {t('taskPage.children.title')}
        <span className="tp-count">{t('taskPage.children.rollup').replace('{done}', String(done)).replace('{total}', String(counted.length))}</span>
      </h2>
      <ul className="tp-children">
        {items.map((c) => (
          <li key={c.slug}>
            <button type="button" className="tp-child" onClick={() => onOpen(c.slug)}>
              <span className="tp-status-dot" style={{ background: sm.colorOf(c.status) }} aria-hidden="true" />
              <span className="tp-child-name" lang="und">{c.name || c.slug}</span>
              <span className="tp-child-status">{sm.labelOf(c.status)}</span>
              {c.criteria.total > 0 && (
                <span className="tp-child-crit">{`${c.criteria.done}/${c.criteria.total}`}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
