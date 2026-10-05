// The fake cloud's finalization rules (D21), in ONE place: the orchestrator test's FakeCloud
// uses them, and tests/unit/handsfree-finalize-contract.test.ts runs the same cases against
// these rules AND lane D's real CloudStateStore + routes, so the fake cannot drift again.
import { CloudError } from '../../src/lib/handsfree/cloud-client.js';

export interface FakePhaseRecord {
  phase: 'sealed' | 'active' | 'quiescing';
  epoch: number;
  sealedEpoch: number | null;
}

/** Lane D's `CloudStateStore.finalizeVerdict`, rule for rule. */
export function fakeFinalizeVerdict(r: FakePhaseRecord, epoch: unknown): 'do' | 'already_done' | 'epoch_mismatch' | 'not_quiescing' {
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) return 'epoch_mismatch';
  if (r.phase === 'quiescing' && epoch === r.epoch) return 'do';
  if (r.phase === 'sealed' && r.sealedEpoch !== null && epoch === r.sealedEpoch) return 'already_done';
  if (epoch < r.epoch) return 'epoch_mismatch';
  return 'not_quiescing';
}

/**
 * wipe-secrets / seal as lane D answers them: idempotent ensure-operations; every seal wipes
 * the secret class first and records sealedEpoch.
 */
export async function fakeFinalize(r: FakePhaseRecord, kind: 'wipe-secrets' | 'seal', epoch: number, wipe: () => void | Promise<void>): Promise<{ alreadyDone: boolean }> {
  const v = fakeFinalizeVerdict(r, epoch);
  if (v === 'epoch_mismatch') throw new CloudError(409, 'epoch_mismatch', 'That quiesce epoch is older than the current one.');
  if (v === 'not_quiescing') throw new CloudError(409, 'not_quiescing', 'The cloud is not quiescing; quiesce it first.');
  if (kind === 'wipe-secrets') {
    await wipe(); // re-runs the idempotent wipe even when already done
    return { alreadyDone: v === 'already_done' };
  }
  if (v === 'already_done') return { alreadyDone: true };
  await wipe();
  r.phase = 'sealed';
  r.sealedEpoch = r.epoch;
  return { alreadyDone: false };
}

/** The cloud's own seal (2 h quiescing cap): wipe first, sealed under the current epoch. */
export async function fakeSelfSeal(r: FakePhaseRecord, wipe: () => void | Promise<void>): Promise<void> {
  await wipe();
  r.phase = 'sealed';
  r.sealedEpoch = r.epoch;
}

/** Lane D's unquiesce: back to active under a NEW epoch. */
export function fakeUnquiesce(r: FakePhaseRecord): boolean {
  if (r.phase !== 'quiescing') return false;
  r.phase = 'active';
  r.epoch++;
  return true;
}

/**
 * Lane D's trip-marker rule for quiesce AND snapshot (handsfree-cloud.ts markerVerdict): a
 * missing marker refuses a normal quiesce / a non-tolerant snapshot (trip_lost); the laptop's
 * recovery (recovery quiesce, tolerant snapshot) is accepted only while the trip's roots are on
 * disk (true = tripLost); roots absent -> mirror_absent (never quiesced, snapshotted or sealed).
 */
export function fakeMarkerVerdict(o: { markerLost: boolean; recovery: boolean; rootsPresent: boolean }): boolean {
  if (!o.markerLost) return false;
  if (!o.recovery) throw new CloudError(409, 'trip_lost', 'The cloud mirror lost this trip (its marker is missing).');
  if (!o.rootsPresent) throw new CloudError(409, 'mirror_absent', 'The trip marker is missing and the trip\'s folders are not on this machine.');
  return true;
}

/** Lane D's quiesce: the marker rule, then quiescing under a new epoch (`tripLost` when lost). */
export function fakeQuiesce(r: FakePhaseRecord, o: { markerLost: boolean; recovery: boolean; rootsPresent?: boolean }): { epoch: number; tripLost?: true } {
  const lost = fakeMarkerVerdict({ markerLost: o.markerLost, recovery: o.recovery, rootsPresent: o.rootsPresent ?? true });
  r.phase = 'quiescing';
  r.epoch++;
  return { epoch: r.epoch, ...(lost ? { tripLost: true as const } : {}) };
}

/** Lane D's guard: a lost-marker trip is wiped or sealed only after its recovery snapshot was served under that epoch. */
export function fakeRequireSnapshotIfLost(o: { markerLost: boolean; servedEpoch: number | null; epoch: number }): void {
  if (o.markerLost && o.servedEpoch !== o.epoch) {
    throw new CloudError(409, 'snapshot_first', 'This trip lost its marker: its recovery snapshot must be taken under this epoch before it is wiped or sealed.');
  }
}
