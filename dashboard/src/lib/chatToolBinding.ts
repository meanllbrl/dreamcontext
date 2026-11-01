/**
 * Which tool a Chat conversation runs on when it is not Claude (Track T: Codex through the T3
 * bridge). Keyed by the conversation's UUID like `chatAgentBinding.ts`, for the same reason: every
 * respawn (Resume, a mode or permission switch, a reconnect) swaps the tab's session object but
 * keeps the conversation, so `createChatSession` reads the tool here and each path carries it.
 * A relaunch rebuilds it from the saved roster's `tool` before the first spawn.
 */
export type ChatTool = '' | 'codex';

const bindings = new Map<string, Exclude<ChatTool, ''>>();

/** Bind `claudeId` to `tool`, or back to Claude with `''`. */
export function bindChatTool(claudeId: string, tool: ChatTool): void {
  if (tool) bindings.set(claudeId, tool);
  else bindings.delete(claudeId);
}

/** The tool `claudeId` runs on, or `''` for Claude. */
export function chatToolFor(claudeId: string): ChatTool {
  return bindings.get(claudeId) ?? '';
}

/** The `&tool=` URL part for `claudeId` ('' for Claude, so a Claude URL stays byte-identical). */
export function chatToolParam(claudeId: string): string {
  const tool = chatToolFor(claudeId);
  return tool ? `&tool=${tool}` : '';
}

/** Instance-bus event: open a NEW chat on `tool`, from a surface that cannot switch its own
 *  (the Super Agent, an agent-bound chat). AgentSurface owns the tabs, so it answers. */
export const OPEN_TOOL_CHAT_EVENT = 'dreamcontext-open-tool-chat';
export interface OpenToolChatDetail { tool: 'codex' }
