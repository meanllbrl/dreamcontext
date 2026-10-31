/**
 * An agent's `read_tools:`: the literal MCP tools a light job of it may call (`automations/
 * light-run.ts`). A leaf: the agent store reads it, and the envelope filters through it again.
 */

const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+?__([A-Za-z0-9_-]+)$/;
/** A word no read tool's name holds: the owner's typo must not open a send tool. */
const MUTATING_WORDS: ReadonlySet<string> = new Set([
  'send', 'post', 'put', 'patch', 'edit', 'update', 'upsert', 'write', 'create', 'add', 'insert',
  'delete', 'remove', 'drop', 'clear', 'set', 'reply', 'forward', 'publish', 'deploy', 'run',
  'exec', 'execute', 'trigger', 'cancel', 'refund', 'pay', 'charge', 'merge', 'push', 'move',
  'rename', 'archive', 'approve', 'invite', 'download', 'upload',
]);

const MAX_READ_TOOLS = 40;

/** Whether a `read_tools:` entry opens: one literal MCP tool, no wildcard, no whole server, no
 *  built-in, and no mutating word in its name. */
export function isReadToolName(name: string): boolean {
  const m = MCP_TOOL_RE.exec(name);
  if (!m) return false;
  const words = m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_-]+/);
  return !words.some((w) => MUTATING_WORDS.has(w));
}

/** The entries of a `read_tools:` value that may open, deduped; anything else is dropped (closed). */
export function readToolsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(isReadToolName);
  return [...new Set(names)].slice(0, MAX_READ_TOOLS);
}
