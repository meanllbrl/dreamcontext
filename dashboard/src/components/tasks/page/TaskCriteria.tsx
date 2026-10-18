import { useEffect, useRef } from 'react';
import type { CriterionView, TaskDetail } from '../../../hooks/useTasks';
import { useUpdateTask } from '../../../hooks/useTasks';
import { useI18n } from '../../../context/I18nContext';
import { toggleCriterion, updateMermaidNodeStatus } from './criteriaEdit';

/**
 * Acceptance criteria as the server parsed them (`CriterionView[]`), as React text: each with
 * its box, an evidence chip by kind and the observed tag. The owner's tick goes through the
 * existing body PATCH; the server turns a tick without evidence into an `owner:` approval.
 */
export function TaskCriteria({ task, onError }: { task: TaskDetail; onError: (err: Error) => void }) {
  const { t } = useI18n();
  const updateTask = useUpdateTask();
  // The body successive ticks compute from: updated synchronously before each PATCH, so two
  // quick ticks never both start from the same server snapshot and overwrite each other.
  const pendingBody = useRef(task.body ?? '');
  useEffect(() => { pendingBody.current = task.body ?? ''; }, [task.body]);

  const tick = (c: CriterionView, checked: boolean) => {
    const current = pendingBody.current;
    const toggled = toggleCriterion(current, c.n, checked);
    if (!toggled) return;
    const next = toggled.nodeId ? updateMermaidNodeStatus(toggled.body, toggled.nodeId, checked) : toggled.body;
    if (next === current) return;
    pendingBody.current = next;
    updateTask.mutate(
      { slug: task.slug, updates: { body: next } },
      { onError: (err: Error) => { pendingBody.current = task.body ?? ''; onError(err); } },
    );
  };

  if (task.criteria.length === 0) return <p className="tkp-empty">{t('taskPage.criteria.empty')}</p>;
  const done = task.criteria.filter((c) => c.checked).length;
  return (
    <div className="tkp-criteria">
      <p className="tkp-meta">{t('taskPage.criteria.count').replace('{done}', String(done)).replace('{total}', String(task.criteria.length))}</p>
      <ol className="tkp-criteria-list">
        {task.criteria.map((c) => {
          const id = `tkp-crit-${task.slug}-${c.n}`;
          return (
            <li key={c.n} className="tkp-criterion" data-checked={c.checked || undefined}>
              <input
                id={id}
                type="checkbox"
                className="tkp-check"
                checked={c.checked}
                disabled={updateTask.isPending}
                onChange={(e) => tick(c, e.target.checked)}
              />
              <label htmlFor={id} className="tkp-criterion-text">{c.text}</label>
              <span className="tkp-criterion-tags">
                {c.observed && <span className="tkp-chip tkp-chip--observed">{t('taskPage.criteria.observed')}</span>}
                {c.checked && c.kind && (
                  <span className={`tkp-chip tkp-chip--${c.kind}`} title={c.ref ?? undefined}>{t(`taskPage.evidence.${c.kind}`)}</span>
                )}
                {c.checked && !c.kind && <span className="tkp-chip tkp-chip--missing">{t('taskPage.evidence.missing')}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
