import { homedir } from 'node:os';
import { HEAVY_MACHINE_SLOTS, clampHeavyLimit } from './builder-tools.js';
import { HEAT_HOT, type MacThermalState } from './handsfree/mac/contract.js';
import { readMacState } from './handsfree/mac/session.js';
import { readThermalState } from './handsfree/mac/thermal.js';

/**
 * Heat and the machine's heavy steps (owner, 2026-10-24). While macOS itself says the Mac is
 * very hot (`thermalState` serious or critical) every repo together runs ONE heavy step
 * (`builder heavy` / `builder test`); otherwise {@link HEAVY_MACHINE_SLOTS}. Every mode,
 * hands-free on or off: Bag mode alone does not lower it. Children are never limited by heat,
 * only heavy steps, and a running step is never stopped.
 */

export { HEAT_HOT };

export function isHot(level: MacThermalState | null | undefined): boolean {
  return level != null && (HEAT_HOT as readonly string[]).includes(level);
}

/** How many heavy steps the machine runs at once at this reading. */
export function heavyLimitFor(level: MacThermalState | null): number {
  return isHot(level) ? 1 : HEAVY_MACHINE_SLOTS;
}

/** A limit as the lock may use it: an integer in [1, HEAVY_MACHINE_SLOTS]; junk reads as the default. */
export const clampLimit = clampHeavyLimit;

/**
 * macOS's thermal state, or null off macOS (no spawn) and under vitest unless a reader is
 * injected (a test never runs osascript). Never throws.
 */
export async function readHeatLevel(deps: { platform?: NodeJS.Platform; read?: () => Promise<MacThermalState | null> } = {}): Promise<MacThermalState | null> {
  if ((deps.platform ?? process.platform) !== 'darwin') return null;
  if (!deps.read && process.env.VITEST) return null;
  try { return await (deps.read ?? (() => readThermalState()))(); } catch { return null; }
}

/** The heavy-step limit at the current reading (what `builder heavy` / `builder test` use). */
export async function currentHeavyLimit(): Promise<number> {
  return heavyLimitFor(await readHeatLevel());
}

/**
 * Is hands-free Mac mode on in Bag mode right now? Read from its state file, alive server pid
 * only. Information only: a reused pid can read true. Never throws.
 */
export function readBagMode(home: string = homedir(), isAlive: (pid: number) => boolean = pidAlive): boolean {
  try {
    const s = readMacState(home);
    if (!s || s.bagMode !== true) return false;
    return Number.isInteger(s.serverPid) && s.serverPid > 1 && isAlive(s.serverPid);
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM'; }
}
