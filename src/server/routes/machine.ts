import type { IncomingMessage, ServerResponse } from 'node:http';
import { totalmem } from 'node:os';
import { sendJson } from '../middleware.js';
import { readBattery, defaultPowerRunner, type BatteryReading } from '../../lib/handsfree/mac/power.js';
import { readCapacityFacts } from '../../lib/super/capacity.js';

/**
 * GET /api/app/machine — what Light mode's Auto needs about THIS Mac: how much memory it has,
 * whether it runs on battery and how full that is, and whether macOS Low Power Mode is on
 * (task: the desktop app stays light on an 8GB MacBook Air; battery/LPM rule: owner,
 * 2026-10-18). The dashboard decides; this only reports. Vault-agnostic: it reads the machine.
 *
 * `onBattery` is `null` wherever the answer is unknown (not macOS, `pmset` failed), so Auto
 * falls back to the memory rule alone. The battery read spawns `pmset`, so it is memoized for
 * a minute (the dashboard asks at most once a minute per window).
 */
export interface MachineFacts {
  totalMemGb: number;
  onBattery: boolean | null;
  /** Battery charge 0-100, null where unknown (no battery, not macOS, pmset failed). */
  batteryPercent: number | null;
  /** macOS Low Power Mode for the power source in use right now; null where unknown. */
  lowPowerMode: boolean | null;
}

interface PowerFacts { onBattery: boolean | null; batteryPercent: number | null; lowPowerMode: boolean | null }
const UNKNOWN_POWER: PowerFacts = { onBattery: null, batteryPercent: null, lowPowerMode: null };

/** `pmset -g` (the settings in use now) → whether Low Power Mode is on. */
export function parseLowPowerMode(text: string): boolean | null {
  const m = /^\s*lowpowermode\s+([01])\b/m.exec(text);
  return m ? m[1] === '1' : null;
}

async function readLowPowerMode(): Promise<boolean | null> {
  const r = await defaultPowerRunner('/usr/bin/pmset', ['-g']);
  return r.code === 0 ? parseLowPowerMode(r.stdout) : null;
}

const BATTERY_TTL_MS = 60_000;

export interface MachineDeps {
  platform: NodeJS.Platform;
  totalMem: () => number;
  battery: () => Promise<BatteryReading>;
  lowPowerMode: () => Promise<boolean | null>;
  now: () => number;
}

const defaultDeps = (): MachineDeps => ({
  platform: process.platform,
  totalMem: totalmem,
  battery: () => readBattery(),
  lowPowerMode: readLowPowerMode,
  now: () => Date.now(),
});

let memo: { at: number; value: PowerFacts; pending: Promise<PowerFacts> | null } | null = null;

async function powerFacts(deps: MachineDeps): Promise<PowerFacts> {
  if (deps.platform !== 'darwin') return UNKNOWN_POWER;
  const t = deps.now();
  if (memo && memo.pending) return memo.pending;
  if (memo && t - memo.at < BATTERY_TTL_MS) return memo.value;
  const pending = Promise.all([
    deps.battery().then((r) => ({ onBattery: !r.charging, batteryPercent: r.percent }), () => ({ onBattery: null, batteryPercent: null })),
    deps.lowPowerMode().catch(() => null),
  ]).then(([b, lowPowerMode]) => ({ ...b, lowPowerMode }));
  memo = { at: t, value: memo?.value ?? UNKNOWN_POWER, pending };
  const value = await pending;
  memo = { at: deps.now(), value, pending: null };
  return value;
}

/** The facts, with injectable readers (unit-tested). */
export async function readMachineFacts(deps: MachineDeps = defaultDeps()): Promise<MachineFacts> {
  const gb = Math.round((deps.totalMem() / 1024 ** 3) * 10) / 10;
  return { totalMemGb: gb, ...(await powerFacts(deps)) };
}

/** Tests only: forget the memoized battery read. */
export function resetMachineFactsForTests(): void {
  memo = null;
}

/**
 * The route adds the Super Agent's capacity facts (plan-r7 D11: `availMemGb` from `vm_stat` on
 * macOS, `diskFreeGb` where worktrees go, `load1`), each memoized for a minute.
 */
export async function handleAppMachine(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const [facts, capacity] = await Promise.all([readMachineFacts(), readCapacityFacts()]);
  sendJson(res, 200, { ...facts, ...capacity });
}
