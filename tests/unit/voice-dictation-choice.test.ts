/**
 * Dictation's engine CHOICE (owner, 2026-10-27): turning voice on used to download and load
 * `large-v3-turbo` with no question asked, and on 8 GB MacBook Airs the app went down. These
 * stand behind the fix:
 *
 *   AC1 — nothing is downloaded or loaded without an explicit choice (the consent gate);
 *   AC2 — the recommended size follows the machine's memory and chip;
 *   AC3 — no eager load: warming loads nothing, the first take does, idle and load unload it;
 *   AC4 — the cloud engine is OpenRouter's transcription endpoint, honoured by `/stt`;
 *   AC5 — too-big / failed loads answer a clear message; an old turbo file is never deleted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  recommendModel, fitsMachine, isHighEndChip, WHISPER_MODELS, type MachineInfo,
} from '../../src/lib/voice/whisperModels.js';
import {
  startDictationInstall, dictationState, dictationInstallSettled, resetDictationInstall,
  parseDictationChoice, ChoiceRequired, InstallRunning, resolveDictation, modelUrl,
} from '../../src/lib/voice/dictationInstall.js';
import {
  transcribeLocal, stopWhisperServer, whisperLoaded, checkPressure, setPressureReader,
  findModel, localBlocked, clearLoadFailure, IDLE_UNLOAD_MS, PRESSURE_POLL_MS, modelName,
} from '../../src/lib/voice/whisper.js';
import { transcribeCloud, TRANSCRIPTION_MODELS } from '../../src/lib/voice/openrouter.js';
import { writeVoiceConfig, readVoiceConfig, voiceConfigPath } from '../../src/lib/voice/config.js';
import {
  handleVoiceStt, handleVoiceWarm, handleDictationInstall,
} from '../../src/server/routes/agent-voice.js';
import { sttGate } from '../../src/lib/voice/limits.js';
import { sttRetryable } from '../../dashboard/src/lib/voice/useVoiceCapture.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GB = 1024 ** 3;
const AIR_8: MachineInfo = { memBytes: 8 * GB, cpuModel: 'Apple M2', cores: 8 };
const AIR_16: MachineInfo = { memBytes: 16 * GB, cpuModel: 'Apple M3', cores: 8 };
const PRO_16: MachineInfo = { memBytes: 16 * GB, cpuModel: 'Apple M3 Pro', cores: 12 };
const BIG_32: MachineInfo = { memBytes: 32 * GB, cpuModel: 'Apple M1', cores: 8 };
const TINY_4: MachineInfo = { memBytes: 4 * GB, cpuModel: 'Intel(R) Core(TM) i5', cores: 4 };

let dir: string;
const TOUCHED = ['HOME', 'OPENROUTER_API_KEY', 'DREAMCONTEXT_DESKTOP', 'DREAMCONTEXT_WHISPER_BIN', 'DREAMCONTEXT_WHISPER_MODEL'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'dc-dictation-choice-'));
  process.env.HOME = dir;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  delete process.env.OPENROUTER_API_KEY;
  // The bare env is the "nothing installed" machine unless a test says otherwise.
  process.env.DREAMCONTEXT_WHISPER_BIN = join(dir, 'no-such-whisper-server');
  delete process.env.DREAMCONTEXT_WHISPER_MODEL;
  resetDictationInstall();
  clearLoadFailure();
  sttGate.reset();
  setPressureReader(async () => ({ pressed: false, why: null }));
});

afterEach(() => {
  stopWhisperServer();
  setPressureReader(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A whisper-server that stays up (so "loaded" is observable) and a model file. */
function liveInstall(file = 'ggml-small.bin') {
  const bin = join(dir, 'whisper-server');
  writeFileSync(bin, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const model = join(dir, file);
  writeFileSync(model, Buffer.alloc(2_000_000));
  return { bin, model, modelName: modelName(model) };
}

/** whisper-server's HTTP side: up, and answering one inference. */
function serverAnswering(text = 'merhaba') {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith('/inference')) return { ok: true, status: 200, json: async () => ({ text, language: 'turkish' }) };
    return { ok: true, status: 404, json: async () => ({}) };
  });
}

function wavBody(): Buffer {
  const b = Buffer.alloc(44 + 3200);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(3200, 40);
  return b;
}

function makeReq(payload: Buffer | string = '', url = '/api/agent/voice/stt'): IncomingMessage {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const stream = Readable.from(buf.length ? [buf] : []) as unknown as IncomingMessage;
  Object.assign(stream, { headers: { 'content-type': Buffer.isBuffer(payload) ? 'audio/wav' : 'application/json' }, method: 'POST', url, destroy: () => {} });
  return stream;
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
    body: () => JSON.parse(Buffer.concat(chunks).toString('utf-8')),
  };
}

// ── AC2: the machine tier ─────────────────────────────────────────────────────────────────

describe('the recommended model follows the machine', () => {
  it('≤ 8 GB → small, under that → base', () => {
    expect(recommendModel(AIR_8)).toBe('small');
    expect(recommendModel(TINY_4)).toBe('base');
    // `totalmem()` reads a little under the label: 7.9 GB is still the 8 GB Air.
    expect(recommendModel({ ...AIR_8, memBytes: 7.9 * GB })).toBe('small');
  });

  it('16 GB on an ordinary chip → medium; 16 GB on a Pro/Max/Ultra → turbo', () => {
    expect(recommendModel(AIR_16)).toBe('medium');
    expect(recommendModel(PRO_16)).toBe('large-v3-turbo');
    expect(isHighEndChip('Apple M2 Max')).toBe(true);
    expect(isHighEndChip('Apple M2')).toBe(false);
  });

  it('32 GB and up → turbo', () => {
    expect(recommendModel(BIG_32)).toBe('large-v3-turbo');
  });

  it('an 8 GB Mac cannot carry medium or turbo; 16 GB carries all of them', () => {
    const turbo = WHISPER_MODELS.find((m) => m.id === 'large-v3-turbo')!;
    const small = WHISPER_MODELS.find((m) => m.id === 'small')!;
    expect(fitsMachine(turbo.ramMB, AIR_8)).toBe(false);
    expect(fitsMachine(small.ramMB, AIR_8)).toBe(true);
    for (const m of WHISPER_MODELS) expect(fitsMachine(m.ramMB, AIR_16)).toBe(true);
  });

  it('the picker carries download size, memory need and the recommendation', () => {
    const s = dictationState({ machine: AIR_8, home: dir });
    expect(s.recommended).toBe('small');
    expect(s.machine.memGB).toBe(8);
    const turbo = s.models.find((m) => m.id === 'large-v3-turbo')!;
    expect(turbo.downloadMB).toBeGreaterThan(1000);
    expect(turbo.ramMB).toBeGreaterThan(2000);
    expect(turbo.fits).toBe(false);
  });
});

// ── AC1: the consent gate ────────────────────────────────────────────────────────────────

describe('nothing is downloaded without a choice', () => {
  it('a bare POST (what setup used to send) is 400 choice_required and fetches nothing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = makeRes();
    await handleDictationInstall(makeReq('', '/api/agent/voice/dictation'), r.res);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('choice_required');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(voiceConfigPath(dir))).toBe(false);
  });

  it('the choice parser accepts only cloud, or local with a known size', () => {
    expect(parseDictationChoice({ engine: 'cloud' })).toEqual({ engine: 'cloud', model: null });
    expect(parseDictationChoice({ engine: 'local', model: 'small' })).toEqual({ engine: 'local', model: 'small' });
    expect(() => parseDictationChoice({ engine: 'local' })).toThrow(ChoiceRequired);
    expect(() => parseDictationChoice({ engine: 'local', model: 'huge' })).toThrow(ChoiceRequired);
    expect(() => parseDictationChoice(null)).toThrow(ChoiceRequired);
  });

  it('no choice and nothing here → not ready, choice null, no engine route', () => {
    const s = dictationState({ machine: AIR_8, home: dir });
    expect(s.choice).toBeNull();
    expect(s.installed).toBe(false);
    expect(resolveDictation({ machine: AIR_8, home: dir }).engine).toBe('none');
  });

  it('a too-big model on an 8 GB Mac is REFUSED before any download, and not stored', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const s = startDictationInstall({ engine: 'local', model: 'large-v3-turbo' }, { machine: AIR_8, home: dir, fetchImpl });
    await dictationInstallSettled();
    expect(s.phase).toBe('error');
    expect(s.error).toMatch(/small or the cloud/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readVoiceConfig(dir).dictationEngine).toBeUndefined();
  });

  it('the CHOSEN size is what is downloaded — small, not turbo', async () => {
    const bin = join(dir, 'whisper-server');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    const env = { DREAMCONTEXT_WHISPER_BIN: bin, DREAMCONTEXT_WHISPER_MODEL: join(dir, 'models', 'ggml-small.bin') };
    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(String(url));
      return new Response(new Uint8Array(4096), { status: 200, headers: { 'content-length': '4096' } });
    }) as unknown as typeof fetch;
    startDictationInstall({ engine: 'local', model: 'small' }, { env, home: dir, machine: AIR_8, fetchImpl, modelHome: join(dir, 'models'), minBytes: 1024 });
    await dictationInstallSettled();
    expect(fetched).toEqual([modelUrl('ggml-small.bin')]);
    expect(readVoiceConfig(dir)).toMatchObject({ dictationEngine: 'local', dictationModel: 'small' });
    // Installing never LOADS it.
    expect(whisperLoaded()).toBe(false);
  });

  it('choosing the cloud installs nothing and is ready once a key is set', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    let s = startDictationInstall({ engine: 'cloud', model: null }, { home: dir, machine: AIR_8, fetchImpl });
    expect(s.installed).toBe(false);
    expect(s.choice).toEqual({ engine: 'cloud', model: null });
    writeVoiceConfig({ openRouterKey: 'sk-or-test' }, dir);
    s = dictationState({ home: dir, machine: AIR_8 });
    expect(s.installed).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── AC3: no eager load ───────────────────────────────────────────────────────────────────

describe('the model loads on the first take, never at launch', () => {
  it('POST /voice/warm (what the composer sent on every launch) loads NOTHING', async () => {
    const install = liveInstall('ggml-large-v3-turbo.bin');
    process.env.DREAMCONTEXT_WHISPER_BIN = install.bin;
    process.env.DREAMCONTEXT_WHISPER_MODEL = install.model;
    const r = makeRes();
    await handleVoiceWarm(makeReq(''), r.res);
    expect(r.body()).toEqual({ warming: null });
    expect(whisperLoaded()).toBe(false);
  });

  it('the composer no longer asks to warm the model when assistant mode opens', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/chat/Composer.tsx'), 'utf-8');
    expect(src).not.toContain("'/api/agent/voice/warm'");
  });

  it('setup no longer starts an install by itself', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/components/assistant/AssistantWizardSteps.tsx'), 'utf-8');
    expect(src).not.toMatch(/DictationInstall autoStart/);
  });

  it('a take loads it, and it is unloaded after the idle window', async () => {
    vi.stubGlobal('fetch', serverAnswering() as unknown as typeof globalThis.fetch);
    const install = liveInstall();
    expect(whisperLoaded()).toBe(false);
    const out = await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install });
    expect(out?.text).toBe('merhaba');
    expect(whisperLoaded()).toBe(true);
    vi.useFakeTimers();
    // Re-armed by a take under fake timers, then the idle window passes.
    await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install });
    vi.advanceTimersByTime(IDLE_UNLOAD_MS + 1);
    expect(whisperLoaded()).toBe(false);
  });
});

// ── the owner's addition: out of RAM under load ─────────────────────────────────────────

describe('under machine load the model is unloaded and not reloaded', () => {
  it('pressure unloads a loaded model at once', async () => {
    vi.stubGlobal('fetch', serverAnswering() as unknown as typeof globalThis.fetch);
    const install = liveInstall();
    await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install });
    expect(whisperLoaded()).toBe(true);
    setPressureReader(async () => ({ pressed: true, why: 'memory' }));
    const reading = await checkPressure();
    expect(reading.pressed).toBe(true);
    expect(whisperLoaded()).toBe(false);
  });

  it('the watch that runs while loaded finds the pressure by itself', async () => {
    vi.stubGlobal('fetch', serverAnswering() as unknown as typeof globalThis.fetch);
    const install = liveInstall();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const pending = transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install });
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(whisperLoaded()).toBe(true);
    setPressureReader(async () => ({ pressed: true, why: 'heat' }));
    await vi.advanceTimersByTimeAsync(PRESSURE_POLL_MS + 1);
    expect(whisperLoaded()).toBe(false);
  });

  it('/stt under pressure refuses with a clear message and loads nothing; with the load gone, it loads', async () => {
    const install = liveInstall();
    process.env.DREAMCONTEXT_WHISPER_BIN = install.bin;
    process.env.DREAMCONTEXT_WHISPER_MODEL = install.model;
    writeVoiceConfig({ dictationEngine: 'local', dictationModel: 'small' }, dir);
    vi.stubGlobal('fetch', serverAnswering() as unknown as typeof globalThis.fetch);
    setPressureReader(async () => ({ pressed: true, why: 'memory' }));
    let r = makeRes();
    await handleVoiceStt(makeReq(wavBody()), r.res, {}, dir);
    // This take only: not `stt_unconfigured` (which reads as "not set up"), and not retryable.
    expect(r.status()).toBe(409);
    expect(r.body().error).toBe('stt_pressure');
    expect(sttRetryable(409, 'stt_pressure')).toBe(false);
    expect(r.body().message).toMatch(/short on memory/);
    expect(whisperLoaded()).toBe(false);

    setPressureReader(async () => ({ pressed: false, why: null }));
    r = makeRes();
    await handleVoiceStt(makeReq(wavBody()), r.res, {}, dir);
    expect(r.status()).toBe(200);
    expect(r.body().engine).toBe('local:small');
    expect(whisperLoaded()).toBe(true);
  });
});

// ── AC4: the cloud engine ────────────────────────────────────────────────────────────────

describe('cloud dictation through OpenRouter', () => {
  it('posts the documented JSON shape (raw base64 input_audio, wav, ISO language)', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ text: ' merhaba dünya ' }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await transcribeCloud(wavBody(), { key: 'sk-or-test', language: 'tr', fetchImpl });
    expect(out).toMatchObject({ ok: true, text: 'merhaba dünya', model: TRANSCRIPTION_MODELS[0] });
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(calls[0].body.model).toBe('openai/whisper-large-v3-turbo');
    expect(calls[0].body.language).toBe('tr');
    const audio = calls[0].body.input_audio as { data: string; format: string };
    expect(audio.format).toBe('wav');
    expect(audio.data.startsWith('data:')).toBe(false);
    expect(Buffer.from(audio.data, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  });

  it('tries the next model on a model error, stops at once on a key error', async () => {
    let n = 0;
    const missing = (async () => { n += 1; return new Response('no such model', { status: 404 }); }) as unknown as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await transcribeCloud(wavBody(), { key: 'k', fetchImpl: missing })).ok).toBe(false);
    expect(n).toBe(TRANSCRIPTION_MODELS.length);
    n = 0;
    const unauthorized = (async () => { n += 1; return new Response('bad key', { status: 401 }); }) as unknown as typeof fetch;
    expect((await transcribeCloud(wavBody(), { key: 'k', fetchImpl: unauthorized })).ok).toBe(false);
    expect(n).toBe(1);
  });

  it('/stt with the cloud chosen goes to OpenRouter and never loads a model', async () => {
    writeVoiceConfig({ dictationEngine: 'cloud', openRouterKey: 'sk-or-test' }, dir);
    const urls: string[] = [];
    vi.stubGlobal('fetch', (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ text: 'selam' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody()), r.res, {}, dir);
    expect(r.status()).toBe(200);
    expect(r.body().text).toBe('selam');
    expect(String(r.body().engine)).toMatch(/^cloud:/);
    expect(urls.every((u) => u.startsWith('https://openrouter.ai/'))).toBe(true);
    expect(whisperLoaded()).toBe(false);
  });

  it('cloud chosen without a key says so instead of failing silently', async () => {
    writeVoiceConfig({ dictationEngine: 'cloud' }, dir);
    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody()), r.res, {}, dir);
    expect(r.status()).toBe(400);
    expect(r.body().message).toMatch(/OpenRouter key/);
  });
});

// ── AC5: graceful refusals, and nothing deleted ───────────────────────────────────────

describe('a model that cannot run is refused, never crashed into', () => {
  it('an old turbo on an 8 GB Mac is not picked up without a choice — and stays on disk', () => {
    const models = join(dir, 'models');
    rmSync(models, { recursive: true, force: true });
    const turbo = join(dir, 'ggml-large-v3-turbo.bin');
    writeFileSync(turbo, Buffer.alloc(2_000_000));
    expect(findModel({}, { machine: AIR_8, dirs: [dir] })).toBeNull();
    expect(findModel({}, { machine: BIG_32, dirs: [dir] })).toBe(turbo);
    expect(existsSync(turbo)).toBe(true);
  });

  it('a chosen model the machine cannot carry is blocked as too_big, with a message naming the fix', async () => {
    const install = liveInstall('ggml-large-v3-turbo.bin');
    expect(localBlocked(install, AIR_8)).toBe('too_big');
    expect(localBlocked(install, BIG_32)).toBeNull();
  });

  it('a model that dies while loading is remembered — the retry does not load it again', async () => {
    const bin = join(dir, 'whisper-server');
    writeFileSync(bin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const model = join(dir, 'ggml-small.bin');
    writeFileSync(model, Buffer.alloc(2_000_000));
    const install = { bin, model, modelName: 'small' };
    // The HTTP side never comes up: the process is gone.
    vi.stubGlobal('fetch', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install });
    expect(out).toBeNull();
    expect(localBlocked(install, BIG_32)).toBe('load_failed');
  });
});

describe('stopping a server whose spawn failed signals nobody', () => {
  it('a non-executable binary: the take fails cleanly and stopping is a no-op, not a group kill', async () => {
    // Measured 2026-10-27: Node's `kill()` on a child that never got a pid sent SIGTERM to the
    // whole process group (exit 143). If this test can finish, nothing was signalled.
    const bin = join(dir, 'whisper-server');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const model = join(dir, 'ggml-small.bin');
    writeFileSync(model, Buffer.alloc(2_000_000));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch);
    const out = await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install: { bin, model, modelName: 'small' } });
    expect(out).toBeNull();
    stopWhisperServer();
    expect(whisperLoaded()).toBe(false);
  });
});

// ── fixes from the end review ───────────────────────────────────────────────────────────

describe('review fixes: a choice during a download, and its timing', () => {
  function slowDownload() {
    let finish!: () => void;
    const gate = new Promise<void>((r) => { finish = r; });
    const fetchImpl = (async () => {
      await gate;
      return new Response(new Uint8Array(4096), { status: 200, headers: { 'content-length': '4096' } });
    }) as unknown as typeof fetch;
    return { fetchImpl, finish };
  }

  it('a new choice while a download runs is REFUSED (409 install_running), never silently dropped', async () => {
    const bin = join(dir, 'whisper-server');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    const env = { DREAMCONTEXT_WHISPER_BIN: bin, DREAMCONTEXT_WHISPER_MODEL: join(dir, 'models', 'ggml-small.bin') };
    const { fetchImpl, finish } = slowDownload();
    startDictationInstall({ engine: 'local', model: 'small' }, { env, home: dir, machine: AIR_8, fetchImpl, modelHome: join(dir, 'models'), minBytes: 1024 });
    expect(() => startDictationInstall({ engine: 'cloud', model: null }, { env, home: dir, machine: AIR_8 })).toThrow(InstallRunning);
    finish();
    await dictationInstallSettled();
  });

  it('the old choice keeps dictating through the download; the new one is stored only when whole', async () => {
    writeVoiceConfig({ dictationEngine: 'cloud', openRouterKey: 'sk-or-x' }, dir);
    const bin = join(dir, 'whisper-server');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    const env = { DREAMCONTEXT_WHISPER_BIN: bin, DREAMCONTEXT_WHISPER_MODEL: join(dir, 'models', 'ggml-small.bin') };
    const { fetchImpl, finish } = slowDownload();
    const s = startDictationInstall({ engine: 'local', model: 'small' }, { env, home: dir, machine: AIR_8, fetchImpl, modelHome: join(dir, 'models'), minBytes: 1024 });
    expect(s.pending).toBe('small');
    expect(readVoiceConfig(dir).dictationEngine).toBe('cloud');
    finish();
    await dictationInstallSettled();
    expect(readVoiceConfig(dir)).toMatchObject({ dictationEngine: 'local', dictationModel: 'small' });
  });

  it('a failed download leaves the previous choice in place', async () => {
    writeVoiceConfig({ dictationEngine: 'cloud', openRouterKey: 'sk-or-x' }, dir);
    const bin = join(dir, 'whisper-server');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    const env = { DREAMCONTEXT_WHISPER_BIN: bin, DREAMCONTEXT_WHISPER_MODEL: join(dir, 'models', 'ggml-small.bin') };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    startDictationInstall({ engine: 'local', model: 'small' }, { env, home: dir, machine: AIR_8, fetchImpl, modelHome: join(dir, 'models'), minBytes: 1024 });
    await dictationInstallSettled();
    expect(readVoiceConfig(dir).dictationEngine).toBe('cloud');
    expect(dictationState({ env, home: dir, machine: AIR_8 }).phase).toBe('error');
  });
});

describe('review fixes: stops we make are not load failures, and no take is cut off', () => {
  it('a server WE stop while it loads is not remembered as a model that failed', async () => {
    const install = liveInstall();
    // The HTTP side is not up yet: the load is "in progress" when the pressure stop lands.
    vi.stubGlobal('fetch', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch);
    const take = transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install });
    await new Promise((r) => setTimeout(r, 50));
    expect(whisperLoaded()).toBe(true);
    stopWhisperServer();
    expect(await take).toBeNull();
    expect(localBlocked(install, BIG_32)).toBeNull();
  });

  it('pressure during a take waits for it to finish, then unloads', async () => {
    const install = liveInstall();
    let answer!: () => void;
    const held = new Promise<void>((r) => { answer = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/inference')) {
        await held;
        return { ok: true, status: 200, json: async () => ({ text: 'bitti', language: 'turkish' }) };
      }
      return { ok: true, status: 404, json: async () => ({}) };
    }) as unknown as typeof globalThis.fetch);
    const take = transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install });
    await new Promise((r) => setTimeout(r, 50));
    setPressureReader(async () => ({ pressed: true, why: 'memory' }));
    await checkPressure();
    expect(whisperLoaded()).toBe(true);           // mid-inference: not cut off
    answer();
    expect((await take)?.text).toBe('bitti');
    expect(whisperLoaded()).toBe(false);          // …and unloaded the moment it finished
  });

  it('our own loaded model is credited back: its memory alone is not "pressure"', async () => {
    vi.stubGlobal('fetch', serverAnswering() as unknown as typeof globalThis.fetch);
    const install = liveInstall();
    await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install });
    const seen: Array<number | undefined> = [];
    setPressureReader(async (o) => { seen.push(o?.loadedMB); return { pressed: false, why: null }; });
    await checkPressure();
    expect(seen[0]).toBe(1000);                    // small's memory, handed to the reading
    expect(whisperLoaded()).toBe(true);
  });

  it('a take for a different model stops the old server first', async () => {
    vi.stubGlobal('fetch', serverAnswering() as unknown as typeof globalThis.fetch);
    const small = liveInstall('ggml-small.bin');
    await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install: small });
    const base = { ...small, model: join(dir, 'ggml-base.bin'), modelName: 'base' };
    writeFileSync(base.model, Buffer.alloc(2_000_000));
    const out = await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install: base });
    expect(out?.model).toBe('base');
  });
});

describe('review fixes: cloud error codes', () => {
  it('a refused key is permanent (stt_unconfigured), not a retry loop', async () => {
    writeVoiceConfig({ dictationEngine: 'cloud', openRouterKey: 'sk-or-revoked' }, dir);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (u: string) => { calls.push(String(u)); return new Response('unauthorized', { status: 401 }); }) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody()), r.res, {}, dir);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('stt_unconfigured');
    expect(r.body().message).toMatch(/refused the key/);
    expect(calls).toHaveLength(1);
  });

  it('a take the provider refuses is final for that take (400 stt_failed, not retried), after one request', async () => {
    writeVoiceConfig({ dictationEngine: 'cloud', openRouterKey: 'sk-or-x' }, dir);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (u: string) => { calls.push(String(u)); return new Response('audio too long', { status: 413 }); }) as unknown as typeof globalThis.fetch);
    const r = makeRes();
    await handleVoiceStt(makeReq(wavBody()), r.res, {}, dir);
    expect(r.status()).toBe(400);
    expect(sttRetryable(400, r.body().error)).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('review fix: a 400 that merely mentions "model" is final, not a model switch', () => {
  it('"exceeds the model\'s maximum duration" costs one request', async () => {
    let n = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tooLong = (async () => { n += 1; return new Response("audio exceeds the model's maximum duration", { status: 400 }); }) as unknown as typeof fetch;
    expect(await transcribeCloud(wavBody(), { key: 'k', fetchImpl: tooLong })).toEqual({ ok: false, reason: 'rejected' });
    expect(n).toBe(1);
    n = 0;
    const unknown = (async () => { n += 1; return new Response('Model openai/whisper-large-v3-turbo does not exist', { status: 400 }); }) as unknown as typeof fetch;
    await transcribeCloud(wavBody(), { key: 'k', fetchImpl: unknown });
    expect(n).toBe(TRANSCRIPTION_MODELS.length);
  });
});
