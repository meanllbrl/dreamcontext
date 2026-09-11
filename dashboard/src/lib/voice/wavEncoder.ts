/**
 * The browser half of the audio format: raw microphone samples → a 16 kHz mono WAV.
 *
 * WHY THE APP ENCODES ITS OWN WAV INSTEAD OF USING `MediaRecorder`. The transcription path
 * accepts exactly two formats: `wav` and `mp3`. `MediaRecorder` produces neither — WebKit
 * gives `audio/mp4`, Chromium `audio/webm` — and both are refused with a 400 several seconds
 * after the owner let go of the button. There is no conversion step available in a webview,
 * so the recording itself has to be the right thing.
 *
 * Everything here is PURE and takes plain arrays, so the format is testable in Node without a
 * microphone, a permission dialog or an AudioContext.
 *
 * 16 kHz because speech models are trained at it and it is a quarter of the bytes of the
 * 48 kHz the device hands us.
 *
 * ── WHY THIS FILE GOT SERIOUS ABOUT THE SIGNAL ──────────────────────────────────────────
 * The owner's verdict, 2026-09-12: the app's dictation is worse than the whisper.cpp they run
 * by hand — with the SAME model, `large-v3-turbo`, on the same machine. The model is
 * therefore not the variable. What is left is the audio handed to it, and this file owned
 * three of the four defects in it:
 *
 *   • a box-average "low-pass" that is not one (see {@link resample}),
 *   • no DC removal, so a mic with an offset spent part of its range on a constant,
 *   • no level normalisation, which matters a great deal now that the capture asks for the
 *     RAW device (`useVoiceCapture.ts` switches AGC off) and a quiet room therefore stays
 *     quiet all the way to the encoder.
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
 * How many zero crossings of the sinc each side of the centre tap the filter keeps.
 *
 * Eight is the usual "good enough for speech" figure: the stop band lands around -60 dB,
 * which is far below anything a log-mel front end can see, and the kernel stays short enough
 * that a ten-second take resamples in a few milliseconds.
 */
const LOBES = 8;

/** How finely the fractional position between input samples is quantised. 256 phases is
 *  ~-72 dB of interpolation error — inaudible, and it turns the kernel into a table computed
 *  once per take instead of a `Math.sin` per tap. */
const PHASES = 256;

/**
 * Resample with a WINDOWED-SINC low-pass, not by averaging a window.
 *
 * ── WHY THE AVERAGE WAS NOT GOOD ENOUGH, AND IT IS NOT A DETAIL ─────────────────────────
 * The rule this replaces took the mean of each source window and called it "a crude
 * low-pass". A 3-sample box filter at 48 kHz is a low-pass whose first null sits at 16 kHz
 * and whose first side lobe is only 13 dB down — so everything the microphone picked up
 * between 8 and 24 kHz folded straight back into the speech band, at barely an eighth of its
 * original level. That is a metallic ring laid over consonants, on a signal whose entire job
 * is to be recognised, and it is exactly the kind of damage that shows up as "the same model
 * transcribes my voice worse in this app than on the command line".
 *
 * A sinc kernel windowed by Blackman cuts at the true Nyquist of the TARGET rate, so nothing
 * above 8 kHz is left to fold. The kernel is built once per call and the fractional position
 * is quantised to {@link PHASES}, so the cost is one multiply-add per tap.
 *
 * Handles any ratio, not just integers: a 44.1 kHz device is as ordinary as a 48 kHz one.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (!(from > 0) || !(to > 0) || input.length === 0) return input;
  if (to >= from) return input;

  const ratio = to / from;
  // The cutoff, normalised to the INPUT rate: half the target rate is where aliasing begins.
  const fc = 0.5 * ratio;
  // Kernel support in input samples. Wider as the ratio gets steeper, which is exactly the
  // case that needs more of it.
  const half = Math.ceil(LOBES / (2 * fc));
  const taps = half * 2 + 1;

  // ── The phase table ───────────────────────────────────────────────────────────────────
  // kernel[p][k] is the weight of input sample `base + k - half` for an output whose exact
  // centre falls `p / PHASES` of a sample past `base`.
  const kernel = new Float32Array(PHASES * taps);
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const x = k - half - frac;                       // distance from the centre, in samples
      const arg = 2 * Math.PI * fc * x;
      const sinc = Math.abs(arg) < 1e-8 ? 1 : Math.sin(arg) / arg;
      // Blackman, over the kernel's own support. Its -58 dB side lobes are what make the
      // stop band deep enough that nothing audible folds back.
      const w = 0.42
        - 0.5 * Math.cos((2 * Math.PI * (k)) / (taps - 1))
        + 0.08 * Math.cos((4 * Math.PI * (k)) / (taps - 1));
      const v = sinc * w;
      kernel[p * taps + k] = v;
      sum += v;
    }
    // NORMALISED PER PHASE. Without this, DC gain wobbles with the fractional offset and a
    // steady tone comes out amplitude-modulated at the beat between the two rates.
    if (sum !== 0) {
      for (let k = 0; k < taps; k++) kernel[p * taps + k] /= sum;
    }
  }

  const outLength = Math.floor(input.length * ratio);
  const out = new Float32Array(outLength);
  const step = from / to;
  for (let i = 0; i < outLength; i++) {
    const centre = i * step;
    const base = Math.floor(centre);
    const p = Math.min(PHASES - 1, Math.floor((centre - base) * PHASES));
    const row = p * taps;
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const j = base + k - half;
      // Outside the take is SILENCE, not a repeated edge sample: a held edge is a step, and a
      // step is broadband.
      if (j < 0 || j >= input.length) continue;
      acc += input[j] * kernel[row + k];
    }
    out[i] = acc;
  }
  return out;
}

/**
 * Remove the constant offset a microphone's DC bias leaves on the take.
 *
 * It is inaudible and it still costs: the offset eats headroom that the normalisation below
 * would otherwise give to the speech, and whisper's front end spends a mel bin on it.
 * Returns the SAME array when there is nothing to remove, so a clean take copies nothing.
 */
export function removeDc(samples: Float32Array): Float32Array {
  if (samples.length === 0) return samples;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  const mean = sum / samples.length;
  if (Math.abs(mean) < 1e-5) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] - mean;
  return out;
}

/** The peak the normaliser aims for. Just below full scale: a hair of headroom for the
 *  16-bit rounding, and nothing more — quantisation noise is the one thing a quiet take
 *  cannot afford. */
export const TARGET_PEAK = 0.89;

/** The most a take may be amplified. A ceiling exists because the gain is applied to the
 *  WHOLE take including the room between words: past ~6x the room comes up with the voice
 *  and whisper starts transcribing the refrigerator. */
export const MAX_TAKE_GAIN = 6;

/** Below this peak a take is not speech at all, and lifting it would only make the room
 *  loud. Sits an order of magnitude under the capture gate's own RMS floor. */
export const NORMALIZE_FLOOR = 0.001;

/**
 * Bring a take up to a consistent level.
 *
 * NOT cosmetic, and it earned its place the moment the capture stopped asking the browser for
 * automatic gain control (`useVoiceCapture.ts`): with AGC on, every take arrived at roughly
 * the same level whatever the room did; with it off — which is what makes the signal honest —
 * a quiet speaker at arm's length can land 20 dB down, and a 16-bit encode of that spends
 * most of its range on nothing.
 *
 * Pure gain, no compression: the dynamics are the speech, and squashing them is the thing AGC
 * was doing wrong in the first place. Silence stays silence ({@link NORMALIZE_FLOOR}), and a
 * take that is already loud is returned untouched rather than pushed into the clipper.
 */
export function normalizeTake(samples: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < NORMALIZE_FLOOR) return samples;          // silence, or near enough
  const gain = Math.min(MAX_TAKE_GAIN, TARGET_PEAK / peak);
  if (gain <= 1) return samples;                       // already at or above target
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
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

/**
 * The whole pipeline: collected frames at the device's rate → an uploadable 16 kHz WAV.
 *
 * ORDER IS LOAD-BEARING. DC comes off first, so the offset is not what the normaliser
 * measures as "peak". Resampling comes before the gain, so the anti-alias filter works on the
 * original dynamic range and the gain is applied to what actually gets encoded — a take
 * normalised first and filtered after can be pushed back over full scale by the filter's own
 * overshoot.
 */
export function wavFromTake(chunks: Float32Array[], deviceRate: number): Uint8Array {
  const merged = removeDc(mergeChunks(chunks));
  const at16k = resample(merged, deviceRate, TARGET_SAMPLE_RATE);
  return encodeWav(normalizeTake(at16k), TARGET_SAMPLE_RATE);
}
