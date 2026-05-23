import type { Task } from '../../hooks/useTasks';
import { tagHue } from '../../lib/tagColor';
import './TaskCard.css';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
}

export function TaskCard({ task, onClick, onDragStart }: TaskCardProps) {
  return (
    <div
      className="task-card"
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
    >
      <div className="task-card-header">
        <span className={`priority-dot priority-dot--${task.priority}`} title={`Priority: ${task.priority}`} />
        {task.urgency && task.urgency !== 'medium' && (
          <span className={`urgency-bar urgency-bar--${task.urgency}`} title={`Urgency: ${task.urgency}`} />
        )}
        <span className="task-card-name">{task.name}</span>
      </div>
      {task.description && (
        <p className="task-card-desc">{task.description.slice(0, 100)}{task.description.length > 100 ? '...' : ''}</p>
      )}
      <div className="task-card-footer">
        {task.tags.length > 0 && (
          <div className="task-card-tags">
            {task.tags.slice(0, 3).map(tag => (
              <span key={tag} className="task-tag" data-hue={tagHue(tag)}>{tag}</span>
            ))}
          </div>
        )}
        <span className="task-card-date">{task.updated_at}</span>
      </div>
    </div>
  );
}
