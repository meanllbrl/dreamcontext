/**
 * The chat drawer's running chats (hands-free phone in the new shell, W1): the Mac's
 * `GET /agent/live-chats`, read by the WINDOW so a project this window has not mounted still
 * lists its chats by name.
 *
 * It sits in `WindowChrome`, above any project's `VaultProvider`, so it builds its own client for
 * the project on screen (`new ApiClient(activeVault)`), never the instance hook: a vault-less call is
 * refused on the phone once two projects are chosen (`phone_vault_required`). Read only where the
 * route answers (the Mac's own app window, the tunnel); everywhere else nothing is polled and the
 * drawer draws only the tabs the projects publish. The cadence is `drawerChatsPollMs`.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiClient } from '../api/client';
import { isDesktop } from '../lib/desktop';
import { isMacPhoneSurface } from '../lib/phoneSurface';
import { pollMs, useWindowActivity } from '../lib/windowActivity';
import type { LiveChatsWire } from '../components/handsfree/macContract';
import { drawerChatsPollMs } from '../components/layout/newshell/drawerModel';
import { rememberSuperMirrorIds } from '../components/sleepy/superMirrorIds';

export function useDrawerChats(o: { activeVault: string; drawerVisible: boolean; enabled: boolean }): {
  live: LiveChatsWire | undefined;
  /** The read has answered at least once since the page loaded. */
  answered: boolean;
} {
  const activity = useWindowActivity();
  const tunnel = isMacPhoneSurface();
  const ms = o.enabled && o.activeVault
    ? drawerChatsPollMs({ tunnel, desktop: isDesktop(), drawerVisible: o.drawerVisible, focused: activity.focused, hidden: activity.hidden })
    : false;
  const { data } = useQuery({
    queryKey: ['drawer-live-chats', o.activeVault],
    queryFn: async () => {
      const wire = await new ApiClient(o.activeVault).get<LiveChatsWire>('/agent/live-chats');
      // Every Super conversation the Mac names is shown as the Super's, however it is opened.
      rememberSuperMirrorIds([...(wire.supers ?? []).map((x) => x.conversationId), ...(wire.parked ?? [])]);
      return wire;
    },
    enabled: ms !== false,
    refetchInterval: ms !== false ? () => pollMs(ms) : false,
    staleTime: 2_000,
    retry: false,
    // One answer covers every chosen project: a project switch keeps the last one on screen
    // until the new key answers, instead of blanking the drawer, History and New chat.
    placeholderData: keepPreviousData,
  });
  // Answered at least once (as documented above): a failed poll keeps the last answer, so one
  // weak mobile poll does not empty an open History. Picks re-ask the Mac themselves.
  return { live: data, answered: data !== undefined };
}
