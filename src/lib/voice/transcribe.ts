/**
 * Speech to text, outside the desktop route (W2 lane C; plan "Voice", A6).
 *
 *  - `transcribeWithRetry` / `isWav`: moved here from `src/server/routes/agent-voice.ts` (the
 *    route re-exports them and keeps its own guards, caps, logging and take records).
 *  - `transcribeAudio(wav)`: the owner's chosen engine, and nothing else (local whisper or the
 *    cloud), as the route chooses it; a garbled take is refused, never sent.
 *  - `oggToWav(path)`: Telegram's voice notes are OGG/Opus; ffmpeg by ABSOLUTE path, `execFile`
 *    with an argument array, `-f ogg -protocol_whitelist file,pipe`, 30 s timeout. No ffmpeg →
 *    `ffmpeg_missing` (the bot says how to install it).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { score, pick, type Candidate, type Verdict } from './garble.js';
import { contextFor, normalizeLanguage, type LanguageContext } from './languageContext.js';
import { prerenderCue } from './cue.js';
import { contextTakes } from './voiceLog.js';
import { transcribeLocal, holdLocalModel, checkPressure, type LocalTranscript, type WhisperInstall } from './whisper.js';
import { transcribeCloud } from './openrouter.js';
import { resolveDictation } from './dictationInstall.js';
import { readVoiceConfig } from './config.js';
import type { TranscribeAudio } from '../telegram/contract.js';

/** Is this body actually a WAV? (magic bytes, never a client-chosen header) */
export function isWav(buf: Buffer): boolean {
  return buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WAVE';
}

/**
 * Transcribe a take, judge it, and retranscribe it ONCE when it is not clean (at most two
 * passes, owner 2026-10-24). Null when whisper did not answer the first pass at all.
 *
 *   • Pass 1 is pinned to the context's primary language when there is one (the fast path,
 *     ~2 s faster than detecting), else `auto`.
 *   • Pass 2: after a LOOP, the same language with no primer at a little temperature; after an
 *     `auto`, out-of-context or weak pass, pinned to the context language; after a weak PINNED
 *     pass, `auto` (the owner may have switched language).
 *   • The better pass wins by `pick`'s sort key; a garbled winner is never sent.
 */
export async function transcribeWithRetry(
  wav: Buffer,
  opts: { cfg: { sttLanguage?: string; sttLanguages?: string[] }; conv: string | null; ui?: unknown; lexicon?: string; install?: WhisperInstall | null },
): Promise<{
  winner: Candidate<LocalTranscript>; verdict: Verdict; passes: 1 | 2; ms: number;
  context: LanguageContext; attempts: Array<Record<string, unknown>>;
} | null> {
  return holdLocalModel(() => transcribeWithRetryHeld(wav, opts));
}

async function transcribeWithRetryHeld(
  wav: Buffer,
  opts: { cfg: { sttLanguage?: string; sttLanguages?: string[] }; conv: string | null; ui?: unknown; lexicon?: string; install?: WhisperInstall | null },
): Promise<{
  winner: Candidate<LocalTranscript>; verdict: Verdict; passes: 1 | 2; ms: number;
  context: LanguageContext; attempts: Array<Record<string, unknown>>;
} | null> {
  const started = Date.now();
  const context = contextFor({ conv: opts.conv, uiLang: opts.ui, cfg: opts.cfg, takes: contextTakes() });
  const first = await transcribeLocal(wav, { language: context.primary ?? 'auto', lexicon: opts.lexicon, install: opts.install });
  if (!first) return null;
  const candidates: Array<Candidate<LocalTranscript>> = [{ pass: first, score: score(first, context) }];
  const s1 = candidates[0].score;
  if (s1.verdict !== 'clean' && first.text) {
    // This take may end in "Anlayamadım": render its cue now, alongside pass 2, rather than after
    // it (the phone never calls /warm, so nothing may have pre-rendered it). Cached; a no-op after.
    prerenderCue(context.primary ?? normalizeLanguage(opts.ui) ?? 'en');
    const target = context.primary ?? context.set[0] ?? normalizeLanguage(opts.ui);
    let second: LocalTranscript | null = null;
    if (s1.loop) {
      second = await transcribeLocal(wav, { language: first.language ?? 'auto', lexicon: opts.lexicon, primer: false, temperature: 0.2, install: opts.install });
    } else if ((!first.forced || !s1.inContext) && target && target !== (first.forced ? first.language : null)) {
      second = await transcribeLocal(wav, { language: target, lexicon: opts.lexicon, install: opts.install });
    } else if (first.forced) {
      second = await transcribeLocal(wav, { language: 'auto', lexicon: opts.lexicon, install: opts.install });
    }
    if (second) candidates.push({ pass: second, score: score(second, context) });
  }
  const { winner, verdict } = pick(candidates);
  return {
    winner,
    verdict,
    passes: candidates.length as 1 | 2,
    ms: Date.now() - started,
    context,
    attempts: candidates.map((c) => ({
      language: c.pass.language, forced: c.pass.forced, verdict: c.score.verdict, reasons: c.score.reasons,
      logprob: c.score.logprob === null ? null : Number(c.score.logprob.toFixed(3)), ms: c.pass.ms,
    })),
  };
}


export class TranscribeError extends Error {
  constructor(readonly code: 'stt_unconfigured' | 'stt_too_big' | 'stt_load_failed' | 'stt_pressure' | 'stt_failed' | 'garbled' | 'not_wav' | 'ffmpeg_missing' | 'ffmpeg_failed') {
    super(code);
    this.name = 'TranscribeError';
  }
}

/** The owner's engine, as the desktop route picks it: WAV in, text out (contract `TranscribeAudio`). */
export const transcribeAudio: TranscribeAudio = async (wav, opts = {}) => {
  if (!isWav(wav)) throw new TranscribeError('not_wav');
  const cfg = readVoiceConfig();
  const route = resolveDictation();
  if (route.engine === 'none') throw new TranscribeError('stt_unconfigured');
  if (route.engine === 'cloud') {
    if (!route.ready) throw new TranscribeError('stt_unconfigured');
    const cloud = await transcribeCloud(wav, { language: opts.language ?? cfg.sttLanguage });
    if (!cloud.ok) throw new TranscribeError(cloud.reason === 'auth' || cloud.reason === 'no_key' ? 'stt_unconfigured' : 'stt_failed');
    return cloud.text;
  }
  const install = route.install;
  if (!install) throw new TranscribeError('stt_unconfigured');
  if (route.blocked === 'too_big') throw new TranscribeError('stt_too_big');
  if (route.blocked === 'load_failed') throw new TranscribeError('stt_load_failed');
  if ((await checkPressure()).pressed) throw new TranscribeError('stt_pressure');
  const ladder = await transcribeWithRetry(wav, { cfg, conv: null, install });
  if (!ladder) throw new TranscribeError('stt_failed');
  if (ladder.verdict === 'garbled') throw new TranscribeError('garbled');
  return ladder.winner.pass.text;
};

/** Where ffmpeg may live: absolute paths only (a Finder-started app has no shell PATH). */
export const FFMPEG_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
export const FFMPEG_TIMEOUT_MS = 30_000;

export function findFfmpeg(candidates: readonly string[] = FFMPEG_CANDIDATES, exists: (p: string) => boolean = existsSync): string | null {
  for (const c of candidates) if (isAbsolute(c) && exists(c)) return c;
  return null;
}

/** The exact argument array (no shell): OGG in from a file, 16 kHz mono WAV out on stdout. */
export function ffmpegArgs(oggPath: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'ogg', '-i', oggPath, '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'];
}

/** OGG/Opus voice note → WAV bytes. `ffmpeg_missing` when no ffmpeg is installed. */
export function oggToWav(oggPath: string, opts: { ffmpeg?: string | null; timeoutMs?: number } = {}): Promise<Buffer> {
  const bin = opts.ffmpeg === undefined ? findFfmpeg() : opts.ffmpeg;
  if (!bin) return Promise.reject(new TranscribeError('ffmpeg_missing'));
  if (!isAbsolute(oggPath)) return Promise.reject(new TranscribeError('ffmpeg_failed'));
  return new Promise((resolve, reject) => {
    execFile(bin, ffmpegArgs(oggPath), { timeout: opts.timeoutMs ?? FFMPEG_TIMEOUT_MS, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(new TranscribeError((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'ffmpeg_missing' : 'ffmpeg_failed')); return; }
      const wav = Buffer.from(stdout);
      if (!isWav(wav)) { reject(new TranscribeError('ffmpeg_failed')); return; }
      resolve(wav);
    });
  });
}

/** A Telegram voice note's path → its transcript (the hub's `transcribeVoice`). */
export async function transcribeVoiceNote(oggPath: string, deps: { toWav?: typeof oggToWav; transcribe?: TranscribeAudio } = {}): Promise<string> {
  const wav = await (deps.toWav ?? oggToWav)(oggPath);
  return (deps.transcribe ?? transcribeAudio)(wav);
}
