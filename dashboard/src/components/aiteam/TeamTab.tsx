import { useEffect, useMemo, useState } from 'react';
import { chainOf, descendantsOf, type TeamTree } from '../../../../src/lib/agents/tree.js';
import { AgentAvatar } from '../agents/AgentAvatar';
import { runDuration, useNow } from '../agents/agentRunState';
import { useI18n } from '../../context/I18nContext';
import { usePlaceAgent } from '../../hooks/useAgents';
import { routineCountLabel, type TeamRow } from './teamModel';
import { ManagerPicker, useTeamTree } from './PlaceInTeam';

/**
 * THE TEAM TAB (Org chart's side panel): one teammate's place, read top to bottom — its chain
 * to you, who it reports to, its own team (with a way to add a report), and every routine its
 * team runs. Only how the team is drawn changes here; nothing it may do does.
 */
export function TeamTab({
  slug, rows, tree, onOpen, onTalk, onToast,
}: {
  slug: string;
  rows: TeamRow[];
  /** The page's tree, in the roster's order. */
  tree: TeamTree;
  onOpen: (slug: string) => void;
  onTalk: (slug: string) => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const { agents } = useTeamTree();
  const place = usePlaceAgent();
  const [editing, setEditing] = useState<'manager' | 'add' | null>(null);
  useEffect(() => setEditing(null), [slug]);
  const rowOf = useMemo(() => new Map(rows.map((r) => [r.slug, r])), [rows]);
  const now = useNow(rows.some((r) => r.status === 'working'));
  const me = rowOf.get(slug);
  const node = tree.nodes.get(slug);
  const summary = agents.find((a) => a.slug === slug);
  // A teammate's agent (B1-4): its place in the team is read here, never changed or talked to.
  const readOnly = summary?.readOnly === true;
  if (!me || !node) return <div className="aiteam-panel-body" />;

  const chain = chainOf(tree, slug);
  const manager = node.parent ? rowOf.get(node.parent) ?? null : null;
  const reports = node.children.map((s) => rowOf.get(s)).filter((r): r is TeamRow => !!r);
  const team = [slug, ...descendantsOf(tree, slug)];
  const routines = team.flatMap((s) => (rowOf.get(s)?.routines ?? []).map((r) => ({ owner: rowOf.get(s)!, routine: r })));
  const above = new Set(chain);
  const addable = agents.filter((a) => !above.has(a.slug) && a.slug !== slug && a.reportsTo !== slug && !a.implicit && !a.readOnly)
    .sort((a, b) => a.title.localeCompare(b.title));

  return (
    <div className="aiteam-panel-body aiteam-teamtab" data-team-tab={slug}>
      <div className="aiteam-teamtab-head">
        <AgentAvatar of="agent" slug={slug} title={me.title} hasPhoto={me.hasPhoto} size={40} />
        <div className="aiteam-teamtab-id">
          <span className="aiteam-teamtab-name">{me.title}</span>
          <span className="aiteam-teamtab-chain" data-chain>
            {t('aiteam.place.you')}
            {chain.map((s) => (
              <span key={s}>
                {' › '}
                {s === slug
                  ? <b>{rowOf.get(s)?.title ?? s}</b>
                  : <button type="button" className="aiteam-convo-path-link" onClick={() => onOpen(s)}>{rowOf.get(s)?.title ?? s}</button>}
              </span>
            ))}
          </span>
        </div>
        {node.team && <span className="aiteam-tag aiteam-tag--accent">{node.team}</span>}
      </div>
      {!readOnly && <div className="aiteam-teamtab-actions">
        <button type="button" className="agp-btn agp-btn--primary" onClick={() => onTalk(slug)}>{t('agents.profile.talk')}</button>
        {!summary?.implicit && (
          <button type="button" className="agp-btn" onClick={() => setEditing(editing === 'manager' ? null : 'manager')} data-change-manager>
            {t('aiteam.team.changeManager')}
          </button>
        )}
      </div>}
      {editing === 'manager' && !readOnly && (
        <ManagerPicker slug={slug} tree={tree} agents={agents} onDone={() => setEditing(null)} onToast={onToast} />
      )}

      <p className="aiteam-panel-label">{t('aiteam.team.reportsTo')}</p>
      {manager
        ? <MemberCard row={manager} now={now} onOpen={onOpen} />
        : <div className="aiteam-teamtab-you">{t('aiteam.team.toYou')}</div>}

      <p className="aiteam-panel-label">
        {t('aiteam.team.its')}
        {node.ownTeam ? ` · ${node.ownTeam}` : ''}
        {' · '}
        {(reports.length === 1 ? t('aiteam.tree.reports.one') : t('aiteam.tree.reports.many')).replace('{n}', String(reports.length))}
      </p>
      {reports.map((r) => <MemberCard key={r.slug} row={r} now={now} onOpen={onOpen} />)}
      {editing === 'add' ? (
        <div className="aiteam-place-edit">
          <select
            className="agent-input"
            aria-label={t('aiteam.team.addReport')}
            defaultValue=""
            disabled={place.isPending}
            onChange={(e) => e.target.value && place.mutate(
              { slug: e.target.value, placement: { reportsTo: slug } },
              {
                onSuccess: () => { onToast(t('aiteam.team.added').replace('{name}', me.title)); setEditing(null); },
                onError: (err) => onToast((err as Error).message),
              },
            )}
            data-add-report-picker
          >
            <option value="" disabled>{t('aiteam.team.pick')}</option>
            {addable.map((a) => <option key={a.slug} value={a.slug}>{a.title}</option>)}
          </select>
          <button type="button" className="agp-textbtn" onClick={() => setEditing(null)}>{t('aiteam.place.cancel')}</button>
        </div>
      ) : (
        !summary?.implicit && !readOnly && addable.length > 0 && (
          <button type="button" className="aiteam-teamtab-add" onClick={() => setEditing('add')} data-add-report>
            + {t('aiteam.team.addReport')}
          </button>
        )
      )}

      <p className="aiteam-panel-label">{t('aiteam.team.routines').replace('{n}', String(routines.length))}</p>
      {routines.length === 0 ? (
        <p className="aiteam-panel-empty">{t('aiteam.team.noRoutines')}</p>
      ) : (
        <div className="aiteam-teamtab-routines">
          {routines.map(({ owner, routine }) => (
            <div key={routine.slug} className="aiteam-teamtab-routine">
              <AgentAvatar of="agent" slug={owner.slug} title={owner.title} hasPhoto={owner.hasPhoto} size={18} />
              <span className="aiteam-teamtab-routine-name">
                {routine.title}
                {!routine.enabled && <span className="aiteam-teamtab-routine-state"> {t('aiteam.routine.paused')}</span>}
              </span>
              <span className="aiteam-teamtab-routine-when">{routine.cadenceLabel}</span>
            </div>
          ))}
        </div>
      )}

      <p className="aiteam-tip">{t('aiteam.team.later')}</p>
    </div>
  );
}

/** A teammate in the Team tab: face, name, its routines, and what it is doing or last said. */
function MemberCard({ row, now, onOpen }: { row: TeamRow; now: number; onOpen: (slug: string) => void }) {
  const { t } = useI18n();
  const working = row.status === 'working';
  const dot = working ? 'working' : row.status === 'needs' ? 'needs' : row.status === 'idle' ? 'idle' : null;
  return (
    <button type="button" className="aiteam-teamtab-member" onClick={() => onOpen(row.slug)} data-member={row.slug}>
      <span className="aiteam-face aiteam-org-face">
        <AgentAvatar of="agent" slug={row.slug} title={row.title} hasPhoto={row.hasPhoto} size={32} />
        {dot && <span className={`aiteam-face-dot aiteam-face-dot--${dot}`} aria-hidden="true" />}
      </span>
      <span className="aiteam-teamtab-member-main">
        <span className="aiteam-row-top">
          <span className="aiteam-row-name">{row.title}</span>
          {row.routines.length > 0 && <span className="aiteam-row-time">{routineCountLabel(row.routines.length, t)}</span>}
        </span>
        <span className={`aiteam-teamtab-member-line${working ? ' aiteam-row-preview--live' : ''}`}>
          {working
            ? t('aiteam.working').replace('{time}', (row.workingSince ? runDuration(now - row.workingSince) : null) ?? '')
            : row.status === 'needs' ? t('aiteam.tag.needs')
              : row.status === 'approval' ? t('aiteam.tag.approval')
                : row.preview ?? row.role}
        </span>
      </span>
      {row.unread > 0 && <span className="sidebar-badge">{row.unread}</span>}
    </button>
  );
}
