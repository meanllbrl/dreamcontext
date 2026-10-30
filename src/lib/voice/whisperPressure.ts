/**
 * Is the machine under load right now — read from the measurement the Super Agent already
 * takes, never a second probe (owner, 2026-10-27: "when the Mac is under load, take Whisper out
 * of RAM at once, and do not bring it back until dictation is used again AND the load is gone").
 *
 *   • MEMORY — `super/capacity.ts`: available memory from `vm_stat` and swap use from `sysctl`,
 *     memoized for a minute and shared with the Super Agent and the idle-chat park sweep. The
 *     lines are the Super's own (`machineRoom`): under 2 GB available, or swap at 75 %+ of its
 *     size. Disk and the session count are not memory and are ignored here.
 *   • NOT SWAP ON macOS (2026-10-30): macOS adds swap files as they fill, so "used / size" sits
 *     at 90 %+ whenever anything is swapped at all — measured on the owner's 16 GB Mac with
 *     2.5 GB available: 7.3 of 8 GB, a minute after 5.9 of 6 GB. As a line it refused 4 of 5
 *     Shift+V takes that day. Available memory is the reading that moves under real load there;
 *     on Linux the swap size is fixed, so its share still counts.
 *   • HEAT — the hands-free Mac mode's thermal governor already reads `NSProcessInfo.thermalState`
 *     while it runs; the server hands that last reading in ({@link setThermalSource}). `serious`
 *     or `critical` counts. When the governor is not running there is no reading, and no new one
 *     is taken for this.
 *
 * A reading that cannot be taken counts as NO pressure (fail open toward the observable state):
 * a broken `vm_stat` must not switch dictation off.
 */

import { machineRoom, readCapacityFacts, type CapacityFacts } from '../super/capacity.js';

export interface PressureReading {
  pressed: boolean;
  /** The owner-facing reason when pressed: "memory", "swap", "heat". */
  why: 'memory' | 'swap' | 'heat' | null;
}

/** `loadedMB`: the memory our own loaded model holds, credited back before the lines are drawn. */
export type PressureReader = (opts?: { loadedMB?: number }) => Promise<PressureReading>;

type ThermalSource = () => string | null;
let thermalSource: ThermalSource = () => null;

/** The server wires the hands-free thermal governor's last reading here. */
export function setThermalSource(src: ThermalSource | null): void {
  thermalSource = src ?? (() => null);
}

/** The memory half, pure: the Super's lines over one reading of the facts. */
export function memoryPressure(
  facts: CapacityFacts,
  opts: { loadedMB?: number; platform?: NodeJS.Platform } = {},
): PressureReading {
  // Our own model's memory is not pressure we must react to by unloading it.
  const own = Math.max(0, opts.loadedMB ?? 0) / 1024;
  const room = machineRoom({ ...facts, availMemGb: facts.availMemGb + own }, { platform: opts.platform });
  if (room.reasons.some((r) => r.limit === 'availMem')) return { pressed: true, why: 'memory' };
  const swapCounts = (opts.platform ?? process.platform) !== 'darwin';
  if (swapCounts && room.reasons.some((r) => r.limit === 'swap')) return { pressed: true, why: 'swap' };
  return { pressed: false, why: null };
}

export const readMachinePressure: PressureReader = async (opts = {}) => {
  try {
    const t = thermalSource();
    if (t === 'serious' || t === 'critical') return { pressed: true, why: 'heat' };
  } catch { /* no reading */ }
  try {
    return memoryPressure(await readCapacityFacts(), opts);
  } catch { /* unreadable: fail open */ }
  return { pressed: false, why: null };
};
