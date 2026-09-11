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

// ─── Making the answer as loud as it can honestly be ───────────────────────────────────

/**
 * The level a spoken chunk is brought to, as RMS over the parts of it that are actually
 * speech. ≈ -18 dBFS, which is where broadcast speech sits: loud enough to carry over a room,
 * far enough from full scale that the peaks have somewhere to go.
 */
export const SPEECH_TARGET_RMS = 0.12;

/** Nothing is ever pushed past this peak. Gain that would clip is not gain, it is distortion,
 *  and a distorted voice is harder to follow than a quiet one. */
export const SPEECH_PEAK_CEILING = 0.89;

/** The most a chunk may be lifted. A ceiling because the gain is flat across the whole chunk:
 *  past ~4x, the model's own breath and room noise come up with the words. */
export const MAX_SPEECH_GAIN = 4;

/** Below this peak there is no speech in the buffer to lift. */
const SPEECH_FLOOR = 0.002;

/**
 * Bring one spoken chunk up to a consistent, audible level.
 *
 * ── WHY THE SERVER DOES THIS AND NOT THE CLIENT ─────────────────────────────────────────
 * The client's only lever is a WebAudio gain node, which is applied AFTER the system's master
 * volume and therefore cannot buy back anything the master took away. Here the audio is still
 * digital and still has its headroom, so a chunk that came back quiet can be lifted before it
 * is ever encoded — which is the only place in the whole path where "make the answer louder"
 * is a thing that can actually be done.
 *
 * It also fixes a second, quieter complaint: chunk-to-chunk level drift. Each sentence is a
 * separate generation, and the model does not hold a consistent level across them, so an
 * answer arrives with one sentence at a comfortable volume and the next noticeably under it.
 * Normalising every chunk to the same target is what makes a paragraph sound like one voice.
 *
 * ── HOW THE LEVEL IS MEASURED ───────────────────────────────────────────────────────────
 * RMS over the ACTIVE samples only — those above a tenth of the chunk's peak. A plain RMS
 * over the whole buffer is dragged down by the silence the model leaves at each end, and a
 * short sentence with a long tail would then be amplified for being mostly quiet rather than
 * for being quiet.
 *
 * Only ever amplifies. A chunk that is already at or above target is returned UNCHANGED (the
 * same Buffer, not a copy) — turning a loud chunk down would be solving a problem nobody has.
 */
export function normalizeSpeech(pcm: Buffer): Buffer {
  const count = Math.floor(pcm.length / 2);
  if (count === 0) return pcm;

  let peak = 0;
  for (let i = 0; i < count; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
    if (v > peak) peak = v;
  }
  if (peak < SPEECH_FLOOR) return pcm;            // silence, or a chunk that says nothing

  // The activity gate: a tenth of the peak is comfortably below any voiced sample and
  // comfortably above the model's room tone.
  const gate = peak * 0.1;
  let sum = 0;
  let active = 0;
  for (let i = 0; i < count; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    if (Math.abs(v) < gate) continue;
    sum += v * v;
    active += 1;
  }
  if (active === 0) return pcm;
  const rms = Math.sqrt(sum / active);
  if (rms <= 0) return pcm;

  const gain = Math.min(MAX_SPEECH_GAIN, SPEECH_TARGET_RMS / rms, SPEECH_PEAK_CEILING / peak);
  if (gain <= 1.01) return pcm;                   // already there — no copy, no work

  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < count; i++) {
    const scaled = Math.round(pcm.readInt16LE(i * 2) * gain);
    // Saturate rather than wrap. The ceiling above makes this unreachable in practice; it is
    // here because a wrapped sample is a click, and a click in a voice is unmistakable.
    out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i * 2);
  }
  return out;
}
