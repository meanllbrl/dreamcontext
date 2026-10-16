/**
 * Mac mode's thermal governor: a lid-closed Mac kept awake under the owner's full load heats
 * with nothing to stop it. Nothing is killed or quit. While macOS reports heat (thermalState
 * fair or worse) the owner's heavy processes are moved to the efficiency cores with
 * `taskpolicy -b` (no sudo; ~97% → ~30% CPU), and after two minutes of nominal readings they
 * are moved back with `taskpolicy -B`. The phone path is never slowed: claude chats, the
 * dashboard server and the app above it, our cloudflared, and WebKit's XPC services (the
 * desktop window; Safari tabs are spared with them, an accepted risk).
 *
 * A process forked while its parent is clamped is BORN clamped and stays so even after the
 * parent is released (measured), so those children are tracked as `inherited` ledger entries
 * and released parent before child. Identity is pid + `ps` lstart (printed in UTC): a reused
 * pid is never released or clamped by mistake.
 *
 * Every doubt resolves toward NOT holding a process slow: no thermal signal for six readings
 * releases everything, and a failed `ps` keeps the ledger so the next tick can still release.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAC_THERMAL_POLL_MS, MAC_THERMAL_RELEASE_TICKS, type MacThermal, type MacThermalState } from './contract.js';
import { isDashboardServer, isOwnerClaude, ledgerProgram, type ProcRow } from '../../orphan-processes.js';
import { isOurCloudflared } from './tunnel.js';

// ─── Runner (the one spawn seam: osascript, ps, taskpolicy) ─────────────────

export interface ThermalRunResult { code: number; stdout: string }
export type ThermalRun = (file: string, args: readonly string[], opts?: { timeoutMs?: number }) => Promise<ThermalRunResult>;

export const OSASCRIPT = '/usr/bin/osascript';
export const PS = '/bin/ps';
export const TASKPOLICY = '/usr/sbin/taskpolicy';
export const OSA_ARGS: readonly string[] = ['-l', 'JavaScript', '-e', 'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState'];
/** lstart in the C locale and in UTC, so it parses the same in every timezone. */
export const PS_ARGS: readonly string[] = ['-axww', '-o', 'uid=,pid=,ppid=,pgid=,pcpu=,pri=,etime=,lstart=,args='];

export const defaultThermalRun: ThermalRun = (file, args, opts = {}) => new Promise((resolveRun) => {
  execFile(file, [...args], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC' },
    timeout: opts.timeoutMs ?? 5000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  }, (err, stdout) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
    resolveRun({ code, stdout: String(stdout ?? '') });
  });
});

// ─── Reading the thermal state ──────────────────────────────────────────────

const STATES: readonly MacThermalState[] = ['nominal', 'fair', 'serious', 'critical'];
export const THERMAL_READ_TIMEOUT_MS = 3000;

/** `NSProcessInfo.thermalState` (0..3, no sudo). Null — never a throw — on anything else. */
export async function readThermalState(run: ThermalRun = defaultThermalRun): Promise<MacThermalState | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), THERMAL_READ_TIMEOUT_MS); });
  const read = (async () => {
    try {
      const r = await run(OSASCRIPT, OSA_ARGS, { timeoutMs: THERMAL_READ_TIMEOUT_MS });
      if (r.code !== 0) return null;
      const t = r.stdout.trim();
      return /^[0-3]$/.test(t) ? STATES[Number(t)] : null;
    } catch { return null; }
  })();
  try { return await Promise.race([read, timeout]); } finally { clearTimeout(timer); }
}

// ─── The process table ──────────────────────────────────────────────────────

export interface HeavyRow extends ProcRow {
  pcpu: number;
  pri: number;
  etimeSec: number;
}

const HEAVY_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+((?:\d+-)?(?:\d+:)?\d+:\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})(?:\s+(.*))?$/;

/** `[[dd-]hh:]mm:ss` → seconds. */
export function parseEtime(s: string): number {
  const [days, rest] = s.includes('-') ? [Number(s.split('-')[0]), s.split('-')[1]] : [0, s];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return days * 86_400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A C-locale lstart printed with TZ=UTC (`Sat Oct  3 15:35:39 2026`) → ms epoch, built with
 * `Date.UTC` from its tokens. Never `Date.parse`: that reads it as LOCAL time. NaN if malformed.
 */
export function lstartToMs(lstart: string): number {
  const t = lstart.trim().split(/\s+/);
  if (t.length !== 5) return NaN;
  const mon = MONTHS.indexOf(t[1]);
  const hms = t[3].split(':').map(Number);
  if (mon < 0 || hms.length !== 3) return NaN;
  return Date.UTC(Number(t[4]), mon, Number(t[2]), hms[0], hms[1], hms[2]);
}

/** Parse the {@link PS_ARGS} table. Null when ANY non-empty line does not parse (a failed scan). */
export function parseHeavyTable(out: string): Map<number, HeavyRow> | null {
  const rows = new Map<number, HeavyRow>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const m = HEAVY_LINE_RE.exec(line);
    if (!m) return null;
    rows.set(Number(m[2]), {
      uid: Number(m[1]), pid: Number(m[2]), ppid: Number(m[3]), pgid: Number(m[4]),
      pcpu: Number(m[5]), pri: Number(m[6]), etimeSec: parseEtime(m[7]), lstart: m[8], args: m[9] ?? '',
    });
  }
  return rows;
}

/** One `ps` scan; null when ps failed or its table did not parse. */
export async function scanProcesses(run: ThermalRun): Promise<Map<number, HeavyRow> | null> {
  try {
    const r = await run(PS, PS_ARGS, { timeoutMs: 5000 });
    if (r.code !== 0 || !r.stdout.trim()) return null;
    return parseHeavyTable(r.stdout);
  } catch { return null; }
}

// ─── The ledger ─────────────────────────────────────────────────────────────

export interface LedgerEntry {
  pid: number;
  /** Raw `ps` lstart (UTC): with pid, the identity. */
  lstart: string;
  /** ms epoch the slowdown began (an inherited child: its birth). */
  clampedAt: number;
  kind: 'root' | 'inherited';
  /** The ledger pid an inherited child descends from. */
  parent?: number;
  state: 'pending' | 'clamped' | 'released';
}

export function isLedgerEntry(x: unknown): x is LedgerEntry {
  const e = x as Partial<LedgerEntry> | null;
  return !!e && Number.isInteger(e.pid) && typeof e.lstart === 'string' && typeof e.clampedAt === 'number'
    && (e.kind === 'root' || e.kind === 'inherited') && (e.state === 'pending' || e.state === 'clamped' || e.state === 'released');
}

// ─── Who may be slowed ──────────────────────────────────────────────────────

export const MAX_ROOTS = 64;
export const MAX_INHERITED = 512;
export const MIN_AGE_SEC = 20;
/** A process at or below this `ps` pri already runs in the background band. */
export const BACKGROUND_PRI = 10;
const WEBKIT_PREFIX = '/System/Library/Frameworks/WebKit.framework/';
const MAX_DEPTH = 64;

export interface ExemptCtx {
  /** The dashboard server pid and its ppid ancestor chain (the desktop app). */
  serverChain: ReadonlySet<number>;
  home: string;
}

/** The server pid and every ancestor up to launchd. */
export function serverChainOf(rows: ReadonlyMap<number, ProcRow>, serverPid: number): Set<number> {
  const chain = new Set<number>([serverPid]);
  let row = rows.get(serverPid);
  for (let i = 0; row && row.ppid > 1 && i < MAX_DEPTH && !chain.has(row.ppid); i++) {
    chain.add(row.ppid);
    row = rows.get(row.ppid);
  }
  return chain;
}

/** The phone path: never slowed. */
export function isExempt(row: ProcRow, ctx: ExemptCtx): boolean {
  return isOwnerClaude(row)
    || isDashboardServer(row)
    || ctx.serverChain.has(row.pid)
    || isOurCloudflared(row.args, ctx.home)
    || row.args.trim().startsWith(WEBKIT_PREFIX);
}

/** CPU a process must burn to be slowed at this level; null = nothing is slowed. */
export function cpuThreshold(level: MacThermalState | null): number | null {
  if (level === 'fair') return 50;
  if (level === 'serious' || level === 'critical') return 15;
  return null;
}

/** New roots to slow at `level`: the heaviest first, at most {@link MAX_ROOTS}. */
export function pickClampTargets(rows: ReadonlyMap<number, HeavyRow>, o: {
  uid: number; level: MacThermalState | null; ctx: ExemptCtx; ledger: ReadonlyMap<number, LedgerEntry>; filter?: (row: HeavyRow) => boolean;
}): HeavyRow[] {
  const min = cpuThreshold(o.level);
  if (min === null) return [];
  const out: HeavyRow[] = [];
  for (const row of rows.values()) {
    if (row.uid !== o.uid || row.etimeSec < MIN_AGE_SEC || row.pcpu < min || row.pri <= BACKGROUND_PRI) continue;
    if (o.ledger.has(row.pid) || isExempt(row, o.ctx)) continue;
    if (o.filter && !o.filter(row)) continue;
    out.push(row);
  }
  return out.sort((a, b) => b.pcpu - a.pcpu).slice(0, MAX_ROOTS);
}

export interface InheritedScan {
  /** Children to record: born clamped under a ledger pid. */
  found: Array<{ row: HeavyRow; parent: number }>;
  /** Exempt children found slowed: released at once, never recorded. */
  exempt: HeavyRow[];
  /** More than the ceiling were found; the rest wait for a later tick. */
  capped: boolean;
}

/**
 * Same-uid processes in the background band, not yet in the ledger, whose ppid chain reaches a
 * ledger pid whose CURRENT lstart matches its entry, born at or after that entry's clamp
 * (whole seconds, inclusive: lstart has 1-second resolution).
 */
export function findInherited(rows: ReadonlyMap<number, HeavyRow>, ledger: ReadonlyMap<number, LedgerEntry>, o: {
  uid: number; ctx: ExemptCtx; room?: number;
}): InheritedScan {
  const scan: InheritedScan = { found: [], exempt: [], capped: false };
  if (!ledger.size) return scan;
  const room = o.room ?? MAX_INHERITED;
  for (const row of rows.values()) {
    if (row.uid !== o.uid || row.pri > BACKGROUND_PRI || ledger.has(row.pid)) continue;
    let anc = rows.get(row.ppid);
    let hit: LedgerEntry | undefined;
    const seen = new Set<number>([row.pid]);
    for (let i = 0; anc && i < MAX_DEPTH && !seen.has(anc.pid); i++) {
      const e = ledger.get(anc.pid);
      if (e && e.lstart === anc.lstart) { hit = e; break; }
      seen.add(anc.pid);
      anc = rows.get(anc.ppid);
    }
    if (!hit) continue;
    const born = lstartToMs(row.lstart);
    if (!(born >= Math.floor(hit.clampedAt / 1000) * 1000)) continue;
    if (isExempt(row, o.ctx)) { scan.exempt.push(row); continue; }
    if (scan.found.length >= room) { scan.capped = true; continue; }
    scan.found.push({ row, parent: hit.pid });
  }
  return scan;
}

// ─── The log ────────────────────────────────────────────────────────────────

export const THERMAL_LOG_CAP = 256 * 1024;

export function thermalLogPathOf(home: string = homedir()): string { return join(home, '.dreamcontext', 'handsfree-mac', 'thermal.log'); }
export function thermalPendingPathOf(home: string = homedir()): string { return join(home, '.dreamcontext', 'handsfree-mac', 'thermal-pending.json'); }

/** Append one line (0600). Over the cap, the newest half is kept first. Never throws. */
export function appendThermalLog(path: string | null, line: string, cap: number = THERMAL_LOG_CAP): void {
  if (!path) return;
  try {
    if (existsSync(path) && statSync(path).size > cap) {
      const text = readFileSync(path, 'utf8');
      const tail = text.slice(Math.floor(text.length / 2));
      const nl = tail.indexOf('\n');
      writeFileSync(path, nl >= 0 ? tail.slice(nl + 1) : '', { mode: 0o600 });
    }
    appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch { /* the log is a diagnostic, never a reason to fail */ }
}

// ─── Releasing ──────────────────────────────────────────────────────────────

export interface ReleaseOpts {
  run: ThermalRun;
  uid: number;
  home: string;
  now?: () => number;
  /** ms epoch: no `-B` is started past it. */
  deadline?: number;
  log?: (pid: number, args: string, action: string, kind: string) => void;
  /** The server chain for the exempt check of children found while releasing. */
  serverPid?: number;
}

export interface ReleaseResult {
  /** Entries still slowed (a failed ps, or the deadline). */
  leftover: LedgerEntry[];
  /** Every scan the procedure ran succeeded. */
  psOk: boolean;
}

const RELEASE_SWEEPS = 3;
/** `taskpolicy -p` on a pid that no longer exists ("setpriority(): No such process"). */
const TASKPOLICY_NO_SUCH_PROCESS = 70;

function depthOf(e: LedgerEntry, all: ReadonlyMap<number, LedgerEntry>): number {
  let d = 0;
  let cur: LedgerEntry | undefined = e;
  while (cur?.kind === 'inherited' && cur.parent !== undefined && d < MAX_DEPTH) { d++; cur = all.get(cur.parent); }
  return d;
}

/**
 * Release `entries`: roots first, then a ps sweep for children (a child forked before its
 * parent's `-B` is caught), children parent before child, sweep + release at most
 * {@link RELEASE_SWEEPS} times. `-B` only on an lstart match; absent from a SUCCESSFUL ps (or
 * `-B` answering "no such process") = dead, dropped; a FAILED ps or any other failed `-B` keeps
 * the entry. Past the deadline no ps and no `-B` start. Never throws.
 */
export async function releaseLedger(entries: readonly LedgerEntry[], o: ReleaseOpts): Promise<ReleaseResult> {
  const now = o.now ?? Date.now;
  const all = new Map<number, LedgerEntry>(entries.map((e) => [e.pid, { ...e }]));
  const pastDeadline = () => o.deadline !== undefined && now() >= o.deadline;
  const unreleased = () => [...all.values()].filter((e) => e.state !== 'released');
  let psOk = true;
  if (!all.size) return { leftover: [], psOk };   // nothing slowed: no ps at all

  const releaseOne = async (e: LedgerEntry, row: HeavyRow | undefined): Promise<boolean> => {
    if (!row || row.lstart !== e.lstart) { all.delete(e.pid); return true; }   // dead or a reused pid
    if (pastDeadline()) return false;
    let code = 1;
    try { code = (await o.run(TASKPOLICY, ['-B', '-p', String(e.pid)], { timeoutMs: 3000 })).code; } catch { /* kept: retried */ }
    o.log?.(e.pid, row.args, code === 0 ? 'release' : code === TASKPOLICY_NO_SUCH_PROCESS ? 'release-gone' : 'release-failed', e.kind);
    if (code === 0) e.state = 'released';
    else if (code === TASKPOLICY_NO_SUCH_PROCESS) all.delete(e.pid);
    // Any other failure (EAGAIN under a full process table, a timeout): the process is alive and
    // still slowed, so it stays unreleased and comes back as leftover.
    return true;
  };

  try {
    if (pastDeadline()) return { leftover: unreleased(), psOk };
    let rows = await scanProcesses(o.run);
    if (!rows) return { leftover: unreleased(), psOk: false };
    // Roots first.
    for (const e of unreleased().filter((x) => x.kind === 'root')) {
      if (!(await releaseOne(e, rows.get(e.pid)))) return { leftover: unreleased(), psOk };
    }
    const ctx: ExemptCtx = { serverChain: o.serverPid ? serverChainOf(rows, o.serverPid) : new Set(), home: o.home };
    for (let sweep = 0; sweep < RELEASE_SWEEPS; sweep++) {
      if (pastDeadline()) break;
      rows = await scanProcesses(o.run);
      if (!rows) { psOk = false; break; }
      const found = findInherited(rows, all, { uid: o.uid, ctx, room: Number.MAX_SAFE_INTEGER });
      for (const r of [...found.exempt, ...found.found.map((f) => f.row)]) {
        const parent = found.found.find((f) => f.row.pid === r.pid)?.parent;
        all.set(r.pid, { pid: r.pid, lstart: r.lstart, clampedAt: lstartToMs(r.lstart), kind: 'inherited', ...(parent !== undefined ? { parent } : {}), state: 'clamped' });
      }
      const todo = unreleased().sort((a, b) => depthOf(a, all) - depthOf(b, all));
      if (!todo.length) break;
      for (const e of todo) {
        if (!(await releaseOne(e, rows.get(e.pid)))) return { leftover: unreleased(), psOk };
      }
    }
  } catch { psOk = false; }
  return { leftover: unreleased(), psOk };
}

/**
 * Release whatever `thermal-pending.json` holds (a Return that ran out of time, a ps that
 * failed). The file is deleted only when every entry was released or found dead in a
 * successful ps; otherwise it is rewritten with the leftovers. Never throws.
 */
export async function releasePendingThermal(o: Omit<ReleaseOpts, 'deadline'> & { path?: string }): Promise<LedgerEntry[]> {
  const path = o.path ?? thermalPendingPathOf(o.home);
  let entries: LedgerEntry[];
  try { entries = (JSON.parse(readFileSync(path, 'utf8')) as unknown[]).filter(isLedgerEntry); } catch { return []; }
  const r = await releaseLedger(entries, o);
  if (!r.leftover.length && r.psOk) { try { rmSync(path, { force: true }); } catch { /* gone */ } return []; }
  writePendingThermal(path, r.leftover.length ? r.leftover : entries);
  return r.leftover;
}

/** Merge `entries` into the pending file (temp file + rename, 0600). Empty input writes nothing. */
export function addPendingThermal(path: string, entries: readonly LedgerEntry[]): void {
  if (!entries.length) return;
  let prior: LedgerEntry[] = [];
  try { prior = (JSON.parse(readFileSync(path, 'utf8')) as unknown[]).filter(isLedgerEntry); } catch { /* none */ }
  const key = (e: LedgerEntry) => `${e.pid}|${e.lstart}`;
  const merged = new Map(prior.map((e) => [key(e), e]));
  for (const e of entries) merged.set(key(e), e);
  writePendingThermal(path, [...merged.values()]);
}

function writePendingThermal(path: string, entries: readonly LedgerEntry[]): void {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* the folder is gone (uninstall) */ }
}

// ─── The governor ───────────────────────────────────────────────────────────

export interface GovernorOpts {
  serverPid: number;
  home?: string;
  uid?: number;
  run?: ThermalRun;
  now?: () => number;
  readThermal?: () => Promise<MacThermalState | null>;
  pollMs?: number;
  releaseTicks?: number;
  /** Verify seam: only rows it accepts may become roots. */
  filter?: (row: HeavyRow) => boolean;
  /** The ledger after every batch of changes (→ state.json). */
  onChange?: (ledger: LedgerEntry[]) => void;
  /** The log file; null = no log. Defaults to `~/.dreamcontext/handsfree-mac/thermal.log`. */
  logPath?: string | null;
  logCap?: number;
}

export class ThermalGovernor {
  private readonly ledger = new Map<number, LedgerEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private halted = false;
  private level: MacThermalState | null = null;
  private nominalStreak = 0;
  private nullStreak = 0;
  private readonly run: ThermalRun;
  private readonly now: () => number;
  private readonly home: string;
  private readonly uid: number;

  constructor(private readonly o: GovernorOpts) {
    this.run = o.run ?? defaultThermalRun;
    this.now = o.now ?? Date.now;
    this.home = o.home ?? homedir();
    this.uid = o.uid ?? (process.getuid?.() ?? -1);
  }

  /** The chip/panel view: the last reading and how many processes are slowed now. */
  snapshot(): MacThermal {
    let slowed = 0;
    for (const e of this.ledger.values()) if (e.state === 'clamped') slowed++;
    return { state: this.level, slowed };
  }

  entries(): LedgerEntry[] { return [...this.ledger.values()].map((e) => ({ ...e })); }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, this.o.pollMs ?? MAC_THERMAL_POLL_MS);
    this.timer.unref?.();
  }

  /** Synchronous: no new tick, no `-b` from here on, and a late tick's onChange is a no-op. */
  halt(): void {
    this.stopped = true;
    this.halted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll. Single-flight: a tick that starts while one runs is skipped. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().catch(() => undefined).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * Stop and release every entry (roots, then children). Waits for an in-flight tick, but not
   * past `deadlineMs`; no `-B` is started past it. Never throws. Returns what is still slowed.
   */
  async releaseAll(o: { deadlineMs?: number } = {}): Promise<LedgerEntry[]> {
    this.halt();
    const deadline = o.deadlineMs !== undefined ? this.now() + o.deadlineMs : undefined;
    try {
      if (this.inFlight) {
        if (deadline === undefined) await this.inFlight;
        else {
          let t: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([this.inFlight, new Promise((r) => { t = setTimeout(r, Math.max(0, deadline - this.now())); })]);
          clearTimeout(t);
        }
      }
      const r = await releaseLedger(this.entries(), this.releaseOpts(deadline));
      this.ledger.clear();
      return r.leftover;
    } catch {
      return this.entries().filter((e) => e.state !== 'released');
    }
  }

  private releaseOpts(deadline?: number): ReleaseOpts {
    return { run: this.run, uid: this.uid, home: this.home, now: this.now, deadline, serverPid: this.o.serverPid, log: (pid, args, action, kind) => this.log(pid, args, action, kind) };
  }

  private log(pid: number, args: string, action: string, kind: string): void {
    const path = this.o.logPath === undefined ? thermalLogPathOf(this.home) : this.o.logPath;
    appendThermalLog(path, `${new Date(this.now()).toISOString()} ${this.level ?? 'null'} ${pid} ${ledgerProgram(args) || '-'} ${action} ${kind}`, this.o.logCap);
  }

  private emit(): void {
    if (this.halted) return;
    try { this.o.onChange?.(this.entries()); } catch { /* the state write is best-effort */ }
  }

  private async runTick(): Promise<void> {
    const level = await (this.o.readThermal ?? (() => readThermalState(this.run)))().catch(() => null);
    if (this.stopped) return;
    this.level = level;
    if (level === null) { this.nullStreak++; this.nominalStreak = 0; }
    else if (level === 'nominal') { this.nominalStreak++; this.nullStreak = 0; }
    else { this.nominalStreak = 0; this.nullStreak = 0; }

    // Cool and nothing slowed: no ps at all.
    if (!this.ledger.size && (level === null || level === 'nominal')) return;

    const releaseAfter = this.o.releaseTicks ?? MAC_THERMAL_RELEASE_TICKS;
    if (this.ledger.size && (this.nominalStreak >= releaseAfter || this.nullStreak >= releaseAfter)) {
      const r = await releaseLedger(this.entries(), this.releaseOpts());
      if (this.halted) return;
      this.ledger.clear();
      for (const e of r.leftover) this.ledger.set(e.pid, e);
      this.emit();
      return;
    }

    const rows = await scanProcesses(this.run);
    if (!rows || this.stopped) return;   // a failed ps keeps the ledger for the next tick
    let changed = false;
    for (const e of [...this.ledger.values()]) {
      const row = rows.get(e.pid);
      if (!row || row.lstart !== e.lstart) { this.ledger.delete(e.pid); changed = true; }   // gone
    }
    const ctx: ExemptCtx = { serverChain: serverChainOf(rows, this.o.serverPid), home: this.home };

    // Children born under a slowed parent first: already slowed, recorded as clamped.
    let inherited = 0;
    for (const e of this.ledger.values()) if (e.kind === 'inherited') inherited++;
    const found = findInherited(rows, this.ledger, { uid: this.uid, ctx, room: Math.max(0, MAX_INHERITED - inherited) });
    for (const row of found.exempt) {
      if (this.stopped) return;
      let code = 1;
      try { code = (await this.run(TASKPOLICY, ['-B', '-p', String(row.pid)], { timeoutMs: 3000 })).code; } catch { /* gone */ }
      this.log(row.pid, row.args, code === 0 ? 'release-exempt' : 'release-failed', 'inherited');
    }
    if (found.capped) this.log(0, '', 'skip-cap', 'inherited');
    for (const { row, parent } of found.found) {
      this.ledger.set(row.pid, { pid: row.pid, lstart: row.lstart, clampedAt: lstartToMs(row.lstart), kind: 'inherited', parent, state: 'clamped' });
      this.log(row.pid, row.args, 'inherited', 'inherited');
      changed = true;
    }

    // New roots, all written as pending in ONE batch before any `-b` runs.
    const roots = pickClampTargets(rows, { uid: this.uid, level, ctx, ledger: this.ledger, filter: this.o.filter });
    const at = this.now();
    for (const row of roots) this.ledger.set(row.pid, { pid: row.pid, lstart: row.lstart, clampedAt: at, kind: 'root', state: 'pending' });
    if (roots.length) this.emit();
    for (const row of roots) {
      if (this.stopped) break;
      let code = 1;
      try { code = (await this.run(TASKPOLICY, ['-b', '-p', String(row.pid)], { timeoutMs: 3000 })).code; } catch { /* gone */ }
      const e = this.ledger.get(row.pid);
      if (code === 0 && e) { e.state = 'clamped'; this.log(row.pid, row.args, 'clamp', 'root'); }
      else { this.ledger.delete(row.pid); this.log(row.pid, row.args, 'clamp-failed', 'root'); }
      changed = true;
    }
    if (changed) this.emit();
  }
}
