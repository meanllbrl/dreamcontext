/**
 * PCM16 → WAV, on both sides of the wire.
 *
 * WHY THIS EXISTS AT ALL. OpenRouter serves audio through CHAT COMPLETIONS, not through the
 * OpenAI-compatible `/audio/*` endpoints (those routes answer, but no speech or transcription
 * model exists behind them — see `openrouter.ts`). The chat path takes audio IN as base64
 * `wav` or `mp3` only, and streams audio OUT as headerless `pcm16`. So the browser has to
 * produce a WAV rather than whatever `MediaRecorder` felt like, and the server has to put a
 * header back on what the model returns before anything can play it.
 *
 * Both halves are 44 bytes of arithmetic, and both are pure, which is the point: the format
 * is testable without a microphone, a speaker or a network.
 */

/** What the chat audio stream returns: 24 kHz mono, signed 16-bit little-endian. */
export const PCM16_SAMPLE_RATE = 24_000;

/** The canonical 44-byte RIFF/WAVE header for mono 16-bit PCM. */
export function wavHeader(byteLength: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + byteLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);            // PCM fmt chunk size
  h.writeUInt16LE(1, 20);             // format 1 = PCM
  h.writeUInt16LE(1, 22);             // channels
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 2 bytes/sample)
  h.writeUInt16LE(2, 32);             // block align
  h.writeUInt16LE(16, 34);            // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(byteLength, 40);
  return h;
}

/** Wrap raw PCM16 samples in a playable WAV container. */
export function wavFromPcm16(pcm: Buffer, sampleRate: number = PCM16_SAMPLE_RATE): Buffer {
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
}

/** Seconds of audio in a PCM16 mono buffer — used for logging and the length cap. */
export function pcmSeconds(pcm: Buffer, sampleRate: number = PCM16_SAMPLE_RATE): number {
  return pcm.length / 2 / sampleRate;
}
