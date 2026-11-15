/**
 * Speech for a Telegram voice bubble: pcm16 (24 kHz mono, what `synthChunk` makes) → OGG/Opus.
 *
 * Telegram draws `sendVoice` as a voice bubble (waveform, duration) only for OGG/Opus; another
 * container arrives as a file. ffmpeg is the one encoder: by ABSOLUTE path (a Finder-started app
 * has no shell PATH, `findFfmpeg`), `spawn` with an argument array (no shell), the pcm on stdin
 * and the OGG on stdout, so no temp file is ever written. The inbound voice notes need the same
 * ffmpeg, so a Mac that hears his voice notes can also answer with one.
 */
import { spawn } from 'node:child_process';
import { findFfmpeg, FFMPEG_TIMEOUT_MS } from './transcribe.js';
import { PCM16_SAMPLE_RATE } from './wav.js';

/** Largest OGG accepted back (a 3-minute voice at 32 kbps is about 0.7 MB). */
export const MAX_VOICE_OGG_BYTES = 16 * 1024 * 1024;

/** The exact argument array: raw pcm16 mono in on stdin, OGG/Opus 32 kbps out on stdout. */
export function opusArgs(sampleRate: number = PCM16_SAMPLE_RATE): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe',
    '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1',
  ];
}

export type EncodeResult = { ok: true; ogg: Buffer } | { ok: false; reason: 'ffmpeg_missing' | 'failed' };

/** pcm16 mono → OGG/Opus bytes. Never throws. */
export function pcmToOggOpus(
  pcm: Buffer,
  opts: { ffmpeg?: string | null; timeoutMs?: number; spawnImpl?: typeof spawn } = {},
): Promise<EncodeResult> {
  const bin = opts.ffmpeg === undefined ? findFfmpeg() : opts.ffmpeg;
  if (!bin) return Promise.resolve({ ok: false, reason: 'ffmpeg_missing' });
  return new Promise((resolve) => {
    let settled = false;
    // Declared before `done`: a synchronous spawn throw calls `done` before any timer exists.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: EncodeResult): void => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = (opts.spawnImpl ?? spawn)(bin, opusArgs(), { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      done({ ok: false, reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'ffmpeg_missing' : 'failed' });
      return;
    }
    timer = setTimeout(() => { child.kill('SIGKILL'); done({ ok: false, reason: 'failed' }); }, opts.timeoutMs ?? FFMPEG_TIMEOUT_MS);
    timer.unref?.();
    const parts: Buffer[] = [];
    let size = 0;
    child.stdout?.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_VOICE_OGG_BYTES) { child.kill('SIGKILL'); done({ ok: false, reason: 'failed' }); return; }
      parts.push(c);
    });
    child.on('error', (err: NodeJS.ErrnoException) => done({ ok: false, reason: err.code === 'ENOENT' ? 'ffmpeg_missing' : 'failed' }));
    child.on('close', (code) => {
      const ogg = Buffer.concat(parts);
      // An OGG stream opens with the capture pattern "OggS".
      if (code === 0 && ogg.length > 4 && ogg.subarray(0, 4).toString('latin1') === 'OggS') done({ ok: true, ogg });
      else done({ ok: false, reason: 'failed' });
    });
    child.stdin?.on('error', () => { /* ffmpeg exited early: `close` decides */ });
    child.stdin?.end(pcm);
  });
}
