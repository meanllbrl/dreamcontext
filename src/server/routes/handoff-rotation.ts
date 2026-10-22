import {
  handoffContinuePrompt, readHandoffRecord, rotationDecision, stampHandoffRecord, superFallbackRecord, writeHandoffRecord,
  type HandoffRecord, type RotationDecision,
} from '../../lib/context-watch.js';
import { startHandoffRun, type HandoffRun, type HandoffStage } from '../../lib/handoff-progress.js';
import { startRotating, takeFreshDelivered } from '../../lib/super/fresh-session.js';

/**
 * The context handoff's rotation at a pane's main `result` frame, out of agent-chat.ts so every
 * case is tested against the real record files (task super-agent-devrini-…). ONE decision per
 * frame (`rotationDecision`): the pane's own record, or — in the Super Agent's pane, after its
 * "New session" turn — a fallback record the server writes when the super wrote none. Never two.
 *
 * `/clear` sent as a stream-json USER frame rotates the conversation in-process and fires
 * SessionStart with `source=clear`, so the pane's websocket, pin id and tab env all survive.
 * `actedAt` is the idempotency latch and this is its ONLY writer (the SessionStart hook owns
 * `consumedAt`): without it every later result would clear again.
 */
export interface RotationInput {
  contextRoot: string;
  /** The pane's pin id (the record key); null = a pane with no pin never rotates. */
  pane: string | null;
  /** The Super Agent's pane: its fresh latch counts, and a rotation holds its inbox. */
  isSuper: boolean;
  frame: Record<string, unknown>;
  /** A refusal read earlier in this turn, or on this very frame. */
  isLimit: boolean;
  observedConversation: string;
  lastMainContext: number;
  /** Open one turn and write one user frame (the bridge's `openTurn` + `writeStdin`). */
  writeUserTurn: (text: string) => void;
  startRun: (run: HandoffRun) => void;
  now?: Date;
}

export function handleRotationAtResult(input: RotationInput): RotationDecision {
  const { contextRoot, pane } = input;
  if (!pane) return 'none';
  // Taken (and so cleared) on every main result: a latch never outlives the turn it was set in.
  const latch = input.isSuper ? takeFreshDelivered(pane) : null;
  let record: HandoffRecord | null = readHandoffRecord(contextRoot, pane);
  const decision = rotationDecision({ record, latch: !!latch, isError: input.frame.is_error === true, isLimit: input.isLimit });
  if (decision === 'none') return decision;
  if (decision === 'fallback') {
    record = superFallbackRecord(pane, input.observedConversation, input.lastMainContext > 0 ? input.lastMainContext : null, input.now);
    if (!writeHandoffRecord(contextRoot, pane, record)) throw new Error('could not write the fallback handoff record');
  }
  const rec = record as HandoffRecord;
  stampHandoffRecord(contextRoot, pane, { actedAt: (input.now ?? new Date()).toISOString() });
  // Both are USER frames, so both open turns (see turnsInFlight's header in agent-chat.ts).
  input.writeUserTurn('/clear');
  input.writeUserTurn(handoffContinuePrompt(rec, { fallback: decision === 'fallback' }));
  input.startRun(startHandoffRun({
    task: rec.task,
    title: rec.title,
    contextTokens: rec.contextTokens ?? input.lastMainContext,
    fromSession: input.observedConversation,
    ...(rec.kind === 'super' ? { kind: 'super' as const } : {}),
  }));
  if (input.isSuper) startRotating(pane);
  return decision;
}

/**
 * Has the rotated super pane finished its fresh session's first turn? Read on a main `result`
 * with the run's stage and the open-turn count from BEFORE this frame. The `/clear` turn's own
 * result never counts: it comes while the run is still `clearing`, or with the continue turn
 * still open (2 in flight) — unless the fresh session has already answered (`done`).
 */
export function rotationFinished(stageBefore: HandoffStage | undefined, turnsBefore: number): boolean {
  if (!stageBefore || stageBefore === 'clearing') return false;
  return turnsBefore <= 1 || stageBefore === 'done';
}
