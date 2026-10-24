import type { SuperCueKind } from '../components/sleepy/super/superCues';

/**
 * The Super Agent's verb sounds (AC16): short, soft, synthesized with WebAudio (no asset, no
 * network), one per cue so each verb is recognisable by ear. The same envelope family as the
 * ask chime and the mic earcons (`chime.ts`) but quieter: feedback, never an alarm.
 *
 * Silent when the owner switched them off (Settings → Chat → Super Agent, this machine), while
 * he types in the super composer, while a spoken answer plays, when the window is not in front,
 * and more often than once per MIN_GAP_MS. A blocked audio context just stays silent.
 */

export const SUPER_SOUNDS_KEY = 'dc.super.sounds';
const MIN_GAP_MS = 250;
const TYPING_QUIET_MS = 2000;

/** One note: start offset (s), frequency (Hz), length (s), peak gain. */
export type Note = [at: number, freq: number, dur: number, gain: number];

/** The notes of each cue. Pure, so a test can pin that every cue is short and soft. */
export const CUE_NOTES: Record<SuperCueKind, Note[]> = {
  // A small rising run: something leaves the centre and lands in orbit.
  delegate: [[0, 659.3, 0.09, 0.045], [0.06, 880, 0.09, 0.045], [0.12, 1318.5, 0.2, 0.04]],
  open: [[0, 987.8, 0.14, 0.035]],
  arrive: [[0, 1174.7, 0.12, 0.025]],
  present: [[0, 784, 0.1, 0.035], [0.07, 1174.7, 0.16, 0.035]],
  stack: [[0, 523.3, 0.1, 0.03]],
  float: [[0, 659.3, 0.1, 0.03]],
  close: [[0, 880, 0.08, 0.03], [0.06, 587.3, 0.14, 0.03]],
  group: [[0, 784, 0.16, 0.025], [0.02, 987.8, 0.16, 0.025]],
  ungroup: [[0, 987.8, 0.1, 0.025], [0.05, 784, 0.12, 0.025]],
  merge: [[0, 587.3, 0.1, 0.035], [0.08, 880, 0.1, 0.035], [0.16, 1174.7, 0.18, 0.03]],
  answer: [[0, 1046.5, 0.1, 0.03]],
};

interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }
function store(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** On by default; the owner turns it off in Settings. */
export function superSoundsEnabled(s: Store | null = store()): boolean {
  return s?.getItem(SUPER_SOUNDS_KEY) !== '0';
}
export function setSuperSounds(on: boolean, s: Store | null = store()): void {
  try { s?.setItem(SUPER_SOUNDS_KEY, on ? '1' : '0'); } catch { /* storage full: stays as it was */ }
}

export interface QuietFacts {
  /** A spoken answer is playing in the super chat. */
  speaking: boolean;
  /** When the owner last typed in the super composer (0 = never). */
  typedAt: number;
  /** The window is visible and in front. */
  focused: boolean;
  now: number;
}

let last = 0;

/** Would a cue sound play now? Pure apart from the gap clock it is given. */
export function cueMayPlay(f: QuietFacts, lastAt: number, enabled: boolean): boolean {
  if (!enabled || f.speaking || !f.focused) return false;
  if (f.typedAt > 0 && f.now - f.typedAt < TYPING_QUIET_MS) return false;
  return f.now - lastAt >= MIN_GAP_MS;
}

let ctx: AudioContext | null = null;

export function playSuperCue(kind: SuperCueKind, facts: QuietFacts): boolean {
  if (!cueMayPlay(facts, last, superSoundsEnabled())) return false;
  last = facts.now;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    for (const [at, freq, dur, peak] of CUE_NOTES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.05);
    }
    return true;
  } catch {
    return false;
  }
}
