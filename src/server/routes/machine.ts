import type { IncomingMessage, ServerResponse } from 'node:http';
import { totalmem } from 'node:os';
import { sendJson } from '../middleware.js';
import { readBattery, type BatteryReading } from '../../lib/handsfree/mac/power.js';
import { readCapacityFacts } from '../../lib/super/capacity.js';

/**
 * GET /api/app/machine — the two facts Light mode's Auto needs about THIS Mac: how much
 * memory it has, and whether it is running on battery right now (task: the desktop app stays
 * light on an 8GB MacBook Air). The dashboard decides; this only reports. Vault-agnostic:
 * it reads the machine, no project.
 *
 * `onBattery` is `null` wherever the answer is unknown (not macOS, `pmset` failed), so Auto
 * falls back to the memory rule alone. The battery read spawns `pmset`, so it is memoized for
 * a minute (the dashboard asks at most once a minute per window).
 */
export interface MachineFacts {
  totalMemGb: number;
  onBattery: boolean | null;
}

const BATTERY_TTL_MS = 60_000;

export interface MachineDeps {
  platform: NodeJS.Platform;
  totalMem: () => number;
  battery: () => Promise<BatteryReading>;
  now: () => number;
}

const defaultDeps = (): MachineDeps => ({
  platform: process.platform,
  totalMem: totalmem,
  battery: () => readBattery(),
  now: () => Date.now(),
});

let memo: { at: number; value: boolean | null; pending: Promise<boolean | null> | null } | null = null;

async function onBattery(deps: MachineDeps): Promise<boolean | null> {
  if (deps.platform !== 'darwin') return null;
  const t = deps.now();
  if (memo && memo.pending) return memo.pending;
  if (memo && t - memo.at < BATTERY_TTL_MS) return memo.value;
  const pending = deps.battery().then(
    (r) => !r.charging,
    () => null,
  );
  memo = { at: t, value: memo?.value ?? null, pending };
  const value = await pending;
  memo = { at: deps.now(), value, pending: null };
  return value;
}

/** The facts, with injectable readers (unit-tested). */
export async function readMachineFacts(deps: MachineDeps = defaultDeps()): Promise<MachineFacts> {
  const gb = Math.round((deps.totalMem() / 1024 ** 3) * 10) / 10;
  return { totalMemGb: gb, onBattery: await onBattery(deps) };
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
