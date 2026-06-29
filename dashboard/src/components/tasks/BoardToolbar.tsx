import { useState, useRef, useEffect, useLayoutEffect, type CSSProperties } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useSyncStatus, useSyncTasks } from '../../hooks/useTasks';
import type { BoardState } from '../../hooks/useBoard';
import { VersionsPopover } from './VersionsPopover';
import {
  type BoardFilters, type CardProps, type Dim, type DueFilter, type Layout, type SortKey,
  DIMS, DIM_LABEL, PRIO_ORDER, SORT_LABEL, STATUS_ORDER, STATUS_META, URG_ORDER,
  BACKLOG_RE, VV_BACKLOG, VV_COMPLETED, VV_CURRENT,
  dimGet, levelLabel, prioColor, taskAssignees, taskVersion, urgColor,
} from './boardModel';

export type MenuKey = 'filter' | 'viewtype' | 'group' | 'sort' | 'versions' | 'props' | null;

interface AssigneeOpt { value: string; label: string; color: string }

interface BoardToolbarProps {
  s: BoardState;
  allTasks: Task[];
  allTags: string[];
  assignees: AssigneeOpt[];
  versionsForFilter: string[];
  /** The active planning version ("current sprint"), or null. Powers the "Current" smart bucket. */
  activeVersion: string | null;
  /** Version names with a released status. Powers the "Completed" smart bucket. */
  releasedVersions: string[];
  openMenu: MenuKey;
  setOpenMenu: (m: MenuKey) => void;
  onNewTask: () => void;
  flash: (msg: string) => void;
}

// ── view types (Kanban + List ship; advanced views are preserved, NOT "coming soon") ──
const VIEW_TYPES: { v: Layout; label: string; icon: string }[] = [
  { v: 'board', label: 'Kanban', icon: 'M3 4h4v12H3zM10 4h4v9h-4zM17 4h4v6h-4z' },
  { v: 'list', label: 'List', icon: 'M4 5h16M4 10h16M4 15h16' },
  { v: 'eisenhower', label: 'Eisenhower', icon: 'M4 4h16v16H4zM12 4v16M4 12h16' },
  { v: 'timeline', label: 'Timeline', icon: 'M4 6h10M8 11h11M4 16h7' },
  { v: 'calendar', label: 'Calendar', icon: 'M4 5h16v15H4zM4 9h16M8 3v4M16 3v4' },
  { v: 'heatmap', label: 'Heatmap', icon: 'M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4z' },
  { v: 'scatter', label: 'RICE', icon: 'M4 20V4M4 20h16M8 14a1 1 0 100-2 1 1 0 000 2zM13 9a1 1 0 100-2 1 1 0 000 2zM17 15a1 1 0 100-2 1 1 0 000 2z' },
];

const DUE_OPTS: { v: DueFilter; l: string }[] = [
  { v: 'all', l: 'All dates' }, { v: 'overdue', l: 'Overdue' }, { v: 'today', l: 'Due today' },
  { v: 'risk', l: 'At risk (≤7d)' }, { v: 'has', l: 'Has due date' }, { v: 'none', l: 'No due date' },
];
const RICE_OPTS = [{ v: 0, l: 'Any RICE' }, { v: 4, l: '≥ 4' }, { v: 6, l: '≥ 6' }, { v: 8, l: '≥ 8' }];

const PROP_DEFS: [keyof CardProps, string][] = [
  ['description', 'Description'], ['tags', 'Tags'], ['priority', 'Priority dot'], ['urgency', 'Urgency bar'],
  ['due', 'Due date'], ['rice', 'RICE score'], ['assignee', 'Assignee'], ['version', 'Version'],
];

const chipTrigger = (active: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 11px', borderRadius: 9, cursor: 'pointer',
  fontSize: 12.5, fontWeight: 500, fontFamily: 'var(--font-family-text)', userSelect: 'none',
  border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
  background: active ? 'var(--color-accent-soft)' : 'var(--color-bg)',
  color: active ? 'var(--color-text)' : 'var(--color-text-secondary)', transition: 'all .12s', whiteSpace: 'nowrap',
});
const popBase: CSSProperties = {
  position: 'absolute', top: 42, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
  borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6, zIndex: 40,
};
const optRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)' };
const sectionLabel: CSSProperties = { padding: '6px 8px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' };

const checkBox = (on: boolean): CSSProperties => ({ flex: '0 0 auto', width: 16, height: 16, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', background: on ? 'var(--color-accent)' : 'transparent', border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border-hover)'}` });
const radioBox = (on: boolean): CSSProperties => ({ flex: '0 0 auto', width: 15, height: 15, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: '#fff', background: on ? 'var(--color-accent)' : 'transparent', border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border-hover)'}` });
const incBtn = (on: boolean): CSSProperties => ({ flex: '0 0 auto', width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, cursor: 'pointer', color: on ? '#fff' : 'var(--color-text-tertiary)', background: on ? 'var(--color-accent)' : 'transparent', border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}` });
const excBtn = (on: boolean): CSSProperties => ({ flex: '0 0 auto', width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, cursor: 'pointer', color: on ? '#fff' : 'var(--color-text-tertiary)', background: on ? 'var(--color-error)' : 'transparent', border: `1px solid ${on ? 'var(--color-error)' : 'var(--color-border)'}` });

interface FieldOpt { value: string; label: string; color: string | null; count: number }

export function BoardToolbar({ s, allTasks, allTags, assignees, versionsForFilter, activeVersion, releasedVersions, openMenu, setOpenMenu, onNewTask, flash }: BoardToolbarProps) {
  const [filterPane, setFilterPane] = useState<keyof BoardFilters | null>(null);
  const f = s.filters;
  const toggle = (m: MenuKey) => { setOpenMenu(openMenu === m ? null : m); if (m !== 'filter') setFilterPane(null); };

  // ── cloud sync (only surfaces when a remote task backend is configured) ──
  const { data: syncStatus } = useSyncStatus();
  const syncTasks = useSyncTasks();
  const cloudEnabled = !!syncStatus && syncStatus.backend !== 'local';
  const syncing = syncTasks.isPending;
  const runSync = () => {
    if (syncing) return;
    syncTasks.mutate(undefined, {
      onSuccess: ({ report }) => {
        const bits = [report.pushed && `${report.pushed} pushed`, report.pulled && `${report.pulled} pulled`].filter(Boolean);
        if (report.conflicts.length) flash(`Synced · ${report.conflicts.length} conflict${report.conflicts.length > 1 ? 's' : ''} to resolve`);
        else if (report.errors.length) flash(`Sync finished with ${report.errors.length} error${report.errors.length > 1 ? 's' : ''}`);
        else flash(bits.length ? `Synced · ${bits.join(' · ')}` : 'Already up to date');
      },
      onError: () => flash('Sync failed — check your connection'),
    });
  };

  const countBy = (dim: Dim, val: string) => allTasks.filter((t) => dimGet(t, dim) === val).length;
  // Assignee is multi-valued (a task may carry several person tags), so it can't
  // use the single-value dimGet path — count a task under EVERY assignee it has.
  const countAssignee = (val: string) =>
    allTasks.filter((t) => {
      const vals = taskAssignees(t);
      return val === 'none' ? vals.length === 0 : vals.includes(val);
    }).length;

  const fieldOpts = (key: keyof BoardFilters): FieldOpt[] => {
    if (key === 'status') return STATUS_ORDER.map((k) => ({ value: k, label: STATUS_META[k].label, color: STATUS_META[k].color, count: countBy('status', k) }));
    if (key === 'priority') return PRIO_ORDER.map((k) => ({ value: k, label: levelLabel(k), color: prioColor(k), count: countBy('priority', k) }));
    if (key === 'urgency') return URG_ORDER.map((k) => ({ value: k, label: levelLabel(k), color: urgColor(k), count: countBy('urgency', k) }));
    if (key === 'version') return [...versionsForFilter, 'none']
      .filter((v, i, a) => a.indexOf(v) === i)
      .filter((v) => v === 'none' || !BACKLOG_RE.test(v)) // backlog is offered as the "Backlog" smart bucket above
      .map((k) => ({ value: k, label: k === 'none' ? 'No version' : k, color: null, count: countBy('version', k) }));
    if (key === 'assignee') return assignees.map((a) => ({ value: a.value, label: a.label, color: a.value === 'none' ? null : a.color, count: countAssignee(a.value) }));
    return allTags.map((tg) => ({ value: tg, label: tg, color: null, count: allTasks.filter((t) => t.tags.includes(tg)).length }));
  };

  const FIELD_DEFS: { key: keyof BoardFilters; label: string }[] = [
    { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' }, { key: 'urgency', label: 'Urgency' },
    { key: 'assignee', label: 'Assignee' }, { key: 'version', label: 'Version' }, { key: 'tags', label: 'Tags' },
  ];

  const fieldSummary = (key: keyof BoardFilters): { text: string; active: boolean } => {
    const fld = f[key] as { inc: string[]; exc: string[] };
    const parts: string[] = [];
    if (fld.inc.length) parts.push(`${fld.inc.length} is`);
    if (fld.exc.length) parts.push(`${fld.exc.length} is not`);
    return { text: parts.join(' · ') || 'Any', active: fld.inc.length + fld.exc.length > 0 };
  };

  // Virtual ("smart") version buckets, shown above the literal version list. Each is
  // offered only when it actually applies: Current when a sprint is active, Backlog
  // when any task sits in the backlog, Completed when a released version exists.
  const releasedSet = new Set(releasedVersions);
  const versionVirtuals: FieldOpt[] = [];
  if (activeVersion) versionVirtuals.push({ value: VV_CURRENT, label: 'Current', color: 'var(--color-accent)', count: allTasks.filter((t) => taskVersion(t) === activeVersion).length });
  if (allTasks.some((t) => BACKLOG_RE.test(taskVersion(t)))) versionVirtuals.push({ value: VV_BACKLOG, label: 'Backlog', color: 'var(--color-text-tertiary)', count: allTasks.filter((t) => BACKLOG_RE.test(taskVersion(t))).length });
  if (releasedSet.size) versionVirtuals.push({ value: VV_COMPLETED, label: 'Completed', color: 'var(--color-status-completed)', count: allTasks.filter((t) => releasedSet.has(taskVersion(t))).length });

  // One include/exclude option row, shared by the literal options and the smart buckets.
  const toggleRow = (section: keyof BoardFilters, o: FieldOpt) => {
    const fld = f[section] as unknown as { inc: string[]; exc: string[] };
    const incOn = fld.inc.includes(o.value), excOn = fld.exc.includes(o.value);
    return (
      <div key={o.value} className="bd-row" style={optRow}>
        {o.color && <span style={{ width: 8, height: 8, borderRadius: '50%', background: o.color, flex: '0 0 auto' }} />}
        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>{o.count}</span>
        <span onClick={() => s.cycleFilter(section, o.value, 'inc')} title="Include" style={incBtn(incOn)}>✓</span>
        <span onClick={() => s.cycleFilter(section, o.value, 'exc')} title="Exclude" style={excBtn(excOn)}>✕</span>
      </div>
    );
  };

  const activeCount =
    FIELD_DEFS.reduce((n, fd) => { const fld = f[fd.key] as { inc: string[]; exc: string[] }; return n + fld.inc.length + fld.exc.length; }, 0)
    + (f.due !== 'all' ? 1 : 0) + (f.minRice > 0 ? 1 : 0);

  const curVT = VIEW_TYPES.find((x) => x.v === s.layout) || VIEW_TYPES[0];
  const groupSummary = DIM_LABEL[s.groupBy] + (s.subGroupBy !== 'none' ? ` → ${DIM_LABEL[s.subGroupBy as Dim]}` : '');

  const activeSection = filterPane;
  const sectionDef = activeSection ? FIELD_DEFS.find((d) => d.key === activeSection) : null;
  const isToggleField = activeSection && activeSection !== 'due' && activeSection !== 'minRice';

  // ── responsive overflow ──────────────────────────────────────────────────────
  // The right-hand controls collapse into a "More" menu when the toolbar can't fit
  // them on one row. Order is display order; we hide from the END (Properties first,
  // then Versions, Group, View). Measurement is a shrink-to-fit loop on the real
  // layout (scrollWidth > clientWidth) rather than per-item width math — robust, and
  // it lets the search input shrink fully before anything collapses.
  const COLLAPSIBLE = ['viewtype', 'group', 'versions', 'props'] as const;
  type CollKey = (typeof COLLAPSIBLE)[number];
  const barRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState<number>(COLLAPSIBLE.length);
  const [moreOpen, setMoreOpen] = useState(false);

  // Shrink one control out of the bar whenever the row overflows. Runs every
  // commit (pre-paint, so no flicker); converges once the row fits or all are out.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (el && el.scrollWidth > el.clientWidth + 1 && visibleCount > 0) setVisibleCount((c) => c - 1);
  });
  // Re-test from scratch (show all, then let the loop above re-shrink) when the
  // available width or the controls' own widths change.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVisibleCount(COLLAPSIBLE.length));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => { setVisibleCount(COLLAPSIBLE.length); }, [cloudEnabled, groupSummary, s.sortBy, s.layout]);

  const visible = COLLAPSIBLE.slice(0, visibleCount) as readonly CollKey[];
  const overflow = COLLAPSIBLE.slice(visibleCount) as readonly CollKey[];
  // Resizing / re-collapsing closes any open menu so a popover never orphans.
  useEffect(() => { setOpenMenu(null); setMoreOpen(false); }, [visibleCount, setOpenMenu]);
  useEffect(() => { if (!overflow.length && moreOpen) setMoreOpen(false); }, [overflow.length, moreOpen]);

  // ── popover bodies (shared by the inline chip popover and the More flyout) ──────
  const COLL_LABEL: Record<CollKey, string> = { viewtype: 'View', group: 'Group', versions: 'Versions', props: 'Properties' };
  const COLL_SUMMARY: Record<CollKey, string> = { viewtype: curVT.label, group: groupSummary, versions: '', props: '' };

  const viewTypeBody = (
    <>
      <div style={sectionLabel}>View type</div>
      {VIEW_TYPES.map((vt) => { const active = s.layout === vt.v; return (
        <div key={vt.v} className="bd-row" onClick={() => { s.setLayout(vt.v); setOpenMenu(null); setMoreOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 13, color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)', background: active ? 'var(--color-accent-soft)' : 'transparent' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--color-accent)' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d={vt.icon} /></svg>
          <span style={{ flex: 1 }}>{vt.label}</span>
        </div>
      ); })}
    </>
  );
  const groupBody = (
    <>
      <div style={sectionLabel}>Group by</div>
      {DIMS.map((d) => (
        <div key={d} className="bd-row" onClick={() => s.setGroupBy(d)} style={optRow}>
          <span style={radioBox(s.groupBy === d)}>{s.groupBy === d ? '●' : ''}</span>
          <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{DIM_LABEL[d]}</span>
        </div>
      ))}
      <div style={{ ...sectionLabel, marginTop: 3, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>Then by</div>
      <div className="bd-row" onClick={() => s.setSubGroupBy('none')} style={optRow}>
        <span style={radioBox(s.subGroupBy === 'none')}>{s.subGroupBy === 'none' ? '●' : ''}</span>
        <span style={{ flex: 1 }}>None</span>
      </div>
      {DIMS.filter((d) => d !== s.groupBy).map((d) => (
        <div key={d} className="bd-row" onClick={() => s.setSubGroupBy(d)} style={optRow}>
          <span style={radioBox(s.subGroupBy === d)}>{s.subGroupBy === d ? '●' : ''}</span>
          <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{DIM_LABEL[d]}</span>
        </div>
      ))}
    </>
  );
  const propsBody = (
    <>
      <div style={{ ...sectionLabel, padding: '6px 8px 8px' }}>Shown on cards</div>
      {PROP_DEFS.map(([k, l]) => (
        <div key={k} className="bd-row" onClick={() => s.toggleCardProp(k)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)' }}>
          <span style={checkBox(s.cardProps[k])}>{s.cardProps[k] ? '✓' : ''}</span>
          <span style={{ flex: 1 }}>{l}</span>
        </div>
      ))}
    </>
  );
  const collWidth: Record<CollKey, number> = { viewtype: 196, group: 210, versions: 320, props: 204 };
  const inlinePopover = (id: CollKey) => {
    if (id === 'versions') return <VersionsPopover tasks={allTasks} />;
    const body = id === 'viewtype' ? viewTypeBody : id === 'group' ? groupBody : propsBody;
    return <div className="bd-pop" style={{ ...popBase, right: 0, width: collWidth[id] }}>{body}</div>;
  };
  // A collapsed control's body, flown out to the LEFT of the More panel.
  const flyoutAnchor: CSSProperties = { position: 'absolute', top: 0, right: '100%', marginRight: 6 };
  const flyoutPopover = (id: CollKey) => {
    if (id === 'versions') return <VersionsPopover tasks={allTasks} style={{ ...flyoutAnchor, top: 0, right: '100%', zIndex: 50 }} />;
    const body = id === 'viewtype' ? viewTypeBody : id === 'group' ? groupBody : propsBody;
    return (
      <div className="bd-pop bd-scroll" style={{ ...flyoutAnchor, width: collWidth[id], maxHeight: 'min(520px,72vh)', overflowY: 'auto', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6, zIndex: 50 }}>{body}</div>
    );
  };

  // The inline trigger chip for a collapsible control (when it's visible in the bar).
  const collapsibleChip = (id: CollKey) => {
    if (id === 'viewtype') return (
      <Chip key="viewtype">
        <div className="bd-chip" onClick={() => toggle('viewtype')} style={chipTrigger(false)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d={curVT.icon} /></svg>
          <span>{curVT.label}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'viewtype' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'viewtype' && inlinePopover('viewtype')}
      </Chip>
    );
    if (id === 'group') return (
      <Chip key="group">
        <div className="bd-chip" onClick={() => toggle('group')} style={chipTrigger(s.subGroupBy !== 'none' || s.groupBy !== 'status')}>
          <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}>Group</span>
          <span>{groupSummary}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'group' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'group' && inlinePopover('group')}
      </Chip>
    );
    if (id === 'versions') return (
      <Chip key="versions">
        <div className="bd-chip" onClick={() => toggle('versions')} title="Manage versions" style={chipTrigger(false)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M4 7h16M4 12h16M4 17h10" /><circle cx="18" cy="17" r="2.5" /></svg>
          <span>Versions</span>
        </div>
        {openMenu === 'versions' && inlinePopover('versions')}
      </Chip>
    );
    return (
      <Chip key="props">
        <div className="bd-chip" onClick={() => toggle('props')} title="Choose which properties show on cards" style={{ ...chipTrigger(false), gap: 5, padding: '0 10px' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><circle cx="8" cy="7" r="2.4" /><path d="M13 7h7" /><circle cx="16" cy="17" r="2.4" /><path d="M4 17h7" /></svg>
          <span style={{ fontSize: 12.5 }}>Properties</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>⌄</span>
        </div>
        {openMenu === 'props' && inlinePopover('props')}
      </Chip>
    );
  };

  return (
    <div ref={barRef} style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', background: 'var(--color-bg-secondary)', borderBottom: '1px solid var(--color-border)', flexWrap: 'nowrap' }}>
      {/* search — shrinks first so the toolbar stays a single row on narrower widths */}
      <div style={{ position: 'relative', flex: '0 1 212px', minWidth: 130 }}>
        <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: 'var(--color-text-tertiary)', pointerEvents: 'none' }}>⌕</span>
        <input className="bd-input" value={s.search} onChange={(e) => s.setSearch(e.target.value)} placeholder="Search tasks…" spellCheck={false}
          style={{ width: '100%', height: 34, padding: '0 12px 0 32px', borderRadius: 9, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13, fontFamily: 'var(--font-family-text)', outline: 'none' }} />
      </div>

      {/* Filter combined menu */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <div className="bd-chip" onClick={() => toggle('filter')} style={chipTrigger(activeCount > 0)}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flex: '0 0 auto' }}><path d="M2 3.2h12L9.2 8.6V13L6.8 14V8.6L2 3.2Z" fill="currentColor" /></svg>
          <span>Filter</span>
          {activeCount > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 20, background: 'var(--color-accent)', color: '#fff' }}>{activeCount}</span>}
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'filter' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'filter' && (
          <div className="bd-pop bd-scroll" style={{ ...popBase, left: 0, width: 300, maxHeight: 'min(468px,72vh)', overflowY: 'auto' }}>
            {!activeSection ? (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px 9px', margin: '-6px -6px 5px', background: 'var(--color-bg-elevated)', borderBottom: '1px solid var(--color-border)', borderRadius: '11px 11px 0 0' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text)', flex: 1 }}>Filter by</span>
                  {activeCount > 0 && <span className="bd-danger" onClick={s.clearAllFilters} style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>Clear all</span>}
                </div>
                {FIELD_DEFS.map((fd) => { const sum = fieldSummary(fd.key); return (
                  <div key={fd.key} className="bd-row" onClick={() => setFilterPane(fd.key)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                    <span style={{ flex: 1, fontWeight: 500 }}>{fd.label}</span>
                    <span style={{ fontSize: 11.5, color: sum.active ? 'var(--color-accent)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{sum.text}</span>
                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>›</span>
                  </div>
                ); })}
                <div className="bd-row" onClick={() => setFilterPane('due')} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                  <span style={{ flex: 1, fontWeight: 500 }}>Due date</span>
                  <span style={{ fontSize: 11.5, color: f.due !== 'all' ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}>{f.due === 'all' ? 'Any' : (DUE_OPTS.find((o) => o.v === f.due)?.l ?? 'Any')}</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>›</span>
                </div>
                <div className="bd-row" onClick={() => setFilterPane('minRice')} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                  <span style={{ flex: 1, fontWeight: 500 }}>Min RICE</span>
                  <span style={{ fontSize: 11.5, color: f.minRice > 0 ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}>{f.minRice > 0 ? `≥ ${f.minRice}` : 'Any'}</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>›</span>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 9px', margin: '-6px -6px 5px', background: 'var(--color-bg-elevated)', borderBottom: '1px solid var(--color-border)', borderRadius: '11px 11px 0 0' }}>
                  <span className="bd-hover bd-hover-text" onClick={() => setFilterPane(null)} title="Back" style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 15, flex: '0 0 auto' }}>‹</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text)', flex: 1 }}>{activeSection === 'due' ? 'Due date' : activeSection === 'minRice' ? 'Min RICE' : sectionDef?.label}</span>
                  {isToggleField && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>
                      <span style={{ display: 'inline-flex', width: 14, height: 14, borderRadius: 5, alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', color: '#fff', fontSize: 8 }}>✓</span>is
                      <span style={{ display: 'inline-flex', width: 14, height: 14, borderRadius: 5, alignItems: 'center', justifyContent: 'center', background: 'var(--color-error)', color: '#fff', fontSize: 8, marginLeft: 3 }}>✕</span>not
                    </span>
                  )}
                  <span className="bd-danger" onClick={() => s.clearField(activeSection)} style={{ fontSize: 11, color: 'var(--color-text-tertiary)', cursor: 'pointer', flex: '0 0 auto' }}>Clear</span>
                </div>

                {activeSection === 'due' && DUE_OPTS.map((o) => (
                  <div key={o.v} className="bd-row" onClick={() => s.setDue(o.v)} style={optRow}>
                    <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{o.l}</span>
                    <span style={radioBox(f.due === o.v)}>{f.due === o.v ? '●' : ''}</span>
                  </div>
                ))}
                {activeSection === 'minRice' && RICE_OPTS.map((o) => (
                  <div key={o.v} className="bd-row" onClick={() => s.setMinRice(o.v)} style={optRow}>
                    <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{o.l}</span>
                    <span style={radioBox(f.minRice === o.v)}>{f.minRice === o.v ? '●' : ''}</span>
                  </div>
                ))}
                {isToggleField && activeSection === 'version' && (
                  <>
                    {versionVirtuals.length > 0 && (
                      <>
                        <div style={{ ...sectionLabel, padding: '4px 8px 3px' }}>Smart</div>
                        {versionVirtuals.map((o) => toggleRow('version', o))}
                        <div style={{ ...sectionLabel, padding: '9px 8px 3px', marginTop: 2, borderTop: '1px solid var(--color-border)' }}>Versions</div>
                      </>
                    )}
                    {fieldOpts('version').map((o) => toggleRow('version', o))}
                  </>
                )}
                {isToggleField && activeSection !== 'version' && fieldOpts(activeSection).map((o) => toggleRow(activeSection, o))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* sort — sits beside Filter on the left */}
      <Chip>
        <div className="bd-chip" onClick={() => toggle('sort')} style={chipTrigger(s.sortBy !== 'manual')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3" /></svg>
          <span>{SORT_LABEL[s.sortBy]}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'sort' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'sort' && (
          <div className="bd-pop" style={{ ...popBase, left: 0, width: 190 }}>
            <div style={sectionLabel}>Sort by</div>
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <div key={k} className="bd-row" onClick={() => s.setSort(k)} style={optRow}>
                <span style={radioBox(s.sortBy === k)}>{s.sortBy === k ? '●' : ''}</span>
                <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{SORT_LABEL[k]}</span>
              </div>
            ))}
            <div onClick={s.sortBy === 'manual' ? undefined : s.toggleSortDir} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4, padding: '8px 9px', borderTop: '1px solid var(--color-border)', cursor: s.sortBy === 'manual' ? 'default' : 'pointer', fontSize: 12, color: s.sortBy === 'manual' ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)', opacity: s.sortBy === 'manual' ? 0.5 : 1 }}>
              <span>{s.sortDir === 'asc' ? 'Ascending' : 'Descending'}</span>
              <span style={{ fontSize: 13 }}>{s.sortDir === 'asc' ? '↑' : '↓'}</span>
            </div>
          </div>
        )}
      </Chip>

      <div style={{ flex: 1, minWidth: 8 }} />

      {/* cloud sync — only when a remote task backend is configured */}
      {cloudEnabled && (
        <div className="bd-chip" onClick={runSync} title={syncing ? 'Syncing…' : `Sync tasks with ${syncStatus!.backend}${syncStatus!.pendingPush ? ` · ${syncStatus!.pendingPush} pending` : ''}`}
          style={{ ...chipTrigger(syncStatus!.pendingPush > 0 || syncStatus!.conflicts > 0), cursor: syncing ? 'progress' : 'pointer', opacity: syncing ? 0.7 : 1 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto', animation: syncing ? 'bd_spin .8s linear infinite' : undefined }}><path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3" /><path d="M21 3v6h-6M3 21v-6h6" /></svg>
          <span>{syncing ? 'Syncing…' : 'Sync'}</span>
          {!syncing && syncStatus!.pendingPush > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 20, background: 'var(--color-accent)', color: '#fff' }}>{syncStatus!.pendingPush}</span>}
          {!syncing && syncStatus!.conflicts > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 20, background: 'var(--color-error)', color: '#fff' }}>{syncStatus!.conflicts}!</span>}
        </div>
      )}

      {/* collapsible controls — View / Group / Versions / Properties.
          Whatever doesn't fit moves into the "More" menu (see below). */}
      {visible.map((id) => collapsibleChip(id))}

      {/* overflow "More" menu — holds the collapsed controls */}
      {overflow.length > 0 && (
        <div style={{ position: 'relative', flex: '0 0 auto' }}>
          <div className="bd-chip" onClick={() => { setMoreOpen((o) => !o); setOpenMenu(null); }} title="More controls" style={chipTrigger(moreOpen)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flex: '0 0 auto' }}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
            <span>More</span>
            <span style={{ fontSize: 9, opacity: 0.7 }}>{moreOpen ? '▲' : '▼'}</span>
          </div>
          {moreOpen && (
            <>
              <div onClick={() => { setMoreOpen(false); setOpenMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
              <div className="bd-pop" style={{ ...popBase, right: 0, width: 230, zIndex: 46 }}>
                <div style={{ ...sectionLabel, padding: '6px 8px 6px' }}>More controls</div>
                {overflow.map((id) => (
                  <div key={id} style={{ position: 'relative' }}>
                    <div className="bd-row" onClick={() => setOpenMenu(openMenu === id ? null : id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: openMenu === id ? 'var(--color-text)' : 'var(--color-text-secondary)', background: openMenu === id ? 'var(--color-bg-secondary)' : 'transparent' }}>
                      <span style={{ flex: 1, fontWeight: 500 }}>{COLL_LABEL[id]}</span>
                      {COLL_SUMMARY[id] && <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}>{COLL_SUMMARY[id]}</span>}
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>‹</span>
                    </div>
                    {openMenu === id && flyoutPopover(id)}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* new task */}
      <div onClick={onNewTask} className="bd-chip" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, cursor: 'pointer', background: 'var(--color-accent)', color: '#fff', fontSize: 12.5, fontWeight: 600, boxShadow: '0 4px 12px -4px var(--color-accent)', flex: '0 0 auto' }}>+ New Task</div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <div style={{ position: 'relative', flex: '0 0 auto' }}>{children}</div>;
}
