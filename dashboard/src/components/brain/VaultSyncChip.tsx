import { VaultDot } from '../layout/VaultDot';
import { TeamUpdatesBadge } from './TeamUpdatesBadge';
import type { TeamVaultUpdate } from '../../hooks/useBrainStatus';

/**
 * Per-project brain-sync chip: reuses `VaultDot`'s green/yellow/red language
 * (`ok`/`stale`/`gone` mapped onto synced/updates-pending/not-connected) so it
 * reads with the same at-a-glance vocabulary as the freshness dot beside it.
 *
 * Shared by both launcher surfaces (the Space cockpit and the List cards) so the
 * two can never drift into describing the same sync state differently.
 */
export function VaultSyncChip({ vault }: { vault?: TeamVaultUpdate }) {
  if (!vault || !vault.enabled || vault.mode !== 'full-repo') {
    return (
      <span
        className="launcher-brain-chip launcher-brain-chip--unconnected"
        title="Cloud sync not set up for this project"
      >
        <VaultDot exists={false} needsUpdate={false} />
        Set up team sync
      </span>
    );
  }
  if (vault.updates > 0 || vault.pendingAgentMerge) {
    return <TeamUpdatesBadge vaultName={vault.name} />;
  }
  return (
    <span className="launcher-brain-chip launcher-brain-chip--synced" title="Brain repo is up to date">
      <VaultDot exists={true} needsUpdate={false} />
      Synced
    </span>
  );
}
