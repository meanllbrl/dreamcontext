import { useEffect, useMemo, useState } from 'react';
import { useApi, useInstanceEvent } from '../../../context/VaultContext';
import { useAgents } from '../../../hooks/useAgents';
import { useAgentFeed, useAutomations } from '../../../hooks/useAutomations';
import { identitiesOf, membersOf } from '../../../hooks/useDrawerProjects';
import { AGENT_SURFACE_EXPANDED_EVENT } from '../../../lib/agentSettings';
import { DRAWER_SURFACE_EVENT, type DrawerSurfaceState } from '../../../lib/drawerIntents';
import { pollMs } from '../../../lib/windowActivity';
import { buildRoster, type EkipSummary, type TeamAgent } from '../../aiteam/teamModel';
import { DRAWER_POLL_MS, headlessRowsOf, type DrawerFacts } from './drawerModel';

/**
 * Facts up (D5): what the window's chat drawer shows under this project. Mounted in every
 * new-shell `ProjectInstance`, beside `RollupBridge` and before `AgentSurface`, so its listener
 * is in place before the surface's first ring. Published for hidden instances too: the drawer
 * lists every project, not just the one on screen.
 *
 * The Ekip row (plan-r10 1d) reads `GET /agent/sessions?summary=1` `members` (owner and routine
 * work only, counted on the server) and the agents' names and faces. The headless roster
 * (`buildRoster`) is kept only for in-flight headless `team` jobs and a routine's question.
 * While the drawer is on screen the reads poll every 15 s. Renders nothing.
 */
export function DrawerFactsBridge({ vault, drawerVisible, onFacts }: {
  vault: string;
  drawerVisible: boolean;
  onFacts?: (vault: string, facts: DrawerFacts) => void;
}) {
  const api = useApi();
  const poll = drawerVisible ? DRAWER_POLL_MS : undefined;
  const agentsQ = useAgents({ pollEveryMs: poll });
  const automationsQ = useAutomations({ pollEveryMs: poll });
  const { data: feed } = useAgentFeed();
  const team = useMemo(
    () => headlessRowsOf(buildRoster((agentsQ.data ?? []) as TeamAgent[], automationsQ.data ?? [], feed)),
    [agentsQ.data, automationsQ.data, feed],
  );
  const identities = useMemo(() => identitiesOf(agentsQ.data ?? []), [agentsQ.data]);
  const [members, setMembers] = useState<EkipSummary[] | undefined>(undefined);
  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      void api.get<{ members?: unknown }>('/agent/sessions?summary=1').then(
        (summary) => { if (!gone) setMembers(membersOf(summary)); },
        () => { /* a failed read keeps the last answer */ },
      ).finally(() => { if (!gone && drawerVisible) timer = setTimeout(read, pollMs(DRAWER_POLL_MS)); });
    };
    read();
    return () => { gone = true; if (timer) clearTimeout(timer); };
  }, [api, drawerVisible]);
  const [surface, setSurface] = useState<DrawerSurfaceState>({ superOn: false, superSelected: false });
  const [chatOpen, setChatOpen] = useState(false);
  useInstanceEvent<DrawerSurfaceState>(DRAWER_SURFACE_EVENT, (s) => { if (s) setSurface(s); });
  useInstanceEvent<boolean>(AGENT_SURFACE_EXPANDED_EVENT, (open) => setChatOpen(open === true));

  // Primitive keys: arrays rebuilt with the same rows must not re-render the window.
  const teamKey = team.map((m) => `${m.slug}:${m.status}:${m.superOnly ? 1 : 0}:${m.preview ?? ''}`).join('|');
  const ekipKey = JSON.stringify([members ?? null, identities]);
  const windowsKey = JSON.stringify([surface.activeWindowId, surface.windows, surface.shown, surface.member, surface.superMarks, surface.chats, surface.activeChatId]);
  useEffect(() => {
    onFacts?.(vault, {
      superOn: surface.superOn, superSelected: surface.superSelected, chatOpen, team,
      ...(members ? { members, identities } : {}),
      ...(surface.windows ? { windows: surface.windows, activeWindowId: surface.activeWindowId } : {}),
      ...(surface.shown ? { shown: surface.shown } : {}),
      ...(surface.member ? { member: surface.member } : {}),
      ...(surface.superMarks ? { superMarks: surface.superMarks } : {}),
      ...(surface.chats ? { chats: surface.chats } : {}),
      ...(surface.activeChatId ? { activeChatId: surface.activeChatId } : {}),
    });
    // `team`, the members and the windows are read through their keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, onFacts, surface.superOn, surface.superSelected, chatOpen, teamKey, ekipKey, windowsKey]);
  return null;
}
