/**
 * Speed speech up (or slow it down) WITHOUT changing its pitch.
 *
 * The reply's audio used to be sped up with `AudioBufferSourceNode.playbackRate`, which is a
 * tape played fast: tempo AND pitch rise together, so at the owner's 1.35x every voice came
 * out ~5 semitones high ("helyum çekmiş gibi", 2026-09-27). This is WSOLA — waveform-similarity
 * overlap-add: the output is built from short windowed grains of the input, taken at the
 * faster pace, each one nudged (within a small tolerance) to the spot where its waveform
 * lines up with the grain before it. Periods are copied, never resampled, so the pitch is the
 * speaker's own. The result is played at rate 1.
 *
 * Pure and synchronous: a ~4 s chunk at 24 kHz takes a few milliseconds, well inside the
 * time the next chunk spends being generated.
 */

/** Grain length. ~30 ms spans a few pitch periods of any speaking voice. */
const WINDOW_SEC = 0.03;
/** How far a grain may move to line up with the previous one. */
const TOLERANCE_SEC = 0.01;
/** Correlation is sampled every Nth point: plenty for alignment, a fraction of the cost. */
const CORR_STEP = 2;

/**
 * Time-stretch mono PCM by `rate` (> 1 = faster/shorter), keeping the pitch.
 * Returns the input unchanged for a rate of ~1 or a clip too short to stretch.
 */
export function timeStretch(input: Float32Array, sampleRate: number, rate: number): Float32Array {
  if (!Number.isFinite(rate) || rate <= 0 || Math.abs(rate - 1) < 0.01) return input;
  const n = Math.max(64, Math.round(WINDOW_SEC * sampleRate) & ~1);
  const hs = n / 2;                         // synthesis hop: 50% overlap
  const ha = hs * rate;                     // analysis hop: how fast we walk the input
  const tol = Math.round(TOLERANCE_SEC * sampleRate);
  if (input.length < n + 2 * tol) return input;

  const outLen = Math.max(n, Math.floor(input.length / rate));
  const out = new Float32Array(outLen + n);
  const norm = new Float32Array(outLen + n);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);

  let prev = 0;                              // where the last grain was taken from
  for (let k = 0, outPos = 0; outPos < outLen; k++, outPos += hs) {
    const nominal = Math.round(k * ha);
    let best = nominal;
    if (k > 0) {
      // The ideal continuation of the previous grain is `prev + hs`; find the grain near
      // `nominal` whose waveform matches it best.
      const target = prev + hs;
      let bestScore = -Infinity;
      const lo = Math.max(0, nominal - tol);
      const hi = Math.min(input.length - n, nominal + tol);
      for (let cand = lo; cand <= hi; cand++) {
        let score = 0;
        for (let i = 0; i < n; i += CORR_STEP) {
          const t = target + i;
          if (t >= input.length) break;
          score += input[cand + i] * input[t];
        }
        if (score > bestScore) { bestScore = score; best = cand; }
      }
    }
    if (best + n > input.length) best = Math.max(0, input.length - n);
    for (let i = 0; i < n; i++) {
      out[outPos + i] += input[best + i] * win[i];
      norm[outPos + i] += win[i];
    }
    prev = best;
  }
  const result = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) result[i] = norm[i] > 1e-6 ? out[i] / norm[i] : 0;
  return result;
}
