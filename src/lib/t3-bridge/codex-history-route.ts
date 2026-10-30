/**
 * The chat-history route's Codex branch (plan r5 §4c, W1 criterion 6). Kept out of agent-chat.ts so
 * it can be tested on its own.
 *
 *   - `null`     → not a Codex pane; the Claude path answers.
 *   - `'refuse'` → a Codex thread that is not this project's (foreign, or its owner cannot be
 *                  resolved): the route answers 403, whoever asks (desktop or phone).
 *   - items      → the owned thread's history (an unmapped new pane: none yet).
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatHistoryItem } from '../transcript-history.js';
import { CODEX_THREAD_RE, codexThreadOwnership, findCodexRollout } from './codex-threads.js';
import { parseCodexRolloutHistory } from './codex-history.js';
import type { ToolId } from './registry.js';

export function codexHistoryFor(o: {
  tool: ToolId | null;
  /** The pane id the client asked about. */
  id: string;
  /** What the tab map records for it ('' or the id itself when unmapped). */
  liveId: string;
  contextRoot: string | null;
  codexHome?: string;
}): { items: ChatHistoryItem[] } | 'refuse' | null {
  const candidates = [o.liveId, o.id].filter((c) => c && CODEX_THREAD_RE.test(c));
  const thread = candidates.find((c) => findCodexRollout(c, o.codexHome));
  if (!thread) {
    if (o.tool !== 'codex') return null;
    // A Codex pane whose map names a thread we cannot find: unresolvable, refused. A pane that
    // was never mapped (a new chat, no turn yet) simply has no history.
    return o.liveId && o.liveId !== o.id ? 'refuse' : { items: [] };
  }
  if (!o.contextRoot) return 'refuse';
  if (codexThreadOwnership(thread, dirname(o.contextRoot), o.codexHome) !== 'owned') return 'refuse';
  const rollout = findCodexRollout(thread, o.codexHome);
  if (!rollout) return 'refuse';
  try {
    return { items: parseCodexRolloutHistory(readFileSync(rollout, 'utf-8')) };
  } catch {
    return { items: [] };
  }
}
