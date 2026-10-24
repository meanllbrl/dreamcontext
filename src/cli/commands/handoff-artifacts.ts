import { liveTranscriptPath, findTranscriptBySessionId } from '../../lib/transcript-locate.js';
import { lastMainChainContext } from '../../lib/context-watch.js';
import { buildDigest, writeDigest } from '../../lib/session-digest.js';
import { appendCompactionRecord } from '../../lib/sleep-consolidation.js';
import { withSleepStateLock } from '../../lib/sleep-state-lock.js';
import { distillTranscript } from './transcript.js';
import { readSleepState, writeSleepState } from './sleep.js';

/**
 * What every context handoff writes beside its state — `tasks handoff` into a task, `super
 * handoff` into the Super Agent's file — so the two can never drift: the session's measured
 * size, a PARTIAL digest (the session is about to end with its decisions un-captured), and the
 * compaction log's `handoff` entry. Best-effort throughout: none of it may block the handoff.
 */
export interface HandoffSession {
  tab: string;
  sessionId: string;
  transcript: string | null;
  contextTokens: number | null;
}

/** Find this session's live transcript: the pane first (it survives a rotation), then the conversation. */
export function locateHandoffSession(root: string, env: NodeJS.ProcessEnv = process.env): HandoffSession {
  const tab = env.DREAMCONTEXT_TAB_SESSION ?? '';
  const sessionId = env.CLAUDE_CODE_SESSION_ID ?? '';
  const transcript = (tab ? liveTranscriptPath(root, tab) : null)
    ?? (sessionId ? findTranscriptBySessionId([sessionId]) : null);
  const contextTokens = transcript ? lastMainChainContext(transcript) : null;
  return { tab, sessionId, transcript, contextTokens };
}

/** The partial digest and the compaction-log entry. */
export function writeHandoffArtifacts(root: string, s: HandoffSession): void {
  try {
    if (s.transcript && s.sessionId) {
      writeDigest(root, s.sessionId, buildDigest(distillTranscript(s.transcript)), { partial: true });
    }
  } catch { /* the digest is a safety net, not the handoff itself */ }
  try {
    withSleepStateLock(root, () => {
      const state = readSleepState(root);
      writeSleepState(root, appendCompactionRecord(state, {
        timestamp: new Date().toISOString(),
        trigger: 'handoff',
        debt_at_compaction: state.debt,
        sessions_count: state.sessions.length,
        bookmarks_count: state.bookmarks.length,
        ...(s.contextTokens !== null ? { context_tokens: s.contextTokens } : {}),
      }));
    });
  } catch { /* the log is a record, never a gate on the handoff */ }
}
