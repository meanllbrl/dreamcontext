import { useState, useRef, useEffect, useLayoutEffect, type CSSProperties } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useStatusModel, useFeatureOptions } from '../../hooks/useTasks';
import { HardRefreshChip, SyncChip, useCloudSync } from './SyncChip';
import type { BoardState } from '../../hooks/useBoard';
import { VersionsPopover } from './VersionsPopover';
import { SparkIcon } from '../sleepy/TypeIcons';
import {
  type BoardFilters, type CardProps, type Dim, type DueFilter, type SortKey,
  PRIO_ORDER, SORT_LABEL, URG_ORDER,
  BACKLOG_RE, VV_BACKLOG, VV_COMPLETED, VV_CURRENT,
  dimGet, levelLabel, prioColor, taskAssignees, taskFeature, taskVersion, urgColor,
} from './boardModel';
import { type BarFit, fitOnLayout, fitOnResize, fitRetest, initialFit, menusToClose } from './toolbarCollapse';

export type MenuKey = 'filter' | 'versions' | 'feature' | 'props' | 'newtask' | null;

interface AssigneeOpt { value: string; label: string; color: string }

interface BoardToolbarProps {
  s: BoardState;
  allTasks: Task[];
  allTags: string[];
  assignees: AssigneeOpt[];
  versionsForFilter: string[];
  /** The version filter is one value: cards then hide their (redundant) version chip. */
  singleVersion?: boolean;
  /** The active planning version ("current sprint"), or null. Powers the "Current" smart bucket. */
  activeVersion: string | null;
  /** Version names with a released status. Powers the "Completed" smart bucket. */
  releasedVersions: string[];
  openMenu: MenuKey;
  setOpenMenu: (m: MenuKey) => void;
  onNewTask: () => void;
  /** Open the "Author with agent" composer. Offered only when {@link agentReady}. */
  onAuthorWithAgent: () => void;
  /** Desktop + Agents-enabled: reveals the "Author with agent" path in the New-task split
   *  button. When false the button is the plain manual-create button it has always been (A6). */
  agentReady: boolean;
  flash: (msg: string) => void;
}

const DUE_OPTS: { v: DueFilter; l: string }[] = [
  { v: 'all', l: 'All dates' }, { v: 'overdue', l: 'Overdue' }, { v: 'today', l: 'Due today' },
  { v: 'risk', l: 'At risk (≤7d)' }, { v: 'has', l: 'Has due date' }, { v: 'none', l: 'No due date' },
];
const RICE_OPTS = [{ v: 0, l: 'Any RICE' }, { v: 4, l: '≥ 4' }, { v: 6, l: '≥ 6' }, { v: 8, l: '≥ 8' }];

const PROP_DEFS: [keyof CardProps, string][] = [
  ['description', 'Description'], ['tags', 'Tags'], ['priority', 'Priority dot'], ['urgency', 'Urgency bar'],
  ['due', 'Due date'], ['rice', 'RICE score'], ['assignee', 'Assignee'], ['version', 'Versions & Sprints'],
  ['subtasks', 'Subtasks'], ['attachments', 'Attachments'],
];

const chipTrigger = (active: boolean): CSSProperties => ({
  boxSizing: 'border-box', margin: 0,
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

export function BoardToolbar({ s, allTasks, allTags, assignees, versionsForFilter, activeVersion, releasedVersions, openMenu, setOpenMenu, onNewTask, onAuthorWithAgent, agentReady, flash }: BoardToolbarProps) {
  const sm = useStatusModel();
  const { data: featureOptions = [] } = useFeatureOptions();
  const [filterPane, setFilterPane] = useState<keyof BoardFilters | 'sort' | null>(null);
  // The Versions & Sprints popover shows the filter list, or (after "Manage versions") the manager.
  const [managingVersions, setManagingVersions] = useState(false);
  const f = s.filters;
  const toggle = (m: MenuKey) => { setOpenMenu(openMenu === m ? null : m); if (m !== 'filter') setFilterPane(null); if (m !== 'versions') setManagingVersions(false); };

  // ── cloud sync (only surfaces when a remote task backend is configured) ──
  // Wiring + chips live in SyncChip.tsx (background job, live progress).
  const cloudSync = useCloudSync(flash);
  const { syncStatus, cloudEnabled } = cloudSync;

  const countBy = (dim: Dim, val: string) => allTasks.filter((t) => dimGet(t, dim) === val).length;
  // Assignee is multi-valued (a task may carry several person tags), so it can't
  // use the single-value dimGet path — count a task under EVERY assignee it has.
  const countAssignee = (val: string) =>
    allTasks.filter((t) => {
      const vals = taskAssignees(t);
      return val === 'none' ? vals.length === 0 : vals.includes(val);
    }).length;

  // Features: the project's feature PRDs plus any slug a task names that has no PRD.
  const featureName = new Map(featureOptions.map((o) => [o.slug, o.name ?? o.slug] as const));
  const featureValues = Array.from(new Set([...featureOptions.map((o) => o.slug), ...allTasks.map(taskFeature).filter((v) => v !== 'none')]));
  const featureLabelOf = (v: string) => (v === 'none' ? 'No feature' : featureName.get(v) ?? v);

  const fieldOpts = (key: keyof BoardFilters): FieldOpt[] => {
    if (key === 'status') return sm.order.map((k) => ({ value: k, label: sm.labelOf(k), color: sm.colorOf(k), count: countBy('status', k) }));
    if (key === 'priority') return PRIO_ORDER.map((k) => ({ value: k, label: levelLabel(k), color: prioColor(k), count: countBy('priority', k) }));
    if (key === 'urgency') return URG_ORDER.map((k) => ({ value: k, label: levelLabel(k), color: urgColor(k), count: countBy('urgency', k) }));
    if (key === 'version') return [...versionsForFilter, 'none']
      .filter((v, i, a) => a.indexOf(v) === i)
      .filter((v) => v === 'none' || !BACKLOG_RE.test(v)) // backlog is offered as the "Backlog" smart bucket above
      .map((k) => ({ value: k, label: k === 'none' ? 'No version' : k, color: null, count: countBy('version', k) }));
    if (key === 'assignee') return assignees.map((a) => ({ value: a.value, label: a.label, color: a.value === 'none' ? null : a.color, count: countAssignee(a.value) }));
    if (key === 'feature') return [...featureValues, 'none'].map((v) => ({ value: v, label: featureLabelOf(v), color: null, count: allTasks.filter((t) => taskFeature(t) === v).length }));
    return allTags.map((tg) => ({ value: tg, label: tg, color: null, count: allTasks.filter((t) => t.tags.includes(tg)).length }));
  };

  const FIELD_DEFS: { key: keyof BoardFilters; label: string }[] = [
    { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' }, { key: 'urgency', label: 'Urgency' },
    { key: 'assignee', label: 'Assignee' }, { key: 'version', label: 'Versions & Sprints' }, { key: 'feature', label: 'Feature' },
    { key: 'tags', label: 'Tags' },
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
        <button type="button" className="bd-btnreset" onClick={() => s.cycleFilter(section, o.value, 'inc')} title="Include" aria-label={`Include ${o.label}`} aria-pressed={incOn} style={incBtn(incOn)}>✓</button>
        <button type="button" className="bd-btnreset" onClick={() => s.cycleFilter(section, o.value, 'exc')} title="Exclude" aria-label={`Exclude ${o.label}`} aria-pressed={excOn} style={excBtn(excOn)}>✕</button>
      </div>
    );
  };

  const activeCount =
    FIELD_DEFS.reduce((n, fd) => { const fld = f[fd.key] as { inc: string[]; exc: string[] }; return n + fld.inc.length + fld.exc.length; }, 0)
    + (f.due !== 'all' ? 1 : 0) + (f.minRice > 0 ? 1 : 0);

  const activeSection = filterPane;
  const sectionDef = activeSection && activeSection !== 'sort' ? FIELD_DEFS.find((d) => d.key === activeSection) : null;
  const isToggleField = !!activeSection && activeSection !== 'due' && activeSection !== 'minRice' && activeSection !== 'sort';

  // The single-pick chips (Versions & Sprints, Feature): what they read as on the bar.
  const singlePickLabel = (key: 'version' | 'feature'): string => {
    const fld = f[key];
    if (fld.exc.length || fld.inc.length > 1) return `${fld.inc.length + fld.exc.length} set`;
    if (!fld.inc.length) return 'All';
    const v = fld.inc[0];
    if (key === 'feature') return featureLabelOf(v);
    if (v === VV_CURRENT) return activeVersion ? `Current · ${activeVersion}` : 'Current';
    if (v === VV_BACKLOG) return 'Backlog';
    if (v === VV_COMPLETED) return 'Completed';
    return v === 'none' ? 'No version' : v;
  };
  const pickRow = (key: 'version' | 'feature', value: string | null, label: string, count: number | null, color?: string | null) => {
    const fld = f[key];
    const on = value === null ? fld.inc.length === 0 && fld.exc.length === 0 : fld.inc.length === 1 && fld.inc[0] === value && fld.exc.length === 0;
    return (
      <button
        key={value ?? '_all'}
        type="button"
        className="bd-btnreset bd-row"
        role="menuitemradio"
        aria-checked={on}
        onClick={() => { s.setFieldInc(key, value === null ? [] : [value]); setOpenMenu(null); }}
        style={{ ...optRow, width: '100%', color: on ? 'var(--color-text)' : optRow.color }}
      >
        <span style={radioBox(on)}>{on ? '●' : ''}</span>
        {color && <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flex: '0 0 auto' }} />}
        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        {count !== null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>{count}</span>}
      </button>
    );
  };

  // ── responsive overflow ──────────────────────────────────────────────────────
  // Properties collapses into a "More" menu when the toolbar can't fit it on one row.
  // Measurement is a shrink-to-fit loop on the real layout (scrollWidth > clientWidth)
  // rather than per-item width math — robust, and it lets the search input shrink fully
  // before anything collapses.
  const COLLAPSIBLE = ['props'] as const;
  type CollKey = (typeof COLLAPSIBLE)[number];
  const barRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<BarFit>(() => initialFit(COLLAPSIBLE.length));
  const visibleCount = fit.visible;
  const [moreOpen, setMoreOpen] = useState(false);

  // Shrink one control out of the bar whenever the row overflows. Runs every
  // commit (pre-paint, so no flicker); converges once the row fits or all are out.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (el && el.scrollWidth > el.clientWidth + 1 && visibleCount > 0) setFit((ft) => fitOnLayout(ft, true));
  });
  // Re-test from scratch (show all, then let the loop above re-shrink) when the
  // available width or the controls' own widths change. Only a real width change
  // counts: a height-only callback, or one the collapse itself set off, keeps the
  // count, so within one width the collapse only ever shrinks.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit((ft) => fitOnResize(ft, el.clientWidth, COLLAPSIBLE.length)));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => { setFit((ft) => fitRetest(ft, COLLAPSIBLE.length)); }, [cloudEnabled, f.version, f.feature, s.sortBy]);

  const visible = COLLAPSIBLE.slice(0, visibleCount) as readonly CollKey[];
  const overflow = COLLAPSIBLE.slice(visibleCount) as readonly CollKey[];
  // Resizing / re-collapsing closes any open menu so a popover never orphans. Only a
  // menu that IS open gets a setter call: a no-op parent update on every count change
  // is what chained a resize into "Maximum update depth exceeded". Reads the menus
  // from this render, but re-runs on the count alone, so opening a menu never closes it.
  useEffect(() => {
    const close = menusToClose(openMenu, moreOpen);
    if (close.menu) setOpenMenu(null);
    if (close.more) setMoreOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCount, setOpenMenu]);
  useEffect(() => { if (!overflow.length && moreOpen) setMoreOpen(false); }, [overflow.length, moreOpen]);

  const propsBody = (
    <>
      <div style={{ ...sectionLabel, padding: '6px 8px 8px' }}>Shown on cards</div>
      {PROP_DEFS.map(([k, l]) => (
        <button key={k} type="button" className="bd-btnreset bd-row" role="menuitemcheckbox" aria-checked={s.cardProps[k]} onClick={() => s.toggleCardProp(k)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', borderRadius: 7, width: '100%', fontSize: 13, color: 'var(--color-text-secondary)' }}>
          <span style={checkBox(s.cardProps[k])}>{s.cardProps[k] ? '✓' : ''}</span>
          <span style={{ flex: 1 }}>{l}</span>
        </button>
      ))}
    </>
  );
  // A collapsed control's body, flown out to the LEFT of the More panel.
  const flyoutAnchor: CSSProperties = { position: 'absolute', top: 0, right: '100%', marginRight: 6 };

  const sortPane = (
    <>
      {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
        <button key={k} type="button" className="bd-btnreset bd-row" role="menuitemradio" aria-checked={s.sortBy === k} onClick={() => s.setSort(k)} style={{ ...optRow, width: '100%' }}>
          <span style={radioBox(s.sortBy === k)}>{s.sortBy === k ? '●' : ''}</span>
          <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{SORT_LABEL[k]}</span>
        </button>
      ))}
      <button type="button" className="bd-btnreset" disabled={s.sortBy === 'manual'} onClick={s.toggleSortDir} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', marginTop: 4, padding: '8px 9px', borderTop: '1px solid var(--color-border)', cursor: s.sortBy === 'manual' ? 'default' : 'pointer', fontSize: 12, color: s.sortBy === 'manual' ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)', opacity: s.sortBy === 'manual' ? 0.5 : 1 }}>
        <span>{s.sortDir === 'asc' ? 'Ascending' : 'Descending'}</span>
        <span style={{ fontSize: 13 }}>{s.sortDir === 'asc' ? '↑' : '↓'}</span>
      </button>
    </>
  );
  const paneRow = (label: string, value: string, active: boolean, onClick: () => void, key?: string) => (
    <button key={key ?? label} type="button" className="bd-btnreset bd-row" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, width: '100%', fontSize: 13, color: 'var(--color-text-secondary)' }}>
      <span style={{ flex: 1, fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 11.5, color: active ? 'var(--color-accent)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{value}</span>
      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>›</span>
    </button>
  );

  return (
    <div ref={barRef} role="toolbar" aria-label="Tasks" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', background: 'var(--color-bg-secondary)', borderBottom: '1px solid var(--color-border)', flexWrap: 'nowrap' }}>
      {/* search — shrinks first so the toolbar stays a single row on narrower widths */}
      <div style={{ position: 'relative', flex: '0 1 212px', minWidth: 130 }}>
        <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: 'var(--color-text-tertiary)', pointerEvents: 'none' }}>⌕</span>
        <input className="bd-input" value={s.search} onChange={(e) => s.setSearch(e.target.value)} placeholder="Search tasks…" aria-label="Search tasks" spellCheck={false}
          style={{ width: '100%', height: 34, padding: '0 12px 0 32px', borderRadius: 9, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13, fontFamily: 'var(--font-family-text)', outline: 'none' }} />
      </div>

      {/* Versions & Sprints — the version filter, plus "Manage versions" */}
      <Chip>
        <button type="button" className="bd-chip" data-testid="versions-chip" aria-haspopup="menu" aria-expanded={openMenu === 'versions'} onClick={() => toggle('versions')} style={chipTrigger(f.version.inc.length + f.version.exc.length > 0)}>
          <span style={{ color: 'var(--color-text-tertiary)' }}>Versions &amp; Sprints</span>
          <span style={{ fontWeight: 600, color: 'var(--color-text)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{singlePickLabel('version')}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
        </button>
        {openMenu === 'versions' && (managingVersions ? (
          <VersionsPopover tasks={allTasks} style={{ left: 0, right: 'auto' }} />
        ) : (
          <div className="bd-pop bd-scroll" role="menu" style={{ ...popBase, left: 0, width: 280, maxHeight: 'min(468px,72vh)', overflowY: 'auto' }}>
            <div style={sectionLabel}>Versions &amp; Sprints</div>
            {pickRow('version', null, 'All', allTasks.length)}
            {versionVirtuals.map((o) => pickRow('version', o.value, o.label, o.count, o.color))}
            {versionVirtuals.length > 0 && <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 4px' }} />}
            {fieldOpts('version').map((o) => pickRow('version', o.value, o.label, o.count))}
            <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 4px' }} />
            <button type="button" className="bd-btnreset bd-row" data-testid="manage-versions" onClick={() => setManagingVersions(true)} style={{ ...optRow, width: '100%', color: 'var(--color-accent)' }}>
              <span style={{ flex: 1 }}>Manage versions…</span>
            </button>
          </div>
        ))}
      </Chip>

      {/* Feature — filter on related_feature */}
      <Chip>
        <button type="button" className="bd-chip" data-testid="feature-chip" aria-haspopup="menu" aria-expanded={openMenu === 'feature'} onClick={() => toggle('feature')} style={chipTrigger(f.feature.inc.length + f.feature.exc.length > 0)}>
          <span style={{ color: 'var(--color-text-tertiary)' }}>Feature</span>
          <span style={{ fontWeight: 600, color: 'var(--color-text)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{singlePickLabel('feature')}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
        </button>
        {openMenu === 'feature' && (
          <div className="bd-pop bd-scroll" role="menu" style={{ ...popBase, left: 0, width: 260, maxHeight: 'min(468px,72vh)', overflowY: 'auto' }}>
            <div style={sectionLabel}>Feature</div>
            {pickRow('feature', null, 'All', allTasks.length)}
            {fieldOpts('feature').map((o) => pickRow('feature', o.value, o.label, o.count))}
          </div>
        )}
      </Chip>

      {/* Filter combined menu (sort included) */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <button type="button" className="bd-chip" data-testid="filter-chip" aria-haspopup="menu" aria-expanded={openMenu === 'filter'} onClick={() => toggle('filter')} style={chipTrigger(activeCount > 0 || s.sortBy !== 'manual')}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flex: '0 0 auto' }}><path d="M2 3.2h12L9.2 8.6V13L6.8 14V8.6L2 3.2Z" fill="currentColor" /></svg>
          <span>Filter</span>
          {activeCount > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 20, background: 'var(--color-accent-strong)', color: 'var(--color-accent-text)' }}>{activeCount}</span>}
          <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
        </button>
        {openMenu === 'filter' && (
          <div className="bd-pop bd-scroll" style={{ ...popBase, left: 0, width: 300, maxHeight: 'min(468px,72vh)', overflowY: 'auto' }}>
            {!activeSection ? (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px 9px', margin: '-6px -6px 5px', background: 'var(--color-bg-elevated)', borderBottom: '1px solid var(--color-border)', borderRadius: '11px 11px 0 0' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text)', flex: 1 }}>Filter by</span>
                  {activeCount > 0 && <button type="button" className="bd-btnreset bd-danger" onClick={s.clearAllFilters} style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Clear all</button>}
                </div>
                {FIELD_DEFS.map((fd) => { const sum = fieldSummary(fd.key); return paneRow(fd.label, sum.text, sum.active, () => setFilterPane(fd.key), fd.key); })}
                {paneRow('Due date', f.due === 'all' ? 'Any' : (DUE_OPTS.find((o) => o.v === f.due)?.l ?? 'Any'), f.due !== 'all', () => setFilterPane('due'))}
                {paneRow('Min RICE', f.minRice > 0 ? `≥ ${f.minRice}` : 'Any', f.minRice > 0, () => setFilterPane('minRice'))}
                <div style={{ height: 1, background: 'var(--color-border)', margin: '5px 4px' }} />
                {paneRow('Sort', SORT_LABEL[s.sortBy], s.sortBy !== 'manual', () => setFilterPane('sort'))}
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 9px', margin: '-6px -6px 5px', background: 'var(--color-bg-elevated)', borderBottom: '1px solid var(--color-border)', borderRadius: '11px 11px 0 0' }}>
                  <button type="button" className="bd-btnreset bd-hover bd-hover-text" onClick={() => setFilterPane(null)} title="Back" aria-label="Back" style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, color: 'var(--color-text-secondary)', fontSize: 15, flex: '0 0 auto' }}>‹</button>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text)', flex: 1 }}>{activeSection === 'due' ? 'Due date' : activeSection === 'minRice' ? 'Min RICE' : activeSection === 'sort' ? 'Sort by' : sectionDef?.label}</span>
                  {isToggleField && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>
                      <span style={{ display: 'inline-flex', width: 14, height: 14, borderRadius: 5, alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', color: '#fff', fontSize: 8 }}>✓</span>is
                      <span style={{ display: 'inline-flex', width: 14, height: 14, borderRadius: 5, alignItems: 'center', justifyContent: 'center', background: 'var(--color-error)', color: '#fff', fontSize: 8, marginLeft: 3 }}>✕</span>not
                    </span>
                  )}
                  {activeSection !== 'sort' && <button type="button" className="bd-btnreset bd-danger" onClick={() => s.clearField(activeSection)} style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flex: '0 0 auto' }}>Clear</button>}
                </div>

                {activeSection === 'sort' && sortPane}
                {activeSection === 'due' && DUE_OPTS.map((o) => (
                  <button key={o.v} type="button" className="bd-btnreset bd-row" onClick={() => s.setDue(o.v)} style={{ ...optRow, width: '100%' }}>
                    <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{o.l}</span>
                    <span style={radioBox(f.due === o.v)}>{f.due === o.v ? '●' : ''}</span>
                  </button>
                ))}
                {activeSection === 'minRice' && RICE_OPTS.map((o) => (
                  <button key={o.v} type="button" className="bd-btnreset bd-row" onClick={() => s.setMinRice(o.v)} style={{ ...optRow, width: '100%' }}>
                    <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{o.l}</span>
                    <span style={radioBox(f.minRice === o.v)}>{f.minRice === o.v ? '●' : ''}</span>
                  </button>
                ))}
                {isToggleField && activeSection === 'version' && (
                  <>
                    {versionVirtuals.length > 0 && (
                      <>
                        <div style={{ ...sectionLabel, padding: '4px 8px 3px' }}>Smart</div>
                        {versionVirtuals.map((o) => toggleRow('version', o))}
                        <div style={{ ...sectionLabel, padding: '9px 8px 3px', marginTop: 2, borderTop: '1px solid var(--color-border)' }}>Versions &amp; Sprints</div>
                      </>
                    )}
                    {fieldOpts('version').map((o) => toggleRow('version', o))}
                  </>
                )}
                {isToggleField && activeSection !== 'version' && fieldOpts(activeSection as keyof BoardFilters).map((o) => toggleRow(activeSection as keyof BoardFilters, o))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 8 }} />

      {/* Properties (collapses into "More" when the row is too narrow) */}
      {visible.includes('props') && (
        <Chip>
          <button type="button" className="bd-chip" data-testid="props-chip" aria-haspopup="menu" aria-expanded={openMenu === 'props'} onClick={() => toggle('props')} title="Choose which properties show on cards" style={{ ...chipTrigger(false), gap: 5, padding: '0 10px' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><circle cx="8" cy="7" r="2.4" /><path d="M13 7h7" /><circle cx="16" cy="17" r="2.4" /><path d="M4 17h7" /></svg>
            <span style={{ fontSize: 12.5 }}>Properties</span>
            <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
          </button>
          {openMenu === 'props' && <div className="bd-pop" role="menu" style={{ ...popBase, right: 0, width: 214 }}>{propsBody}</div>}
        </Chip>
      )}

      {/* overflow "More" menu — holds Properties when it doesn't fit */}
      {overflow.length > 0 && (
        <div style={{ position: 'relative', flex: '0 0 auto' }}>
          <button type="button" className="bd-chip" onClick={() => { setMoreOpen((o) => !o); setOpenMenu(null); }} title="More controls" aria-expanded={moreOpen} style={chipTrigger(moreOpen)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flex: '0 0 auto' }}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
            <span>More</span>
          </button>
          {moreOpen && (
            <>
              <div onClick={() => { setMoreOpen(false); setOpenMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
              <div className="bd-pop" style={{ ...popBase, right: 0, width: 230, zIndex: 46 }}>
                <div style={{ ...sectionLabel, padding: '6px 8px 6px' }}>More controls</div>
                {overflow.map((id) => (
                  <div key={id} style={{ position: 'relative' }}>
                    <button type="button" className="bd-btnreset bd-row" onClick={() => setOpenMenu(openMenu === id ? null : id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, width: '100%', fontSize: 13, color: openMenu === id ? 'var(--color-text)' : 'var(--color-text-secondary)', background: openMenu === id ? 'var(--color-bg-secondary)' : 'transparent' }}>
                      <span style={{ flex: 1, fontWeight: 500 }}>Properties</span>
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>‹</span>
                    </button>
                    {openMenu === id && (
                      <div className="bd-pop bd-scroll" style={{ ...flyoutAnchor, width: 214, maxHeight: 'min(520px,72vh)', overflowY: 'auto', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6, zIndex: 50 }}>{propsBody}</div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* cloud sync — only when a remote task backend is configured */}
      {cloudEnabled && (
        <SyncChip cs={cloudSync} chipStyle={chipTrigger((syncStatus?.pendingPush ?? 0) > 0 || (syncStatus?.conflicts ?? 0) > 0)} />
      )}
      {/* hard refresh — wipe local mirrors + ledger, re-pull everything from the remote */}
      {cloudEnabled && !cloudSync.syncing && <HardRefreshChip cs={cloudSync} chipStyle={chipTrigger(false)} />}

      {/* new task — plain button on web; a split button on desktop where an agent can author.
          The primary click always opens the manual form (least surprise, A1); the caret reveals
          the "Author with agent" power path alongside it. */}
      {agentReady ? (
        <div style={{ position: 'relative', flex: '0 0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'stretch', height: 34, borderRadius: 9, overflow: 'hidden', boxShadow: '0 4px 12px -4px var(--color-accent)' }}>
            <button type="button" onClick={onNewTask} className="bd-btnreset bd-chip" data-testid="new-task" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 13px', background: 'var(--color-accent-strong)', color: 'var(--color-accent-text)', fontSize: 12.5, fontWeight: 600 }}>+ New Task</button>
            <button type="button" onClick={() => toggle('newtask')} title="More ways to create a task" aria-label="More ways to create a task" aria-expanded={openMenu === 'newtask'} className="bd-btnreset bd-chip" style={{ display: 'flex', alignItems: 'center', padding: '0 8px', background: 'var(--color-accent-strong)', color: 'var(--color-accent-text)', borderLeft: '1px solid rgba(255,255,255,0.28)' }}>
              <span style={{ fontSize: 9, opacity: 0.9, transform: openMenu === 'newtask' ? 'rotate(180deg)' : 'none', transition: 'transform .12s' }}>▼</span>
            </button>
          </div>
          {openMenu === 'newtask' && (
            <div className="bd-pop" role="menu" style={{ ...popBase, right: 0, width: 246 }}>
              <button type="button" className="bd-btnreset bd-row" onClick={() => { setOpenMenu(null); onNewTask(); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, width: '100%', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M14 3v4a1 1 0 0 0 1 1h4M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /></svg>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontWeight: 500, color: 'var(--color-text)' }}>Blank form</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Fill in the fields yourself</span>
                </span>
              </button>
              <button type="button" className="bd-btnreset bd-row" onClick={() => { setOpenMenu(null); onAuthorWithAgent(); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, width: '100%', fontSize: 13, color: 'var(--color-accent)' }}>
                <span style={{ display: 'inline-flex', flex: '0 0 auto' }}><SparkIcon size={15} /></span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontWeight: 600 }}>Author with agent</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Describe it; Claude specs &amp; creates it</span>
                </span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <button type="button" onClick={onNewTask} className="bd-btnreset bd-chip" data-testid="new-task" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, background: 'var(--color-accent-strong)', color: 'var(--color-accent-text)', fontSize: 12.5, fontWeight: 600, boxShadow: '0 4px 12px -4px var(--color-accent)', flex: '0 0 auto' }}>+ New Task</button>
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <div style={{ position: 'relative', flex: '0 0 auto' }}>{children}</div>;
}
