/**
 * The local transcription path: what counts as an install, what language is sent, and the
 * rule that every failure here is a `null` rather than an error.
 *
 * The server itself is not started in these tests — a 1.5 GB model load is not a unit test.
 * What IS tested is everything around it, because that is where the two measured bugs lived:
 * a missing `language` field meaning ENGLISH rather than "detect", and a detection pass that
 * doubled the latency of every take.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findWhisper, modelName, cleanWhisperText, serverArgs,
  transcribeLocal, primerFrom, stopWhisperServer, setPressureReader,
} from '../../src/lib/voice/whisper.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-whisper-'));
});
afterEach(() => {
  stopWhisperServer();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** A plausible install: a binary and a model file big enough to be real. */
function fakeInstall(name = 'ggml-large-v3-turbo.bin') {
  const bin = join(dir, 'whisper-server');
  const model = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });  // a server that stays up
  writeFileSync(model, Buffer.alloc(2_000_000));
  return { bin, model, modelName: modelName(model) };
}

describe('finding an install', () => {
  it('honours the explicit override, binary and model', () => {
    const { bin, model } = fakeInstall();
    const found = findWhisper({ DREAMCONTEXT_WHISPER_BIN: bin, DREAMCONTEXT_WHISPER_MODEL: model });
    expect(found).toEqual({ bin, model, modelName: 'large-v3-turbo' });
  });

  it('is NULL when the binary is not there — the cloud path is the fallback, not an error', () => {
    // Every "not here" answer in this module is a null on purpose: local transcription is an
    // optimisation, and an optimisation that fails loudly is worse than no optimisation.
    expect(findWhisper({ DREAMCONTEXT_WHISPER_BIN: join(dir, 'nope') , PATH: '/nonexistent' })).toBeNull();
  });

  it('names the model the way Settings shows it', () => {
    expect(modelName('/x/y/ggml-large-v3-turbo.bin')).toBe('large-v3-turbo');
    expect(modelName('/x/y/ggml-medium.bin')).toBe('medium');
  });
});

describe('which language is sent (no memory: the caller decides, task sesli-giris…)', () => {
  function serverAnswering(seen: Record<string, unknown>, body: unknown = { text: ' merhaba ', language: 'turkish', segments: [{ start: 0, end: 2, avg_logprob: -0.1, no_speech_prob: 0.01 }] }) {
    return vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (String(url).endsWith('/inference')) {
        const form = init?.body as FormData;
        for (const k of ['language', 'response_format', 'temperature', 'prompt']) seen[k] = form.get(k);
        return { ok: true, status: 200, json: async () => body };
      }
      return { ok: true, status: 404, json: async () => ({}) };   // the readiness probe
    });
  }

  it('sends a normalized pin as given, and `auto` for anything not in the table', async () => {
    const install = fakeInstall();
    const seen: Record<string, unknown> = {};
    vi.stubGlobal('fetch', serverAnswering(seen) as unknown as typeof globalThis.fetch);
    await transcribeLocal(Buffer.from('RIFF'), { language: 'Turkish', install });
    expect(seen.language).toBe('tr');
    await transcribeLocal(Buffer.from('RIFF'), { language: 'tr;rm -rf', install });
    expect(seen.language).toBe('auto');
  });

  it('a detected language is NOT remembered: the next take with no pin detects again', async () => {
    // The old 10-minute memory pinned an Icelandic misdetection onto the next take (measured
    // 2026-10-24, takes 18-32-58 → 18-36-00).
    const install = fakeInstall();
    const seen: Record<string, unknown> = {};
    vi.stubGlobal('fetch', serverAnswering(seen, { text: 'Nei þurfum það', language: 'icelandic', segments: [] }) as unknown as typeof globalThis.fetch);
    const first = await transcribeLocal(Buffer.from('RIFF'), { language: 'auto', install });
    expect(first?.language).toBe('is');
    expect(first?.forced).toBe(false);
    await transcribeLocal(Buffer.from('RIFF'), { install });
    expect(seen.language).toBe('auto');
  });

  it('asks for verbose_json on every pass and hands back the segments garble.ts reads', async () => {
    const install = fakeInstall();
    const seen: Record<string, unknown> = {};
    vi.stubGlobal('fetch', serverAnswering(seen) as unknown as typeof globalThis.fetch);
    const r = await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install });
    expect(seen.response_format).toBe('verbose_json');
    expect(r).toMatchObject({ text: 'merhaba', language: 'tr', forced: true });
    expect(r?.segments[0]).toEqual({ start: 0, end: 2, avg_logprob: -0.1, no_speech_prob: 0.01 });
  });

  it('the loop retry: no primer, a little temperature', async () => {
    const install = fakeInstall();
    const seen: Record<string, unknown> = {};
    vi.stubGlobal('fetch', serverAnswering(seen) as unknown as typeof globalThis.fetch);
    await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install, lexicon: 'dreamcontext', primer: false, temperature: 0.2 });
    expect(seen.prompt).toBeNull();
    expect(seen.temperature).toBe('0.2');
  });

  it('starts the server with -nlp (no language-probability map: verbose_json at json cost)', () => {
    const install = fakeInstall();
    expect(serverArgs(install, 47113, 4)).toContain('-nlp');
  });
});

describe('cleaning what whisper returns', () => {
  it('strips the padding and the wrap it adds mid-sentence', () => {
    expect(cleanWhisperText(' Dremontext taskını güncelle\n et.\n')).toBe('Dremontext taskını güncelle et.');
  });

  it('joins a segment that ends MID-WORD without a space (measured on a real take)', () => {
    // whisper-server, large-v3-turbo, the owner's own recording, 2026-10-13: the segment
    // boundary fell inside "yapabiliyoruz". A new word's segment starts with its own space.
    const raw = ' Bir de bunun faturalandırma zamanlarında ayarlardan yapab\niliyoruz.\n Bunu anlatalım kendisine.\n';
    expect(cleanWhisperText(raw)).toBe('Bir de bunun faturalandırma zamanlarında ayarlardan yapabiliyoruz. Bunu anlatalım kendisine.');
  });

  it('removes the audio DESCRIPTIONS — they are not something anybody said', () => {
    // A tool-enabled agent would receive "[BLANK_AUDIO]" as an instruction typed by the owner.
    expect(cleanWhisperText('[BLANK_AUDIO]')).toBe('');
    expect(cleanWhisperText('(music) tamam (laughter)')).toBe('tamam');
    expect(cleanWhisperText('*sighs* başlat')).toBe('başlat');
  });
});

describe('the vocabulary primer', () => {
  it('is a punctuated SENTENCE, because whisper copies its style', () => {
    // A bare token list came back as transcripts with no commas and no capitals — and the
    // speech chunker breaks on exactly that punctuation.
    const primed = primerFrom('dreamcontext sleep task insight');
    expect(primed).toMatch(/^Bu konuşmada şu terimler geçebilir: /);
    expect(primed).toContain('dreamcontext, sleep, task, insight');
    expect(primed.endsWith('.')).toBe(true);
  });

  it('is empty for an empty lexicon rather than a sentence about nothing', () => {
    expect(primerFrom('   ')).toBe('');
  });
});

describe('the primer is withheld while the language is being DETECTED', () => {
  function serverAnswering(seen: { prompt?: unknown; language?: unknown }) {
    return vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (String(url).endsWith('/inference')) {
        const form = init?.body as FormData;
        seen.prompt = form.get('prompt');
        seen.language = form.get('language');
        return { ok: true, status: 200, json: async () => ({ text: 'merhaba', language: 'turkish' }) };
      }
      return { ok: true, status: 404, json: async () => ({}) };
    });
  }

  it('sends no prompt on the detecting take — an English word list makes whisper hear English', async () => {
    // Measured: primed with the (mostly English) product vocabulary, a Turkish take came back
    // as "DREAM JON TEXT TASKINI GUNCELLE" — detected as English, transliterated and shouting.
    const install = fakeInstall();
    const seen: { prompt?: unknown; language?: unknown } = {};
    vi.stubGlobal('fetch', serverAnswering(seen) as unknown as typeof globalThis.fetch);
    await transcribeLocal(Buffer.from('RIFF'), { language: 'auto', install, lexicon: 'dreamcontext sleep' });
    expect(seen.language).toBe('auto');
    expect(seen.prompt).toBeNull();
  });

  it('sends it once the language is known', async () => {
    const install = fakeInstall();
    const seen: { prompt?: unknown; language?: unknown } = {};
    vi.stubGlobal('fetch', serverAnswering(seen) as unknown as typeof globalThis.fetch);
    await transcribeLocal(Buffer.from('RIFF'), { language: 'tr', install, lexicon: 'dreamcontext sleep' });
    expect(seen.language).toBe('tr');
    expect(String(seen.prompt)).toContain('dreamcontext, sleep');
  });
});
