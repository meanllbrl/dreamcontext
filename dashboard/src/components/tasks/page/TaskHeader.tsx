import type { TaskDetail } from '../../../hooks/useTasks';
import { useStatusModel, useUpdateTask, usePlanTask } from '../../../hooks/useTasks';
import { useCycles } from '../../../hooks/useCycles';
import { useI18n } from '../../../context/I18nContext';
import { cycleOfCard, orderOf } from '../taskOrder';
import { TaskVerdictBar } from './TaskVerdictBar';
import { fill } from '../../../lib/fill';

/**
 * The task page's header: back to the board, the name exactly as written (React text, no case
 * transform), status, the placement on the "when?" axis (Now / Next / Later or a cycle), the
 * parent path, the one door to an agent, and the verdict bar while the task waits in review.
 */
export function TaskHeader({ task, onBack, onOpenTask, onGiveToAgent, onError }: {
  task: TaskDetail;
  onBack: () => void;
  onOpenTask: (slug: string) => void;
  onGiveToAgent: () => void;
  onError: (err: Error) => void;
}) {
  const { t } = useI18n();
  const sm = useStatusModel();
  const updateTask = useUpdateTask();
  const plan = usePlanTask();
  const { data: cycles } = useCycles();
  const active = cycles?.active ?? null;
  const cycle = cycleOfCard(task);
  const order = orderOf(task, active);
  // The select's value: the card's own cycle when it is planned into one that is not active,
  // else its order bucket.
  const placement = cycle && cycle !== active ? cycle : order;
  const planned = (cycles?.cycles ?? []).filter((c) => c.status === 'planned');
  const cycleLabel = (id: string) => {
    const c = cycles?.cycles.find((x) => x.id === id);
    return c ? fill(t('taskPage.header.cycleN'), { n: String(c.number) }) : id;
  };

  const statuses = sm.order.includes(task.status) ? sm.order : [...sm.order, task.status];
  const statusLabel = (k: string) => (['todo', 'in_progress', 'in_review', 'completed'].includes(k) ? t(`tasks.${k}`) : sm.labelOf(k));

  return (
    <header className="tkp-header">
      <div className="tkp-header-top">
        <button type="button" className="tkp-btn tkp-back" onClick={onBack}>
          <span aria-hidden="true">←</span> {t('taskPage.backToBoard')}
        </button>
        <button type="button" className="tkp-btn tkp-btn--primary" onClick={onGiveToAgent}>
          {t('giveAgent.open')}
        </button>
      </div>

      {task.parent && (
        <nav className="tkp-breadcrumb" aria-label={t('taskPage.header.parentPath')}>
          <button type="button" className="tkp-link" onClick={() => onOpenTask(task.parent!.slug)} lang="und">
            {task.parent.name || task.parent.slug}
          </button>
          <span aria-hidden="true" className="tkp-meta">/</span>
        </nav>
      )}

      <h1 className="tkp-title" lang="und">{task.name || task.slug}</h1>

      <div className="tkp-header-controls">
        <label className="tkp-control">
          <span className="tkp-label">{t('taskPage.header.status')}</span>
          <select
            id="tkp-status"
            className="tkp-select"
            value={task.status}
            disabled={updateTask.isPending}
            onChange={(e) => updateTask.mutate({ slug: task.slug, updates: { status: e.target.value } }, { onError })}
          >
            {statuses.map((k) => <option key={k} value={k}>{statusLabel(k)}</option>)}
          </select>
        </label>
        <label className="tkp-control">
          <span className="tkp-label">{t('taskPage.header.placement')}</span>
          <select
            id="tkp-placement"
            className="tkp-select"
            value={placement}
            disabled={plan.isPending}
            onChange={(e) => plan.mutate({ slug: task.slug, target: e.target.value }, { onError })}
          >
            {active && <option value="now">{t('board.order.now')}</option>}
            <option value="next">{t('board.order.next')}</option>
            <option value="later">{t('board.order.later')}</option>
            {planned.map((c) => <option key={c.id} value={c.id}>{cycleLabel(c.id)}</option>)}
            {cycle && cycle !== active && !planned.some((c) => c.id === cycle) && <option value={cycle}>{cycleLabel(cycle)}</option>}
          </select>
        </label>
        {cycle && <span className="tkp-chip">{cycleLabel(cycle)}</span>}
      </div>

      {sm.kindOf(task.status) === 'review' && (
        <div className="tkp-review">
          <p className="tkp-meta">{t('taskPage.header.inReview')}</p>
          <TaskVerdictBar slug={task.slug} />
        </div>
      )}
    </header>
  );
}
