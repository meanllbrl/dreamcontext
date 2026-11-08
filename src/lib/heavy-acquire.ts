import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HEAT_RECHECK_MS,
  HEAVY_DEFAULT_WAIT_S,
  acquireFastSlot,
  acquireHeavy,
  clampHeavyLimit,
  fastSlotPaths,
  heavySlotPaths,
  heavySlotsHeld,
  machineHeavySlots,
  machineLoad,
  type HeavyHold,
} from './builder-tools.js';
import { currentHeavyLimit } from './heat.js';
import type { WaitParts } from './run-ledger.js';
import { QUEUE_KEEP_MS, QueuePlace, fastSlotLimit, ordered, readTickets, ticketRow, type QueueLine } from './heavy-queue.js';

/**
 * The heavy lock as `builder heavy` and `builder test` take it, with the one message both print
 * when nothing ran: the heat or memory limit (`./heat.ts`), the
 * machine's slots, or this checkout's lock, whichever the wait actually ran out on.
 */

/** Wait while very hot and no --max-wait was given: a wait plus a slowed run stays under the
 *  Bash tool's 600 s cap. */
export const HEAVY_HOT_WAIT_S = 120;

export interface HeavyAcquireOpts {
  cwd: string;
  lockPath: string;
  slotDir: string;
  /** Seconds the caller asked for (`--max-wait`); undefined = the default for the heat. */
  maxWaitS?: number;
  /** The machine's heavy-step limit right now (tests inject it). */
  heavyLimit?: () => Promise<number>;
  ps: () => string;
  /** This check's place in line. Absent: no queue, the lock is raced as it always was. */
  job?: { key: string; size: number; label: string; line: QueueLine; shared?: boolean };
  /** A line for the waiter, printed as it starts waiting and every {@link WAIT_NOTE_MS}. */
  note?: (line: string) => void;
  /** Is the machine past its cores right now (tests inject it)? */
  machineBusy?: () => boolean;
}

export const WAIT_NOTE_MS = 60_000;

export const heavyQueueDir = (lockPath: string): string => `${lockPath}.queue`;
export const fastQueueDir = (slotDir: string): string => join(slotDir, 'fast-queue');
/**
 * The machine's heavy-slot line. Each checkout has its own lock, so the waiters for a slot are
 * many checkouts (worktrees of one repo included): without a line the slot went to whoever polled
 * first, and smaller-first, the kept place and the age rule were lost across worktrees. A check
 * enters it only once it holds its checkout's lock, so a busy worktree never blocks the line.
 */
export const heavySlotQueueDir = (slotDir: string): string => join(slotDir, 'heavy-queue');

export interface HeavyAcquired {
  held: HeavyHold | null;
  /** The line it really went through: a fast job falls back to heavy while the Mac is very hot. */
  line?: QueueLine;
  /** Seconds it waited for (held) or gave up after (null). */
  waitS: number;
  /** Why nothing ran, when `held` is null. */
  busy: string | null;
  /** Where the wait went, for the ledger (`waitWhy`). */
  waits?: WaitParts;
}

export async function acquireHeavyReporting(o: HeavyAcquireOpts): Promise<HeavyAcquired> {
  const read = o.heavyLimit ?? currentHeavyLimit;
  const safeRead = async () => { try { return clampHeavyLimit(await read()); } catch { return machineHeavySlots(); } };
  const first = await safeRead();
  const waitS = o.maxWaitS ?? (first === 1 ? HEAVY_HOT_WAIT_S : HEAVY_DEFAULT_WAIT_S);
  const started = Date.now();
  let fastMs = 0;
  if (o.job?.line === 'fast' && first > 1) {
    const r = await tryFast(o, o.job, first, waitS);
    fastMs = Date.now() - started;
    if (!r.hot) return { held: r.held, line: 'fast', waitS, busy: r.busy, waits: { lockMs: 0, slotFullMs: 0, slotLineMs: 0, limit: first, fastMs } };
  }
  const queued = Date.now();
  const shared = o.job?.shared === true;
  const place = o.job && !shared ? QueuePlace.enter(heavyQueueDir(o.lockPath), o.job, Date.now()) : null;
  const tell = waitNotes(o, place, o.lockPath, 'heavy');
  let entry: number | null = first;
  let lastLimit = first;
  let repoLocked = false;
  let slotPlace: QueuePlace | null = null;
  let slotNotes: (now: number) => void = () => {};
  const waits: WaitParts = { lockMs: 0, slotFullMs: 0, slotLineMs: 0, limit: first, fastMs };
  let tick = queued;
  const held = await acquireHeavy(o.cwd, {
    waitMs: Math.max(0, waitS * 1000 - (Date.now() - started)),
    slotDir: o.slotDir,
    repoLock: o.lockPath,
    // The entry reading is the one just taken; later rechecks read afresh.
    limit: async () => { if (entry !== null) { const n = entry; entry = null; return n; } return safeRead(); },
    noRepoLock: shared,
    onLimit: (n) => { lastLimit = n; waits.limit = n; },
    onRepoLock: () => {
      repoLocked = true;
      tick = Date.now();
      waits.lockMs = tick - queued;
      if (o.job) {
        slotPlace = QueuePlace.enter(heavySlotQueueDir(o.slotDir), o.job, Date.now());
        slotNotes = waitNotes(o, slotPlace, null, 'heavy slot');
      }
    },
    turn: place ? (now) => { const mine = place.myTurn(now); if (!mine) tell(now); return mine; } : undefined,
    onSlot: () => { slotPlace?.leave(); },
    slotTurn: o.job ? (now, free) => {
      if (free > 0) waits.slotLineMs += now - tick; else waits.slotFullMs += now - tick;
      tick = now;
      if (!slotPlace) return true;
      const mine = slotPlace.myTurn(now, free);
      if (!mine) slotNotes(now);
      return mine;
    } : undefined,
  });
  if (held) {
    place?.leave();
    return { held, line: 'heavy', waitS, busy: null, waits };
  }
  // The wait ran out before the lock came: all of it was the lock's.
  if (!repoLocked) waits.lockMs = Date.now() - queued;
  place?.park(Date.now());
  (slotPlace as QueuePlace | null)?.park(Date.now());
  const why = busyMessage(o, { waitS, lastLimit, repoLocked });
  const kept = place ?? (slotPlace as QueuePlace | null);
  return { held: null, line: 'heavy', waitS, busy: kept ? `${why}${keptPlace(kept)}` : `${why} Run the same command again.`, waits };
}

/** `hot`: the Mac turned very hot while waiting, the job goes to the one heavy line. */
async function tryFast(o: HeavyAcquireOpts, job: NonNullable<HeavyAcquireOpts['job']>, first: number, waitS: number): Promise<{ held: HeavyHold | null; hot: boolean; busy: string | null }> {
  const place = QueuePlace.enter(fastQueueDir(o.slotDir), job, Date.now());
  const tell = waitNotes(o, place, null, 'fast');
  const busyNow = o.machineBusy ?? (() => machineLoad().busy);
  const read = o.heavyLimit ?? currentHeavyLimit;
  let heat = first;
  let hot = false;
  let readAt = Date.now();
  const limit = (): number => {
    if (Date.now() - readAt >= HEAT_RECHECK_MS) {
      readAt = Date.now();
      void Promise.resolve().then(read).then((n) => { heat = clampHeavyLimit(n); }, () => {});
    }
    const n = fastSlotLimit(heat, busyNow());
    hot = n === 0;
    return n;
  };
  const held = await acquireFastSlot({
    waitMs: waitS * 1000, paths: fastSlotPaths(o.slotDir), limit,
    turn: (now) => { const mine = place.myTurn(now); if (!mine) tell(now); return mine; },
  });
  if (held || hot) { place.leave(); return { held, hot, busy: null }; }
  place.park(Date.now());
  return { held: null, hot: false, busy: `all fast slots of this machine stayed busy for ${waitS}s, held by ${fastHolders(o.slotDir, o.ps)}; NOTHING ran.${keptPlace(place)}` };
}

/** Who holds the machine's heavy slots: every repo and worktree together. */
function heavyHolders(slotDir: string, ps: () => string): string {
  return heavySlotPaths(slotDir).filter(heavySlotsHeldAt).map((p) => holderOf(p, ps)).join(', ') || 'nobody now';
}

function fastHolders(slotDir: string, ps: () => string): string {
  return fastSlotPaths(slotDir).filter((p) => existsSync(p)).map((p) => holderOf(p, ps)).join(', ') || 'nobody now';
}

/** Where the waiter stands, in words it can act on: who is ahead, and who holds the lock. */
function standing(place: QueuePlace, lockPath: string | null, o: HeavyAcquireOpts): string {
  const now = Date.now();
  const { position, ahead } = place.spot(now);
  const rows = ahead.slice(0, 3).map((t, i) => ticketRow(t, i, now)).join('; ');
  const holder = lockPath ? `; lock held by ${holderOf(lockPath, o.ps)}` : '';
  return `place ${position} in line${rows ? `, ahead: ${rows}` : ''}${holder}`;
}

function waitNotes(o: HeavyAcquireOpts, place: QueuePlace | null, lockPath: string | null, line: QueueLine | 'heavy slot'): (now: number) => void {
  let next = 0;
  return (now) => {
    if (!place || !o.note || now < next) return;
    next = now + WAIT_NOTE_MS;
    o.note(`waiting in the ${line} line: ${standing(place, lockPath, o)}`);
  };
}

function keptPlace(place: QueuePlace): string {
  const { position, ahead } = place.spot(Date.now());
  const rows = ahead.slice(0, 3).map((t) => t.label).join('; ');
  return ` Your place is KEPT for ${Math.round(QUEUE_KEEP_MS / 60_000)} min (place ${position}${rows ? `, ahead: ${rows}` : ''}): the same command from this checkout takes it back, so do other work first and read "builder queue" before you come back.`;
}

/** What `builder queue` prints: each line's waiters in the order they will run. */
export function queueReport(lockPath: string, slotDir: string, ps: () => string, nowMs: number = Date.now()): string[] {
  const out = [
    `heavy lock (this checkout): ${existsSync(lockPath) ? holderOf(lockPath, ps) : 'free'}`,
    `heavy slots: ${heavyHolders(slotDir, ps)}`,
    `fast slots: ${fastHolders(slotDir, ps)}`,
  ];
  for (const [line, dir] of [['heavy', heavyQueueDir(lockPath)], ['heavy slot', heavySlotQueueDir(slotDir)], ['fast', fastQueueDir(slotDir)]] as const) {
    const all = ordered(readTickets(dir, nowMs), nowMs);
    out.push(`${line} line: ${all.length === 0 ? 'empty' : `${all.length} waiting or parked`}`);
    all.forEach((t, i) => out.push(`  ${ticketRow(t, i, nowMs)}`));
  }
  return out;
}

function busyMessage(o: HeavyAcquireOpts, r: { waitS: number; lastLimit: number; repoLocked: boolean }): string {
  if (!r.repoLocked) {
    return `the heavy lock is held by ${holderOf(o.lockPath, o.ps)} and stayed busy for ${r.waitS}s; NOTHING ran.`;
  }
  if (r.lastLimit === 1 && heavySlotsHeld(o.slotDir) >= 1) {
    const slot = heavySlotPaths(o.slotDir).find((p) => heavySlotsHeldAt(p));
    return `macOS reports critical heat or memory pressure, so this machine runs one heavy step at a time; slot held by ${slot ? holderOf(slot, o.ps) : 'another check'} for ${r.waitS}s; NOTHING ran.`;
  }
  const holders = heavySlotPaths(o.slotDir).filter((p) => existsSync(p)).map((p) => holderOf(p, o.ps)).join(', ');
  return `all ${r.lastLimit} heavy slots of this machine stayed busy for ${r.waitS}s (other checkouts' checks${holders ? `: ${holders}` : ''}); NOTHING ran.`;
}

/** Does a live process hold this one slot file? */
function heavySlotsHeldAt(path: string): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(path, 'utf-8')) as { pid?: unknown };
    if (typeof pid !== 'number') return true;
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
  } catch {
    return false;
  }
}

export function holderOf(lockPath: string, ps: () => string): string {
  try {
    const { pid } = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: number };
    if (typeof pid !== 'number') return 'another check';
    const row = ps().split('\n').find((l) => new RegExp(`^\\s*${pid}\\s`).test(l));
    const command = row?.replace(/^\s*\d+\s+\d+\s+\S+\s+/, '').trim();
    return `pid ${pid}${command ? ` (${command.slice(0, 120)})` : ''}`;
  } catch {
    return 'another check';
  }
}
