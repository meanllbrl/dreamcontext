/**
 * The browser half of the audio format: raw microphone samples → a 16 kHz mono WAV.
 *
 * WHY THE APP ENCODES ITS OWN WAV INSTEAD OF USING `MediaRecorder`. The transcription path
 * is a chat completion with a base64 `input_audio` part, and upstream accepts exactly two
 * formats: `wav` and `mp3`. `MediaRecorder` produces neither — WebKit gives `audio/mp4`,
 * Chromium `audio/webm` — and both are refused with a 400 several seconds after the owner
 * let go of the button. There is no conversion step available in a webview, so the recording
 * itself has to be the right thing.
 *
 * Everything here is PURE and takes plain arrays, so the format is testable in Node without a
 * microphone, a permission dialog or an AudioContext.
 *
 * 16 kHz because speech models are trained at it and it is a quarter of the bytes of the
 * 48 kHz the device hands us — and those bytes are base64'd into a JSON body.
 */

/** What the take is resampled to before upload. */
export const TARGET_SAMPLE_RATE = 16_000;

/** Join the frames collected during a take into one buffer. */
export function mergeChunks(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Resample by AVERAGING each source window rather than picking one sample out of it.
 *
 * Dropping samples is the one-liner and it aliases: high-frequency content folds back into
 * the speech band as a metallic ring, on a signal whose whole job is to be recognised. The
 * mean over the window is a crude low-pass, which is all this needs and costs one loop.
 */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from || input.length === 0) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Float −1..1 → signed 16-bit, clamped. Values outside the range are what clipping IS; they
 *  must saturate rather than wrap, or a loud syllable becomes a burst of noise. */
export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** A complete mono 16-bit WAV file, header and all. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = toPcm16(samples);
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);              // PCM fmt chunk size
  view.setUint16(20, 1, true);               // format 1 = PCM
  view.setUint16(22, 1, true);               // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // byte rate
  view.setUint16(32, 2, true);               // block align
  view.setUint16(34, 16, true);              // bits per sample
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(bytes.buffer, 44).set(pcm);
  return bytes;
}

/** The whole pipeline: collected frames at the device's rate → an uploadable 16 kHz WAV. */
export function wavFromTake(chunks: Float32Array[], deviceRate: number): Uint8Array {
  const merged = mergeChunks(chunks);
  return encodeWav(downsample(merged, deviceRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
}
