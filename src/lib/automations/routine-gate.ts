import { questionPath, readQuestion, writeQuestion } from './hitl.js';
import { cadenceLabel, getAutomation } from './store.js';
import { appendThreadEntry, readThreadRun } from './threads.js';
import { AGENT_SELF_ENV, type AutomationManifest, type AutomationQuestion } from './types.js';

/**
 * "It never sets up a routine without asking", made mechanical (AI Team).
 *
 * An agent the owner is talking to may offer a scheduled routine, but a routine is a new
 * unattended bypassPermissions job approved on this machine the moment it is created, so the
 * agent's own judgement that the owner "clearly wanted it" is not enough. Inside a run,
 * `automations create` therefore needs `--answer <question id>` naming a routine proposal this
 * run's agent made (`propose --routine`) that the owner answered with its FIRST choice, and that
 * has not set up a routine already. Free text, another choice, another agent's question or an
 * unanswered one: refused, with the reason.
 *
 * "Inside a run" is `DREAMCONTEXT_AUTOMATION_RUN` in the environment, which the runner sets on
 * every spawn (a fresh run, a reply, and an answer's resume). Unset is a person at a terminal,
 * who needs no proof of their own consent.
 */

const RUN_ENV = 'DREAMCONTEXT_AUTOMATION_RUN';
const SLUG_ENV = 'DREAMCONTEXT_AUTOMATION_SLUG';

export type RoutineGate =
  | { ok: true; question: AutomationQuestion | null; runSlug: string | null }
  | { ok: false; reason: string };

/** Is the owner in this turn: does the run the env names hold something they typed? A turn
 *  started by a message (an ask, a reply) does; a scheduled fire does not. */
export function ownerInTurn(contextRoot: string, slug: string, runId: string | undefined): boolean {
  if (!runId) return false;
  try {
    return readThreadRun(contextRoot, slug, runId).some((e) => e.kind === 'user');
  } catch {
    return false;
  }
}

export function checkRoutineCreate(
  contextRoot: string,
  input: { agent?: string; answer?: string },
  env: NodeJS.ProcessEnv = process.env,
): RoutineGate {
  const inRun = env[RUN_ENV] !== undefined;
  const answerId = input.answer?.trim() ?? '';
  if (!inRun && !answerId) return { ok: true, question: null, runSlug: null };

  const runSlug = (env[SLUG_ENV] ?? '').trim() || (input.agent ?? '').trim();
  if (!runSlug) return { ok: false, reason: 'This run does not know its own slug, so it cannot set up a routine.' };
  const self = getAutomation(contextRoot, runSlug)?.agent ?? runSlug;
  const asAgent = (input.agent ?? '').trim();
  const selfEnv = env[AGENT_SELF_ENV];

  if (inRun && !answerId) {
    return {
      ok: false,
      reason:
        'A run sets up a routine only after the owner says yes. Propose it with ' +
        `\`dreamcontext automations propose ${runSlug} --routine --title … --body … --choice "Set it up" --choice "Change it"\`, ` +
        'stop, and create it with --answer <question id> once they press the first choice.',
    };
  }
  if (asAgent !== self || (selfEnv !== undefined && selfEnv !== self)) {
    return { ok: false, reason: `A run sets up routines only for its own agent: pass --agent ${self}.` };
  }

  let q: AutomationQuestion | null;
  try {
    q = readQuestion(questionPath(contextRoot, runSlug, answerId));
  } catch {
    q = null;
  }
  if (!q || q.slug !== runSlug) {
    return { ok: false, reason: `There is no question "${answerId}" from ${runSlug}. Name the routine proposal the owner answered.` };
  }
  if (q.kind !== 'flow-hitl' || q.proposes !== 'routine') {
    return { ok: false, reason: `"${answerId}" is not a routine proposal. Propose the routine with \`propose --routine\` first.` };
  }
  if (q.state !== 'answered') {
    return { ok: false, reason: `The owner has not answered "${answerId}" yet. Wait for their answer.` };
  }
  if (q.choices.length === 0 || q.answer !== q.choices[0]) {
    return {
      ok: false,
      reason: `The owner answered "${q.answer ?? ''}", not "${q.choices[0] ?? 'the first choice'}". Nothing is set up: change the proposal or drop it.`,
    };
  }
  if (q.routine) {
    return { ok: false, reason: `"${answerId}" already set up the routine "${q.routine}". One answer sets up one routine.` };
  }
  return { ok: true, question: q, runSlug };
}

/**
 * After a gated create: the question remembers what it set up (so it cannot set up a second),
 * and the conversation gets one "Routine created" line in the run that proposed it.
 * Best-effort, like every thread write on a run path: the routine exists either way.
 */
export function recordRoutineCreated(
  contextRoot: string,
  gate: Extract<RoutineGate, { ok: true }>,
  created: Pick<AutomationManifest, 'slug' | 'title' | 'mode' | 'schedule' | 'scheduleError'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!gate.question || !gate.runSlug) return;
  try {
    writeQuestion(contextRoot, { ...gate.question, routine: created.slug });
  } catch {
    // the routine is created; a question that cannot be stamped is only a missed replay guard
  }
  const runId = env[RUN_ENV] || gate.question.runFiredAt;
  try {
    appendThreadEntry(contextRoot, gate.runSlug, {
      runId,
      kind: 'system',
      event: 'routine',
      text: `Routine created · ${created.title} · ${cadenceLabel(created)}`,
      via: 'cli',
    });
  } catch {
    // a thread that cannot be written does not undo the routine
  }
}
