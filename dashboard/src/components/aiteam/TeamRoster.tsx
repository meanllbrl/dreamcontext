import { useMemo, useState, type ReactNode } from 'react';
import type { TeamTree, TreeLine } from '../../../../src/lib/agents/tree.js';
import { AgentAvatar } from '../agents/AgentAvatar';
import { AutomationsDispatcherBar } from '../automations/AutomationsDispatcherBar';
import { runDuration, useNow } from '../agents/agentRunState';
import { useI18n } from '../../context/I18nContext';
import { filterRoster, rosterTime, type TeamRow } from './teamModel';
import { rollupOf, teamTreeOf, treeSections, visibleTreeLines, type RosterView, type TeamRollup } from './teamTree';
import { TeamIcon } from './TeamIcons';

/**
 * THE LIST ON THE LEFT: every teammate, one row each, "Needs you" first.
 *
 * A row is a conversation, like a messenger's: face (with a status dot), name, the last thing
 * said, when, how many unread, and one tag for the state that stops it (a question, a paused
 * routine, an approval). A draft row stands at the top while a new teammate is being written.
 *
 * TREE (the List | Tree switch under the search): the same rows, indented under the agent each
 * reports to, one section per lead's team and a last "Reports to you" for the agents with
 * nobody above or below them. A lead folds; folded, it says what its team holds (how many
 * reports, who needs you, who waits for approval), so a fold never hides a question.
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
}: {
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
  const now = new Date(useNow(rows.some((r) => r.status === 'working')));

  return (
    <aside className="aiteam-roster" aria-label={t('aiteam.title')}>
      <div className="aiteam-roster-head">
        <h1 className="aiteam-roster-title">{t('aiteam.title')}</h1>
        {!empty && (
          <span className="aiteam-roster-count">
            {(rows.length === 1 ? t('aiteam.count.one') : t('aiteam.count.many')).replace('{n}', String(rows.length))}
          </span>
        )}
        <span className="aiteam-spacer" />
        {onOrgChart && !empty && (
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
      {top}
      {!empty && (
        <label className="aiteam-search">
          <TeamIcon name="search" size={14} />
          <input
            className="aiteam-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('aiteam.search')}
            aria-label={t('aiteam.search')}
          />
        </label>
      )}
      {!empty && (
        <div className="aiteam-viewswitch agents-switch" role="tablist" aria-label={t('aiteam.view.label')}>
          {(['list', 'tree'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={`agents-switch-opt${view === v ? ' agents-switch-opt--on' : ''}`}
              onClick={() => onView?.(v)}
              data-roster-view={v}
            >
              <TeamIcon name={v === 'list' ? 'list' : 'tree'} size={14} />
              {t(`aiteam.view.${v}`)}
            </button>
          ))}
        </div>
      )}
      <div className="aiteam-list">
        {empty && <p className="aiteam-roster-empty">{t('aiteam.roster.empty')}</p>}
        {draft && (
          <button type="button" className="aiteam-row aiteam-row--on aiteam-row--draft" aria-current="true">
            <span className="aiteam-face"><span className="aiteam-draft-av" aria-hidden="true">+</span></span>
            <span className="aiteam-row-main">
              <span className="aiteam-row-top"><span className="aiteam-row-name">{t('aiteam.newTeammate')}</span></span>
              <span className="aiteam-row-preview">
                {draft.title.trim()
                  ? t('aiteam.draft.named').replace('{name}', draft.title.trim())
                  : t('aiteam.draft.blank')}
              </span>
            </span>
            <span className="aiteam-row-end" />
          </button>
        )}
        {view === 'list' && (
          <>
            {needs.length > 0 && <div className="aiteam-section">{t('aiteam.section.needs')}</div>}
            {needs.map((r) => (
              <Row key={r.slug} row={r} on={!draft && selected === r.slug} onSelect={onSelect} now={now} />
            ))}
            {team.length > 0 && <div className="aiteam-section">{t('aiteam.section.team')}</div>}
            {team.map((r) => (
              <Row key={r.slug} row={r} on={!draft && selected === r.slug} onSelect={onSelect} now={now} />
            ))}
            {owners.map((owner) => (
              <div key={`ro:${owner}`} data-readonly-section={owner}>
                <div className="aiteam-section">{t('aiteam.section.readonly').replace('{owner}', owner)}</div>
                {readonly.filter((r) => (r.ownerLabel ?? '') === owner).map((r) => (
                  <Row key={r.slug} row={r} on={!draft && selected === r.slug} onSelect={onSelect} now={now} />
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
                    team={node.ownTeam}
                    rollup={l.collapsed ? rollupOf(tree, (s) => rowBySlug.get(s), l.slug) : null}
                    note={node.missingManager ? t('aiteam.tree.missing') : node.cycle ? t('aiteam.tree.loop') : null}
                    on={!draft && selected === l.slug}
                    onSelect={onSelect}
                    onToggle={toggle}
                    now={now}
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
  line, row, team, rollup, note, on, onSelect, onToggle, now,
}: {
  line: TreeLine;
  row: TeamRow;
  team: string | null;
  rollup: TeamRollup | null;
  note: string | null;
  on: boolean;
  onSelect: (slug: string) => void;
  onToggle: (slug: string) => void;
  now: Date;
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
        now={now}
        size={d === 0 ? 40 : 32}
        team={team}
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

function rollupWords(r: TeamRollup, t: (k: string) => string): { text: string; warn: boolean }[] {
  const out: { text: string; warn: boolean }[] = [
    { text: (r.reports === 1 ? t('aiteam.tree.reports.one') : t('aiteam.tree.reports.many')).replace('{n}', String(r.reports)), warn: false },
  ];
  if (r.needs > 0) out.push({ text: t('aiteam.tree.roll.needs').replace('{n}', String(r.needs)), warn: true });
  if (r.approval > 0) out.push({ text: t('aiteam.tree.roll.approval').replace('{n}', String(r.approval)), warn: true });
  if (r.working > 0) out.push({ text: t('aiteam.tree.roll.working').replace('{n}', String(r.working)), warn: false });
  if (r.paused > 0) out.push({ text: t('aiteam.tree.roll.paused').replace('{n}', String(r.paused)), warn: false });
  return out;
}

function Row({
  row, on, onSelect, now, size = 40, team = null, rollup = null, note = null,
}: {
  row: TeamRow;
  on: boolean;
  onSelect: (slug: string) => void;
  now: Date;
  size?: number;
  /** A lead's team, drawn as a chip before its last line. */
  team?: string | null;
  /** A folded lead: what its team holds. */
  rollup?: TeamRollup | null;
  /** Why it sits at the top of the tree when it should not (a missing manager, a loop). */
  note?: string | null;
}) {
  const { t } = useI18n();
  const working = row.status === 'working';
  const elapsed = working && row.workingSince ? runDuration(now.getTime() - row.workingSince) : null;
  const dot = working ? 'working' : row.status === 'needs' ? 'needs' : row.status === 'idle' && row.lastAt ? 'idle' : null;
  return (
    <button
      type="button"
      className={`aiteam-row${on ? ' aiteam-row--on' : ''}${size < 40 ? ' aiteam-row--sm' : ''}`}
      onClick={() => onSelect(row.slug)}
      aria-current={on ? 'true' : undefined}
      data-team-row={row.slug}
    >
      <span className="aiteam-face">
        <AgentAvatar of="agent" slug={row.slug} title={row.title} hasPhoto={row.hasPhoto} size={size} />
        {dot && <span className={`aiteam-face-dot aiteam-face-dot--${dot}`} aria-hidden="true" />}
      </span>
      <span className="aiteam-row-main">
        <span className="aiteam-row-top">
          <span className="aiteam-row-name">{row.title}</span>
          <span className="aiteam-row-time">{working ? t('aiteam.time.now') : rosterTime(row.lastAt, now, t)}</span>
        </span>
        <span className={`aiteam-row-preview${working ? ' aiteam-row-preview--live' : ''}${team ? ' aiteam-row-preview--team' : ''}`}>
          {team && <span className="aiteam-tag aiteam-tag--accent aiteam-teamchip">{team}</span>}
          {working
            ? t('aiteam.working').replace('{time}', elapsed ?? '')
            : row.preview ?? t('aiteam.row.noMessages')}
        </span>
        {rollup && (
          <span className="aiteam-rollup" data-rollup>
            {rollupWords(rollup, t).map((w, i) => (
              <span key={i} className={w.warn ? 'aiteam-rollup-warn' : undefined}>{i > 0 ? ' · ' : ''}{w.text}</span>
            ))}
          </span>
        )}
        {note && <span className="aiteam-rollup">{note}</span>}
        {(row.status === 'needs' || row.status === 'paused' || row.status === 'approval' || row.elsewhere || row.readOnly || row.global) && (
          <span className="aiteam-row-tags">
            {row.global && (
              <span className="aiteam-tag aiteam-tag--accent" data-global-chip title={t('aiteam.tag.globalHint')}>{t('aiteam.tag.global')}</span>
            )}
            {row.readOnly && (
              <span className="aiteam-tag aiteam-tag--muted" data-owner-chip><TeamIcon name="lock" size={10} />{t('aiteam.owner.of').replace('{owner}', row.ownerLabel ?? '')}</span>
            )}
            {row.elsewhere && (
              <span className="aiteam-tag aiteam-tag--muted" data-elsewhere-chip>{t('aiteam.elsewhere.tag').replace('{machine}', row.elsewhere)}</span>
            )}
            {row.status === 'needs' && <span className="aiteam-tag aiteam-tag--warn">{t('aiteam.tag.needs')}</span>}
            {row.status === 'paused' && (
              <span className="aiteam-tag aiteam-tag--muted"><TeamIcon name="pause" size={10} />{t('aiteam.tag.paused')}</span>
            )}
            {row.status === 'approval' && (
              <span className="aiteam-tag"><TeamIcon name="lock" size={10} />{t('aiteam.tag.approval')}</span>
            )}
          </span>
        )}
      </span>
      <span className="aiteam-row-end">
        {row.unread > 0 && <span className="sidebar-badge">{row.unread}</span>}
      </span>
    </button>
  );
}
