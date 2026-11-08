/**
 * The projects the new shell lists (picker, drawer, History, the launcher's first pick), in the
 * shape the shell reads.
 *
 * On Mac mode's tunnel the Mac serves only the projects chosen at start, by name (`GET /vaults`,
 * vault-agnostic): no path, no logo (logos are not requested on the tunnel), no recency. Its
 * order is the list's order, and nothing about it is written anywhere. Everywhere else it is the
 * launcher's status, as today.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { isMacPhoneSurface } from '../lib/phoneSurface';
import { useLauncherStatus } from './useLauncher';

export interface ShellProject {
  name: string;
  exists: boolean;
  logo: boolean;
  logoStamp: number | null;
  lastOpenedAt?: string | null;
}

/** The tunnel's `/vaults` answer as shell projects: chosen ones only, never a logo. Pure. */
export function tunnelProjects(raw: { vaults?: Array<{ name?: unknown; exists?: unknown }> } | undefined): ShellProject[] {
  return (raw?.vaults ?? [])
    .filter((v): v is { name: string; exists: boolean } => typeof v.name === 'string' && v.exists === true)
    .map((v) => ({ name: v.name, exists: true, logo: false, logoStamp: null }));
}

export function useShellProjects(enabled = true): { data: { vaults: ShellProject[] } | undefined; isError: boolean } {
  const tunnel = isMacPhoneSurface();
  const launcher = useLauncherStatus(enabled && !tunnel);
  const phone = useQuery({
    queryKey: ['shell-projects-tunnel'],
    queryFn: async () => ({ vaults: tunnelProjects(await api.get<{ vaults?: Array<{ name?: unknown; exists?: unknown }> }>('/vaults')) }),
    enabled: enabled && tunnel,
    staleTime: 30_000,
    retry: false,
  });
  return tunnel ? { data: phone.data, isError: phone.isError } : { data: launcher.data, isError: launcher.isError };
}
