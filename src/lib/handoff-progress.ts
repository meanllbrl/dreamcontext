/**
 * The context handoff, WATCHED. Desktop Chat rotates a pane into a fresh session at a turn
 * boundary (agent-chat.ts: `/clear`, then the continue prompt). Before this module the user
 * learned about it from one grey line sent AFTER the fact — the biggest operation the chat
 * does looked like nothing (owner, 2026-10-07). This turns the CLI's own frames into the
 * stages a card can draw while it happens:
 *
 *   clearing  — `/clear` and the continue prompt are written. The task file and the digest
 *               are ALREADY on disk: the record this run starts from only exists because
 *               `dreamcontext tasks handoff` finished writing both.
 *   resuming  — the old conversation is gone: the CLI reported a NEW session id, or the
 *               `/clear` turn's own result arrived.
 *   done      — the fresh session answered. Its first main-chain assistant frame carries the
 *               usage the new context is measured from (`postTokens`).
 *   failed    — the rotation threw, or the process exited mid-way.
 *
 * Pure: the route feeds it frames and sends whatever it returns. Nothing here knows about
 * sockets, so the stage logic is pinned by unit tests against real frame shapes.
 */
import { contextTokensFromUsage } from './context-watch.js';

export type HandoffStage = 'clearing' | 'resuming' | 'done' | 'failed';

export interface HandoffRun {
  /** Start time (ms) — doubles as the run's identity, so a replayed frame updates the SAME card. */
  id: number;
  stage: HandoffStage;
  task: string;
  title: string;
  /** Context the old session handed off at. Absent when neither the record nor the stream had it. */
  contextTokens?: number;
  /** Context the fresh session opened with — only once it was measured. */
  postTokens?: number;
  message?: string;
  /** The conversation being left; a `system/init` naming any OTHER id means the clear landed. */
  fromSession?: string;
}

export function startHandoffRun(opts: {
  task: string;
  title: string;
  contextTokens: number | null | undefined;
  fromSession: string | null | undefined;
  now?: number;
}): HandoffRun {
  return {
    id: opts.now ?? Date.now(),
    stage: 'clearing',
    task: opts.task,
    title: opts.title || opts.task,
    ...(opts.contextTokens && opts.contextTokens > 0 ? { contextTokens: opts.contextTokens } : {}),
    ...(opts.fromSession ? { fromSession: opts.fromSession } : {}),
  };
}

/**
 * Advance on one stdout frame. Returns the NEW run when the stage changed, else null.
 *
 * `turnsInFlight` is the route's count BEFORE this frame closes anything. The rotation opens
 * two turns (`/clear`, then the continue prompt), so a `result` only finishes the run when it
 * is the LAST open one — otherwise the `/clear` turn's own result would read as "the fresh
 * session answered" before it said a word.
 */
export function advanceHandoffRun(
  run: HandoffRun,
  frame: Record<string, unknown>,
  turnsInFlight: number,
): HandoffRun | null {
  if (run.stage === 'done' || run.stage === 'failed') return null;
  const mainResult = frame.type === 'result' && frame.parent_tool_use_id === undefined;

  if (run.stage === 'clearing') {
    const newSession = frame.type === 'system' && frame.subtype === 'init'
      && typeof frame.session_id === 'string' && frame.session_id !== run.fromSession;
    if (newSession || mainResult) return { ...run, stage: 'resuming' };
    return null;
  }

  // resuming
  if (frame.type === 'assistant' && !frame.parent_tool_use_id) {
    const message = frame.message as { usage?: Record<string, unknown> } | undefined;
    const post = contextTokensFromUsage(message?.usage);
    return { ...run, stage: 'done', ...(post > 0 ? { postTokens: post } : {}) };
  }
  if (mainResult && turnsInFlight <= 1) return { ...run, stage: 'done' };
  return null;
}

export function failHandoffRun(run: HandoffRun, message: string): HandoffRun | null {
  if (run.stage === 'done' || run.stage === 'failed') return null;
  return { ...run, stage: 'failed', message };
}

/** The `_meta` frame for a run. `fromSession` stays on the server — the card has no use for it. */
export function handoffProgressFrame(run: HandoffRun): Record<string, unknown> {
  const { fromSession: _from, ...wire } = run;
  return { subtype: 'handoff_progress', ...wire };
}
