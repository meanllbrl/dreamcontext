/**
 * Voice notes from Telegram (W2 lane C, plan "Voice", A6): OGG → WAV through ffmpeg by absolute
 * path with a fixed argument array and the protocol whitelist; no ffmpeg → `ffmpeg_missing`; the
 * transcript comes from the shared core, which refuses a non-WAV and a garbled take.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ffmpegArgs, findFfmpeg, isWav, oggToWav, transcribeVoiceNote, TranscribeError, FFMPEG_TIMEOUT_MS } from '../../src/lib/voice/transcribe.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'voice', 'tone.ogg');
const ffmpeg = findFfmpeg();

describe('ffmpeg wrapper', () => {
  it('is an argument array with the OGG demuxer and the file,pipe whitelist; 30 s timeout', () => {
    expect(ffmpegArgs('/tmp/a b;rm -rf.ogg')).toEqual(['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'ogg', '-i', '/tmp/a b;rm -rf.ogg', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1']);
    expect(FFMPEG_TIMEOUT_MS).toBe(30_000);
  });

  it('only absolute candidates count', () => {
    expect(findFfmpeg(['ffmpeg', 'bin/ffmpeg'], () => true)).toBeNull();
    expect(findFfmpeg(['/x/ffmpeg'], () => true)).toBe('/x/ffmpeg');
    expect(findFfmpeg(['/x/ffmpeg'], () => false)).toBeNull();
  });

  it('no ffmpeg → ffmpeg_missing; a relative input → refused', async () => {
    await expect(oggToWav(FIXTURE, { ffmpeg: null })).rejects.toMatchObject({ code: 'ffmpeg_missing' });
    await expect(oggToWav('tone.ogg', { ffmpeg: '/bin/false' })).rejects.toMatchObject({ code: 'ffmpeg_failed' });
  });

  it.runIf(!!ffmpeg)('the fixture OGG becomes a WAV', async () => {
    const wav = await oggToWav(FIXTURE);
    expect(isWav(wav)).toBe(true);
    expect(wav.length).toBeGreaterThan(1000);
  });
});

describe('transcribeVoiceNote', () => {
  it('converts, then transcribes with the shared core', async () => {
    const wav = Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(8)]);
    const text = await transcribeVoiceNote('/x/a.ogg', { toWav: async () => wav, transcribe: async (w) => (isWav(w) ? 'merhaba dünya' : 'x') });
    expect(text).toBe('merhaba dünya');
  });

  it('a missing ffmpeg surfaces as ffmpeg_missing (the hub tells how to install it)', async () => {
    const err = await transcribeVoiceNote('/x/a.ogg', { toWav: () => Promise.reject(new TranscribeError('ffmpeg_missing')) }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscribeError);
    expect(String(err.message)).toMatch(/ffmpeg_missing/);
  });
});
