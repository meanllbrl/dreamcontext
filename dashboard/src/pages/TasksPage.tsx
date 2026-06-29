import { KanbanBoard } from '../components/tasks/KanbanBoard';

export function TasksPage() {
  // Fill the shell-main content height so the board is full-height regardless of
  // content (empty states / Timeline / Calendar shrink without this). The board
  // root is height:100%; this wrapper completes the chain to shell-main.
  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      <KanbanBoard />
    </div>
  );
}
