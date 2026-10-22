import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { TeamTree } from '../../../../src/lib/agents/tree.js';
import { AgentAvatar } from '../agents/AgentAvatar';
import { AutomationsDispatcherBar } from '../automations/AutomationsDispatcherBar';
import { runDuration, useNow } from '../agents/agentRunState';
import { useI18n } from '../../context/I18nContext';
import { filterRoster, routineCountLabel, type TeamRow } from './teamModel';
import { teamCount } from './teamTree';
import { edgePath, layoutOrgChart } from './orgLayout';
import { TeamIcon } from './TeamIcons';

/**
 * THE ORG CHART: the whole team at once, under "You". Each teammate is a card (face with its
 * status dot, name, the first line of its job, then its routines or the state that stops it);
 * a lead whose reports have nobody under them is drawn as a labelled team frame; the selected
 * teammate's line up to you is drawn in the accent. The placement is `layoutOrgChart` (pure).
 *
 * A click selects a card (the page opens its Team tab); a double-click opens its conversation.
 * Wider than the page, the chart scrolls sideways; it never shrinks a card.
 */
/**
 * THE ORG CHART VIEW: the page's head (name, counts, Conversations | Org chart, find, New), the
 * strip that says who needs you, the chart, and the scheduler's line at the foot. It takes the
 * place of the list and the conversation; the side panel stays where it was.
 */
export function OrgView({
  tree, rows, selected, onSelect, onTalk, onConversations, onNew, onToast, nextRun,
}: {
  tree: TeamTree;
  rows: TeamRow[];
  selected: string | null;
  onSelect: (slug: string) => void;
  onTalk: (slug: string) => void;
  onConversations: () => void;
  onNew: () => void;
  onToast: (msg: string) => void;
  nextRun: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const teams = teamCount(tree);
  const needs = rows.filter((r) => r.status === 'needs');
  const count = (st: TeamRow['status']) => rows.filter((r) => r.status === st).length;
  const facts = [
    ['working', 'aiteam.org.working'],
    ['approval', 'aiteam.org.approval'],
    ['paused', 'aiteam.org.paused'],
  ] as const;
  const said = facts.filter(([st]) => count(st) > 0).map(([st, key]) => t(key).replace('{n}', String(count(st))));
  const matches = useMemo(() => (query.trim() ? new Set(filterRoster(rows, query).map((r) => r.slug)) : null), [rows, query]);

  return (
    <section className="aiteam-org" aria-label={t('aiteam.page.org')}>
      <header className="aiteam-org-head">
        <h1 className="aiteam-roster-title">{t('aiteam.title')}</h1>
        <span className="aiteam-roster-count">
          {(rows.length === 1 ? t('aiteam.count.one') : t('aiteam.count.many')).replace('{n}', String(rows.length))}
          {teams > 0 && ` · ${(teams === 1 ? t('aiteam.org.teams.one') : t('aiteam.org.teams.many')).replace('{n}', String(teams))}`}
        </span>
        <PageSwitch view="org" onConversations={onConversations} />
        <span className="aiteam-spacer" />
        <label className="aiteam-search aiteam-org-search">
          <TeamIcon name="search" size={14} />
          <input
            className="aiteam-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('aiteam.org.find')}
            aria-label={t('aiteam.org.find')}
          />
        </label>
        <button type="button" className="aiteam-newbtn" onClick={onNew}>
          <TeamIcon name="plus" size={12} /> {t('aiteam.new')}
        </button>
      </header>
      {(needs.length > 0 || said.length > 0) && (
        <div className="aiteam-org-strip" data-org-strip>
          {needs.length > 0 && (
            <button type="button" className="aiteam-org-strip-needs" onClick={() => onSelect(needs[0].slug)}>
              <span className="aiteam-tag aiteam-tag--warn">{t('aiteam.org.needs').replace('{n}', String(needs.length))}</span>
              <b>{needs[0].title}</b>
              {needs[0].preview && <span className="aiteam-org-strip-text">{needs[0].preview}</span>}
            </button>
          )}
          <span className="aiteam-spacer" />
          {said.length > 0 && <span className="aiteam-org-strip-facts">{said.join(' · ')}</span>}
        </div>
      )}
      <OrgChart tree={tree} rows={rows} selected={selected} onSelect={onSelect} onTalk={onTalk} matches={matches} />
      <div className="aiteam-roster-foot aiteam-org-foot">
        <AutomationsDispatcherBar variant="inline" onToast={onToast} />
        <span className="aiteam-roster-next">{nextRun}</span>
        <span className="aiteam-spacer" />
        <span className="aiteam-org-hint">{t('aiteam.org.hint')}</span>
      </div>
    </section>
  );
}

/** Conversations | Org chart, at the head of the Org chart. */
export function PageSwitch({ view, onConversations }: { view: 'conversations' | 'org'; onConversations: () => void }) {
  const { t } = useI18n();
  return (
    <div className="agents-switch aiteam-pageswitch" role="tablist" aria-label={t('aiteam.page.label')}>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'conversations'}
        className={`agents-switch-opt${view === 'conversations' ? ' agents-switch-opt--on' : ''}`}
        onClick={onConversations}
        data-page-view="conversations"
      >
        <TeamIcon name="list" size={14} /> {t('aiteam.page.conversations')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'org'}
        className={`agents-switch-opt${view === 'org' ? ' agents-switch-opt--on' : ''}`}
        data-page-view-current="org"
      >
        <TeamIcon name="tree" size={14} /> {t('aiteam.page.org')}
      </button>
    </div>
  );
}

export function OrgChart({
  tree, rows, selected, onSelect, onTalk, matches = null,
}: {
  tree: TeamTree;
  rows: TeamRow[];
  selected: string | null;
  onSelect: (slug: string) => void;
  onTalk: (slug: string) => void;
  /** A search's matches; the rest of the cards fade. Null: no search. */
  matches?: ReadonlySet<string> | null;
}) {
  const { t } = useI18n();
  const rowOf = useMemo(() => new Map(rows.map((r) => [r.slug, r])), [rows]);
  const layout = useMemo(
    () => layoutOrgChart(tree, { selected, titleOf: (s) => rowOf.get(s)?.title ?? s }),
    [tree, selected, rowOf],
  );
  const now = useNow(rows.some((r) => r.status === 'working'));
  const scrollRef = useRef<HTMLDivElement>(null);

  // Wider than the view: open on "You" (the middle), then keep the selected card in sight.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);
  useEffect(() => {
    if (!selected) return;
    const card = scrollRef.current?.querySelector<HTMLElement>(`[data-org-card="${CSS.escape(selected)}"]`);
    card?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selected, layout]);

  return (
    <div ref={scrollRef} className="aiteam-org-scroll" data-org-chart>
      <div className="aiteam-org-canvas" style={{ width: layout.width, height: layout.height }}>
        {layout.frames.map((f) => (
          <div
            key={f.lead}
            className={`aiteam-org-frame${f.onPath ? ' aiteam-org-frame--path' : ''}`}
            style={{ left: f.x, top: f.y, width: f.w, height: f.h }}
            data-org-frame={f.lead}
          >
            <span className="aiteam-org-frame-label">{f.label}</span>
            <span className="aiteam-org-frame-count">{f.count}</span>
          </div>
        ))}
        <svg className="aiteam-org-lines" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.filter((e) => !e.onPath).map((e) => (
            <path key={`${e.from}>${e.to}`} d={edgePath(e.points)} className="aiteam-org-line" />
          ))}
          {/* The selected line last, so it is drawn over the shared bus. */}
          {layout.edges.filter((e) => e.onPath).map((e) => (
            <path key={`${e.from}>${e.to}`} d={edgePath(e.points)} className="aiteam-org-line aiteam-org-line--path" />
          ))}
        </svg>
        <div className="aiteam-org-you" style={{ left: layout.you.x, top: layout.you.y, width: layout.you.w, height: layout.you.h }}>
          <TeamIcon name="user" size={14} /> {t('aiteam.org.you')}
        </div>
        {layout.cards.map((c) => {
          const row = rowOf.get(c.slug);
          if (!row) return null;
          return (
            <OrgCard
              key={c.slug}
              row={row}
              on={selected === c.slug}
              dim={!!matches && !matches.has(c.slug)}
              style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
              onSelect={onSelect}
              onTalk={onTalk}
              now={now}
            />
          );
        })}
      </div>
    </div>
  );
}

function OrgCard({
  row, on, dim, style, onSelect, onTalk, now,
}: {
  row: TeamRow;
  on: boolean;
  dim: boolean;
  style: CSSProperties;
  onSelect: (slug: string) => void;
  onTalk: (slug: string) => void;
  now: number;
}) {
  const { t } = useI18n();
  const working = row.status === 'working';
  const dot = working ? 'working' : row.status === 'needs' ? 'needs' : row.status === 'idle' ? 'idle' : null;
  const enabled = row.routines.filter((r) => r.enabled).length;
  return (
    <button
      type="button"
      className={`aiteam-org-card${on ? ' aiteam-org-card--on' : ''}${dim ? ' aiteam-org-card--dim' : ''}`}
      style={style}
      onClick={() => onSelect(row.slug)}
      onDoubleClick={() => onTalk(row.slug)}
      aria-pressed={on}
      data-org-card={row.slug}
    >
      <span className="aiteam-org-card-top">
        <span className="aiteam-face aiteam-org-face">
          <AgentAvatar of="agent" slug={row.slug} title={row.title} hasPhoto={row.hasPhoto} size={28} />
          {dot && <span className={`aiteam-face-dot aiteam-face-dot--${dot}`} aria-hidden="true" />}
        </span>
        <span className="aiteam-org-card-id">
          <span className="aiteam-org-card-name">{row.title}</span>
          <span className="aiteam-org-card-role">{row.role}</span>
        </span>
      </span>
      <span className="aiteam-org-card-foot">
        {row.status === 'needs' && <span className="aiteam-tag aiteam-tag--warn">{t('aiteam.tag.needs')}</span>}
        {working && (
          <span className="aiteam-org-live">
            {t('aiteam.working').replace('{time}', (row.workingSince ? runDuration(now - row.workingSince) : null) ?? '')}
          </span>
        )}
        {row.status === 'approval' && <span className="aiteam-tag"><TeamIcon name="lock" size={10} />{t('aiteam.tag.approval')}</span>}
        {row.status === 'paused' && <span className="aiteam-tag aiteam-tag--muted"><TeamIcon name="pause" size={10} />{t('aiteam.tag.paused')}</span>}
        {(row.status === 'idle') && (
          <span className="aiteam-org-meta">
            <TeamIcon name="clock" size={12} />
            {enabled > 0 ? routineCountLabel(enabled, t) : t('aiteam.org.onCall')}
          </span>
        )}
        <span className="aiteam-spacer" />
        {row.unread > 0 && <span className="sidebar-badge">{row.unread}</span>}
      </span>
    </button>
  );
}
