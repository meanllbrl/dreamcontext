import { preparePrompt } from './agentPrompt';
import { requestDelegateAgent } from './delegateAgent';

/**
 * "Author a task with an agent" — the twin of the delegate flow. Where delegating hands an
 * EXISTING task to a background agent, this hands a rough IDEA to an agent whose whole job is
 * to interview you for the gaps and write a properly-speced task via `dreamcontext tasks
 * create`. Both ride the exact same rail: `preparePrompt` (transport routing) →
 * `requestDelegateAgent` (the `dreamcontext-delegate-agent` window event the always-mounted
 * `AgentSurface` listens for → spawns MINIMIZED). See {@link ../delegateAgent} for the rail.
 *
 * The agent already KNOWS the task conventions: the project's `dreamcontext` skill is loaded
 * into every in-app claude session by the SessionStart hook, so the seed prompt below does not
 * re-teach the task schema — it just points the agent at the job and tells it to interview for
 * anything missing.
 */

/** The tab title for an authoring session (also the corner-chip label). */
export const AUTHOR_TASK_TITLE = 'Author a task';

/** Optional starting hints the user set in the composer — woven into the seed prompt so the
 *  created task lands in the right column / at the right priority. Empty strings are omitted. */
export interface AuthorTaskHints {
  /** Target board status/column, e.g. `todo` / `in_progress` — maps to `tasks create --status`. */
  status?: string;
  /** Target priority, e.g. `high` — maps to `tasks create --priority`. */
  priority?: string;
}

/**
 * Build the task-authoring seed prompt from the user's rough idea + optional hints.
 *
 * Deliberately structured for the human reviewing it in the composer; the SERVER collapses
 * newlines to spaces before it reaches claude's readline (see `sanitizePrompt` in
 * agent-terminal.ts), so claude receives one message. It does NOT restate the task schema —
 * the loaded `dreamcontext` skill owns that — it names the JOB (interview → create → fill the
 * body to conventions → doctor) and the required task sections so the agent aims for a
 * fully-speced task, not a thin stub.
 */
export function buildAuthorPrompt(idea: string, hints: AuthorTaskHints = {}): string {
  const parts: string[] = [
    'You are authoring a NEW dreamcontext task from a rough idea. The project\'s `dreamcontext` '
    + 'skill is loaded (SessionStart), so follow its task conventions exactly — do not re-invent them.',
    `\nMy rough idea:\n${idea.trim()}`,
  ];

  const hintLines: string[] = [];
  if (hints.status?.trim()) hintLines.push(`- Put it in the "${hints.status.trim()}" column (\`--status ${hints.status.trim()}\`).`);
  if (hints.priority?.trim()) hintLines.push(`- Priority "${hints.priority.trim()}" (\`--priority ${hints.priority.trim()}\`).`);
  if (hintLines.length) parts.push(`\nStarting hints:\n${hintLines.join('\n')}`);

  parts.push(
    '\nDo this:'
    + '\n1. If anything essential is missing — the real Why, testable acceptance criteria, or the affected '
    + 'files — ask me a few sharp follow-up questions FIRST. Interview me for exactly what you need; don\'t interrogate.'
    + '\n2. Create the task with `dreamcontext tasks create "<title>" ...`, setting the flags we agreed on.'
    + '\n3. Fill the task body to the project\'s conventions: a real **Why**, testable **Acceptance Criteria** '
    + '(A1, A2, …), a **Workflow** mermaid that mirrors those criteria, and **Technical Details** (file-by-file where you can).'
    + '\n4. Run `dreamcontext tasks doctor` and fix anything it flags.'
    + '\n5. When it\'s done, reply with the new task\'s slug and a one-line summary. The board picks it up automatically.',
  );
  return parts.join('\n');
}

/**
 * Prepare + dispatch the authoring request in one step: route the seed prompt to a transport
 * that can carry it, then ask the always-mounted surface to spawn a MINIMIZED authoring agent.
 * Throws if the prompt can't be handed over (see `preparePrompt`); resolves to the surface's
 * ACK otherwise (false → no surface / prereqs missing, so the composer shows a real error
 * instead of an optimistic "started ✓").
 *
 * Bypass defaults to the caller's choice; authoring is low-risk (it writes a task file), so the
 * composer arms it ON by default — the agent can run `tasks create` / `tasks doctor` without an
 * approval prompt per command, while still interviewing you for the content.
 */
export async function authorTaskWithAgent(
  args: { idea: string; hints?: AuthorTaskHints; bypass: boolean },
): Promise<boolean> {
  const prompt = buildAuthorPrompt(args.idea, args.hints);
  const { inline, token } = await preparePrompt(prompt);
  return requestDelegateAgent({
    title: AUTHOR_TASK_TITLE, prompt: inline, promptToken: token, bypass: args.bypass,
    // reveal:false — start minimized (A3). It surfaces as a corner chip; click it to answer
    // the agent's interview questions, and the chip raises an attention badge when it's done.
    reveal: false,
  });
}
