import { useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import { TaskCard } from './TaskCard';
import { SubGroupSection } from './SubGroupSection';
import './KanbanColumn.css';

interface SubGroup {
  key: string;
  label: string;
  color?: string;
  tasks: Task[];
}

interface KanbanColumnProps {
  title: string;
  status: string;
  tasks: Task[];
  count: number;
  colorVar: string;
  onTaskClick: (task: Task) => void;
  onTaskContextMenu?: (task: Task, e: React.MouseEvent) => void;
  onDrop: (slug: string, newStatus: string) => void;
  staggerIndex?: number;
  subGroups?: SubGroup[];
}

export function KanbanColumn({ title, status, tasks, count, colorVar, onTaskClick, onTaskContextMenu, onDrop, subGroups }: KanbanColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const slug = e.dataTransfer.getData('text/plain');
    if (slug) {
      onDrop(slug, status);
    }
  };

  const onDragStart = (e: React.DragEvent, task: Task) => {
    e.dataTransfer.setData('text/plain', task.slug);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      className={`kanban-column ${isDragOver ? 'kanban-column--dragover' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="kanban-column-header">
        <span className="kanban-column-dot" style={{ background: `var(${colorVar})` }} />
        <span className="kanban-column-title">{title}</span>
        <span className="kanban-column-count">{count}</span>
      </div>
      <div className="kanban-column-cards">
        {subGroups && subGroups.length > 0 ? (
          subGroups.map(sg => (
            <SubGroupSection
              key={sg.key}
              label={sg.label}
              color={sg.color}
              tasks={sg.tasks}
              onTaskClick={onTaskClick}
              onTaskContextMenu={onTaskContextMenu}
              onDragStart={onDragStart}
            />
          ))
        ) : (
          tasks.map(task => (
            <TaskCard
              key={task.slug}
              task={task}
              onClick={() => onTaskClick(task)}
              onContextMenu={onTaskContextMenu ? (e) => onTaskContextMenu(task, e) : undefined}
              onDragStart={(e) => onDragStart(e, task)}
            />
          ))
        )}
      </div>
    </div>
  );
}
