import { useContext, useEffect, useMemo, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useApi, useVaultId } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useAgents } from '../../hooks/useAgents';
import { identitiesOf, membersOf } from '../../hooks/useDrawerProjects';
import { onWindowActivity, pollMs } from '../../lib/windowActivity';
import { requestManageMembers, requestOpenAgents } from '../../lib/openAgents';
import { buildEkip, memberWaitCounts, projectEkip, type EkipSummary } from '../aiteam/teamModel';
import { fetchSuperState } from '../sleepy/super/superApi';
import { buildGlobalTeam, DRAWER_POLL_MS } from './newshell/drawerModel';
import { TeamSection } from './newshell/TeamSection';

/**
 * The classic rail's Ekip row (under Chat) and its Global ekip row (in the footer): the same
 * row and list as the new shell's drawer (plan-r10 1d, 1f), for the ONE project this rail
 * belongs to. Members come from `GET /agent/sessions?summary=1` `members`; the row opens in
 * place (plan r4 D5, `TeamSection`); a member click opens its stage (`requestOpenAgents({ slug })`,
 * the active instance routes it), "Üyeleri yönet" opens the modal. The switch is on the stage.
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
  const { vault: vaultId } = useVaultId();
  const agentsQ = useAgents();
  const [summaries, setSummaries] = useState<EkipSummary[] | undefined>(undefined);
  // What each member has waiting in main's record (its mirrors, its routines): the red count
  // counts every item, not just the summary's one `asking` (a refused or stalled job is there only).
  const [waits, setWaits] = useState<Record<string, number>>({});

  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      void Promise.all([
        api.get<{ members?: unknown }>('/agent/sessions?summary=1').then(
          (s) => { if (!gone) setSummaries(membersOf(s)); },
          () => { /* the last answer stays */ },
        ),
        // Unreadable (null): the last counts stay, like the summary's.
        fetchSuperState(api).then((st) => { if (!gone && st) setWaits(memberWaitCounts(st.enabled ? st.queue : [])); }),
      ]).finally(() => { if (!gone) timer = setTimeout(read, pollMs(DRAWER_POLL_MS)); });
    };
    read();
    // Back in front: read at once (plan r4 D8).
    const offFocus = onWindowActivity((next, prev) => {
      if (gone || !next.focused || prev.focused) return;
      if (timer) clearTimeout(timer);
      read();
    });
    return () => { gone = true; offFocus(); if (timer) clearTimeout(timer); };
  }, [api]);

  const all = useMemo(() => buildEkip(summaries, identitiesOf(agentsQ.data ?? []), [], waits), [summaries, agentsQ.data, waits]);
  const own = useMemo(() => projectEkip(all), [all]);
  const global = useMemo(() => buildGlobalTeam([{ vault: '', members: all }], ''), [all]);

  if (kind === 'project') {
    if (!own.length) return null;
    return (
      <li className="sidebar-team">
        <TeamSection members={own} kind="project" vault={vaultId} label={t('drawer.team.row')} className="sidebar-item" testid="drawer-team-row"
          onOpen={(m) => requestOpenAgents({ slug: m.slug })} onManage={() => requestManageMembers()} onNewMember={() => requestManageMembers({ create: true })} />
      </li>
    );
  }
  if (!global) return null;
  return (
    <div className="ns-team-global">
      <div className="ns-team-global-head">{t('drawer.team.independent')}</div>
      <TeamSection members={global.members} kind="global" label={t('drawer.team.global')} className="sidebar-item" testid="drawer-global-team-row"
        onOpen={(m) => requestOpenAgents({ slug: m.slug })} onManage={() => requestManageMembers()} onNewMember={() => requestManageMembers({ create: true })} />
    </div>
  );
}
