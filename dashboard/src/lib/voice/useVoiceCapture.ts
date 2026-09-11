/**
 * Push-to-talk capture: hold the button, speak, release, get a transcript.
 *
 * ── THE APP RECORDS ITS OWN WAV, AND THAT IS NOT A PREFERENCE ───────────────────────────
 * Transcription is a chat completion with a base64 `input_audio` part, and upstream accepts
 * `wav` or `mp3` and nothing else. `MediaRecorder` produces neither (WebKit: `audio/mp4`,
 * Chromium: `audio/webm`), a webview has no converter, and the refusal arrives as a 400
 * several seconds after the button is released. So the samples are taken straight off the
 * graph and encoded here (`wavEncoder.ts`) — which also deleted the container probe this
 * file used to open with, and with it a whole class of "which engine are we in" branching.
 *
 * ── THE SAME NODE MEASURES AND RECORDS ──────────────────────────────────────────────────
 * One `ScriptProcessorNode` hands us every frame; the RMS meter and the tape read the SAME
 * buffer. That is why the silence gate can no longer disagree with what was recorded, which
 * is exactly how it failed before: the meter lived on a `requestAnimationFrame` loop over an
 * AudioContext that was never resumed, so it reported silence for every take while
 * `MediaRecorder` happily captured the sentence. `ScriptProcessorNode` is deprecated and
 * chosen anyway — an AudioWorklet needs a separately-loaded module, which in a bundled
 * desktop webview buys a Blob-URL dance for a node that works everywhere today.
 *
 * ── THE CONTEXT IS OPENED INSIDE THE GESTURE ────────────────────────────────────────────
 * WebKit only starts an AudioContext for a real user gesture. Created after
 * `await getUserMedia` it stays `suspended`, and a suspended graph delivers silence.
 *
 * ── THE SILENCE GATE IS THE ONLY DEFENCE AGAINST A HALLUCINATED SENTENCE ────────────────
 * The transcription model returns text with no confidence signal, so a take of pure silence
 * can come back as a confident, entirely invented sentence — and that sentence would be
 * submitted to a TOOL-ENABLED agent as if the owner had said it. Two client-side checks
 * stand between those: a minimum duration (the tap-instead-of-hold case) and an RMS floor
 * (the "held it but never spoke" case). An empty transcript is likewise never submitted.
 *
 * ── TRACKS ARE STOPPED AFTER EVERY TAKE ─────────────────────────────────────────────────
 * Not tidiness: a live track keeps the macOS microphone indicator lit, which tells the owner
 * the app is listening when it is not.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { wavFromTake, TARGET_SAMPLE_RATE } from './wavEncoder';

/** A take shorter than this was a tap, not a hold. */
export const MIN_TAKE_MS = 300;

/** Peak RMS a take must reach to count as speech. Room tone sits far below this; normal
 *  speech at arm's length is an order of magnitude above it. */
export const RMS_FLOOR = 0.012;

/** Root-mean-square of one frame of samples, in 0..1. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** How many samples one published level covers. See {@link levelSlices}. */
export const LEVEL_SLICE = 1024;

/**
 * One audio frame, split into the level values the meter draws.
 *
 * Pure, and separated from the audio callback so the CONTRACT is testable without a
 * microphone: a 4096-sample frame must yield FOUR measurements, each a real RMS of its own
 * quarter. Publishing one value per frame instead — the obvious version — is ~12 Hz at
 * 48 kHz, which is visibly steppy; and interpolating between frames would draw a meter that
 * is partly invention, in a component whose entire job is to be believed.
 *
 * A trailing partial slice is DROPPED rather than measured short: an RMS over fewer samples
 * is not comparable to its neighbours, and one wrong-height bar at the end of every frame is
 * a periodic artefact that looks like signal.
 */
export function levelSlices(frame: Float32Array, step = LEVEL_SLICE): number[] {
  const out: number[] = [];
  for (let i = 0; i + step <= frame.length; i += step) {
    out.push(rmsOf(frame.subarray(i, i + step)));
  }
  return out;
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
  /**
   * The live input level (RMS, 0..1), roughly every 21 ms while a take is recording.
   *
   * DELIBERATELY NOT REACT STATE. It is read by a canvas that paints on its own rAF loop;
   * routing it through `setState` would re-render the composer at audio rate. Held in a ref
   * so a caller that re-creates the callback every render does not rebuild the audio graph.
   */
  onLevel?: (level: number) => void;
}

export function useVoiceCapture({ vault, onTranscript, onLevel }: VoiceCaptureOptions): VoiceCapture {
  const [state, setState] = useState<CaptureState>('idle');
  /** See {@link VoiceCaptureOptions.onLevel}: the audio callback reads the CURRENT listener,
   *  so a new closure each render never touches the graph. */
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  /** The tape: every frame the graph handed us, at the device's own sample rate. */
  const chunksRef = useRef<Float32Array[]>([]);
  /** The node feeding both the tape and the meter, kept so it can be disconnected. */
  const tapRef = useRef<ScriptProcessorNode | null>(null);
  const startedAtRef = useRef(0);
  const peakRef = useRef(0);
  /** How many frames were captured. Zero means the graph never ran for this take — see the
   *  fail-open in `finishTake`. */
  const meteredFramesRef = useRef(0);
  const tickRef = useRef(0);
  /** True between `start()` and the release, so a frame arriving after the take is over is
   *  dropped rather than appended to a tape nobody is holding. */
  const capturingRef = useRef(false);
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
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = 0; }
    capturingRef.current = false;
    if (tapRef.current) {
      tapRef.current.onaudioprocess = null;
      try { tapRef.current.disconnect(); } catch { /* already gone */ }
      tapRef.current = null;
    }
    // The macOS mic indicator stays lit for as long as ANY track is live.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
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
          'Content-Type': 'audio/wav',
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

  /**
   * Close the tape and decide what happens to it. Called from `stop()` — there is no recorder
   * event to hang this on any more, which is a simplification: the release IS the end of the
   * take, rather than a request for one that arrives asynchronously later.
   */
  const finishTake = useCallback(() => {
    const durationMs = Date.now() - startedAtRef.current;
    const deviceRate = audioCtxRef.current?.sampleRate ?? TARGET_SAMPLE_RATE;
    const frames = chunksRef.current;
    // A take with no frames at all never reached the graph — an ABSENT meter, not a silent
    // room — and a number nobody took must not veto a sentence. There is also nothing to
    // upload in that case, so it degrades to `silent` below on emptiness alone.
    const peak = meteredFramesRef.current > 0 ? peakRef.current : 1;
    capturingRef.current = false;
    const wav = frames.length ? wavFromTake(frames, deviceRate) : null;
    chunksRef.current = [];
    teardown();

    const verdict = wav ? judgeTake(durationMs, peak) : 'silent';
    if (verdict !== 'ok' || !wav) {
      // NOTHING is uploaded. Not one invented sentence reaches the agent (AC5).
      inFlightRef.current = false;
      phaseRef.current = 'idle';
      setState(verdict === 'too-short' ? 'too-short' : 'silent');
      return;
    }
    phaseRef.current = 'uploading';
    setState('transcribing');
    void upload(new Blob([wav as unknown as BlobPart], { type: 'audio/wav' }));
  }, [teardown, upload]);


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
    meteredFramesRef.current = 0;
    chunksRef.current = [];

    // ── THE METER'S CONTEXT IS BUILT HERE, INSIDE THE GESTURE ────────────────────────────
    // Synchronously, in the same tick as the pointerdown — exactly like `SpeechQueue.unlock`
    // a few files over, and for the same rule: WebKit only starts an AudioContext for a real
    // user gesture. Built after `await getUserMedia` instead, it starts (and stays)
    // `suspended`, its analyser hands back a buffer of ZEROES, and the silence gate then
    // refuses every take however loudly it was spoken. That was the whole of "nothing was
    // heard in that take" — the microphone was fine; the meter was asleep.
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    } catch {
      audioCtxRef.current = null;
    }

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

      // ── The tape and the meter, on ONE node ─────────────────────────────────────────
      // The context was opened in the gesture (see `start`'s head); it is only WIRED here,
      // once there is a stream to wire to. Every frame is both recorded and measured, so the
      // gate can never disagree with what was captured — the failure this replaced was
      // exactly that disagreement.
      const ctx = audioCtxRef.current;
      if (!ctx) {
        teardown();
        if (cancelled()) return;
        inFlightRef.current = false;
        phaseRef.current = 'idle';
        setState('error');
        setError('This system cannot record audio.');
        return;
      }
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

      try {
        const source = ctx.createMediaStreamSource(stream);
        // 4096 frames ≈ 85 ms at 48 kHz: small enough that a short take still gets several
        // frames, large enough not to spend the take in callback overhead.
        const tap = ctx.createScriptProcessor(4096, 1, 1);
        tapRef.current = tap;
        tap.onaudioprocess = (e) => {
          if (!capturingRef.current) return;
          const frame = e.inputBuffer.getChannelData(0);
          // COPIED: the buffer belongs to the graph and is reused for the next callback.
          chunksRef.current.push(new Float32Array(frame));
          peakRef.current = Math.max(peakRef.current, rmsOf(frame));
          meteredFramesRef.current += 1;
          // ── THE LIVE METER, AND WHY IT IS A CALLBACK RATHER THAN STATE ────────────────
          // The meter is the mode's trust signal: a take that heard nothing must LOOK
          // different from one that was never recorded. But publishing a level through
          // React state would re-render the whole composer ~47 times a second, so the level
          // leaves through a ref'd callback and is drawn to a canvas instead.
          //
          // One callback per 1024 samples rather than per frame: 4096 at 48 kHz is ~85 ms,
          // which is ~12 Hz — visibly steppy. Quartering it gives ~47 Hz, and each value is
          // still a REAL measurement of that slice, not an interpolation.
          const onLevel = onLevelRef.current;
          if (onLevel) for (const level of levelSlices(frame)) onLevel(level);
        };
        source.connect(tap);
        // A ScriptProcessor only runs while it is connected to the destination, so it is —
        // through a gain of ZERO. Without the mute, the owner hears themselves.
        const mute = ctx.createGain();
        mute.gain.value = 0;
        tap.connect(mute);
        mute.connect(ctx.destination);
      } catch {
        teardown();
        if (cancelled()) return;
        inFlightRef.current = false;
        phaseRef.current = 'idle';
        setState('error');
        setError('This system cannot record audio.');
        return;
      }

      startedAtRef.current = Date.now();
      capturingRef.current = true;
      phaseRef.current = 'recording';
      setState('recording');
      tickRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 250);
    })();
  }, [teardown, finishTake]);

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
    finishTake();
  }, [teardown, finishTake]);

  return {
    state,
    elapsed,
    busy: state === 'recording' || state === 'transcribing',
    error,
    start,
    stop,
  };
}
