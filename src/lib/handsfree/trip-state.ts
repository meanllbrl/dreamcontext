/**
 * The laptop's hands-free phase: `home | going | away | returning`, kept in
 * `~/.dreamcontext/handsfree/state.json` and changed only under `acquireFileLock`.
 *
 * PINNED for wave 2 (lane F consumes these at every spawn chokepoint, the lock middleware
 * and the background writers):
 *   - {@link handsfreeLockFor}(path) → the lock covering `path`, or null;
 *   - {@link isAway}() → true whenever the laptop is not `home` (going, away, returning:
 *     the roots are locked from the first step of go until return lands).
 * Both are synchronous and cheap (one small JSON read); `home` is injectable for tests.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep, basename } from 'node:path';
import { acquireFileLockWithin, releaseFileLock } from '../file-lock.js';
import { atomicWriteFile } from './paths.js';

export type LaptopPhase = 'home' | 'going' | 'away' | 'returning';

export interface LockedRoot {
  rootId: string;
  /** Realpath at lock time. */
  path: string;
}

export interface TripState {
  version: 1;
  phase: LaptopPhase;
  tripId: string | null;
  roots: LockedRoot[];
  updatedAt: string;
  /** Free-form orchestration fields wave 2 owns (pending cloud finalization, …). */
  extra?: Record<string, unknown>;
  /**
   * Set ONLY by {@link readTripState} when state.json exists but neither it nor its
   * last-good copy can be read: the laptop fails CLOSED (phase `away`, every path locked)
   * until the named file is repaired. Never written.
   */
  unreadable?: string;
}

export const HOME_STATE: TripState = { version: 1, phase: 'home', tripId: null, roots: [], updatedAt: new Date(0).toISOString() };

export function handsfreeDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'handsfree');
}

export function statePath(home?: string): string {
  return join(handsfreeDir(home), 'state.json');
}

/** The last-good copy, rewritten after every successful update. */
export function lastGoodPath(home?: string): string {
  return join(handsfreeDir(home), 'state.last-good.json');
}

function parseState(path: string): TripState | null {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as TripState;
    if (s?.version === 1 && PHASES.includes(s.phase) && Array.isArray(s.roots) && (s.phase === 'home' || typeof s.tripId === 'string')) {
      delete s.unreadable;
      return s;
    }
  } catch { /* unreadable */ }
  return null;
}

const PHASES: LaptopPhase[] = ['home', 'going', 'away', 'returning'];

/**
 * Read the state (no lock: writes are atomic renames). FAILS CLOSED:
 *  - no state file → `home` (the normal case: never went hands-free);
 *  - state.json unreadable/corrupt → the last-good copy;
 *  - neither readable → `away` with `unreadable` set: {@link isAway} is true and
 *    {@link handsfreeLockFor} locks every path until the file is repaired.
 */
export function readTripState(home?: string): TripState {
  const main = statePath(home);
  let exists = true;
  try {
    lstatSync(main);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
  }
  if (!exists) return { ...HOME_STATE, roots: [] };
  const s = parseState(main) ?? parseState(lastGoodPath(home));
  if (s) return s;
  return {
    ...HOME_STATE,
    phase: 'away',
    tripId: 'unreadable',
    roots: [],
    unreadable: `hands-free state file ${main} is unreadable and has no readable last-good copy; every path stays locked until it is repaired`,
  };
}

/** Allowed laptop transitions (anything else is a bug in the caller). */
const TRANSITIONS: Record<LaptopPhase, LaptopPhase[]> = {
  home: ['going'],
  going: ['away', 'home'], // home: preflight failure / abandon before away
  away: ['returning', 'home'], // home: abandon (D12) or superseded
  returning: ['home', 'away'], // away: cancel back to active, or Roll back
};

export class TripStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TripStateError';
  }
}

/**
 * Change the state under the state lock. `mutate` gets the current state and returns the
 * next one; a phase change must be an allowed transition. Leaving for `home` clears the
 * trip and the roots.
 */
export async function updateTripState(
  mutate: (cur: TripState) => TripState,
  o: { home?: string; waitMs?: number } = {},
): Promise<TripState> {
  const lock = statePath(o.home) + '.lock';
  if (!(await acquireFileLockWithin(lock, { waitMs: o.waitMs ?? 5000, staleMs: 10_000 }))) {
    throw new TripStateError('hands-free state is locked by another process');
  }
  try {
    const cur = readTripState(o.home);
    if (cur.unreadable) throw new TripStateError(cur.unreadable);
    const next = mutate(structuredClone(cur));
    if (!PHASES.includes(next.phase)) throw new TripStateError(`bad phase ${String(next.phase)}`);
    if (next.phase !== cur.phase && !TRANSITIONS[cur.phase].includes(next.phase)) {
      throw new TripStateError(`illegal transition ${cur.phase} → ${next.phase}`);
    }
    const out: TripState = next.phase === 'home'
      ? { version: 1, phase: 'home', tripId: null, roots: [], updatedAt: new Date().toISOString(), ...(next.extra ? { extra: next.extra } : {}) }
      : { ...next, version: 1, updatedAt: new Date().toISOString() };
    if (out.phase !== 'home' && !out.tripId) throw new TripStateError(`phase ${out.phase} needs a trip id`);
    const text = JSON.stringify(out, null, 2) + '\n';
    atomicWriteFile(statePath(o.home), text);
    atomicWriteFile(lastGoodPath(o.home), text);
    return out;
  } finally {
    releaseFileLock(lock);
  }
}

/** Lock roots for a new trip: home → going (LOCK FIRST, before anything else of go). */
export function beginGoing(tripId: string, roots: Array<{ rootId: string; path: string }>, home?: string): Promise<TripState> {
  const locked = roots.map((r) => ({ rootId: r.rootId, path: realpathOrResolve(r.path) }));
  return updateTripState((cur) => {
    if (cur.phase !== 'home') throw new TripStateError(`cannot start a trip while ${cur.phase}`);
    return { ...cur, phase: 'going', tripId, roots: locked };
  }, { home });
}

export function setPhase(phase: LaptopPhase, expectTrip: string, home?: string): Promise<TripState> {
  return updateTripState((cur) => {
    if (cur.tripId !== expectTrip) throw new TripStateError(`trip mismatch: state has ${cur.tripId ?? 'none'}`);
    return { ...cur, phase };
  }, { home });
}

/** True whenever the laptop is not `home` (going, away or returning). */
export function isAway(home?: string): boolean {
  return readTripState(home).phase !== 'home';
}

export interface HandsfreeLock {
  tripId: string;
  phase: Exclude<LaptopPhase, 'home'>;
  rootId: string;
  root: string;
  /** Present when the state file is unreadable: everything is locked, this names the file. */
  error?: string;
}

function realpathOrResolve(p: string): string {
  // Resolve the nearest existing ancestor (a cwd about to be created still counts).
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(cur);
      return join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

function within(root: string, p: string, caseInsensitive: boolean): boolean {
  const a = caseInsensitive ? root.toLowerCase() : root;
  const b = caseInsensitive ? p.toLowerCase() : p;
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/**
 * The hands-free lock covering `path` (a cwd, a vault root, a file), or null when the
 * laptop is home or the path is outside every locked root. Symlinks are resolved; on
 * macOS the comparison is case-insensitive (APFS default), so `~/Projects/X` cannot dodge
 * a lock on `~/projects/x`.
 */
export function handsfreeLockFor(path: string, home?: string): HandsfreeLock | null {
  const s = readTripState(home);
  if (s.unreadable) return { tripId: s.tripId ?? 'unreadable', phase: 'away', rootId: '*', root: '/', error: s.unreadable };
  if (s.phase === 'home' || !s.tripId) return null;
  const p = realpathOrResolve(path);
  const ci = process.platform === 'darwin' || process.platform === 'win32';
  for (const r of s.roots) {
    if (within(r.path, p, ci)) return { tripId: s.tripId, phase: s.phase, rootId: r.rootId, root: r.path };
  }
  return null;
}
