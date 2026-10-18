import { KanbanBoard } from '../components/tasks/KanbanBoard';
import type { FocusTarget } from '../hooks/useFocusTarget';

interface TasksPageProps {
  focus?: FocusTarget;
  /** Opens one task as its own page (a card click, ⌘K, the Brain map). */
  onOpenTask?: (slug: string) => void;
}

export function TasksPage({ focus, onOpenTask }: TasksPageProps = {}) {
  // Fill the shell-main content height so the board is full-height regardless of
  // content (empty states / Timeline shrink without this). The board
  // root is height:100%; this wrapper completes the chain to shell-main.
  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      <KanbanBoard focus={focus} onOpenTask={onOpenTask} />
    </div>
  );
}
