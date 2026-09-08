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
  findWhisper, modelName, cleanWhisperText, languageFor, forgetDetectedLanguage,
  transcribeLocal, primerFrom,
} from '../../src/lib/voice/whisper.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-whisper-'));
  forgetDetectedLanguage();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  forgetDetectedLanguage();
});

/** A plausible install: a binary and a model file big enough to be real. */
function fakeInstall(name = 'ggml-large-v3-turbo.bin') {
  const bin = join(dir, 'whisper-server');
  const model = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
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

describe('which language is sent', () => {
  it('sends the PIN when Settings has one', () => {
    expect(languageFor('tr')).toBe('tr');
  });

  it('asks for detection when there is nothing pinned and nothing remembered', () => {
    // Not "sends no field": whisper.cpp's default is ENGLISH, and omitting it is how a Turkish
    // take came back transliterated and in capitals. Measured, not assumed.
    expect(languageFor('auto')).toBe('auto');
    expect(languageFor(undefined)).toBe('auto');
  });
});

describe('sticky detection', () => {
  /** A whisper-server answering with `body`, so the module's own bookkeeping can be observed
   *  without a model. */
  function serverAnswering(body: unknown) {
    return vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (String(url).endsWith('/inference')) {
        return { ok: true, status: 200, json: async () => body, form: init?.body };
      }
      return { ok: true, status: 404, json: async () => ({}) };   // the readiness probe
    });
  }

  it('remembers the language the first take detected, and pins it on the next', async () => {
    // The whole point: detection is an extra pass, ~1.75s against ~0.88s once it is known.
    const install = fakeInstall();
    const fetchMock = serverAnswering({ text: ' merhaba ', language: 'turkish' });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof globalThis.fetch);
    const first = await transcribeLocal(Buffer.from('RIFF'), { language: 'auto', install });
    expect(first?.text).toBe('merhaba');
    expect(languageFor('auto')).toBe('turkish');   // whisper takes its own name back as a pin
  });

  it('FORGETS it when a take comes back empty — the likeliest sign the pin was wrong', async () => {
    const install = fakeInstall();
    vi.stubGlobal('fetch', serverAnswering({ text: ' ', language: 'turkish' }) as unknown as typeof globalThis.fetch);
    await transcribeLocal(Buffer.from('RIFF'), { language: 'auto', install });
    expect(languageFor('auto')).toBe('auto');
  });

  it('never lets a remembered language override an explicit pin', async () => {
    const install = fakeInstall();
    vi.stubGlobal('fetch', serverAnswering({ text: 'merhaba', language: 'turkish' }) as unknown as typeof globalThis.fetch);
    await transcribeLocal(Buffer.from('RIFF'), { language: 'auto', install });
    expect(languageFor('en')).toBe('en');
  });
});

describe('cleaning what whisper returns', () => {
  it('strips the padding and the wrap it adds mid-sentence', () => {
    expect(cleanWhisperText(' Dremontext taskını güncelle\n et.\n')).toBe('Dremontext taskını güncelle et.');
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
