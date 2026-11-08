import { preparePrompt } from './agentPrompt';
import { requestDelegateAgent } from './delegateAgent';

/**
 * "✦ Score N" on the Roadmap: hand the scoring work to a background agent, on the
 * same rail as authoring a task (lib/authorTaskAgent.ts): `preparePrompt` →
 * `requestDelegateAgent` (the always-mounted surface spawns it MINIMIZED and ACKs).
 *
 * The agent writes SUGGESTIONS only (`tasks suggest`, `roadmap objective suggest`);
 * the owner accepts, edits or dismisses each one on the board. The loaded
 * `dreamcontext` skill carries the rules; this prompt names the job and the commands.
 */

export const SCORE_AGENT_TITLE = 'Score the roadmap';

export function buildScorePrompt(count: number): string {
  return [
    `Score the roadmap: ${count} item(s) need RICE values or an objective link.`,
    'You SUGGEST, the owner decides. Never edit owner values: never run `tasks rice`, `tasks objectives`, or `roadmap objective edit` for this.',
    '1. Run `dreamcontext roadmap unscored --json` and read every item and the live objectives.',
    '2. For each task: read it (`dreamcontext tasks show <slug>`), then `dreamcontext tasks suggest <slug>` with exactly its `missing` RICE fields (--reach 1-10, --impact 1-5, --confidence 25|50|75|100, --effort weeks), plus `--objective <slug>` or `--no-objective` when `needs_link` is true, and `--why "<one sentence>"`.',
    '3. For each objective: `dreamcontext roadmap objective suggest <slug>` with its missing fields and --why.',
    '4. A refusal (owner_scored, owner_linked, dismissed) means the owner already decided: skip that item.',
    '5. When done, run `dreamcontext roadmap unscored --done` and reply with one line: how many suggestions you left.',
  ].join('\n');
}

/**
 * Prepare + dispatch. Throws if the prompt cannot be handed over; resolves to the
 * surface's ACK (false = no surface / prerequisites missing: an error, never optimistic).
 */
export async function scoreWithAgent(bus: EventTarget, vault: string | null, count: number): Promise<boolean> {
  const { inline, token } = await preparePrompt(vault, buildScorePrompt(count));
  return requestDelegateAgent(bus, {
    title: SCORE_AGENT_TITLE,
    prompt: inline,
    promptToken: token,
    bypass: true,
    reveal: false,
  });
}
