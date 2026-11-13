import { useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi, useVault } from '../../context/VaultContext';
import { useShareT } from './Sheet';
import { handOff } from './askAgent';
import { settingsPrompt } from './settingsPrompt';
import { APPS_WAITING_KEY } from '../../hooks/useAppsWaiting';
import { followsOf, installFollowVersion, settleInstall, stepFollow, subscribeInstallFollow, type InstallRow } from './installFollow';

export interface InstallStatus { installs: InstallRow[] }
export const INSTALL_STATUS_KEY = 'apps-install-status';

/**
 * Follows the installs the owner started from Apps, wherever he is (K8, review r1): mounted with
 * the project, not with the page. When the server says one is done it does the next step ONCE:
 * the settings to Claude in a new named chat; the app's own page (its settings sheet for "I'll
 * fill them in") left for Apps; a failure left for Apps in plain words. Renders nothing.
 */
export function InstallFollower() {
  const api = useApi();
  const qc = useQueryClient();
  const { vault, bus } = useVault();
  const ts = useShareT();
  useSyncExternalStore(subscribeInstallFollow, installFollowVersion);
  const v = vault ?? '';
  const mine = followsOf(v);
  const n = mine.size;
  const status = useQuery({
    queryKey: [INSTALL_STATUS_KEY, vault],
    queryFn: () => api.get<InstallStatus>('/apps/install/status'),
    enabled: n > 0,
    refetchInterval: n > 0 ? 1500 : false,
  });

  useEffect(() => {
    if (!n || !status.data) return;
    for (const [k, f] of [...mine]) {
      const step = stepFollow(k, f, status.data.installs, status.dataUpdatedAt);
      if (step.kind === 'wait') continue;
      void qc.invalidateQueries({ queryKey: ['apps', vault] });
      void qc.invalidateQueries({ queryKey: ['apps-shared', vault] });
      void qc.invalidateQueries({ queryKey: [APPS_WAITING_KEY, vault] });
      if (step.kind === 'settle') { settleInstall(v, k, step.outcome); continue; }
      settleInstall(v, k, null);
      const { slug } = step;
      let line: string | null = null;
      try { line = settingsPrompt(slug, ts); } catch { line = null; }
      // The chat doing the settings is what he sees: the app's page waits only when none started.
      const page = () => settleInstall(v, k, { kind: 'open', slug, sheet: null });
      if (line) void handOff(bus, v, ts('handoff.settingsTab', { name: f.name }), line).then((ok) => { if (!ok) page(); }, page);
      else page();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data, status.dataUpdatedAt, n]);
  return null;
}
