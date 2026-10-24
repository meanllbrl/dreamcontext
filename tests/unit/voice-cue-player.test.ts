/**
 * The "Anlayamadım" cue's player (task sesli-giris-bozuk…, AC4): its own AudioContext, unlocked
 * synchronously in `start()` on BOTH capture paths (before the native early return), never
 * closed by a take's teardown, a lent speech-queue context when its own stays suspended, and a
 * reported `suspended` — never a throw — when nothing can play.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { unlock, play, lendContext, cueStats, resetCuePlayerForTests } from '../../dashboard/src/lib/voice/cuePlayer.js';

/** A fake AudioContext: `state` starts as given and `resume()` moves it only when allowed. */
class FakeCtx {
  static made: FakeCtx[] = [];
  static resumable = true;
  static initial: AudioContextState = 'suspended';
  state: AudioContextState = FakeCtx.initial;
  destination = {};
  started = 0;
  constructor() { FakeCtx.made.push(this); }
  async resume() { if (FakeCtx.resumable) this.state = 'running'; }
  async decodeAudioData() { return { duration: 1 }; }
  createBufferSource() {
    const ctx = this;
    return { buffer: null, connect() {}, start() { ctx.started += 1; } };
  }
}

beforeEach(() => {
  resetCuePlayerForTests();
  FakeCtx.made = [];
  FakeCtx.resumable = true;
  FakeCtx.initial = 'suspended';
  vi.stubGlobal('AudioContext', FakeCtx);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const WAV = Buffer.from('RIFFcueWAVE').toString('base64');

describe('cuePlayer', () => {
  it('unlock opens one context and wakes it; play starts the cue on it', async () => {
    unlock();
    unlock();
    expect(FakeCtx.made).toHaveLength(1);
    await Promise.resolve();
    expect(await play(WAV)).toBe('started');
    expect(FakeCtx.made[0].started).toBe(1);
    expect(cueStats).toMatchObject({ starts: 1, last: 'started' });
  });

  it('own context stuck suspended (a hotkey take): a running lent speech-queue context plays it', async () => {
    FakeCtx.resumable = false;
    unlock();
    const lent = new FakeCtx();
    lent.state = 'running';
    const unlend = lendContext(() => lent as unknown as AudioContext);
    expect(await play(WAV)).toBe('started');
    expect(lent.started).toBe(1);
    unlend();
  });

  it('nothing running and no lender: reports suspended, does not throw, logs it', async () => {
    FakeCtx.resumable = false;
    unlock();
    await expect(play(WAV)).resolves.toBe('suspended');
    expect(console.info).toHaveBeenCalledWith('[voice] cue: suspended');
  });

  it('a resume() that NEVER settles (outside a gesture, per spec) still reports suspended, promptly', async () => {
    FakeCtx.resumable = false;
    unlock();
    FakeCtx.made[0].resume = () => new Promise(() => {});
    const t = Date.now();
    await expect(play(WAV)).resolves.toBe('suspended');
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('a cue still decoding when the next take is pressed is dropped, never played over it', async () => {
    FakeCtx.initial = 'running';
    unlock();
    let release: () => void = () => {};
    FakeCtx.made[0].decodeAudioData = () => new Promise((r) => { release = () => r({ duration: 1 }); });
    const pending = play(WAV);
    await Promise.resolve();
    unlock();                                   // the owner presses again
    release();
    await expect(pending).resolves.toBe('failed');
    expect(FakeCtx.made[0].started).toBe(0);
  });

  it('no context at all (never unlocked): suspended, never a throw', async () => {
    await expect(play(WAV)).resolves.toBe('suspended');
  });
});

describe('the capture hook and the cue', () => {
  const src = readFileSync('dashboard/src/lib/voice/useVoiceCapture.ts', 'utf-8');

  it('start() unlocks the cue BEFORE the native path returns early (both paths)', () => {
    const start = src.slice(src.indexOf('const start = useCallback'));
    const unlockAt = start.indexOf('unlockCue();');
    const nativeReturn = start.indexOf('startNativeTake(take);');
    expect(unlockAt).toBeGreaterThan(0);
    expect(nativeReturn).toBeGreaterThan(unlockAt);
  });

  it('teardown never touches the cue context', () => {
    const teardown = src.slice(src.indexOf('const teardown = useCallback'), src.indexOf('useEffect(() => () => {'));
    expect(teardown).not.toMatch(/cue/i);
  });

  it('a garbled answer plays the cue and reaches no transcript', () => {
    const branch = src.slice(src.indexOf("if (res.ok && body.garbled === true)"), src.indexOf('if (res.ok) {'));
    expect(branch).toContain('playCue(body.cue.b64)');
    expect(branch).toContain("setState('garbled')");
    expect(branch).not.toContain('onTranscript');
  });
});
