import type { Task } from '../../../hooks/useTasks';
import { GiveToAgentMenu } from './GiveToAgentMenu';

/**
 * The drawer's header: a crumb (the feature, or for a subtask "↑ parent · n/m", which opens the
 * parent), the title (editable in place: Enter or blur saves, Esc reverts), "Give to agent",
 * fullscreen and close.
 */
export function DetailHeader({
  task, featureName, parent, parentProgress, fullScreen, onToggleFullScreen, onClose, onOpenTask, onRename, onError,
}: {
  task: Task;
  featureName: string | null;
  parent: Task | null;
  parentProgress: { done: number; total: number } | null;
  fullScreen: boolean;
  onToggleFullScreen: () => void;
  onClose: () => void;
  onOpenTask: (slug: string) => void;
  onRename: (name: string) => void;
  onError: (msg: string) => void;
}) {
  return (
    <div className="detail-header">
      <div className="detail-head-main">
        <div className="detail-crumb">
          {parent ? (
            <button type="button" className="detail-crumb-parent" data-testid="crumb-parent" onClick={() => onOpenTask(parent.slug)} title={`Open ${parent.name}`}>
              ↑ <span className="detail-crumb-parent-name">{parent.name || parent.slug}</span>
              {parentProgress && <span className="detail-crumb-count">{parentProgress.done}/{parentProgress.total}</span>}
            </button>
          ) : (
            <span className="detail-crumb-feature">{featureName ?? 'No feature'}</span>
          )}
          <span className="detail-crumb-sep" aria-hidden>›</span>
          <span>{parent ? 'Subtask' : 'Task'}</span>
        </div>
        <h2
          className="detail-title"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          role="textbox"
          aria-label="Task title"
          key={`${task.slug}-${task.name}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement).blur(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).textContent = task.name; (e.currentTarget as HTMLElement).blur(); }
          }}
          onBlur={(e) => {
            const next = (e.currentTarget.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (!next) { e.currentTarget.textContent = task.name; return; }
            if (next !== task.name) onRename(next);
          }}
        >
          {task.name}
        </h2>
      </div>
      <div className="detail-header-actions">
        <GiveToAgentMenu task={task} onError={onError} />
        <button
          type="button"
          className="detail-icon-btn"
          onClick={onToggleFullScreen}
          title={fullScreen ? 'Exit full-page view' : 'Open in full page'}
          aria-label={fullScreen ? 'Exit full-page view' : 'Open in full page'}
        >
          {fullScreen ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" /></svg>
          )}
        </button>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
      </div>
    </div>
  );
}
