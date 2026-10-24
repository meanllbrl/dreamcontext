import type { CSSProperties } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useStatusModel } from '../../hooks/useTasks';
import { useVault } from '../../context/VaultContext';
import { taskAssetUrl } from '../../api/client';
import {
  type CardProps,
  assigneeHue, assigneeInitials, criteriaCount, dueInfo, fmtUpdated, levelLabel, prioColor, subtaskProgress,
  tagHue, taskAssignees, taskAgent, taskName, taskRice, urgColor,
} from './boardModel';
import { TaskAgentFace } from './AssignToAgentComposer';
import { BoardSubtasks } from './BoardSubtasks';

interface BoardCardProps {
  task: Task;
  cardProps: CardProps;
  dragging?: boolean;
  assigneeName?: (slug: string) => string;
  /** This parent's children (all of them, not only the visible ones). Empty for a non-parent. */
  subtasks?: Task[];
  subtasksOpen?: boolean;
  onToggleSubtasks?: () => void;
  /** '↑ parent' line: set only for a child whose parent is not on the board. */
  parentName?: string | null;
  /** Show the Versions & Sprints chip (off when the filter is a single version). */
  showVersionChip?: boolean;
  onOpenTask?: (t: Task) => void;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}

const AVATAR_BASE: CSSProperties = {
  flex: '0 0 auto', width: 20, height: 20, borderRadius: '50%', display: 'inline-flex',
  alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 700,
  color: '#fff', fontFamily: 'var(--font-family-text)', boxSizing: 'border-box',
};
const MAX_AVATARS = 3;

/**
 * Overlapping avatar stack for a task's assignees. Renders one badge per
 * assignee (up to {@link MAX_AVATARS}) plus a `+N` overflow chip. `ring` is the
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
            style={{ ...AVATAR_BASE, background: `hsl(${assigneeHue(slug)} 52% 45%)`, marginLeft: i === 0 ? 0 : -6, boxShadow: `0 0 0 2px ${ring}` }}
          >
            {assigneeInitials(slug, nm)}
          </span>
        );
      })}
      {extra > 0 && (
        <span
          title={slugs.slice(MAX_AVATARS).map(nameOf).join(', ')}
          style={{ ...AVATAR_BASE, width: 22, fontSize: 9, color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)', marginLeft: -6, boxShadow: `0 0 0 2px ${ring}` }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

/** A feature slug as a reader-facing name: the last path segment, dashes to spaces, capitalised. */
function featureLabel(slug: string): string {
  const leaf = slug.split('/').pop() || slug;
  const words = leaf.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : slug;
}

/**
 * One board card (approved v4): title, feature line, criteria count, a priority chip, a
 * Versions & Sprints chip, the subtask chip that opens a thin inline list, and the attachment
 * clip. Description, tags, urgency and due stay toggleable under Properties.
 */
export function BoardCard({
  task, cardProps: cp, dragging, assigneeName, subtasks = [], subtasksOpen, onToggleSubtasks, parentName,
  showVersionChip = true, onOpenTask, onClick, onContextMenu, onDragStart, onDragEnd,
}: BoardCardProps) {
  const sm = useStatusModel();
  const { vault } = useVault();
  const di = dueInfo(task, sm);
  const rice = taskRice(task);
  const assignees = taskAssignees(task);
  const name = taskName(task);
  const agent = taskAgent(task);
  const nameOf = (slug: string) => (assigneeName ? assigneeName(slug) : slug);
  const crit = criteriaCount(task);
  const prog = subtaskProgress(subtasks, sm);
  const att = task.attachments;

  const showDue = cp.due && !!di;
  const showRice = cp.rice && rice != null;
  const showVersion = cp.version && showVersionChip && !!task.version;
  const showAssignee = cp.assignee && assignees.length > 0;
  const showSubs = cp.subtasks && subtasks.length > 0;
  const showClip = cp.attachments && !!att && att.count > 0;
  const tags = (task.tags || []).slice(0, 4);

  return (
    <div
      className="bd-card bd-card-hover"
      data-task-slug={task.slug}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{
        background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', borderRadius: 12,
        padding: 12, cursor: 'grab', boxShadow: 'var(--shadow-sm)', position: 'relative',
        transition: 'border-color .14s, box-shadow .14s, transform .14s', opacity: dragging ? 0.4 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 5 }}>
        {cp.urgency && <span style={{ width: 3, height: 13, borderRadius: 2, background: urgColor(task.urgency), flex: '0 0 auto', marginTop: 3 }} />}
        <span className="bd-card-title" style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-family-text)', fontWeight: 600, fontSize: 13.5, color: 'var(--color-text)', letterSpacing: '-0.005em', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{name}</span>
      </div>

      {parentName && <div className="bd-card-parent" title={`Subtask of ${parentName}`}>↑ {parentName}</div>}
      <div className="bd-card-feature">{task.related_feature ? featureLabel(task.related_feature) : 'No feature'}</div>

      {cp.description && task.description && (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.5, margin: '0 0 9px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{task.description}</div>
      )}

      {cp.tags && tags.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
          {tags.map((t) => <span key={t} className="bd-tag" data-hue={tagHue(t)}>{t}</span>)}
        </div>
      )}

      <div className="bd-card-foot">
        {showSubs && (
          <button
            type="button"
            className="bd-sub-chip"
            data-testid="subtask-chip"
            aria-expanded={!!subtasksOpen}
            aria-label={`${prog.done} of ${prog.total} subtasks done`}
            onClick={(e) => { e.stopPropagation(); onToggleSubtasks?.(); }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="bd-sub-caret" aria-hidden>›</span>
            <span className="bd-sub-bar" aria-hidden><span style={{ width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%` }} /></span>
            {prog.done}/{prog.total}
          </button>
        )}
        <span className="bd-card-mono" title="Acceptance criteria done">{crit.total ? `✓ ${crit.done}/${crit.total}` : 'no criteria'}</span>
        {showClip && att && (
          <span className="bd-clip" title={`${att.count} attachment${att.count === 1 ? '' : 's'}`} data-testid="card-clip">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8" /></svg>
            {att.count}
            {att.cover && <img className="bd-clip-cover" src={taskAssetUrl(vault, task.slug, att.cover)} alt="" loading="lazy" />}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 4 }} />
        {showDue && di && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 6, color: di.color, background: di.bg, whiteSpace: 'nowrap' }}>
            {di.glyph && <span style={{ fontSize: 10 }}>{di.glyph}</span>}{di.label}
          </span>
        )}
        {showRice && <span className="bd-card-mono" style={{ color: 'var(--color-accent)' }}>RICE {rice}</span>}
        {cp.priority && (
          <span className="bd-prio-chip" style={{ color: prioColor(task.priority) }}>
            <span className="bd-prio-chip-dot" style={{ background: prioColor(task.priority) }} aria-hidden />
            {levelLabel(task.priority)}
          </span>
        )}
        {showVersion && <span className="bd-ver-chip" title="Versions & Sprints">{task.version}</span>}
        {agent && <TaskAgentFace slug={agent} />}
        {showAssignee && <AvatarStack slugs={assignees} ring="var(--color-bg-elevated)" nameOf={nameOf} />}
        {!cp.priority && !showVersion && <span className="bd-card-mono">{fmtUpdated(task.updated_at)}</span>}
      </div>

      {showSubs && subtasksOpen && <BoardSubtasks parent={task} children={subtasks} onOpen={(t) => onOpenTask?.(t)} />}

      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{levelLabel(task.priority)} priority</span>
    </div>
  );
}
