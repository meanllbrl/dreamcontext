import { useMemo, useState, type DragEvent } from 'react';
import type { Task } from '../../hooks/useTasks';
import { usePlanTask, useRankTask, useStatusModel } from '../../hooks/useTasks';
import type { CycleListEntry } from '../../hooks/useCycles';
import { useI18n } from '../../context/I18nContext';
import { byRank, taskName } from '../tasks/boardModel';
import { cycleOfCard } from '../tasks/taskOrder';

/** A leaf is a card with no sub-tasks: what a cycle's capacity is counted in. */
function isLeaf(t: Task): boolean {
  return !t.children || t.children.total === 0;
}

/**
 * Planning a cycle: the Next queue on one side, the chosen cycle on the other. A card moves by
 * drag (`POST /tasks/:slug/plan`) or by its "Move to" select, and orders inside its list with
 * Up / Down (`POST /tasks/:slug/rank`). The capacity line compares the cycle's planned leaves
 * with what the last closed cycles finished.
 */
export function PlanningBoard({ tasks, cycles, cycle, capacityHint, onOpenTask }: {
  tasks: Task[];
  cycles: CycleListEntry[];
  cycle: CycleListEntry;
  capacityHint: number | null;
  onOpenTask: (slug: string) => void;
}) {
  const { t } = useI18n();
  const sm = useStatusModel();
  const plan = usePlanTask();
  const rank = useRankTask();
  const [dragSlug, setDragSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onError = (err: Error) => setError(err.message);

  const live = useMemo(() => tasks.filter((x) => !sm.isTerminal(x.status) && x.status !== 'cancelled'), [tasks, sm]);
  const next = useMemo(() => byRank(live.filter((x) => !cycleOfCard(x) && x.queue !== 'later')), [live]);
  const inCycle = useMemo(() => byRank(tasks.filter((x) => cycleOfCard(x) === cycle.id && x.status !== 'cancelled' && !sm.isCancelled(x.status))), [tasks, cycle.id, sm]);
  const leaves = inCycle.filter(isLeaf).length;
  const targets = cycles.filter((c) => c.status !== 'closed');
  const cycleLabel = (c: CycleListEntry) => t('taskPage.header.cycleN').replace('{n}', String(c.number));

  const moveTo = (slug: string, target: string) => { setError(null); plan.mutate({ slug, target }, { onError }); };
  const rankRelative = (list: Task[], i: number, dir: -1 | 1) => {
    const other = list[i + dir];
    if (!other) return;
    setError(null);
    rank.mutate(dir === -1 ? { slug: list[i].slug, before: other.slug } : { slug: list[i].slug, after: other.slug }, { onError });
  };
  const dropOn = (target: string) => (e: DragEvent) => {
    e.preventDefault();
    const slug = dragSlug;
    setDragSlug(null);
    if (slug) moveTo(slug, target);
  };

  const list = (items: Task[], where: 'next' | 'cycle', label: string) => (
    <section
      className="pln-lane"
      aria-label={label}
      data-planning-lane={where}
      onDragOver={(e) => e.preventDefault()}
      onDrop={dropOn(where === 'next' ? 'next' : cycle.id)}
    >
      <h3 className="pln-lane-title">{label}<span className="pln-count">{items.length}</span></h3>
      {items.length === 0 && <p className="pln-empty">{t('planning.board.emptyLane')}</p>}
      <ol className="pln-items">
        {items.map((x, i) => (
          <li
            key={x.slug}
            className="pln-item"
            draggable
            data-planning-item={x.slug}
            onDragStart={() => setDragSlug(x.slug)}
            onDragEnd={() => setDragSlug(null)}
          >
            <button type="button" className="pln-link" onClick={() => onOpenTask(x.slug)} lang="und">{taskName(x)}</button>
            {x.children && x.children.total > 0 && <span className="pln-meta">{`${x.children.done}/${x.children.total}`}</span>}
            <span className="pln-item-actions">
              <button type="button" className="pln-icon-btn" aria-label={t('planning.board.up').replace('{name}', taskName(x))} disabled={i === 0 || rank.isPending} onClick={() => rankRelative(items, i, -1)}>↑</button>
              <button type="button" className="pln-icon-btn" aria-label={t('planning.board.down').replace('{name}', taskName(x))} disabled={i === items.length - 1 || rank.isPending} onClick={() => rankRelative(items, i, 1)}>↓</button>
              <select
                className="pln-select"
                aria-label={t('planning.board.moveTo').replace('{name}', taskName(x))}
                value=""
                onChange={(e) => { if (e.target.value) moveTo(x.slug, e.target.value); }}
              >
                <option value="">{t('planning.board.moveToShort')}</option>
                {where === 'cycle' && <option value="next">{t('board.order.next')}</option>}
                <option value="later">{t('board.order.later')}</option>
                {targets.filter((c) => !(where === 'cycle' && c.id === cycle.id)).map((c) => <option key={c.id} value={c.id}>{cycleLabel(c)}</option>)}
              </select>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );

  return (
    <div className="pln-board" data-planning-board={cycle.id}>
      <p className="pln-capacity" data-capacity>
        {capacityHint === null
          ? t('planning.board.capacityNoHint').replace('{n}', String(leaves))
          : t('planning.board.capacity').replace('{n}', String(leaves)).replace('{hint}', String(capacityHint))}
      </p>
      <div className="pln-lanes">
        {list(next, 'next', t('board.order.next'))}
        {list(inCycle, 'cycle', `${cycleLabel(cycle)}${cycle.goal ? ` · ${cycle.goal}` : ''}`)}
      </div>
      {error && <p className="pln-error" role="alert">{error}</p>}
    </div>
  );
}
