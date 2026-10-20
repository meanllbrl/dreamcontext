/**
 * The hands-free phone's voice message (task the-hands-free-phone-sends-a-voice-message-that-the-
 * mac-s-whisper-turns-into-text, AC2-AC3): POST /api/agent/voice/stt is the ONE voice route the
 * phone listener opens, with caps of its own decided per SOCKET (never by loopback: the tunnel
 * dials from 127.0.0.1) — 4 MB, 2 minutes by the WAV header, one take in flight, a dozen a minute
 * — and every other voice route stays laptop-only. The route runs through the real handler with a
 * stubbed whisper; the phone socket is marked the way the phone listener marks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PHONE_MAX_STT_BYTES, PHONE_MAX_STT_SECONDS, PHONE_STT_LIMITS, phoneSttGate, sttGate, wavSeconds,
} from '../../src/lib/voice/limits.js';
import { handleVoiceStt } from '../../src/server/routes/agent-voice.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';
import { MAC_DENIED_API_ROUTES, phoneAllows, setPhoneSurfaceForTests } from '../../dashboard/src/lib/phoneSurface.js';

/** A PCM16 mono WAV of `seconds` at `rate`, with an honest (or a lying) data size. */
function wav(seconds: number, rate = 16_000, declared?: number, o: { byteRate?: number; bits?: number } = {}): Buffer {
  const bits = o.bits ?? 16;
  const align = bits / 8;
  const n = Math.round(seconds * rate) * align;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(o.byteRate ?? rate * align, 28); h.writeUInt16LE(align, 32);
  h.writeUInt16LE(bits, 34); h.write('data', 36); h.writeUInt32LE(declared ?? n, 40);
  return Buffer.concat([h, Buffer.alloc(n)]);
}

function makeRes() {
  let statusCode = 0;
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (c: Buffer) => { chunks.push(Buffer.from(c)); });
  const res = Object.assign(sink, {
    setHeader() {},
    writeHead(code: number) { statusCode = code; return res; },
    get headersSent() { return statusCode !== 0; },
  }) as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => { try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { return undefined; } },
  };
}

/** A request on a socket — a PHONE socket when `phone`, marked as the phone listener marks it. */
function makeReq(payload: Buffer, phone: boolean): IncomingMessage {
  const stream = Readable.from(payload.length ? [payload] : []) as unknown as IncomingMessage;
  const socket = {};
  if (phone) markPhoneSocket(socket);
  Object.assign(stream, { headers: { 'content-type': 'audio/wav' }, method: 'POST', url: '/api/agent/voice/stt', socket, destroy: () => {} });
  return stream;
}

const TOUCHED = ['HOME', 'DREAMCONTEXT_DESKTOP', 'DREAMCONTEXT_WHISPER_BIN', 'DREAMCONTEXT_WHISPER_MODEL'] as const;
let saved: Record<string, string | undefined> = {};
let home: string;
let inference: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'dc-phone-stt-'));
  process.env.HOME = home;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  const bin = join(home, 'whisper-server');
  const model = join(home, 'ggml-large-v3-turbo.bin');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  writeFileSync(model, Buffer.alloc(2_000_000));
  process.env.DREAMCONTEXT_WHISPER_BIN = bin;
  process.env.DREAMCONTEXT_WHISPER_MODEL = model;
  inference = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: ' telefondan bir mesaj ', language: 'turkish' }) }));
  vi.stubGlobal('fetch', (vi.fn(async (u: string) => (String(u).endsWith('/inference')
    ? inference()
    : { ok: true, status: 404, json: async () => ({}) }))) as unknown as typeof globalThis.fetch);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  sttGate.reset();
  phoneSttGate.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('wavSeconds (the phone take\'s length, from its own header)', () => {
  it('reads the recorder\'s format (PCM mono 16 kHz 16-bit)', () => {
    expect(wavSeconds(wav(2))).toBeCloseTo(2, 5);
  });
  it('a forged byteRate cannot shrink a take: the length comes from rate x block align (review r1)', () => {
    expect(wavSeconds(wav(130, 16_000, undefined, { byteRate: 0x7fffffff }))).toBeCloseTo(130, 3);
  });
  it('any other format is refused, not measured: another rate, 8-bit, 8 kHz', () => {
    expect(wavSeconds(wav(1.5, 48_000))).toBeNull();
    expect(wavSeconds(wav(1, 8_000, undefined, { bits: 8 }))).toBeNull();
    expect(wavSeconds(wav(1, 16_000, undefined, { bits: 8 }))).toBeNull();
  });
  it('a declared size smaller than the bytes present counts the bytes (no smuggling)', () => {
    expect(wavSeconds(wav(10, 16_000, 32))).toBeCloseTo(10, 3);
  });
  it('an unreadable header is null: not RIFF, no fmt, no data, a streaming size', () => {
    expect(wavSeconds(Buffer.from('not a wav at all, honestly'))).toBeNull();
    const noFmt = wav(1); noFmt.write('junk', 12);
    expect(wavSeconds(noFmt)).toBeNull();
    expect(wavSeconds(wav(1).subarray(0, 36))).toBeNull();
    expect(wavSeconds(wav(1, 16_000, 0xffffffff))).toBeNull();
  });
});

describe('POST /api/agent/voice/stt from the phone (AC2)', () => {
  it('a phone take within the caps is transcribed by the local whisper', async () => {
    const r = makeRes();
    await handleVoiceStt(makeReq(wav(3), true), r.res, {}, home);
    expect(r.status()).toBe(200);
    expect(r.body().text).toBe('telefondan bir mesaj');
    expect(phoneSttGate.state.inFlight).toBe(0);
    expect(sttGate.state.inFlight).toBe(0);
  });

  it('a phone take over 2 minutes is refused (413) before whisper runs; the laptop takes the same take', async () => {
    const long = wav(PHONE_MAX_STT_SECONDS + 5);
    expect(long.length).toBeLessThan(PHONE_MAX_STT_BYTES);
    const r = makeRes();
    await handleVoiceStt(makeReq(long, true), r.res, {}, home);
    expect(r.status()).toBe(413);
    expect(inference).not.toHaveBeenCalled();
    const desk = makeRes();
    await handleVoiceStt(makeReq(long, false), desk.res, {}, home);
    expect(desk.status()).toBe(200);
  });

  it('a phone body over 4 MB is refused mid-stream; a phone WAV whose header cannot say its length is refused', async () => {
    const big = makeRes();
    await handleVoiceStt(makeReq(Buffer.concat([wav(1), Buffer.alloc(PHONE_MAX_STT_BYTES)]), true), big.res, {}, home);
    expect(big.status()).toBe(413);
    const odd = makeRes();
    await handleVoiceStt(makeReq(wav(1, 16_000, 0xffffffff), true), odd.res, {}, home);
    expect(odd.status()).toBe(413);
    expect(inference).not.toHaveBeenCalled();
  });

  it('one phone take in flight and a dozen a minute; the laptop is not throttled by the phone\'s gate', async () => {
    expect(PHONE_STT_LIMITS).toEqual({ concurrency: 1, perWindow: 12, windowMs: 60_000 });
    phoneSttGate.acquire();
    const busy = makeRes();
    await handleVoiceStt(makeReq(wav(1), true), busy.res, {}, home);
    expect(busy.status()).toBe(429);
    expect(busy.body().error).toBe('stt_busy');
    expect(sttGate.state.inFlight).toBe(0);
    const desk = makeRes();
    await handleVoiceStt(makeReq(wav(1), false), desk.res, {}, home);
    expect(desk.status()).toBe(200);
    phoneSttGate.reset();
    for (let i = 0; i < 12; i++) {
      const ok = makeRes();
      await handleVoiceStt(makeReq(wav(1), true), ok.res, {}, home);
      expect(ok.status()).toBe(200);
    }
    const rate = makeRes();
    await handleVoiceStt(makeReq(wav(1), true), rate.res, {}, home);
    expect(rate.status()).toBe(429);
  });
});

describe('the route policy opens exactly one voice route (AC2)', () => {
  it('stt is allowed and request-scoped; every other voice route stays laptop-only', () => {
    expect(ROUTE_POLICY['POST /api/agent/voice/stt']).toMatchObject({ allow: true, scope: 'request', body: 'json' });
    const others = Object.keys(ROUTE_POLICY).filter((k) => k.includes('/api/agent/voice/') && k !== 'POST /api/agent/voice/stt');
    expect(others.sort()).toEqual([
      'GET /api/agent/voice/dictation', 'GET /api/agent/voice/status', 'POST /api/agent/voice/dictation',
      'POST /api/agent/voice/focus', 'POST /api/agent/voice/log', 'POST /api/agent/voice/tts', 'POST /api/agent/voice/warm',
      'PUT /api/agent/voice/config',
    ]);
    for (const k of others) expect(ROUTE_POLICY[k].allow).toBe(false);
  });

  it('the dashboard\'s mirror agrees: the phone may send stt and nothing else of voice', () => {
    setPhoneSurfaceForTests('mac');
    try {
      expect(MAC_DENIED_API_ROUTES).not.toContain('POST /api/agent/voice/stt');
      expect(phoneAllows('POST', '/api/agent/voice/stt')).toBe(true);
      for (const [m, p] of [['POST', '/api/agent/voice/tts'], ['POST', '/api/agent/voice/warm'], ['GET', '/api/agent/voice/status'], ['POST', '/api/agent/voice/focus'], ['GET', '/api/agent/voice/dictation']]) {
        expect(phoneAllows(m, p)).toBe(false);
      }
    } finally { setPhoneSurfaceForTests(null); }
  });
});

describe('a forged header over the tunnel (review r1)', () => {
  it('a phone take with a forged byteRate past 2 minutes is refused before whisper runs', async () => {
    const r = makeRes();
    await handleVoiceStt(makeReq(wav(PHONE_MAX_STT_SECONDS + 5, 16_000, undefined, { byteRate: 0x7fffffff }), true), r.res, {}, home);
    expect(r.status()).toBe(413);
    expect(inference).not.toHaveBeenCalled();
  });
  it('a phone take in an 8 kHz 8-bit shape is refused', async () => {
    const r = makeRes();
    await handleVoiceStt(makeReq(wav(3, 8_000, undefined, { bits: 8 }), true), r.res, {}, home);
    expect(r.status()).toBe(413);
    expect(inference).not.toHaveBeenCalled();
  });
});
