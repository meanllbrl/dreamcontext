import { execFile } from 'node:child_process';
import { promises as fsp, readFileSync } from 'node:fs';
import { freemem, homedir, loadavg, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { activityOf, getChat } from '../assistant/chat-registry.js';
import { heavySlotDir, heavySlotsHeld } from '../builder-tools.js';
import { MAX_LIVE_CHILDREN, type SuperState } from './types.js';
import { superWorktreeRoot } from './store.js';

/**
 * How much room this machine has for another child chat (plan-r7 D11, decision 5).
 *
 * The ONLY limit on a NEW `super delegate` is {@link MAX_LIVE_CHILDREN} live children; adoption
 * at hand-over is never refused (those chats already exist). The facts below are information
 * (`super state`'s `machine`) and the park sweep's signal, never a delegate hold (owner,
 * 2026-10-21: a full swap or little free memory alone does not show the machine cannot take one
 * more; the system swaps on its own): free memory (`vm_stat` on macOS, where `os.freemem()`
 * reports only the truly free pages and reads an 8 GB Mac as nearly full), free disk where
 * worktrees go, and the 1-minute load. Every read is async (no `execFileSync` on a request path)
 * and memoized for a minute.
 */

export interface CapacityFacts {
  availMemGb: number;
  diskFreeGb: number | null;
  load1: number;
  /** Physical memory. */
  totalMemGb?: number;
  /** Swap in use and its current size (`sysctl vm.swapusage` on macOS, `/proc/meminfo` on
   *  Linux), null when unreadable. macOS grows the swap file on demand, so the share is of
   *  the size right now. */
  swapUsedGb?: number | null;
  swapTotalGb?: number | null;
  /** Running processes whose command BASENAME is `claude`, counted from `ps` (see
   *  {@link CLAUDE_SESSIONS_MEANS}): app chats, terminal tabs and sessions of other projects, and
   *  the Super itself, never the Claude.app helpers. NOT a count of this vault's children: a
   *  child that is `starting`, parked or ended has no process and is not in it. Null when `ps`
   *  failed. */
  claudeSessions?: number | null;
  /** Machine heavy slots (`builder heavy` / `builder test`, every repo) held right now. */
  heavySteps?: number | null;
}

export interface CapacityDeps {
  platform: NodeJS.Platform;
  vmStat: () => Promise<string>;
  freeMem: () => number;
  statfs: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  loadavg: () => number[];
  worktreeRoot: string;
  now: () => number;
  /** The readers below are optional so a caller that injects only the old ones (tests) gets
   *  null facts for them, never a real `sysctl` or `ps`. */
  totalMem?: () => number;
  swapUsage?: () => Promise<string>;
  procMeminfo?: () => Promise<string>;
  psComm?: () => Promise<string>;
  heavySlots?: () => number;
}

const run = promisify(execFile);

const defaultDeps = (): CapacityDeps => ({
  platform: process.platform,
  vmStat: async () => (await run('vm_stat', [], { timeout: 5_000 })).stdout,
  freeMem: freemem,
  statfs: (p) => fsp.statfs(p),
  loadavg,
  worktreeRoot: superWorktreeRoot(homedir()),
  now: () => Date.now(),
  totalMem: totalmem,
  swapUsage: async () => (await run('sysctl', ['vm.swapusage'], { timeout: 5_000 })).stdout,
  procMeminfo: () => fsp.readFile('/proc/meminfo', 'utf-8'),
  psComm: async () => (await run('ps', ['-axo', 'comm='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  heavySlots: () => heavySlotsHeld(heavySlotDir()),
});

export const CAPACITY_TTL_MS = 60_000;
const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;

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

/** `sysctl vm.swapusage` → used and total GB: `total = 20480.00M  used = 19316.50M  free = …`. */
export function parseSwapUsage(text: string): { usedGb: number; totalGb: number } | null {
  const num = (label: string): number | null => {
    const m = new RegExp(`${label}\\s*=\\s*([\\d.]+)([KMGT])`).exec(text);
    if (!m) return null;
    const scale = { K: 1 / (1024 * 1024), M: 1 / 1024, G: 1, T: 1024 }[m[2] as 'K' | 'M' | 'G' | 'T'];
    return Number(m[1]) * scale;
  };
  const totalGb = num('total');
  const usedGb = num('used');
  return totalGb === null || usedGb === null ? null : { usedGb, totalGb };
}

/** `/proc/meminfo` → swap used and total GB (SwapTotal − SwapFree, in kB). */
export function parseProcMeminfoSwap(text: string): { usedGb: number; totalGb: number } | null {
  const kb = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const total = kb('SwapTotal');
  const free = kb('SwapFree');
  if (total === null || free === null) return null;
  return { usedGb: (total - free) / (1024 * 1024), totalGb: total / (1024 * 1024) };
}

/** How many processes in a `ps -axo comm=` listing are `claude` by command basename. */
export function countClaudeSessions(psComm: string): number {
  let n = 0;
  for (const line of psComm.split('\n')) {
    const comm = line.trim();
    if (!comm) continue;
    if (comm.slice(comm.lastIndexOf('/') + 1) === 'claude') n += 1;
  }
  return n;
}

/** What {@link CapacityFacts.claudeSessions} counts, in the words `super state` shows beside it. */
export const CLAUDE_SESSIONS_MEANS =
  'running processes named claude on this machine, from ps: every project, terminal tab, app chat and the Super itself; a child that is starting, parked or ended has none, so this is not the number of children';

/**
 * The count read now, past the 60 s memo of {@link readCapacityFacts}: right after an app restart
 * the memo still holds the zero read before the first chats spawned (field 2026-10-21: 0 shown
 * with 2 `claude` processes alive 30 s). `ps` is one cheap call. Null when it failed or is not wired.
 */
export async function readClaudeSessionsNow(injected?: Pick<CapacityDeps, 'psComm'>): Promise<number | null> {
  const psComm = (injected ?? defaultDeps()).psComm;
  try { return psComm ? countClaudeSessions(await psComm()) : null; } catch { return null; }
}

/** The facts for `super state`: the memoized ones with the process count read fresh. */
export async function readCapacityFactsForState(injected?: CapacityDeps): Promise<CapacityFacts> {
  const facts = await readCapacityFacts(injected);
  if (factsOverride && !injected) return facts;
  const fresh = await readClaudeSessionsNow(injected);
  return fresh === null ? facts : { ...facts, claudeSessions: fresh };
}

/** The nearest existing directory at or above `path` (statfs needs one that exists). */
async function existingDir(path: string): Promise<string> {
  let p = path;
  for (;;) {
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) return p;
    } catch { /* climb */ }
    const up = dirname(p);
    if (up === p) return p;
    p = up;
  }
}

let memo: { at: number; value: Promise<CapacityFacts> } | null = null;

async function measure(deps: CapacityDeps): Promise<CapacityFacts> {
  let availBytes: number | null = null;
  if (deps.platform === 'darwin') {
    try { availBytes = parseVmStat(await deps.vmStat()); } catch { availBytes = null; }
  }
  if (availBytes === null) availBytes = deps.freeMem();
  let diskFreeGb: number | null = null;
  try {
    const st = await deps.statfs(await existingDir(deps.worktreeRoot));
    diskFreeGb = round1((Number(st.bavail) * Number(st.bsize)) / GB);
  } catch { diskFreeGb = null; }
  const load1 = round1(deps.loadavg()[0] ?? 0);
  const totalMemGb = deps.totalMem ? round1(deps.totalMem() / GB) : undefined;
  let swap: { usedGb: number; totalGb: number } | null = null;
  try {
    if (deps.platform === 'darwin' && deps.swapUsage) swap = parseSwapUsage(await deps.swapUsage());
    else if (deps.platform === 'linux' && deps.procMeminfo) swap = parseProcMeminfoSwap(await deps.procMeminfo());
  } catch { swap = null; }
  let claudeSessions: number | null = null;
  try { claudeSessions = deps.psComm ? countClaudeSessions(await deps.psComm()) : null; } catch { claudeSessions = null; }
  let heavySteps: number | null = null;
  try { heavySteps = deps.heavySlots ? deps.heavySlots() : null; } catch { heavySteps = null; }
  return {
    availMemGb: round1(availBytes / GB),
    diskFreeGb,
    load1,
    ...(totalMemGb !== undefined ? { totalMemGb } : {}),
    swapUsedGb: swap ? round1(swap.usedGb) : null,
    swapTotalGb: swap ? round1(swap.totalGb) : null,
    claudeSessions,
    heavySteps,
  };
}

/** Tests only: what the no-argument readers answer instead of this machine (null = measure). */
let factsOverride: CapacityFacts | null = null;
let factsOverrideDelayMs = 0;
/** `delayMs` stands in for a cold measurement (`ps`, `sysctl`, `statfs` take real time). */
export function setCapacityFactsForTests(facts: CapacityFacts | null, opts: { delayMs?: number } = {}): void {
  factsOverride = facts;
  factsOverrideDelayMs = opts.delayMs ?? 0;
}
function overridden(): Promise<CapacityFacts> {
  const facts = { ...(factsOverride as CapacityFacts) };
  return factsOverrideDelayMs > 0 ? new Promise((r) => { setTimeout(() => r(facts), factsOverrideDelayMs); }) : Promise.resolve(facts);
}

/** The facts, memoized for {@link CAPACITY_TTL_MS}. Injectable readers for tests. */
export function readCapacityFacts(injected?: CapacityDeps): Promise<CapacityFacts> {
  if (!injected && factsOverride) return overridden();
  const deps = injected ?? defaultDeps();
  const t = deps.now();
  if (memo && t - memo.at < CAPACITY_TTL_MS) return memo.value;
  const value = measure(deps);
  memo = { at: t, value };
  return value;
}

/** The facts read fresh, past the memo (the park sweep reads once a minute anyway and must see
 *  what its last parking freed). Refreshes the memo for the other readers. */
export function readCapacityFactsFresh(injected?: CapacityDeps): Promise<CapacityFacts> {
  if (!injected && factsOverride) return overridden();
  const deps = injected ?? defaultDeps();
  const value = measure(deps);
  memo = { at: deps.now(), value };
  return value;
}

// ── Machine room (orchestration plan r5 D11; the parking task P-D1) ────────────────────
/** Soft lines: the park sweep parks chats idle >= 10 min. */
export const SOFT_SWAP_SHARE = 0.75;
export const SOFT_DISK_GB = 15;
export const SOFT_AVAIL_MEM_GB = 2;
/** One live Claude session per this many GB of RAM (10 on a 16 GB Mac). */
export const GB_PER_SESSION = 1.6;
/** Hard lines: the park sweep parks chats idle >= 3 min. */
export const HARD_SWAP_SHARE = 0.9;
export const HARD_DISK_GB = 8;

export type MachineLimit = 'sessions' | 'swap' | 'disk' | 'availMem' | 'light' | 'swapUnknown';

export interface MachineReason {
  limit: MachineLimit;
  /** Over a HARD limit (swap >= 90 %, disk < 8 GB). */
  hard: boolean;
  /** What was read and the line it crossed, for the owner's one sentence. */
  value: number | null;
  threshold: number;
}

export interface MachineRoom {
  ok: boolean;
  hard: boolean;
  reasons: MachineReason[];
}

/**
 * Is this machine under load? One pure function, two consumers: the idle-chat park sweep (which
 * acts on memory, swap and disk only) and the `notes` of `super state`'s `machine` (information:
 * `delegate` never reads it, owner 2026-10-21). A null fact never counts alone (fail open
 * toward the observable state), except that an unreadable swap on macOS, where it is always
 * readable, is reported as `swapUnknown` (it does not make `ok` false).
 */
export function machineRoom(facts: CapacityFacts, opts: { lightMode?: boolean; platform?: NodeJS.Platform } = {}): MachineRoom {
  const reasons: MachineReason[] = [];
  const { totalMemGb, swapUsedGb, swapTotalGb, claudeSessions, diskFreeGb, availMemGb } = facts;
  if (typeof claudeSessions === 'number' && typeof totalMemGb === 'number' && totalMemGb > 0) {
    const max = Math.floor(totalMemGb / GB_PER_SESSION);
    if (claudeSessions >= max) reasons.push({ limit: 'sessions', hard: false, value: claudeSessions, threshold: max });
  }
  if (typeof swapUsedGb === 'number' && typeof swapTotalGb === 'number' && swapTotalGb > 0) {
    const share = swapUsedGb / swapTotalGb;
    if (share >= SOFT_SWAP_SHARE) reasons.push({ limit: 'swap', hard: share >= HARD_SWAP_SHARE, value: Math.round(share * 100), threshold: Math.round((share >= HARD_SWAP_SHARE ? HARD_SWAP_SHARE : SOFT_SWAP_SHARE) * 100) });
  }
  if (typeof diskFreeGb === 'number' && diskFreeGb < SOFT_DISK_GB) {
    reasons.push({ limit: 'disk', hard: diskFreeGb < HARD_DISK_GB, value: diskFreeGb, threshold: diskFreeGb < HARD_DISK_GB ? HARD_DISK_GB : SOFT_DISK_GB });
  }
  if (typeof availMemGb === 'number' && availMemGb < SOFT_AVAIL_MEM_GB) {
    reasons.push({ limit: 'availMem', hard: false, value: availMemGb, threshold: SOFT_AVAIL_MEM_GB });
  }
  if (opts.lightMode) reasons.push({ limit: 'light', hard: false, value: null, threshold: 0 });
  const blocking = reasons.slice();
  if ((opts.platform ?? process.platform) === 'darwin' && (swapUsedGb === null || swapTotalGb === null)) {
    reasons.push({ limit: 'swapUnknown', hard: false, value: null, threshold: 0 });
  }
  return { ok: blocking.length === 0, hard: blocking.some((r) => r.hard), reasons };
}

/**
 * Light mode, as the server can tell it. The rule MIRRORS the app's `computeLightMode`
 * (dashboard/src/lib/lightMode.ts; a drift test compares them): the setting pins it On or Off;
 * Auto turns it on for a Mac of 8.5 GB or less, in macOS Low Power Mode, or on battery at 20 %
 * or below. Without power facts Auto knows only the memory rule (fail open: off).
 */
export const LIGHT_LOW_MEMORY_GB = 8.5;
export const LIGHT_LOW_BATTERY_PERCENT = 20;
export type LightReason = 'setting' | 'ram' | 'battery' | 'low-power';
export type LightSetting = 'auto' | 'on' | 'off';
export interface PowerFacts { onBattery?: boolean | null; batteryPercent?: number | null; lowPowerMode?: boolean | null }
export interface LightMode { on: boolean; reason: LightReason | null; setting: LightSetting; totalMemGb?: number; batteryPercent?: number | null }

export function readLightSetting(home: string = homedir()): LightSetting {
  try {
    const mode = (JSON.parse(readFileSync(join(home, '.dreamcontext', 'agent-ui.json'), 'utf-8')) as Record<string, unknown>).lightMode;
    return mode === 'on' || mode === 'off' ? mode : 'auto';
  } catch { return 'auto'; }
}

/** The rule, pure. */
export function lightModeState(setting: LightSetting, facts: Pick<CapacityFacts, 'totalMemGb'>, power?: PowerFacts | null): LightMode {
  const base = { setting, ...(typeof facts.totalMemGb === 'number' ? { totalMemGb: facts.totalMemGb } : {}) };
  if (setting === 'on') return { ...base, on: true, reason: 'setting' };
  if (setting === 'off') return { ...base, on: false, reason: null };
  if (typeof facts.totalMemGb === 'number' && facts.totalMemGb > 0 && facts.totalMemGb <= LIGHT_LOW_MEMORY_GB) return { ...base, on: true, reason: 'ram' };
  if (power?.lowPowerMode === true) return { ...base, on: true, reason: 'low-power' };
  if (power?.onBattery === true && typeof power.batteryPercent === 'number' && power.batteryPercent <= LIGHT_LOW_BATTERY_PERCENT) {
    return { ...base, on: true, reason: 'battery', batteryPercent: power.batteryPercent };
  }
  return { ...base, on: false, reason: null };
}

/** Tests only: what the power read answers while the facts are overridden (default: unknown). */
let powerOverride: PowerFacts | null = null;
export function setPowerFactsForTests(power: PowerFacts | null): void { powerOverride = power; }

/**
 * Is light mode on, and why? The power facts (`pmset`) are read only when Auto could still turn
 * it on by them; under a test override no `pmset` runs.
 */
/** How long `super state` waits for the power read (`pmset` can stall for minutes): Auto then
 *  answers without power facts, as the app does while its facts have not arrived. */
export const POWER_WAIT_MS = 1_500;

export async function lightModeNow(
  facts: Pick<CapacityFacts, 'totalMemGb'>,
  readPower: () => Promise<PowerFacts | null>,
  home: string = homedir(),
  waitMs: number = POWER_WAIT_MS,
): Promise<LightMode> {
  const setting = readLightSetting(home);
  const bare = lightModeState(setting, facts);
  if (setting !== 'auto' || bare.on) return bare;
  let power: PowerFacts | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    power = factsOverride ? powerOverride : await Promise.race([
      readPower(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
    ]);
  } catch { power = null; } finally { if (timer) clearTimeout(timer); }
  return lightModeState(setting, facts, power);
}

/** Is light mode on, from the setting and the memory rule alone (no power facts)? */
export function lightModeOn(facts: Pick<CapacityFacts, 'totalMemGb'>, home: string = homedir()): boolean {
  return lightModeState(readLightSetting(home), facts).on;
}

/** What light mode is, why it is on and what ends it: a fact for the Super, never a request. */
export function lightModeNote(light: LightMode): string {
  const why =
    light.reason === 'setting' ? 'Settings → Performance is set to On, so it stays on until that setting changes'
    : light.reason === 'ram' ? `Auto turned it on: this Mac has ${light.totalMemGb} GB RAM (Auto's line is ${LIGHT_LOW_MEMORY_GB} GB), so it stays on while the setting is Auto`
    : light.reason === 'battery' ? `Auto turned it on: the Mac runs on battery at ${light.batteryPercent} % (line ${LIGHT_LOW_BATTERY_PERCENT} %); it turns itself off when the Mac is plugged in or charged above that`
    : light.reason === 'low-power' ? 'Auto turned it on: macOS Low Power Mode is on; it turns itself off when Low Power Mode is turned off'
    : 'set by the app';
  return `light mode is on (${why}). It only slows the app's animations and polling: it holds no job and nothing needs switching off`;
}

/**
 * The machine's crossed lines as short English facts for `super state` (`machine.notes`):
 * information for the Super Agent, never a hold and never a message the owner is owed. Memory
 * lines say what does NOT help (disk cleanup frees disk, never RAM or swap).
 */
const DISK_NOT_MEMORY = 'removing worktrees or files frees disk, not memory';
export function machineNotes(room: MachineRoom, light?: LightMode): string[] {
  const notes: string[] = [];
  for (const r of room.reasons) {
    if (r.limit === 'sessions') notes.push(`${r.value} Claude processes are running on this machine (about ${r.threshold} fit its RAM)`);
    else if (r.limit === 'swap') notes.push(`swap is ${r.value} % full (line ${r.threshold} %); ${DISK_NOT_MEMORY}`);
    else if (r.limit === 'disk') notes.push(`${r.value} GB disk free (line ${r.threshold} GB)`);
    else if (r.limit === 'availMem') notes.push(`${r.value} GB memory free (line ${r.threshold} GB); ${DISK_NOT_MEMORY}`);
    else if (r.limit === 'light') notes.push(light ? lightModeNote(light) : lightModeNote({ on: true, reason: null, setting: 'auto' }));
  }
  return notes;
}

/** Tests only. */
export function resetCapacityForTests(): void {
  memo = null;
}

const LIVE = new Set(['starting', 'working', 'stale', 'asking']);

/** The vault's children that are running right now (starting/working/asking). */
/** A delegated child the window opened but the registry has not seen yet counts as live this
 *  long (a fast 9th `delegate` must not slip past the cap before its siblings register). */
export const UNREGISTERED_LIVE_MS = 60_000;

export function liveChildren(state: SuperState, now = Date.now()): string[] {
  return Object.keys(state.children).filter((sid) => {
    const c = getChat(sid);
    if (c) return LIVE.has(activityOf(c, now));
    const child = state.children[sid];
    return !child.adopted && now - child.startedAt < UNREGISTERED_LIVE_MS;
  });
}

/** May `super delegate` start one more child? Adoption never asks this. */
export function delegationAllowed(state: SuperState, now = Date.now()): { ok: boolean; live: number; max: number } {
  const live = liveChildren(state, now).length;
  return { ok: live < MAX_LIVE_CHILDREN, live, max: MAX_LIVE_CHILDREN };
}
