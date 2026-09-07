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
  handleVoiceStt, handleVoiceTts, handleVoiceStatus, uploadFilenameFor, JARVIS_INSTRUCTIONS,
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
const TOUCHED = ['HOME', 'OPENROUTER_API_KEY', 'DREAMCONTEXT_DESKTOP'] as const;
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
      key: 'k', fetchImpl: catalogue(['openai/gpt-4o-mini-transcribe', 'x/y']),
    });
    expect(r).toEqual({ ok: true, id: 'openai/gpt-4o-mini-transcribe' });
  });

  it('matches a VERSION-SUFFIXED id, so a date bump needs no code change', async () => {
    const r = await resolveModel('speech', {
      key: 'k', fetchImpl: catalogue(['openai/gpt-4o-mini-tts-2026-11-01']),
    });
    expect(r).toEqual({ ok: true, id: 'openai/gpt-4o-mini-tts-2026-11-01' });
  });

  it('walks the preference order and falls through to the next live model', async () => {
    const r = await resolveModel('transcription', {
      key: 'k', fetchImpl: catalogue(['openai/whisper-large-v3']),
    });
    expect(r).toEqual({ ok: true, id: 'openai/whisper-large-v3' });
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
    const fetchImpl = catalogue(['openai/gpt-4o-mini-transcribe']);
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

describe('POST /api/agent/voice/stt', () => {
  it('403s outside the desktop app (AC15\'s server half)', async () => {
    process.env.DREAMCONTEXT_DESKTOP = '0';
    const r = makeRes();
    await handleVoiceStt(makeReq('x'), r.res, {}, home);
    expect(r.status()).toBe(403);
    expect(r.body().error).toBe('desktop_only');
  });

  it('with NO key answers stt_unconfigured and says what is missing (AC14)', async () => {
    const r = makeRes();
    await handleVoiceStt(makeReq('x'), r.res, {}, home);
    expect(r.body().error).toBe('stt_unconfigured');
    expect(r.body().message).toMatch(/OpenRouter key/i);
  });

  it('refuses a DIRECT POST once the cap is taken — 429 stt_busy (AC12)', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    // Fill the gate as if two takes were already upstream.
    expect(sttGate.acquire()).toBe('ok');
    expect(sttGate.acquire()).toBe('ok');
    const r = makeRes();
    await handleVoiceStt(makeReq('x'), r.res, {}, home);
    expect(r.status()).toBe(429);
    expect(r.body().error).toBe('stt_busy');
  });

  it('NEVER forwards the upstream error body, and stays RETRYABLE (AC13, AC14)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeVoiceConfig({ openRouterKey: 'sk-or-secret-value' }, home);
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'openai/gpt-4o-mini-transcribe' }] }), text: async () => '' };
      }
      return {
        ok: false, status: 500, json: async () => ({}),
        text: async () => 'upstream exploded, key sk-or-secret-value, trace 0xdeadbeef',
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof globalThis.fetch);

    const r = makeRes();
    await handleVoiceStt(makeReq(Buffer.from('audio-bytes'), { 'content-type': 'audio/webm' }), r.res, {}, home);
    const raw = r.raw()!.toString('utf-8');
    // `stt_failed`, not `stt_unconfigured`: this take blew up, a retry is fine.
    expect(r.body().error).toBe('stt_failed');
    expect(raw).not.toContain('sk-or-secret-value');
    expect(raw).not.toContain('0xdeadbeef');
    expect(raw).not.toContain('upstream exploded');
    // The gate was released, so the very next take is not blocked by the failed one.
    expect(sttGate.state.inFlight).toBe(0);
  });

  it('sends NO `prompt` — OpenRouter documents it as accepted and ignored', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    let form: FormData | undefined;
    const fetchMock = vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'openai/gpt-4o-mini-transcribe' }] }), text: async () => '' };
      }
      form = init?.body as FormData;
      return { ok: true, status: 200, json: async () => ({ text: 'sleep başlat' }), text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof globalThis.fetch);

    const r = makeRes();
    await handleVoiceStt(makeReq(Buffer.from('bytes'), { 'content-type': 'audio/mp4' }), r.res, {}, home);
    expect(r.status()).toBe(200);
    expect(r.body().text).toBe('sleep başlat');
    expect(form!.get('prompt')).toBeNull();
    expect(form!.get('model')).toBe('openai/gpt-4o-mini-transcribe');
    // `auto` is the default, so no language is pinned unless Settings pinned one (AC4).
    expect(form!.get('language')).toBeNull();
  });

  it('pins the STT language when Settings set one — AC4\'s escape hatch', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x', sttLanguage: 'tr' }, home);
    let form: FormData | undefined;
    vi.stubGlobal('fetch', (vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'openai/gpt-4o-mini-transcribe' }] }), text: async () => '' };
      }
      form = init?.body as FormData;
      return { ok: true, status: 200, json: async () => ({ text: 'ok' }), text: async () => '' };
    })) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceStt(makeReq(Buffer.from('bytes'), { 'content-type': 'audio/webm' }), r.res, {}, home);
    expect(form!.get('language')).toBe('tr');
  });

  it('uploads the recorded container AS-IS — there is no conversion step anywhere', () => {
    expect(uploadFilenameFor('audio/mp4')).toBe('take.m4a');       // what WebKit produces
    expect(uploadFilenameFor('audio/webm;codecs=opus')).toBe('take.webm');
    expect(uploadFilenameFor('audio/ogg')).toBe('take.ogg');
    expect(uploadFilenameFor(undefined)).toBe('take.webm');
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

  it('carries the JARVIS persona in `instructions` — the character, not a second provider', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', (vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'openai/gpt-4o-mini-tts' }] }), text: async () => '' };
      }
      sent = JSON.parse(String(init?.body));
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, text: async () => '' };
    })) as unknown as typeof globalThis.fetch);

    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'bak, ekrana koyuyorum' })), r.res, {}, home);
    expect(r.status()).toBe(200);
    expect(r.header('Content-Type')).toBe('audio/mpeg');
    expect(sent!.instructions).toBe(JARVIS_INSTRUCTIONS);
    expect(sent!.response_format).toBe('mp3');
    expect(sent!.model).toBe('openai/gpt-4o-mini-tts');
    expect(sent!.voice).toBe(DEFAULT_VOICE);
  });

  it('a failed chunk answers tts_failed and releases the gate — the queue skips and walks on (AC10)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeVoiceConfig({ openRouterKey: 'sk-or-x' }, home);
    vi.stubGlobal('fetch', (vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'openai/gpt-4o-mini-tts' }] }), text: async () => '' };
      }
      return { ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited upstream' };
    })) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceTts(makeReq(JSON.stringify({ text: 'one chunk' })), r.res, {}, home);
    expect(r.body().error).toBe('tts_failed');
    expect(r.raw()!.toString()).not.toContain('rate limited upstream');
    expect(ttsGate.state.inFlight).toBe(0);
  });
});

describe('GET /api/agent/voice/status', () => {
  it('reports a BOOLEAN key and never the key itself', async () => {
    writeVoiceConfig({ openRouterKey: 'sk-or-secret-value' }, home);
    const r = makeRes();
    await handleVoiceStatus(makeReq(), r.res);
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
