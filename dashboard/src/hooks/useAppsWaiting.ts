import { useQuery } from '@tanstack/react-query';
import { useApi, useVault } from '../context/VaultContext';
import { isDesktop } from '../lib/desktop';
import { isPhoneSurface } from '../lib/phoneSurface';

/** `GET /api/apps/shared/waiting` (app-ux-genel K1): what waits for this GitHub account. */
export interface AppsWaiting { known: number; unknown: number; notInstalled: number; signedIn?: boolean }
export const APPS_WAITING_KEY = 'apps-waiting';

/**
 * The Apps row's dot: something from a person this account works with waits (an invitation or a
 * shared app not installed here). Asked when the window opens and again when Apps opens (the page
 * invalidates this key); an invitation from an unknown GitHub account never counts (S2); a failed
 * check counts nothing.
 */
export function useAppsWaiting(): number {
  const api = useApi();
  const { vault } = useVault();
  const { data } = useQuery({
    queryKey: [APPS_WAITING_KEY, vault],
    queryFn: () => api.get<AppsWaiting>('/apps/shared/waiting'),
    enabled: typeof window !== 'undefined' && isDesktop() && !isPhoneSurface(),
    staleTime: Infinity,
    retry: false,
  });
  return data ? data.known + data.notInstalled : 0;
}
