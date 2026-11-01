/**
 * The CLI's agent guard for owner RICE values: an agent never overwrites an
 * owner score. From an agent session (CLAUDE_CODE_SESSION_ID set), a command
 * that would change a RICE field already holding a value — or clear values —
 * is refused unless --owner says the owner asked for it in the conversation.
 * Proposals go through `tasks suggest` / `roadmap objective suggest` instead.
 *
 * This guard only sees that one variable: it protects against an agent
 * forgetting the rule, not against a determined caller.
 */

type RiceLike = { reach?: number | null; impact?: number | null; confidence?: number | null; effort?: number | null } | null | undefined;

export function isAgentSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.CLAUDE_CODE_SESSION_ID === 'string' && env.CLAUDE_CODE_SESSION_ID.trim() !== '';
}

export function agentGuardRefuses(
  existing: RiceLike,
  flags: { reach?: unknown; impact?: unknown; confidence?: unknown; effort?: unknown },
  clearing: boolean,
  owner: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (owner || !isAgentSession(env) || !existing) return false;
  const held = (k: 'reach' | 'impact' | 'confidence' | 'effort'): boolean =>
    existing[k] !== null && existing[k] !== undefined;
  if (clearing) return (['reach', 'impact', 'confidence', 'effort'] as const).some(held);
  return (['reach', 'impact', 'confidence', 'effort'] as const).some((k) => flags[k] !== undefined && held(k));
}
