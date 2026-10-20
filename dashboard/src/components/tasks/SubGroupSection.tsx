import { useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import { TaskCard } from './TaskCard';
import './SubGroupSection.css';

interface SubGroupSectionProps {
  label: string;
  color?: string;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onTaskContextMenu?: (task: Task, e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent, task: Task) => void;
}

export function SubGroupSection({ label, color, tasks, onTaskClick,
  onTaskContextMenu, onDragStart }: SubGroupSectionProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="sub-group">
      <button className="sub-group-header" onClick={() => setCollapsed(v => !v)}>
        <svg
          className={`sub-group-chevron ${collapsed ? '' : 'sub-group-chevron--open'}`}
          width="10" height="10" viewBox="0 0 10 10" fill="none"
        >
          <path d="M3 2L7 5L3 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {color && <span className="sub-group-dot" style={{ background: color }} />}
        <span className="sub-group-label">{label}</span>
        <span className="sub-group-count">{tasks.length}</span>
      </button>
      {!collapsed && (
        <div className="sub-group-cards">
          {tasks.map(task => (
            <TaskCard
              key={task.slug}
              task={task}
              onClick={() => onTaskClick(task)}
              onContextMenu={onTaskContextMenu ? (e) => onTaskContextMenu(task, e) : undefined}
              onDragStart={(e) => onDragStart(e, task)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
