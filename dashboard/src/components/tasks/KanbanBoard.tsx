import { useMemo, useState, useCallback, useEffect, type CSSProperties } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useTasks, useUpdateTask, useDeleteTask, useTaskMembers, useStatusModel, isOpenChildrenRefusal } from '../../hooks/useTasks';
import { useI18n } from '../../context/I18nContext';
import { useVault } from '../../context/VaultContext';
import { publishPageDetail } from '../../lib/pageContext';
import { openChildrenMessage } from '../../lib/taskObjection';
import { useFocusTarget, type FocusTarget } from '../../hooks/useFocusTarget';
import { useVersions, useActiveVersion } from '../../hooks/useVersions';
import { useBoardState } from '../../hooks/useBoard';
import { confirmAction } from '../../lib/desktop';
import {
  type SaveScope,
  PRIO_ORDER,
  activeFilterCount, dimGroups, dueInfo, filterTasks, levelLabel, nestChildren, prioColor, sortTasks, taskAssignees,
} from './boardModel';
import { BoardViewTabs } from './BoardViewTabs';
import { BoardToolbar, type MenuKey } from './BoardToolbar';
import { BoardColumn, type BoardColumnData } from './BoardColumn';
import { SleepEvalBanner } from './SleepEvalDeck';
import { SaveScopeDialog } from './SaveScopeDialog';
import { TaskDetailPanel } from './TaskDetailPanel';
import { TaskCreateModal } from './TaskCreateModal';
import { AuthorTaskComposer } from './AuthorTaskComposer';
import { useAgentCapabilities, isSleepAgentReady } from '../../hooks/useAgentCapabilities';
import { readAgentSettings, AGENT_SETTINGS_EVENT } from '../../lib/agentSettings';
import './Board.css';

const AVATAR_PALETTE = ['#9d8cff', '#4aa8ff', '#4ade80', '#f0abfc', '#fbbf24', '#5eead4', '#f9a8d4'];
const distinct = (xs: string[]): string[] => Array.from(new Set(xs));

type PendingSave = { mode: 'save' | 'create'; name?: string } | null;

export function KanbanBoard({ focus }: { focus?: FocusTarget } = {}) {
  const { t } = useI18n();
  const sm = useStatusModel();
  const s = useBoardState();
  // The open view and its filter count, for the Super dock's page chip (lib/pageContext.ts).
  const { bus } = useVault();
  const viewName = s.activeView?.name;
  const filterCount = activeFilterCount(s.filters);
  useEffect(() => {
    publishPageDetail(bus, 'tasks', { page: 'tasks', view: viewName, filters: filterCount });
    return () => publishPageDetail(bus, 'tasks', null);
  }, [bus, viewName, filterCount]);
  const { data: tasks = [], isLoading } = useTasks();
  const { data: members = [] } = useTaskMembers();
  const { data: realVersions = [] } = useVersions();
  const { data: activeVersion = null } = useActiveVersion();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  // Desktop-only gate for "Author with agent": the in-app agent needs a real embedded
  // terminal + the claude CLI (so it's hidden on the web build / when prereqs are missing,
  // A6) AND the Agents surface must be enabled in Settings. Same readiness check the
  // header's Sleep tracker uses, plus the live `enabled` flag (kept in sync via the same
  // event the Settings page broadcasts on save).
  const { data: agentCaps } = useAgentCapabilities();
  const [agentSettings, setAgentSettings] = useState(() => readAgentSettings());
  useEffect(() => {
    const onChange = () => setAgentSettings(readAgentSettings());
    window.addEventListener(AGENT_SETTINGS_EVENT, onChange);
    return () => window.removeEventListener(AGENT_SETTINGS_EVENT, onChange);
  }, []);
  const agentReady = isSleepAgentReady(agentCaps, agentSettings.chatView) && agentSettings.enabled;

  const [openMenu, setOpenMenu] = useState<MenuKey>(null);
  const [viewMenuId, setViewMenuId] = useState<string | null>(null);
  const [colCollapsed, setColCollapsed] = useState<Record<string, boolean>>({});
  // Which parents have their subtask list open — kept for this board session only.
  const [subtasksOpen, setSubtasksOpen] = useState<Record<string, boolean>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; task: Task } | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showAuthor, setShowAuthor] = useState(false);
  const [pendingSave, setPendingSave] = useState<PendingSave>(null);
  const [toast, setToast] = useState<{ msg: string; refused: boolean } | null>(null);

  const flash = useCallback((msg: string, refused = false) => { setToast({ msg, refused }); }, []);
  // A refusal says what to do next, so it stays long enough to be read.
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.refused ? 6000 : 1900); return () => clearTimeout(timer); }, [toast]);

  // Open the task the ⌘K palette / Brain map navigated to in the TaskDetailPanel.
  useFocusTarget(focus, (slug) => setSelectedSlug(slug));

  const closeAllMenus = useCallback(() => { setOpenMenu(null); setViewMenuId(null); }, []);
  // Esc closes an open toolbar / view menu (keyboard users have no click-away).
  useEffect(() => {
    if (openMenu === null && viewMenuId === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeAllMenus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openMenu, viewMenuId, closeAllMenus]);

  // ── derived option data ──────────────────────────────────────────────────────
  const memberMap = useMemo(() => new Map(members.map((m) => [m.slug, m.name])), [members]);
  const assignees = useMemo(() => {
    const present = distinct(tasks.flatMap(taskAssignees));
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
  const filtered = useMemo(() => filterTasks(tasks, s.filters, s.search, versionMeta, sm), [tasks, s.filters, s.search, versionMeta, sm]);
  const groupOpts = useMemo(() => ({ versionOrder: versionsForFilter, assignees, statuses: sm }), [versionsForFilter, assignees, sm]);
  // Subtasks ride inside their parent's card when the parent is visible; the chip and the
  // inline list read ALL of a parent's children (a filter never hides how much is left).
  const nested = useMemo(() => nestChildren(filtered), [filtered]);
  const allChildren = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) if (t.parent_task) m.set(t.parent_task, [...(m.get(t.parent_task) ?? []), t]);
    return m;
  }, [tasks]);
  const taskBySlug = useMemo(() => new Map(tasks.map((t) => [t.slug, t])), [tasks]);
  // Card lookups for BoardColumn → BoardCard (stable per data change).
  const topSlugs = useMemo(() => new Set(nested.top.map((t) => t.slug)), [nested]);
  const childrenOf = useCallback((slug: string) => (topSlugs.has(slug) ? allChildren.get(slug) ?? [] : []), [topSlugs, allChildren]);
  const parentNameOf = useCallback((t: Task) => {
    if (!t.parent_task) return null;
    const p = taskBySlug.get(t.parent_task);
    // A dangling link (the parent is gone) draws no '↑' line: the task reads as top-level.
    return p ? (p.name || p.slug) : null;
  }, [taskBySlug]);
  // Only drawn on a card whose parent is NOT folding it in (the parent is filtered out).
  const nestedSlugs = useMemo(() => new Set([...nested.childrenByParent.values()].flat().map((t) => t.slug)), [nested]);
  const singleVersion = s.filters.version.inc.length === 1;

  const columns: { data: BoardColumnData; colKey: string }[] = useMemo(() => {
    return dimGroups('status', nested.top, groupOpts).map((col) => {
      const colKey = `status:${col.key}`;
      const cards = sortTasks(col.tasks, s.sortBy, s.sortDir);
      return { colKey, data: { key: col.key, label: col.label, count: cards.length, color: col.color, collapsed: !!colCollapsed[colKey], subs: [{ key: '_all', hasHeader: false, cards }] } };
    });
  }, [s.sortBy, s.sortDir, nested, groupOpts, colCollapsed]);

  const viewCounts = useMemo(() => {
    const m: Record<string, number> = {};
    s.views.forEach((v) => { m[v.id] = filterTasks(tasks, v.config.filters, v.config.search, versionMeta, sm).length; });
    return m;
  }, [s.views, tasks, versionMeta, sm]);

  // ── overdue chip (the tab row's right side; replaces the red Attention banner) ──────
  // Live = not terminal by KIND (a cancelled-kind task is never overdue).
  const overdueCount = useMemo(
    () => tasks.filter((t) => !sm.isTerminal(t.status) && dueInfo(t, sm)?.kind === 'overdue').length,
    [tasks, sm],
  );

  // ── status moves (drag, right-click) ───────────────────────────────────────────
  // The card's column comes from the server's status, so a refused move leaves it where it
  // was; the toast says so, and "Moved to" only shows once the move landed. A parent with open
  // sub-tasks is refused (409 parent_has_open_children): name them from the list we hold.
  // The promise, not per-call callbacks: TanStack keeps those for the latest call only, so a
  // second move made before this one answers would swallow its refusal.
  const moveStatus = useCallback((task: Task, status: string) => {
    updateTask.mutateAsync({ slug: task.slug, updates: { status } as Partial<Task> }).then(
      () => flash(`Moved to ${sm.labelOf(status)}`),
      (err: Error) => flash(isOpenChildrenRefusal(err)
        ? openChildrenMessage(t, 'board', task, tasks, sm.isTerminal, err.message)
        : err.message, true),
    );
  }, [updateTask, flash, sm, t, tasks]);

  // ── drag + drop (patch the status) ─────────────────────────────────────────────
  const draggable = true;
  const onCardDragStart = useCallback((e: React.DragEvent, id: string) => { setDragId(id); try { e.dataTransfer.effectAllowed = 'move'; } catch { /* noop */ } }, []);
  const endDrag = useCallback(() => { setDragId(null); setDragOverKey(null); }, []);
  // The column key the dragged card currently lives in — used to suppress the
  // landing silhouette on its source column (a no-op drop).
  const dragSourceKey = useMemo(() => {
    if (!dragId) return null;
    const task = tasks.find((t) => t.id === dragId);
    return task ? task.status : null;
  }, [dragId, tasks]);
  const onColumnDrop = useCallback((colValue: string) => {
    const id = dragId;
    endDrag();
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === colValue) return;
    moveStatus(task, colValue);
  }, [dragId, tasks, endDrag, moveStatus]);

  // ── right-click context menu ─────────────────────────────────────────────────────
  const openCtxMenu = useCallback((e: React.MouseEvent, task: Task) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, task });
  }, []);
  const ctxSetStatus = useCallback((task: Task, status: string) => {
    if (task.status !== status) moveStatus(task, status);
    setCtxMenu(null);
  }, [moveStatus]);
  const ctxSetPriority = useCallback((task: Task, priority: string) => {
    if (task.priority !== priority) { updateTask.mutate({ slug: task.slug, updates: { priority } as Partial<Task> }); flash(`Priority → ${levelLabel(priority)}`); }
    setCtxMenu(null);
  }, [updateTask, flash]);
  // Writes ONLY the tag: the backend's "backlog ⇒ undated" rule clears the
  // dates itself, so this button cannot drift into a second definition of what
  // backlog means.
  const ctxSendToBacklog = useCallback((task: Task) => {
    setCtxMenu(null);
    if (task.tags.some((t) => t.toLowerCase() === 'backlog')) return;
    updateTask.mutate(
      { slug: task.slug, updates: { tags: [...task.tags, 'backlog'] } as Partial<Task> },
      { onSuccess: () => flash('Sent to backlog'), onError: () => flash('Could not send to backlog', true) },
    );
  }, [updateTask, flash]);
  const ctxDelete = useCallback(async (task: Task) => {
    setCtxMenu(null);
    const ok = await confirmAction({
      title: `Delete “${task.name || task.slug}”?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    deleteTask.mutate(task.slug, { onSuccess: () => flash('Task deleted'), onError: () => flash('Delete failed', true) });
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

  if (!s.ready || isLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 240, color: 'var(--color-text-tertiary)', fontSize: 13 }}>Loading board…</div>;
  }

  const activeName = s.activeView?.name ?? 'view';
  const pendingTitle = pendingSave?.mode === 'create' ? `Create “${pendingSave.name || 'New view'}”` : `Save “${activeName}”`;
  const pendingDefaultScope: SaveScope = s.activeView?.origin === 'local' || s.activeView?.hasLocalOverride ? 'local' : 'shared';
  const isEmpty = filtered.length === 0;

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
        overdue={overdueCount}
        onOverdue={() => { s.setDue('risk'); closeAllMenus(); }}
      />

      <BoardToolbar
        s={s}
        allTasks={tasks}
        allTags={allTags}
        assignees={assignees}
        singleVersion={singleVersion}
        versionsForFilter={versionsForFilter}
        activeVersion={activeVersion}
        releasedVersions={releasedVersions}
        openMenu={openMenu}
        setOpenMenu={setOpenMenu}
        onNewTask={() => setShowCreate(true)}
        onAuthorWithAgent={() => setShowAuthor(true)}
        agentReady={agentReady}
        flash={flash}
      />

      <SleepEvalBanner />

      <div className="bd-scroll" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--color-bg)', overflow: 'hidden' }}>
        {isEmpty ? (
          <EmptyState onClear={s.clearAllFilters} />
        ) : (
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
                childrenOf={childrenOf}
                parentNameOf={(t) => (nestedSlugs.has(t.slug) ? null : parentNameOf(t))}
                showVersionChip={!singleVersion}
                subtasksOpen={subtasksOpen}
                onToggleSubtasks={(slug) => setSubtasksOpen((m) => ({ ...m, [slug]: !m[slug] }))}
                onOpenTask={(t) => setSelectedSlug(t.slug)}
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
          onSendToBacklog={ctxSendToBacklog}
          onSetStatus={ctxSetStatus}
          onSetPriority={ctxSetPriority}
          onDelete={ctxDelete}
        />
      )}

      {selectedTask && (
        <TaskDetailPanel
          key={selectedTask.slug}
          task={selectedTask}
          allTasks={tasks}
          onOpenTask={(slug) => setSelectedSlug(slug)}
          onClose={() => setSelectedSlug(null)}
        />
      )}
      {showCreate && <TaskCreateModal onClose={() => setShowCreate(false)} />}
      {showAuthor && (
        <AuthorTaskComposer
          onClose={() => setShowAuthor(false)}
          onStarted={() => flash('Authoring agent started — it works in the corner')}
        />
      )}
      {pendingSave && <SaveScopeDialog title={pendingTitle} defaultScope={pendingDefaultScope} onPick={handlePickScope} onCancel={() => setPendingSave(null)} />}

      {toast && (
        <div className="bd-pop" role={toast.refused ? 'alert' : 'status'} data-testid="board-toast" style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: 9, padding: '10px 16px', borderRadius: 11, background: 'var(--color-bg-elevated)', border: `1px solid ${toast.refused ? 'var(--color-error)' : 'var(--color-border)'}`, boxShadow: 'var(--shadow-lg)', fontSize: 13, color: 'var(--color-text)', width: 'max-content', maxWidth: 'min(560px, calc(100% - 32px))', lineHeight: 1.45 }}>
          <span style={{ color: toast.refused ? 'var(--color-error)' : 'var(--color-accent)', flexShrink: 0 }}>{toast.refused ? '!' : '✓'}</span>{toast.msg}
        </div>
      )}
    </div>
  );
}

interface CtxMenuState { x: number; y: number; task: Task }
function TaskContextMenu({ menu, onClose, onOpen, onSetStatus, onSetPriority, onSendToBacklog, onDelete }: {
  menu: CtxMenuState;
  onClose: () => void;
  onOpen: (t: Task) => void;
  onSetStatus: (t: Task, status: string) => void;
  onSetPriority: (t: Task, priority: string) => void;
  onSendToBacklog: (t: Task) => void;
  onDelete: (t: Task) => void;
}) {
  const sm = useStatusModel();
  const { task } = menu;
  // The collapsed menu is short (≈ 220×190px); submenus fly out to the side. Handing a task to
  // an agent lives in the task's own "Give to agent" button, never here.
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
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: sm.colorOf(task.status), flex: '0 0 auto' }} />
            <span style={{ flex: 1 }}>Move to status</span>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{sm.labelOf(task.status)}</span>
            {chevron}
          </div>
          {openSub === 'status' && (
            <div className="bd-pop" style={flyout}>
              {sm.order.map((st) => (
                <div key={st} className="bd-row" onClick={() => onSetStatus(task, st)} style={row}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: sm.colorOf(st), flex: '0 0 auto' }} />
                  <span style={{ flex: 1 }}>{sm.labelOf(st)}</span>
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

        {/* Backlog is a TAG, not a status, so it never appeared in this menu and
            had to be typed by hand. One row writes it. Hidden once the task is
            already there rather than shown as a no-op. */}
        {!task.tags.some((t) => t.toLowerCase() === 'backlog') && (
          <div className="bd-row" onClick={() => onSendToBacklog(task)} style={row}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M3 7h18M3 12h18M3 17h18" /></svg>
            <span style={{ flex: 1 }}>Send to backlog</span>
          </div>
        )}

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
