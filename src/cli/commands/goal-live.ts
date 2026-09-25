import { Command } from 'commander';
import { existsSync, unlinkSync } from 'node:fs';
import { resolveContextRoot } from '../../lib/context-path.js';
import { error } from '../../lib/format.js';
import {
  AGENT_ROLE_IDS,
  GOAL_FORK_STATES,
  GOAL_LINEAGE_KINDS,
  GOAL_LIVE_PHASES,
  GOAL_VERDICTS,
  applyGoalLiveEvent,
  goalLivePath,
  goalLiveSessionId,
  measureInheritedContext,
  readGoalLive,
  sweepAbandonedGoalLive,
  writeGoalLiveAtomic,
  type GoalForkState,
  type GoalLineageKind,
  type GoalLiveEvent,
  type GoalLivePhase,
  type GoalVerdict,
} from '../../lib/goal-live.js';

/**
 * `dreamcontext goal-live …` — the single writer of a goal-skill run's live file.
 *
 * TWO CONTRACTS the skill relies on, and the reason this command is shaped the way it is:
 *
 *   • SILENT on success. Every call is chained onto a real step (`… && claude -p …`) or sent
 *     alongside a dispatch, so it lands in the chat as part of another row; a success line
 *     would put bookkeeping in front of the user, which is exactly what the chat's quiet
 *     "Updated the quest map" row exists to avoid.
 *   • ALWAYS EXITS 0. Live state is telemetry, not a gate. A write that fails must never
 *     break the `&&` chain it sits in and stop the builder it was describing. Failures are
 *     still printed (`✗ goal-live: …` on stderr), never swallowed.
 */

/** What an action needs from the outside world. Injectable so tests never touch a real vault. */
export interface GoalLiveDeps {
  resolveRoot: () => string | null;
  env: NodeJS.ProcessEnv;
  /** Home directory for the `--context-of` transcript lookup (defaults to the real one). */
  home?: string;
  now: () => Date;
}

const DEFAULT_DEPS: GoalLiveDeps = {
  resolveRoot: () => resolveContextRoot(),
  env: process.env,
  now: () => new Date(),
};

/** Actor ids and names land in a JSON file the UI renders, so they are kept plain and short.
 *  The dashboard's normalizer mirrors this cap (pinned by goal-live-schema-lockstep.test.ts). */
export const ACTOR_ID_MAX = 40;
const ACTOR_ID_RE = new RegExp(`^[A-Za-z0-9._-]{1,${ACTOR_ID_MAX}}$`);
const NAME_MAX = 60;

/** A failed command's reason. Thrown inside an action, printed once by {@link runQuietly}. */
class GoalLiveInputError extends Error {}

function wholeNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new GoalLiveInputError(`${flag} must be a whole number, got "${raw}"`);
  return n;
}

/** Load, fold a batch of events, write once. One read and one write per CLI call, however
 *  many ids the call names. */
function applyEvents(deps: GoalLiveDeps, events: GoalLiveEvent[], opts: { sweep?: boolean } = {}): void {
  const root = deps.resolveRoot();
  if (!root) throw new GoalLiveInputError('no _dream_context/ found from here');
  const now = deps.now();
  if (opts.sweep) sweepAbandonedGoalLive(root, now.getTime());
  const path = goalLivePath(root, goalLiveSessionId(deps.env));
  let state = events[0]?.type === 'start' ? null : readGoalLive(path);
  for (const ev of events) state = applyGoalLiveEvent(state, ev, now.toISOString());
  if (state) writeGoalLiveAtomic(path, state);
}

/** `T1=Role registry,T2=Tokens` → `[{id:'T1', name:'Role registry'}, …]`. Names may not
 *  contain a comma — the list separator. */
export function parseActorSpec(spec: string): Array<{ id: string; name?: string }> {
  const out: Array<{ id: string; name?: string }> = [];
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=');
    const id = (eq === -1 ? part : part.slice(0, eq)).trim();
    const name = eq === -1 ? '' : part.slice(eq + 1).trim().slice(0, NAME_MAX);
    if (!id) continue;
    if (!ACTOR_ID_RE.test(id)) throw new GoalLiveInputError(`actor id "${id}" must be letters, digits, ".", "_" or "-"`);
    out.push(name ? { id, name } : { id });
  }
  if (out.length === 0) throw new GoalLiveInputError('no actor id given');
  return out;
}

/** `critic=NEEDS_WORK T1=done` → state events. Lower-case words are states, upper-case words
 *  are verdicts — case-sensitive on purpose, since `fail` (a builder that failed) and `FAIL`
 *  (a judge's verdict) mean different things. */
export function parseStatePairs(pairs: string[]): Array<Extract<GoalLiveEvent, { type: 'state' }>> {
  if (pairs.length === 0) throw new GoalLiveInputError('no id=word pair given');
  return pairs.map((pair) => {
    const eq = pair.indexOf('=');
    const id = eq === -1 ? '' : pair.slice(0, eq).trim();
    const word = eq === -1 ? '' : pair.slice(eq + 1).trim();
    if (!ACTOR_ID_RE.test(id)) throw new GoalLiveInputError(`"${pair}" is not id=word`);
    if ((GOAL_VERDICTS as readonly string[]).includes(word)) return { type: 'state', id, verdict: word as GoalVerdict };
    if ((GOAL_FORK_STATES as readonly string[]).includes(word)) return { type: 'state', id, state: word as GoalForkState };
    throw new GoalLiveInputError(`"${word}" is not one of ${[...GOAL_FORK_STATES, ...GOAL_VERDICTS].join(', ')}`);
  });
}

export function goalLiveStart(deps: GoalLiveDeps, goal: string | undefined): void {
  const slug = (goal ?? '').trim();
  if (!slug) throw new GoalLiveInputError('start needs --goal <slug>');
  applyEvents(deps, [{ type: 'start', goal: slug, session: goalLiveSessionId(deps.env) }], { sweep: true });
}

export function goalLivePhase(deps: GoalLiveDeps, phase: string, opts: { wave?: string; waves?: string }): void {
  if (!(GOAL_LIVE_PHASES as readonly string[]).includes(phase)) {
    throw new GoalLiveInputError(`phase must be one of ${GOAL_LIVE_PHASES.join(', ')}, got "${phase}"`);
  }
  applyEvents(deps, [{
    type: 'phase',
    phase: phase as GoalLivePhase,
    wave: wholeNumber(opts.wave, '--wave'),
    waves: wholeNumber(opts.waves, '--waves'),
  }]);
}

export interface ActorOptions { kind?: string; role?: string; from?: string; round?: string; contextOf?: string }

export function goalLiveActor(deps: GoalLiveDeps, spec: string, opts: ActorOptions): void {
  const kind = opts.kind ?? '';
  if (!(GOAL_LINEAGE_KINDS as readonly string[]).includes(kind)) {
    throw new GoalLiveInputError(`--kind must be one of ${GOAL_LINEAGE_KINDS.join(', ')}`);
  }
  const actors = parseActorSpec(spec);
  const round = wholeNumber(opts.round, '--round');
  if (opts.from && !ACTOR_ID_RE.test(opts.from)) throw new GoalLiveInputError(`--from "${opts.from}" is not an actor id`);
  // Measured ONCE for the whole call: every fork in one spawn inherits the same source.
  // A non-fork ignores it — a resume or a fresh judge inherits nothing to count.
  const ctx = kind === 'fork' && opts.contextOf ? measureInheritedContext(opts.contextOf, deps.home) : null;
  const events: GoalLiveEvent[] = actors.map(({ id, name }) => {
    const role = opts.role ?? (AGENT_ROLE_IDS.includes(id) ? id : '');
    if (!role) throw new GoalLiveInputError(`actor "${id}" is not a role id, so --role is required`);
    return {
      type: 'actor', id, role, kind: kind as GoalLineageKind,
      ...(opts.from ? { from: opts.from } : {}),
      ...(round != null ? { round } : {}),
      ...(name ? { name } : {}),
      ...(ctx != null ? { ctx } : {}),
    };
  });
  applyEvents(deps, events);
}

export function goalLiveState(deps: GoalLiveDeps, pairs: string[]): void {
  applyEvents(deps, parseStatePairs(pairs));
}

/** Escalation / abort only — a finished run keeps its file so the win and receipt stay up. */
export function goalLiveClear(deps: GoalLiveDeps): void {
  const root = deps.resolveRoot();
  if (!root) throw new GoalLiveInputError('no _dream_context/ found from here');
  const path = goalLivePath(root, goalLiveSessionId(deps.env));
  if (existsSync(path)) unlinkSync(path);
}

/** Run an action under the two contracts above: print a failure, never throw, never exit ≠ 0. */
function runQuietly(action: () => void): void {
  try {
    action();
  } catch (err) {
    error(`goal-live: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function registerGoalLiveCommand(program: Command, deps: GoalLiveDeps = DEFAULT_DEPS): void {
  const cmd = program
    .command('goal-live')
    .description('Write the goal-skill live run file the app draws as a quest map (silent; always exits 0)');

  cmd
    .command('start')
    .description('Begin a run: a fresh live file for this session (sweeps files abandoned for 3h)')
    .option('--goal <slug>', 'The goal or task slug')
    .action((opts: { goal?: string }) => runQuietly(() => goalLiveStart(deps, opts.goal)));

  cmd
    .command('phase')
    .argument('<phase>', GOAL_LIVE_PHASES.join('|'))
    .option('--wave <n>', 'Current implementation wave')
    .option('--waves <n>', 'Total implementation waves')
    .description('Record a phase transition')
    .action((phase: string, opts: { wave?: string; waves?: string }) => runQuietly(() => goalLivePhase(deps, phase, opts)));

  cmd
    .command('actor')
    .argument('<ids>', 'Comma-separated id[=name] list, e.g. "T1=Role registry,T2=Tokens"')
    .option('--kind <kind>', GOAL_LINEAGE_KINDS.join('|'))
    .option('--role <role>', 'Agent role (defaults to the id when the id is a role, e.g. critic)')
    .option('--from <id>', 'The actor this one came from (a fork\'s source)')
    .option('--round <n>', 'Round number')
    .option('--context-of <sessionId>', 'Measure the context a fork inherits from this session')
    .description('Record agents joining the run: briefed, copied, brought back or called fresh')
    .action((ids: string, opts: ActorOptions) => runQuietly(() => goalLiveActor(deps, ids, opts)));

  cmd
    .command('state')
    .argument('<pairs...>', 'id=word, word one of run|done|wait|fail|SOLID|NEEDS_WORK|PASS|FAIL')
    .description('Update agents\' states or verdicts')
    .action((pairs: string[]) => runQuietly(() => goalLiveState(deps, pairs)));

  cmd
    .command('clear')
    .description('Remove this session\'s live file (escalation or abort only)')
    .action(() => runQuietly(() => goalLiveClear(deps)));
}
