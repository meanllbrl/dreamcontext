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
 * ── THE DEVICE IS ASKED FOR THE PROCESSED SIGNAL, BECAUSE THE RAW ONE IS SILENT ─────────
 * `getUserMedia({ audio: true })` hands over the microphone after the browser's voice-call
 * chain: echo cancellation, noise suppression and automatic gain control. From 2026-09-12
 * this file asked for all three OFF, on the reasoning that they are tuned for telephony and
 * lossy in the band a recogniser reads. On WebKit/macOS that reasoning never got to matter:
 * the three are ONE switch there (the voice-processing audio unit), and with it off the
 * built-in microphone arrives roughly 30x quieter.
 *
 * MEASURED 2026-09-29, the owner speaking continuously into a MacBook Pro's built-in mic,
 * a bare WKWebView running this exact graph (peak RMS over 5 s, half-second slices):
 *   echoCancellation/NS/AGC off, 16 kHz context   0.009  (slices 0.000-0.002)
 *   echoCancellation/NS/AGC off, 48 kHz context   0.008  (slices 0.001-0.005)
 *   defaults (processing on),    16 kHz context   0.216  (slices 0.013-0.216)
 *   defaults (processing on),    48 kHz context   0.131  (slices 0.024-0.131)
 * The raw take sits at the silence gate's noise floor, so every take was refused as silent
 * before it was ever uploaded. The owner heard that as "the microphone dies when I press the
 * hotkey" (and saw the input level in System Settings drop when the take started). A take
 * that is heard beats a cleaner take that is not.
 *
 * The echo-cancellation worry that motivated the raw request is smaller than it looked,
 * too: read-aloud is opt-in, and starting a take barges in on anything still speaking, so
 * the canceller has little of the machine's own voice to adapt to.
 *
 * The flags are asked ON explicitly rather than left to defaults, so a future default change
 * cannot turn this back into a silent microphone, and `ideal` rather than exact, so a device
 * that cannot honour one still opens. A browser that refuses the constraint object outright
 * falls back to `{ audio: true }`.
 *
 * ── AND CAPTURED AT 16 kHz WHERE THE PLATFORM ALLOWS IT ─────────────────────────────────
 * An AudioContext built with `{ sampleRate: 16000 }` makes the platform's own resampler do
 * the rate conversion, and it is a better one than anything worth shipping in this file.
 * Where that is refused, the take is captured at the device's rate and `wavEncoder.ts`
 * resamples it with a windowed-sinc filter.
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
import { turnTrace } from './turnTrace';
import { unlock as unlockCue, play as playCue } from './cuePlayer';
import {
  beginNativeTake, endNativeTake, cancelNativeTake, onNativeLevel, probeNativeMic, nativeMicReady,
} from './nativeMic';

/**
 * The constraint object: the voice-processing chain ON, one channel.
 *
 * NOT the raw device: on WebKit/macOS turning the chain off leaves the built-in microphone
 * ~30x quieter, below the silence gate. See the module note for the measurement.
 */
export const MIC: MediaTrackConstraints = {
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
  channelCount: { ideal: 1 },
};

/** A take shorter than this was a tap, not a hold. */
export const MIN_TAKE_MS = 300;

/**
 * The STRICTEST the speech gate ever gets: the level calibrated when the browser's automatic
 * gain control was doing the levelling for us.
 *
 * It is now a CEILING on the threshold rather than the threshold itself — see
 * {@link speechThreshold}.
 */
export const RMS_FLOOR = 0.012;

/**
 * The absolute floor, below which a take is not speech on any device.
 *
 * This is the one number that is not relative to anything, and it is deliberately far down:
 * its only job is to catch a microphone that is delivering nothing at all, where "peak is
 * several times the noise" would otherwise be satisfied by two adjacent flavours of zero.
 */
export const ABSOLUTE_RMS_FLOOR = 0.0015;

/** How far a take's loudest moment must rise above its own quietest one to be speech. */
export const SPEECH_OVER_NOISE = 3.5;

/**
 * The peak RMS this take had to reach, given how quiet its own quietest moment was.
 *
 * ── WHY THE GATE BECAME RELATIVE, 2026-09-12 ────────────────────────────────────────────
 * FOUND IN REVIEW, and it is the regression that would have traded one complaint for a worse
 * one. {@link RMS_FLOOR} was measured against a capture path that asked the browser for
 * automatic gain control; the raw-device capture this mode used from 2026-09-12 to 2026-09-29
 * switched AGC off, and a quiet speaker at arm's length can then land 20 dB —
 * about 10x in amplitude — under where the same voice used to arrive. A fixed absolute floor
 * calibrated on the boosted signal would have started discarding real sentences as silence,
 * with no transcript at all: "the dictation is bad" replaced by "the dictation did not
 * happen".
 *
 * The insight that makes the fix simple is that AGC boosted the ROOM as well as the voice. So
 * the ratio between them barely moved; only the absolute level did. The gate therefore asks
 * about the ratio, and keeps the old absolute number as a CEILING it may never exceed:
 *
 *   threshold = max(ABSOLUTE_RMS_FLOOR, min(RMS_FLOOR, noise × SPEECH_OVER_NOISE))
 *
 * The capture is processed again ({@link MIC}), and the relative gate stays: it costs nothing
 * and still covers a device or engine whose chain does not level the signal.
 *
 * By construction this can only ever ACCEPT MORE than the old rule did, never less — so it
 * cannot introduce a new false "that take was silent". And it still refuses a take of pure
 * room tone, where the peak IS the noise and therefore cannot be several times it.
 */
export function speechThreshold(noiseRms: number): number {
  if (!Number.isFinite(noiseRms) || noiseRms <= 0) return RMS_FLOOR;
  return Math.max(ABSOLUTE_RMS_FLOOR, Math.min(RMS_FLOOR, noiseRms * SPEECH_OVER_NOISE));
}

/** Root-mean-square of one frame of samples, in 0..1. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** How many samples one published level covers at 48 kHz. See {@link levelSlices}. */
export const LEVEL_SLICE = 1024;

/**
 * The meter's slice, and the graph's frame, for a context running at `rate`.
 *
 * Both used to be constants sized for 48 kHz, and both are wrong the moment the context is
 * opened at 16 kHz (see the module note): a 4096-sample frame is 85 ms at 48 kHz and 256 ms
 * at 16 kHz, which is a meter that updates four times a second and a silence gate that can
 * miss a short take entirely. Sizing them in TIME rather than in samples keeps the meter at
 * ~47 Hz and the frame at ~85 ms whatever rate the platform gave us.
 */
export function sliceFor(rate: number): number {
  return Math.max(128, Math.round(rate / 47));
}

/** The ScriptProcessor's buffer size for `rate` — a power of two, ~85 ms, within the range
 *  the spec allows (256…16384). */
export function frameSizeFor(rate: number): number {
  const wanted = rate * 0.085;
  const pow = Math.pow(2, Math.round(Math.log2(wanted)));
  return Math.min(16384, Math.max(256, pow));
}

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
 *
 * `noiseRms` is the take's own quietest frame. Absent (or unmeasurable) it defaults to
 * `Infinity`, which collapses {@link speechThreshold} back to the old fixed floor — so a
 * caller that cannot measure the room is held to the stricter rule rather than to none.
 */
export function judgeTake(durationMs: number, peakRms: number, noiseRms = Infinity): TakeVerdict {
  if (durationMs < MIN_TAKE_MS) return 'too-short';
  if (peakRms < speechThreshold(noiseRms)) return 'silent';
  return 'ok';
}

/**
 * The silence gate's two numbers for a take that arrived as ONE buffer (the native path), measured
 * exactly as the WebKit path measures its frames: per ~85 ms frame, the loudest and the quietest.
 * A trailing partial frame is ignored, as the graph never delivers one. Pure, so the gate can be
 * checked against real recordings without a microphone.
 */
export function measureTake(samples: Float32Array, rate: number): { peak: number; floor: number; frames: number } {
  const size = frameSizeFor(rate);
  let peak = 0;
  let floor = Infinity;
  let frames = 0;
  for (let at = 0; at + size <= samples.length; at += size) {
    const level = rmsOf(samples.subarray(at, at + size));
    peak = Math.max(peak, level);
    floor = Math.min(floor, level);
    frames += 1;
  }
  return { peak, floor, frames };
}

/**
 * What the server is told about how a take was captured, logged next to its transcript
 * (`~/.dreamcontext/logs/voice.jsonl`). The numbers that answer "were my first words lost" and
 * "did the page drop audio mid-take": how long after the press the first sample landed, and how
 * much audio was captured against how long the take lasted.
 */
export interface TakeMeta {
  source: 'native' | 'webkit';
  rate: number;
  /** ms from the take opening (the press) to the first captured sample. */
  firstSampleMs: number | null;
  /** ms of audio actually captured, and ms the take lasted on the wall clock. */
  capturedMs: number;
  wallMs: number;
}

/** Every state the mic button can be in. `awaiting-confirmation` belongs to the Composer,
 *  which owns the pending text; capture itself is done by then. */
export type CaptureState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'too-short'
  | 'silent'
  /** The Mac could not understand the take, twice, and sent nothing ("Anlayamadım"). */
  | 'garbled'
  | 'error'
  | 'unconfigured';

/**
 * How many times a failed transcription is tried AGAIN before the owner is told (owner,
 * 2026-10-04: "if transcription fails let's try 2 times before saying that it failed").
 */
export const STT_RETRIES = 2;
/** The wait before retry n (1-based): a cold whisper server needs a moment, not a hammering. */
export function sttRetryDelayMs(attempt: number): number {
  return attempt <= 1 ? 700 : 1600;
}

/**
 * Is this transcription failure worth another try? A network failure, the server being busy,
 * a 5xx and `stt_failed` are this take's bad luck. `stt_unconfigured` (no dictation installed,
 * a take in a format we refuse), a take too large, and a refusal of the caller are not: the
 * same bytes would fail the same way.
 */
export function sttRetryable(status: number | null, error: string | undefined): boolean {
  if (status === null) return true;                      // the request never answered
  if (error === 'stt_unconfigured' || status === 413 || status === 403) return false;
  if (status === 429 || status >= 500) return true;
  return error === 'stt_failed' && status !== 400;
}

export interface VoiceCapture {
  state: CaptureState;
  /** 0 on the first transcription attempt; 1..STT_RETRIES while a failed one is retried. */
  attempt: number;
  /** Seconds elapsed in the current take, for the button's live readout. */
  elapsed: number;
  /** True while a take is anywhere in the pipeline — the busy guard's source of truth. */
  busy: boolean;
  /** What went wrong, in the owner's terms. Never an upstream message. */
  error: string;
  /** What whisper made of a `garbled` take — shown dimmed, as plain text, never sent. */
  heard: string;
  start: () => void;
  stop: () => void;
}

/**
 * The hands-free phone's longest take, ended and sent like a release. Under the Mac's own cap
 * for a phone take (`PHONE_MAX_STT_SECONDS` = 120 in src/lib/voice/limits.ts; the drift test holds
 * the margin): a message held past it is sent, never recorded in full and then refused.
 */
export const PHONE_MAX_TAKE_MS = 115_000;

export interface VoiceCaptureOptions {
  /** The vault this take belongs to — `/stt` is vault-scoped. */
  vault: string | null;
  /** Called with a non-empty transcript and its take ref (when the server kept one). Never
   *  called for a rejected, empty or garbled take. */
  onTranscript: (text: string, take?: string) => void;
  /** The conversation the take is dictated into: one of the server's language-context signals. */
  conv?: string | null;
  /**
   * The live input level (RMS, 0..1), roughly every 21 ms while a take is recording.
   *
   * DELIBERATELY NOT REACT STATE. It is read by a canvas that paints on its own rAF loop;
   * routing it through `setState` would re-render the composer at audio rate. Held in a ref
   * so a caller that re-creates the callback every render does not rebuild the audio graph.
   */
  onLevel?: (level: number) => void;
  /** End (and send) the take at this length, as letting go would. Unset: no limit (the laptop). */
  maxMs?: number;
}

export function useVoiceCapture({ vault, onTranscript, onLevel, maxMs, conv }: VoiceCaptureOptions): VoiceCapture {
  /** Read by the recording tick; `stopRef` is the stop below, which the tick cannot name yet. */
  const maxMsRef = useRef(maxMs);
  maxMsRef.current = maxMs;
  const stopRef = useRef<() => void>(() => {});
  const [state, setState] = useState<CaptureState>('idle');
  /** See {@link VoiceCaptureOptions.onLevel}: the audio callback reads the CURRENT listener,
   *  so a new closure each render never touches the graph. */
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [heard, setHeard] = useState('');
  const [attempt, setAttempt] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  /** The tape: every frame the graph handed us, at the device's own sample rate. */
  const chunksRef = useRef<Float32Array[]>([]);
  /** The node feeding both the tape and the meter, kept so it can be disconnected. */
  const tapRef = useRef<ScriptProcessorNode | null>(null);
  const startedAtRef = useRef(0);
  const peakRef = useRef(0);
  /** The QUIETEST frame of the take — the room, near enough. What makes the speech gate
   *  relative to this microphone's own level rather than to one measured on another. */
  const floorRef = useRef(Infinity);
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
  /** The native take this hook holds (`nativeMic.ts`), or null on the WebKit path. */
  const nativeIdRef = useRef<number | null>(null);
  /** Unsubscribes the native level stream. */
  const nativeLevelOffRef = useRef<(() => void) | null>(null);
  /** When `start()` ran, for the WebKit take's first-sample latency. */
  const pressedAtRef = useRef(0);
  /** This take is on the native path (decided in `start()`). */
  const nativeTakeRef = useRef(false);
  /** Released while the native take was still being claimed: end it the moment it is. */
  const stopPendingRef = useRef(false);

  // Learn now whether the shell records natively, so the first press already knows its path.
  useEffect(() => { void probeNativeMic(); }, []);

  /** Release the device and every meter attached to it. Idempotent. */
  const teardown = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = 0; }
    capturingRef.current = false;
    nativeLevelOffRef.current?.();
    nativeLevelOffRef.current = null;
    if (nativeIdRef.current !== null) {
      // Dropped, not ended: whoever still wanted the samples has already taken the id.
      void cancelNativeTake(nativeIdRef.current);
      nativeIdRef.current = null;
    }
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

  const upload = useCallback(async (blob: Blob, meta?: TakeMeta) => {
    const take = takeRef.current;
    try {
      const bytes = await blob.arrayBuffer();
      // The take is held here, so a failed transcription is simply sent again: twice more,
      // with a short wait, before the owner hears that it failed (`STT_RETRIES`).
      for (let n = 0; ; n++) {
        if (takeRef.current !== take) return;          // unmounted or superseded meanwhile
        setAttempt(n);
        let status: number | null = null;
        let body: {
          text?: string; error?: string; message?: string; take?: string;
          garbled?: boolean; heard?: string; cue?: { b64?: string };
        } = {};
        try {
          const res = await fetch('/api/agent/voice/stt', {
            method: 'POST',
            headers: {
              'Content-Type': 'audio/wav',
              ...(vault ? { 'X-Dreamcontext-Vault': vault } : {}),
              ...(meta ? { 'X-Dreamcontext-Take': JSON.stringify({ ...meta, attempt: n, ...takeContext(conv) }) } : {}),
            },
            body: bytes,
          });
          status = res.status;
          body = await res.json().catch(() => ({})) as typeof body;
          if (res.ok && body.garbled === true) {
            // Understood by nobody, twice: NOTHING reaches the composer and nothing is sent.
            // The notice says so, and the phone says it aloud (owner, 2026-10-24).
            turnTrace.drop(vault, 'silent');
            setHeard(typeof body.heard === 'string' ? body.heard : '');
            setState('garbled');
            if (typeof body.cue?.b64 === 'string') void playCue(body.cue.b64);
            return;
          }
          if (res.ok) {
            const text = (body.text || '').trim();
            if (!text) {
              // A blank transcript is a silence the gate did not catch. Never submitted.
              turnTrace.drop(vault, 'silent');
              setState('silent');
              return;
            }
            turnTrace.mark(vault, 'stt');
            turnTrace.sttAttempts(vault, n + 1);
            setState('idle');
            onTranscript(text, typeof body.take === 'string' ? body.take : undefined);
            return;
          }
        } catch {
          status = null;
        }
        if (n < STT_RETRIES && sttRetryable(status, body.error)) {
          await new Promise((r) => setTimeout(r, sttRetryDelayMs(n + 1)));
          continue;
        }
        // `*_unconfigured` is PERMANENT until Settings changes — the mode degrades to text
        // and says what is missing. Everything else is this take only.
        const permanent = body.error === 'stt_unconfigured';
        turnTrace.drop(vault, 'stt_failed');
        setState(permanent ? 'unconfigured' : 'error');
        setError(body.message || (n > 0
          ? `That take did not go through after ${n + 1} tries. Try again.`
          : 'That take did not go through. Try again.'));
        return;
      }
    } finally {
      setAttempt(0);
      inFlightRef.current = false;
      phaseRef.current = 'idle';
    }
  }, [vault, onTranscript, conv]);

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
    // Two frames at least: with one, the quietest frame IS the loudest and every take would
    // be judged against its own peak. Unmeasured falls back to the old fixed floor.
    const noise = meteredFramesRef.current > 1 ? floorRef.current : Infinity;
    capturingRef.current = false;
    const wav = frames.length ? wavFromTake(frames, deviceRate) : null;
    chunksRef.current = [];
    teardown();

    // No frame at all and released inside the tap window: a TAP (the press is what the owner
    // did, so it is timed from the press), not a silent room. It earns the tap's one word and
    // nudge, as on the native path (`frames === 0 ? 'too-short'`).
    const verdict = wav ? judgeTake(durationMs, peak, noise)
      : Date.now() - pressedAtRef.current < MIN_TAKE_MS ? 'too-short' : 'silent';
    if (verdict !== 'ok' || !wav) {
      // NOTHING is uploaded. Not one invented sentence reaches the agent (AC5).
      inFlightRef.current = false;
      phaseRef.current = 'idle';
      setState(verdict === 'too-short' ? 'too-short' : 'silent');
      turnTrace.drop(vault, 'silent');
      return;
    }
    phaseRef.current = 'uploading';
    setState('transcribing');
    let captured = 0;
    for (const f of frames) captured += f.length;
    const meta: TakeMeta = {
      source: 'webkit',
      rate: deviceRate,
      firstSampleMs: startedAtRef.current ? startedAtRef.current - pressedAtRef.current : null,
      capturedMs: Math.round((captured / deviceRate) * 1000),
      wallMs: durationMs,
    };
    void upload(new Blob([wav as unknown as BlobPart], { type: 'audio/wav' }), meta);
  }, [vault, teardown, upload]);

  /**
   * End a NATIVE take: fetch its samples from the shell, gate them exactly as the WebKit path
   * gates its frames, and upload. The phase moves to `uploading` at once, so a second release
   * while the samples are on their way is ignored rather than ending the take twice.
   */
  const finishNativeTake = useCallback(() => {
    const id = nativeIdRef.current;
    nativeIdRef.current = null;
    nativeLevelOffRef.current?.();
    nativeLevelOffRef.current = null;
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = 0; }
    phaseRef.current = 'uploading';
    const take = takeRef.current;
    void (async () => {
      const fail = (message: string) => {
        if (takeRef.current !== take) return;
        inFlightRef.current = false;
        phaseRef.current = 'idle';
        setState('error');
        setError(message);
      };
      if (id === null) { fail('That take did not go through. Try again.'); return; }
      let got;
      try {
        got = await endNativeTake(id);
      } catch {
        fail('The microphone is not available. Check the permission in System Settings.');
        return;
      }
      if (takeRef.current !== take) return;
      const { peak, floor, frames } = measureTake(got.samples, got.rate);
      const durationMs = got.rate > 0 ? (got.samples.length / got.rate) * 1000 : 0;
      const verdict = frames === 0 ? 'too-short' : judgeTake(durationMs, peak, frames > 1 ? floor : Infinity);
      if (verdict !== 'ok') {
        inFlightRef.current = false;
        phaseRef.current = 'idle';
        setState(verdict === 'too-short' ? 'too-short' : 'silent');
        turnTrace.drop(vault, 'silent');
        return;
      }
      const wav = wavFromTake([got.samples], got.rate);
      setState('transcribing');
      const meta: TakeMeta = {
        source: 'native',
        rate: got.rate,
        firstSampleMs: got.firstSampleMs,
        capturedMs: Math.round(durationMs),
        wallMs: got.wallMs,
      };
      void upload(new Blob([wav as unknown as BlobPart], { type: 'audio/wav' }), meta);
    })();
  }, [vault, upload]);

  /**
   * Open (or claim) a NATIVE take. The hotkey's take has been listening since the press; the
   * elapsed clock starts there too, so the readout tells the truth about what is on tape.
   */
  const startNativeTake = useCallback((take: number) => {
    void (async () => {
      const cancelled = () => takeRef.current !== take;
      let begun: { id: number; sinceMs: number } | null;
      try {
        begun = await beginNativeTake();
      } catch {
        begun = null;
        if (cancelled()) return;
        inFlightRef.current = false;
        phaseRef.current = 'idle';
        setState('error');
        setError('The microphone is not available. Check the permission in System Settings.');
        return;
      }
      if (!begun) {
        if (cancelled()) return;
        inFlightRef.current = false;
        phaseRef.current = 'idle';
        setState('error');
        setError('This system cannot record audio.');
        return;
      }
      if (cancelled()) { void cancelNativeTake(begun.id); return; }
      nativeIdRef.current = begun.id;
      startedAtRef.current = Date.now() - begun.sinceMs;
      phaseRef.current = 'recording';
      if (stopPendingRef.current) {
        // Released before the claim landed. The shell has been recording since the press, so
        // this is a whole take, not a cancelled one: end it now.
        stopPendingRef.current = false;
        finishNativeTake();
        return;
      }
      setState('recording');
      tickRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 250);
      const off = await onNativeLevel((level) => onLevelRef.current?.(level));
      if (cancelled() || nativeIdRef.current !== begun.id) { off(); return; }
      nativeLevelOffRef.current = off;
    })();
  }, [finishNativeTake]);


  const start = useCallback(() => {
    // The busy guard, at its source. A second press while a take is unresolved is REFUSED,
    // never queued: two `fill textarea → submit` paths racing is how an async transcript ends
    // up overwriting something the owner typed by hand while waiting (AC3f).
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    // The cue's context, inside the gesture and before the native path returns early: by the
    // time a take comes back garbled the gesture is long gone (`cuePlayer.ts`).
    unlockCue();
    const take = ++takeRef.current;
    phaseRef.current = 'opening';
    setError('');
    setHeard('');
    setElapsed(0);
    peakRef.current = 0;
    floorRef.current = Infinity;
    meteredFramesRef.current = 0;
    chunksRef.current = [];
    pressedAtRef.current = Date.now();
    startedAtRef.current = 0;
    stopPendingRef.current = false;
    nativeTakeRef.current = nativeMicReady();

    // ── THE DESKTOP RECORDS NATIVELY ─────────────────────────────────────────────────────
    // No AudioContext, no getUserMedia: the shell's take (`nativeMic.ts`) — already running
    // since the hotkey press, when there was one. Only once the shell has PROVEN it can (the
    // mount-time probe); until then, and in a browser, the WebKit path below.
    if (nativeTakeRef.current) {
      startNativeTake(take);
      return;
    }

    // ── THE METER'S CONTEXT IS BUILT HERE, INSIDE THE GESTURE ────────────────────────────
    // Synchronously, in the same tick as the pointerdown — exactly like `SpeechQueue.unlock`
    // a few files over, and for the same rule: WebKit only starts an AudioContext for a real
    // user gesture. Built after `await getUserMedia` instead, it starts (and stays)
    // `suspended`, its analyser hands back a buffer of ZEROES, and the silence gate then
    // refuses every take however loudly it was spoken. That was the whole of "nothing was
    // heard in that take" — the microphone was fine; the meter was asleep.
    // 16 kHz ASKED FOR FIRST: the platform's own resampler is better than ours, and where it
    // obliges, `wavEncoder.resample` becomes a no-op for the whole take. A rate a device
    // cannot serve THROWS here rather than degrading, so the plain constructor is the second
    // attempt and not a nicety.
    try {
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      } catch {
        ctx = new AudioContext();
      }
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
      } catch (err) {
        // A constraint this device or engine will not take must not cost the take. Retried
        // ONCE with no constraints at all: a take in the default chain beats no take.
        if ((err as { name?: string })?.name === 'OverconstrainedError'
          || (err as { name?: string })?.name === 'TypeError') {
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
        } else {
          if (cancelled()) return;
          inFlightRef.current = false;
          phaseRef.current = 'idle';
          setState('error');
          setError('The microphone is not available. Check the permission in System Settings.');
          return;
        }
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
        // ~85 ms of audio whatever rate the context ended up at: small enough that a short
        // take still gets several frames, large enough not to spend the take in callback
        // overhead. Sized from the rate rather than hardcoded, because the context above now
        // asks for 16 kHz and a fixed 4096 would be 256 ms there.
        const slice = sliceFor(ctx.sampleRate);
        const tap = ctx.createScriptProcessor(frameSizeFor(ctx.sampleRate), 1, 1);
        tapRef.current = tap;
        tap.onaudioprocess = (e) => {
          if (!capturingRef.current) return;
          const frame = e.inputBuffer.getChannelData(0);
          // COPIED: the buffer belongs to the graph and is reused for the next callback.
          chunksRef.current.push(new Float32Array(frame));
          const level = rmsOf(frame);
          peakRef.current = Math.max(peakRef.current, level);
          floorRef.current = Math.min(floorRef.current, level);
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
          if (onLevel) for (const level of levelSlices(frame, slice)) onLevel(level);
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
        const ms = Date.now() - startedAtRef.current;
        setElapsed(Math.floor(ms / 1000));
        if (maxMsRef.current && ms >= maxMsRef.current) stopRef.current();
      }, 250);
    })();
  }, [teardown, finishTake, startNativeTake]);

  const stop = useCallback(() => {
    const verdict = stopVerdict(phaseRef.current);
    if (verdict === 'ignore') return;
    // The release: a voice turn of the notch starts its clock here (lib/voice/turnTrace.ts).
    if (verdict !== 'cancel' || nativeTakeRef.current) turnTrace.arm(vault);
    if (verdict === 'cancel' && nativeTakeRef.current) {
      // Native: the shell is already recording (since the hotkey press, for a hotkey take), so a
      // release while the claim is in flight ENDS the take rather than throwing the words away.
      stopPendingRef.current = true;
      return;
    }
    if (verdict === 'cancel') {
      // Released before the device finished opening. CANCEL the take rather than merely
      // freeing the guard: bumping the token makes the coroutine unwind at its next check and
      // stop the stream it may already hold, instead of going on to start a recorder that
      // nothing can ever stop.
      takeRef.current += 1;
      phaseRef.current = 'idle';
      teardown();
      inFlightRef.current = false;
      // A release inside the tap window is a tap, and says so (one word and a nudge); a long
      // press the device never opened for (a permission sheet) just goes back to rest.
      setState(Date.now() - pressedAtRef.current < MIN_TAKE_MS ? 'too-short' : 'idle');
      return;
    }
    if (nativeIdRef.current !== null) finishNativeTake();
    else finishTake();
  }, [vault, teardown, finishTake, finishNativeTake]);
  stopRef.current = stop;

  return {
    state,
    attempt,
    elapsed,
    busy: state === 'recording' || state === 'transcribing',
    error,
    heard,
    start,
    stop,
  };
}

/** The language-context half of the take header: the conversation (shape-checked again by the
 *  server) and the device's UI language — the OS language the owner reads, which says more
 *  about what they speak than the app's own, English-by-default locale. */
function takeContext(conv: string | null | undefined): { conv?: string; ui?: string } {
  const ui = typeof navigator !== 'undefined' ? navigator.language : '';
  return { ...(conv && /^[\w-]{1,64}$/.test(conv) ? { conv } : {}), ...(ui ? { ui } : {}) };
}
