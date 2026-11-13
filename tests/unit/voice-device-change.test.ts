/**
 * Dictation after the input device changes (reported 2026-11-13: after the screen locked, or
 * headphones went in or out, voice typed nothing).
 *
 * What Node can prove: a take whose track ENDS mid-hold re-opens the current default input and
 * wires it into the same graph; a context left `interrupted` after sleep is resumed; a take
 * whose input delivered nothing is named as such (with the device) instead of "hold longer" or
 * "closer to the mic"; and a shell call that never answers frees the take instead of locking
 * dictation until a restart. What it cannot (CoreAudio re-opening on a real Mac when headphones
 * go in or out) is covered by `cargo test mic::` for its logic and by the owner on the Mac.
 */

import { describe, it, expect, vi } from 'vitest';
import { openLiveInput, keepRunning, requestInput, REOPEN_DELAY_MS } from '../../dashboard/src/lib/voice/micInput.js';
import {
  nativeTakeVerdict, judgeCapture, noSignalMessage, micFailureMessage, MIC, MIN_TAKE_MS,
} from '../../dashboard/src/lib/voice/useVoiceCapture.js';
import { decodeNativeTake, withDeadline, lateBeginMayCancel } from '../../dashboard/src/lib/voice/nativeMic.js';

/** A track that can be ended the way WebKit ends one when its device goes away. */
class FakeTrack extends EventTarget {
  stopped = false;
  constructor(public label: string) { super(); }
  stop() { this.stopped = true; }
  end() { this.dispatchEvent(new Event('ended')); }
}

class FakeStream {
  constructor(public track: FakeTrack) {}
  getTracks() { return [this.track]; }
  getAudioTracks() { return [this.track]; }
}

/** A MediaDevices whose default input is whatever `defaultLabel` says right now. */
function fakeDevices() {
  const state = { defaultLabel: 'MacBook Pro Microphone', calls: 0, fail: false };
  const opened: FakeStream[] = [];
  const devices = {
    getUserMedia: vi.fn(async () => {
      state.calls += 1;
      if (state.fail) throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
      const s = new FakeStream(new FakeTrack(state.defaultLabel));
      opened.push(s);
      return s as unknown as MediaStream;
    }),
  };
  return { devices, state, opened };
}

/** Past the re-open's settle beat. */
const flush = () => new Promise((r) => setTimeout(r, REOPEN_DELAY_MS + 30));

describe('a take whose device goes away mid-hold', () => {
  it('re-opens the CURRENT default input and wires it in place of the dead one', async () => {
    const { devices, state, opened } = fakeDevices();
    const replaced: MediaStream[] = [];
    const input = await openLiveInput(devices, {
      constraints: MIC, live: () => true, onReplace: (s) => replaced.push(s),
    });
    expect(input).not.toBeNull();
    expect(input!.label()).toBe('MacBook Pro Microphone');

    // Headphones plugged in: the default moves, then the old track ends.
    state.defaultLabel = 'AirPods Pro';
    opened[0].track.end();
    await flush();

    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(replaced).toHaveLength(1);
    expect(input!.stream).toBe(replaced[0]);
    expect(input!.label()).toBe('AirPods Pro');
    expect(opened[0].track.stopped).toBe(true);

    input!.close();
    expect(opened[1].track.stopped).toBe(true);
  });

  it('keeps following: a second change re-opens again', async () => {
    const { devices, state, opened } = fakeDevices();
    const input = await openLiveInput(devices, { constraints: MIC, live: () => true, onReplace: () => {} });
    state.defaultLabel = 'AirPods Pro';
    opened[0].track.end();
    await flush();
    state.defaultLabel = 'MacBook Pro Microphone';
    opened[1].track.end();
    await flush();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(3);
    expect(input!.label()).toBe('MacBook Pro Microphone');
  });

  it('never re-opens after the take is closed or superseded (no mic left lit)', async () => {
    const { devices, opened } = fakeDevices();
    let live = true;
    const input = await openLiveInput(devices, { constraints: MIC, live: () => live, onReplace: () => {} });
    input!.close();
    opened[0].track.end();
    await flush();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);

    const second = await openLiveInput(devices, { constraints: MIC, live: () => live, onReplace: () => {} });
    live = false;
    opened[1].track.end();
    await flush();
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    second!.close();
  });

  it('a cancelled take stops the stream it was opening and returns null', async () => {
    const { devices, opened } = fakeDevices();
    const input = await openLiveInput(devices, { constraints: MIC, live: () => false, onReplace: () => {} });
    expect(input).toBeNull();
    expect(opened[0].track.stopped).toBe(true);
  });

  it('a re-open that fails is reported, not thrown into the audio graph', async () => {
    const { devices, state, opened } = fakeDevices();
    const lost = vi.fn();
    await openLiveInput(devices, { constraints: MIC, live: () => true, onReplace: () => {}, onLost: lost });
    state.fail = true;
    opened[0].track.end();
    await flush();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('a refused constraint object falls back to the plain default once', async () => {
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'OverconstrainedError' }))
      .mockResolvedValueOnce(new FakeStream(new FakeTrack('m')) as unknown as MediaStream);
    await requestInput({ getUserMedia }, MIC);
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true });
  });
});

describe('a context left asleep', () => {
  it('resumes an interrupted or suspended context, never a running or closed one', () => {
    for (const [state, resumes] of [['interrupted', true], ['suspended', true], ['running', false], ['closed', false]] as const) {
      const resume = vi.fn(async () => {});
      keepRunning({ state, resume } as unknown as AudioContext);
      expect(resume).toHaveBeenCalledTimes(resumes ? 1 : 0);
    }
  });
});

/** The body `mic_take_end` returns. */
function body(rate: number, opened: number, wall: number, samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(16 + samples.length * 4);
  const v = new DataView(buf);
  [rate, opened, 0xffffffff, wall].forEach((n, i) => v.setUint32(i * 4, n, true));
  samples.forEach((s, i) => v.setFloat32(16 + i * 4, s, true));
  return buf;
}

describe('a take whose input delivered nothing says so', () => {
  it('held 2 s, no samples at all: no-signal, not "hold longer" (was too-short)', () => {
    const t = decodeNativeTake(body(48_000, 30, 2_000, new Float32Array(0)));
    expect(nativeTakeVerdict(t)).toBe('no-signal');
  });

  it('held 2 s of exact zeros (a closed lid, a dead route): no-signal, not "closer to the mic" (was silent)', () => {
    const t = decodeNativeTake(body(48_000, 30, 2_000, new Float32Array(96_000)));
    expect(nativeTakeVerdict(t)).toBe('no-signal');
  });

  it('a real tap is still a tap, and a quiet room is still silent', () => {
    expect(nativeTakeVerdict(decodeNativeTake(body(48_000, 20, 150, new Float32Array(0))))).toBe('too-short');
    const room = new Float32Array(96_000).map((_, i) => 0.0004 * Math.sin(i));
    expect(nativeTakeVerdict(decodeNativeTake(body(48_000, 20, 2_000, room)))).toBe('silent');
  });

  it('speech still passes', () => {
    const speech = new Float32Array(96_000).map((_, i) => (i > 48_000 ? 0.2 : 0.0004) * Math.sin(i / 7));
    expect(nativeTakeVerdict(decodeNativeTake(body(48_000, 20, 2_000, speech)))).toBe('ok');
  });

  it('the WebKit path uses the same rule', () => {
    expect(judgeCapture({ heldMs: 1_500, durationMs: 1_500, frames: 0, peak: 0, floor: Infinity })).toBe('no-signal');
    expect(judgeCapture({ heldMs: MIN_TAKE_MS - 1, durationMs: 0, frames: 0, peak: 0, floor: Infinity })).toBe('too-short');
  });

  it('names the device and what to do', () => {
    expect(noSignalMessage('AirPods Pro')).toContain('"AirPods Pro"');
    expect(noSignalMessage(null)).toContain('the microphone');
    expect(noSignalMessage(null)).toContain('System Settings');
  });
});

describe('a shell call that never answers frees the take', () => {
  it('rejects after the deadline, and a late take is handed back to be cancelled', async () => {
    vi.useFakeTimers();
    try {
      let answer!: (v: { id: number }) => void;
      const never = new Promise<{ id: number }>((r) => { answer = r; });
      const late = vi.fn();
      const p = withDeadline(never, 5_000, late);
      const caught = p.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const err = await caught;
      expect(err).toBeInstanceOf(Error);
      expect(micFailureMessage(err)).toMatch(/stopped answering/);
      answer({ id: 7 });
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toHaveBeenCalledWith({ id: 7 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late begin cancels its take only when no later press was sent (the shell hands the same id to every claim)', () => {
    // Press A times out; press B is sent while the shell is stalled and claims the take A's
    // begin opens. A's late answer must NOT cancel it.
    expect(lateBeginMayCancel(1, 2)).toBe(false);
    // Nobody pressed again: the late take has no owner and is cancelled.
    expect(lateBeginMayCancel(2, 2)).toBe(true);
  });

  it('a permission refusal still reads as a permission problem', () => {
    expect(micFailureMessage(new Error('open input: denied'))).toMatch(/permission/);
  });
});
