import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useUpdateTask, useDeleteTask, useFeatureOptions, useStatusModel } from '../../hooks/useTasks';
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
  const sm = useStatusModel();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const { data: featureOptions } = useFeatureOptions();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [parentError, setParentError] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);

  const onMutationError = (err: Error) => {
    setMutationError(err.message);
    setTimeout(() => setMutationError(null), 5000);
  };
  const update = (updates: Updates, onError?: (err: Error) => void) => {
    updateTask.mutate({ slug: task.slug, updates }, { onError: onError ?? onMutationError });
  };

  // ── body writes, serialized ────────────────────────────────────────────────
  // bodySourceRef: the last SERVER body (rollback target). pendingBodyRef: the optimistic body
  // every toggle computes from, updated SYNCHRONOUSLY before the PATCH fires, so a second tick
  // made before the first PATCH resolves builds on it instead of on the stale server copy.
  const bodySourceRef = useRef(task.body ?? '');
  const pendingBodyRef = useRef<string>(task.body ?? '');
  const [shownBody, setShownBody] = useState(task.body ?? '');
  useEffect(() => {
    bodySourceRef.current = task.body ?? '';
    pendingBodyRef.current = task.body ?? '';
    setShownBody(task.body ?? '');
  }, [task.body, task.slug]);

  const writeBody = (next: string) => {
    pendingBodyRef.current = next;
    setShownBody(next);
    updateTask.mutate(
      { slug: task.slug, updates: { body: next } },
      {
        onError: (err: Error) => {
          pendingBodyRef.current = bodySourceRef.current;
          setShownBody(bodySourceRef.current);
          onMutationError(err);
        },
      },
    );
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

  // Esc closes the drawer (inner menus and inputs stop their own Esc first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const subtasksSlot = (children.length > 0 || !task.parent_task)
    ? <SubtasksSection task={task} children={children} onOpen={open} />
    : null;

  return (
    <div className={`detail-overlay ${fullScreen ? 'detail-overlay--fullscreen' : ''}`} onClick={onClose}>
      <div className={`detail-panel ${fullScreen ? 'detail-panel--fullscreen' : ''}`} onClick={(e) => e.stopPropagation()} data-task-slug={task.slug}>
        <DetailHeader
          task={task}
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
                subtasks: task.parent_task ? null : subtasksSlot,
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
