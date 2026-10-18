import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { freemem, homedir, loadavg } from 'node:os';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { activityOf, getChat } from '../assistant/chat-registry.js';
import { MAX_LIVE_CHILDREN, type SuperState } from './types.js';
import { superWorktreeRoot } from './store.js';

/**
 * How much room this machine has for another child chat (plan-r7 D11, decision 5).
 *
 * The HARD cap is {@link MAX_LIVE_CHILDREN} live children for a NEW `super delegate`; adoption
 * at hand-over is never refused (those chats already exist). The facts below are what the
 * briefing reasons over before it starts one more: free memory (`vm_stat` on macOS, where
 * `os.freemem()` reports only the truly free pages and reads an 8 GB Mac as nearly full), free
 * disk where worktrees go, and the 1-minute load. Every read is async (no `execFileSync` on a
 * request path) and memoized for a minute.
 */

export interface CapacityFacts {
  availMemGb: number;
  diskFreeGb: number | null;
  load1: number;
}

export interface CapacityDeps {
  platform: NodeJS.Platform;
  vmStat: () => Promise<string>;
  freeMem: () => number;
  statfs: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  loadavg: () => number[];
  worktreeRoot: string;
  now: () => number;
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
  return { availMemGb: round1(availBytes / GB), diskFreeGb, load1 };
}

/** The facts, memoized for {@link CAPACITY_TTL_MS}. Injectable readers for tests. */
export function readCapacityFacts(deps: CapacityDeps = defaultDeps()): Promise<CapacityFacts> {
  const t = deps.now();
  if (memo && t - memo.at < CAPACITY_TTL_MS) return memo.value;
  const value = measure(deps);
  memo = { at: t, value };
  return value;
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
