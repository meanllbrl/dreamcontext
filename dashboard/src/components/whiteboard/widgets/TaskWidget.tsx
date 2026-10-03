import { useTasks } from '../../../hooks/useTasks';
import { emitInstance, useVault } from '../../../context/VaultContext';
import { humaniseSlug, isValidWidgetRef, stampedTitle, taskTitle } from '../widgetModel';
import { usePagePopup } from '../PagePopup';
import { useWbText } from '../whiteboardHost';
import { PageBody } from './KnowledgeWidget';
import { WidgetButton, WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';

/**
 * A task on the board: name, status, priority, due date. Opening it, by the Open button or a
 * click on the card once it is active, reads the task's own markdown file in the board's page
 * popup; the popup's "Open in Tasks" is the way to the Tasks page.
 */
export function TaskWidget({ payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const { bus } = useVault();
  const popup = usePagePopup();
  const ref = isValidWidgetRef(payload.ref) ? payload.ref : null;
  const { data, isLoading, isError } = useTasks();
  const task = ref ? data?.find((t) => t.slug === ref) : undefined;
  // A title stamped as the bare slug (older pickers did) reads as no title; the label stays "Task".
  const title = stampedTitle(payload.title, ref) || (task ? taskTitle(task) : ref ? humaniseSlug(ref) : '')
    || tx('whiteboard.kind.task', 'Task');

  const open = () => {
    if (!task) return;
    if (popup?.openPage({ kind: 'task', ref: task.slug })) return;
    // Outside a board page there is no popup: the task opens where it lives.
    emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'tasks', id: task.slug });
  };

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
      <PageBody onOpen={open}>
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
      </PageBody>
    );
  }

  return (
    <WidgetFrame
      kind="task"
      title={task ? '' : title}
      active={active}
      size={size}
      actions={task && (
        <WidgetButton onClick={open}>{tx('whiteboard.widget.open', 'Open')}</WidgetButton>
      )}
    >
      {body}
    </WidgetFrame>
  );
}
