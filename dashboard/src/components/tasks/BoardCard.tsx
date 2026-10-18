import type { CSSProperties, KeyboardEvent } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useStatusModel } from '../../hooks/useTasks';
import { useI18n } from '../../context/I18nContext';
import {
  type CardProps,
  assigneeHue, assigneeInitials, dueInfo, fmtUpdated, tagHue, taskAssignees,
  taskAgent, taskName, taskVersion,
} from './boardModel';
import { TaskAgentFace } from './AssignToAgentComposer';
import { fill } from '../../lib/fill';

interface BoardCardProps {
  task: Task;
  cardProps: CardProps;
  dragging?: boolean;
  variant?: 'board' | 'list';
  assigneeName?: (slug: string) => string;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  /** A drop of another card onto this one (ranking within a column). */
  onDrop?: (e: React.DragEvent) => void;
  /** Whether the sub-tasks nested under this card are shown (parent cards only). */
  expanded?: boolean;
  onToggleExpand?: () => void;
}

/** Enter or Space on a focused card opens it, as a click does. */
const activate = (open: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
};

const AVATAR_BASE: CSSProperties = {
  flex: '0 0 auto', width: 20, height: 20, borderRadius: '50%', display: 'inline-flex',
  alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 700,
  color: '#fff', fontFamily: 'var(--font-family-text)', boxSizing: 'border-box',
};
const MAX_AVATARS = 3;

/**
 * Overlapping avatar stack for a task's assignees. Renders one badge per
 * assignee (up to {@link MAX_AVATARS}) plus a `+N` overflow chip — fixes the
 * card showing only the primary assignee on multi-assignee tasks. `ring` is the
 * surface the stack sits on, so overlapping badges read with a clean gap.
 */
function AvatarStack({ slugs, ring, nameOf }: { slugs: string[]; ring: string; nameOf: (s: string) => string }) {
  const shown = slugs.slice(0, MAX_AVATARS);
  const extra = slugs.length - shown.length;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', flex: '0 0 auto' }}>
      {shown.map((slug, i) => {
        const nm = nameOf(slug);
        return (
          <span
            key={slug}
            title={nm}
            style={{
              ...AVATAR_BASE,
              background: `hsl(${assigneeHue(slug)} 52% 45%)`,
              marginLeft: i === 0 ? 0 : -6,
              boxShadow: `0 0 0 2px ${ring}`,
            }}
          >
            {assigneeInitials(slug, nm)}
          </span>
        );
      })}
      {extra > 0 && (
        <span
          title={slugs.slice(MAX_AVATARS).map(nameOf).join(', ')}
          style={{
            ...AVATAR_BASE, width: 22, fontSize: 9, color: 'var(--color-text-secondary)',
            background: 'var(--color-bg-tertiary)', marginLeft: -6, boxShadow: `0 0 0 2px ${ring}`,
          }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

export function BoardCard({ task, cardProps: cp, dragging, variant = 'board', assigneeName, onClick, onContextMenu, onDragStart, onDragEnd, onDrop, expanded, onToggleExpand }: BoardCardProps) {
  const { t } = useI18n();
  const sm = useStatusModel();
  const di = dueInfo(task, sm);
  const ver = task.version;
  const assignees = taskAssignees(task);
  const name = taskName(task);
  const agent = taskAgent(task);
  const nameOf = (slug: string) => (assigneeName ? assigneeName(slug) : slug);

  const showDue = cp.due && !!di;
  const showVersion = cp.version && !!ver;
  const showAssignee = cp.assignee && assignees.length > 0;
  const showMeta = showDue || showVersion;
  const tags = (task.tags || []).slice(0, 4);
  // A parent card says how many of its sub-tasks are done, and opens them in place.
  const kids = task.children;
  const rollup = kids && kids.total > 0 ? (
    <button
      type="button"
      className="bd-rollup"
      aria-expanded={onToggleExpand ? !!expanded : undefined}
      aria-label={fill(t('board.card.subtasks'), { done: String(kids.done), total: String(kids.total) })}
      onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
      disabled={!onToggleExpand}
    >
      {onToggleExpand && <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>}
      {`${kids.done}/${kids.total}`}
    </button>
  ) : null;

  if (variant === 'list') {
    return (
      <div
        className="bd-card bd-card-hover"
        role="button"
        tabIndex={0}
        data-task-card={task.slug}
        onClick={onClick}
        onKeyDown={activate(onClick)}
        onContextMenu={onContextMenu}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderRadius: 10,
          border: '1px solid transparent', cursor: 'pointer', background: 'transparent',
        }}
      >
        <span lang="und" style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13.5, color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        {rollup}
        {cp.tags && (
          <div style={{ display: 'flex', gap: 5, flex: '0 0 auto' }}>
            {tags.slice(0, 2).map((t) => <span key={t} className="bd-tag" data-hue={tagHue(t)}>{t}</span>)}
          </div>
        )}
        {showDue && di && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 6, color: di.color, background: di.bg, whiteSpace: 'nowrap', flex: '0 0 auto' }}>{di.label}</span>
        )}
        {agent && <TaskAgentFace slug={agent} />}
        {showAssignee && <AvatarStack slugs={assignees} ring="var(--color-bg-elevated)" nameOf={nameOf} />}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', width: 74, textAlign: 'right' }}>{fmtUpdated(task.updated_at)}</span>
      </div>
    );
  }

  return (
    <div
      className="bd-card bd-card-hover"
      role="button"
      tabIndex={0}
      data-task-card={task.slug}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDrop ? (e) => e.preventDefault() : undefined}
      onDrop={onDrop}
      onClick={onClick}
      onKeyDown={activate(onClick)}
      onContextMenu={onContextMenu}
      style={{
        background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', borderRadius: 12,
        padding: 12, cursor: onDragStart ? 'grab' : 'pointer', boxShadow: 'var(--shadow-sm)',
        transition: 'border-color .14s, box-shadow .14s, transform .14s', opacity: dragging ? 0.4 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span lang="und" style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-family-text)', fontWeight: 600, fontSize: 13.5, color: 'var(--color-text)', letterSpacing: '-0.005em', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{name}</span>
        {rollup}
      </div>

      {cp.description && task.description && (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.5, margin: '0 0 9px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{task.description}</div>
      )}

      {showMeta && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 9 }}>
          {showDue && di && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 6, color: di.color, background: di.bg, whiteSpace: 'nowrap' }}>
              {di.glyph && <span style={{ fontSize: 10 }}>{di.glyph}</span>}{di.label}
            </span>
          )}
          {showVersion && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)', background: 'var(--color-bg-tertiary)', padding: '2px 7px', borderRadius: 6 }}>{taskVersion(task) === 'none' ? '—' : ver}</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {cp.tags && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
            {tags.map((t) => <span key={t} className="bd-tag" data-hue={tagHue(t)}>{t}</span>)}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 4 }} />
        {agent && <TaskAgentFace slug={agent} />}
        {showAssignee && <AvatarStack slugs={assignees} ring="var(--color-bg-elevated)" nameOf={nameOf} />}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>{fmtUpdated(task.updated_at)}</span>
      </div>

    </div>
  );
}
