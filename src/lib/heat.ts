import { execFile } from 'node:child_process';
import { freemem, homedir } from 'node:os';
import { HEAVY_SLOT_FLOOR, clampHeavyLimit, heavySlotDir, heavySlotsHeld, machineHeavySlots } from './builder-tools.js';
import { HEAT_HOT, type MacThermalState } from './handsfree/mac/contract.js';
import { readMacState } from './handsfree/mac/session.js';
import { readThermalState } from './handsfree/mac/thermal.js';

/**
 * The machine's real signals and its heavy steps (owner, 2026-10-24, 2026-11-01: speed wins).
 * Every repo together runs {@link machineHeavySlots} heavy steps (`builder heavy` / `builder
 * test`) unless macOS itself says otherwise: 2 at `thermalState` serious, 1 at critical (truly
 * throttling) or at critical memory pressure. High swap or a busy load average lowers nothing.
 * Every mode, hands-free on or off: Bag mode alone does not lower it. Children are never limited
 * by this, only heavy steps, and a running step is never stopped.
 */

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
const MEMORY_PRESSURE_CRITICAL = 4;

export { HEAT_HOT };

export function isHot(level: MacThermalState | null | undefined): boolean {
  return level != null && (HEAT_HOT as readonly string[]).includes(level);
}

/**
 * Available memory from a `vm_stat` sample: free + inactive + purgeable + speculative pages
 * times the page size the header names. Null when the sample is not one.
 */
export function parseVmStat(text: string): number | null {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) return null;
  const pages = (label: string): number => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  const total = pages('free') + pages('inactive') + pages('purgeable') + pages('speculative');
  return total * Number(size[1]);
}

/** How many heavy steps the machine runs at once at this reading. */
export function heavyLimitFor(level: MacThermalState | null, memoryCritical = false, slots: number = machineHeavySlots()): number {
  if (level === 'critical' || memoryCritical) return 1;
  return isHot(level) ? HEAVY_SLOT_FLOOR : slots;
}

/** Free memory the way `capacity.ts` counts it, in GB; null when it cannot be read. */
async function readAvailGb(): Promise<number | null> {
  if (process.env.VITEST) return null;
  if (process.platform !== 'darwin') return freemem() / 1024 ** 3;
  const sample = await new Promise<string | null>((done) => {
    execFile('/usr/bin/vm_stat', { timeout: 2000 }, (err, out) => { done(err ? null : String(out)); });
  });
  const bytes = sample === null ? null : parseVmStat(sample);
  return bytes === null ? null : bytes / 1024 ** 3;
}

/**
 * Is macOS's memory pressure critical right now? Asks the kernel, not swap or free memory: swap
 * sat 89 % full on 2026-11-01 with the kernel saying only "warn". False off macOS, under vitest
 * unless a reader is injected, and on any doubt: a failed probe never slows a check.
 */
export async function readMemoryCritical(deps: { platform?: NodeJS.Platform; read?: () => Promise<string> } = {}): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'darwin') return false;
  if (!deps.read && process.env.VITEST) return false;
  const read = deps.read ?? (() => new Promise<string>((done, fail) => {
    execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000 }, (err, out) => { if (err) fail(err); else done(String(out)); });
  }));
  try { return Number((await read()).trim()) === MEMORY_PRESSURE_CRITICAL; } catch { return false; }
}

/** A limit as the lock may use it: an integer in [1, HEAVY_SLOT_CAP]; junk reads as the machine's own. */
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
  const [level, memoryCritical, availGb] = await Promise.all([readHeatLevel(), readMemoryCritical(), readAvailGb()]);
  return heavyLimitFor(level, memoryCritical, machineHeavySlots({ availGb, held: heavySlotsHeld(heavySlotDir()) }));
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
