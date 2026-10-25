/**
 * `POST /api/agent/voice/retranscribe` — a chat's agent re-runs ONE take it received (task
 * sesli-giris-bozuk…, AC6): own take only, own vault only, never over the phone, capped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleVoiceRetranscribe, handleVoiceConfigPut, resetRetranscribeCaps } from '../../src/server/routes/agent-voice.js';
import { readVoiceConfig, writeVoiceConfig } from '../../src/lib/voice/config.js';
import { keepTake, bindTake } from '../../src/lib/voice/voiceLog.js';
import { mintWindowToken, WINDOW_TOKEN_HEADER } from '../../src/lib/window-control.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { sttGate } from '../../src/lib/voice/limits.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';

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
  return { res, status: () => statusCode, body: () => JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') };
}

function makeReq(body: unknown, token?: string, o: { phone?: boolean; remote?: string } = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  const socket: Record<string, unknown> = { remoteAddress: o.remote ?? '127.0.0.1' };
  if (o.phone) markPhoneSocket(socket);
  Object.assign(stream, { headers: token ? { [WINDOW_TOKEN_HEADER]: token } : {}, method: 'POST', socket });
  return stream;
}

const TOUCHED = ['HOME', 'DREAMCONTEXT_WHISPER_BIN', 'DREAMCONTEXT_WHISPER_MODEL'] as const;
let saved: Record<string, string | undefined> = {};
let home: string;
let seenLanguage: unknown;
const releases: Array<() => void> = [];

function chat(sessionId: string, contextRoot = '/vault/a'): string {
  const m = mintWindowToken({ send: () => true, vault: 'a', contextRoot, sessionId, mode: 'basic' });
  releases.push(m.release);
  return m.token;
}

function boundTake(session: string, contextRoot = '/vault/a'): string {
  const ref = keepTake(Buffer.from('RIFF....WAVE'), { contextRoot, quality: 'suspect', language: 'is', primary: 'tr' })!;
  expect(bindTake(ref, session, contextRoot)).not.toBeNull();
  return ref;
}

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'dc-retx-'));
  process.env.HOME = home;
  const bin = join(home, 'whisper-server');
  const model = join(home, 'ggml-large-v3-turbo.bin');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  writeFileSync(model, Buffer.alloc(2_000_000));
  process.env.DREAMCONTEXT_WHISPER_BIN = bin;
  process.env.DREAMCONTEXT_WHISPER_MODEL = model;
  seenLanguage = undefined;
  vi.stubGlobal('fetch', (vi.fn(async (u: string, init?: { body?: unknown }) => {
    if (!String(u).endsWith('/inference')) return { ok: true, status: 404, json: async () => ({}) };
    seenLanguage = (init?.body as FormData).get('language');
    return { ok: true, status: 200, json: async () => ({ text: 'Ne durumdayız?', language: 'turkish', segments: [{ start: 0, end: 2, avg_logprob: -0.1 }] }) };
  })) as unknown as typeof globalThis.fetch);
  resetRetranscribeCaps();
  sttGate.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const r of releases.splice(0)) r();
  rmSync(home, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('POST /api/agent/voice/retranscribe', () => {
  it('own take → one pass forced to the take\'s context language', async () => {
    const token = chat('s1');
    const ref = boundTake('s1');
    const r = makeRes();
    await handleVoiceRetranscribe(makeReq({ ref }, token), r.res);
    expect(r.status()).toBe(200);
    expect(seenLanguage).toBe('tr');
    expect(r.body()).toMatchObject({ ref, text: 'Ne durumdayız?', language: 'tr', quality: 'clean' });
  });

  it('no ref → the chat\'s latest take; --language overrides', async () => {
    const token = chat('s1');
    boundTake('s1');
    const r = makeRes();
    await handleVoiceRetranscribe(makeReq({ language: 'english' }, token), r.res);
    expect(r.status()).toBe(200);
    expect(seenLanguage).toBe('en');
  });

  it('another session\'s take → 403; another vault\'s take → 403', async () => {
    const mine = chat('s1');
    const r1 = makeRes();
    await handleVoiceRetranscribe(makeReq({ ref: boundTake('s2') }, mine), r1.res);
    expect(r1.status()).toBe(403);
    const r2 = makeRes();
    await handleVoiceRetranscribe(makeReq({ ref: boundTake('s1', '/vault/b') }, mine), r2.res);
    expect(r2.status()).toBe(403);
  });

  it('unknown or malformed ref → 404; no token → 401; bad language → 400', async () => {
    const token = chat('s1');
    const a = makeRes();
    await handleVoiceRetranscribe(makeReq({ ref: `vt_${'0'.repeat(32)}` }, token), a.res);
    expect(a.status()).toBe(404);
    const b = makeRes();
    await handleVoiceRetranscribe(makeReq({ ref: '../../etc/passwd' }, token), b.res);
    expect(b.status()).toBe(404);
    const c = makeRes();
    await handleVoiceRetranscribe(makeReq({ ref: boundTake('s1') }), c.res);
    expect(c.status()).toBe(401);
    const d = makeRes();
    await handleVoiceRetranscribe(makeReq({ ref: boundTake('s1'), language: 'tr;rm' }, token), d.res);
    expect(d.status()).toBe(400);
    expect(d.body().error).toBe('bad_language');
  });

  it('the phone socket and a non-loopback caller → 403, and the route policy denies it', async () => {
    const token = chat('s1');
    const ref = boundTake('s1');
    const a = makeRes();
    await handleVoiceRetranscribe(makeReq({ ref }, token, { phone: true }), a.res);
    expect(a.status()).toBe(403);
    const b = makeRes();
    await handleVoiceRetranscribe(makeReq({ ref }, token, { remote: '192.168.1.5' }), b.res);
    expect(b.status()).toBe(403);
    expect(ROUTE_POLICY['POST /api/agent/voice/retranscribe']?.allow).toBe(false);
  });

  it('a third retry of one take → 429', async () => {
    const token = chat('s1');
    const ref = boundTake('s1');
    for (let i = 0; i < 2; i++) {
      const r = makeRes();
      await handleVoiceRetranscribe(makeReq({ ref }, token), r.res);
      expect(r.status()).toBe(200);
    }
    const r = makeRes();
    await handleVoiceRetranscribe(makeReq({ ref }, token), r.res);
    expect(r.status()).toBe(429);
  });
});

describe('PUT /api/agent/voice/config — Languages I speak', () => {
  it('normalizes a list and drops unknowns; a non-list is refused (400), never a wipe', async () => {
    const ok = makeRes();
    await handleVoiceConfigPut(makeReq({ sttLanguages: ['Turkish', 'en', 'klingon', '../x'] }), ok.res);
    expect(ok.status()).toBe(200);
    expect(readVoiceConfig(home).sttLanguages).toEqual(['tr', 'en']);
    const bad = makeRes();
    await handleVoiceConfigPut(makeReq({ sttLanguages: 'tr' }), bad.res);
    expect(bad.status()).toBe(400);
    expect(readVoiceConfig(home).sttLanguages).toEqual(['tr', 'en']);
    writeVoiceConfig({ sttLanguages: null }, home);
  });

  it('a pin outside the table is refused (400 bad_language)', async () => {
    const r = makeRes();
    await handleVoiceConfigPut(makeReq({ sttLanguage: 'tr;rm' }), r.res);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('bad_language');
  });
});
