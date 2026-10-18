import type { Task } from '../../hooks/useTasks';
import { useI18n } from '../../context/I18nContext';
import { type CardNode, type CardProps, nestByParent } from './boardModel';
import { BoardCard } from './BoardCard';

export interface BoardSubGroup {
  key: string;
  hasHeader: boolean;
  label?: string;
  color?: string;
  count?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  cards: Task[];
  empty?: boolean;
}

export interface BoardColumnData {
  key: string;
  label: string;
  count: number;
  color: string;
  collapsed: boolean;
  subs: BoardSubGroup[];
  /** Drops into this column are refused (the Done lane). */
  noDrop?: boolean;
}

interface BoardColumnProps {
  col: BoardColumnData;
  /** Every task on the board, to name the parent of a sub-task whose parent is in another column. */
  allTasks: Task[];
  cardProps: CardProps;
  dragId: string | null;
  draggable: boolean;
  isDropTarget?: boolean;
  showDropSilhouette?: boolean;
  assigneeName?: (slug: string) => string;
  onToggleCollapse: () => void;
  onAddTask: () => void;
  onCardClick: (task: Task) => void;
  onCardContextMenu?: (e: React.MouseEvent, task: Task) => void;
  onCardDragStart: (e: React.DragEvent, id: string) => void;
  onCardDragEnd: () => void;
  onColumnDragOver: (e: React.DragEvent) => void;
  onColumnDragLeave?: (e: React.DragEvent) => void;
  onColumnDrop: (e: React.DragEvent) => void;
  /** A card dropped onto another card of this column: rank it there. */
  onCardDrop?: (target: Task) => void;
  isExpanded: (slug: string) => boolean;
  onToggleExpand: (slug: string) => void;
  /** Hidden: on a phone the board shows one column at a time. */
  hidden?: boolean;
}

export function BoardColumn({
  col, allTasks, cardProps, dragId, draggable, isDropTarget, showDropSilhouette, assigneeName,
  onToggleCollapse, onAddTask, onCardClick, onCardContextMenu, onCardDragStart, onCardDragEnd, onColumnDragOver, onColumnDragLeave, onColumnDrop,
  onCardDrop, isExpanded, onToggleExpand, hidden,
}: BoardColumnProps) {
  const { t } = useI18n();
  const card = (task: Task, nested = false) => (
    <BoardCard
      key={task.id}
      task={task}
      cardProps={cardProps}
      dragging={dragId === task.id}
      assigneeName={assigneeName}
      onClick={() => onCardClick(task)}
      onContextMenu={onCardContextMenu ? (e) => onCardContextMenu(e, task) : undefined}
      onDragStart={draggable ? (e) => onCardDragStart(e, task.id) : undefined}
      onDragEnd={onCardDragEnd}
      onDrop={onCardDrop && !nested ? (e) => { e.preventDefault(); e.stopPropagation(); onCardDrop(task); } : undefined}
      expanded={isExpanded(task.slug)}
      onToggleExpand={() => onToggleExpand(task.slug)}
    />
  );
  const node = (n: CardNode) => (
    <div key={n.task.id} className="bd-node">
      {card(n.task)}
      {n.children.length > 0 && isExpanded(n.task.slug) && (
        <div className="bd-nested" role="group" aria-label={t('board.card.subtasksOf').replace('{name}', n.task.name || n.task.slug)}>
          {n.children.map((c) => card(c, true))}
        </div>
      )}
    </div>
  );
  return (
    <div
      className={isDropTarget ? 'bd-col-droptarget' : undefined}
      data-board-column={col.key}
      onDragOver={onColumnDragOver}
      onDragLeave={onColumnDragLeave}
      onDrop={onColumnDrop}
      style={{
        // Grow to share the full board width evenly; fall back to a readable min
        // (then the row scrolls horizontally when there are too many columns).
        flex: '1 1 0', minWidth: 280, display: hidden ? 'none' : 'flex', flexDirection: 'column', minHeight: 0,
        background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)',
        borderTop: `2px solid ${col.color}`, borderRadius: 13, padding: '12px 9px 4px', transition: 'background .12s, border-color .12s',
      }}
    >
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 9, padding: '4px 6px 12px' }}>
        <button type="button" className="bd-col-head" onClick={onToggleCollapse} aria-expanded={!col.collapsed} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1, minWidth: 0, background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left' }}>
          <span style={{ width: 9, height: 9, borderRadius: 3, background: col.color, flex: '0 0 auto' }} />
          <span style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 13.5, color: 'var(--color-text)', letterSpacing: '0.01em', whiteSpace: 'nowrap', flex: '0 1 auto' }}>{col.label}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-text-tertiary)', background: 'var(--color-bg-tertiary)', padding: '1px 7px', borderRadius: 20 }}>{col.count}</span>
        </button>
        <button type="button" className="bd-hover bd-hover-text bd-col-add" onClick={onAddTask} title={t('board.column.add')} aria-label={t('board.column.add')} style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, cursor: 'pointer', color: 'var(--color-text-tertiary)', fontSize: 15, flex: '0 0 auto', background: 'none', border: 'none' }}>+</button>
      </div>

      {!col.collapsed && (
        <div className="bd-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, padding: '1px 3px 8px' }}>
          {showDropSilhouette && (
            <div className="bd-drop-silhouette" style={{ marginBottom: col.subs.some((s) => s.cards.length) ? -4 : 0 }}>{t('board.column.drop')}</div>
          )}
          {col.subs.map((sub) => (
            <div key={sub.key}>
              {sub.hasHeader && (
                <div role="button" tabIndex={0} aria-expanded={!sub.collapsed} onClick={sub.onToggleCollapse} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sub.onToggleCollapse?.(); } }} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 6px 8px', cursor: 'pointer' }}>
                  <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', transition: 'transform .15s', transform: sub.collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>▸</span>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: sub.color, flex: '0 0 auto' }} />
                  <span style={{ fontFamily: 'var(--font-family-text)', fontWeight: 600, fontSize: 11.5, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>{sub.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>{sub.count}</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
                </div>
              )}
              {!sub.collapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {nestByParent(sub.cards, allTasks).map((item) => (item.kind === 'card' ? node(item.node) : (
                    <div key={`parent:${item.parent.slug}`} className="bd-orphans">
                      <div className="bd-orphans-head" lang="und">{item.parent.name}</div>
                      {item.nodes.map(node)}
                    </div>
                  )))}
                  {(sub.empty || (sub.cards.length === 0 && !sub.hasHeader)) && (
                    <div style={{ padding: 14, border: '1px dashed var(--color-border)', borderRadius: 10, textAlign: 'center', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{t('board.column.empty')}</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
