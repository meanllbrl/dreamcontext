import { useEffect, useMemo, useState } from 'react';
import { useInstanceEvent } from '../../../context/VaultContext';
import { useAgents } from '../../../hooks/useAgents';
import { useAgentFeed, useAutomations } from '../../../hooks/useAutomations';
import { AGENT_SURFACE_EXPANDED_EVENT } from '../../../lib/agentSettings';
import { DRAWER_SURFACE_EVENT, type DrawerSurfaceState } from '../../../lib/drawerIntents';
import { buildRoster, type TeamAgent } from '../../aiteam/teamModel';
import { DRAWER_POLL_MS, teamRowsOf, type DrawerFacts } from './drawerModel';

/**
 * Facts up (D5): what the window's chat drawer shows under this project. Mounted in every
 * new-shell `ProjectInstance`, beside `RollupBridge` and before `AgentSurface`, so its listener
 * is in place before the surface's first ring. Published for hidden instances too: the drawer
 * lists every project, not just the one on screen.
 *
 * The team rows are the AI Team page's own three inputs through `buildRoster`. While the drawer
 * is on screen the agents and automations poll every 15 s (a hidden instance's queries would
 * otherwise sit stale); the feed keeps its own interval, the one the classic `Sidebar` polls in
 * every instance and the new shell no longer mounts. Renders nothing.
 */
export function DrawerFactsBridge({ vault, drawerVisible, onFacts }: {
  vault: string;
  drawerVisible: boolean;
  onFacts?: (vault: string, facts: DrawerFacts) => void;
}) {
  const poll = drawerVisible ? DRAWER_POLL_MS : undefined;
  const agentsQ = useAgents({ pollEveryMs: poll });
  const automationsQ = useAutomations({ pollEveryMs: poll });
  const { data: feed } = useAgentFeed();
  const team = useMemo(
    () => teamRowsOf(buildRoster((agentsQ.data ?? []) as TeamAgent[], automationsQ.data ?? [], feed)),
    [agentsQ.data, automationsQ.data, feed],
  );
  const [surface, setSurface] = useState<DrawerSurfaceState>({ superOn: false, superSelected: false });
  const [chatOpen, setChatOpen] = useState(false);
  useInstanceEvent<DrawerSurfaceState>(DRAWER_SURFACE_EVENT, (s) => { if (s) setSurface(s); });
  useInstanceEvent<boolean>(AGENT_SURFACE_EXPANDED_EVENT, (open) => setChatOpen(open === true));

  // A primitive key: a team array rebuilt with the same rows must not re-render the window.
  const teamKey = team.map((m) => `${m.slug}:${m.status}:${m.hasPhoto ? 1 : 0}:${m.title}`).join('|');
  const windowsKey = JSON.stringify([surface.activeWindowId, surface.windows, surface.shown, surface.member, surface.superMarks]);
  useEffect(() => {
    onFacts?.(vault, {
      superOn: surface.superOn, superSelected: surface.superSelected, chatOpen, team,
      ...(surface.windows ? { windows: surface.windows, activeWindowId: surface.activeWindowId } : {}),
      ...(surface.shown ? { shown: surface.shown } : {}),
      ...(surface.member ? { member: surface.member } : {}),
      ...(surface.superMarks ? { superMarks: surface.superMarks } : {}),
    });
    // `team` and the windows are read through their keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, onFacts, surface.superOn, surface.superSelected, chatOpen, teamKey, windowsKey]);
  return null;
}
