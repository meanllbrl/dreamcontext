/**
 * "Sesli asistan okuma yaparken hâlâ bazı cümleleri atlıyor" (owner, 2026-10-21).
 *
 * Every test here runs the REAL page queue (`dashboard/src/lib/voice/speechQueue.ts`, its real
 * fetcher) against the REAL route (`handleVoiceTts`, its real concurrency gate and logger) and,
 * for the two surfaces that speak, the REAL chat session reducer. Only the far ends are fakes:
 * OpenRouter (it reads the line back after a delay) and the speaker (an AudioContext that
 * records what it was given). The claim under test is the owner's: every sentence of a reply
 * reaches the speaker, and voice.jsonl says what became of each one.
 *
 * The defect these pin (found 2026-10-21, and in the owner's own voice.jsonl: 28 of 210 chunks
 * of the 2026-10-17 notch replies never reached the server, the 4th, 8th, 12th of a block):
 * the queue kept LOOK_AHEAD requests open for the QUEUED chunks and one more for the chunk it
 * was waiting on, four against a route that admits three. The fourth came back 429, which the
 * queue read as "skip this chunk", and the route never logged the refusal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { writeVoiceConfig } from '../../src/lib/voice/config.js';
import { clearModelCache } from '../../src/lib/voice/openrouter.js';
import { ttsGate, TTS_LIMITS } from '../../src/lib/voice/limits.js';
import { speakable } from '../../src/lib/voice/speakable.js';
import { parseSpeechReport } from '../../src/lib/voice/voiceLog.js';
import { handleVoiceTts, handleVoiceLog } from '../../src/server/routes/agent-voice.js';
import {
  SpeechQueue, createSpeechChunker, createSpeakFetcher, LOOK_AHEAD, BUSY_RETRY_MS,
} from '../../dashboard/src/lib/voice/speechQueue.js';
import { adoptVoicePrefs } from '../../dashboard/src/lib/voice/voicePrefs.js';
import type { FocusClient } from '../../dashboard/src/lib/voice/audioFocus.js';

const OPEN_FOCUS: FocusClient = {
  hold: async () => ({ granted: true, holder: 's1', ducked: false, gain: 1, paused: [] }),
  release: () => {},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── The far end: OpenRouter, reading every line back after `genMs` ──────────────────────

let genMs = 40;
let upstreamOpen = 0;
let upstreamPeak = 0;

function sse(transcript: string) {
  const frames = [
    { choices: [{ delta: { audio: { transcript } } }] },
    { choices: [{ delta: { audio: { data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString('base64') } } }] },
  ];
  const body = `${frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
  return {
    ok: true, status: 200, text: async () => body, json: async () => ({}),
    body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }),
  };
}

/** Wait `ms`, or reject as an abort the moment `signal` fires — a real fetch's contract. */
function abortable(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

// ── The near end: the route, called the way the HTTP server calls it ────────────────────

function makeRes() {
  let statusCode = 0;
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (c: Buffer) => { chunks.push(Buffer.from(c)); });
  const res = Object.assign(sink, {
    setHeader() {},
    writeHead(code: number) { statusCode = code; return res; },
    get headersSent() { return statusCode !== 0; },
  }) as unknown as ServerResponse & PassThrough;
  return { res, status: () => statusCode, raw: () => Buffer.concat(chunks) };
}

function makeReq(body: string, url: string): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  Object.assign(req, { headers: { 'content-type': 'application/json' }, method: 'POST', url, destroy: () => {} });
  return req;
}

/** `[url, body]` of every request that left the page, in order. */
let pageRequests: Array<[string, string]> = [];
let home: string;

function installNetwork(): void {
  vi.stubGlobal('fetch', (async (u: string, init?: RequestInit) => {
    const url = String(u);
    if (url.endsWith('/models')) {
      return { ok: true, status: 200, text: async () => '', json: async () => ({ data: [{ id: 'openai/gpt-audio-mini' }] }) };
    }
    if (url.endsWith('/chat/completions')) {
      upstreamOpen += 1;
      upstreamPeak = Math.max(upstreamPeak, upstreamOpen);
      try {
        const line = String(JSON.parse(String(init?.body)).messages.at(-1).content);
        await abortable(genMs, init?.signal);
        return sse(/«([\s\S]*)»/.exec(line)?.[1] ?? '');
      } finally {
        upstreamOpen -= 1;
      }
    }
    if (url === '/api/agent/voice/tts' || url === '/api/agent/voice/log') {
      pageRequests.push([url, String(init?.body)]);
      const signal = init?.signal as AbortSignal | undefined;
      const r = makeRes();
      const handled = url === '/api/agent/voice/tts'
        ? handleVoiceTts(makeReq(String(init?.body), url), r.res, {}, home)
        : handleVoiceLog(makeReq(String(init?.body), url), r.res);
      const gone = new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => {
          // What a real socket does when the page aborts: the response closes unfinished.
          r.res.emit('close');
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
      await Promise.race([handled, gone]);
      const status = r.status();
      return new Response(status === 204 ? null : r.raw(), { status });
    }
    // Everything else the chat session asks for at start (history, prefs, focus): empty.
    return new Response(JSON.stringify({ messages: [], items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch);
}

// ── The speaker: records what it was handed, on a clock that never moves ────────────────

class FakeCtx {
  /** While set, every decode waits on it — the window a barge-in can land in. */
  static hold: Promise<void> | null = null;
  static decoding = 0;
  /** Decodes from this one on refuse (a webview that gives up part-way): the element fallback. */
  static failFrom = Infinity;
  /** Seconds each decoded chunk lasts. */
  static duration = 1;
  state = 'running';
  currentTime = 0;
  destination = {};
  async resume() {}
  async close() {}
  async decodeAudioData() {
    FakeCtx.decoding += 1;
    if (FakeCtx.hold) await FakeCtx.hold;
    if (FakeCtx.decoding >= FakeCtx.failFrom) throw new Error('cannot decode');
    return { duration: FakeCtx.duration, length: 8000, sampleRate: 8000, numberOfChannels: 1, getChannelData: () => new Float32Array(8000) } as unknown as AudioBuffer;
  }
  createBuffer() { throw new Error('rate stays 1 here'); }
  createBufferSource() {
    return { buffer: null, onended: null, connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {} };
  }
  createGain() { return { gain: { value: 1, setTargetAtTime: () => {} }, connect: () => {} }; }
  createDynamicsCompressor() {
    const p = () => ({ value: 0 });
    return { threshold: p(), knee: p(), ratio: p(), attack: p(), release: p(), connect: () => {} };
  }
}

/** The chunks handed to the speaker, in order (the clock never moves, so none is forgotten). */
const heardBy = (q: SpeechQueue) => (q as unknown as { marks: Array<{ text: string }> }).marks.map((m) => m.text);

// ── voice.jsonl ─────────────────────────────────────────────────────────────────────────

type Line = Record<string, unknown> & { kind: string };
function voiceLog(): Line[] {
  const file = join(home, '.dreamcontext', 'logs', 'voice.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
}
const speechLines = () => voiceLog().filter((l) => l.kind === 'speech');
const ttsLines = () => voiceLog().filter((l) => l.kind === 'tts');

/** Poll until `cond` holds (the network is real time here), or fail with what was seen. */
async function until(cond: () => boolean, what: string, ms = 9000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

// ── The oracle ──────────────────────────────────────────────────────────────────────────

/** What the owner must hear: every chunk the chunker closes that has something speakable in it. */
function mustHear(text: string): string[] {
  const c = createSpeechChunker();
  return [...c.push(text), ...c.flush()].filter((ch) => speakable(ch) !== '');
}
function allChunks(text: string): string[] {
  const c = createSpeechChunker();
  return [...c.push(text), ...c.flush()];
}

/** A tiny seeded PRNG, so a "random" delta split is the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Feed `text` in pieces of 1..`max` characters, `everyMs` apart — a model streaming a reply. */
async function stream(q: SpeechQueue, text: string, item: string, opts: { max?: number; everyMs?: number; seed?: number } = {}): Promise<void> {
  const next = rng(opts.seed ?? 7);
  for (let i = 0; i < text.length;) {
    const n = 1 + Math.floor(next() * (opts.max ?? 14));
    q.push(text.slice(i, i + n), item);
    i += n;
    await sleep(opts.everyMs ?? 4);
  }
  q.endBlock();
}

let queues: SpeechQueue[] = [];
function queue(surface: 'assistant' | 'super' = 'assistant'): SpeechQueue {
  const q = new SpeechQueue('noskip-pane', undefined, OPEN_FOCUS, { surface });
  queues.push(q);
  return q;
}

/** Speak `text` as one streamed block and wait until every chunk has its line in voice.jsonl. */
async function speakAll(text: string, opts: { max?: number; everyMs?: number; seed?: number; whole?: boolean } = {}): Promise<{ heard: string[]; q: SpeechQueue }> {
  const q = queue();
  if (opts.whole) { q.push(text, 'item-1'); q.endBlock(); } else await stream(q, text, 'item-1', opts);
  const total = allChunks(text).length;
  await until(() => new Set(speechLines().map((l) => l.id)).size >= total, `${total} chunk lines`);
  return { heard: heardBy(q), q };
}

// ── Shared fixtures (synthetic: no real project, no real person) ────────────────────────

const SEVEN = [
  'Tamam, bakıyorum. ',
  'Sürüm 0.33.0 yayında ve üç değişiklik var. ',
  'Birincisi ses kaydı artık doğrudan mikrofondan alınıyor. ',
  'İkincisi bir cümle artık atlanmıyor. ',
  'Üçüncüsü panel uzun cevaplarda açılıyor. ',
  'Kısaca hepsi bu kadar. ',
  'Başka bir şey ister misin?',
].join('');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-noskip-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('DREAMCONTEXT_DESKTOP', '1');
  writeVoiceConfig({ openRouterKey: 'sk-or-test' }, home);
  clearModelCache();
  ttsGate.reset();
  adoptVoicePrefs(null);
  genMs = 40;
  upstreamOpen = 0;
  upstreamPeak = 0;
  pageRequests = [];
  queues = [];
  FakeCtx.hold = null;
  FakeCtx.decoding = 0;
  FakeCtx.failFrom = Infinity;
  FakeCtx.duration = 1;
  vi.stubGlobal('window', Object.assign(new EventTarget(), { AudioContext: FakeCtx }));
  installNetwork();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const q of queues) q.dispose();
  await sleep(20);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  ttsGate.reset();
  rmSync(home, { recursive: true, force: true });
});

// ── 1. The reproduction, and the cap that ends it ───────────────────────────────────────

describe('every sentence reaches the speaker — the queue against the real route', () => {
  it('a STREAMED seven-sentence Turkish reply: all seven are played, in order', async () => {
    // Red on the old queue: the 4th sentence ("İkincisi bir cümle artık atlanmıyor.") was the
    // fourth open request, refused 429 and dropped — and voice.jsonl showed nothing. The text
    // streams faster than speech generates, as it does live (~0.3 s a sentence vs ~1.3 s).
    genMs = 150;
    const { heard } = await speakAll(SEVEN);
    expect(heard).toEqual(mustHear(SEVEN));
    expect(heard).toHaveLength(7);
  });

  it('a block that arrives WHOLE (no deltas, the echo): the 4th, 8th and 12th are not dropped', async () => {
    // The owner's voice.jsonl, 2026-10-17: missing chunks sat at positions 4, 8, 12, 16.
    const twelve = Array.from({ length: 12 }, (_, i) => `Bu ${i + 1}. maddenin cümlesi, tam okunmalı.`).join(' ');
    const { heard } = await speakAll(twelve, { whole: true });
    expect(heard).toEqual(mustHear(twelve));
    expect(heard).toHaveLength(12);
  });

  it(`never has more than LOOK_AHEAD (${LOOK_AHEAD}) requests open — the one it waits on counts`, async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `Cümle numarası ${i + 1} burada bitiyor.`).join(' ');
    await speakAll(twelve, { whole: true });
    expect(upstreamPeak).toBeLessThanOrEqual(LOOK_AHEAD);
    // So the queue never meets its own refusal: no 429 was ever answered to it.
    expect(ttsLines().filter((l) => String(l.outcome).startsWith('refused'))).toEqual([]);
  });

  it('LOOK_AHEAD never exceeds what the route admits at once (the mirror of TTS_LIMITS)', () => {
    expect(LOOK_AHEAD).toBeLessThanOrEqual(TTS_LIMITS.concurrency);
  });
});

// ── 2. Real replies, named ──────────────────────────────────────────────────────────────

describe('real reply shapes — nothing speakable is left out, nothing fenced is read', () => {
  const cases: Array<{ name: string; text: string; must: string[]; never?: RegExp[] }> = [
    {
      name: 'markdown: heading, bold, inline code, a link, the highlighter',
      text: '## Özet\nBunu **hemen** yaptım. `dreamcontext update` komutu çalıştı. [El kitabı](docs/el-kitabi.pdf) güncel. ==Önemli== kısım bu.\n',
      must: ['Özet', 'Bunu **hemen** yaptım.', '`dreamcontext update` komutu çalıştı.', 'güncel.', '==Önemli== kısım bu.'],
    },
    {
      name: 'a bullet list and a numbered list',
      text: 'Üç şey var:\n- Birinci madde burada.\n- İkinci madde de burada.\n- Üçüncü madde son.\n1. Önce kaydet.\n2. Sonra gönder.\n',
      must: ['Üç şey var:', 'Birinci madde burada.', 'İkinci madde de burada.', 'Üçüncü madde son.', 'Önce kaydet.', 'Sonra gönder.'],
    },
    {
      name: 'a table between two sentences (rows are silent, the prose is not)',
      text: 'Tabloyu koydum.\n| Sürüm | Tarih |\n|---|---|\n| 0.33.0 | 21 Ekim |\nTablonun altı da okunur.\n',
      must: ['Tabloyu koydum.', 'Tablonun altı da okunur.'],
      never: [/\|/],
    },
    {
      name: 'a code block, dream-view, dream-actions and dream-html between prose',
      text: [
        'Komut şu:', '```bash', 'npm test -- --run', '```', 'Sonra kartı açtım.',
        '```dream-view', '{"type":"insight","id":"haftalik-aktif"}', '```', 'Düğmeler aşağıda.',
        '```dream-actions', '[{"label":"Aç","action":"ask","text":"aç"}]', '```',
        '```dream-html', '<div class="dc-card">x. y. z.</div>', '```', 'Hepsi bu kadar.', '',
      ].join('\n'),
      must: ['Komut şu:', 'Sonra kartı açtım.', 'Düğmeler aşağıda.', 'Hepsi bu kadar.'],
      never: [/npm|insight|label|dc-card|dream-|\{|</],
    },
    {
      name: 'versions, decimals, abbreviations, ordinals and an initial stay inside their sentence',
      text: 'Sürüm 0.33.0 yayında. Süre 3.5 saniyeydi, örn. ilk açılış vb. hepsi dahil. 3. görev bitti. Dr. Kaya onayladı. A. Demir de baktı. ',
      must: ['Sürüm 0.33.0 yayında.', 'Süre 3.5 saniyeydi, örn. ilk açılış vb. hepsi dahil.', '3. görev bitti.', 'Dr. Kaya onayladı.', 'A. Demir de baktı.'],
    },
    {
      name: 'lines ending in a colon, and emoji (an emoji-only line is silent)',
      text: 'Şunları yaptım:\n- Kaydı düzelttim 🎉\n- Testi yazdım\n✅\nYarın devam ederiz 🙂\n',
      must: ['Şunları yaptım:', 'Kaydı düzelttim 🎉', 'Testi yazdım', 'Yarın devam ederiz 🙂'],
    },
    {
      name: 'a long paragraph cut at clauses, and a turn that ends with no terminator',
      text: 'Bu uzun bir cümle, içinde virgüller var, ve konuşma akışı bozulmadan okunması gerekiyor; çünkü sahip dinliyor ve her kelime önemli — hiçbiri atlanmamalı. Son satırın noktası yok',
      must: ['hiçbiri atlanmamalı.', 'Son satırın noktası yok'],
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const { heard } = await speakAll(c.text, { seed: c.name.length });
      expect(heard).toEqual(mustHear(c.text));
      const said = heard.join(' ');
      for (const m of c.must) expect(said).toContain(m);
      for (const n of c.never ?? []) expect(said).not.toMatch(n);
      // Each silent chunk is accounted for, not lost: voice.jsonl says why it was not read.
      const silent = allChunks(c.text).filter((ch) => speakable(ch) === '');
      const why = speechLines().filter((l) => l.outcome === 'skipped').map((l) => l.reason);
      expect(why).toEqual(silent.map(() => 'nothing-speakable'));
    });
  }
});

// ── 3. Contention: other claimants of the gate ──────────────────────────────────────────

describe('a busy route is waited out, never skipped', () => {
  it('while ANOTHER pane holds every slot, the reply is still read whole (429 is retried)', async () => {
    // The notch and the Super Agent can both be speaking; their requests share one gate.
    expect(ttsGate.acquire()).toBe('ok');
    expect(ttsGate.acquire()).toBe('ok');
    expect(ttsGate.acquire()).toBe('ok');
    setTimeout(() => { ttsGate.release(); ttsGate.release(); ttsGate.release(); }, BUSY_RETRY_MS[0] + BUSY_RETRY_MS[1] / 2);
    const five = 'Birinci cümle. İkinci cümle geliyor. Üçüncü de burada. Dördüncü cümle. Beşinci ve son.';
    const { heard } = await speakAll(five);
    expect(heard).toEqual(mustHear(five));
    // The refusals happened, and are on record now — the line the old route never wrote.
    expect(ttsLines().some((l) => l.outcome === 'refused-busy')).toBe(true);
    expect(speechLines().filter((l) => l.outcome === 'skipped')).toEqual([]);
  });

  it('while the head chunk waits out a 429, the queue never runs more than LOOK_AHEAD chunks ahead of it', async () => {
    // Review r1: with the window bounded only by open requests, every slot a neighbour freed
    // went to chunk N+3, N+4…, the head found the gate full at each retry and was skipped
    // "busy" after the whole budget. One slot held by another pane for the whole reply.
    expect(ttsGate.acquire()).toBe('ok');
    try {
      genMs = 60;
      const sixteen = Array.from({ length: 16 }, (_, i) => `Sıradaki cümle ${i + 1} burada.`).join(' ');
      const { heard } = await speakAll(sixteen, { whole: true });
      expect(heard).toEqual(mustHear(sixteen));
      const seqOf = (l: Line) => Number(/-(\d+)$/.exec(String(l.id))?.[1]);
      const spoken = ttsLines().filter((l) => l.outcome === 'spoken').map(seqOf);
      for (let k = 0; k < spoken.length; k++) {
        const oldestUnspoken = Math.min(...spoken.slice(k));
        expect(spoken[k] - oldestUnspoken).toBeLessThan(LOOK_AHEAD);
      }
      expect(speechLines().filter((l) => l.outcome === 'skipped')).toEqual([]);
      // The contention really happened: without a refusal this test could not fail.
      expect(ttsLines().some((l) => l.outcome === 'refused-busy')).toBe(true);
    } finally {
      ttsGate.release();
    }
  });

  it('a route that stays saturated past the whole retry budget skips with reason "busy", said', async () => {
    const fetcher = createSpeakFetcher(async () => true);   // no real waiting
    let asked = 0;
    vi.stubGlobal('fetch', (async () => { asked += 1; return new Response('{"error":"tts_busy"}', { status: 429 }); }) as unknown as typeof fetch);
    const out = await fetcher('Bir cümle.', new AbortController().signal, 'x-1');
    expect(out).toEqual({ skipped: 'busy' });
    expect(asked).toBe(BUSY_RETRY_MS.length + 1);
  });
});

// ── 4. Barge-in: the next turn is not refused by the last one's leftovers ──────────────

describe('barge-in', () => {
  it('the route lets go of a talked-over chunk at once, and the next turn is read whole', async () => {
    genMs = 400;                                  // long generations, so the barge-in lands mid-flight
    const q = queue();
    q.push('Eski cevabın birinci cümlesi. Eski cevabın ikinci cümlesi. Eski cevabın üçüncü cümlesi. ', 'item-old');
    await until(() => ttsGate.state.inFlight === LOOK_AHEAD, 'the old turn to fill the gate', 2000);
    q.stop('barge-in');
    q.resume();
    // The slots come back as soon as the page lets go — not 400 ms later when generation ends.
    await until(() => ttsGate.state.inFlight === 0, 'the gate to empty', 150);
    genMs = 40;
    const next = 'Yeni soruya cevap. İkinci cümle burada. Üçüncü cümle de var. Dördüncü ve son cümle.';
    q.push(next, 'item-new');
    q.endBlock();
    const want = mustHear(next);
    await until(() => heardBy(q).length >= want.length, 'the new turn to be heard');
    expect(heardBy(q)).toEqual(want);
    // And the record says what happened to the old turn's sentences: cut by the barge-in.
    await until(() => speechLines().filter((l) => l.reason === 'barge-in').length === 3, 'three cut lines');
    expect(ttsLines().filter((l) => l.outcome === 'abandoned').length).toBeGreaterThan(0);
  });

  it('a chunk still DECODING when the owner barges in is never played, and is logged cut only', async () => {
    // Review r1: stop() and resume() run in one tick, so a `stopped` check after the decode was
    // already false again — the talked-over sentence was scheduled anyway (cut, then played).
    let release!: () => void;
    FakeCtx.hold = new Promise<void>((r) => { release = r; });
    const q = queue();
    q.push('Bu cümle çözülürken araya girildi. ', 'item-a');
    await until(() => FakeCtx.decoding === 1, 'the decode to start', 3000);
    q.stop('barge-in');
    q.resume();
    release();
    await sleep(60);
    expect(heardBy(q)).toEqual([]);
    await until(() => speechLines().length >= 1, 'its line');
    await sleep(30);
    expect(speechLines().map((l) => [l.outcome, l.reason])).toEqual([['cut', 'barge-in']]);
  });

  it('on the ELEMENT fallback, a chunk waiting for the scheduled tail when the owner barges in is never played', async () => {
    // The round-1 "worse" path: the fallback waits out the Web Audio tail (seconds, live), and a
    // `stopped` check after that wait was already false again — the stale chunk played in full.
    class FakeAudio {
      static plays = 0;
      preload = ''; src = ''; playbackRate = 1; defaultPlaybackRate = 1; preservesPitch = true; muted = false;
      addEventListener() {} removeEventListener() {} removeAttribute() { this.src = ''; } pause() {}
      play() { FakeAudio.plays += 1; return Promise.resolve(); }
    }
    vi.stubGlobal('Audio', FakeAudio);
    FakeCtx.duration = 0.3;                       // the first chunk's tail: ~0.36 s from now
    FakeCtx.failFrom = 2;                         // the second chunk will not decode
    const q = queue();
    q.push('Birinci cümle çalınıyor. İkinci cümle sırada bekliyor. ', 'item-a');
    await until(() => heardBy(q).length === 1 && FakeCtx.decoding === 2, 'the 2nd chunk to wait for the tail', 3000);
    await sleep(10);
    q.stop('barge-in');
    q.resume();
    await sleep(500);                             // past the tail the fallback was waiting for
    expect(FakeAudio.plays).toBe(0);
    const second = speechLines().filter((l) => String(l.head).startsWith('İkinci'));
    expect(second.map((l) => [l.outcome, l.reason])).toEqual([['cut', 'barge-in']]);
  });

  it('a played chunk the owner talks over is logged as cut AND heard; queued ones as cut, unheard', async () => {
    const q = queue();
    q.push('Birinci cümle çalınıyor. İkinci cümle sırada. ', 'item-a');
    await until(() => heardBy(q).length === 2, 'both scheduled');
    // Half a second into the first chunk (each lasts 1 s): it is sounding, the second is not.
    (q as unknown as { ctx: FakeCtx }).ctx.currentTime = 0.5;
    q.stop('barge-in');
    await until(() => speechLines().filter((l) => l.outcome === 'cut').length === 2, 'two cut lines');
    const cut = speechLines().filter((l) => l.outcome === 'cut');
    expect(cut.map((l) => [l.head, l.heard])).toEqual([['Birinci cümle çalınıyor.', true], ['İkinci cümle sırada.', false]]);
  });
});

// ── 5. The record: one line per chunk, matched across page and server ──────────────────

describe('voice.jsonl says what became of every chunk', () => {
  it('each chunk has a speech line, and each played one has the server tts line with the same id', async () => {
    await speakAll(SEVEN);
    await sleep(30);
    const speech = speechLines();
    const played = speech.filter((l) => l.outcome === 'played');
    expect(played.map((l) => l.head)).toEqual(mustHear(SEVEN).map((t) => t.slice(0, 60)));
    for (const p of played) {
      expect(p.surface).toBe('assistant');
      expect(typeof p.id).toBe('string');
      expect(ttsLines().find((t) => t.id === p.id)?.outcome).toBe('spoken');
    }
  });

  it('speech switched off in Settings: every chunk is logged skipped "speech-off" and nothing is fetched', async () => {
    adoptVoicePrefs({ speech: false });
    const q = queue();
    q.push('Bir. İki cümle. Üç cümle burada.', 'item-1');
    q.endBlock();
    await until(() => speechLines().length === 3, 'three lines');
    expect(speechLines().map((l) => l.reason)).toEqual(['speech-off', 'speech-off', 'speech-off']);
    expect(pageRequests.filter(([u]) => u === '/api/agent/voice/tts')).toEqual([]);
  });

  it('a talked-over paragraph says once that its rest is not read', async () => {
    const q = queue();
    q.push('Uzun paragraf başlıyor. ', 'item-a');
    q.stop('barge-in');
    q.resume();
    q.push('ve devamı geliyor. ', 'item-a');
    q.push('daha da devamı. ', 'item-a');
    await until(() => speechLines().some((l) => l.reason === 'talked-over'), 'the talked-over line');
    expect(speechLines().filter((l) => l.reason === 'talked-over')).toHaveLength(1);
  });

  it('the phone never asks for speech (the listener refuses the route): skipped "phone"', async () => {
    const { setPhoneSurfaceForTests } = await import('../../dashboard/src/lib/phoneSurface.js');
    setPhoneSurfaceForTests('mac');
    try {
      const out = await createSpeakFetcher()('Telefon konuşmaz.', new AbortController().signal);
      expect(out).toEqual({ skipped: 'phone' });
      expect(pageRequests).toEqual([]);
    } finally {
      setPhoneSurfaceForTests(null);
    }
  });

  it('the log route keeps only known fields of a speech record', () => {
    expect(parseSpeechReport({
      kind: 'speech', outcome: 'skipped', reason: 'busy', id: 'ab-1', chars: 12, head: 'Bir\ncümle', surface: 'super', extra: 'x',
    })).toEqual({ kind: 'speech', outcome: 'skipped', reason: 'busy', id: 'ab-1', chars: 12, head: 'Bir cümle', surface: 'super' });
    expect(parseSpeechReport({ kind: 'speech', outcome: 'exploded' })).toBeNull();
    expect(parseSpeechReport({ kind: 'speech', outcome: 'cut', reason: 'made-up', id: '../x' })).toEqual({ kind: 'speech', outcome: 'cut' });
  });
});

// ── 6. The two surfaces that speak, through the real chat session ───────────────────────

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static all: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { FakeWebSocket.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

const ev = (event: unknown) => ({ type: 'stream_event', event });
const textStart = (index: number) => ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
const textDelta = (index: number, text: string) => ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const stop = (index: number) => ev({ type: 'content_block_stop', index });
const echo = (text: string) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] } });

/** Stream one text block as a real CLI does: start, deltas, stop, then the full echo. */
async function block(ws: FakeWebSocket, index: number, text: string, seed: number): Promise<void> {
  const next = rng(seed);
  ws.frame(textStart(index));
  for (let i = 0; i < text.length;) {
    const n = 1 + Math.floor(next() * 12);
    ws.frame(textDelta(index, text.slice(i, i + n)));
    i += n;
    await sleep(3);
  }
  ws.frame(stop(index));
  ws.frame(echo(text));
}

async function openSession(mode: 'assistant' | 'super') {
  FakeWebSocket.all = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:1', assign: () => {} });
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', remove() {}, style: {}, appendChild() {} }),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null,
  });
  // The composer's read-aloud switch is ON.
  vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'dreamcontext-read-aloud' ? '1' : null), setItem() {}, removeItem() {} });
  const { createChatSession } = await import('../../dashboard/src/components/sleepy/chatSession.js');
  const s = createChatSession('__assistant__', false, () => {}, '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', false, '', '', '', '', false, mode);
  const ws = FakeWebSocket.all[0];
  ws.open();
  return { s, ws };
}

describe('the surfaces that speak, end to end', () => {
  it('the NOTCH (assistant mode): two answer blocks around a tool call are read whole; a progress line is not', async () => {
    const { s, ws } = await openSession('assistant');
    const first = 'Tamam, bakıyorum. Sürüm 0.33.0 yayında. Üç değişiklik var. Dördüncü cümle de var. Beşinci de.';
    const second = 'Baktım: kayıt düzgün. Her cümle okunuyor. Atlanan yok. Bitti.';
    await block(ws, 0, `<!-- notch:progress -->\nŞimdi kontrol ediyorum.`, 1);
    ws.frame(ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } }));
    ws.frame(stop(1));
    ws.frame({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } });
    await block(ws, 0, `<!-- notch:present -->\n${first}`, 2);
    await block(ws, 1, `<!-- notch:present stay -->\n${second}`, 3);
    ws.frame({ type: 'result', is_error: false, result: second });
    const want = [...mustHear(first), ...mustHear(second)];
    await until(() => speechLines().filter((l) => l.outcome === 'played').length >= want.length, 'the notch reply');
    expect(speechLines().filter((l) => l.outcome === 'played').map((l) => l.head)).toEqual(want.map((t) => t.slice(0, 60)));
    expect(speechLines().every((l) => l.surface === 'assistant')).toBe(true);
    expect(JSON.stringify(speechLines())).not.toContain('kontrol ediyorum');
    s.dispose();
  });

  it('the SUPER AGENT (a spoken turn): everything between voice_turn and voice_turn_end is read whole', async () => {
    const { s, ws } = await openSession('super');
    const reply = 'Kartı açtım. Sitede üç hata var. Birini düzelttim. İkisi sende. Bakar mısın?';
    ws.frame({ type: '_meta', subtype: 'voice_turn' });
    await block(ws, 0, reply, 4);
    ws.frame({ type: '_meta', subtype: 'voice_turn_end' });
    ws.frame({ type: 'result', is_error: false, result: reply });
    const want = mustHear(reply);
    await until(() => speechLines().filter((l) => l.outcome === 'played').length >= want.length, 'the super reply');
    expect(speechLines().filter((l) => l.outcome === 'played').map((l) => l.head)).toEqual(want);
    expect(speechLines().every((l) => l.surface === 'super')).toBe(true);
    s.dispose();
  });
});
