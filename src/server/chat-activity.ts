import { activityOf, listChats } from '../lib/assistant/chat-registry.js';
import { liveChatsSnapshot } from './routes/agent-chat-live.js';

/**
 * Is any in-app chat mid-turn right now? The desktop self-update and its relaunch wait while
 * one is: an upgrade rewrites the CLI and every project's hooks under a running turn, and the
 * relaunch quits the app, which ends every chat process. A turn is busy when the live child
 * says so (a pinned chat's own turn edge, or a child still draining), or when the chat registry
 * reads it as working, starting, asking or silent mid-turn (the subject is asked, not its
 * record; src/lib/super/live.ts reads it the same way).
 */
export function anyChatBusy(now: number = Date.now()): boolean {
  if (liveChatsSnapshot().some((e) => e.busy)) return true;
  return listChats().some((e) => {
    const a = activityOf(e, now);
    return a === 'working' || a === 'starting' || a === 'asking' || a === 'stale';
  });
}
