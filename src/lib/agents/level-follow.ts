/**
 * A live agent chat follows its member's autonomy level (owner 2026-11-10: "the label can never
 * lie"). The permission mode is argv, fixed for a process's life, so a chat whose level changed
 * respawns in place with `--resume` (agent-chat.ts). Every write path reaches the chat one of two
 * ways: a route of this server says so here at once, and every other writer (the CLI, a synced
 * pull, another process approving) is caught by the chat's own watch on the agent's file and the
 * approvals store. Both call the chat's ONE check, which re-reads the level in force.
 */
type Listener = (contextRoot: string, slug: string) => void;

const listeners = new Set<Listener>();

/** Register a live chat's check; returns its removal. */
export function onAgentLevel(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Told after a route of this server wrote an agent or an approval (any field: the chat re-reads). */
export function notifyAgentLevel(contextRoot: string, slug: string): void {
  for (const fn of [...listeners]) {
    try { fn(contextRoot, slug); } catch { /* one chat's failure is its own */ }
  }
}
