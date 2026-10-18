import { useMemo, useState, useCallback, useEffect, type CSSProperties } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useTasks, useUpdateTask, useDeleteTask, useTaskMembers, useStatusModel, usePlanTask, useRankTask } from '../../hooks/useTasks';
import { useCycles } from '../../hooks/useCycles';
import { useFocusTarget, type FocusTarget } from '../../hooks/useFocusTarget';
import { useVersions, useActiveVersion } from '../../hooks/useVersions';
import { useBoardState } from '../../hooks/useBoard';
import { confirmAction } from '../../lib/desktop';
import {
  type Dim, type OrderLane, type SaveScope,
  dimGet, dimGroups, dueInfo, filterTasks, sortTasks, taskAssignees,
} from './boardModel';
import { orderOf } from './taskOrder';
import { BoardViewTabs } from './BoardViewTabs';
import { BoardToolbar, type MenuKey } from './BoardToolbar';
import { BoardColumn, type BoardColumnData, type BoardSubGroup } from './BoardColumn';
import { BoardCard } from './BoardCard';
import { CycleStrip } from './CycleStrip';
import { AtRiskAlert } from './AtRiskAlert';
import { SleepEvalBanner } from './SleepEvalDeck';
import { SaveScopeDialog } from './SaveScopeDialog';
import { TaskCreateModal } from './TaskCreateModal';
import { useI18n } from '../../context/I18nContext';
import { useGiveToAgent } from '../../lib/giveToAgent';
import { useAgentCapabilities, isSleepAgentReady } from '../../hooks/useAgentCapabilities';
import { readAgentSettings, AGENT_SETTINGS_EVENT } from '../../lib/agentSettings';
import { TimelineGantt } from './TimelineGantt';
import './Board.css';
import { fill } from '../../lib/fill';

const AVATAR_PALETTE = ['#9d8cff', '#4aa8ff', '#4ade80', '#f0abfc', '#fbbf24', '#5eead4', '#f9a8d4'];
const distinct = (xs: string[]): string[] => Array.from(new Set(xs));

type PendingSave = { mode: 'save' | 'create'; name?: string } | null;

/** Below this width the board shows one column at a time (plan r3 § 5b). */
const ONE_COLUMN_QUERY = '(max-width: 640px)';

function useOneColumn(): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(ONE_COLUMN_QUERY).matches;
  const [one, setOne] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(ONE_COLUMN_QUERY);
    const on = () => setOne(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return one;
}

export function KanbanBoard({ focus, onOpenTask, onOpenPlanning }: {
  focus?: FocusTarget;
  onOpenTask?: (slug: string) => void;
  onOpenPlanning?: () => void;
} = {}) {
  const { t } = useI18n();
  const sm = useStatusModel();
  const s = useBoardState();
  const { data: tasks = [], isLoading } = useTasks();
  const { data: members = [] } = useTaskMembers();
  const { data: realVersions = [] } = useVersions();
  const { data: activeVersion = null } = useActiveVersion();
  const { data: cycles } = useCycles();
  const activeCycleId = cycles?.active ?? null;
  const updateTask = useUpdateTask();
  const planTask = usePlanTask();
  const rankTask = useRankTask();
  const deleteTask = useDeleteTask();
  // Whether the in-app agent can start sessions (desktop, prerequisites, surface enabled):
  // the toolbar's "Write it with an agent" path is offered only then (A6).
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
  const [subCollapsed, setSubCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; task: Task } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const giveToAgent = useGiveToAgent();
  const [pendingSave, setPendingSave] = useState<PendingSave>(null);
  const [dismissedAlert, setDismissedAlert] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'error' } | null>(null);
  const oneColumn = useOneColumn();
  const [mobileCol, setMobileCol] = useState<string | null>(null);

  const flash = useCallback((msg: string, tone: 'ok' | 'error' = 'ok') => { setToast({ msg, tone }); }, []);
  // A refusal (the evidence gate's 409 names every unproven criterion) stays long enough to read.
  useEffect(() => { if (!toast) return; const tm = setTimeout(() => setToast(null), toast.tone === 'error' ? 8000 : 1900); return () => clearTimeout(tm); }, [toast]);

  // A task opens as its own page (plan r3 § 5a): a card click, and the task the ⌘K palette or
  // the Brain map navigated the board to.
  const openTask = useCallback((slug: string) => onOpenTask?.(slug), [onOpenTask]);
  useFocusTarget(focus, openTask);

  const closeAllMenus = useCallback(() => { setOpenMenu(null); setViewMenuId(null); }, []);

  // ── derived option data ──────────────────────────────────────────────────────
  const memberMap = useMemo(() => new Map(members.map((m) => [m.slug, m.name])), [members]);
  const unassignedLabel = t('board.unassigned');
  const assignees = useMemo(() => {
    const present = distinct(tasks.flatMap(taskAssignees));
    const values = distinct([...members.map((m) => m.slug), ...present]);
    const list = values.map((v, i) => ({ value: v, label: memberMap.get(v) || v.replace(/[-_]/g, ' '), color: AVATAR_PALETTE[i % AVATAR_PALETTE.length] }));
    return [...list, { value: 'none', label: unassignedLabel, color: 'var(--color-text-tertiary)' }];
  }, [tasks, members, memberMap, unassignedLabel]);
  const assigneeName = useCallback((slug: string) => (slug === 'none' ? unassignedLabel : memberMap.get(slug) || slug), [memberMap, unassignedLabel]);
  const allTags = useMemo(() => distinct(tasks.flatMap((x) => x.tags)).sort(), [tasks]);
  const versionsForFilter = useMemo(
    () => distinct([...realVersions.map((v) => v.version), ...tasks.map((x) => x.version).filter((v): v is string => !!v)]),
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
  const orderLabels = useMemo<Record<OrderLane, string>>(
    () => ({ now: t('board.order.now'), next: t('board.order.next'), later: t('board.order.later'), done: t('board.order.done') }),
    [t],
  );
  const groupOpts = useMemo(
    () => ({ versionOrder: versionsForFilter, assignees, statuses: sm, activeCycleId, orderLabels }),
    [versionsForFilter, assignees, sm, activeCycleId, orderLabels],
  );

  const columns: { data: BoardColumnData; colKey: string }[] = useMemo(() => {
    return dimGroups(s.groupBy, filtered, groupOpts).map((col) => {
      const colKey = `${s.groupBy}:${col.key}`;
      const cards = (xs: Task[]) => (s.groupBy === 'order' && s.sortBy === 'manual' ? xs : sortTasks(xs, s.sortBy, s.sortDir));
      let subs: BoardSubGroup[];
      if (s.subGroupBy === 'none') {
        subs = [{ key: '_all', hasHeader: false, cards: cards(col.tasks) }];
      } else {
        const sg = dimGroups(s.subGroupBy as Dim, col.tasks, groupOpts).filter((x) => x.tasks.length);
        subs = sg.map((x) => {
          const subKey = `${colKey}|${x.key}`;
          return { key: x.key, hasHeader: true, label: x.label, color: x.color, count: x.tasks.length, collapsed: !!subCollapsed[subKey], onToggleCollapse: () => setSubCollapsed((m) => ({ ...m, [subKey]: !m[subKey] })), cards: cards(x.tasks) };
        });
        if (!subs.length) subs = [{ key: '_e', hasHeader: false, cards: [], empty: true }];
      }
      // The Done lane is closed until it is opened: finished work does not crowd the board.
      const isDoneLane = s.groupBy === 'order' && col.key === 'done';
      const collapsed = colCollapsed[colKey] ?? isDoneLane;
      return { colKey, data: { key: col.key, label: col.label, count: col.tasks.length, color: col.color, collapsed, subs, noDrop: isDoneLane } };
    });
  }, [s.groupBy, s.subGroupBy, s.sortBy, s.sortDir, filtered, groupOpts, colCollapsed, subCollapsed]);

  const viewCounts = useMemo(() => {
    const m: Record<string, number> = {};
    s.views.forEach((v) => { m[v.id] = filterTasks(tasks, v.config.filters, v.config.search, versionMeta, sm).length; });
    return m;
  }, [s.views, tasks, versionMeta, sm]);

  // ── at-risk alert ──────────────────────────────────────────────────────────────
  const atRisk = useMemo(() => {
    // Live = not terminal by KIND (a cancelled-kind task never enters the banner).
    const open = tasks.filter((x) => !sm.isTerminal(x.status));
    let overdue = 0, today = 0, soon = 0;
    open.forEach((x) => { const di = dueInfo(x, sm); if (!di) return; if (di.kind === 'overdue') overdue++; else if (di.kind === 'today') today++; else if (di.kind === 'soon' || di.kind === 'week') soon++; });
    return { overdue, today, soon };
  }, [tasks, sm]);
  const showAlert = !dismissedAlert && (atRisk.overdue > 0 || atRisk.today > 0);

  // ── drag + drop ─────────────────────────────────────────────────────────────────
  // Order grouping: a drop on another column PLANS the card there (`POST /tasks/:slug/plan`),
  // a drop on a card of the same column RANKS it before that card. Every other grouping
  // patches the grouped field, as before.
  const draggable = s.layout === 'board';
  const onCardDragStart = useCallback((e: React.DragEvent, id: string) => { setDragId(id); try { e.dataTransfer.effectAllowed = 'move'; } catch { /* noop */ } }, []);
  const endDrag = useCallback(() => { setDragId(null); setDragOverKey(null); }, []);
  const keyOf = useCallback((task: Task): string => {
    if (s.groupBy === 'order') {
      if (sm.isDone(task.status) && orderOf(task, activeCycleId) !== 'now') return 'done';
      return orderOf(task, activeCycleId);
    }
    return dimGet(task, s.groupBy as Dim, activeCycleId);
  }, [s.groupBy, sm, activeCycleId]);
  // The column key the dragged card currently lives in — used to suppress the
  // landing silhouette on its source column (a no-op drop).
  const dragSourceKey = useMemo(() => {
    if (!dragId) return null;
    const task = tasks.find((x) => x.id === dragId);
    return task ? keyOf(task) : null;
  }, [dragId, tasks, keyOf]);
  const onError = useCallback((err: Error) => flash(err.message, 'error'), [flash]);
  const onColumnDrop = useCallback((colValue: string) => {
    const id = dragId;
    endDrag();
    if (!id) return;
    const task = tasks.find((x) => x.id === id);
    if (!task || keyOf(task) === colValue) return;
    if (s.groupBy === 'order') {
      if (colValue === 'done') return;
      planTask.mutate({ slug: task.slug, target: colValue }, { onSuccess: () => flash(fill(t('board.toast.planned'), { lane: orderLabels[colValue as OrderLane] ?? colValue })), onError });
      return;
    }
    const field = s.groupBy as Dim;
    const value = colValue === 'none' && (field === 'version' || field === 'assignee') ? null : colValue;
    updateTask.mutate(
      { slug: task.slug, updates: { [field]: value } as Partial<Task> },
      { onSuccess: () => flash(t('board.toast.updated')), onError },
    );
  }, [dragId, tasks, s.groupBy, keyOf, planTask, updateTask, flash, onError, endDrag, orderLabels, t]);
  const onCardDrop = useCallback((target: Task) => {
    const id = dragId;
    endDrag();
    if (!id) return;
    const task = tasks.find((x) => x.id === id);
    if (!task || task.slug === target.slug) return;
    if (keyOf(task) !== keyOf(target)) { onColumnDrop(keyOf(target)); return; }
    rankTask.mutate({ slug: task.slug, before: target.slug }, { onSuccess: () => flash(t('board.toast.ranked')), onError });
  }, [dragId, tasks, keyOf, rankTask, flash, onError, endDrag, onColumnDrop, t]);

  // ── right-click context menu ─────────────────────────────────────────────────────
  const openCtxMenu = useCallback((e: React.MouseEvent, task: Task) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, task });
  }, []);
  const ctxSetStatus = useCallback((task: Task, status: string) => {
    if (task.status !== status) {
      updateTask.mutate(
        { slug: task.slug, updates: { status } as Partial<Task> },
        { onSuccess: () => flash(fill(t('board.toast.moved'), { status: sm.labelOf(status) })), onError },
      );
    }
    setCtxMenu(null);
  }, [updateTask, flash, onError, sm, t]);
  // Later is a place on the "when?" axis now, not a tag (plan r3 § 5b): one row plans it there.
  const ctxMoveToLater = useCallback((task: Task) => {
    setCtxMenu(null);
    planTask.mutate(
      { slug: task.slug, target: 'later' },
      { onSuccess: () => flash(fill(t('board.toast.planned'), { lane: orderLabels.later })), onError },
    );
  }, [planTask, flash, onError, orderLabels, t]);
  const ctxDelete = useCallback(async (task: Task) => {
    setCtxMenu(null);
    const ok = await confirmAction({
      title: fill(t('board.delete.title'), { name: task.name || task.slug }),
      body: t('board.delete.body'),
      confirmLabel: t('taskPage.delete.confirm'),
      destructive: true,
    });
    if (!ok) return;
    deleteTask.mutate(task.slug, { onSuccess: () => flash(t('board.toast.deleted')), onError: () => flash(t('board.toast.deleteFailed'), 'error') });
  }, [deleteTask, flash, t]);
  // The one door to an agent (plan r3 § 5e): Develop, a named agent or a custom prompt, all
  // from the dialog `ProjectInstance` mounts, which reads the task by slug.
  const ctxGiveToAgent = useCallback((task: Task) => { setCtxMenu(null); giveToAgent({ slug: task.slug }); }, [giveToAgent]);

  // ── view actions ────────────────────────────────────────────────────────────────
  const handleRequestSave = useCallback(() => { setPendingSave({ mode: 'save' }); closeAllMenus(); }, [closeAllMenus]);
  // "+ New view" creates a blank view (Board, no filters) immediately and returns
  // its id so the tab bar can enter rename mode. No name prompt, no scope dialog.
  const handleCreateBlank = useCallback((): string => { closeAllMenus(); const id = s.createBlankView(); flash(t('board.toast.viewCreated')); return id; }, [s, flash, closeAllMenus, t]);
  const handlePickScope = useCallback((scope: SaveScope) => {
    if (!pendingSave) return;
    s.saveView(scope);
    flash(scope === 'shared' ? t('board.toast.savedShared') : t('board.toast.savedLocal'));
    setPendingSave(null);
  }, [pendingSave, s, flash, t]);

  if (!s.ready || isLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 240, color: 'var(--color-text-tertiary)', fontSize: 13 }}>{t('board.loading')}</div>;
  }

  const activeName = s.activeView?.name ?? t('board.view');
  const pendingTitle = pendingSave?.mode === 'create'
    ? fill(t('board.save.create'), { name: pendingSave.name || t('board.view.new') })
    : fill(t('board.save.title'), { name: activeName });
  const pendingDefaultScope: SaveScope = s.activeView?.origin === 'local' || s.activeView?.hasLocalOverride ? 'local' : 'shared';
  const isEmpty = filtered.length === 0;
  const isTimeline = s.layout === 'timeline';
  // On a phone the board is one column at a time; the segmented control picks which.
  const shownCol = oneColumn ? (columns.find((c) => c.data.key === mobileCol) ?? columns[0])?.data.key ?? null : null;

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
        onAuthorWithAgent={() => giveToAgent({ preset: 'author' })}
        agentReady={agentReady}
        flash={flash}
      />

      <CycleStrip onOpenPlanning={onOpenPlanning} />
      <SleepEvalBanner />

      {showAlert && (
        <AtRiskAlert
          overdue={atRisk.overdue}
          today={atRisk.today}
          soon={atRisk.soon}
          onFocus={() => { s.setDue('risk'); setDismissedAlert(true); }}
          onDismiss={() => setDismissedAlert(true)}
        />
      )}

      <div className="bd-scroll" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--color-bg)', overflow: isTimeline ? 'auto' : 'hidden' }}>
        {isEmpty && !isTimeline ? (
          <EmptyState onClear={s.clearAllFilters} />
        ) : s.layout === 'board' ? (
          <>
            {oneColumn && (
              <div className="bd-seg" role="group" aria-label={t('board.columns')}>
                {columns.map(({ data }) => (
                  <button key={data.key} type="button" className="bd-seg-btn" aria-pressed={shownCol === data.key} onClick={() => setMobileCol(data.key)}>
                    {`${data.label} · ${data.count}`}
                  </button>
                ))}
              </div>
            )}
            <div
              className="bd-scroll"
              // Clear the active column only when the pointer leaves the whole board
              // row. Per-column dragleave is intentionally NOT used: that boundary
              // fires on every child-card crossing and on the silhouette reflow, and
              // WKWebView (Tauri) frequently reports a null relatedTarget mid-drag.
              onDragLeave={(e) => {
                if (!draggable) return;
                const rt = e.relatedTarget as Node | null;
                if (rt && !e.currentTarget.contains(rt)) setDragOverKey(null);
              }}
              style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14, padding: oneColumn ? '12px' : '16px 16px 18px', overflowX: 'auto', overflowY: 'hidden' }}
            >
              {columns.map(({ data, colKey }) => (
                <BoardColumn
                  key={colKey}
                  col={data}
                  allTasks={tasks}
                  cardProps={s.cardProps}
                  dragId={dragId}
                  draggable={draggable && !oneColumn}
                  hidden={oneColumn && shownCol !== data.key}
                  isDropTarget={!!dragId && dragOverKey === data.key && !data.noDrop}
                  showDropSilhouette={!!dragId && dragOverKey === data.key && dragSourceKey !== data.key && !data.noDrop}
                  assigneeName={assigneeName}
                  onToggleCollapse={() => setColCollapsed((m) => ({ ...m, [colKey]: !data.collapsed }))}
                  onAddTask={() => setShowCreate(true)}
                  onCardClick={(x) => openTask(x.slug)}
                  onCardContextMenu={openCtxMenu}
                  onCardDragStart={onCardDragStart}
                  onCardDragEnd={endDrag}
                  onCardDrop={s.groupBy === 'order' && !data.noDrop ? onCardDrop : undefined}
                  isExpanded={(slug) => !!expanded[slug]}
                  onToggleExpand={(slug) => setExpanded((m) => ({ ...m, [slug]: !m[slug] }))}
                  onColumnDragOver={(e) => { if (draggable && !data.noDrop) { e.preventDefault(); if (dragOverKey !== data.key) setDragOverKey(data.key); } }}
                  onColumnDrop={(e) => { if (draggable && !data.noDrop) { e.preventDefault(); onColumnDrop(data.key); } }}
                />
              ))}
            </div>
          </>
        ) : s.layout === 'list' ? (
          <div className="bd-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 18px 20px' }}>
            {columns.map(({ data, colKey }) => (
              <div key={colKey} style={{ marginBottom: 22 }} data-board-column={data.key}>
                <button type="button" className="bd-col-head" aria-expanded={!data.collapsed} onClick={() => setColCollapsed((m) => ({ ...m, [colKey]: !data.collapsed }))} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 4px 10px', cursor: 'pointer', position: 'sticky', top: 0, background: 'var(--color-bg)', zIndex: 2, width: '100%', border: 'none', color: 'inherit', font: 'inherit', textAlign: 'left' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: data.color, flex: '0 0 auto' }} />
                  <span style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 14, color: 'var(--color-text)' }}>{data.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-text-tertiary)', background: 'var(--color-bg-tertiary)', padding: '1px 8px', borderRadius: 20 }}>{data.count}</span>
                  <span style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
                </button>
                {!data.collapsed && data.subs.map((sub) => (
                  <div key={sub.key}>
                    {sub.hasHeader && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 6px 5px' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: sub.color, flex: '0 0 auto' }} />
                        <span style={{ fontFamily: 'var(--font-family-text)', fontWeight: 600, fontSize: 11, letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>{sub.label}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>{sub.count}</span>
                      </div>
                    )}
                    {sub.cards.map((x) => (
                      <BoardCard key={x.id} task={x} cardProps={s.cardProps} variant="list" assigneeName={assigneeName} onClick={() => openTask(x.slug)} onContextMenu={(e) => openCtxMenu(e, x)} />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column' }}>
            <TimelineGantt tasks={filtered} onTaskClick={(x) => openTask(x.slug)} />
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
          inLater={orderOf(ctxMenu.task, activeCycleId) === 'later'}
          onClose={() => setCtxMenu(null)}
          onOpen={(x) => { openTask(x.slug); setCtxMenu(null); }}
          onMoveToLater={ctxMoveToLater}
          onGiveToAgent={ctxGiveToAgent}
          onSetStatus={ctxSetStatus}
          onDelete={ctxDelete}
        />
      )}

      {showCreate && <TaskCreateModal onClose={() => setShowCreate(false)} />}
      {pendingSave && <SaveScopeDialog title={pendingTitle} defaultScope={pendingDefaultScope} onPick={handlePickScope} onCancel={() => setPendingSave(null)} />}

      {toast && (
        <div className="bd-pop" style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: 9, padding: '10px 16px', borderRadius: 11, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-lg)', fontSize: 13, color: 'var(--color-text)' }}>
          <span aria-hidden="true" style={{ color: toast.tone === 'error' ? 'var(--color-error)' : 'var(--color-accent)' }}>{toast.tone === 'error' ? '!' : '✓'}</span>
          <span role={toast.tone === 'error' ? 'alert' : 'status'} style={{ whiteSpace: 'pre-line', maxWidth: 560 }}>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

interface CtxMenuState { x: number; y: number; task: Task }
function TaskContextMenu({ menu, inLater, onClose, onOpen, onGiveToAgent, onSetStatus, onMoveToLater, onDelete }: {
  menu: CtxMenuState;
  inLater: boolean;
  onClose: () => void;
  onOpen: (t: Task) => void;
  onGiveToAgent: (t: Task) => void;
  onSetStatus: (t: Task, status: string) => void;
  onMoveToLater: (t: Task) => void;
  onDelete: (t: Task) => void;
}) {
  const sm = useStatusModel();
  const { t } = useI18n();
  const { task } = menu;
  const W = 220, H = 190, SUB_W = 188;
  const left = typeof window !== 'undefined' ? Math.min(menu.x, window.innerWidth - W - 8) : menu.x;
  const top = typeof window !== 'undefined' ? Math.min(menu.y, window.innerHeight - H - 8) : menu.y;
  // Flip the flyout to the left when the main menu sits too close to the right edge.
  const flipLeft = typeof window !== 'undefined' && left + W + SUB_W + 8 > window.innerWidth;

  const [openSub, setOpenSub] = useState<'status' | null>(null);

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
      <div className="bd-pop" role="menu" style={{ position: 'fixed', left, top, zIndex: 71, width: W, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6 }}>
        <div className="bd-row" role="menuitem" onClick={() => onOpen(task)} style={row}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></svg>
          <span style={{ flex: 1 }}>{t('board.menu.open')}</span>
        </div>

        {/* The one door to an agent: Develop, a named agent or a custom prompt (plan r3 § 5e). */}
        <div className="bd-row" role="menuitem" onClick={() => onGiveToAgent(task)} style={row}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" /></svg>
          <span style={{ flex: 1 }}>{t('board.menu.giveToAgent')}</span>
        </div>

        <div style={{ height: 1, background: 'var(--color-border)', margin: '5px 4px' }} />

        {/* Move to status — collapsed, flyout submenu */}
        <div style={{ position: 'relative' }} onMouseEnter={() => setOpenSub('status')} onMouseLeave={() => setOpenSub(null)}>
          <div className="bd-row" role="menuitem" aria-haspopup="menu" aria-expanded={openSub === 'status'} onClick={() => setOpenSub((x) => (x === 'status' ? null : 'status'))} style={{ ...row, ...(openSub === 'status' ? { background: 'var(--color-bg-secondary)' } : {}) }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: sm.colorOf(task.status), flex: '0 0 auto' }} />
            <span style={{ flex: 1 }}>{t('board.menu.status')}</span>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{sm.labelOf(task.status)}</span>
            {chevron}
          </div>
          {openSub === 'status' && (
            <div className="bd-pop" role="menu" style={flyout}>
              {sm.order.map((st) => (
                <div key={st} className="bd-row" role="menuitem" onClick={() => onSetStatus(task, st)} style={row}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: sm.colorOf(st), flex: '0 0 auto' }} />
                  <span style={{ flex: 1 }}>{sm.labelOf(st)}</span>
                  {task.status === st && <span style={{ color: 'var(--color-accent)', fontSize: 12 }}>✓</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Later is a place on the "when?" axis: one row plans the card there. Hidden once
            the card is already in Later rather than shown as a no-op. */}
        {!inLater && (
          <div className="bd-row" role="menuitem" onClick={() => onMoveToLater(task)} style={row}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M3 7h18M3 12h18M3 17h18" /></svg>
            <span style={{ flex: 1 }}>{t('board.menu.moveToLater')}</span>
          </div>
        )}

        <div style={{ height: 1, background: 'var(--color-border)', margin: '5px 4px' }} />
        <div className="bd-row bd-danger" role="menuitem" onClick={() => onDelete(task)} style={{ ...row, color: 'var(--color-text-secondary)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
          <span style={{ flex: 1 }}>{t('taskPage.delete.button')}</span>
        </div>
      </div>
    </>
  );
}

function EmptyState({ onClear }: { onClear: () => void }) {
  const { t } = useI18n();
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, textAlign: 'center', padding: 40 }}>
      <div style={{ width: 60, height: 60, borderRadius: 16, background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, color: 'var(--color-text-tertiary)' }}>⌕</div>
      <div style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 19, color: 'var(--color-text)' }}>{t('board.empty.title')}</div>
      <div style={{ fontSize: 13.5, color: 'var(--color-text-tertiary)', maxWidth: 360, lineHeight: 1.5 }}>{t('board.empty.body')}</div>
      <button type="button" className="bd-chip" onClick={onClear} style={{ marginTop: 4, padding: '8px 16px', borderRadius: 9, cursor: 'pointer', background: 'var(--color-accent-soft)', color: 'var(--color-accent)', fontSize: 13, fontWeight: 600, border: '1px solid var(--color-accent)' }}>{t('board.empty.clear')}</button>
    </div>
  );
}
