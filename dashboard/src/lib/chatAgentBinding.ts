/**
 * Which automation agent a Chat conversation speaks as (the composer's agent picker).
 *
 * Keyed by the conversation's UUID (`claudeId`), not by the tab: every respawn in the surface
 * (Resume, a mode, permission or account switch, the auth restart) swaps the tab's session
 * object but keeps the conversation, so `createChatSession` reads the binding here and each of
 * those paths carries the agent without being told. A relaunch rebuilds it from the saved
 * roster's `agent` before the first spawn (AgentSurface's hydrate).
 *
 * The server decides everything else from the slug at every spawn (approval, scope, briefing:
 * `prepareAgentChat` in src/lib/whiteboards/card-chat.ts); this map only remembers the name.
 */

const bindings = new Map<string, string>();

/** Bind `claudeId` to `agent`, or unbind it with `''`. */
export function bindChatAgent(claudeId: string, agent: string): void {
  if (agent) bindings.set(claudeId, agent);
  else bindings.delete(claudeId);
}

/** The agent `claudeId` speaks as, or `''` for plain Claude. */
export function chatAgentFor(claudeId: string): string {
  return bindings.get(claudeId) ?? '';
}
