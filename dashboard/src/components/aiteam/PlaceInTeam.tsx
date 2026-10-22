import { useEffect, useMemo, useState } from 'react';
import { buildTree, chainOf, descendantsOf, peersOf, type TeamTree } from '../../../../src/lib/agents/tree.js';
import { AgentAvatar } from '../agents/AgentAvatar';
import { useI18n } from '../../context/I18nContext';
import { useAgents, usePlaceAgent, type AgentSummary } from '../../hooks/useAgents';

/**
 * WHERE A TEAMMATE SITS: who it reports to (and a way to change that), its team, who it works
 * beside, who reports to it, and its whole chain up to you. The Profile tab's "Place in team"
 * and the Org chart's Team tab both draw from this file.
 *
 * Only how the team is DRAWN: `reports_to` and `team` are outside the approval hash, so a
 * change here never re-approves or blocks anything (the server refuses a loop).
 */

export function useTeamTree(): { agents: AgentSummary[]; tree: TeamTree; byslug: Map<string, AgentSummary> } {
  const { data } = useAgents();
  return useMemo(() => {
    const agents = data ?? [];
    return {
      agents,
      tree: buildTree(agents.map((a) => ({ slug: a.slug, reportsTo: a.reportsTo ?? null, team: a.team ?? null }))),
      byslug: new Map(agents.map((a) => [a.slug, a])),
    };
  }, [data]);
}

/** A teammate as a small chip: face and name. Clicking it opens that teammate. */
export function PersonChip({
  agent, on = false, onOpen,
}: {
  agent: Pick<AgentSummary, 'slug' | 'title' | 'hasPhoto'>;
  on?: boolean;
  onOpen?: (slug: string) => void;
}) {
  return (
    <button
      type="button"
      className={`aiteam-person${on ? ' aiteam-person--on' : ''}`}
      onClick={onOpen ? () => onOpen(agent.slug) : undefined}
      disabled={!onOpen || on}
      data-person={agent.slug}
    >
      <AgentAvatar of="agent" slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={18} />
      <span className="aiteam-person-name">{agent.title}</span>
    </button>
  );
}

/** You › … › the teammate, as chips. */
export function ChainChips({ slug, tree, byslug, onOpen }: {
  slug: string;
  tree: TeamTree;
  byslug: Map<string, AgentSummary>;
  onOpen?: (slug: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="aiteam-chain" data-chain>
      <span className="aiteam-person aiteam-person--you">{t('aiteam.place.you')}</span>
      {chainOf(tree, slug).map((s) => {
        const a = byslug.get(s);
        return a ? (
          <span key={s} className="aiteam-chain-step">
            <span className="aiteam-chain-sep" aria-hidden="true">›</span>
            <PersonChip agent={a} on={s === slug} onOpen={onOpen} />
          </span>
        ) : null;
      })}
    </div>
  );
}

/**
 * Change who it reports to: an inline picker of every teammate that would not make a loop
 * (never itself, never anyone below it), plus "You".
 */
export function ManagerPicker({
  slug, tree, agents, onDone, onToast,
}: {
  slug: string;
  tree: TeamTree;
  agents: AgentSummary[];
  onDone: () => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const place = usePlaceAgent();
  const below = useMemo(() => new Set(descendantsOf(tree, slug)), [tree, slug]);
  const current = tree.nodes.get(slug)?.parent ?? '';
  const options = agents.filter((a) => a.slug !== slug && !below.has(a.slug)).sort((a, b) => a.title.localeCompare(b.title));
  const name = agents.find((a) => a.slug === slug)?.title ?? slug;
  return (
    <div className="aiteam-place-edit">
      <select
        className="agent-input"
        aria-label={t('aiteam.place.reportsTo')}
        defaultValue={current}
        disabled={place.isPending}
        onChange={(e) => place.mutate(
          { slug, placement: { reportsTo: e.target.value || null } },
          {
            onSuccess: () => { onToast(t('aiteam.place.saved').replace('{name}', name)); onDone(); },
            onError: (err) => onToast((err as Error).message),
          },
        )}
        data-manager-picker
      >
        <option value="">{t('aiteam.place.youOwner')}</option>
        {options.map((a) => <option key={a.slug} value={a.slug}>{a.title}</option>)}
      </select>
      <button type="button" className="agp-textbtn" onClick={onDone}>{t('aiteam.place.cancel')}</button>
    </div>
  );
}

/** Name (or rename, or clear) a lead's team. */
function TeamNameEditor({ slug, name, current, onDone, onToast }: {
  slug: string;
  name: string;
  current: string | null;
  onDone: () => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const place = usePlaceAgent();
  const [value, setValue] = useState(current ?? '');
  const save = (team: string | null) => place.mutate({ slug, placement: { team } }, {
    onSuccess: () => { onToast(t('aiteam.place.saved').replace('{name}', name)); onDone(); },
    onError: (err) => onToast((err as Error).message),
  });
  return (
    <form className="aiteam-place-edit" onSubmit={(e) => { e.preventDefault(); save(value.trim() || null); }}>
      <input
        className="agent-input"
        value={value}
        maxLength={40}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        aria-label={t('aiteam.place.team')}
        placeholder={t('aiteam.place.teamPlaceholder')}
      />
      <button type="submit" className="agp-btn" disabled={place.isPending}>{t('aiteam.place.save')}</button>
      {current && <button type="button" className="agp-textbtn" onClick={() => save(null)}>{t('aiteam.place.teamClear')}</button>}
      <button type="button" className="agp-textbtn" onClick={onDone}>{t('aiteam.place.cancel')}</button>
    </form>
  );
}

/** The Profile tab's "Place in team" section. */
export function PlaceInTeam({ slug, onOpen, onToast }: {
  slug: string;
  onOpen?: (slug: string) => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const { agents, tree, byslug } = useTeamTree();
  const [editing, setEditing] = useState<'manager' | 'team' | null>(null);
  useEffect(() => setEditing(null), [slug]);
  const me = byslug.get(slug);
  const node = tree.nodes.get(slug);
  if (!me || !node) return null;

  const manager = node.parent ? byslug.get(node.parent) ?? null : null;
  const peers = peersOf(tree, slug).map((s) => byslug.get(s)).filter((a): a is AgentSummary => !!a);
  const reports = node.children.map((s) => byslug.get(s)).filter((a): a is AgentSummary => !!a);
  const lead = node.teamLead && node.teamLead !== slug ? byslug.get(node.teamLead) ?? null : null;

  return (
    <section className="agp-section aiteam-place" aria-label={t('aiteam.place.title')} data-section="place">
      <div className="agp-head">
        <h3 className="agp-h">{t('aiteam.place.title')}</h3>
        <p className="agp-hint">{t('aiteam.place.hint')}</p>
      </div>
      <dl className="aiteam-place-grid">
        <dt>{t('aiteam.place.reportsTo')}</dt>
        <dd>
          {editing === 'manager' ? (
            <ManagerPicker slug={slug} tree={tree} agents={agents} onDone={() => setEditing(null)} onToast={onToast} />
          ) : (
            <span className="aiteam-place-line">
              {manager ? <PersonChip agent={manager} onOpen={onOpen} /> : <span className="aiteam-person aiteam-person--you">{t('aiteam.place.you')}</span>}
              {!me.implicit && (
                <button type="button" className="agp-textbtn" onClick={() => setEditing('manager')} data-change-manager>
                  {t('aiteam.place.change')}
                </button>
              )}
            </span>
          )}
        </dd>

        <dt>{t('aiteam.place.team')}</dt>
        <dd>
          {editing === 'team' ? (
            <TeamNameEditor slug={slug} name={me.title} current={node.ownTeam} onDone={() => setEditing(null)} onToast={onToast} />
          ) : (
            <span className="aiteam-place-line">
              {node.team ? <span className="aiteam-tag aiteam-tag--accent">{node.team}</span> : <span className="agp-muted">{t('aiteam.place.teamNone')}</span>}
              {lead && <span className="agp-muted">{t('aiteam.place.teamFrom').replace('{name}', lead.title)}</span>}
              {node.children.length > 0 && !me.implicit && (
                <button type="button" className="agp-textbtn" onClick={() => setEditing('team')}>
                  {node.ownTeam ? t('aiteam.place.teamRename') : t('aiteam.place.teamName')}
                </button>
              )}
            </span>
          )}
        </dd>

        <dt>{t('aiteam.place.worksWith')}</dt>
        <dd>
          {peers.length > 0
            ? <span className="aiteam-place-line">{peers.map((p) => <PersonChip key={p.slug} agent={p} onOpen={onOpen} />)}</span>
            : <span className="agp-muted">{t('aiteam.place.nobody')}</span>}
        </dd>

        <dt>{t('aiteam.place.reports')}</dt>
        <dd>
          {reports.length > 0
            ? <span className="aiteam-place-line">{reports.map((p) => <PersonChip key={p.slug} agent={p} onOpen={onOpen} />)}</span>
            : <span className="agp-muted">{t('aiteam.place.noReports')}</span>}
        </dd>
      </dl>
      {node.missingManager && <p className="agp-muted">{t('aiteam.place.missing').replace('{slug}', node.missingManager)}</p>}
      {node.cycle && <p className="agp-muted">{t('aiteam.place.loop')}</p>}
      {me.implicit && <p className="agp-muted">{t('aiteam.place.implicit')}</p>}
      <ChainChips slug={slug} tree={tree} byslug={byslug} onOpen={onOpen} />
    </section>
  );
}
