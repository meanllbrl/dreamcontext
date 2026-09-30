import { useTasks } from '../../../hooks/useTasks';
import { emitInstance, useVault } from '../../../context/VaultContext';
import { isValidWidgetRef } from '../widgetModel';
import { useWbText } from '../whiteboardHost';
import { WidgetButton, WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';

/**
 * A task on the board: name, status, priority, due date, and an Open button that lands on it
 * in the Tasks page through the app's existing open-page event (on this project's bus only).
 */
export function TaskWidget({ payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const { bus } = useVault();
  const ref = isValidWidgetRef(payload.ref) ? payload.ref : null;
  const { data, isLoading, isError } = useTasks();
  const task = ref ? data?.find((t) => t.slug === ref) : undefined;
  const title = payload.title || task?.name || ref || tx('whiteboard.kind.task', 'Task');

  let body;
  if (!ref) {
    body = <WidgetNotice tone="missing">{tx('whiteboard.widget.badRef', 'This widget has no valid reference.')}</WidgetNotice>;
  } else if (isLoading) {
    body = <WidgetNotice tone="loading">{tx('whiteboard.widget.loading', 'Loading…')}</WidgetNotice>;
  } else if (isError) {
    body = <WidgetNotice tone="error">{tx('whiteboard.widget.loadFailed', 'Could not load this.')}</WidgetNotice>;
  } else if (!task) {
    body = (
      <WidgetNotice tone="missing">
        {tx('whiteboard.task.notFound', 'Task not found:')}&nbsp;<code>{ref}</code>
      </WidgetNotice>
    );
  } else {
    // S: the name and one meta line. M and up: the description under it, then the chips.
    const due = task.due_date ? `${tx('whiteboard.task.due', 'due')} ${task.due_date}` : '';
    const summary = task.description && task.description !== task.name ? task.description : '';
    body = (
      <div className="wb-entity">
        <p className="wb-entity-title">{title}</p>
        {size === 's' ? (
          <p className="wb-entity-meta">
            <span className={`wb-status-dot wb-status-dot--${task.status}`} aria-hidden />
            {[task.status, due].filter(Boolean).join(' · ')}
          </p>
        ) : (
          <>
            {summary && <p className="wb-entity-summary">{summary}</p>}
            <div className="wb-widget-meta">
              <span className="wb-widget-chip">
                <span className={`wb-status-dot wb-status-dot--${task.status}`} aria-hidden />{task.status}
              </span>
              <span className="wb-widget-chip">{task.priority}</span>
              {due && <span className="wb-widget-chip">{due}</span>}
              {task.assignee && <span className="wb-widget-chip">@{task.assignee}</span>}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <WidgetFrame
      kind="task"
      title={task ? '' : title}
      active={active}
      size={size}
      actions={task && (
        <WidgetButton onClick={() => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'tasks', id: task.slug })}>
          {tx('whiteboard.widget.open', 'Open')}
        </WidgetButton>
      )}
    >
      {body}
    </WidgetFrame>
  );
}
