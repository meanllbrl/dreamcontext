import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useUpdateTask, useDeleteTask, useFeatureOptions, useStatusModel, isOpenChildrenRefusal } from '../../hooks/useTasks';
import { useI18n } from '../../context/I18nContext';
import { openChildrenMessage } from '../../lib/taskObjection';
import { confirmAction } from '../../lib/desktop';
import { useTheme } from '../../context/ThemeContext';
import { DetailHeader } from './detail/DetailHeader';
import { PropertiesPanel, type Updates } from './detail/PropertiesPanel';
import { BodySections } from './detail/BodySections';
import { SubtasksSection } from './detail/SubtasksSection';
import { CriteriaSection } from './detail/CriteriaSection';
import { MediaSection } from './detail/MediaSection';
import { toggleCriterion, type SectionKey } from './detail/sectionModel';
import { subtaskProgress } from './boardModel';
import './TaskDetailPanel.css';

interface TaskDetailPanelProps {
  task: Task;
  /** The board's task list: parent, children and the parent select read from it. */
  allTasks?: Task[];
  /** Open another task in this drawer (a subtask, or the parent from the crumb). */
  onOpenTask?: (slug: string) => void;
  onClose: () => void;
}

/**
 * The task drawer (approved v5 + v6): a header (crumb, editable title, Give to agent,
 * fullscreen, close), the body as sections on the left and Properties on the right.
 *
 * This file is the SHELL: the data comes from the board's list, every write goes through the
 * task PATCH, and every body write is serialized on one pending body (below) so rapid ticks
 * never lose an update. The parts live in `detail/`.
 */
export function TaskDetailPanel({ task, allTasks = [], onOpenTask, onClose }: TaskDetailPanelProps) {
  const { resolved: theme } = useTheme();
  const { t } = useI18n();
  const sm = useStatusModel();
  const updateTask = useUpdateTask();
  // Body writes get their OWN mutation observer: a property edit through `updateTask` must never
  // detach the in-flight body write (TanStack keeps per-call callbacks for the latest call only).
  const bodyWrite = useUpdateTask();
  const deleteTask = useDeleteTask();
  const { data: featureOptions } = useFeatureOptions();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [parentError, setParentError] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);

  // A status change refused because sub-tasks are still open names them in the owner's
  // language (the status select snaps back on its own: it shows the server's status).
  const onMutationError = (err: Error) => {
    setMutationError(isOpenChildrenRefusal(err) ? openChildrenMessage(t, 'detail', task, allTasks, sm.isTerminal) : err.message);
    setTimeout(() => setMutationError(null), 5000);
  };
  const update = (updates: Updates, onError?: (err: Error) => void) => {
    updateTask.mutate({ slug: task.slug, updates }, { onError: onError ?? onMutationError });
  };

  // ── body writes, serialized ────────────────────────────────────────────────
  // bodySourceRef: the last SERVER body (rollback target). pendingBodyRef: the optimistic body
  // every toggle computes from, updated SYNCHRONOUSLY before the PATCH fires, so a second tick
  // made before the first PATCH resolves builds on it instead of on the stale server copy.
  //
  // Writes are CHAINED: one PATCH in flight at a time. A tick made while one is in flight only
  // marks the body dirty; when the write settles, the latest pending body goes out. And the
  // server's body is adopted only when nothing is in flight or queued — a refetch that lands
  // mid-burst (each PATCH invalidates the list) carries an older body and must not reset ticks.
  const bodySourceRef = useRef(task.body ?? '');
  const pendingBodyRef = useRef<string>(task.body ?? '');
  const inflightRef = useRef(false);
  const queuedRef = useRef(false);
  const [shownBody, setShownBody] = useState(task.body ?? '');
  useEffect(() => {
    bodySourceRef.current = task.body ?? '';
    if (inflightRef.current || queuedRef.current) return;
    pendingBodyRef.current = task.body ?? '';
    setShownBody(task.body ?? '');
  }, [task.body, task.slug]);

  const flushBody = () => {
    inflightRef.current = true;
    queuedRef.current = false;
    const sent = pendingBodyRef.current;
    // Driven by the PROMISE, which settles whatever else is called meanwhile and even after the
    // drawer closes, so a queued tick still goes out instead of the chain stalling.
    bodyWrite.mutateAsync({ slug: task.slug, updates: { body: sent } })
      .then(() => { bodySourceRef.current = sent; })
      .catch((err: Error) => {
        queuedRef.current = false;
        pendingBodyRef.current = bodySourceRef.current;
        setShownBody(bodySourceRef.current);
        onMutationError(err);
      })
      .finally(() => {
        inflightRef.current = false;
        if (queuedRef.current) flushBody();
      });
  };
  const writeBody = (next: string) => {
    pendingBodyRef.current = next;
    setShownBody(next);
    if (inflightRef.current) queuedRef.current = true;
    else flushBody();
  };
  const onToggle = (key: SectionKey, index: number, checked: boolean) => {
    const next = toggleCriterion(pendingBodyRef.current, key, index, checked);
    if (next !== null) writeBody(next);
  };

  // ── relations ──────────────────────────────────────────────────────────────
  const children = useMemo(() => allTasks.filter((t) => t.parent_task === task.slug), [allTasks, task.slug]);
  const parent = task.parent_task ? allTasks.find((t) => t.slug === task.parent_task) ?? null : null;
  const parentProgress = parent ? subtaskProgress(allTasks.filter((t) => t.parent_task === parent.slug), sm) : null;
  const featureName = task.related_feature
    ? (featureOptions ?? []).find((f) => f.slug === task.related_feature)?.name ?? task.related_feature
    : null;
  const open = (slug: string) => onOpenTask?.(slug);

  const handleDelete = async () => {
    const ok = await confirmAction({
      title: `Delete task “${task.name}”?`,
      body: children.length
        ? `Its ${children.length} subtask${children.length === 1 ? '' : 's'} stay, as top-level tasks. This propagates to the remote backend on sync.`
        : 'This propagates to the remote backend on sync.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    deleteTask.mutate(task.slug, { onError: onMutationError, onSuccess: () => onClose?.() });
  };

  // Esc closes the drawer — but never an Esc meant for something inside it: a field being typed
  // in (its draft would be lost), an open picker or menu (they mark their Esc as handled).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input:not([type="checkbox"]):not([type="file"]), textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"], .ss-pop')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A dangling parent link (the parent is gone) reads as top-level.
  const subtasksSlot = (children.length > 0 || !parent)
    ? <SubtasksSection task={task} children={children} onOpen={open} />
    : null;

  return (
    <div className={`detail-overlay ${fullScreen ? 'detail-overlay--fullscreen' : ''}`} onClick={onClose}>
      <div className={`detail-panel ${fullScreen ? 'detail-panel--fullscreen' : ''}`} onClick={(e) => e.stopPropagation()} data-task-slug={task.slug}>
        <DetailHeader
          task={task}
          allTasks={allTasks}
          featureName={featureName}
          parent={parent}
          parentProgress={parentProgress}
          fullScreen={fullScreen}
          onToggleFullScreen={() => setFullScreen((v) => !v)}
          onClose={onClose}
          onOpenTask={open}
          onRename={(name) => update({ name })}
          onError={(msg) => setMutationError(msg)}
        />
        <div className="detail-grid">
          <div className="detail-main">
            {mutationError && <div className="error-state detail-error">{mutationError}</div>}
            <BodySections
              task={task}
              body={shownBody}
              theme={theme}
              onToggle={onToggle}
              slots={{
                // A subtask has no subtasks of its own (two levels max), so it gets no section.
                subtasks: parent ? null : subtasksSlot,
                criteria: <CriteriaSection body={shownBody} onToggle={(i, c) => onToggle('acceptance_criteria', i, c)} />,
                media: <MediaSection task={task} />,
              }}
            />
          </div>
          <PropertiesPanel
            task={task}
            allTasks={allTasks}
            update={update}
            onDelete={handleDelete}
            deleting={deleteTask.isPending}
            parentError={parentError}
            setParentError={setParentError}
          />
        </div>
      </div>
    </div>
  );
}
