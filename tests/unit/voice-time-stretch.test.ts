/**
 * The reply's speed is a TEMPO change, never a pitch change (owner, 2026-09-27: at 1.35x the
 * voice came out "helyum çekmiş gibi" because the chunk was played fast). Measured on a tone:
 * the stretched clip is shorter by the rate, and its frequency is the original's.
 */

import { describe, it, expect } from 'vitest';
import { timeStretch } from '../../dashboard/src/lib/voice/timeStretch';

const SR = 24_000;

function tone(freq: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

/** Frequency from upward zero crossings over the middle of the clip (edges are windowed). */
function frequency(x: Float32Array): number {
  const a = Math.floor(x.length * 0.2);
  const b = Math.floor(x.length * 0.8);
  let crossings = 0;
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
  return crossings / ((b - a) / SR);
}

describe('timeStretch', () => {
  it('1.35x is 1.35x SHORTER and keeps the pitch (the helium bug)', () => {
    const input = tone(220, 2);
    const out = timeStretch(input, SR, 1.35);
    expect(out.length).toBeCloseTo(input.length / 1.35, -2);
    expect(frequency(out)).toBeGreaterThan(215);
    expect(frequency(out)).toBeLessThan(225);
  });

  it('slows down without dropping the pitch either', () => {
    const out = timeStretch(tone(220, 1), SR, 0.8);
    expect(out.length).toBeCloseTo(SR / 0.8, -2);
    expect(Math.abs(frequency(out) - 220)).toBeLessThan(5);
  });

  it('leaves rate 1 and a too-short clip untouched', () => {
    const input = tone(220, 1);
    expect(timeStretch(input, SR, 1)).toBe(input);
    const tiny = new Float32Array(100);
    expect(timeStretch(tiny, SR, 1.5)).toBe(tiny);
  });

  it('does not clip: the output stays within the input amplitude', () => {
    const out = timeStretch(tone(180, 1.5), SR, 1.35);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(0.51);
  });
});
