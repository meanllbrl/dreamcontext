import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudPhase } from './cloud-mode.js';

/**
 * The cloud's own trip state, persisted in the 0700 dcserver dir: the phase the phone gate
 * reads (`sealed | active | quiescing`), the quiesce epoch, the trip and the laptop that
 * started it. Transitions happen ONLY through the transfer routes (handsfree-cloud.ts) and
 * the idle clock's two backstops (AC13 revert, 2 h seal), each a method here.
 *
 * A missing or corrupt file reads as sealed with no trip: nothing serves the phone until a
 * laptop proves itself and activates a trip (fail closed).
 */

export interface CloudTripRecord {
  version: 1;
  phase: CloudPhase;
  /** Bumped by every quiesce; seal/cut/snapshot/unquiesce must name the current one. */
  epoch: number;
  tripId: string | null;
  laptopId: string | null;
  /** Laptop ids that lost the cloud to a take-over (AC24): they see `superseded`. */
  supersededLaptopIds: string[];
  /** The laptop's go manifest (manifest.ts GoManifest), as received at `POST trip`. */
  go: unknown | null;
  /** Root ids of the trip (also written into the mirror's trip marker). */
  rootIds: string[];
  /** POST trip accepted, activate not yet: the phone is still off, the clock defers. */
  goingSince: number | null;
  quiescingSince: number | null;
  /** The epoch whose return snapshot was served (AC13: no auto-revert after that). */
  servedEpoch: number | null;
  /** The epoch this cloud was sealed under (D21): a finalization repeated for it is alreadyDone. */
  sealedEpoch: number | null;
  /** This quiesce must never auto-revert to active: a recovery, or a quiesce of a sealed cloud. */
  noRevert: boolean;
  /** Last transfer call of the laptop (any route): "laptop progress" for AC13 and the 2 h seal. */
  lastLaptopProgressAt: number | null;
  updatedAt: number;
}

export const SEALED_EMPTY: CloudTripRecord = {
  version: 1,
  phase: 'sealed',
  epoch: 0,
  tripId: null,
  laptopId: null,
  supersededLaptopIds: [],
  go: null,
  rootIds: [],
  goingSince: null,
  quiescingSince: null,
  servedEpoch: null,
  sealedEpoch: null,
  noRevert: false,
  lastLaptopProgressAt: null,
  updatedAt: 0,
};

/** How often laptop progress is written to disk at most. */
const PROGRESS_PERSIST_MS = 5_000;

const PHASES: readonly CloudPhase[] = ['sealed', 'active', 'quiescing'];
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse a stored record; anything malformed reads as sealed (fail closed). */
export function parseTripRecord(raw: unknown): CloudTripRecord {
  if (!raw || typeof raw !== 'object') return { ...SEALED_EMPTY };
  const r = raw as Record<string, unknown>;
  if (!PHASES.includes(r.phase as CloudPhase)) return { ...SEALED_EMPTY };
  return {
    version: 1,
    phase: r.phase as CloudPhase,
    epoch: Number.isSafeInteger(r.epoch) && (r.epoch as number) >= 0 ? r.epoch as number : 0,
    tripId: typeof r.tripId === 'string' && ID_RE.test(r.tripId) ? r.tripId : null,
    laptopId: typeof r.laptopId === 'string' && ID_RE.test(r.laptopId) ? r.laptopId : null,
    supersededLaptopIds: Array.isArray(r.supersededLaptopIds)
      ? r.supersededLaptopIds.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)).slice(-50)
      : [],
    go: r.go ?? null,
    rootIds: Array.isArray(r.rootIds) ? r.rootIds.filter((x): x is string => typeof x === 'string') : [],
    goingSince: numOrNull(r.goingSince),
    quiescingSince: numOrNull(r.quiescingSince),
    servedEpoch: numOrNull(r.servedEpoch),
    sealedEpoch: numOrNull(r.sealedEpoch),
    noRevert: r.noRevert === true,
    lastLaptopProgressAt: numOrNull(r.lastLaptopProgressAt),
    updatedAt: numOrNull(r.updatedAt) ?? 0,
  };
}

export class CloudStateStore {
  private readonly file: string;
  private readonly now: () => number;
  private rec: CloudTripRecord;

  constructor(opts: { dir: string; now?: () => number }) {
    this.file = join(opts.dir, 'cloud-trip.json');
    this.now = opts.now ?? Date.now;
    let raw: unknown = null;
    try { raw = JSON.parse(readFileSync(this.file, 'utf-8')); } catch { /* absent: sealed */ }
    this.rec = parseTripRecord(raw);
  }

  get(): Readonly<CloudTripRecord> {
    return this.rec;
  }

  phase(): CloudPhase {
    return this.rec.phase;
  }

  /** Persist BEFORE the in-memory state changes, so a crash never serves a phase it did not store. */
  private commit(next: CloudTripRecord): CloudTripRecord {
    const stamped = { ...next, updatedAt: this.now() };
    const dir = join(this.file, '..');
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(stamped), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.rec = stamped;
    return stamped;
  }

  /** Any authenticated transfer call: the laptop is making progress. */
  touchLaptopProgress(): void {
    const now = this.now();
    const last = this.rec.lastLaptopProgressAt;
    // Persisted with the state (a restart while quiescing must not forget the laptop was
    // making progress), at most every few seconds so a chunk storm does not rewrite the file
    // per chunk.
    if (last === null || now - last >= PROGRESS_PERSIST_MS) this.commit({ ...this.rec, lastLaptopProgressAt: now });
    else this.rec = { ...this.rec, lastLaptopProgressAt: now };
  }

  /** The transfer routes that only make sense during a return: quiescing AND this epoch. */
  quiescingEpoch(epoch: unknown): 'ok' | 'not_quiescing' | 'epoch_mismatch' {
    if (!this.epochMatches(epoch)) return 'epoch_mismatch';
    return this.rec.phase === 'quiescing' ? 'ok' : 'not_quiescing';
  }

  /**
   * POST trip. Refused unless sealed; a live trip of ANOTHER laptop needs takeOver. A
   * take-over marks the previous laptop superseded (AC24).
   */
  /** The verdict {@link startTrip} would give, without changing anything. */
  checkStartTrip(p: { laptopId: string; takeOver: boolean }): { ok: true } | { ok: false; error: 'not_sealed' | 'laptop_mismatch' } {
    const cur = this.rec;
    // A superseded laptop coming back is simply a foreign laptop now (laptop_mismatch); it
    // reads `supersededLaptopIds` from health to know why.
    if (cur.phase !== 'sealed') return { ok: false, error: 'not_sealed' };
    const foreign = cur.laptopId !== null && cur.laptopId !== p.laptopId;
    if (foreign && !p.takeOver) return { ok: false, error: 'laptop_mismatch' };
    return { ok: true };
  }

  startTrip(p: { tripId: string; laptopId: string; go: unknown; rootIds: string[]; takeOver: boolean }):
    | { ok: true; record: CloudTripRecord }
    | { ok: false; error: 'not_sealed' | 'laptop_mismatch' } {
    const cur = this.rec;
    const verdict = this.checkStartTrip(p);
    if (!verdict.ok) return verdict;
    const foreign = cur.laptopId !== null && cur.laptopId !== p.laptopId;
    const superseded = foreign
      ? [...cur.supersededLaptopIds.filter((x) => x !== cur.laptopId && x !== p.laptopId), cur.laptopId as string]
      : cur.supersededLaptopIds.filter((x) => x !== p.laptopId);
    const record = this.commit({
      ...cur,
      phase: 'sealed',
      tripId: p.tripId,
      laptopId: p.laptopId,
      supersededLaptopIds: superseded,
      go: p.go,
      rootIds: p.rootIds,
      goingSince: this.now(),
      quiescingSince: null,
      servedEpoch: null,
      noRevert: false,
      lastLaptopProgressAt: this.now(),
    });
    return { ok: true, record };
  }

  activate(tripId: string): { ok: true } | { ok: false; error: 'trip_mismatch' } {
    if (this.rec.tripId !== tripId) return { ok: false, error: 'trip_mismatch' };
    this.commit({ ...this.rec, phase: 'active', goingSince: null, quiescingSince: null });
    return { ok: true };
  }

  /** Every quiesce gets a NEW epoch, persisted before the reply (AC13). */
  quiesce(tripId: string, o: { recovery?: boolean } = {}): { ok: true; epoch: number } | { ok: false; error: 'trip_mismatch' } {
    if (this.rec.tripId !== tripId) return { ok: false, error: 'trip_mismatch' };
    const epoch = this.rec.epoch + 1;
    // A recovery (D12), or any quiesce of a SEALED cloud, never turns the phone back on by itself.
    const noRevert = o.recovery === true || this.rec.phase === 'sealed';
    this.commit({ ...this.rec, phase: 'quiescing', epoch, noRevert, quiescingSince: this.now(), servedEpoch: null, goingSince: null, lastLaptopProgressAt: this.now() });
    return { ok: true, epoch };
  }

  epochMatches(epoch: unknown): boolean {
    return typeof epoch === 'number' && epoch === this.rec.epoch && this.rec.epoch > 0;
  }

  markServed(epoch: number): void {
    this.commit({ ...this.rec, servedEpoch: epoch, lastLaptopProgressAt: this.now() });
  }

  /** quiescing → active (a cancelled return, or the AC13 auto-revert). */
  /** quiescing → active. Bumps the epoch, so a stale caller can never snapshot or seal the
   *  now active cloud with the epoch of the return that was cancelled. */
  unquiesce(): boolean {
    if (this.rec.phase !== 'quiescing') return false;
    this.commit({ ...this.rec, phase: 'active', epoch: this.rec.epoch + 1, quiescingSince: null, servedEpoch: null, noRevert: false });
    return true;
  }

  /** Sealed under the current epoch (callers wipe the secret class FIRST, D21). */
  seal(): void {
    this.commit({ ...this.rec, phase: 'sealed', sealedEpoch: this.rec.epoch, quiescingSince: null, goingSince: null, noRevert: false });
  }

  /**
   * D21: wipe-secrets and seal are idempotent ensure-operations. Quiescing at the current
   * epoch: do it. Sealed at exactly this epoch: already done. An older epoch than the current
   * one: epoch_mismatch. Anything else: not_quiescing.
   */
  finalizeVerdict(epoch: unknown): 'do' | 'already_done' | 'epoch_mismatch' | 'not_quiescing' {
    const r = this.rec;
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) return 'epoch_mismatch';
    if (r.phase === 'quiescing' && epoch === r.epoch) return 'do';
    if (r.phase === 'sealed' && r.sealedEpoch !== null && epoch === r.sealedEpoch) return 'already_done';
    if (epoch < r.epoch) return 'epoch_mismatch';
    return 'not_quiescing';
  }
}
