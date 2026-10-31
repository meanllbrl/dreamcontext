/**
 * The Eco-mode and resume joins on the bridge side (plan r5 §4d). Claude gets these from its
 * hooks; a bridge tool has no hooks, so the bridge child calls the same library functions:
 *
 *   - measurement: after every `result`, `maybeNudge` with the context Codex reported
 *     (`usedTokens`), on the same ladder and thresholds (`resolveHandoffFor`); a nudge rides the
 *     next turn as untrusted app context.
 *   - rotation: `/clear` opened a fresh thread; like SessionStart(`source=clear`), the pane's
 *     handoff record is read, its banner handed to the next turn, and `consumedAt` stamped.
 *   - resume: the pane's live thread id goes into the same tab → conversation map the hooks keep,
 *     so a reopened pane finds its thread.
 */
import { join } from 'node:path';
import { recordAgentSession } from '../agent-session-map.js';
import { findCodexRollout } from './codex-threads.js';
import { maybeNudge, renderHandoffBanner, selectHandoffForSessionStart, stampHandoffRecord } from '../context-watch.js';
import type { AppContext } from './stdio.js';

export interface EcoJoins {
  onReady: (nativeThreadId: string) => void;
  onRotated: (nativeThreadId: string) => AppContext[];
  onResult: (nativeThreadId: string, contextTokens: number) => AppContext[];
}

export function ecoJoins(projectRoot: string, env: NodeJS.ProcessEnv, o: { codexHome?: string } = {}): EcoJoins {
  const contextRoot = join(projectRoot, '_dream_context');
  const tab = typeof env.DREAMCONTEXT_TAB_SESSION === 'string' ? env.DREAMCONTEXT_TAB_SESSION : '';
  const record = (id: string): void => {
    // Only a thread Codex has written down: a mapped thread with no rollout is refused on reopen.
    if (tab && id && findCodexRollout(id, o.codexHome)) recordAgentSession(contextRoot, tab, id);
  };
  return {
    // Recorded once a turn has run (`onResult`), never at thread start: Codex writes a thread's
    // rollout with its first turn, and a mapped thread with no rollout is refused on reopen.
    onReady: () => undefined,
    onRotated: (id) => {
      try {
        const picked = selectHandoffForSessionStart(contextRoot, 'clear', tab || null);
        if (!picked) return [];
        const banner = renderHandoffBanner(picked.record);
        stampHandoffRecord(contextRoot, picked.key, { consumedAt: new Date().toISOString() });
        return [{ key: 'dreamcontext-handoff', text: banner }];
      } catch {
        return [];
      }
    },
    onResult: (id, contextTokens) => {
      record(id);
      const nudge = maybeNudge(contextRoot, { session_id: id, context_tokens: contextTokens }, env);
      return nudge ? [{ key: 'dreamcontext-context', text: nudge }] : [];
    },
  };
}
