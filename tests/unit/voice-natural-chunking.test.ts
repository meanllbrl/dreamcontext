/**
 * Spoken replies are cut where a speaker would pause, read with the sentence before them as
 * context, and joined by a breath instead of half a second of dead air.
 *
 * The owner, 2026-10-21: "yanlış cümleyi yanlış yerde bölüyor, akıcı değil, robotik geliyor".
 * Measured on their own replies the same day: 26–27% of chunks ended on a comma, semicolon or
 * colon in the MIDDLE of a sentence (three inside a parenthesis), every chunk was generated
 * cold, and every chunk carried 318–738 ms of trailing silence that the gapless player turned
 * into a pause at every seam. The fixtures below are synthetic (pattern: synthetic fixtures)
 * but shaped like those replies: Turkish first, English alike.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  createSpeechChunker, boundaryOf, SpeechQueue, PREV_CONTEXT_CHARS as CLIENT_PREV_CHARS,
  FIRST_CLAUSE_CHUNK_CHARS, CLAUSE_CHUNK_CHARS, type SpeakFetcher, type SpeakContext,
} from '../../dashboard/src/lib/voice/speechQueue.js';
import type { FocusClient } from '../../dashboard/src/lib/voice/audioFocus.js';
import { adoptVoicePrefs } from '../../dashboard/src/lib/voice/voicePrefs.js';
import { speakable } from '../../src/lib/voice/speakable.js';
import { trimSpeechTail, SENTENCE_TAIL_MS, CLAUSE_TAIL_MS, PCM16_SAMPLE_RATE } from '../../src/lib/voice/wav.js';
import { writeVoiceConfig } from '../../src/lib/voice/config.js';
import { clearModelCache } from '../../src/lib/voice/openrouter.js';
import { ttsGate } from '../../src/lib/voice/limits.js';
import {
  handleVoiceTts, speechMessages, contextLine, lineContinues, scriptLine, CONTINUES_NOTE,
  PREV_CONTEXT_CHARS, JARVIS_FEWSHOT,
} from '../../src/server/routes/agent-voice.js';

/** Feed `text` one character at a time, then end the block. */
function drip(text: string): string[] {
  const c = createSpeechChunker();
  const out: string[] = [];
  for (const ch of text) out.push(...c.push(ch));
  return [...out, ...c.flush()];
}
function whole(text: string): string[] {
  const c = createSpeechChunker();
  return [...c.push(text), ...c.flush()];
}
/** The same reply must cut the same way however the stream slices it. */
function chunks(text: string): string[] {
  const a = drip(text);
  expect(whole(text)).toEqual(a);
  return a;
}

// ── 1. A sentence is the unit ───────────────────────────────────────────────────────────

describe('a sentence is never cut at a comma it can afford to keep', () => {
  it('the owner\'s own shape: a sentence with a comma before "ama" is ONE chunk', () => {
    // voice.jsonl 2026-10-21: "Bu değişiklik bitip kurulana kadar eski kural geçerli," then
    // "ama o zamana kadar işler zaten başlamış durumda." — two takes, a full stop between.
    const reply = 'Ölçüler sadece bilgi olarak görünecek. Bu değişiklik bitip kurulana kadar eski kural geçerli, '
      + 'ama o zamana kadar işler zaten başlamış durumda.';
    expect(chunks(reply)).toEqual([
      'Ölçüler sadece bilgi olarak görünecek.',
      'Bu değişiklik bitip kurulana kadar eski kural geçerli, ama o zamana kadar işler zaten başlamış durumda.',
    ]);
  });

  it('a FIRST sentence up to the trigger is read whole, commas and colon included', () => {
    const first = 'Haklısın, açıklayayım: kendi koyduğum bir kural var, makine yorulunca yeni iş başlatmıyor.';
    expect(first.length).toBeLessThan(FIRST_CLAUSE_CHUNK_CHARS);
    expect(chunks(`${first} Şimdi yük düştü.`)).toEqual([first, 'Şimdi yük düştü.']);
  });

  it('never cuts inside a parenthesis — "(yük 39," was a real chunk', () => {
    const reply = 'Makine yüklüydü (yük 39, normalde 8, bellek de sınırdaydı), o yüzden iş başlamadı ve '
      + 'bekleyen iki işi de sıraya aldım, makine boşalınca hepsini tek tek başlatacağım.';
    expect(reply.length).toBeGreaterThan(FIRST_CLAUSE_CHUNK_CHARS);
    const out = chunks(reply);
    for (const c of out) {
      const opens = (c.match(/\(/g) ?? []).length;
      const closes = (c.match(/\)/g) ?? []).length;
      expect(opens, c).toBe(closes);
    }
    expect(out.join(' ')).toBe(reply);
  });

  it('never cuts inside quotes or inline code', () => {
    const reply = 'Ayarlara "Zorla, Dikkatli, Kapalı" anahtarı eklenecek ve `npm test, tsc` ikisi de koşacak, '
      + 'sonra kurulu sürümde de aynı anahtar görünecek ve sen istediğini seçebileceksin.';
    const out = chunks(reply);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).not.toMatch(/"Zorla,$|`npm test,$/);
    for (const c of out) {
      expect((c.match(/"/g) ?? []).length % 2, c).toBe(0);
      expect((c.match(/`/g) ?? []).length % 2, c).toBe(0);
    }
  });

  it('never cuts a list of numbers — "3, 4 ve 5" is one phrase', () => {
    const buf = 'Bekleyen işleri makine boşalınca sırayla başlatacağım ve önce 3, 4 ve 5 numaralı işler '
      + 'gelecek, diğerleri sonra başlayacak ve sen beklemeyeceksin';
    expect(buf.length).toBeGreaterThan(FIRST_CLAUSE_CHUNK_CHARS);
    const at = boundaryOf(buf, true);
    expect(buf.slice(0, at)).toMatch(/işler gelecek,$/);
  });

  it('prefers a semicolon, colon or dash, then a comma before a conjunction, over a bare comma', () => {
    const strong = 'Bugün üç iş bitti, ikisi kuruldu, biri bekliyor; kalan işler yarın sabah makine boşalınca tek tek başlayacak ve bitince haber vereceğim.';
    expect(chunks(strong)[0].endsWith(';')).toBe(true);
    const conj = 'Bugün üç iş bitti, ikisi kuruldu, biri hâlâ bekliyor ve kurulum sırasında testler kırmızı çıktı, çünkü makine o sırada çok yüklüydü ve testler zaman aşımına düştü.';
    expect(chunks(conj)[0]).toBe('Bugün üç iş bitti, ikisi kuruldu, biri hâlâ bekliyor ve kurulum sırasında testler kırmızı çıktı,');
  });

  it('later sentences wait longer than the first before a clause cut', () => {
    expect(CLAUSE_CHUNK_CHARS).toBeGreaterThan(FIRST_CLAUSE_CHUNK_CHARS);
    const mid = 'Kodu gönderip birleştireceğim, sonra kurulu sürümü yeniden başlatıp sesi bir kez daha deneyeceğim, ardından sana ne duyduğumu yazacağım.';
    expect(mid.length).toBeGreaterThan(FIRST_CLAUSE_CHUNK_CHARS);
    expect(mid.length).toBeLessThan(CLAUSE_CHUNK_CHARS);
    expect(chunks(`Tamam. ${mid}`)).toEqual(['Tamam.', mid]);
  });

  it('an unpunctuated run past the hard cap breaks BEFORE a conjunction, not mid-phrase', () => {
    const run = `${'bu cümlede hiç noktalama yok çünkü dikte edilmiş gibi yazıldı '.repeat(4)}ve sonunda biter`;
    const out = chunks(run);
    expect(out.length).toBeGreaterThan(1);
    expect(out.join(' ')).toBe(run);
    expect(out[1]).toMatch(/^(çünkü|ve) /);
  });
});

// ── 2. What is NOT a sentence end ───────────────────────────────────────────────────────

describe('numbers, versions, abbreviations and initials stay inside their sentence', () => {
  const cases: Array<[string, string[]]> = [
    ['Sürüm 0.33.0 hazır, uygulamayı yeniden başlatabilirsin. Sonra dinle.', ['Sürüm 0.33.0 hazır, uygulamayı yeniden başlatabilirsin.', 'Sonra dinle.']],
    ['Bellek 3,2 GB boş ve takas %75 civarında. Bekliyorum.', ['Bellek 3,2 GB boş ve takas %75 civarında.', 'Bekliyorum.']],
    ['Süre 1.5 saniyeydi. 3. görev bitti. Tamam.', ['Süre 1.5 saniyeydi.', '3. görev bitti.', 'Tamam.']],
    ['Testler, belgeler vs. hepsi geçti. Bitti.', ['Testler, belgeler vs. hepsi geçti.', 'Bitti.']],
    ['Dr. Kaya ve Prof. Demir onayladı. Bitti.', ['Dr. Kaya ve Prof. Demir onayladı.', 'Bitti.']],
    ['Use a short id, e.g. the first eight characters. Done.', ['Use a short id, e.g. the first eight characters.', 'Done.']],
    ['Restart at 9 a.m. tomorrow is fine. Thanks.', ['Restart at 9 a.m. tomorrow is fine.', 'Thanks.']],
    ['Rapor A. Yılmaz tarafından yazıldı. Bitti.', ['Rapor A. Yılmaz tarafından yazıldı.', 'Bitti.']],
    ['Bak: https://example.com/a.b/c sayfası açık. Sonra.', ['Bak: https://example.com/a.b/c sayfası açık.', 'Sonra.']],
    ['Dosya src/lib/voice/wav.ts içinde. Sonra.', ['Dosya src/lib/voice/wav.ts içinde.', 'Sonra.']],
  ];
  for (const [text, want] of cases) {
    it(text, () => { expect(chunks(text)).toEqual(want); });
  }

  it('a sentence ends AFTER closing emphasis, quotes and brackets', () => {
    expect(chunks('**Bitti.** Şimdi kuruyorum.')).toEqual(['**Bitti.**', 'Şimdi kuruyorum.']);
    expect(chunks('Dedi ki: "Tamam." Sonra çıktı.')).toEqual(['Dedi ki: "Tamam."', 'Sonra çıktı.']);
    expect(chunks('(Bu önemli.) Devam ediyorum.')).toEqual(['(Bu önemli.)', 'Devam ediyorum.']);
  });

  it('still ends a real sentence immediately, however short — the first word is waiting', () => {
    const c = createSpeechChunker();
    expect(c.push('Bakıyorum. ')).toEqual(['Bakıyorum.']);
  });
});

// ── 3. What costs no request at all ─────────────────────────────────────────────────────

describe('structure and decoration never reach the speech route', () => {
  it('a table and a horizontal rule are dropped whole, the prose around them is kept', () => {
    const reply = 'Tabloyu koydum.\n| Sürüm | Tarih |\n|---|---|\n| 0.33.0 | 21 Ekim |\n---\nAltı da okunur.\n';
    expect(chunks(reply)).toEqual(['Tabloyu koydum.', 'Altı da okunur.']);
  });

  it('an emoji-only line, a stray marker or a lone bullet is no chunk', () => {
    expect(chunks('Günaydın!\n☀️\n**\nBugün üç iş var.\n')).toEqual(['Günaydın!', 'Bugün üç iş var.']);
  });

  it('a bullet list still reads item by item (a line is still a boundary)', () => {
    expect(chunks('Şunlara bakacak:\n- Türkçe kalitesi\n- İlk sesin gecikmesi\n')).toEqual([
      'Şunlara bakacak:', '- Türkçe kalitesi', '- İlk sesin gecikmesi',
    ]);
  });

  it('speakable reads no commit hash, emoji or task box', () => {
    expect(speakable('Main\'e alınabilir: f09dc690 ve 75ef8906 hazır 🎉')).toBe('Main\'e alınabilir: ve hazır');
    expect(speakable('- [x] Testler yeşil ✅')).toBe('Testler yeşil');
    // A plain number and a hex-looking WORD are words, not hashes.
    expect(speakable('Toplam 1234567 satır, deadbeef adlı dal.')).toBe('Toplam 1234567 satır, deadbeef adlı dal.');
  });
});

// ── 4. The seam ─────────────────────────────────────────────────────────────────────────

function pcm(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
}
const ms = (n: number) => Math.round((n / 1000) * PCM16_SAMPLE_RATE);

describe('the silence after the last word is cut to a breath', () => {
  // 300 ms of "speech" then 600 ms of near-silence — the shape the live model returns.
  const voiced = Array.from({ length: ms(300) }, (_, i) => (i % 2 ? 12000 : -12000));
  const tail = Array.from({ length: ms(600) }, (_, i) => (i % 2 ? 30 : -30));
  const take = pcm([...voiced, ...tail]);

  it('keeps SENTENCE_TAIL_MS after a sentence and CLAUSE_TAIL_MS after a clause', () => {
    expect(trimSpeechTail(take, SENTENCE_TAIL_MS).length / 2).toBe(ms(300) + ms(SENTENCE_TAIL_MS));
    expect(trimSpeechTail(take, CLAUSE_TAIL_MS).length / 2).toBe(ms(300) + ms(CLAUSE_TAIL_MS));
    expect(CLAUSE_TAIL_MS).toBeLessThan(SENTENCE_TAIL_MS);
  });

  it('never cuts into the words, and ends on silence (no click)', () => {
    const out = trimSpeechTail(take, 0);
    expect(out.length / 2).toBeGreaterThanOrEqual(ms(300) - 1);
    expect(Math.abs(out.readInt16LE(out.length - 2))).toBeLessThan(200);
    expect(out.readInt16LE(0)).toBe(take.readInt16LE(0));
  });

  it('leaves a take with no tail, or no speech, untouched', () => {
    const tight = pcm(voiced);
    expect(trimSpeechTail(tight, SENTENCE_TAIL_MS)).toBe(tight);
    const silent = pcm(tail);
    expect(trimSpeechTail(silent, 0)).toBe(silent);
    expect(trimSpeechTail(Buffer.alloc(0), 0).length).toBe(0);
  });
});

// ── 5. Context for the voice ────────────────────────────────────────────────────────────

describe('each line is read as the next line of the same script', () => {
  it('the previous line is a turn of the job already done, the new line is the last message', () => {
    const msgs = speechMessages('ama o zamana kadar işler başlamış durumda.', 'Eski kural geçerli,');
    const n = 1 + JARVIS_FEWSHOT.length;
    expect(msgs.slice(n)).toEqual([
      { role: 'user', content: scriptLine('Eski kural geçerli,', true) },
      { role: 'assistant', content: 'Eski kural geçerli,' },
      { role: 'user', content: scriptLine('ama o zamana kadar işler başlamış durumda.') },
    ]);
    expect(speechMessages('Tek satır.')).toHaveLength(n + 1);
  });

  it('a line that stops mid-sentence is told so; a heading or a full sentence is not', () => {
    expect(lineContinues('Eski kural geçerli,')).toBe(true);
    expect(lineContinues('Şunlara bakacak:')).toBe(true);
    expect(lineContinues('Bitti.')).toBe(false);
    expect(lineContinues('Türkçe kalitesi')).toBe(false);
    expect(scriptLine('Eski kural geçerli,', true).startsWith(CONTINUES_NOTE)).toBe(true);
    expect(scriptLine('Bitti.')).not.toContain(CONTINUES_NOTE);
  });

  it('context is stripped like speech, capped, and anything odd is simply no context', () => {
    expect(contextLine('Bunu **hemen** yaptım: https://example.com bak.')).toBe('Bunu hemen yaptım: bak.');
    expect(contextLine('x'.repeat(5000))!.length).toBe(PREV_CONTEXT_CHARS);
    expect(contextLine(42)).toBeUndefined();
    expect(contextLine('   ')).toBeUndefined();
    expect(contextLine('```dream-html\n<div>x</div>\n```')).toBeUndefined();
  });

  it('the page and the route agree on how much context travels (mirror)', () => {
    expect(CLIENT_PREV_CHARS).toBe(PREV_CONTEXT_CHARS);
  });
});

// ── 6. The real queue against the real route ────────────────────────────────────────────

const OPEN_FOCUS: FocusClient = {
  hold: async () => ({ granted: true, holder: 's1', ducked: false, gain: 1, paused: [] }),
  release: () => {},
};
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

describe('the queue sends the previous chunk; the route uses it as context only', () => {
  let home: string;
  let upstream: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let pcmOut: Buffer;

  function makeRes() {
    let statusCode = 0;
    const parts: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (c: Buffer) => { parts.push(Buffer.from(c)); });
    const res = Object.assign(sink, {
      setHeader() {},
      writeHead(code: number) { statusCode = code; return res; },
      get headersSent() { return statusCode !== 0; },
    }) as unknown as ServerResponse & PassThrough;
    return { res, status: () => statusCode, raw: () => Buffer.concat(parts) };
  }
  function makeReq(body: unknown): IncomingMessage {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    Object.assign(req, { headers: { 'content-type': 'application/json' }, method: 'POST', url: '/api/agent/voice/tts', destroy: () => {} });
    return req;
  }
  function voiceLog(): Array<Record<string, unknown>> {
    const file = join(home, '.dreamcontext', 'logs', 'voice.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dc-natchunk-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('DREAMCONTEXT_DESKTOP', '1');
    writeVoiceConfig({ openRouterKey: 'sk-or-test' }, home);
    clearModelCache();
    ttsGate.reset();
    adoptVoicePrefs(null);
    upstream = [];
    // 200 ms of voice and 500 ms of tail: what the model sends back.
    pcmOut = pcm([
      ...Array.from({ length: ms(200) }, (_, i) => (i % 2 ? 9000 : -9000)),
      ...Array.from({ length: ms(500) }, () => 0),
    ]);
    vi.stubGlobal('fetch', (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.endsWith('/models')) {
        return { ok: true, status: 200, text: async () => '', json: async () => ({ data: [{ id: 'openai/gpt-audio-mini' }] }) };
      }
      const body = JSON.parse(String(init?.body));
      upstream.push(body);
      const line = /«([\s\S]*)»/.exec(String(body.messages.at(-1).content))?.[1] ?? '';
      const frames = [
        { choices: [{ delta: { audio: { transcript: line } } }] },
        { choices: [{ delta: { audio: { data: pcmOut.toString('base64') } } }] },
      ];
      const sse = `${frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
      return {
        ok: true, status: 200, text: async () => sse, json: async () => ({}),
        body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
      };
    }) as unknown as typeof fetch);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    ttsGate.reset();
    rmSync(home, { recursive: true, force: true });
  });

  async function post(body: unknown): Promise<{ status: number; wav: Buffer }> {
    const r = makeRes();
    await handleVoiceTts(makeReq(body), r.res, {}, home);
    return { status: r.status(), wav: r.raw() };
  }

  it('reads ONLY the line, with the previous one as context, and trims the seam', async () => {
    const { status, wav } = await post({ text: 'ama işler başlamış durumda.', id: 't-2', prev: 'Eski kural **geçerli**,' });
    expect(status).toBe(200);
    const msgs = upstream[0].messages;
    expect(msgs.at(-1)!.content).toContain('«ama işler başlamış durumda.»');
    expect(msgs.at(-2)).toEqual({ role: 'assistant', content: 'Eski kural geçerli,' });
    // 200 ms of voice + the sentence breath, not + the model's 500 ms.
    const samples = (wav.length - 44) / 2;
    expect(samples).toBe(ms(200) + ms(SENTENCE_TAIL_MS));
    const line = voiceLog().find((l) => l.kind === 'tts' && l.id === 't-2')!;
    expect(line.outcome).toBe('spoken');
    expect(line.context).toBe(true);
    expect(typeof line.genMs).toBe('number');
    expect(line.trimmedMs).toBe(500 - SENTENCE_TAIL_MS);
  });

  it('a line that stops mid-sentence gets the short seam and the continue note', async () => {
    const { wav } = await post({ text: 'Bu değişiklik kurulana kadar eski kural geçerli,' });
    expect((wav.length - 44) / 2).toBe(ms(200) + ms(CLAUSE_TAIL_MS));
    expect(upstream[0].messages.at(-1)!.content.startsWith(CONTINUES_NOTE)).toBe(true);
    expect(upstream[0].messages).toHaveLength(1 + JARVIS_FEWSHOT.length + 1);
  });

  it('the queue sends each chunk the one before it, and forgets it at a new turn and a stop', async () => {
    const sent: Array<[string, SpeakContext | undefined]> = [];
    const fetcher: SpeakFetcher = async (text, _signal, _id, context) => { sent.push([text, context]); return null; };
    const q = new SpeechQueue('nat-pane', fetcher, OPEN_FOCUS, { report: () => {} });
    q.push('Birinci cümle burada. İkinci cümle de burada. ', 'i1');
    q.flushTurn();
    q.push('Yeni turun ilk cümlesi. ', 'i2');
    q.stop('barge-in');
    q.resume();
    q.push('Araya girdikten sonra ilk cümle. ', 'i3');
    q.endBlock();
    for (let i = 0; i < 40 && sent.length < 4; i++) await sleep(10);
    q.dispose();
    expect(sent).toEqual([
      ['Birinci cümle burada.', {}],
      ['İkinci cümle de burada.', { prev: 'Birinci cümle burada.' }],
      ['Yeni turun ilk cümlesi.', {}],
      ['Araya girdikten sonra ilk cümle.', {}],
    ]);
  });
});
