/**
 * The capture gate (AC2's probe, AC5's silence gate).
 *
 * The pure halves of `useVoiceCapture` are exported precisely so they can be tested here,
 * without a microphone, a browser or a permission prompt. What is NOT provable from Node —
 * and is therefore on the manual checklist rather than faked into a green test — is which
 * container the real Tauri WKWebView actually reports as supported.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  pickMimeType, rmsOf, judgeTake, stopVerdict,
  CONTAINER_CANDIDATES, MIN_TAKE_MS, RMS_FLOOR,
} from '../../dashboard/src/lib/voice/useVoiceCapture.js';

describe('the container probe (AC2)', () => {
  it('prefers webm/opus when the engine supports it — Chromium\'s answer', () => {
    expect(pickMimeType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
  });

  it('falls through to mp4/AAC when webm is unsupported — WebKit\'s answer, and the reason this probe exists', () => {
    // The hardcoded assumption this replaces (`audio/webm;codecs=opus`) throws SYNCHRONOUSLY
    // from the MediaRecorder constructor on an engine that cannot produce it, killing voice
    // input on the very first press. WebKit is the engine this feature ships in.
    expect(pickMimeType((t) => t.startsWith('audio/mp4'))).toBe('audio/mp4;codecs=mp4a.40.2');
  });

  it('returns undefined when nothing matches, so MediaRecorder picks its own default', () => {
    // Not an error: a recorder with no mimeType produces something it can definitely make,
    // and the blob's own `type` then tells the server what arrived. Refusing to record
    // because none of our guesses matched would be strictly worse.
    expect(pickMimeType(() => false)).toBeUndefined();
  });

  it('treats a THROWING probe as a no rather than propagating it', () => {
    expect(pickMimeType((t) => {
      if (t.startsWith('audio/webm')) throw new TypeError('nope');
      return t === 'audio/mp4';
    })).toBe('audio/mp4');
  });

  it('offers only containers the transcription endpoint accepts — there is no conversion step', () => {
    const accepted = ['webm', 'mp4', 'ogg', 'wav', 'mp3', 'flac', 'aac'];
    for (const c of CONTAINER_CANDIDATES) {
      expect(accepted.some((a) => c.includes(a)), c).toBe(true);
    }
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
