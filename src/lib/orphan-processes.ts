// Leftover processes a chat tab's agent started and nobody will ever stop.
//
// THE LEAK: an agent runs `next dev &` (or nohup, or an emulator) inside a Bash call. The
// launching shell exits, the tree is reparented to launchd, and nothing kills it — not Claude
// Code's background-shell tracking, not the server's tab-close reap (that reaps the claude
// child only). Measured 2026-10-03: six `next dev` trees 3-12 days old held ~16.8 GB.
//
// This module is the READ side and is pure apart from `ps`: it snapshots the process table and
// the env of the few rows that matter, and classifies which process groups are reapable. The
// sweeper (src/server/orphan-sweep.ts) owns grace, the ledger and the signals.
//
// Every doubt resolves toward KEEPING a process. A table that does not parse, a `ps` that
// throws, or an owner whose env cannot be read aborts the whole tick: an unreadable owner must
// never read as "owner gone".

import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { CLAUDE_COMMAND_RE } from './session-origin.js';

const execFileAsync = promisify(execFile);

export interface ProcRow {
  uid: number;
  pid: number;
  ppid: number;
  pgid: number;
  /** `ps` lstart, e.g. `Sat Oct  3 15:35:39 2026` — with pid, a process identity across ticks. */
  lstart: string;
  /** Full argv as `ps` renders it (newlines show as `\012`). May be empty. */
  args: string;
}

/** The markers found in one process's env. `readable: false` = no line, a mismatched line, or an empty env. */
export interface EnvMarkers {
  readable: boolean;
  serverPids: number[];
  tabIds: string[];
  sessionIds: string[];
}

export interface Snapshot {
  rows: Map<number, ProcRow>;
  env: Map<number, EnvMarkers>;
  /** The uid this server runs as; rows of any other uid are ancestry only. */
  uid: number;
  /** Owner rows that died between the table and the env call. */
  gone: Set<number>;
}

export type AbortReason = 'table' | 'env' | 'owner-unreadable';

export interface OrphanGroup {
  pgid: number;
  members: ProcRow[];
  tabId: string;
  sessionId: string | null;
}

// ─── ps ──────────────────────────────────────────────────────────────────────

/** A failed `ps`. Carries ONLY a class string: the execFile error holds stdout, and `-E` stdout holds tokens. */
export class PsError extends Error {
  readonly psClass: string;
  constructor(psClass: string) {
    super(`ps failed (${psClass})`);
    this.name = 'PsError';
    this.psClass = psClass;
  }
}

/** Run `ps` with `args`; an exit code in `okCodes` with non-empty stdout counts as success. */
export type RunPs = (args: readonly string[], okCodes: readonly number[]) => Promise<string>;

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

function psErrorClass(err: unknown): string {
  const e = err as { code?: unknown; killed?: unknown } | null;
  if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || e?.code === 'ENOBUFS') return 'enobufs';
  if (e?.killed === true || e?.code === 'ETIMEDOUT') return 'timeout';
  if (typeof e?.code === 'number') return `exit:${e.code}`;
  return 'spawn';
}

/**
 * Async on purpose: a 600-row `ps -axww` under execFileSync stalls every request the server is
 * serving. Every rejection is swallowed and replaced by a fresh PsError — no cause, no stdout.
 */
export function createRunPs(
  exec: ExecFileLike = (file, args, opts) => execFileAsync(file, [...args], { ...opts, encoding: 'utf8' }),
): RunPs {
  return async (args, okCodes) => {
    let failure: string;
    try {
      const { stdout } = await exec('ps', args, {
        env: { ...process.env, LC_ALL: 'C' },
        timeout: 5000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return String(stdout);
    } catch (err) {
      const e = err as { code?: unknown; stdout?: unknown } | null;
      // macOS exits 1 when a listed pid died in between; the live lines are still printed.
      if (typeof e?.code === 'number' && okCodes.includes(e.code)) {
        const stdout = typeof e.stdout === 'string' ? e.stdout : '';
        if (stdout.trim()) return stdout;
      }
      failure = psErrorClass(err);
    }
    throw new PsError(failure);
  };
}

export const runPs: RunPs = createRunPs();

const TABLE_ARGS = ['-axww', '-o', 'uid=,pid=,ppid=,pgid=,lstart=,args='] as const;

// macOS pads the lstart column (5 spaces before args); `\s+` eats the padding, trailing
// whitespace in args is kept (`next-server (v16.1.1) `).
const TABLE_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})(?:\s+(.*))?$/;

/** Parse the `-o uid=,pid=,ppid=,pgid=,lstart=,args=` table. Null if ANY non-empty line does not parse. */
export function parseProcTable(out: string): Map<number, ProcRow> | null {
  const rows = new Map<number, ProcRow>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(TABLE_LINE_RE);
    if (!m) return null;
    const row: ProcRow = {
      uid: Number(m[1]),
      pid: Number(m[2]),
      ppid: Number(m[3]),
      pgid: Number(m[4]),
      lstart: m[5],
      args: m[6] ?? '',
    };
    rows.set(row.pid, row);
  }
  return rows;
}

// Anchored on whitespace so a marker can only start a token. Run on the env remainder only,
// never on argv, so a command line can never forge one.
const SERVER_PID_RE = /(?:^|\s)DREAMCONTEXT_SERVER_PID=(\d+)(?=\s|$)/g;
const TAB_SESSION_RE = /(?:^|\s)DREAMCONTEXT_TAB_SESSION=([0-9a-f-]{36})(?=\s|$)/g;
const SESSION_ID_RE = /(?:^|\s)CLAUDE_CODE_SESSION_ID=([0-9a-f-]{36})(?=\s|$)/g;

const UNREADABLE: EnvMarkers = { readable: false, serverPids: [], tabIds: [], sessionIds: [] };

function distinct<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/**
 * Parse `ps -wwE -o pid=,command=` output. Each line is `<pid> <args> <env…>`; the line must
 * start with that pid's table args or the env is unknown (a pid reused in between). EVERY
 * marker match is collected: an env value can contain whitespace and so carry a second token.
 */
export function parseEnvLines(out: string, rows: Map<number, ProcRow>): Map<number, EnvMarkers> {
  const env = new Map<number, EnvMarkers>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s*(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const row = rows.get(pid);
    if (!row) continue;
    const rest = m[2];
    if (!rest.startsWith(row.args)) { env.set(pid, UNREADABLE); continue; }
    const remainder = rest.slice(row.args.length);
    // The env must start a new token after args, not continue the last argv word.
    const boundary = row.args === '' || /\s$/.test(row.args) || remainder === '' || /^\s/.test(remainder);
    if (!boundary || !remainder.trim()) { env.set(pid, UNREADABLE); continue; }
    env.set(pid, {
      readable: true,
      serverPids: distinct([...remainder.matchAll(SERVER_PID_RE)].map((x) => Number(x[1]))),
      tabIds: distinct([...remainder.matchAll(TAB_SESSION_RE)].map((x) => x[1])),
      sessionIds: distinct([...remainder.matchAll(SESSION_ID_RE)].map((x) => x[1])),
    });
  }
  return env;
}

// ─── Predicates ──────────────────────────────────────────────────────────────

function argv0(args: string): string {
  return args.trim().split(/\s+/)[0] ?? '';
}

/** Basename of argv0 only, reduced to a safe charset — the ONLY thing about a process the ledger names. */
export function ledgerProgram(args: string): string {
  return basename(argv0(args)).replace(/[^A-Za-z0-9._()-]/g, '').slice(0, 40);
}

/** The process IS a claude: a `claude` binary, or node running the npm-installed CLI. */
export function isOwnerClaude(row: ProcRow): boolean {
  const name = basename(argv0(row.args));
  return name === 'claude' || (name === 'node' && row.args.includes('@anthropic-ai/claude-code/cli.js'));
}

/** `claude` anywhere as a command word — also wrappers (`zsh -c … claude -p`, `caffeinate -i claude`). Keep direction only. */
export function isLooseClaude(row: ProcRow): boolean {
  return CLAUDE_COMMAND_RE.test(row.args);
}

/** STRICT: `node <…dist/index.js | …bin/dreamcontext> dashboard …`. */
export function isDashboardServer(row: ProcRow): boolean {
  const tokens = row.args.trim().split(/\s+/);
  if (basename(tokens[0] ?? '') !== 'node') return false;
  const scriptAt = tokens.findIndex((t, i) => i > 0 && !t.startsWith('-'));
  if (scriptAt < 0) return false;
  const script = tokens[scriptAt];
  return (script.endsWith('dist/index.js') || script.endsWith('bin/dreamcontext')) && tokens[scriptAt + 1] === 'dashboard';
}

/** LOOSE: any command mentioning a dreamcontext dashboard (agents' wrappers show an EMPTY env). Keep direction only. */
export function isDashboardLooking(row: ProcRow): boolean {
  return row.args.includes('dashboard') && (row.args.includes('dist/index.js') || row.args.includes('bin/dreamcontext'));
}

// ─── Groups ──────────────────────────────────────────────────────────────────

const MAX_ANCESTRY = 64;

/** Does `pid`'s ppid chain hit a claude? A cycle or the depth cap counts as yes (keep). */
function hasClaudeAncestor(rows: Map<number, ProcRow>, pid: number): boolean {
  const visited = new Set<number>();
  let cur = rows.get(pid)?.ppid ?? 0;
  for (let depth = 0; cur > 0; depth++) {
    if (depth >= MAX_ANCESTRY || visited.has(cur)) return true;
    visited.add(cur);
    const row = rows.get(cur);
    if (!row) return false;
    if (isOwnerClaude(row) || isLooseClaude(row)) return true;
    cur = row.ppid;
  }
  return false;
}

/** `pid` and every ancestor of it (bounded). */
function selfAndAncestors(rows: Map<number, ProcRow>, pid: number): Set<number> {
  const out = new Set<number>([pid]);
  let cur = rows.get(pid)?.ppid ?? 0;
  for (let depth = 0; cur > 0 && depth < MAX_ANCESTRY && !out.has(cur); depth++) {
    out.add(cur);
    cur = rows.get(cur)?.ppid ?? 0;
  }
  return out;
}

/** Rule 1: dead-leader, same-uid, claude-free process groups, keyed by pgid. */
export function escapedGroups(rows: Map<number, ProcRow>, uid: number): Map<number, ProcRow[]> {
  const byPgid = new Map<number, ProcRow[]>();
  for (const row of rows.values()) {
    const list = byPgid.get(row.pgid);
    if (list) list.push(row); else byPgid.set(row.pgid, [row]);
  }
  const escaped = new Map<number, ProcRow[]>();
  for (const [pgid, members] of byPgid) {
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    if (rows.has(pgid)) continue; // leader alive
    if (members.some((r) => r.uid !== uid)) continue;
    if (members.some((r) => isOwnerClaude(r) || isLooseClaude(r))) continue;
    if (members.some((r) => hasClaudeAncestor(rows, r.pid))) continue;
    escaped.set(pgid, members);
  }
  return escaped;
}

/** Dashboard-server rows of this uid: the strict predicate, plus this server's own row always. */
function dashboardServerRows(rows: Map<number, ProcRow>, uid: number, selfPid: number): ProcRow[] {
  return [...rows.values()].filter((r) => r.uid === uid && (r.pid === selfPid || isDashboardServer(r)));
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

export interface SnapshotOptions {
  selfPid?: number;
  uid?: number;
}

/**
 * Two `ps` calls: the whole table, then ONE env call for the rows whose env matters (this
 * server, every claude, every dashboard server, their direct children, every rule-1 member).
 */
export async function takeSnapshot(
  run: RunPs,
  isPidAlive: (pid: number) => boolean,
  opts: SnapshotOptions = {},
): Promise<Snapshot | { aborted: AbortReason }> {
  const selfPid = opts.selfPid ?? process.pid;
  const uid = opts.uid ?? process.getuid?.() ?? -1;

  let tableOut: string;
  try {
    tableOut = await run(TABLE_ARGS, [0]);
  } catch {
    return { aborted: 'table' };
  }
  const rows = parseProcTable(tableOut);
  if (!rows || rows.size === 0) return { aborted: 'table' };

  const owners = [...rows.values()].filter((r) => r.uid === uid && isOwnerClaude(r));
  const strictServers = [...rows.values()].filter((r) => r.uid === uid && isDashboardServer(r));
  const serverPids = new Set(dashboardServerRows(rows, uid, selfPid).map((r) => r.pid));
  const hedge = [...rows.values()].filter((r) => r.uid === uid && serverPids.has(r.ppid));

  const list = new Set<number>([selfPid]);
  for (const r of owners) list.add(r.pid);
  for (const pid of serverPids) list.add(pid);
  for (const r of hedge) list.add(r.pid);
  for (const members of escapedGroups(rows, uid).values()) for (const r of members) list.add(r.pid);

  let envOut: string;
  try {
    envOut = await run(['-wwE', '-o', 'pid=,command=', '-p', [...list].join(',')], [0, 1]);
  } catch {
    return { aborted: 'env' };
  }
  if (!envOut.trim()) return { aborted: 'env' };
  const env = parseEnvLines(envOut, rows);

  // Only a claude or a strict dashboard server can abort: their env is what proves a tab live.
  const gone = new Set<number>();
  for (const r of [...owners, ...strictServers]) {
    const markers = env.get(r.pid);
    if (!markers) {
      if (isPidAlive(r.pid)) return { aborted: 'owner-unreadable' };
      gone.add(r.pid);
    } else if (!markers.readable) {
      return { aborted: 'owner-unreadable' };
    }
  }
  return { rows, env, uid, gone };
}

// ─── Classification (pure) ───────────────────────────────────────────────────

const ARGV_SESSION_RE = /(?:^|\s)--(?:resume|session-id)(?:=|\s+)(\S+)/g;

/** Every tab or session id a live owner still carries. */
function liveIds(snapshot: Snapshot, selfPid: number, selfEnv: NodeJS.ProcessEnv, escapedPids: Set<number>): Set<string> {
  const { rows, env, uid, gone } = snapshot;
  const live = new Set<string>();
  const addEnv = (pid: number, tabsOnly = false): void => {
    const m = env.get(pid);
    if (!m?.readable) return;
    for (const id of m.tabIds) live.add(id);
    if (!tabsOnly) for (const id of m.sessionIds) live.add(id);
  };

  // a. every live claude: env ids and argv --resume / --session-id
  for (const r of rows.values()) {
    if (r.uid !== uid || gone.has(r.pid) || !isOwnerClaude(r)) continue;
    addEnv(r.pid);
    for (const m of r.args.matchAll(ARGV_SESSION_RE)) live.add(m[1]);
  }

  // b. every live dashboard server, except an agent's leftover one inside an escaped group
  const servers = dashboardServerRows(rows, uid, selfPid).filter((r) => !gone.has(r.pid));
  for (const r of servers) {
    if (r.pid !== selfPid && escapedPids.has(r.pid)) continue;
    addEnv(r.pid);
  }
  for (const key of ['DREAMCONTEXT_TAB_SESSION', 'CLAUDE_CODE_SESSION_ID']) {
    const v = (selfEnv[key] ?? '').trim();
    if (v) live.add(v);
  }

  // Hedge against a future claude that retitles itself: a tab-carrying direct child of a server.
  const serverPids = new Set(servers.map((r) => r.pid));
  for (const r of rows.values()) {
    if (r.uid === uid && serverPids.has(r.ppid)) addEnv(r.pid, true);
  }
  return live;
}

/**
 * The reap rule. A group is a candidate only when ALL hold:
 *  1. escaped — dead leader, same uid, no claude member or ancestor (escapedGroups);
 *  2. attributed to ONE tab — a member carries SERVER_PID + TAB_SESSION, no member is ambiguous,
 *     and every SERVER_PID is this server or dead;
 *  3. that tab is not live (liveIds);
 *  4. no member is this server, its ancestor, or anything dashboard-looking.
 * `paused` = groups kept ONLY because a SERVER_PID names another live process: the sweeper
 * keeps their grace frozen instead of resetting it.
 */
export function classifyOrphanGroups(
  snapshot: Snapshot,
  selfPid: number,
  selfEnv: NodeJS.ProcessEnv,
): { candidates: OrphanGroup[]; paused: OrphanGroup[] } {
  const { rows, env, uid } = snapshot;
  const escaped = escapedGroups(rows, uid);
  const escapedPids = new Set<number>();
  for (const members of escaped.values()) for (const r of members) escapedPids.add(r.pid);
  const live = liveIds(snapshot, selfPid, selfEnv, escapedPids);
  const protectedPids = selfAndAncestors(rows, selfPid);

  const candidates: OrphanGroup[] = [];
  const paused: OrphanGroup[] = [];
  for (const [pgid, members] of escaped) {
    const markers = members.map((r) => env.get(r.pid)).filter((m): m is EnvMarkers => !!m?.readable);
    if (markers.some((m) => m.tabIds.length > 1 || m.sessionIds.length > 1 || m.serverPids.length > 1)) continue;
    if (!markers.some((m) => m.serverPids.length > 0 && m.tabIds.length > 0)) continue;
    const tabs = distinct(markers.flatMap((m) => m.tabIds));
    if (tabs.length !== 1) continue;
    const tabId = tabs[0];
    if (live.has(tabId)) continue;
    if (members.some((r) => protectedPids.has(r.pid) || isDashboardLooking(r))) continue;

    const sessions = distinct(markers.flatMap((m) => m.sessionIds));
    const group: OrphanGroup = { pgid, members, tabId, sessionId: sessions.length === 1 ? sessions[0] : null };
    const otherLiveServer = markers.some((m) => m.serverPids.some((p) => p !== selfPid && rows.has(p)));
    (otherLiveServer ? paused : candidates).push(group);
  }
  return { candidates, paused };
}
