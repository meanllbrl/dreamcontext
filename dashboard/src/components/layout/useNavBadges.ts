import { useEffect, useState } from 'react';
import { useAgentFeed } from '../../hooks/useAutomations';
import { useInstanceEvent } from '../../context/VaultContext';
import { useAppsWaiting } from '../../hooks/useAppsWaiting';
import { useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import { AGENT_SURFACE_EXPANDED_EVENT, agentSurfaceSettings, onAgentSettings, readAgentSettings } from '../../lib/agentSettings';
import { PROJECT_ROLLUP_EVENT } from '../sleepy/AgentSurface';
import type { ProjectRollup } from '../sleepy/agentStatus';

/**
 * What the project's navigation shows beside its rows: the AI Team's unread, whether Chat is offered, the live-chat rollup and whether the chat
 * overlay is open. Moved out of `Sidebar` unchanged, so the classic sidebar and
 * the new shell's `Rail` read ONE set of badges.
 */
export function useNavBadges() {
  // PROJECT-WIDE unread in the agents channel. The rail is the only place a
  // message is visible from another page, so without this an agent that fired
  // while the user was in Tasks is a thing they find out about tomorrow.
  // Per MACHINE, like every other thread read mark — a teammate reading it on
  // their laptop must not clear this badge here.
  const { data: agentFeed } = useAgentFeed();
  const agentUnread = agentFeed?.unreadTotal ?? 0;
  // The Chat row shows under the SAME gate as the corner FAB — desktop, and the surface
  // enabled in Settings — so the rail never offers a launcher that opens nothing.
  const { data: caps } = useAgentCapabilities();
  const [chatEnabled, setChatEnabled] = useState<boolean>(() => agentSurfaceSettings(readAgentSettings()).enabled);
  useEffect(() => onAgentSettings((cfg) => setChatEnabled(agentSurfaceSettings(cfg).enabled)), []);
  const showChat = !!caps?.desktop && chatEnabled;
  // Live chats in THIS project, and whether one of them wants you. The surface publishes the
  // rollup on change only; it starts at zero sessions, so a rail mounted with it never misses
  // a count that mattered.
  const [chatRollup, setChatRollup] = useState<{ live: number; waiting: number }>({ live: 0, waiting: 0 });
  useInstanceEvent<ProjectRollup>(PROJECT_ROLLUP_EVENT, (r) => setChatRollup({ live: r.live, waiting: r.waiting }));
  // While the overlay covers the page, Chat is where the user IS — one active row, not two.
  const [chatOpen, setChatOpen] = useState(false);
  useInstanceEvent<boolean>(AGENT_SURFACE_EXPANDED_EVENT, (open) => setChatOpen(open === true));
  // Apps: a dot when something from a person this account works with waits (K1, S2).
  const appsWaiting = useAppsWaiting();
  return { agentUnread, showChat, chatRollup, chatOpen, appsWaiting };
}
