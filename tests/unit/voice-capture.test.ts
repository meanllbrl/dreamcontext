/**
 * The capture path: the WAV the browser now encodes itself (AC2), and the silence gate that
 * decides whether a take is uploaded at all (AC5).
 *
 * The pure halves are exported precisely so they can be tested here, without a microphone, a
 * browser or a permission prompt. What is NOT provable from Node — and is therefore on the
 * manual checklist rather than faked into a green test — is the real WKWebView graph: that a
 * ScriptProcessor delivers frames, and that the context resumes inside the gesture.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  rmsOf, judgeTake, stopVerdict, MIN_TAKE_MS, RMS_FLOOR,
} from '../../dashboard/src/lib/voice/useVoiceCapture.js';
import {
  downsample, toPcm16, encodeWav, mergeChunks, wavFromTake, TARGET_SAMPLE_RATE,
} from '../../dashboard/src/lib/voice/wavEncoder.js';

// ── The WAV the app encodes itself (AC2) ────────────────────────────────────────────────
//
// The container probe this replaces is gone with `MediaRecorder`: transcription is a chat
// completion whose `input_audio` format enum is `wav` or `mp3` ONLY, so producing anything
// else is a 400 several seconds after the button is released, with no converter available in
// a webview to save it.

describe('the recorded WAV', () => {
  it('is a real RIFF/WAVE file — mono, 16-bit, at the target rate', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), TARGET_SAMPLE_RATE);
    const view = new DataView(wav.buffer);
    const ascii = (at: number, n: number) => String.fromCharCode(...wav.slice(at, at + n));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);                    // mono
    expect(view.getUint32(24, true)).toBe(TARGET_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);                   // bits per sample
    expect(view.getUint32(4, true)).toBe(wav.length - 8);        // RIFF size covers the rest
    expect(view.getUint32(40, true)).toBe(4 * 2);                // data size = samples × 2
    expect(wav.length).toBe(44 + 8);
  });

  it('SATURATES a clipped sample instead of wrapping it', () => {
    // Wrapping turns the loudest syllable of a sentence into a burst of noise — the one part
    // of a take that most needed to be intelligible.
    const pcm = toPcm16(new Float32Array([2, -2, 1, -1]));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(32767);
    expect(pcm[3]).toBe(-32768);
  });

  it('downsamples by AVERAGING the window, not by dropping samples', () => {
    // Decimation aliases: high frequencies fold back into the speech band as a metallic ring,
    // on a signal whose whole job is to be recognised.
    const input = new Float32Array([1, 0, 1, 0, 1, 0, 1, 0]);
    const out = downsample(input, 48000, 24000);
    expect(out.length).toBe(4);
    for (const v of out) expect(v).toBeCloseTo(0.5, 6);
  });

  it('leaves the samples alone when the device already runs at or below the target', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsample(input, 16000, 16000)).toBe(input);
    expect(downsample(input, 8000, 16000)).toBe(input);
  });

  it('joins the take\'s frames in order', () => {
    const merged = mergeChunks([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([])]);
    expect(Array.from(merged)).toEqual([1, 2, 3]);
  });

  it('encodes a whole take end to end at 16 kHz', () => {
    // 48 kHz in, 16 kHz out: a third of the samples, a quarter of the bytes of the raw
    // float frames — and those bytes get base64'd into a JSON body.
    const frames = [new Float32Array(4800).fill(0.25), new Float32Array(4800).fill(-0.25)];
    const wav = wavFromTake(frames, 48000);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe((9600 / 3) * 2);
  });
});

describe('rmsOf', () => {
  it('is zero for digital silence', () => {
    expect(rmsOf(new Float32Array(512))).toBe(0);
  });

  it('is the amplitude for a constant signal', () => {
    expect(rmsOf(new Float32Array(64).fill(0.5))).toBeCloseTo(0.5, 6);
  });

  it('handles an empty frame without dividing by zero', () => {
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });
});

describe('the silence gate (AC5)', () => {
  it('rejects a TAP — under 300 ms is a mis-click, not a sentence', () => {
    expect(judgeTake(MIN_TAKE_MS - 1, 0.9)).toBe('too-short');
    expect(judgeTake(120, 0.9)).toBe('too-short');
  });

  it('rejects a SILENT take even when it was held for a long time', () => {
    // This is the case with teeth. `gpt-4o-mini-transcribe` returns json/text only — there
    // is no `no_speech_prob` to consult — so silence can come back as a confident invented
    // sentence, and that sentence would be submitted to a tool-enabled agent as if the owner
    // had said it. The RMS floor is the only thing standing there.
    expect(judgeTake(5000, 0.0)).toBe('silent');
    expect(judgeTake(5000, RMS_FLOOR - 0.001)).toBe('silent');
  });

  it('accepts a real take', () => {
    expect(judgeTake(1200, 0.2)).toBe('ok');
    expect(judgeTake(MIN_TAKE_MS, RMS_FLOOR)).toBe('ok');
  });

  it('reports the tap and the silence as DIFFERENT verdicts — they are different mistakes', () => {
    expect(judgeTake(100, 0)).not.toBe(judgeTake(5000, 0));
  });
});

describe('releasing the button (the orphaned-recorder race, found in review)', () => {
  it('CANCELS a take released while the device is still opening', () => {
    // The case that made this a Critical finding, and it is the FIRST press after a fresh
    // permission grant: `getUserMedia` does not resolve until the OS dialog is answered, so
    // the button is long since released by then. Treating that as "no recorder, just free the
    // guard" let the coroutine go on to START a recorder nothing held a handle to — a live
    // track with the mic indicator lit for good, an unbounded chunk array, and the guard
    // already open so the next press ran a second capture alongside it.
    expect(stopVerdict('opening')).toBe('cancel');
  });

  it('stops the recorder when one is actually running', () => {
    expect(stopVerdict('recording')).toBe('stop-recorder');
  });

  it('IGNORES a release once capture is over — the guard belongs to the upload', () => {
    // The other phase with no recorder object, and it means the opposite. Conflating the two
    // is what the phase exists to prevent: freeing the guard here would let a second press
    // race the in-flight transcript, which is exactly what AC3f forbids.
    expect(stopVerdict('uploading')).toBe('ignore');
    expect(stopVerdict('idle')).toBe('ignore');
  });

  it('the async open RE-CHECKS cancellation after every await it performs', () => {
    // A source read, because the race lives in a React hook that root vitest (plain Node, no
    // DOM) cannot mount. What is pinned is the SHAPE the fix depends on: a token captured per
    // take, and a check after the one await that can outlive the button press.
    const src = readFileSync('dashboard/src/lib/voice/useVoiceCapture.ts', 'utf-8');
    expect(src).toMatch(/const take = \+\+takeRef\.current/);
    expect(src).toMatch(/const cancelled = \(\) => takeRef\.current !== take/);
    // Immediately after the device opens, and before anything is assigned to a ref that a
    // LATER take's teardown would own.
    const afterAwait = src.slice(src.indexOf('await navigator.mediaDevices.getUserMedia'));
    const checkAt = afterAwait.indexOf('if (cancelled())');
    const assignAt = afterAwait.indexOf('streamRef.current = stream');
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(assignAt);
    // And the abandoned stream's tracks are stopped by hand, since `teardown()` reads
    // `streamRef` and that was deliberately never assigned.
    expect(afterAwait.slice(checkAt, assignAt)).toMatch(/stream\.getTracks\(\)\.forEach/);
  });
});

// ── The meter has to be RUNNING before its number may veto anything ──────────────────────

describe('the RMS meter measures the take, or does not veto it', () => {
  const src = readFileSync('dashboard/src/lib/voice/useVoiceCapture.ts', 'utf-8');

  it('opens the AudioContext INSIDE the gesture, before any await', () => {
    // WebKit only starts a context for a real user gesture. `start()` runs synchronously from
    // the pointerdown, so the context is built in its head — the same rule `SpeechQueue.unlock`
    // follows for the playback element.
    const start = src.slice(src.indexOf('const start = useCallback'));
    const ctxAt = start.indexOf('new AudioContext()');
    const awaitAt = start.indexOf('await navigator.mediaDevices.getUserMedia');
    expect(ctxAt).toBeGreaterThan(-1);
    expect(ctxAt).toBeLessThan(awaitAt);
  });

  it('RESUMES it — a context created outside a gesture stays suspended in WebKit', () => {
    // The reported failure, and the reason it looked like a hardware problem: a suspended
    // context's analyser returns a buffer of zeroes, so every take — however loudly spoken —
    // scored an RMS of 0 and the gate refused it as silence. The context is built after
    // `await getUserMedia`, so the press that started the take no longer counts as the
    // gesture the autoplay policy wants.
    expect(src).toMatch(/if \(ctx\.state === 'suspended'\) void ctx\.resume\(\)/);
  });

  it('records and measures the SAME frame, so the gate cannot disagree with the tape', () => {
    // The failure this replaced was exactly that disagreement: an unresumed analyser reported
    // silence for every take while the recorder captured the sentence perfectly well.
    expect(src).toMatch(/chunksRef\.current\.push\(new Float32Array\(frame\)\);/);
    expect(src).toMatch(/peakRef\.current = Math\.max\(peakRef\.current, rmsOf\(frame\)\);/);
    expect(src).toMatch(/meteredFramesRef\.current \+= 1;/);
  });

  it('fails OPEN when the meter never measured — an absent number cannot refuse a sentence', () => {
    // Same policy the missing-meter `catch` has always applied, now covering a meter that was
    // present and reported nothing for reasons that have nothing to do with the room.
    expect(src).toMatch(/const peak = meteredFramesRef\.current > 0 \? peakRef\.current : 1;/);
  });

  it('mutes the monitoring path — a ScriptProcessor must reach the destination to run', () => {
    // Connected straight through, the owner hears themselves at full volume the moment they
    // press the mic. Through a gain of zero, the node still runs and nothing is played.
    expect(src).toMatch(/mute\.gain\.value = 0;/);
    expect(src).toMatch(/mute\.connect\(ctx\.destination\);/);
  });

  it('resets the frame count at the START of every take, not only on teardown', () => {
    // Otherwise take N+1 inherits take N's frames and a meter that has since stopped running
    // would still be trusted.
    const start = src.slice(src.indexOf('const start = useCallback'));
    expect(start).toMatch(/meteredFramesRef\.current = 0;/);
  });
});
