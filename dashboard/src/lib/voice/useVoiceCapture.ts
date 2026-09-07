/**
 * Push-to-talk capture: hold the button, speak, release, get a transcript.
 *
 * ── THE CONTAINER IS PROBED, NEVER ASSUMED ──────────────────────────────────────────────
 * There is no other `MediaRecorder` usage in this codebase to copy, so the usual "do what
 * the neighbouring file does" is unavailable and the assumption has to be made explicitly.
 * `audio/webm;codecs=opus` is the reflex and it is WRONG here: WebKit historically produces
 * `audio/mp4`/AAC, and an unsupported `mimeType` throws SYNCHRONOUSLY from the constructor —
 * so hardcoding it kills voice input on the very first press, in the one browser engine this
 * feature ships in. Both containers are on the transcription endpoint's accepted list, so the
 * probe is the entire fix: no conversion, no ffmpeg, no fallback encoder.
 *
 * ── THE SILENCE GATE IS THE ONLY DEFENCE AGAINST A HALLUCINATED SENTENCE ────────────────
 * `gpt-4o-mini-transcribe` returns `json`/`text` only. There is no `no_speech_prob` to check
 * — that belongs to `whisper-1` with `verbose_json`, a different model on a different path.
 * So a take of pure silence can come back as a confident, entirely invented sentence, and
 * that sentence would be submitted to a TOOL-ENABLED agent as if the owner had said it.
 * Two client-side checks stand between those: a minimum duration (the tap-instead-of-hold
 * case) and an RMS floor (the "held it but never spoke" case). An empty or whitespace-only
 * transcript is likewise never submitted.
 *
 * ── TRACKS ARE STOPPED AFTER EVERY TAKE ─────────────────────────────────────────────────
 * Not tidiness: a live track keeps the macOS microphone indicator lit, which tells the owner
 * the app is listening when it is not.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** A take shorter than this was a tap, not a hold. */
export const MIN_TAKE_MS = 300;

/** Peak RMS a take must reach to count as speech. Room tone sits far below this; normal
 *  speech at arm's length is an order of magnitude above it. */
export const RMS_FLOOR = 0.012;

/**
 * Containers to try, in order. Every one of them is on the transcription endpoint's accepted
 * list, so whichever the engine picks uploads as-is.
 */
export const CONTAINER_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
] as const;

/**
 * The first candidate this engine actually supports, or `undefined` to let `MediaRecorder`
 * choose its own default.
 *
 * `undefined` is a real answer, not a failure: a `MediaRecorder` constructed with no
 * `mimeType` picks something it can definitely produce, and the blob's own `type` then tells
 * the server what arrived. Refusing to record because none of our guesses matched would be
 * strictly worse than that.
 */
export function pickMimeType(
  supported: (t: string) => boolean = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
): string | undefined {
  for (const candidate of CONTAINER_CANDIDATES) {
    try {
      if (supported(candidate)) return candidate;
    } catch { /* a throwing probe is a "no" */ }
  }
  return undefined;
}

/** Root-mean-square of one analyser frame, in 0..1. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export type TakeVerdict = 'ok' | 'too-short' | 'silent';

/** How far a take has got. See {@link stopVerdict} for why the phase is tracked separately
 *  from "is there a recorder". */
export type TakePhase = 'idle' | 'opening' | 'recording' | 'uploading';

/**
 * What releasing the button should DO, given how far the take has got. Pure, so the rule can
 * be tested without a microphone, a permission dialog or a race.
 *
 * The distinction that matters is between the two phases with NO recorder object, which an
 * earlier version conflated and which is the bug this function exists to prevent:
 *   • `opening` — the device has not opened yet (`getUserMedia` is still awaiting the OS
 *     permission dialog). The take must be CANCELLED, not merely un-guarded: otherwise the
 *     coroutine goes on to start a recorder that no handle can stop, leaving a live track
 *     with the mic indicator lit and the busy guard already open for a second capture.
 *   • `uploading` — capture is over and the recorder was torn down on purpose. A stray
 *     release here must do NOTHING; the guard belongs to the upload.
 */
export function stopVerdict(phase: TakePhase): 'cancel' | 'stop-recorder' | 'ignore' {
  if (phase === 'opening') return 'cancel';
  if (phase === 'recording') return 'stop-recorder';
  return 'ignore';
}

/**
 * Should this take be uploaded at all? Pure, so the rule can be tested without a microphone.
 * Order matters for the message the owner sees: a tap is a different mistake from a silence.
 */
export function judgeTake(durationMs: number, peakRms: number): TakeVerdict {
  if (durationMs < MIN_TAKE_MS) return 'too-short';
  if (peakRms < RMS_FLOOR) return 'silent';
  return 'ok';
}

/** Every state the mic button can be in. `awaiting-confirmation` belongs to the Composer,
 *  which owns the pending text; capture itself is done by then. */
export type CaptureState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'too-short'
  | 'silent'
  | 'error'
  | 'unconfigured';

export interface VoiceCapture {
  state: CaptureState;
  /** Seconds elapsed in the current take, for the button's live readout. */
  elapsed: number;
  /** True while a take is anywhere in the pipeline — the busy guard's source of truth. */
  busy: boolean;
  /** What went wrong, in the owner's terms. Never an upstream message. */
  error: string;
  start: () => void;
  stop: () => void;
}

export interface VoiceCaptureOptions {
  /** The vault this take belongs to — `/stt` is vault-scoped. */
  vault: string | null;
  /** Called with a non-empty transcript. Never called for a rejected or empty take. */
  onTranscript: (text: string) => void;
}

export function useVoiceCapture({ vault, onTranscript }: VoiceCaptureOptions): VoiceCapture {
  const [state, setState] = useState<CaptureState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const peakRef = useRef(0);
  const rafRef = useRef(0);
  const tickRef = useRef(0);
  /** A take is unresolved from the moment the button goes down until the transcript (or a
   *  refusal) lands. `state` alone is not enough — it is React state and lags a fast
   *  double-tap by a render. */
  const inFlightRef = useRef(false);
  /**
   * Which take is current. Incremented when one BEGINS and again when one is CANCELLED, so
   * the async open below can ask "am I still the take that was asked for?" after every await.
   *
   * Found in review, and it is the first press after a fresh permission grant that triggers
   * it: `getUserMedia` does not resolve until the OS dialog is answered, so the button is
   * long since released by then. Without this token, `stop()` saw no recorder, freed the busy
   * guard, and the coroutine went on to build and START a recorder that nothing held a handle
   * to — a live track with the macOS mic indicator lit for good, a chunk array growing
   * unbounded, and the guard already open so the next press ran a SECOND capture alongside it.
   */
  const takeRef = useRef(0);
  /**
   * How far the current take has got. `stop()` needs this because "there is no recorder" is
   * ambiguous on its own: it means the device has not opened YET (cancel the take) during
   * `opening`, and it means the recorder has already been torn down (leave everything alone)
   * during `uploading`.
   */
  const phaseRef = useRef<TakePhase>('idle');

  /** Release the device and every meter attached to it. Idempotent. */
  const teardown = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = 0; }
    // The macOS mic indicator stays lit for as long as ANY track is live.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => () => {
    // Unmount CANCELS a take that is still opening, for exactly the reason `stop()` does.
    // `teardown()` alone is not enough here: during `opening` the stream has deliberately not
    // been assigned to `streamRef` yet, so a `getUserMedia` that resolves after this component
    // is gone would hand a live track to a coroutine whose teardown has already run — and the
    // mic indicator would stay lit with nothing left to switch it off. Narrow (it needs an
    // unmount while the OS permission dialog is up) and surfaced by review while checking the
    // fix above; closed here rather than left as a known hole in the same window.
    takeRef.current += 1;
    phaseRef.current = 'idle';
    teardown();
  }, [teardown]);

  const upload = useCallback(async (blob: Blob) => {
    try {
      const res = await fetch('/api/agent/voice/stt', {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'audio/webm',
          ...(vault ? { 'X-Dreamcontext-Vault': vault } : {}),
        },
        body: await blob.arrayBuffer(),
      });
      const body = await res.json().catch(() => ({})) as { text?: string; error?: string; message?: string };
      if (!res.ok) {
        // `*_unconfigured` is PERMANENT until Settings changes — the mode degrades to text
        // and says what is missing. Everything else is this take only, and retrying is fine.
        const permanent = body.error === 'stt_unconfigured';
        setState(permanent ? 'unconfigured' : 'error');
        setError(body.message || 'That take did not go through. Try again.');
        return;
      }
      const text = (body.text || '').trim();
      if (!text) {
        // A blank transcript is a silence the gate did not catch. Never submitted.
        setState('silent');
        return;
      }
      setState('idle');
      onTranscript(text);
    } catch {
      setState('error');
      setError('That take did not go through. Try again.');
    } finally {
      inFlightRef.current = false;
      phaseRef.current = 'idle';
    }
  }, [vault, onTranscript]);

  const start = useCallback(() => {
    // The busy guard, at its source. A second press while a take is unresolved is REFUSED,
    // never queued: two `fill textarea → submit` paths racing is how an async transcript ends
    // up overwriting something the owner typed by hand while waiting (AC3f).
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const take = ++takeRef.current;
    phaseRef.current = 'opening';
    setError('');
    setElapsed(0);
    peakRef.current = 0;
    chunksRef.current = [];

    void (async () => {
      /** True once `stop()` cancelled this take while the device was still opening. */
      const cancelled = () => takeRef.current !== take;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        if (cancelled()) return;
        inFlightRef.current = false;
        phaseRef.current = 'idle';
        setState('error');
        setError('The microphone is not available. Check the permission in System Settings.');
        return;
      }
      if (cancelled()) {
        // Released while the OS permission dialog was up. The tracks are stopped HERE rather
        // than through `teardown()`, because `streamRef` was deliberately never assigned —
        // this stream belongs to a take that no longer exists, and a later take's teardown
        // must not be the thing that closes it.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      let recorder: MediaRecorder;
      try {
        const mimeType = pickMimeType();
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      } catch {
        // Reached only if the probe and the constructor disagree. Degrade rather than throw.
        teardown();
        if (cancelled()) return;
        inFlightRef.current = false;
        phaseRef.current = 'idle';
        setState('error');
        setError('This system cannot record audio in a supported format.');
        return;
      }
      recorderRef.current = recorder;

      // The RMS meter. Peak across the take, not an average: a take is speech if the owner
      // spoke at ANY point in it, and an average would let a long pause veto a real sentence.
      try {
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const sample = () => {
          analyser.getFloatTimeDomainData(buf);
          peakRef.current = Math.max(peakRef.current, rmsOf(buf));
          rafRef.current = requestAnimationFrame(sample);
        };
        rafRef.current = requestAnimationFrame(sample);
      } catch {
        // No meter available: fail OPEN on the RMS check rather than refusing every take.
        peakRef.current = 1;
      }

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const durationMs = Date.now() - startedAtRef.current;
        const peak = peakRef.current;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        teardown();

        const verdict = judgeTake(durationMs, peak);
        if (verdict !== 'ok') {
          // NOTHING is uploaded. Not one invented sentence reaches the agent (AC5).
          inFlightRef.current = false;
          phaseRef.current = 'idle';
          setState(verdict === 'too-short' ? 'too-short' : 'silent');
          return;
        }
        phaseRef.current = 'uploading';
        setState('transcribing');
        void upload(blob);
      };

      startedAtRef.current = Date.now();
      recorder.start();
      phaseRef.current = 'recording';
      setState('recording');
      tickRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 250);
    })();
  }, [teardown, upload]);

  const stop = useCallback(() => {
    const verdict = stopVerdict(phaseRef.current);
    if (verdict === 'ignore') return;
    if (verdict === 'cancel') {
      // Released before the device finished opening. CANCEL the take rather than merely
      // freeing the guard: bumping the token makes the coroutine unwind at its next check and
      // stop the stream it may already hold, instead of going on to start a recorder that
      // nothing can ever stop.
      takeRef.current += 1;
      phaseRef.current = 'idle';
      teardown();
      inFlightRef.current = false;
      setState('idle');
      return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, [teardown]);

  return {
    state,
    elapsed,
    busy: state === 'recording' || state === 'transcribing',
    error,
    start,
    stop,
  };
}
