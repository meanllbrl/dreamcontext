import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SyncJob, SyncStatus } from '../../hooks/useTasks';
import { useStartSyncJob, useSyncJob, useSyncStatus } from '../../hooks/useTasks';

/**
 * Cloud-sync toolbar controls, extracted from BoardToolbar (which was over the
 * component-size threshold). Sync runs as a BACKGROUND JOB in the server: the
 * chip only starts it, the poll renders live progress, and the job keeps
 * running (until it settles) even if the user navigates away — coming back
 * re-adopts it mid-flight.
 */

export interface CloudSync {
  syncStatus: SyncStatus | undefined;
  syncJob: SyncJob | null | undefined;
  cloudEnabled: boolean;
  syncing: boolean;
  runSync: (hard?: boolean) => void;
}

export function useCloudSync(flash: (msg: string) => void): CloudSync {
  const queryClient = useQueryClient();
  const { data: syncStatus } = useSyncStatus();
  const { data: syncJob } = useSyncJob();
  const startSyncJob = useStartSyncJob();
  const cloudEnabled = !!syncStatus && syncStatus.backend !== 'local';
  const syncing = syncJob?.status === 'running' || startSyncJob.isPending;

  const runSync = (hard = false) => {
    if (syncing) return;
    if (hard && !window.confirm(
      `Hard refresh from ${syncStatus?.backend}?\n\nLocal task mirrors are backed up and the whole board is re-pulled from the remote (the source of truth). Local-only edits that never synced will not come back from the remote.`,
    )) return;
    startSyncJob.mutate({ hard }, {
      onError: () => flash('Sync could not start — check your connection'),
    });
  };

  // Completion watcher: when a RUNNING job settles (observed via the poll),
  // refresh the board and announce the outcome exactly once. A job that
  // settled while this component was unmounted produces no flash (`!prev`
  // guard) — intentional: a stale toast on remount would be noise.
  const prevJobRef = useRef<SyncJob | null>(null);
  useEffect(() => {
    const prev = prevJobRef.current;
    prevJobRef.current = syncJob ?? null;
    if (!syncJob || syncJob.status === 'running') return;
    if (!prev || prev.id !== syncJob.id || prev.status !== 'running') return;
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
    queryClient.invalidateQueries({ queryKey: ['tasks-sync-status'] });
    const r = syncJob.report;
    if (syncJob.status === 'error') {
      flash(`Sync failed: ${syncJob.error ?? 'unknown error'}`);
    } else if (syncJob.kind === 'hard-refresh') {
      flash(`Hard refresh done · ${r?.pulled ?? 0} pulled from remote`);
    } else if (r && r.conflicts.length > 0) {
      flash(`Synced · ${r.conflicts.length} conflict${r.conflicts.length > 1 ? 's' : ''} to resolve`);
    } else {
      const bits = [r?.pushed && `${r.pushed} pushed`, r?.created && `${r.created} created`, r?.pulled && `${r.pulled} pulled`].filter(Boolean);
      flash(bits.length ? `Synced · ${bits.join(' · ')}` : 'Already up to date');
    }
  }, [syncJob, queryClient, flash]);

  return { syncStatus, syncJob, cloudEnabled, syncing, runSync };
}

/** Keyboard parity for the click-only chip divs (Enter/Space activate). */
const chipKey = (act: () => void) => (e: KeyboardEvent<HTMLDivElement>) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); }
};

const badge = (bg: string): CSSProperties => ({
  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 20, background: bg, color: '#fff',
});

export function SyncChip({ cs, chipStyle }: { cs: CloudSync; chipStyle: CSSProperties }) {
  const { syncStatus, syncJob, syncing, runSync } = cs;
  const label = syncing
    ? (syncJob?.kind === 'hard-refresh' ? 'Refreshing…' : syncJob?.phase === 'push' ? 'Pushing…' : syncJob?.phase === 'pull' ? 'Pulling…' : 'Syncing…')
    : 'Sync';
  return (
    <div className="bd-chip" role="button" tabIndex={0} aria-label={`Sync tasks with ${syncStatus?.backend}`}
      onClick={() => runSync(false)} onKeyDown={chipKey(() => runSync(false))}
      title={syncing ? `Syncing in the background — keeps running if you navigate away${syncJob?.attempt && syncJob.attempt > 1 ? ` (pass ${syncJob.attempt})` : ''}` : `Sync tasks with ${syncStatus?.backend}${syncStatus?.pendingPush ? ` · ${syncStatus.pendingPush} pending` : ''}`}
      style={{ ...chipStyle, cursor: syncing ? 'progress' : 'pointer', opacity: syncing ? 0.7 : 1 }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto', animation: syncing ? 'bd_spin .8s linear infinite' : undefined }}><path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3" /><path d="M21 3v6h-6M3 21v-6h6" /></svg>
      <span>{label}</span>
      {/* live determinate progress — mirrors the server job's per-task ticks */}
      {syncing && !!syncJob && syncJob.total > 0 && (
        <>
          <span style={{ width: 44, height: 4, borderRadius: 2, background: 'var(--color-border)', overflow: 'hidden', flex: '0 0 auto' }} role="progressbar" aria-valuemin={0} aria-valuemax={syncJob.total} aria-valuenow={syncJob.current}>
            <span style={{ display: 'block', height: '100%', width: `${Math.min(100, Math.round((syncJob.current / syncJob.total) * 100))}%`, background: 'var(--color-accent)', transition: 'width .3s ease' }} />
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.8 }}>{syncJob.current}/{syncJob.total}</span>
        </>
      )}
      {!syncing && (syncStatus?.pendingPush ?? 0) > 0 && <span style={badge('var(--color-accent)')}>{syncStatus!.pendingPush}</span>}
      {!syncing && (syncStatus?.conflicts ?? 0) > 0 && <span style={badge('var(--color-error)')}>{syncStatus!.conflicts}!</span>}
    </div>
  );
}

/** Hard refresh — wipe local mirrors + ledger, re-pull everything from the remote. */
export function HardRefreshChip({ cs, chipStyle }: { cs: CloudSync; chipStyle: CSSProperties }) {
  const { syncStatus, runSync } = cs;
  const name = `Hard refresh: re-pull everything from ${syncStatus?.backend}`;
  return (
    <div className="bd-chip" role="button" tabIndex={0} aria-label={name}
      onClick={() => runSync(true)} onKeyDown={chipKey(() => runSync(true))}
      title={`${name} (local mirrors are backed up first)`} style={{ ...chipStyle, cursor: 'pointer' }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M3 12a9 9 0 1 0 9-9" /><path d="M3 3v6h6" /><path d="M12 7v5l3 3" /></svg>
    </div>
  );
}
