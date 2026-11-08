import type { SessionStatusInfo } from './agentStatus';

/**
 * One open tab of a project, as the device shell's chat rows read it (`openRows`, `homeRows`):
 * its pane, title, state and the conversation it holds, so a Mac chat this phone already holds is
 * never listed twice.
 */
export interface StackTab {
  id: string;
  paneId: string;
  title: string;
  info: SessionStatusInfo;
  /** The conversation this tab holds, once known (the live session's). */
  claudeId?: string;
  /** The roster's id for it, when that differs (a dormant tab, or a pin the server replaced):
   *  either one means "held here", so neither is stacked again as a Mac chat. */
  altClaudeId?: string;
  attention: boolean;
}

/** Every conversation id a tab holds, live or roster. */
export function heldIds(tabs: readonly StackTab[]): string[] {
  return tabs.flatMap((t) => [t.claudeId, t.altClaudeId]).filter((x): x is string => !!x);
}
