import {
  TEAMMATE_TASK_TYPE, headlessSessionIdOf, isHeadlessAgentShell, type CommandProbe, type SubAgentRun,
} from './chatEntities';
import { actionText, toolAction } from './toolAction';

/**
 * Headless teammates: `claude -p` runs this conversation started, read off their OWN
 * transcripts by `GET /api/agent/teammates` and folded into the party cards as members.
 *
 * Two ways a run becomes one, and both end in the same `SubAgentRun` with a `session`:
 *   • the CLI tracked it (a backgrounded `claude -p --session-id X`): the tracked run is kept,
 *     for its lifecycle frames, and ENRICHED with the brief, steps and report its transcript has;
 *   • nothing tracked it (launched detached, wrapped in a script, or by a session that has since
 *     ended): the run is built from the transcript summary alone, and anchored to the call that
 *     named its id, so its card lands where it was started.
 */

/** The wire shape of one teammate (`src/server/routes/agent-teammates.ts`'s `TeammateWire`). */
export interface TeammateWire {
  session: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  missing?: boolean;
  brief?: string;
  startedAt?: number;
  endedAt?: number;
  updatedAt?: number;
  result?: string;
  steps: Array<{ toolUseId: string; name: string; input?: unknown; status: 'running' | 'done' | 'error' }>;
  toolUses: number;
  durationMs?: number;
  model?: string;
  actor?: string;
  role?: string;
  kind?: string;
  name?: string;
  from?: string;
  registeredAt?: string;
  wave?: number;
  round?: number;
}

export interface TeammatesResponse { teammates: TeammateWire[] }

const RUN_STATUS: Readonly<Record<TeammateWire['status'], SubAgentRun['status']>> = {
  running: 'running', done: 'completed', failed: 'error', stopped: 'stopped',
};

const UUID_IN_TEXT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function commandOf(item: CommandProbe): string | undefined {
  if (item.kind !== 'tool' || item.name !== 'Bash' || !item.input || typeof item.input !== 'object') return undefined;
  const cmd = (item.input as Record<string, unknown>).command;
  return typeof cmd === 'string' ? cmd : undefined;
}

/** Every id this conversation started a headless `claude` with (`--session-id`), oldest first.
 *  What the client may ask the server to confirm as LAUNCHED; the server checks it itself. */
export function launchedSessionIds(entries: readonly CommandProbe[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const id = headlessSessionIdOf(commandOf(e));
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(-12);
}

/** The tool call a teammate's card anchors to: the FIRST Bash call whose command names its id
 *  (its launch, or its `goal-live actor --session` registration). First, because later calls
 *  name it too: a `--resume` of it, or a fork's `--context-of` measuring it. */
export function anchorsBySession(entries: readonly CommandProbe[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    const cmd = commandOf(e);
    if (!cmd || !e.toolUseId) continue;
    for (const m of cmd.toLowerCase().matchAll(UUID_IN_TEXT_RE)) if (!out.has(m[0])) out.set(m[0], e.toolUseId);
  }
  return out;
}

/** What it is on right now, in the team log's own words. */
function doingOf(t: TeammateWire): string | undefined {
  const step = [...t.steps].reverse().find((s) => s.status === 'running') ?? t.steps[t.steps.length - 1];
  return step ? actionText(toolAction(step.name, step.input, step.status === 'running' ? 'running' : 'done')) : undefined;
}

/** A card's line for a teammate: its registered name, else the first line of its brief. */
function nameOf(t: TeammateWire): string {
  if (t.name) return t.name;
  const first = t.brief?.split('\n').find((l) => l.trim())?.trim() ?? '';
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/** The fields a transcript adds to any run, tracked or not. */
function transcriptFields(t: TeammateWire): Partial<SubAgentRun> {
  return {
    session: t.session,
    ...(t.role ? { role: t.role } : {}),
    ...(t.kind ? { joined: t.kind } : {}),
    ...(t.brief ? { prompt: t.brief } : {}),
    ...(t.result ? { report: t.result } : {}),
    ...(t.model ? { model: t.model } : {}),
    ...(t.wave ? { wave: t.wave } : {}),
    ...(t.round ? { round: t.round } : {}),
    ...(doingOf(t) ? { activity: doingOf(t) } : {}),
    usage: { toolUses: t.toolUses, ...(t.durationMs != null ? { durationMs: t.durationMs } : {}) },
  };
}

/** A teammate no `task_*` frame ever named, as a run the party card can hold. */
export function teammateRun(t: TeammateWire, anchorToolUseId: string | undefined, nowMs: number): SubAgentRun {
  const registered = t.registeredAt ? Date.parse(t.registeredAt) : NaN;
  const startedAt = t.startedAt ?? (Number.isFinite(registered) ? registered : nowMs);
  const status = RUN_STATUS[t.status];
  return {
    taskId: `teammate:${t.session}`,
    ...(anchorToolUseId ? { toolUseId: anchorToolUseId } : {}),
    name: nameOf(t),
    taskType: TEAMMATE_TASK_TYPE,
    status,
    startedAt,
    ...(status !== 'running' ? { endedAt: t.endedAt ?? t.updatedAt ?? nowMs } : {}),
    ...transcriptFields(t),
  };
}

/**
 * The conversation's runs with its teammates folded in: a tracked headless run whose command
 * carries a teammate's id is enriched in place (its lifecycle stays the CLI's, which watched
 * the process), and every other teammate joins as a run of its own.
 */
export function withTeammates(
  runs: readonly SubAgentRun[], teammates: readonly TeammateWire[], anchors: ReadonlyMap<string, string>, nowMs: number,
): SubAgentRun[] {
  if (teammates.length === 0) return runs as SubAgentRun[];
  const bySession = new Map(teammates.map((t) => [t.session, t]));
  const claimed = new Set<string>();
  const merged = runs.map((run) => {
    if (!isHeadlessAgentShell(run)) return run;
    const id = headlessSessionIdOf(run.command ?? run.name);
    const t = id ? bySession.get(id) : undefined;
    if (!t) return run;
    claimed.add(t.session);
    return { ...run, ...transcriptFields(t), activity: run.status === 'running' ? doingOf(t) ?? run.activity : run.activity };
  });
  for (const t of teammates) {
    if (claimed.has(t.session)) continue;
    merged.push(teammateRun(t, anchors.get(t.session), nowMs));
  }
  return merged;
}

/** Where a run's own conversation is read from: a teammate's transcript, or a dispatched
 *  sub-agent's sidechain under the parent conversation. */
export function runHistoryPath(run: SubAgentRun, conversationId: string): string {
  return run.session
    ? `/agent/teammate-history?claudeId=${encodeURIComponent(conversationId)}&session=${encodeURIComponent(run.session)}&launched=1`
    : `/agent/chat-history?claudeId=${encodeURIComponent(conversationId)}&subagent=${encodeURIComponent(run.taskId)}`;
}
