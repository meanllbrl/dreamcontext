import { useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import { TaskCard } from './TaskCard';
import {
  QUADRANTS,
  quadrantOf,
  computeMove,
  summarizeMove,
  isNoOpMove,
  type QuadrantKey,
} from './eisenhower';
import './EisenhowerMatrix.css';

interface EisenhowerMatrixProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  /**
   * Called when a task is dragged into a quadrant whose priority/urgency bucket
   * differs from the task's current one. Omit to render a read-only matrix.
   */
  onTaskMove?: (slug: string, updates: Partial<Pick<Task, 'priority' | 'urgency'>>) => void;
}

interface LastMove {
  slug: string;
  name: string;
  toLabel: string;
  prev: { priority: Task['priority']; urgency: Task['urgency'] };
}

export function EisenhowerMatrix({ tasks, onTaskClick, onTaskMove }: EisenhowerMatrixProps) {
  const activeTasks = tasks.filter(t => t.status !== 'completed');
  const [dragOverKey, setDragOverKey] = useState<QuadrantKey | null>(null);
  const [draggingSlug, setDraggingSlug] = useState<string | null>(null);
  const [lastMove, setLastMove] = useState<LastMove | null>(null);
  const interactive = !!onTaskMove;

  const draggingTask = draggingSlug ? activeTasks.find(t => t.slug === draggingSlug) ?? null : null;
  const sourceKey = draggingTask ? quadrantOf(draggingTask) : null;

  const handleDragStart = (e: React.DragEvent, task: Task) => {
    e.dataTransfer.setData('text/plain', task.slug);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingSlug(task.slug);
  };

  const endDrag = () => {
    setDraggingSlug(null);
    setDragOverKey(null);
  };

  const handleDragOver = (e: React.DragEvent, key: QuadrantKey) => {
    if (!interactive) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverKey !== key) setDragOverKey(key);
  };

  const handleDrop = (e: React.DragEvent, key: QuadrantKey) => {
    if (!onTaskMove) return;
    e.preventDefault();
    const slug = e.dataTransfer.getData('text/plain');
    endDrag();
    if (!slug) return;
    const task = activeTasks.find(t => t.slug === slug);
    if (!task) return;
    const updates = computeMove(task, key);
    if (isNoOpMove(updates)) return;
    onTaskMove(slug, updates);
    const target = QUADRANTS.find(q => q.key === key);
    setLastMove({
      slug,
      name: task.name,
      toLabel: target?.label ?? key,
      prev: { priority: task.priority, urgency: task.urgency },
    });
  };

  const handleUndo = () => {
    if (!lastMove || !onTaskMove) return;
    onTaskMove(lastMove.slug, { priority: lastMove.prev.priority, urgency: lastMove.prev.urgency });
    setLastMove(null);
  };

  return (
    <div className={`eisenhower${draggingTask ? ' eisenhower--dragging' : ''}`}>
      {interactive && lastMove && (
        <div className="eisenhower-undo" role="status">
          <span className="eisenhower-undo-text">
            Moved <strong>{lastMove.name}</strong> → {lastMove.toLabel}
          </span>
          <button type="button" className="eisenhower-undo-btn" onClick={handleUndo}>
            Undo
          </button>
          <button
            type="button"
            className="eisenhower-undo-dismiss"
            aria-label="Dismiss"
            onClick={() => setLastMove(null)}
          >
            ×
          </button>
        </div>
      )}
      <div className="eisenhower-grid" onDragEnd={endDrag}>
        {QUADRANTS.map(q => {
          const qTasks = activeTasks.filter(t => quadrantOf(t) === q.key);
          const isOver = dragOverKey === q.key;
          const isSource = sourceKey === q.key;
          // Live preview of what dropping here would change.
          const preview = isOver && draggingTask ? computeMove(draggingTask, q.key) : null;
          const previewLabel = preview
            ? isNoOpMove(preview)
              ? 'Already here'
              : summarizeMove(preview)
            : null;

          const cls = [
            'eisenhower-quadrant',
            `eisenhower-quadrant--${q.key}`,
            isOver ? 'eisenhower-quadrant--dragover' : '',
            isSource ? 'eisenhower-quadrant--source' : '',
            isOver && preview && isNoOpMove(preview) ? 'eisenhower-quadrant--noop' : '',
          ].filter(Boolean).join(' ');

          return (
            <div
              key={q.key}
              className={cls}
              onDragOver={(e) => handleDragOver(e, q.key)}
              onDragLeave={() => setDragOverKey(prev => (prev === q.key ? null : prev))}
              onDrop={(e) => handleDrop(e, q.key)}
            >
              <div className="eisenhower-quadrant-header">
                <span className="eisenhower-quadrant-dot" style={{ background: `var(${q.colorVar})` }} />
                <span className="eisenhower-quadrant-label">{q.label}</span>
                <span className="eisenhower-quadrant-count">{qTasks.length}</span>
              </div>
              {previewLabel ? (
                <span className="eisenhower-quadrant-preview">{previewLabel}</span>
              ) : (
                <span className="eisenhower-quadrant-subtitle">{q.subtitle}</span>
              )}
              <div className="eisenhower-quadrant-cards">
                {qTasks.map(task => (
                  <TaskCard
                    key={task.slug}
                    task={task}
                    onClick={() => onTaskClick(task)}
                    onDragStart={(e) => handleDragStart(e, task)}
                    dragging={draggingSlug === task.slug}
                  />
                ))}
                {interactive && qTasks.length === 0 && (
                  <div className="eisenhower-quadrant-empty">Drop tasks here</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="eisenhower-x-label">
        <span className="eisenhower-axis-hi">Urgent</span>
        <span className="eisenhower-axis-lo">Not Urgent</span>
      </div>
    </div>
  );
}
