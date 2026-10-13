/**
 * The native take (`desktop/src-tauri/src/mic.rs` → `nativeMic.ts` → `useVoiceCapture.ts`) and
 * the voice log that records every take and chunk (`src/lib/voice/voiceLog.ts`).
 *
 * What Node can prove: the binary body the shell hands over decodes to the right numbers and
 * samples, the one-buffer take is gated exactly as the WebKit frames are, and the log keeps
 * only what it should. What it cannot — CoreAudio opening at the hotkey press — is measured by
 * the log itself on the owner's machine (`firstSampleMs` per take in voice.jsonl).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeNativeTake } from '../../dashboard/src/lib/voice/nativeMic.js';
import { measureTake, judgeTake, frameSizeFor } from '../../dashboard/src/lib/voice/useVoiceCapture.js';
import { parseTakeMeta, keepTake, logVoiceEvent, KEEP_TAKES } from '../../src/lib/voice/voiceLog.js';

/** The body `mic_take_end` returns: rate, opened ms, first-sample ms, wall ms, f32 samples. */
function body(rate: number, opened: number, first: number, wall: number, samples: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(16 + samples.length * 4);
  const v = new DataView(buf);
  [rate, opened, first, wall].forEach((n, i) => v.setUint32(i * 4, n, true));
  samples.forEach((s, i) => v.setFloat32(16 + i * 4, s, true));
  return buf;
}

describe('the native take body', () => {
  it('decodes the header and every sample, little-endian', () => {
    const t = decodeNativeTake(body(48_000, 41, 57, 3_210, [0, 0.5, -0.25]));
    expect(t).toMatchObject({ rate: 48_000, openedMs: 41, firstSampleMs: 57, wallMs: 3_210 });
    expect(Array.from(t.samples)).toEqual([0, 0.5, -0.25]);
  });

  it('reads u32::MAX as "never happened", not as a 49-day latency', () => {
    const t = decodeNativeTake(body(48_000, 0xffffffff, 0xffffffff, 10, []));
    expect(t.openedMs).toBeNull();
    expect(t.firstSampleMs).toBeNull();
    expect(t.samples.length).toBe(0);
  });
});

describe('a native take is gated like the WebKit frames', () => {
  const rate = 48_000;
  const tone = (seconds: number, amp: number) => Float32Array.from(
    { length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / rate));

  it('measures per graph frame: the loudest and the quietest', () => {
    const quiet = tone(0.5, 0.001);
    const loud = tone(0.5, 0.05);
    const take = new Float32Array(quiet.length + loud.length);
    take.set(quiet); take.set(loud, quiet.length);
    const m = measureTake(take, rate);
    expect(m.frames).toBe(Math.floor(take.length / frameSizeFor(rate)));
    expect(m.peak).toBeGreaterThan(0.03);
    expect(m.floor).toBeLessThan(0.001);
  });

  it('accepts a raw-device voice at the level the owner\'s mic really delivers', () => {
    // The owner's raw MacBook mic: peak RMS ~0.02-0.04 per frame (their own Handy takes,
    // measured 2026-10-13), room ~0.0002. The WebKit era needed AGC to clear the gate.
    const room = tone(0.4, 0.0003);
    const voice = tone(1.2, 0.03);
    const take = new Float32Array(room.length + voice.length);
    take.set(room); take.set(voice, room.length);
    const m = measureTake(take, rate);
    expect(judgeTake((take.length / rate) * 1000, m.peak, m.floor)).toBe('ok');
  });

  it('still refuses room tone and a tap', () => {
    const room = Float32Array.from({ length: rate * 2 }, () => (Math.random() * 2 - 1) * 0.0004);
    const m = measureTake(room, rate);
    expect(judgeTake(2000, m.peak, m.floor)).toBe('silent');
    expect(judgeTake(120, 0.05, 0.0002)).toBe('too-short');
  });
});

describe('the voice log', () => {
  let home: string;
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  it('keeps only the known numeric capture facts from the page\'s header', () => {
    expect(parseTakeMeta(JSON.stringify({
      source: 'native', rate: 48000, firstSampleMs: 52.4, capturedMs: 3000, wallMs: 3050,
      attempt: 0, text: 'not ours to log', firstSampleMsBogus: 1,
    }))).toEqual({ source: 'native', rate: 48000, firstSampleMs: 52, capturedMs: 3000, wallMs: 3050, attempt: 0 });
    expect(parseTakeMeta('{not json')).toEqual({});
    expect(parseTakeMeta(JSON.stringify({ source: 'evil', rate: -1, wallMs: 'x' }))).toEqual({});
    expect(parseTakeMeta(undefined)).toEqual({});
  });

  it('appends one JSON line per event', () => {
    home = mkdtempSync(join(tmpdir(), 'dc-voicelog-'));
    logVoiceEvent({ kind: 'tts', outcome: 'spoken' }, home);
    logVoiceEvent({ kind: 'stt', ms: 900 }, home);
    const lines = readFileSync(join(home, '.dreamcontext', 'logs', 'voice.jsonl'), 'utf-8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).kind)).toEqual(['tts', 'stt']);
    expect(JSON.parse(lines[0]).at).toMatch(/^\d{4}-/);
  });

  it(`keeps the audio of the last ${KEEP_TAKES} takes and no more`, () => {
    home = mkdtempSync(join(tmpdir(), 'dc-voicelog-'));
    for (let i = 0; i < KEEP_TAKES + 3; i++) {
      keepTake(Buffer.from([i]), { n: i }, home);
      const until = Date.now() + 2; while (Date.now() < until) { /* distinct timestamps */ }
    }
    const files = readdirSync(join(home, '.dreamcontext', 'logs', 'voice-takes'));
    expect(files.filter((f) => f.endsWith('.wav'))).toHaveLength(KEEP_TAKES);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(KEEP_TAKES);
    const kept = files.filter((f) => f.endsWith('.json')).map((f) =>
      JSON.parse(readFileSync(join(home, '.dreamcontext', 'logs', 'voice-takes', f), 'utf-8')).n as number);
    expect(Math.min(...kept)).toBe(3);   // the oldest three went
  });
});
