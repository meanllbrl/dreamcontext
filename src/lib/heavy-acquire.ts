import { readFileSync } from 'node:fs';
import {
  HEAVY_DEFAULT_WAIT_S,
  HEAVY_MACHINE_SLOTS,
  acquireHeavy,
  clampHeavyLimit,
  heavySlotPaths,
  heavySlotsHeld,
  type HeavyHold,
} from './builder-tools.js';
import { currentHeavyLimit } from './heat.js';

/**
 * The heavy lock as `builder heavy` and `builder test` take it, with the one message both print
 * when nothing ran: the heat (one step machine-wide while macOS says very hot, `./heat.ts`), the
 * machine's slots, or this repo's lock, whichever the wait actually ran out on.
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
}

export interface HeavyAcquired {
  held: HeavyHold | null;
  /** Seconds it waited for (held) or gave up after (null). */
  waitS: number;
  /** Why nothing ran, when `held` is null. */
  busy: string | null;
}

export async function acquireHeavyReporting(o: HeavyAcquireOpts): Promise<HeavyAcquired> {
  const read = o.heavyLimit ?? currentHeavyLimit;
  const safeRead = async () => { try { return clampHeavyLimit(await read()); } catch { return HEAVY_MACHINE_SLOTS; } };
  const first = await safeRead();
  const waitS = o.maxWaitS ?? (first === 1 ? HEAVY_HOT_WAIT_S : HEAVY_DEFAULT_WAIT_S);
  let entry: number | null = first;
  let lastLimit = first;
  let repoLocked = false;
  const held = await acquireHeavy(o.cwd, {
    waitMs: waitS * 1000,
    slotDir: o.slotDir,
    repoLock: o.lockPath,
    // The entry reading is the one just taken; later rechecks read afresh.
    limit: async () => { if (entry !== null) { const n = entry; entry = null; return n; } return safeRead(); },
    onLimit: (n) => { lastLimit = n; },
    onRepoLock: () => { repoLocked = true; },
  });
  if (held) return { held, waitS, busy: null };
  return { held: null, waitS, busy: busyMessage(o, { waitS, lastLimit, repoLocked }) };
}

function busyMessage(o: HeavyAcquireOpts, r: { waitS: number; lastLimit: number; repoLocked: boolean }): string {
  if (!r.repoLocked) {
    return `the heavy lock is held by ${holderOf(o.lockPath, o.ps)} and stayed busy for ${r.waitS}s; NOTHING ran. Run the same command again.`;
  }
  if (r.lastLimit === 1 && heavySlotsHeld(o.slotDir) >= 1) {
    const slot = heavySlotPaths(o.slotDir).find((p) => heavySlotsHeldAt(p));
    return `the Mac is very hot (macOS thermal state serious or critical), so this machine runs one heavy step at a time; slot held by ${slot ? holderOf(slot, o.ps) : 'another check'} for ${r.waitS}s; NOTHING ran. Run the same command again.`;
  }
  return `all ${r.lastLimit} heavy slots of this machine stayed busy for ${r.waitS}s (other repos' checks); NOTHING ran. Run the same command again.`;
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
