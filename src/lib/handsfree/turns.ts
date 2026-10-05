/**
 * Running work inside the in-scope roots at go (Go step 3): a running turn WAITS unless the
 * owner chose Cut (D4, AC12); an idle chat is cut without asking; every cut kills the whole
 * process group, and the git preflight re-runs after it.
 *
 * D22: the PROCESS TREE decides ({@link processTurnControl}); the dashboard's registries
 * (chat children, PTYs, detached runs; `src/server/routes/handsfree.ts`) only label what the
 * scan finds and give idle chats their cut-without-asking. The CLI uses the scan alone.
 */
import { pathUnderAny } from '../automations/runner.js';
import type { ProcessRunner } from './git-snapshot.js';

export interface RunningWork {
  kind: 'chat' | 'pty' | 'detached' | 'process';
  id: string;
  cwd?: string;
  /** A running turn (wait or Cut). False = an idle chat child (cut without asking). */
  busy: boolean;
  /** The process id (scan entries). */
  pid?: number;
  /** A scan entry that descends from this process (the dashboard's own child tree). */
  fromSelf?: boolean;
}

export interface TurnControl {
  list(roots: string[]): Promise<RunningWork[]>;
  /** Cut the idle work (`all: false`) or everything (`all: true`); resolves once it exited. */
  cut(roots: string[], o: { all: boolean }): Promise<number>;
}

export const NO_TURNS: TurnControl = {
  list: async () => [],
  cut: async () => 0,
};

/** Realpath + case-insensitive (darwin/win32) containment: lane F's `pathUnderAny`. */
export function under(roots: string[], p: string): boolean {
  return pathUnderAny(p, roots);
}

export interface ProcessScanOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Signal a pid (negative = a process group). Injectable for tests. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** This process (the dashboard server or the CLI). */
  self?: number;
  /** How long a cut waits after SIGTERM before SIGKILL (default 5 s), and after SIGKILL. */
  graceMs?: number;
}

interface Found { pid: number; cwd: string; pgid: number | null; fromSelf: boolean }

/** The id of the entry a failed process scan reports: running work that could not be checked. */
export const UNKNOWN_WORK_ID = 'unknown';

/**
 * D22: running work by the PROCESS TREE. Every process whose cwd is inside a scope root
 * (claude and every descendant, hooks included), whether or not it descends from this
 * process, found by an lsof cwd scan with lane F's realpath + case-insensitive containment.
 * Never listed or signalled: this process itself, its own process group, and its ancestors
 * (a claude that launched the CLI cannot finish before the CLI does; waiting on it would
 * deadlock and cutting it would kill the caller).
 * Cut = SIGTERM to each found process group, SIGKILL to each group after the grace even when
 * its leader already exited, then wait until every found pid is gone.
 */
export function processTurnControl(run: ProcessRunner, o: ProcessScanOptions = {}): TurnControl {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const kill = o.kill ?? ((pid: number, sig: NodeJS.Signals | 0) => { process.kill(pid, sig); });
  const self = o.self ?? process.pid;
  const grace = o.graceMs ?? 5000;
  const table = async (): Promise<Map<number, { ppid: number; pgid: number }>> => {
    const res = await run('ps', ['-axo', 'pid=,ppid=,pgid='], { cwd: '/', timeoutMs: 15_000 }).catch(() => null);
    const m = new Map<number, { ppid: number; pgid: number }>();
    for (const line of res?.stdout.toString().split('\n') ?? []) {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      if (pid > 0) m.set(pid, { ppid, pgid });
    }
    return m;
  };
  const scan = async (roots: string[]): Promise<{ found: Found[]; ownGroup: number | null; unknown?: true }> => {
    const res = await run('lsof', ['-a', '-d', 'cwd', '-F', 'pn'], { cwd: '/', timeoutMs: 30_000 }).catch(() => null);
    // Fail CLOSED: a scan that failed or timed out is "unknown running work", never "nothing".
    if (!res || res.signal || (res.code !== 0 && res.code !== 1)) return { found: [], ownGroup: null, unknown: true };
    const hits: Array<{ pid: number; cwd: string }> = [];
    let pid = 0;
    for (const line of res.stdout.toString().split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid > 0 && pid !== self && under(roots, line.slice(1))) hits.push({ pid, cwd: line.slice(1) });
    }
    const t = await table();
    const ownGroup = t.get(self)?.pgid ?? null;
    if (!hits.length) return { found: [], ownGroup };
    const ancestors = new Set<number>();
    for (let cur = t.get(self)?.ppid ?? 0, i = 0; cur > 1 && i < 256; i++) { ancestors.add(cur); cur = t.get(cur)?.ppid ?? 0; }
    const fromSelf = (p: number) => {
      for (let cur = t.get(p)?.ppid ?? 0, i = 0; cur > 1 && i < 256; i++) { if (cur === self) return true; cur = t.get(cur)?.ppid ?? 0; }
      return false;
    };
    const found = hits
      .filter((h) => !ancestors.has(h.pid) && (ownGroup === null || t.get(h.pid)?.pgid !== ownGroup))
      .map((h) => ({ ...h, pgid: t.get(h.pid)?.pgid ?? null, fromSelf: fromSelf(h.pid) }));
    return { found, ownGroup };
  };
  const alive = (pid: number) => { try { kill(pid, 0); return true; } catch { return false; } };
  const signalAll = (found: Found[], sig: NodeJS.Signals, ownGroup: number | null) => {
    const groups = new Set<number>();
    for (const f of found) {
      if (f.pgid && f.pgid > 1 && f.pgid !== ownGroup) groups.add(f.pgid);
      else { try { kill(f.pid, sig); } catch { /* gone */ } }
    }
    // The whole group, even when its leader already exited (its hook children may not have).
    for (const g of groups) { try { kill(-g, sig); } catch { /* group gone */ } }
  };
  const waitGone = async (found: Found[], ms: number) => {
    for (let waited = 0; waited < ms && found.some((f) => alive(f.pid)); waited += 100) await sleep(100);
  };
  return {
    async list(roots) {
      const r = await scan(roots);
      if (r.unknown) return [{ kind: 'process' as const, id: UNKNOWN_WORK_ID, busy: true }];
      return r.found.map((f) => ({ kind: 'process' as const, id: String(f.pid), pid: f.pid, cwd: f.cwd, busy: true, fromSelf: f.fromSelf }));
    },
    async cut(roots, c) {
      if (!c.all) return 0;
      const { found, ownGroup } = await scan(roots);
      if (!found.length) return 0;
      signalAll(found, 'SIGTERM', ownGroup);
      await waitGone(found, grace);
      signalAll(found, 'SIGKILL', ownGroup);
      await waitGone(found, Math.max(grace, 1000) * 2);
      return found.length;
    },
  };
}

/** Two controls as one: listed side by side, cut in order. */
export function combineTurnControls(...cs: TurnControl[]): TurnControl {
  return {
    list: async (roots) => (await Promise.all(cs.map((c) => c.list(roots)))).flat(),
    cut: async (roots, o) => {
      let n = 0;
      for (const c of cs) n += await c.cut(roots, o);
      return n;
    },
  };
}
