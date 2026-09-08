/**
 * The server half of J.A.R.V.I.S mode: the key store, the model resolver, the caps, and the
 * two audio routes' posture.
 *
 * The criteria these stand behind:
 *   AC12 — the caps hold when the client is bypassed (a direct POST past the cap is refused).
 *   AC13 — no OpenRouter error body reaches the client, and the key appears in nothing.
 *   AC14 — no key degrades to text and SAYS what is missing; one failed take is retryable.
 *   AC3b — model ids are resolved from the catalogue; a rename is a clear config error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  readVoiceConfig, writeVoiceConfig, voiceConfigPath, voiceApiKey, voiceStatus, DEFAULT_VOICE,
} from '../../src/lib/voice/config.js';
import {
  resolveModel, clearModelCache, redactKey, MODEL_PREFERENCES,
} from '../../src/lib/voice/openrouter.js';
import {
  VoiceGate, sttGate, ttsGate, MAX_STT_BYTES, MAX_TTS_CHARS,
} from '../../src/lib/voice/limits.js';
import {
  handleVoiceStt, handleVoiceTts, handleVoiceStatus, handleVoiceConfigPut, isWav,
  transcriptFrom, JARVIS_INSTRUCTIONS, JARVIS_FEWSHOT, TRANSCRIBE_ASK,
} from '../../src/server/routes/agent-voice.js';

// ── harness ──────────────────────────────────────────────────────────────────────────────

function makeRes() {
  let statusCode = 0;
  let headers: Record<string, string | number> = {};
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (c: Buffer) => { chunks.push(Buffer.from(c)); });
  const res = Object.assign(sink, {
    setHeader(name: string, value: string) { headers[name] = value; },
    writeHead(code: number, hdrs?: Record<string, string | number>) {
      statusCode = code;
      headers = { ...headers, ...(hdrs ?? {}) };
      return res;
    },
    get headersSent() { return statusCode !== 0; },
  }) as unknown as ServerResponse;
  const raw = () => (chunks.length ? Buffer.concat(chunks) : undefined);
  return {
    res,
    status: () => statusCode,
    header: (n: string) => headers[n],
    raw,
    body: () => {
      const buf = raw();
      if (buf === undefined) return undefined;
      try { return JSON.parse(buf.toString('utf-8')); } catch { return buf.toString('utf-8'); }
    },
  };
}

/** A request whose body is `payload` — a real stream, since the STT route caps per chunk. */
function makeReq(payload: Buffer | string = '', headers: Record<string, string> = {}): IncomingMessage {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const stream = Readable.from(buf.length ? [buf] : []) as unknown as IncomingMessage;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  (stream as unknown as { method: string }).method = 'POST';
  (stream as unknown as { url: string }).url = '/api/agent/voice/stt';
  (stream as unknown as { destroy: () => void }).destroy = () => {};
  return stream;
}

let home: string;

/**
 * Save and restore the three env vars this file touches INDIVIDUALLY.
 *
 * Not `process.env = {...saved}`: assigning a fresh object to `process.env` swaps out the
 * live binding, after which `process.env.HOME = x` writes to a plain JS object and the real
 * process environment never changes. `os.homedir()` reads the REAL environment, so every
 * later test in the file silently resolved the developer's own home instead of the temp one
 * — and, because a real home has no voice.json, they all failed as "no key" while passing
 * in isolation. Found the hard way; left written down so it is not re-introduced.
 */
const TOUCHED = [
  'HOME', 'OPENROUTER_API_KEY', 'DREAMCONTEXT_DESKTOP', 'PATH',
  'DREAMCONTEXT_WHISPER_BIN', 'DREAMCONTEXT_WHISPER_MODEL',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'dc-voice-'));
  process.env.HOME = home;
  delete process.env.OPENROUTER_API_KEY;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  clearModelCache();
  sttGate.reset();
  ttsGate.reset();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── the key store ────────────────────────────────────────────────────────────────────────

describe('the voice key store', () => {
  it('writes voice.json at mode 0600 — the same secrecy class as a Claude account', () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-secret' }, home);
    const mode = statSync(voiceConfigPath(home)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('leaves an absent file as an EMPTY config rather than throwing', () => {
    expect(readVoiceConfig(home)).toEqual({});
    expect(voiceApiKey(home)).toBeNull();
  });

  it('treats a CORRUPT file as "no key" instead of breaking the app', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(voiceConfigPath(home), '{ not json');
    expect(readVoiceConfig(home)).toEqual({});
    expect(voiceStatus(home).key).toBe(false);
  });

  it('merges a patch instead of replacing — saving the voice cannot blank the key', () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-secret' }, home);
    writeVoiceConfig({ voice: 'ash' }, home);
    expect(readVoiceConfig(home)).toEqual({ openRouterKey: 'sk-or-secret', voice: 'ash' });
  });

  it('clears a field with null — how Settings removes the key without a second verb', () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-secret' }, home);
    writeVoiceConfig({ openRouterKey: null }, home);
    expect(voiceApiKey(home)).toBeNull();
  });

  it('NEVER reports the key itself — voiceStatus carries a boolean (AC13)', () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-secret' }, home);
    const status = voiceStatus(home);
    expect(status.key).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sk-or-secret');
    expect(status.voice).toBe(DEFAULT_VOICE);
    expect(status.sttLanguage).toBe('auto');
  });

  it('reads NO OpenAI key, ever — the owner\'s explicit instruction', () => {
    const src = readFileSync('src/lib/voice/config.ts', 'utf-8')
      + readFileSync('src/lib/voice/openrouter.ts', 'utf-8')
      + readFileSync('src/server/routes/agent-voice.ts', 'utf-8');
    expect(src).not.toMatch(/OPENAI_API_KEY|api\.openai\.com/);
  });
});

// ── model resolution (AC3b) ──────────────────────────────────────────────────────────────

function catalogue(ids: string[]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
    text: async () => '',
  })) as unknown as typeof globalThis.fetch;
}

describe('model resolution', () => {
  it('resolves an id from the live catalogue, never a hardcoded one', async () => {
    const r = await resolveModel('transcription', {
      key: 'k', fetchImpl: catalogue(['openai/gpt-audio-mini', 'x/y']),
    });
    expect(r).toEqual({ ok: true, id: 'openai/gpt-audio-mini' });
  });

  it('matches a VERSION-SUFFIXED id, so a date bump needs no code change', async () => {
    const r = await resolveModel('speech', {
      key: 'k', fetchImpl: catalogue(['openai/gpt-audio-mini-2026-11-01']),
    });
    expect(r).toEqual({ ok: true, id: 'openai/gpt-audio-mini-2026-11-01' });
  });

  it('walks the preference order and falls through to the next live model', async () => {
    // The CORRECTION pass is what still resolves against the catalogue. The audio ids do not
    // and must not: `/models` lists chat models only, so resolving `whisper-large-v3-turbo`
    // there reports "no model matched" for a model that transcribes perfectly well. That
    // mistake is why this file no longer resolves anything audio.
    const r = await resolveModel('correction', {
      key: 'k', fetchImpl: catalogue(['anthropic/claude-haiku-4.5']),
    });
    expect(r).toEqual({ ok: true, id: 'anthropic/claude-haiku-4.5' });
  });

  it('A RENAME IS A CLEAR CONFIGURATION ERROR, not a silent 404 on first press (AC3b)', async () => {
    const r = await resolveModel('transcription', {
      key: 'k', fetchImpl: catalogue(['some/entirely-different-model']),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('no_match');
    // It must NAME what it looked for, or the owner has nothing to act on.
    for (const pref of MODEL_PREFERENCES.transcription) expect(r.detail).toContain(pref);
  });

  it('says "no key" without touching the network', async () => {
    const fetchImpl = catalogue([]);
    const r = await resolveModel('speech', { key: null, fetchImpl });
    expect(r).toEqual({ ok: false, reason: 'no_key', detail: expect.stringContaining('No OpenRouter key') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('memoises, so a resolution is not a network round trip per push-to-talk', async () => {
    const fetchImpl = catalogue(['openai/gpt-audio-mini']);
    await resolveModel('transcription', { key: 'k', fetchImpl });
    await resolveModel('transcription', { key: 'k', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT forward an upstream error body when the catalogue rejects (AC13)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({}),
      text: async () => 'invalid key sk-or-leaked-value',
    })) as unknown as typeof globalThis.fetch;
    const r = await resolveModel('speech', { key: 'sk-or-leaked-value', fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.detail).not.toContain('sk-or-leaked-value');
    expect(r.detail).not.toContain('invalid key');
    // Logged server-side, but with the key redacted out of the body.
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('upstream 401');
    expect(logged).not.toContain('sk-or-leaked-value');
  });
});

describe('redactKey', () => {
  it('removes the configured key AND anything key-shaped', () => {
    const out = redactKey('used sk-or-aaaaaaaaaaaa and sk-or-bbbbbbbbbbbb', 'sk-or-aaaaaaaaaaaa');
    expect(out).not.toContain('sk-or-aaaaaaaaaaaa');
    expect(out).not.toContain('sk-or-bbbbbbbbbbbb');
  });
});

// ── the caps (AC12) ──────────────────────────────────────────────────────────────────────

describe('the server-side caps', () => {
  it('refuses past the concurrency limit and recovers on release', () => {
    const gate = new VoiceGate({ concurrency: 2, perWindow: 100, windowMs: 1000 });
    expect(gate.acquire()).toBe('ok');
    expect(gate.acquire()).toBe('ok');
    expect(gate.acquire()).toBe('busy');
    gate.release();
    expect(gate.acquire()).toBe('ok');
  });

  it('refuses past the per-window limit, and forgets once the window rolls', () => {
    const gate = new VoiceGate({ concurrency: 10, perWindow: 2, windowMs: 1000 });
    expect(gate.acquire(0)).toBe('ok');
    gate.release();
    expect(gate.acquire(10)).toBe('ok');
    gate.release();
    expect(gate.acquire(20)).toBe('rate');
    expect(gate.acquire(1500)).toBe('ok');
  });

  it('pins the documented ceilings', () => {
    expect(MAX_STT_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_TTS_CHARS).toBe(2000);
  });
});

// ── the routes ───────────────────────────────────────────────────────────────────────────

/** A WAV body of `n` sample bytes — the only container the audio API accepts. */
function wavBody(n = 64): Buffer {
  const pcm = Buffer.alloc(n);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, pcm]);
}

/** A believable whisper install in a temp dir, for the local-path tests. */
function whisperStub(): { bin: string; model: string } {
  const bin = join(home, 'whisper-server');
  const model = join(home, 'ggml-large-v3-turbo.bin');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  writeFileSync(model, Buffer.alloc(2_000_000));
  return { bin, model };
}

/** The catalogue answer — only the CORRECTION pass resolves against it now; the audio ids
 *  are deliberately not resolved (see `AUDIO_MODELS`). */
const MODELS_OK = {
  ok: true, status: 200, text: async () => '',
  json: async () => ({ data: [{ id: 'openai/gpt-audio-mini' }] }),
};

/** An upstream SSE response carrying `frames`, exactly as the streaming API delivers them. */
function sseResponse(frames: unknown[], status = 200) {
  const body = `${frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
  return {
    ok: status < 400,
    status,
    text: async () => body,
    json: async () => ({}),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        // Split across chunks on purpose: an SSE line arriving in two pieces is the normal
        // case, and a parser that only works on whole lines passes a single-chunk test.
        const bytes = new TextEncoder().encode(body);
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    }),
  };
}

/** One audio delta carrying `bytes` of pcm16. */
const audioFrame = (bytes: number[]) => ({
  choices: [{ delta: { audio: { data: Buffer.from(bytes).toString('base64') } } }],
});

describe('POST /api/agent/voice/stt', () => {
  // Every test in this block is about the CLOUD path, so local transcription is switched off
  // explicitly. Leaving it on `auto` would make these tests pass or fail depending on whether
  // the machine running them happens to have whisper.cpp installed — the exact class of test
  // that goes green on CI and red on a laptop.
  beforeEach(() => { writeVoiceConfig({ sttEngine: 'cloud' }, home); });

  it('403s outside the desktop app (AC15\'s server half)', async () => {
    process.env.DREAMCONTEXT_DESKTOP = '0';
    const r = makeRes();
    await handleVoiceStt(makeReq('x'), r.res, {}, home);
    expect(r.status()).toBe(403);
    expect(r.body().error).toBe('desktop_only');
  });

  it('with NO key answers stt_unconfigured and says what is missing (AC14)', async () => {
    // A real WAV, because the container guard now runs before the key check: the body has to
    // be read either way, and a take in the wrong format is not a key problem.
    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody(), { 'content-type': 'audio/wav' }), r.res, {}, home);
    expect(r.body().error).toBe('stt_unconfigured');
    expect(r.body().message).toMatch(/OpenRouter key/i);
  });

  it('refuses a DIRECT POST once the cap is taken — 429 stt_busy (AC12)', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    expect(sttGate.acquire()).toBe('ok');
    expect(sttGate.acquire()).toBe('ok');
    const r = makeRes();
    await handleVoiceStt(makeReq('x'), r.res, {}, home);
    expect(r.status()).toBe(429);
    expect(r.body().error).toBe('stt_busy');
  });

  it('refuses a take that is not a WAV, on the MAGIC BYTES rather than the header', async () => {
    // The upstream format enum is `wav` or `mp3` and nothing else, so a webm take is a 400
    // from a provider several seconds after the button was released. Caught here instead, and
    // caught on the bytes: what matters is the audio, not what somebody labelled it.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    vi.stubGlobal('fetch', (vi.fn(async () => MODELS_OK)) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceStt(makeReq(Buffer.from('not a wav'), { 'content-type': 'audio/wav' }), r.res, {}, home);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('stt_unconfigured');
    expect(isWav(wavBody())).toBe(true);
    expect(isWav(Buffer.from('RIFFxxxxAVI '))).toBe(false);
  });

  it('NEVER forwards the upstream error body, and stays RETRYABLE (AC13, AC14)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeVoiceConfig({ openRouterKey: 'sk-or-secret-value' }, home);
    vi.stubGlobal('fetch', (vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({}),
      text: async () => 'upstream exploded, key sk-or-secret-value, trace 0xdeadbeef',
    }))) as unknown as typeof globalThis.fetch);

    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody(), { 'content-type': 'audio/wav' }), r.res, {}, home);
    const raw = r.raw()!.toString('utf-8');
    expect(r.body().error).toBe('stt_failed');
    expect(raw).not.toContain('sk-or-secret-value');
    expect(raw).not.toContain('0xdeadbeef');
    expect(raw).not.toContain('upstream exploded');
    expect(sttGate.state.inFlight).toBe(0);
  });

  it('uses the TRANSCRIPTION endpoint and a real speech recogniser', async () => {
    // Not a chat completion any more: `openai/whisper-large-v3-turbo` is absent from the
    // `/models` catalogue but present on this endpoint, and on the same Turkish take it was
    // both the cheapest ($0.0001) and the most accurate of the ids that answer there.
    writeVoiceConfig({ openRouterKey: 'sk-or-x', sttEngine: 'cloud' }, home);
    let url = '';
    let form: FormData | undefined;
    vi.stubGlobal('fetch', (vi.fn(async (u: string, init?: { body?: unknown }) => {
      url = String(u);
      form = init?.body as FormData;
      return { ok: true, status: 200, text: async () => '', json: async () => ({ text: ' sleep başlat ' }) };
    })) as unknown as typeof globalThis.fetch);

    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody(), { 'content-type': 'audio/wav' }), r.res, {}, home);
    expect(r.status()).toBe(200);
    expect(r.body().text).toBe('sleep başlat');
    expect(url).toContain('/audio/transcriptions');
    expect(form!.get('model')).toBe('openai/whisper-large-v3-turbo');
    // NO language is sent by default: whisper detects it, so nothing in this feature has to
    // know or ask which language is being spoken.
    expect(form!.get('language')).toBeNull();
  });

  it('pins the language only when Settings asked for one', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x', sttEngine: 'cloud', sttLanguage: 'tr' }, home);
    let form: FormData | undefined;
    vi.stubGlobal('fetch', (vi.fn(async (_u: string, init?: { body?: unknown }) => {
      form = init?.body as FormData;
      return { ok: true, status: 200, text: async () => '', json: async () => ({ text: 'ok' }) };
    })) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody(), { 'content-type': 'audio/wav' }), r.res, {}, home);
    expect(form!.get('language')).toBe('tr');
  });

  it('prefers GROQ when a key is set — same model, its own hardware', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x', groqKey: 'gsk_test', sttEngine: 'cloud' }, home);
    const seen: string[] = [];
    vi.stubGlobal('fetch', (vi.fn(async (u: string) => {
      seen.push(String(u));
      return { ok: true, status: 200, text: async () => '', json: async () => ({ text: 'ok' }) };
    })) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody(), { 'content-type': 'audio/wav' }), r.res, {}, home);
    expect(seen[0]).toContain('api.groq.com');
    expect(r.body().engine).toBe('groq:whisper-large-v3-turbo');
  });

  it('falls through to OpenRouter when Groq refuses, rather than failing the take', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeVoiceConfig({ openRouterKey: 'sk-or-x', groqKey: 'gsk_bad', sttEngine: 'cloud' }, home);
    vi.stubGlobal('fetch', (vi.fn(async (u: string) => (
      String(u).includes('groq')
        ? { ok: false, status: 401, text: async () => 'bad key', json: async () => ({}) }
        : { ok: true, status: 200, text: async () => '', json: async () => ({ text: 'ok' }) }
    ))) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody(), { 'content-type': 'audio/wav' }), r.res, {}, home);
    expect(r.status()).toBe(200);
    expect(r.body().engine).toBe('openrouter:openai/whisper-large-v3-turbo');
  });

  it('reads the transcript whether the content is a string or content PARTS', () => {
    expect(transcriptFrom('  sleep başlat ')).toBe('sleep başlat');
    expect(transcriptFrom([{ type: 'text', text: 'sleep' }, { type: 'text', text: 'başlat' }])).toBe('sleep başlat');
    // The failure this guards: a transcript that quietly became "[object Object]" would be
    // submitted to a TOOL-ENABLED agent as if the owner had said it.
    expect(transcriptFrom({ weird: true })).toBe('');
    expect(transcriptFrom(undefined)).toBe('');
  });
});

describe('local transcription is tried FIRST, and falls back rather than failing', () => {
  it('answers from the local engine without ever reaching OpenRouter', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x', sttEngine: 'auto' }, home);
    const upstream = vi.fn(async () => MODELS_OK);
    vi.stubGlobal('fetch', (vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes('127.0.0.1')) {
        // the readiness probe, then the inference
        if (url.endsWith('/inference')) {
          return { ok: true, status: 200, json: async () => ({ text: ' merhaba ', language: 'turkish' }) };
        }
        return { ok: true, status: 404, json: async () => ({}) };
      }
      return upstream();
    })) as unknown as typeof globalThis.fetch);
    process.env.DREAMCONTEXT_WHISPER_BIN = whisperStub().bin;
    process.env.DREAMCONTEXT_WHISPER_MODEL = whisperStub().model;

    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody(), { 'content-type': 'audio/wav' }), r.res, {}, home);
    expect(r.status()).toBe(200);
    expect(r.body().text).toBe('merhaba');
    expect(String(r.body().engine)).toMatch(/^local:/);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('says so plainly when local is REQUIRED and missing, instead of quietly spending money', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x', sttEngine: 'local' }, home);
    process.env.DREAMCONTEXT_WHISPER_BIN = '/nonexistent/whisper-server';
    process.env.PATH = '/nonexistent';
    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody(), { 'content-type': 'audio/wav' }), r.res, {}, home);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('stt_unconfigured');
    expect(r.body().message).toMatch(/whisper/i);
  });
});

describe('POST /api/agent/voice/tts', () => {
  it('403s outside the desktop app', async () => {
    process.env.DREAMCONTEXT_DESKTOP = '0';
    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'hi' })), r.res, {}, home);
    expect(r.status()).toBe(403);
  });

  it('refuses an over-long chunk from a direct POST (AC12)', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'a'.repeat(MAX_TTS_CHARS + 1) })), r.res, {}, home);
    expect(r.status()).toBe(413);
    expect(r.body().error).toBe('tts_busy');
  });

  it('with no key says the mode still works as text (AC14)', async () => {
    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'hi' })), r.res, {}, home);
    expect(r.body().error).toBe('tts_unconfigured');
    expect(r.body().message).toMatch(/text/i);
  });

  it('streams pcm16 and returns a playable WAV, carrying the verbatim persona', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    let sent: {
      model?: string; stream?: boolean; modalities?: string[];
      audio?: { voice?: string; format?: string };
      messages?: Array<{ role: string; content: string }>;
    } | undefined;
    vi.stubGlobal('fetch', (vi.fn(async (u: string, init?: { body?: unknown }) => {
      if (String(u).endsWith('/models')) return MODELS_OK;
      sent = JSON.parse(String(init?.body));
      return sseResponse([
        // A transcript delta with no bytes — the words the model says it is speaking. They
        // must MATCH the line, or the chunk is refused (see the verbatim tests below).
        { choices: [{ delta: { audio: { transcript: 'bak, ekrana koyuyorum' } } }] },
        audioFrame([1, 2, 3, 4]),
        audioFrame([5, 6]),
      ]);
    })) as unknown as typeof globalThis.fetch);

    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'bak, ekrana koyuyorum' })), r.res, {}, home);
    expect(r.status()).toBe(200);
    expect(r.header('Content-Type')).toBe('audio/wav');
    // STREAMING is not a preference: the API refuses audio output without it, and refuses
    // mp3 with it. So the header goes back on here.
    expect(sent!.stream).toBe(true);
    expect(sent!.modalities).toEqual(['text', 'audio']);
    expect(sent!.audio!.format).toBe('pcm16');
    expect(sent!.audio!.voice).toBe(DEFAULT_VOICE);
    expect(sent!.model).toBe('openai/gpt-audio-mini');
    // The persona is what makes a CHAT model a TTS engine: without the verbatim rule it
    // answers the sentence instead of reading it.
    expect(sent!.messages![0]).toEqual({ role: 'system', content: JARVIS_INSTRUCTIONS });
    expect(JARVIS_INSTRUCTIONS).toMatch(/VERBATIM/);
    // The few-shot rides between the persona and the line: the wording alone still let short
    // lines be answered, and these two turns are what closed them.
    expect(sent!.messages!.slice(1, 5)).toEqual(JARVIS_FEWSHOT.map((m) => ({ ...m })));
    expect(sent!.messages![5].content).toContain('ekrana koyuyorum');

    const out = r.raw()!;
    expect(out.toString('ascii', 0, 4)).toBe('RIFF');
    expect(out.toString('ascii', 8, 12)).toBe('WAVE');
    expect(out.readUInt32LE(24)).toBe(24000);           // the rate the stream is generated at
    expect(out.length).toBe(44 + 6);                    // header + both audio deltas
  });

  // ── The model answering the line instead of reading it ──────────────────────────────
  //
  // Measured on the owner's key, this is the mode's loudest failure and it is NOT rare: with
  // the old prompt, 5 of 7 conversational lines came back as a fresh answer, so the voice held
  // one conversation while the transcript showed another. The prompt made it rare; these two
  // tests are what make it harmless, because the residue is stochastic.

  it('retries once when the spoken words are not the line — the failure is stochastic', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    let calls = 0;
    vi.stubGlobal('fetch', (vi.fn(async (u: string) => {
      if (String(u).endsWith('/models')) return MODELS_OK;
      calls += 1;
      // First attempt: an ANSWER, measured verbatim from the live model.
      if (calls === 1) {
        return sseResponse([
          { choices: [{ delta: { audio: {
            transcript: 'Anladım. Şu anda sesim net bir şekilde geliyor mu? Bu konuda bana daha fazla bilgi verebilir misin?',
          } } }] },
          audioFrame([9, 9, 9, 9]),
        ]);
      }
      // Second: the same line, read.
      return sseResponse([
        { choices: [{ delta: { audio: { transcript: 'Evet, duyuyorum. Net geliyor.' } } }] },
        audioFrame([1, 2, 3, 4]),
      ]);
    })) as unknown as typeof globalThis.fetch);

    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'Evet, duyuyorum. Net geliyor.' })), r.res, {}, home);
    expect(r.status()).toBe(200);
    expect(calls).toBe(2);
    // The RETRY's audio is what goes back, not the answer's.
    expect(r.raw()!.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('hands a line the chat model will not read to a REAL tts, instead of dropping it', async () => {
    // Both attempts came back as an answer rather than a reading. The old behaviour was to
    // drop the sentence — a hole in the speech the owner can only find by reading the screen.
    // `google/gemini-3.1-flash-tts-preview` cannot make this mistake: it has no conversation
    // to have. It is the fallback and not the default because it is 2.4x slower.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    let chatCalls = 0;
    let speechModel = '';
    vi.stubGlobal('fetch', (vi.fn(async (u: string, init?: { body?: unknown }) => {
      const url = String(u);
      if (url.endsWith('/models')) return MODELS_OK;
      if (url.endsWith('/audio/speech')) {
        speechModel = JSON.parse(String(init?.body)).model;
        return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
      }
      chatCalls += 1;
      return sseResponse([
        { choices: [{ delta: { audio: {
          transcript: 'Tabii, şimdi o zaman bir konu seçebiliriz. Seni daha çok hangi ilgi alanı çekiyor?',
        } } }] },
        audioFrame([7, 7, 7, 7]),
      ]);
    })) as unknown as typeof globalThis.fetch);

    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'Söyle, hangi konuya girelim.' })), r.res, {}, home);
    expect(chatCalls).toBe(2);                       // tried, retried, then handed it over
    expect(speechModel).toBe('google/gemini-3.1-flash-tts-preview');
    expect(r.status()).toBe(200);
    expect(r.raw()!.toString('ascii', 0, 4)).toBe('RIFF');
  });

  it('speaks unverified audio rather than muting the mode, when no transcript arrives', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    vi.stubGlobal('fetch', (vi.fn(async (u: string) => {
      if (String(u).endsWith('/models')) return MODELS_OK;
      // Bytes, no `transcript` field anywhere — a provider that stops sending it must not
      // turn the check into a second way for the right words to go missing.
      return sseResponse([audioFrame([1, 2, 3, 4])]);
    })) as unknown as typeof globalThis.fetch);

    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'Bir şey söyle.' })), r.res, {}, home);
    expect(r.status()).toBe(200);
  });

  it('204s when the model answered in words only — the queue skips and walks on', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    vi.stubGlobal('fetch', (vi.fn(async (u: string) => {
      if (String(u).endsWith('/models')) return MODELS_OK;
      return sseResponse([{ choices: [{ delta: { content: 'I would rather not.' } }] }]);
    })) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'one chunk' })), r.res, {}, home);
    expect(r.status()).toBe(204);
    expect(ttsGate.state.inFlight).toBe(0);
  });

  it('treats an error INSIDE the stream as a failure, though the status line said 200', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeVoiceConfig({ openRouterKey: 'sk-or-secret-value' }, home);
    vi.stubGlobal('fetch', (vi.fn(async (u: string) => {
      if (String(u).endsWith('/models')) return MODELS_OK;
      return sseResponse([{ error: { message: 'rate limited, key sk-or-secret-value' } }]);
    })) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'one chunk' })), r.res, {}, home);
    expect(r.body().error).toBe('tts_failed');
    expect(r.raw()!.toString()).not.toContain('sk-or-secret-value');
    expect(ttsGate.state.inFlight).toBe(0);
  });

  it('a failed chunk answers tts_failed and releases the gate — the queue skips and walks on (AC10)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    vi.stubGlobal('fetch', (vi.fn(async (u: string) => {
      if (String(u).endsWith('/models')) return MODELS_OK;
      return { ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited upstream' };
    })) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'one chunk' })), r.res, {}, home);
    expect(r.body().error).toBe('tts_failed');
    expect(r.raw()!.toString()).not.toContain('rate limited upstream');
    expect(ttsGate.state.inFlight).toBe(0);
  });
});

describe('PUT /api/agent/voice/config', () => {
  it('stores a chord canonically and reports it back', async () => {
    const r = makeRes();
    await handleVoiceConfigPut(makeReq(JSON.stringify({ pushToTalk: 'Shift+Alt+KeyJ' })), r.res);
    expect(r.status()).toBe(200);
    expect(r.body().pushToTalk).toBe('Alt+Shift+KeyJ');
  });

  it('REFUSES a chord the composer could not match, rather than storing it', async () => {
    // The one field where refusing beats clamping: a rate out of range still plays, but a
    // binding with no modifier would be swallowed app-wide and never reach the mic. Settings
    // is the only place the owner can be told.
    const r = makeRes();
    await handleVoiceConfigPut(makeReq(JSON.stringify({ pushToTalk: 'KeyJ' })), r.res);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('bad_hotkey');
    const after = makeRes();
    await handleVoiceStatus(makeReq(), after.res);
    expect(after.body().pushToTalk).toBe('Alt+Space');
  });

  it('null resets the chord to the default', async () => {
    await handleVoiceConfigPut(makeReq(JSON.stringify({ pushToTalk: 'Control+F9' })), makeRes().res);
    const r = makeRes();
    await handleVoiceConfigPut(makeReq(JSON.stringify({ pushToTalk: null })), r.res);
    expect(r.body().pushToTalk).toBe('Alt+Space');
  });

  it('clamps the speaking rate and carries the speech toggle', async () => {
    const r = makeRes();
    await handleVoiceConfigPut(makeReq(JSON.stringify({ speechRate: 12, speech: false })), r.res);
    expect(r.body().speechRate).toBe(1.75);
    expect(r.body().speech).toBe(false);
  });

  it('a patch that names one field leaves the key alone', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-secret-value' }, home);
    const r = makeRes();
    await handleVoiceConfigPut(makeReq(JSON.stringify({ speechRate: 1.15 })), r.res);
    expect(r.body().key).toBe(true);
    expect(r.raw()!.toString()).not.toContain('sk-or-secret-value');
  });
});

// ── posture, read off the server's own wiring ────────────────────────────────────────────

describe('route posture', () => {
  const index = readFileSync('src/server/index.ts', 'utf-8');

  it('registers all four routes', () => {
    expect(index).toContain("router.post('/api/agent/voice/stt', handleVoiceStt)");
    expect(index).toContain("router.post('/api/agent/voice/tts', handleVoiceTts)");
    expect(index).toContain("router.get('/api/agent/voice/status', handleVoiceStatus)");
    expect(index).toContain("router.put('/api/agent/voice/config', handleVoiceConfigPut)");
  });

  it('classifies STT as vault-SCOPED and TTS as vault-AGNOSTIC — explicitly, not by accident', () => {
    const list = index.match(/const VAULT_AGNOSTIC_PREFIXES = \[[^\]]*\]/)![0];
    // STT reads the vault's brain for the lexicon, so it must NOT be agnostic.
    expect(list).not.toContain('/api/agent/voice/stt');
    expect(list).toContain('/api/agent/voice/tts');
    expect(list).toContain('/api/agent/voice/status');
    expect(list).toContain('/api/agent/voice/config');
    // And the prefix match must not swallow /stt via a shorter entry.
    expect(list).not.toMatch(/'\/api\/agent\/voice'/);
  });
});
