import type { CSSProperties } from 'react';
import type { Task } from '../../hooks/useTasks';
import {
  type CardProps,
  assigneeInitials, dueInfo, fmtUpdated, levelLabel, prioColor, tagHue, taskAssignee,
  taskName, taskRice, taskVersion, urgColor,
} from './boardModel';

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
}

const dot = (color: string): CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: color, flex: '0 0 auto' });
const bar = (color: string): CSSProperties => ({ width: 3, height: 13, borderRadius: 2, background: color, flex: '0 0 auto' });

export function BoardCard({ task, cardProps: cp, dragging, variant = 'board', assigneeName, onClick, onContextMenu, onDragStart, onDragEnd }: BoardCardProps) {
  const di = dueInfo(task);
  const rice = taskRice(task);
  const ver = task.version;
  const asg = taskAssignee(task);
  const name = taskName(task);
  const aName = assigneeName ? assigneeName(asg) : asg;

  const showDue = cp.due && !!di;
  const showRice = cp.rice && rice != null;
  const showVersion = cp.version && !!ver;
  const showAssignee = cp.assignee && asg !== 'none';
  const showMeta = showDue || showRice || showVersion;
  const tags = (task.tags || []).slice(0, 4);

  const avatar: CSSProperties = {
    flex: '0 0 auto', width: 20, height: 20, borderRadius: '50%', display: 'flex',
    alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 700,
    color: '#fff', background: 'var(--color-accent)', fontFamily: 'var(--font-family-text)',
  };

  if (variant === 'list') {
    return (
      <div
        className="bd-card bd-card-hover"
        onClick={onClick}
        onContextMenu={onContextMenu}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderRadius: 10,
          border: '1px solid transparent', cursor: 'pointer', background: 'transparent',
        }}
      >
        {cp.priority && <span style={dot(prioColor(task.priority))} />}
        {cp.urgency && <span style={bar(urgColor(task.urgency))} />}
        <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13.5, color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        {cp.tags && (
          <div style={{ display: 'flex', gap: 5, flex: '0 0 auto' }}>
            {tags.slice(0, 2).map((t) => <span key={t} className="bd-tag" data-hue={tagHue(t)}>{t}</span>)}
          </div>
        )}
        {showDue && di && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 6, color: di.color, background: di.bg, whiteSpace: 'nowrap', flex: '0 0 auto' }}>{di.label}</span>
        )}
        {showAssignee && <span style={avatar} title={aName}>{assigneeInitials(asg, aName)}</span>}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', width: 74, textAlign: 'right' }}>{fmtUpdated(task.updated_at)}</span>
      </div>
    );
  }

  return (
    <div
      className="bd-card bd-card-hover"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{
        background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', borderRadius: 12,
        padding: 12, cursor: 'grab', boxShadow: 'var(--shadow-sm)',
        transition: 'border-color .14s, box-shadow .14s, transform .14s', opacity: dragging ? 0.4 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {cp.priority && <span style={dot(prioColor(task.priority))} />}
        {cp.urgency && <span style={bar(urgColor(task.urgency))} />}
        <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-family-text)', fontWeight: 600, fontSize: 13.5, color: 'var(--color-text)', letterSpacing: '-0.005em', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{name}</span>
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
          {showRice && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, color: 'var(--color-accent)', background: 'var(--color-accent-soft)', padding: '2px 7px', borderRadius: 6 }}>RICE {rice}</span>
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
        {showAssignee && <span style={avatar} title={aName}>{assigneeInitials(asg, aName)}</span>}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>{fmtUpdated(task.updated_at)}</span>
      </div>

      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{levelLabel(task.priority)} priority</span>
    </div>
  );
}
