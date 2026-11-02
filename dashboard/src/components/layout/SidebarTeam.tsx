import { useContext, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useAgents } from '../../hooks/useAgents';
import { identitiesOf, membersOf } from '../../hooks/useDrawerProjects';
import { pollMs } from '../../lib/windowActivity';
import { requestManageMembers, requestOpenAgents } from '../../lib/openAgents';
import { buildEkip, ekipAsking, ekipCount, projectEkip, setMemberEnabled, type EkipSummary } from '../aiteam/teamModel';
import { buildGlobalTeam, DRAWER_POLL_MS } from './newshell/drawerModel';
import { TeamList, TeamRowButton } from './newshell/TeamList';

/**
 * The classic rail's Ekip row (under Chat) and its Global ekip row (in the footer): the same
 * row and list as the new shell's drawer (plan-r10 1d, 1f), for the ONE project this rail
 * belongs to. Members come from `GET /agent/sessions?summary=1` `members`; a member click opens
 * its stage (`requestOpenAgents({ slug })`, the active instance routes it), the switch is
 * `POST /api/agents/:slug/enabled`, "Üyeleri yönet" opens the modal.
 */
export function SidebarTeam({ kind }: { kind: 'project' | 'global' }) {
  // Outside a query client (a bare render of the rail) there is nothing to read: no row, and the
  // rail renders exactly as it did before the Ekip row existed.
  const client = useContext(QueryClientContext);
  return client ? <SidebarTeamRows kind={kind} /> : null;
}

function SidebarTeamRows({ kind }: { kind: 'project' | 'global' }) {
  const { t } = useI18n();
  const api = useApi();
  const agentsQ = useAgents();
  const [summaries, setSummaries] = useState<EkipSummary[] | undefined>(undefined);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      void api.get<{ members?: unknown }>('/agent/sessions?summary=1').then(
        (s) => { if (!gone) setSummaries(membersOf(s)); },
        () => { /* the last answer stays */ },
      ).finally(() => { if (!gone) timer = setTimeout(read, pollMs(DRAWER_POLL_MS)); });
    };
    read();
    return () => { gone = true; if (timer) clearTimeout(timer); };
  }, [api]);

  const all = useMemo(() => buildEkip(summaries, identitiesOf(agentsQ.data ?? [])), [summaries, agentsQ.data]);
  const own = useMemo(() => projectEkip(all), [all]);
  const global = useMemo(() => buildGlobalTeam([{ vault: '', members: all }], ''), [all]);

  const toggle = (slug: string, enabled: boolean) => setMemberEnabled(api, slug, enabled);
  const anchor = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setOpen(open ? null : { x: r.right + 8, y: kind === 'global' ? r.bottom : r.top });
  };

  if (kind === 'project') {
    if (!own.length) return null;
    return (
      <li className="sidebar-team">
        <TeamRowButton members={own} count={ekipCount(own)} asking={ekipAsking(own)} label={t('drawer.team.row')}
          className="sidebar-item" testid="drawer-team-row" expanded={!!open} onClick={anchor} />
        {open && (
          <TeamList title={t('drawer.team.row')} members={own} sheet={false} testid="team-list" anchor={open}
            onOpen={(m) => { setOpen(null); requestOpenAgents({ slug: m.slug }); }}
            onSwitch={(m, enabled) => toggle(m.slug, enabled)}
            onManage={() => requestManageMembers()}
            onClose={() => setOpen(null)} />
        )}
      </li>
    );
  }
  if (!global) return null;
  return (
    <div className="ns-team-global">
      <div className="ns-team-global-head">{t('drawer.team.independent')}</div>
      <TeamRowButton members={global.members} count={global.count} asking={global.asking} label={t('drawer.team.global')}
        className="sidebar-item" testid="drawer-global-team-row" expanded={!!open} onClick={anchor} />
      {open && (
        <TeamList title={`${t('drawer.team.global')} · ${t('drawer.team.globalAll')}`} members={global.members.map((m) => ({ ...m, project: null }))}
          sheet={false} testid="global-team-list" anchor={open}
          onOpen={(m) => { setOpen(null); requestOpenAgents({ slug: m.slug }); }}
          onSwitch={(m, enabled) => toggle(m.slug, enabled)}
          onManage={() => requestManageMembers()}
          onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
