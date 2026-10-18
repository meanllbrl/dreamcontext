import { useEffect, useMemo, useRef, useState } from 'react';
import { useDeleteTask, useTask } from '../hooks/useTasks';
import { confirmAction } from '../lib/desktop';
import { useI18n } from '../context/I18nContext';
import type { Page } from '../components/layout/Sidebar';
import { useSectionCollapse } from '../components/tasks/detail/useSectionCollapse';
import { TaskSection } from '../components/tasks/detail/TaskSection';
import { splitBodySections } from '../components/tasks/page/bodySections';
import { TaskHeader } from '../components/tasks/page/TaskHeader';
import { TaskCriteria } from '../components/tasks/page/TaskCriteria';
import { TaskSections } from '../components/tasks/page/TaskSections';
import { TaskChildren } from '../components/tasks/page/TaskChildren';
import { TaskFields } from '../components/tasks/page/TaskFields';
import { TaskJournalTimeline } from '../components/tasks/page/TaskJournalTimeline';
import { AssignToAgentComposer } from '../components/tasks/AssignToAgentComposer';
import '../components/tasks/page/TaskPage.css';

interface TaskPageProps {
  /** The task to show (the Shell's focus id). Null after a reload: the page goes back to the board. */
  slug: string | null;
  onNavigate: (page: Page, id: string | null) => void;
}

/**
 * One task, as a page (plan r3 § 5a): the header, the criteria with their evidence, the
 * decisions and the other sections, the sub-tasks, the journal timeline, and the properties
 * beside them. Everything comes from `GET /api/tasks/:slug`; the board's cards carry no body.
 *
 * `data-task-ready` is set once the card is painted: the verify script times the 300 KB legacy
 * card from the click to that attribute.
 */
export function TaskPage({ slug, onNavigate }: TaskPageProps) {
  const { t } = useI18n();
  const { data: task, isLoading, error } = useTask(slug ?? '');
  const deleteTask = useDeleteTask();
  const collapse = useSectionCollapse();
  const [assigning, setAssigning] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [painted, setPainted] = useState<string | null>(null);

  // No task to show (a reload remembers the page, not the slug): back to the board.
  useEffect(() => { if (!slug) onNavigate('tasks', null); }, [slug, onNavigate]);

  // A refusal (the evidence gate's 409 names every unproven criterion, one per line) stays
  // long enough to read; a newer error restarts the clock.
  const mutationErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (mutationErrorTimer.current) clearTimeout(mutationErrorTimer.current); }, []);
  const onMutationError = (err: Error) => {
    setMutationError(err.message);
    if (mutationErrorTimer.current) clearTimeout(mutationErrorTimer.current);
    mutationErrorTimer.current = setTimeout(() => setMutationError(null), 8000);
  };

  const sections = useMemo(() => splitBodySections(task?.body ?? ''), [task?.body]);

  // Ready after the browser has painted this card (two frames: commit, then paint).
  useEffect(() => {
    if (!task) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setPainted(task.slug)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [task]);

  const openTask = (next: string) => onNavigate('task', next);
  const back = () => onNavigate('tasks', null);

  const handleDelete = async () => {
    if (!task) return;
    const ok = await confirmAction({
      title: t('taskPage.delete.title').replace('{name}', task.name || task.slug),
      body: t('taskPage.delete.body'),
      confirmLabel: t('taskPage.delete.confirm'),
      destructive: true,
    });
    if (!ok) return;
    deleteTask.mutate(task.slug, { onError: onMutationError, onSuccess: back });
  };

  if (!slug) return null;
  if (isLoading) return <div className="tkp-page tkp-state">{t('taskPage.loading')}</div>;
  if (error || !task) {
    return (
      <div className="tkp-page tkp-state">
        <p>{t('taskPage.notFound')}</p>
        <button type="button" className="tkp-btn" onClick={back}>{t('taskPage.backToBoard')}</button>
      </div>
    );
  }

  return (
    <div className="tkp-page" data-task-page={task.slug} data-task-ready={painted === task.slug ? task.slug : undefined}>
      <TaskHeader
        task={task}
        onBack={back}
        onOpenTask={openTask}
        onGiveToAgent={() => setAssigning(true)}
        onError={onMutationError}
      />
      {mutationError && (
        <div className="error-state" role="alert" style={{ whiteSpace: 'pre-line' }}>{mutationError}</div>
      )}
      <div className="tkp-layout">
        <div className="tkp-doc">
          {task.description && <p className="tkp-summary">{task.description}</p>}
          <TaskSections
            slug={task.slug}
            sections={sections}
            collapse={collapse}
            criteria={<TaskCriteria task={task} onError={onMutationError} />}
          />
          <TaskChildren items={task.children} onOpen={openTask} />
          <TaskSection id="journal" title={t('tasks.changelog')} open={collapse.isOpen('journal')} onToggle={() => collapse.toggle('journal')}>
            <TaskJournalTimeline slug={task.slug} onError={onMutationError} />
          </TaskSection>
        </div>
        <aside className="tkp-rail" aria-label={t('taskPage.properties')}>
          <TaskFields task={task} collapse={collapse} onError={onMutationError} onGiveToAgent={() => setAssigning(true)} />
          <div className="tkp-danger">
            <button type="button" className="tkp-btn tkp-btn--danger" onClick={handleDelete} disabled={deleteTask.isPending}>
              {t('taskPage.delete.button')}
            </button>
            <span className="tkp-meta">{t('taskPage.delete.hint')}</span>
          </div>
        </aside>
      </div>
      {assigning && <AssignToAgentComposer task={task} onClose={() => setAssigning(false)} />}
    </div>
  );
}
