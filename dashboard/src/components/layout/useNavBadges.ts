import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAgentFeed } from '../../hooks/useAutomations';
import { useTheses } from '../../hooks/useTheses';
import { useApi, useInstanceEvent, useVault } from '../../context/VaultContext';
import { isDesktop } from '../../lib/desktop';
import { isPhoneSurface } from '../../lib/phoneSurface';
import { useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import { AGENT_SURFACE_EXPANDED_EVENT, agentSurfaceSettings, onAgentSettings, readAgentSettings } from '../../lib/agentSettings';
import { PROJECT_ROLLUP_EVENT } from '../sleepy/AgentSurface';
import type { ProjectRollup } from '../sleepy/agentStatus';

/** `GET /api/apps/shared/waiting` (app-ux-genel K1): what waits for this GitHub account. */
export interface AppsWaiting { known: number; unknown: number; notInstalled: number; signedIn?: boolean }
export const APPS_WAITING_KEY = 'apps-waiting';

/**
 * What the project's navigation shows beside its rows: the AI Team's unread, whether the
 * learning layer is off, whether Chat is offered, the live-chat rollup and whether the chat
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
  // Hypotheses is in the rail for everyone, on or off. It used to be hidden
  // while the learning layer was disabled, which made the layer undiscoverable
  // by exactly the people who had never turned it on: the page that explains it
  // and carries its enable button was only reachable once it was already
  // enabled. Off now reads as a dimmed item with an "off" tag, and the page
  // itself is the explainer + switch.
  // `=== false`, never `!enabled`: the field is undefined until the query
  // resolves, and a rail that says "off" for a beat before flipping to on is
  // worse than one that simply doesn't label it yet.
  const { data: thesesData } = useTheses();
  const learningOff = thesesData?.enabled === false;
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
  // Apps: a dot when something from a person this account works with waits (an invitation or a
  // shared app not installed here). Asked when the window opens and again when Apps opens (K1);
  // an invitation from an unknown GitHub account never lights it (S2); a failed check, no dot.
  const api = useApi();
  const { vault } = useVault();
  const { data: waiting } = useQuery({
    queryKey: [APPS_WAITING_KEY, vault],
    queryFn: () => api.get<AppsWaiting>('/apps/shared/waiting'),
    enabled: isDesktop() && !isPhoneSurface(),
    staleTime: Infinity,
    retry: false,
  });
  const appsWaiting = waiting ? waiting.known + waiting.notInstalled : 0;
  return { agentUnread, learningOff, showChat, chatRollup, chatOpen, appsWaiting };
}
