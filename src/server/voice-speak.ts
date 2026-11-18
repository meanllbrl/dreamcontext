/**
 * A whole spoken summary for the owner's Telegram (plan telegram-sesli-ozet, C2): text in, one
 * OGG/Opus voice out, made with the SAME model chain, voice and verbatim guard as the Mac voice
 * mode (`synthChunk`, shared with `/tts`).
 *
 *  - The text is redacted (`redactSecrets`), capped at {@link MAX_SUMMARY_CHARS}, then made
 *    `speakable` (no links, paths, fences).
 *  - It is cut into sentence groups of at most {@link SUMMARY_CHUNK_CHARS} and each is spoken by
 *    `synthChunk`, at most {@link SUMMARY_IN_FLIGHT} at once, joined in order. Each chunk holds a
 *    slot of the Mac's own `ttsGate`, so this never spends past the Mac's limits: a busy gate is
 *    waited out briefly, a rate limit fails the voice.
 *  - ANY chunk not spoken fails the whole voice: a summary with a missing sentence is never sent
 *    as if complete. The caller then sends the text instead.
 *
 * No `isDesktop()` gate of its own: the Telegram hub that calls this runs only in the desktop
 * server. The key is read here and never returned or logged.
 */
import { voiceApiKey, readVoiceConfig, DEFAULT_VOICE } from '../lib/voice/config.js';
import { resolveModel } from '../lib/voice/openrouter.js';
import { ttsGate, type VoiceGate } from '../lib/voice/limits.js';
import { speakable } from '../lib/voice/speakable.js';
import { CLAUSE_TAIL_MS, SENTENCE_TAIL_MS, PCM16_SAMPLE_RATE, wavFromPcm16 } from '../lib/voice/wav.js';
import { logVoiceEvent } from '../lib/voice/voiceLog.js';
import { pcmToOggOpus } from '../lib/voice/encode.js';
import { redactSecrets } from '../lib/telegram/format.js';
import { synthChunk, lineContinues, type SynthResult } from './routes/agent-voice.js';

/** D4: about 3 minutes of speech at most. */
export const MAX_SUMMARY_CHARS = 3000;
/** One synthesis call: a few sentences (the Mac speaks single sentences so the first one plays
 *  early; here the whole voice is needed before it is sent, so fewer, longer calls are faster). */
export const SUMMARY_CHUNK_CHARS = 240;
export const SUMMARY_IN_FLIGHT = 2;
/** How long one chunk waits for a busy gate slot before the voice fails. */
export const GATE_WAIT_MS = 15_000;
const GATE_STEP_MS = 250;

export type SpeakSummaryResult =
  | { ok: true; ogg: Buffer; seconds: number; wav?: Buffer }
  | { ok: false; reason: 'no_key' | 'too_long' | 'nothing_speakable' | 'no_ffmpeg' | 'failed' };

export interface SpeakDeps {
  key?: () => string | null;
  model?: (key: string) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
  voice?: () => string;
  synth?: typeof synthChunk;
  encode?: typeof pcmToOggOpus;
  gate?: VoiceGate;
  sleep?: (ms: number) => Promise<void>;
  log?: (e: Record<string, unknown>) => void;
}

/** Sentence groups of at most `max` characters; a longer sentence is cut at a comma or space. */
export function summaryChunks(text: string, max: number = SUMMARY_CHUNK_CHARS): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  const pieces: string[] = [];
  for (const s of sentences) {
    let rest = s;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
      if (cut < max / 3) cut = window.lastIndexOf(' ');
      if (cut < max / 3) cut = max - 1;
      pieces.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) pieces.push(rest);
  }
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + 1 + p.length <= max) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out;
}

export async function speakSummary(text: string, opts: { signal?: AbortSignal; home?: string; deps?: SpeakDeps; format?: 'ogg' | 'wav' } = {}): Promise<SpeakSummaryResult> {
  const d = opts.deps ?? {};
  const home = opts.home;
  const log = d.log ?? ((e: Record<string, unknown>) => logVoiceEvent(e, home));
  const gate = d.gate ?? ttsGate;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  const startedAt = Date.now();
  const clean = redactSecrets(text ?? '').trim();
  const done = (r: SpeakSummaryResult, extra: Record<string, unknown> = {}): SpeakSummaryResult => {
    log({ kind: 'tts', outcome: `summary-${r.ok ? 'ok' : r.reason}`, chars: clean.length, genMs: Date.now() - startedAt, ...(r.ok ? { seconds: Number(r.seconds.toFixed(1)) } : {}), ...extra });
    return r;
  };
  if (clean.length > MAX_SUMMARY_CHARS) return done({ ok: false, reason: 'too_long' });
  const spoken = speakable(clean);
  if (!spoken.trim()) return done({ ok: false, reason: 'nothing_speakable' });
  const key = (d.key ?? (() => voiceApiKey(home)))();
  if (!key) return done({ ok: false, reason: 'no_key' });
  const model = await (d.model ?? ((k: string) => resolveModel('speech', { key: k, home })))(key);
  // A missing key is the setup line; a model that cannot be reached or found is "hazırlanamadı"
  // (`/tts` reads `no_match` as setup; here the failure line suits a vanished model better).
  if (!model.ok) return done({ ok: false, reason: model.reason === 'no_key' ? 'no_key' : 'failed' });
  const voice = (d.voice ?? (() => readVoiceConfig(home).voice || DEFAULT_VOICE))();
  const synth = d.synth ?? synthChunk;

  const chunks = summaryChunks(spoken);
  const gone = new AbortController();
  const onAbort = (): void => gone.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) gone.abort();
  const results: (SynthResult | null)[] = new Array(chunks.length).fill(null);
  let failed = false;
  let next = 0;

  const one = async (i: number): Promise<void> => {
    // A slot of the Mac's own gate, per chunk (never bypassed). Busy: wait a little; rate: fail.
    const until = Date.now() + GATE_WAIT_MS;
    for (;;) {
      if (failed || gone.signal.aborted) return;
      const v = gate.acquire();
      if (v === 'ok') break;
      if (v === 'rate' || Date.now() > until) { failed = true; gone.abort(); return; }
      await sleep(GATE_STEP_MS);
    }
    try {
      const chunk = chunks[i]!;
      const r = await synth({
        spoken: chunk, prev: i > 0 ? chunks[i - 1] : undefined, key, modelId: model.id, voice,
        tailMs: lineContinues(chunk) ? CLAUSE_TAIL_MS : SENTENCE_TAIL_MS, gone: gone.signal,
      });
      results[i] = r;
      if (r.outcome !== 'spoken' && r.outcome !== 'spoken-by-fallback') { failed = true; gone.abort(); }
    } catch {
      failed = true;
      gone.abort();
    } finally {
      gate.release();
    }
  };
  const worker = async (): Promise<void> => {
    while (!failed && !gone.signal.aborted && next < chunks.length) await one(next++);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(SUMMARY_IN_FLIGHT, chunks.length) }, worker));
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const outcomes = results.map((r) => r?.outcome ?? 'skipped');
  // How often a longer chunk was answered instead of read (retried, or spoken by the fallback).
  const retried = results.filter((r) => r?.retried || r?.outcome === 'spoken-by-fallback').length;
  if (failed || gone.signal.aborted || results.some((r) => !r?.pcm)) {
    return done({ ok: false, reason: 'failed' }, { chunks: chunks.length, outcomes, retried });
  }
  const pcm = Buffer.concat(results.map((r) => r!.pcm!));
  const seconds = pcm.length / (PCM16_SAMPLE_RATE * 2);
  // The Mac chat's card plays the SAME speech as a WAV (WKWebView has no Ogg/Opus): no ffmpeg.
  if (opts.format === 'wav') return done({ ok: true, ogg: Buffer.alloc(0), wav: wavFromPcm16(pcm), seconds }, { chunks: chunks.length, retried, format: 'wav' });
  const enc = await (d.encode ?? pcmToOggOpus)(pcm);
  if (!enc.ok) return done({ ok: false, reason: enc.reason === 'ffmpeg_missing' ? 'no_ffmpeg' : 'failed' }, { chunks: chunks.length, retried });
  return done({ ok: true, ogg: enc.ogg, seconds }, { chunks: chunks.length, retried });
}
