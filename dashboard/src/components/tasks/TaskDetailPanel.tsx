import { useState, useMemo, useRef, useEffect } from 'react';
import { marked } from 'marked';
import type { Task } from '../../hooks/useTasks';
import { useUpdateTask, useAddTaskChangelog } from '../../hooks/useTasks';
import { usePlanningVersions } from '../../hooks/useVersions';
import { useI18n } from '../../context/I18nContext';
import './TaskDetailPanel.css';

marked.setOptions({ gfm: true, breaks: true });

interface TaskDetailPanelProps {
  task: Task;
  onClose: () => void;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <div className="prop-value">{children}</div>
    </div>
  );
}

function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // Check after render with clamped class applied
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) setIsTruncated(el.scrollHeight > el.clientHeight + 1);
    });
  }, [text]);

  return (
    <span className="prop-expandable" onClick={() => setExpanded(v => !v)}>
      <span ref={ref} className={`prop-text ${expanded ? '' : 'prop-text--clamped'}`}>{text}</span>
      {isTruncated && !expanded && <span className="prop-expand-hint">show more</span>}
      {expanded && isTruncated && <span className="prop-expand-hint">show less</span>}
    </span>
  );
}

export function TaskDetailPanel({ task, onClose }: TaskDetailPanelProps) {
  const { t } = useI18n();
  const updateTask = useUpdateTask();
  const addChangelog = useAddTaskChangelog();
  const { data: versions } = usePlanningVersions();
  const [changelogEntry, setChangelogEntry] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);

  const onMutationError = (err: Error) => {
    setMutationError(err.message);
    setTimeout(() => setMutationError(null), 5000);
  };

  const handleStatusChange = (status: string) => {
    updateTask.mutate(
      { slug: task.slug, updates: { status: status as Task['status'] } },
      { onError: onMutationError },
    );
  };

  const handlePriorityChange = (priority: string) => {
    updateTask.mutate(
      { slug: task.slug, updates: { priority: priority as Task['priority'] } },
      { onError: onMutationError },
    );
  };

  const handleUrgencyChange = (urgency: string) => {
    updateTask.mutate(
      { slug: task.slug, updates: { urgency: urgency as Task['urgency'] } },
      { onError: onMutationError },
    );
  };

  const handleVersionChange = (version: string) => {
    updateTask.mutate(
      { slug: task.slug, updates: { version: version || null } },
      { onError: onMutationError },
    );
  };

  const handleAddChangelog = (e: React.FormEvent) => {
    e.preventDefault();
    if (!changelogEntry.trim()) return;
    addChangelog.mutate(
      { slug: task.slug, content: changelogEntry.trim() },
      { onSuccess: () => setChangelogEntry(''), onError: onMutationError },
    );
  };

  const bodyHtml = useMemo(() => {
    if (!task.body) return '';
    return marked.parse(task.body) as string;
  }, [task.body]);

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={e => e.stopPropagation()}>
        <div className="detail-header">
          <h2 className="detail-title">{task.name}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="detail-body">
          {mutationError && (
            <div className="error-state" style={{ marginBottom: 'var(--space-3)' }}>{mutationError}</div>
          )}

          {/* Properties Block */}
          <div className="props-block">
            <PropertyRow label="Status">
              <select
                className="field-select prop-select"
                value={task.status}
                onChange={e => handleStatusChange(e.target.value)}
              >
                <option value="todo">{t('tasks.todo')}</option>
                <option value="in_progress">{t('tasks.in_progress')}</option>
                <option value="in_review">{t('tasks.in_review')}</option>
                <option value="completed">{t('tasks.completed')}</option>
              </select>
            </PropertyRow>

            <PropertyRow label={t('tasks.priority')}>
              <select
                className="field-select prop-select"
                value={task.priority}
                onChange={e => handlePriorityChange(e.target.value)}
              >
                <option value="low">{t('priority.low')}</option>
                <option value="medium">{t('priority.medium')}</option>
                <option value="high">{t('priority.high')}</option>
                <option value="critical">{t('priority.critical')}</option>
              </select>
            </PropertyRow>

            <PropertyRow label="Urgency">
              <select
                className="field-select prop-select"
                value={task.urgency}
                onChange={e => handleUrgencyChange(e.target.value)}
              >
                <option value="low">{t('priority.low')}</option>
                <option value="medium">{t('priority.medium')}</option>
                <option value="high">{t('priority.high')}</option>
                <option value="critical">{t('priority.critical')}</option>
              </select>
            </PropertyRow>

            {task.tags.length > 0 && (
              <PropertyRow label="Tags">
                <div className="prop-tags">
                  {task.tags.map(tag => (
                    <span key={tag} className="task-tag">{tag}</span>
                  ))}
                </div>
              </PropertyRow>
            )}

            {task.related_feature && (
              <PropertyRow label="Feature">
                <span className="prop-feature">{task.related_feature}</span>
              </PropertyRow>
            )}

            <PropertyRow label="Version">
              <select
                className="field-select prop-select"
                value={task.version ?? ''}
                onChange={e => handleVersionChange(e.target.value)}
              >
                <option value="">No version</option>
                {(versions ?? []).map(v => (
                  <option key={v.version} value={v.version}>{v.version}</option>
                ))}
                {task.version && !(versions ?? []).some(v => v.version === task.version) && (
                  <option value={task.version}>{task.version}</option>
                )}
              </select>
            </PropertyRow>

            {task.description && (
              <PropertyRow label="Description">
                <ExpandableText text={task.description} />
              </PropertyRow>
            )}

            <PropertyRow label="Created">
              <span className="prop-date">{task.created_at}</span>
            </PropertyRow>

            <PropertyRow label="Updated">
              <span className="prop-date">{task.updated_at}</span>
            </PropertyRow>

            {task.parent_task && (
              <PropertyRow label="Parent">
                <span className="prop-text">{task.parent_task}</span>
              </PropertyRow>
            )}

            <PropertyRow label="ID">
              <code className="prop-id">{task.id}</code>
            </PropertyRow>
          </div>

          {/* Divider */}
          <hr className="detail-divider" />

          {/* Rendered Markdown Body */}
          {bodyHtml ? (
            <div
              className="markdown-body"
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          ) : (
            <p className="detail-empty">No content.</p>
          )}

          {/* Divider */}
          <hr className="detail-divider" />

          {/* Changelog Add */}
          <div className="changelog-section">
            <h3 className="changelog-title">{t('tasks.changelog')}</h3>
            <form onSubmit={handleAddChangelog} className="changelog-add">
              <input
                className="field-input"
                value={changelogEntry}
                onChange={e => setChangelogEntry(e.target.value)}
                placeholder="Add a changelog entry..."
              />
              <button
                type="submit"
                className="btn btn--primary"
                disabled={!changelogEntry.trim() || addChangelog.isPending}
              >
                {addChangelog.isPending ? '...' : t('tasks.add_entry')}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
