import { useMemo, useState, useCallback, useEffect, type CSSProperties } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useTasks, useUpdateTask, useDeleteTask, useTaskMembers } from '../../hooks/useTasks';
import { useVersions, useActiveVersion } from '../../hooks/useVersions';
import { useBoardState } from '../../hooks/useBoard';
import {
  type Dim, type SaveScope,
  PRIO_ORDER, STATUS_META, STATUS_ORDER,
  dimGet, dimGroups, dueInfo, filterTasks, levelLabel, prioColor, sortTasks, taskAssignee,
} from './boardModel';
import { BoardViewTabs } from './BoardViewTabs';
import { BoardToolbar, type MenuKey } from './BoardToolbar';
import { BoardColumn, type BoardColumnData, type BoardSubGroup } from './BoardColumn';
import { BoardCard } from './BoardCard';
import { AtRiskAlert } from './AtRiskAlert';
import { SaveScopeDialog } from './SaveScopeDialog';
import { TaskDetailPanel } from './TaskDetailPanel';
import { TaskCreateModal } from './TaskCreateModal';
import { EisenhowerMatrix } from './EisenhowerMatrix';
import { RiceScatter } from './RiceScatter';
import { TimelineGantt } from './TimelineGantt';
import { TaskCalendar } from './TaskCalendar';
import { ActivityHeatmap } from './ActivityHeatmap';
import './Board.css';

const AVATAR_PALETTE = ['#9d8cff', '#4aa8ff', '#4ade80', '#f0abfc', '#fbbf24', '#5eead4', '#f9a8d4'];
const distinct = (xs: string[]): string[] => Array.from(new Set(xs));

type PendingSave = { mode: 'save' | 'create'; name?: string } | null;

export function KanbanBoard() {
  const s = useBoardState();
  const { data: tasks = [], isLoading } = useTasks();
  const { data: members = [] } = useTaskMembers();
  const { data: realVersions = [] } = useVersions();
  const { data: activeVersion = null } = useActiveVersion();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const [openMenu, setOpenMenu] = useState<MenuKey>(null);
  const [viewMenuId, setViewMenuId] = useState<string | null>(null);
  const [colCollapsed, setColCollapsed] = useState<Record<string, boolean>>({});
  const [subCollapsed, setSubCollapsed] = useState<Record<string, boolean>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; task: Task } | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingSave, setPendingSave] = useState<PendingSave>(null);
  const [dismissedAlert, setDismissedAlert] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((msg: string) => { setToast(msg); }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 1900); return () => clearTimeout(t); }, [toast]);

  const closeAllMenus = useCallback(() => { setOpenMenu(null); setViewMenuId(null); }, []);

  // ── derived option data ──────────────────────────────────────────────────────
  const memberMap = useMemo(() => new Map(members.map((m) => [m.slug, m.name])), [members]);
  const assignees = useMemo(() => {
    const present = distinct(tasks.map(taskAssignee)).filter((a) => a !== 'none');
    const values = distinct([...members.map((m) => m.slug), ...present]);
    const list = values.map((v, i) => ({ value: v, label: memberMap.get(v) || v.replace(/[-_]/g, ' '), color: AVATAR_PALETTE[i % AVATAR_PALETTE.length] }));
    return [...list, { value: 'none', label: 'Unassigned', color: 'var(--color-text-tertiary)' }];
  }, [tasks, members, memberMap]);
  const assigneeName = useCallback((slug: string) => (slug === 'none' ? 'Unassigned' : memberMap.get(slug) || slug), [memberMap]);
  const allTags = useMemo(() => distinct(tasks.flatMap((t) => t.tags)).sort(), [tasks]);
  const versionsForFilter = useMemo(
    () => distinct([...realVersions.map((v) => v.version), ...tasks.map((t) => t.version).filter((v): v is string => !!v)]),
    [realVersions, tasks],
  );
  const releasedVersions = useMemo(
    () => realVersions.filter((v) => v.status === 'released').map((v) => v.version),
    [realVersions],
  );
  // Resolves the version filter's virtual buckets (Current / Backlog / Completed).
  const versionMeta = useMemo(
    () => ({ active: activeVersion, released: releasedVersions }),
    [activeVersion, releasedVersions],
  );

  // ── filtering / grouping ──────────────────────────────────────────────────────
  const filtered = useMemo(() => filterTasks(tasks, s.filters, s.search, versionMeta), [tasks, s.filters, s.search, versionMeta]);
  const groupOpts = useMemo(() => ({ versionOrder: versionsForFilter, assignees }), [versionsForFilter, assignees]);

  const columns: { data: BoardColumnData; colKey: string }[] = useMemo(() => {
    return dimGroups(s.groupBy, filtered, groupOpts).map((col) => {
      const colKey = `${s.groupBy}:${col.key}`;
      let subs: BoardSubGroup[];
      if (s.subGroupBy === 'none') {
        subs = [{ key: '_all', hasHeader: false, cards: sortTasks(col.tasks, s.sortBy, s.sortDir) }];
      } else {
        const sg = dimGroups(s.subGroupBy as Dim, col.tasks, groupOpts).filter((x) => x.tasks.length);
        subs = sg.map((x) => {
          const subKey = `${colKey}|${x.key}`;
          return { key: x.key, hasHeader: true, label: x.label, color: x.color, count: x.tasks.length, collapsed: !!subCollapsed[subKey], onToggleCollapse: () => setSubCollapsed((m) => ({ ...m, [subKey]: !m[subKey] })), cards: sortTasks(x.tasks, s.sortBy, s.sortDir) };
        });
        if (!subs.length) subs = [{ key: '_e', hasHeader: false, cards: [], empty: true }];
      }
      return { colKey, data: { key: col.key, label: col.label, count: col.tasks.length, color: col.color, collapsed: !!colCollapsed[colKey], subs } };
    });
  }, [s.groupBy, s.subGroupBy, s.sortBy, s.sortDir, filtered, groupOpts, colCollapsed, subCollapsed]);

  const viewCounts = useMemo(() => {
    const m: Record<string, number> = {};
    s.views.forEach((v) => { m[v.id] = filterTasks(tasks, v.config.filters, v.config.search, versionMeta).length; });
    return m;
  }, [s.views, tasks, versionMeta]);

  // ── at-risk alert ──────────────────────────────────────────────────────────────
  const atRisk = useMemo(() => {
    const open = tasks.filter((t) => t.status !== 'completed');
    let overdue = 0, today = 0, soon = 0;
    open.forEach((t) => { const di = dueInfo(t); if (!di) return; if (di.kind === 'overdue') overdue++; else if (di.kind === 'today') today++; else if (di.kind === 'soon' || di.kind === 'week') soon++; });
    return { overdue, today, soon };
  }, [tasks]);
  const showAlert = !dismissedAlert && (atRisk.overdue > 0 || atRisk.today > 0);

  // ── drag + drop (patch the grouped dimension) ───────────────────────────────────
  const draggable = s.layout === 'board';
  const onCardDragStart = useCallback((e: React.DragEvent, id: string) => { setDragId(id); try { e.dataTransfer.effectAllowed = 'move'; } catch { /* noop */ } }, []);
  const endDrag = useCallback(() => { setDragId(null); setDragOverKey(null); }, []);
  // The column key the dragged card currently lives in — used to suppress the
  // landing silhouette on its source column (a no-op drop).
  const dragSourceKey = useMemo(() => {
    if (!dragId) return null;
    const task = tasks.find((t) => t.id === dragId);
    return task ? dimGet(task, s.groupBy as Dim) : null;
  }, [dragId, tasks, s.groupBy]);
  const onColumnDrop = useCallback((colValue: string) => {
    const id = dragId;
    endDrag();
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const field = s.groupBy as Dim;
    const value = colValue === 'none' && (field === 'version' || field === 'assignee') ? null : colValue;
    if ((task[field as keyof Task] ?? 'none') === (value ?? 'none')) return;
    updateTask.mutate({ slug: task.slug, updates: { [field]: value } as Partial<Task> });
    flash(`Updated ${field}`);
  }, [dragId, tasks, s.groupBy, updateTask, flash, endDrag]);

  // ── right-click context menu ─────────────────────────────────────────────────────
  const openCtxMenu = useCallback((e: React.MouseEvent, task: Task) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, task });
  }, []);
  const ctxSetStatus = useCallback((task: Task, status: string) => {
    if (task.status !== status) { updateTask.mutate({ slug: task.slug, updates: { status } as Partial<Task> }); flash(`Moved to ${STATUS_META[status]?.label ?? status}`); }
    setCtxMenu(null);
  }, [updateTask, flash]);
  const ctxSetPriority = useCallback((task: Task, priority: string) => {
    if (task.priority !== priority) { updateTask.mutate({ slug: task.slug, updates: { priority } as Partial<Task> }); flash(`Priority → ${levelLabel(priority)}`); }
    setCtxMenu(null);
  }, [updateTask, flash]);
  const ctxDelete = useCallback((task: Task) => {
    setCtxMenu(null);
    if (typeof window !== 'undefined' && !window.confirm(`Delete “${task.name || task.slug}”? This cannot be undone.`)) return;
    deleteTask.mutate(task.slug, { onSuccess: () => flash('Task deleted'), onError: () => flash('Delete failed') });
    if (selectedSlug === task.slug) setSelectedSlug(null);
  }, [deleteTask, flash, selectedSlug]);

  // ── view actions ────────────────────────────────────────────────────────────────
  const handleRequestSave = useCallback(() => { setPendingSave({ mode: 'save' }); closeAllMenus(); }, [closeAllMenus]);
  // "+ New view" creates a blank view (Kanban, no filters) immediately and returns
  // its id so the tab bar can enter rename mode. No name prompt, no scope dialog.
  const handleCreateBlank = useCallback((): string => { closeAllMenus(); const id = s.createBlankView(); flash('New view created'); return id; }, [s, flash, closeAllMenus]);
  const handlePickScope = useCallback((scope: SaveScope) => {
    if (!pendingSave) return;
    s.saveView(scope);
    flash(scope === 'shared' ? 'Saved for everyone' : 'Saved for yourself');
    setPendingSave(null);
  }, [pendingSave, s, flash]);

  const selectedTask = selectedSlug ? tasks.find((t) => t.slug === selectedSlug) || null : null;
  const onTaskMove = useCallback((slug: string, updates: Partial<Pick<Task, 'priority' | 'urgency'>>) => updateTask.mutate({ slug, updates }), [updateTask]);

  if (!s.ready || isLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 240, color: 'var(--color-text-tertiary)', fontSize: 13 }}>Loading board…</div>;
  }

  const activeName = s.activeView?.name ?? 'view';
  const pendingTitle = pendingSave?.mode === 'create' ? `Create “${pendingSave.name || 'New view'}”` : `Save “${activeName}”`;
  const pendingDefaultScope: SaveScope = s.activeView?.origin === 'local' || s.activeView?.hasLocalOverride ? 'local' : 'shared';
  const isEmpty = filtered.length === 0;
  const isAdvanced = ['eisenhower', 'scatter', 'timeline', 'calendar', 'heatmap'].includes(s.layout);

  return (
    <div style={{ height: 'calc(100dvh - var(--header-height) - 2 * var(--space-4))', maxHeight: 'calc(100dvh - var(--header-height) - 2 * var(--space-4))', display: 'flex', flexDirection: 'column', position: 'relative', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
      <BoardViewTabs
        views={s.views}
        activeViewId={s.activeViewId}
        counts={viewCounts}
        isDirty={s.isDirty}
        menuOpenId={viewMenuId}
        onMenuToggle={setViewMenuId}
        onApply={(id) => { s.applyView(id); closeAllMenus(); }}
        onRequestSave={handleRequestSave}
        onReset={s.resetView}
        onCreateBlank={handleCreateBlank}
        onRename={s.renameView}
        onDuplicate={s.duplicateView}
        onDelete={s.deleteView}
      />

      <BoardToolbar
        s={s}
        allTasks={tasks}
        allTags={allTags}
        assignees={assignees}
        versionsForFilter={versionsForFilter}
        activeVersion={activeVersion}
        releasedVersions={releasedVersions}
        openMenu={openMenu}
        setOpenMenu={setOpenMenu}
        onNewTask={() => setShowCreate(true)}
        flash={flash}
      />

      {showAlert && (
        <AtRiskAlert
          overdue={atRisk.overdue}
          today={atRisk.today}
          soon={atRisk.soon}
          onFocus={() => { s.setDue('risk'); setDismissedAlert(true); }}
          onDismiss={() => setDismissedAlert(true)}
        />
      )}

      <div className="bd-scroll" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--color-bg)', overflow: isAdvanced ? 'auto' : 'hidden' }}>
        {isEmpty && !isAdvanced ? (
          <EmptyState onClear={s.clearAllFilters} />
        ) : s.layout === 'board' ? (
          <div
            className="bd-scroll"
            // Clear the active column only when the pointer leaves the whole board
            // row. Per-column dragleave is intentionally NOT used: that boundary
            // fires on every child-card crossing and on the silhouette reflow, and
            // WKWebView (Tauri) frequently reports a null relatedTarget mid-drag —
            // both would clear dragOverKey for a frame and flicker the silhouette.
            // dragOverKey is re-set by the next column's dragover and is always
            // cleared on drop/dragend via endDrag().
            onDragLeave={(e) => {
              if (!draggable) return;
              const rt = e.relatedTarget as Node | null;
              if (rt && !e.currentTarget.contains(rt)) setDragOverKey(null);
            }}
            style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14, padding: '16px 16px 18px', overflowX: 'auto', overflowY: 'hidden' }}
          >
            {columns.map(({ data, colKey }) => (
              <BoardColumn
                key={colKey}
                col={data}
                cardProps={s.cardProps}
                dragId={dragId}
                draggable={draggable}
                isDropTarget={!!dragId && dragOverKey === data.key}
                showDropSilhouette={!!dragId && dragOverKey === data.key && dragSourceKey !== data.key}
                assigneeName={assigneeName}
                onToggleCollapse={() => setColCollapsed((m) => ({ ...m, [colKey]: !m[colKey] }))}
                onAddTask={() => setShowCreate(true)}
                onCardClick={(t) => setSelectedSlug(t.slug)}
                onCardContextMenu={openCtxMenu}
                onCardDragStart={onCardDragStart}
                onCardDragEnd={endDrag}
                onColumnDragOver={(e) => { if (draggable) { e.preventDefault(); if (dragOverKey !== data.key) setDragOverKey(data.key); } }}
                onColumnDrop={(e) => { if (draggable) { e.preventDefault(); onColumnDrop(data.key); } }}
              />
            ))}
          </div>
        ) : s.layout === 'list' ? (
          <div className="bd-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 18px 20px' }}>
            {columns.map(({ data, colKey }) => (
              <div key={colKey} style={{ marginBottom: 22 }}>
                <div onClick={() => setColCollapsed((m) => ({ ...m, [colKey]: !m[colKey] }))} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 4px 10px', cursor: 'pointer', position: 'sticky', top: 0, background: 'var(--color-bg)', zIndex: 2 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: data.color, flex: '0 0 auto' }} />
                  <span style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 14, color: 'var(--color-text)' }}>{data.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-text-tertiary)', background: 'var(--color-bg-tertiary)', padding: '1px 8px', borderRadius: 20 }}>{data.count}</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
                </div>
                {!data.collapsed && data.subs.map((sub) => (
                  <div key={sub.key}>
                    {sub.hasHeader && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 6px 5px' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: sub.color, flex: '0 0 auto' }} />
                        <span style={{ fontFamily: 'var(--font-family-text)', fontWeight: 600, fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>{sub.label}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>{sub.count}</span>
                      </div>
                    )}
                    {sub.cards.map((t) => (
                      <BoardCard key={t.id} task={t} cardProps={s.cardProps} variant="list" assigneeName={assigneeName} onClick={() => setSelectedSlug(t.slug)} onContextMenu={(e) => openCtxMenu(e, t)} />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column' }}>
            {s.layout === 'eisenhower' && <EisenhowerMatrix tasks={filtered} onTaskClick={(t) => setSelectedSlug(t.slug)} onTaskMove={onTaskMove} />}
            {s.layout === 'scatter' && <RiceScatter tasks={filtered} onTaskClick={(t) => setSelectedSlug(t.slug)} />}
            {s.layout === 'timeline' && <TimelineGantt tasks={filtered} onTaskClick={(t) => setSelectedSlug(t.slug)} />}
            {s.layout === 'calendar' && <TaskCalendar tasks={filtered} onTaskClick={(t) => setSelectedSlug(t.slug)} />}
            {s.layout === 'heatmap' && <ActivityHeatmap tasks={filtered} />}
          </div>
        )}
      </div>

      {/* click-away for toolbar / view popovers */}
      {(openMenu !== null || viewMenuId !== null) && (
        <div onClick={closeAllMenus} style={{ position: 'absolute', inset: 0, zIndex: 35 }} />
      )}

      {ctxMenu && (
        <TaskContextMenu
          menu={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onOpen={(t) => { setSelectedSlug(t.slug); setCtxMenu(null); }}
          onSetStatus={ctxSetStatus}
          onSetPriority={ctxSetPriority}
          onDelete={ctxDelete}
        />
      )}

      {selectedTask && <TaskDetailPanel task={selectedTask} onClose={() => setSelectedSlug(null)} />}
      {showCreate && <TaskCreateModal onClose={() => setShowCreate(false)} />}
      {pendingSave && <SaveScopeDialog title={pendingTitle} defaultScope={pendingDefaultScope} onPick={handlePickScope} onCancel={() => setPendingSave(null)} />}

      {toast && (
        <div className="bd-pop" style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: 9, padding: '10px 16px', borderRadius: 11, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-lg)', fontSize: 13, color: 'var(--color-text)' }}>
          <span style={{ color: 'var(--color-accent)' }}>✓</span>{toast}
        </div>
      )}
    </div>
  );
}

interface CtxMenuState { x: number; y: number; task: Task }
function TaskContextMenu({ menu, onClose, onOpen, onSetStatus, onSetPriority, onDelete }: {
  menu: CtxMenuState;
  onClose: () => void;
  onOpen: (t: Task) => void;
  onSetStatus: (t: Task, status: string) => void;
  onSetPriority: (t: Task, priority: string) => void;
  onDelete: (t: Task) => void;
}) {
  const { task } = menu;
  // The collapsed menu is short now (≈ 220×190px); submenus fly out to the side.
  const W = 220, H = 190, SUB_W = 188;
  const left = typeof window !== 'undefined' ? Math.min(menu.x, window.innerWidth - W - 8) : menu.x;
  const top = typeof window !== 'undefined' ? Math.min(menu.y, window.innerHeight - H - 8) : menu.y;
  // Flip the flyout to the left when the main menu sits too close to the right edge.
  const flipLeft = typeof window !== 'undefined' && left + W + SUB_W + 8 > window.innerWidth;

  const [openSub, setOpenSub] = useState<'status' | 'priority' | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)' };
  const chevron = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto', opacity: 0.6 }}><path d="m9 18 6-6-6-6" /></svg>
  );

  // Style for a flyout submenu that sits beside the parent row.
  const flyout: CSSProperties = {
    position: 'absolute', top: -6, zIndex: 72, width: SUB_W,
    ...(flipLeft ? { right: '100%' } : { left: '100%' }),
    background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
    borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6,
  };

  return (
    <>
      <div onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
      <div className="bd-pop" style={{ position: 'fixed', left, top, zIndex: 71, width: W, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6 }}>
        <div className="bd-row" onClick={() => onOpen(task)} style={row}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></svg>
          <span style={{ flex: 1 }}>Open details</span>
        </div>

        <div style={{ height: 1, background: 'var(--color-border)', margin: '5px 4px' }} />

        {/* Move to status — collapsed, flyout submenu */}
        <div style={{ position: 'relative' }} onMouseEnter={() => setOpenSub('status')} onMouseLeave={() => setOpenSub(null)}>
          <div className="bd-row" onClick={() => setOpenSub(s => (s === 'status' ? null : 'status'))} style={{ ...row, ...(openSub === 'status' ? { background: 'var(--color-bg-secondary)' } : {}) }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_META[task.status]?.color ?? 'var(--color-text-tertiary)', flex: '0 0 auto' }} />
            <span style={{ flex: 1 }}>Move to status</span>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{STATUS_META[task.status]?.label ?? task.status}</span>
            {chevron}
          </div>
          {openSub === 'status' && (
            <div className="bd-pop" style={flyout}>
              {STATUS_ORDER.map((st) => (
                <div key={st} className="bd-row" onClick={() => onSetStatus(task, st)} style={row}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_META[st].color, flex: '0 0 auto' }} />
                  <span style={{ flex: 1 }}>{STATUS_META[st].label}</span>
                  {task.status === st && <span style={{ color: 'var(--color-accent)', fontSize: 12 }}>✓</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Set priority — collapsed, flyout submenu */}
        <div style={{ position: 'relative' }} onMouseEnter={() => setOpenSub('priority')} onMouseLeave={() => setOpenSub(null)}>
          <div className="bd-row" onClick={() => setOpenSub(s => (s === 'priority' ? null : 'priority'))} style={{ ...row, ...(openSub === 'priority' ? { background: 'var(--color-bg-secondary)' } : {}) }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: prioColor(task.priority), flex: '0 0 auto' }} />
            <span style={{ flex: 1 }}>Set priority</span>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{levelLabel(task.priority)}</span>
            {chevron}
          </div>
          {openSub === 'priority' && (
            <div className="bd-pop" style={flyout}>
              {PRIO_ORDER.map((p) => (
                <div key={p} className="bd-row" onClick={() => onSetPriority(task, p)} style={row}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: prioColor(p), flex: '0 0 auto' }} />
                  <span style={{ flex: 1 }}>{levelLabel(p)}</span>
                  {task.priority === p && <span style={{ color: 'var(--color-accent)', fontSize: 12 }}>✓</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ height: 1, background: 'var(--color-border)', margin: '5px 4px' }} />
        <div className="bd-row bd-danger" onClick={() => onDelete(task)} style={{ ...row, color: 'var(--color-text-secondary)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
          <span style={{ flex: 1 }}>Delete task</span>
        </div>
      </div>
    </>
  );
}

function EmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, textAlign: 'center', padding: 40 }}>
      <div style={{ width: 60, height: 60, borderRadius: 16, background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, color: 'var(--color-text-tertiary)' }}>⌕</div>
      <div style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 19, color: 'var(--color-text)' }}>No tasks match these filters</div>
      <div style={{ fontSize: 13.5, color: 'var(--color-text-tertiary)', maxWidth: 360, lineHeight: 1.5 }}>Try clearing a filter or widening your search. Your saved views stay put.</div>
      <span className="bd-chip" onClick={onClear} style={{ marginTop: 4, padding: '8px 16px', borderRadius: 9, cursor: 'pointer', background: 'var(--color-accent-soft)', color: 'var(--color-accent)', fontSize: 13, fontWeight: 600, border: '1px solid var(--color-accent)' }}>Clear all filters</span>
    </div>
  );
}
