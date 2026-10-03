import { findRegisteredActor } from './goal-live.js';

/**
 * Who started this claude session: a human, or dreamcontext / an orchestrator?
 *
 * Sleep debt paces how often the human-facing agent asks to consolidate. A session the app or
 * an orchestrator spawned (a Develop or goal-skill builder, an automation run, background
 * sleep, a peer or lab run, a nested `claude -p`) is recorded for task linkage but carries NO
 * debt, gets no auto-bookmarks and receives no sleep directive. Its work is already carried by
 * its orchestrator's session, the task log and git; counting it again multiplied one run's
 * debt by the number of builders it launched.
 *
 * No transcript property tells the two apart: human Chat sessions and `claude -p` builders are
 * both `entrypoint: sdk-cli`, `promptSource: sdk`. So the marker comes from four sources, first
 * match wins:
 *
 * 1. Env the app already sets on its own spawns: `DREAMCONTEXT_AUTO_SLEEP=1` (background sleep)
 *    and `DREAMCONTEXT_AUTOMATION_RUN` (every automation run).
 * 2. `DREAMCONTEXT_SPAWNED=<by>`, set by the Develop recipe, peer delivery and lab commentary.
 *    Load-bearing for Develop: the recipe registers a builder AFTER spawning it, so at the
 *    builder's SessionStart the registration below may not exist yet.
 * 3. Goal-live registration (`goal-live actor … --session <uuid>`). Goal-skill registers BEFORE
 *    it spawns, so this catches its builders and planners from their first SessionStart. A
 *    Develop lead is never a registered actor: its id only ever lands in the run's `session`.
 * 4. Process ancestry: two or more `claude` commands above the hook before the dashboard
 *    server's pid. Covers council personas (background Bash calls stay descendants of their
 *    orchestrator) and ad-hoc synchronous `claude -p`, including children of pinned panes. The
 *    server stamps its own pid into its env at boot (`prepareDashboardEnv`), so every pane
 *    inherits the boundary and a human pane's own claude never reads as nested.
 *
 * Scoped out: a nohup'd, unregistered, env-less ad-hoc `claude -p` scores as its own session.
 *
 * The `known` fast path (SessionStart, UserPromptSubmit) trusts the stored ledger record and
 * skips sources 3 and 4. Records written before the marker existed carry no `spawn`, so the fast
 * path reads them as human; the Stop hook never passes `known` and stays authoritative.
 */

export const SPAWNED_ENV = 'DREAMCONTEXT_SPAWNED' as const;

export type SpawnBy = 'develop' | 'goal-skill' | 'automation' | 'auto-sleep' | 'peer' | 'lab' | 'nested' | 'other';
export type SpawnVia = 'env' | 'goal-live' | 'ancestry';

export interface SpawnMarker {
  by: SpawnBy;
  via: SpawnVia;
}

/** Every env key that marks a process as spawned. Scrubbed from the dashboard server's env so no
 *  pane it launches can inherit a leaked marker and silently zero a human's debt. */
export const SPAWN_ENV_KEYS: readonly string[] = [
  SPAWNED_ENV,
  'DREAMCONTEXT_AUTOMATION_RUN',
  'DREAMCONTEXT_AUTOMATION_SLUG',
  'DREAMCONTEXT_AUTO_SLEEP',
];

/** `DREAMCONTEXT_SPAWNED` values kept as-is; any other non-empty value reads as `other`. */
const NAMED_SPAWNERS: ReadonlySet<SpawnBy> = new Set<SpawnBy>(['develop', 'goal-skill', 'peer', 'lab']);

/** Sources 1 and 2: the env the spawning process set. Null when nothing marks this process. */
export function spawnMarkerFromEnv(env: NodeJS.ProcessEnv): SpawnMarker | null {
  if (env.DREAMCONTEXT_AUTO_SLEEP === '1') return { by: 'auto-sleep', via: 'env' };
  if ((env.DREAMCONTEXT_AUTOMATION_RUN ?? '').trim()) return { by: 'automation', via: 'env' };
  const spawned = (env[SPAWNED_ENV] ?? '').trim();
  if (!spawned) return null;
  return { by: NAMED_SPAWNERS.has(spawned as SpawnBy) ? (spawned as SpawnBy) : 'other', via: 'env' };
}

/** Delete every spawn marker from `env`, in place. */
export function scrubSpawnEnv(env: NodeJS.ProcessEnv): void {
  for (const key of SPAWN_ENV_KEYS) delete env[key];
}

/**
 * Called first thing by the dashboard server. Scrubs spawn markers (a server launched from a
 * spawned context must not pass one to a human pane) and stamps the server's own pid as the
 * ancestry boundary, so unpinned panes, which get no per-tab env, still bound the walk.
 *
 * Also drops the launcher's conversation and tab ids (a hook-launched server inherits them):
 * every child would otherwise carry that tab's id, and the orphan sweep reads the tab id as the
 * owner of a leftover process. Deleted inline, not via SPAWN_ENV_KEYS — that list is the
 * spawn-marker contract and the test isolation setup depends on it.
 */
export function prepareDashboardEnv(env: NodeJS.ProcessEnv, serverPid: number): void {
  scrubSpawnEnv(env);
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.DREAMCONTEXT_TAB_SESSION;
  env.DREAMCONTEXT_SERVER_PID = String(serverPid);
}

export interface PsRow {
  ppid: number;
  command: string;
}

/** Parse `ps -axo pid=,ppid=,command=` output into a pid-keyed table. Unparseable lines are skipped. */
export function parsePsTable(psOutput: string): Map<number, PsRow> {
  const table = new Map<number, PsRow>();
  for (const line of psOutput.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
  }
  return table;
}

/** `claude` as a command word (bare or path tail), never a path fragment like `~/.claude/…`. */
export const CLAUDE_COMMAND_RE =/(^|[\s/])claude($|\s)/;

/**
 * Walk up from `startPid` (the hook's parent) counting claude-like commands. The hook's own
 * claude is the nearest one; any additional claude before the walk leaves the tab means this
 * claude is nested inside another. The walk stops at `serverPid`: everything above the dashboard
 * server (e.g. a dev server started from a Claude Code session) is outside the pane.
 */
export function isNestedInProcessTable(
  table: Map<number, PsRow>,
  startPid: number,
  serverPid: number | null,
  maxHops = 15,
): boolean {
  let pid = startPid;
  let claudes = 0;
  for (let hop = 0; hop < maxHops && pid > 1; hop++) {
    if (serverPid && pid === serverPid) break;
    const row = table.get(pid);
    if (!row) break;
    if (CLAUDE_COMMAND_RE.test(row.command)) claudes++;
    if (claudes >= 2) return true;
    pid = row.ppid;
  }
  return false;
}

export interface ResolveSpawnInput {
  env: NodeJS.ProcessEnv;
  contextRoot: string | null;
  sessionId: string | null;
  /** The ancestry walk. Called at most once, and only when every cheaper source missed. */
  isNested: () => boolean;
  /** The stored ledger record for this session, when one exists (never passed by Stop). */
  known?: { spawn?: SpawnMarker };
}

/** Resolve this session's spawn marker: env, then the stored record, then goal-live, then ancestry. */
export function resolveSpawnMarker(input: ResolveSpawnInput): SpawnMarker | null {
  const fromEnv = spawnMarkerFromEnv(input.env);
  if (fromEnv) return fromEnv;
  if (input.known) return input.known.spawn ?? null;
  if (input.contextRoot && input.sessionId) {
    const actor = findRegisteredActor(input.contextRoot, input.sessionId);
    if (actor) return { by: actor.mode === 'develop' ? 'develop' : 'goal-skill', via: 'goal-live' };
  }
  return input.isNested() ? { by: 'nested', via: 'ancestry' } : null;
}
