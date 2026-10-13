/**
 * One voice turn of the notch, timed end to end: from the hotkey's release to the first sound
 * of the answer, as ONE line in `~/.dreamcontext/logs/voice.jsonl` (`kind:"turn"`).
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────────────
 * The owner asked whether Spidey could be faster (2026-10-13). The transcripts answer half of
 * it — owner message to first reply text, median 8.4 s — but not the half the owner hears:
 * whisper before it and the first spoken chunk after it. Each stage lives in a different
 * module (the capture hook, the chat session, the speech queue), so each one marks its own
 * moment here and the trace is written once the answer has started playing.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────────────────
 * Every stage is milliseconds since the release (`t0`). A stage that never happened is ABSENT,
 * never 0 — "no audio" and "audio at once" must not read the same. The first mark of a stage
 * wins: a turn has one first token, however many deltas follow.
 *
 *   stt         the transcript came back            sent        the prompt left the page
 *   firstToken  the first streamed delta (thinking or text)
 *   firstText   the first streamed answer text      ttsAsked    the first chunk went to TTS
 *   ttsReady    the first chunk's audio arrived      audio       the first chunk is audible
 *   end         the turn's result frame
 *
 * plus the first API call's token footprint (input / cacheRead / cacheCreation, model) and how
 * many tool calls ran before the first answer text. The server adds the configured effort.
 *
 * Only the notch is traced ({@link TRACED_VAULT}): it is the one surface with a hotkey, a
 * spoken answer and a latency budget. One trace at a time, as there is one owner and one mic.
 */

/** The Assistant's hidden vault. Mirrors `ASSISTANT_VAULT` in components/assistant/Notch.tsx
 *  (a lib module does not import a component); `tests/unit/voice-turn-trace.test.ts` holds
 *  the two equal. */
export const TRACED_VAULT = '__assistant__';

export type TurnStage = 'stt' | 'sent' | 'firstToken' | 'firstText' | 'ttsAsked' | 'ttsReady' | 'audio' | 'end';
export type TurnOutcome = 'answered' | 'silent' | 'stt_failed' | 'no_audio' | 'abandoned' | 'superseded';

export interface TurnUsageSample {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  model?: string;
}

export interface TurnRecord {
  kind: 'turn';
  outcome: TurnOutcome;
  stages: Partial<Record<TurnStage, number>>;
  usage?: TurnUsageSample;
  /** Tool calls the model made before its first answer text. */
  toolsBeforeText: number;
  sttAttempts?: number;
}

/** A turn whose result came but no audio started is written this long after the result:
 *  speech off, or every chunk refused. */
export const AFTER_END_MS = 15_000;
/** A turn that never ends (a crash, a closed notch) is written as abandoned after this. */
export const MAX_TURN_MS = 180_000;
/** A hotkey release this recent is the turn's start; older, the stop itself is. */
const RELEASE_FRESH_MS = 10_000;

interface Trace {
  t0: number;
  stages: Partial<Record<TurnStage, number>>;
  usage?: TurnUsageSample;
  tools: number;
  sttAttempts?: number;
  timer: unknown;
}

export interface TurnTracer {
  /** The hotkey came up (Notch, at the Rust edge): the most accurate t0 there is. */
  noteRelease(at?: number): void;
  /** The take ended and is going to whisper. Starts a trace for the notch's vault. */
  arm(vault: string | null | undefined): void;
  mark(vault: string | null | undefined, stage: TurnStage): void;
  /** For the speech queue, which belongs to the notch alone and has no vault. */
  markSpeech(stage: 'ttsAsked' | 'ttsReady' | 'audio', at?: number): void;
  usage(vault: string | null | undefined, u: TurnUsageSample): void;
  toolUse(vault: string | null | undefined): void;
  sttAttempts(vault: string | null | undefined, n: number): void;
  /** The take produced no turn (silence, a failed transcription). */
  drop(vault: string | null | undefined, outcome: 'silent' | 'stt_failed'): void;
}

export function createTurnTracer(
  write: (r: TurnRecord) => void,
  now: () => number = Date.now,
  // Arrow wrappers, not the bare functions: a WebKit/Chromium `setTimeout` called as a method
  // of this object throws "Illegal invocation" (caught by verify, on the hotkey release).
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): TurnTracer {
  let cur: Trace | null = null;
  let releasedAt = 0;

  const ours = (vault: string | null | undefined) => vault === TRACED_VAULT && cur !== null;

  function flush(outcome: TurnOutcome): void {
    const t = cur;
    if (!t) return;
    cur = null;
    if (t.timer) timers.clear(t.timer);
    write({
      kind: 'turn',
      outcome,
      stages: t.stages,
      ...(t.usage ? { usage: t.usage } : {}),
      toolsBeforeText: t.tools,
      ...(t.sttAttempts !== undefined ? { sttAttempts: t.sttAttempts } : {}),
    });
  }

  function reschedule(ms: number, outcome: TurnOutcome): void {
    const t = cur;
    if (!t) return;
    if (t.timer) timers.clear(t.timer);
    t.timer = timers.set(() => { if (cur === t) flush(outcome); }, ms);
  }

  function stamp(stage: TurnStage, at: number): void {
    const t = cur;
    if (!t || t.stages[stage] !== undefined) return;
    t.stages[stage] = Math.max(0, Math.round(at - t.t0));
    if (stage === 'audio' && t.stages.end !== undefined) flush('answered');
    else if (stage === 'end') {
      if (t.stages.audio !== undefined) flush('answered');
      else reschedule(AFTER_END_MS, 'no_audio');
    }
  }

  return {
    noteRelease(at = now()) { releasedAt = at; },
    arm(vault) {
      if (vault !== TRACED_VAULT) return;
      if (cur) flush('superseded');
      const at = now();
      const t0 = releasedAt && at - releasedAt >= 0 && at - releasedAt < RELEASE_FRESH_MS ? releasedAt : at;
      releasedAt = 0;
      cur = { t0, stages: {}, tools: 0, timer: null };
      reschedule(MAX_TURN_MS, 'abandoned');
    },
    mark(vault, stage) { if (ours(vault)) stamp(stage, now()); },
    markSpeech(stage, at = now()) {
      // Speech before the prompt went out is the PREVIOUS answer still playing.
      if (cur && cur.stages.sent !== undefined) stamp(stage, at);
    },
    usage(vault, u) {
      if (ours(vault) && !cur!.usage && cur!.stages.sent !== undefined) cur!.usage = u;
    },
    toolUse(vault) {
      if (ours(vault) && cur!.stages.sent !== undefined && cur!.stages.firstText === undefined) cur!.tools += 1;
    },
    sttAttempts(vault, n) { if (ours(vault)) cur!.sttAttempts = n; },
    drop(vault, outcome) { if (ours(vault)) flush(outcome); },
  };
}

function post(r: TurnRecord): void {
  void fetch('/api/agent/voice/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(r),
  }).catch(() => { /* best-effort: a lost trace never costs a turn */ });
}

/**
 * A tracer that cannot throw. Its marks sit on the release, the send and the play path; a bug
 * in the measurement must never cost the take it is measuring.
 */
export function guarded(t: TurnTracer): TurnTracer {
  const safe = {} as TurnTracer;
  for (const k of Object.keys(t) as Array<keyof TurnTracer>) {
    (safe as unknown as Record<string, (...a: unknown[]) => void>)[k] = (...a: unknown[]) => {
      try { (t[k] as (...x: unknown[]) => void)(...a); } catch { /* measurement only */ }
    };
  }
  return safe;
}

/** The page's one tracer. */
export const turnTrace: TurnTracer = guarded(createTurnTracer(post));
