import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { TeamTree, TreeLine } from '../../../../src/lib/agents/tree.js';
import { AgentAvatar } from '../agents/AgentAvatar';
import { AutomationsDispatcherBar } from '../automations/AutomationsDispatcherBar';
import { useI18n } from '../../context/I18nContext';
import { filterRoster, type TeamRow } from './teamModel';
import { clampRosterWidth, ROSTER_MAX_WIDTH, ROSTER_MIN_WIDTH, ROSTER_WIDTH_STEP, rollupOf, teamTreeOf, treeSections, visibleTreeLines, type RosterView, type TeamRollup } from './teamTree';
import { TeamIcon } from './TeamIcons';

/**
 * THE LIST ON THE LEFT: every teammate, one row each, "Needs you" first.
 *
 * A row reads like the side menu: one line, a small face, the name, and on the right only what
 * asks for a look (a state dot, unread). What was said and when is on the teammate's own page. A
 * member of all projects that talked here carries a small globe. A draft row stands at the top
 * while a new teammate is being written.
 *
 * TREE (the List | Tree switch under the search): the same rows, indented under the agent each
 * reports to, one section per lead's team and a last "Reports to you" for the agents with
 * nobody above or below them. A lead folds; folded, its dot still says what its team holds, so
 * a fold never hides a question.
 */
export function TeamRoster({
  rows,
  selected,
  draft,
  onSelect,
  onNew,
  onToast,
  nextRun,
  tree: treeIn,
  view = 'list',
  onView,
  onOrgChart,
  top,
  width,
  pageWidth = 0,
  onWidth,
  onWidthCommit,
  headless = false,
  beyond = 0,
}: {
  /** How many members of all projects stand only on the Org chart: an empty list says so. */
  beyond?: number;
  /** The new shell (W2-B): the page's bar carries the title, the count and the actions. */
  headless?: boolean;
  rows: TeamRow[];
  selected: string | null;
  /** The new teammate being written, or null. */
  draft: { title: string } | null;
  onSelect: (slug: string) => void;
  onNew: () => void;
  onToast: (msg: string) => void;
  /** The scheduler's next fire, said under the list. */
  nextRun: string;
  /** Who reports to whom (`teamTreeOf`). Absent: nobody is placed, everyone reports to you. */
  tree?: TeamTree;
  view?: RosterView;
  onView?: (view: RosterView) => void;
  /** Switch the page to the Org chart. */
  onOrgChart?: () => void;
  /** Drawn under the head: agent sync's notice and the owner inbox. */
  top?: ReactNode;
  /** The list's width in px when its edge can be dragged (absent on a phone). */
  width?: number;
  /** The page the list shares with the conversation: its half is the ceiling. */
  pageWidth?: number;
  onWidth?: (px: number) => void;
  /** The drag ended or a key moved it: keep this width. */
  onWidthCommit?: (px: number) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const shown = filterRoster(rows, query);
  const rowBySlug = useMemo(() => new Map(rows.map((r) => [r.slug, r])), [rows]);
  const tree = useMemo(() => treeIn ?? teamTreeOf(rows, []), [treeIn, rows]);
  const sections = useMemo(
    () => treeSections(tree, (slug) => rowBySlug.get(slug)?.title ?? slug),
    [tree, rowBySlug],
  );
  const drag = useRef<{ x: number; w: number } | null>(null);
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || width === undefined) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The handle is the RIGHT edge: moving it right widens the list, one pixel for one.
    onWidth?.(clampRosterWidth(drag.current.w + (e.clientX - drag.current.x), pageWidth));
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const start = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onWidthCommit?.(clampRosterWidth(start.w + (e.clientX - start.x), pageWidth));
  };
  const onHandleKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (width === undefined || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const next = clampRosterWidth(width + (e.key === 'ArrowRight' ? ROSTER_WIDTH_STEP : -ROSTER_WIDTH_STEP), pageWidth);
    onWidth?.(next);
    onWidthCommit?.(next);
  };
  const toggle = (slug: string) => setCollapsed((cur) => {
    const next = new Set(cur);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    return next;
  });
  const needs = shown.filter((r) => r.section === 'needs');
  const team = shown.filter((r) => r.section === 'team');
  // Teammates' agents, one read-only part per owner (B1-4), after your own.
  const readonly = shown.filter((r) => r.section === 'readonly');
  const owners = [...new Set(readonly.map((r) => r.ownerLabel ?? ''))];
  const empty = rows.length === 0 && !draft;

  return (
    <aside className="aiteam-roster" aria-label={t('aiteam.title')}>
      {width !== undefined && (
        <div
          className="aiteam-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('aiteam.roster.resize')}
          aria-valuemin={ROSTER_MIN_WIDTH}
          aria-valuemax={clampRosterWidth(ROSTER_MAX_WIDTH, pageWidth)}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onKeyDown={onHandleKey}
        />
      )}
      {!headless && (
        <div className="aiteam-roster-head">
          <h1 className="aiteam-roster-title">{t('aiteam.title')}</h1>
          {!empty && (
            <span className="aiteam-roster-count">
              {(rows.length === 1 ? t('aiteam.count.one') : t('aiteam.count.many')).replace('{n}', String(rows.length))}
            </span>
          )}
          <span className="aiteam-spacer" />
          {onOrgChart && (!empty || beyond > 0) && (
            <button
              type="button"
              className="aiteam-iconbtn"
              onClick={onOrgChart}
              aria-label={t('aiteam.page.org')}
              title={t('aiteam.page.org')}
              data-page-view="org"
            >
              <TeamIcon name="tree" size={16} />
            </button>
          )}
          <button type="button" className="aiteam-newbtn" onClick={onNew}>
            <TeamIcon name="plus" size={12} /> {t('aiteam.new')}
          </button>
        </div>
      )}
      {top}
      {!empty && (
        <div className="aiteam-tools">
          <label className="aiteam-search">
            <TeamIcon name="search" size={13} />
            <input
              className="aiteam-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('aiteam.search')}
              aria-label={t('aiteam.search')}
            />
          </label>
          <div className="aiteam-viewicons" role="tablist" aria-label={t('aiteam.view.label')}>
            {(['list', 'tree'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                aria-label={t(`aiteam.view.${v}`)}
                title={t(`aiteam.view.${v}`)}
                className={`aiteam-viewicon${view === v ? ' is-on' : ''}`}
                onClick={() => onView?.(v)}
                data-roster-view={v}
              >
                <TeamIcon name={v === 'list' ? 'list' : 'tree'} size={14} />
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="aiteam-list">
        {empty && <p className="aiteam-roster-empty">{t(beyond > 0 ? 'aiteam.roster.emptyProject' : 'aiteam.roster.empty')}</p>}
        {draft && (
          <button type="button" className="aiteam-row aiteam-row--on aiteam-row--draft" aria-current="true">
            <span className="aiteam-face"><span className="aiteam-draft-av" aria-hidden="true">+</span></span>
            <span className="aiteam-row-name">{draft.title.trim() || t('aiteam.newTeammate')}</span>
            <span className="aiteam-row-end" />
          </button>
        )}
        {view === 'list' && (
          <>
            {needs.length > 0 && <div className="aiteam-section">{t('aiteam.section.needs')}</div>}
            {needs.map((r) => (
              <Row key={r.slug} row={r} on={!draft && selected === r.slug} onSelect={onSelect} />
            ))}
            {team.length > 0 && <div className="aiteam-section">{t('aiteam.section.team')}</div>}
            {team.map((r) => (
              <Row key={r.slug} row={r} on={!draft && selected === r.slug} onSelect={onSelect} />
            ))}
            {owners.map((owner) => (
              <div key={`ro:${owner}`} data-readonly-section={owner}>
                <div className="aiteam-section">{t('aiteam.section.readonly').replace('{owner}', owner)}</div>
                {readonly.filter((r) => (r.ownerLabel ?? '') === owner).map((r) => (
                  <Row key={r.slug} row={r} on={!draft && selected === r.slug} onSelect={onSelect} />
                ))}
              </div>
            ))}
          </>
        )}
        {view === 'tree' && sections.map((sec) => {
          const lines = visibleTreeLines(tree, rows, collapsed, sec.roots, query);
          if (lines.length === 0) return null;
          return (
            <div key={sec.key} className="aiteam-treesec" data-tree-section={sec.key}>
              <div className="aiteam-section">
                {sec.label ?? t('aiteam.tree.you')}
                <span className="aiteam-section-count"> · {sec.count}</span>
              </div>
              {lines.map((l) => {
                const row = rowBySlug.get(l.slug);
                if (!row) return null;
                const node = tree.nodes.get(l.slug)!;
                return (
                  <TreeRow
                    key={l.slug}
                    line={l}
                    row={row}
                    rollup={l.collapsed ? rollupOf(tree, (s) => rowBySlug.get(s), l.slug) : null}
                    note={node.missingManager ? t('aiteam.tree.missing') : node.cycle ? t('aiteam.tree.loop') : null}
                    on={!draft && selected === l.slug}
                    onSelect={onSelect}
                    onToggle={toggle}
                  />
                );
              })}
            </div>
          );
        })}
        {!empty && shown.length === 0 && <p className="aiteam-roster-empty">{t('aiteam.search.none')}</p>}
      </div>
      <div className="aiteam-roster-foot">
        <AutomationsDispatcherBar variant="inline" onToast={onToast} />
        <span className="aiteam-roster-next">{nextRun}</span>
      </div>
    </aside>
  );
}

/** A row of the tree: the guides down from its managers, its fold, then the list's own row. */
function TreeRow({
  line, row, rollup, note, on, onSelect, onToggle,
}: {
  line: TreeLine;
  row: TeamRow;
  rollup: TeamRollup | null;
  note: string | null;
  on: boolean;
  onSelect: (slug: string) => void;
  onToggle: (slug: string) => void;
}) {
  const { t } = useI18n();
  const d = line.depth;
  return (
    <div
      className={`aiteam-trow${d === 0 ? ' aiteam-trow--root' : ''}`}
      style={{ paddingLeft: d * TREE_INDENT }}
      data-tree-row={row.slug}
      data-depth={d}
    >
      {line.guides.map((g, i) => g && <span key={i} className="aiteam-guide" style={{ left: guideX(i) }} aria-hidden="true" />)}
      {/* Not the last report: its manager's line runs on past it, to the next one. */}
      {d > 0 && !line.last && <span className="aiteam-guide" style={{ left: guideX(d - 1) }} aria-hidden="true" />}
      {d > 0 && (
        <span
          className="aiteam-elbow"
          style={{ left: guideX(d - 1), width: line.hasChildren ? TREE_INDENT - CARET / 2 : TREE_INDENT + CARET / 2 + 4 }}
          aria-hidden="true"
        />
      )}
      {line.hasChildren ? (
        <button
          type="button"
          className="aiteam-caret"
          onClick={() => onToggle(row.slug)}
          aria-expanded={!line.collapsed}
          aria-label={(line.collapsed ? t('aiteam.tree.expand') : t('aiteam.tree.collapse')).replace('{name}', row.title)}
        >
          <TeamIcon name={line.collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
        </button>
      ) : (
        <span className="aiteam-caret aiteam-caret--none" aria-hidden="true" />
      )}
      {/* Open, a lead's own guide runs down from under its fold to its first report. */}
      {line.hasChildren && !line.collapsed && <span className="aiteam-guide aiteam-guide--down" style={{ left: guideX(d) }} aria-hidden="true" />}
      <Row
        row={row}
        on={on}
        onSelect={onSelect}
        rollup={rollup}
        note={note}
      />
    </div>
  );
}

/** One level of indent, and the fold's width: the guide of a level runs under its fold. */
const TREE_INDENT = 22;
/** The fold's hit box (a 12px glyph inside): 24px, the pointer-target minimum. */
const CARET = 24;
function guideX(level: number): number {
  return level * TREE_INDENT + CARET / 2;
}

/** The list's row, in the side menu's language: one line, a small face, a name, and on the right
 *  only what asks for a look (unread, or a state dot). The rest is on the teammate's own head. */
function Row({
  row, on, onSelect, rollup = null, note = null,
}: {
  row: TeamRow;
  on: boolean;
  onSelect: (slug: string) => void;
  /** A folded lead: what its team holds. A question inside a fold still shows. */
  rollup?: TeamRollup | null;
  /** Why it sits at the top of the tree when it should not (a missing manager, a loop). */
  note?: string | null;
}) {
  const { t } = useI18n();
  // Asking wins over working: a fold must never hide a question.
  const dot = row.status === 'needs' || row.status === 'approval' || rollup?.needs || rollup?.approval ? 'needs'
    : row.status === 'working' || rollup?.working ? 'working'
      : row.status === 'paused' ? 'paused' : null;
  return (
    <button
      type="button"
      className={`aiteam-row${on ? ' aiteam-row--on' : ''}`}
      onClick={() => onSelect(row.slug)}
      aria-current={on ? 'true' : undefined}
      title={[row.title, note, row.preview].filter(Boolean).join(' · ')}
      data-team-row={row.slug}
    >
      <span className="aiteam-face">
        <AgentAvatar of="agent" slug={row.slug} title={row.title} hasPhoto={row.hasPhoto} size={22} />
      </span>
      <span className="aiteam-row-name">{row.title}</span>
      <span className="aiteam-row-end">
        {row.global && (
          <span className="aiteam-row-mark" title={t('aiteam.tag.globalHint')} aria-label={t('aiteam.tag.global')} data-global-chip>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true"><circle cx="6" cy="6" r="4.8" /><path d="M1.2 6h9.6M6 1.2c1.6 1.4 1.6 8.2 0 9.6M6 1.2c-1.6 1.4-1.6 8.2 0 9.6" /></svg>
          </span>
        )}
        {dot && <span className={`aiteam-row-dot aiteam-row-dot--${dot}`} aria-label={t(dot === 'working' ? 'aiteam.time.now' : `aiteam.tag.${dot}`)} />}
        {row.unread > 0 && <span className="sidebar-badge">{row.unread}</span>}
      </span>
    </button>
  );
}
