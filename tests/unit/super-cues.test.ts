/**
 * The stage's verb cues and its reveal gate (jarvis plan r9 G1, AC16), and the verb sounds:
 * short, soft, quiet while the owner types or a spoken answer plays, off in Settings.
 */
import { describe, it, expect } from 'vitest';
import { CUE_MS, REVEAL_GAP_MS, TYPING_HOLD_MS, cueOf, holdsNewCards, revealStep } from '../../dashboard/src/components/sleepy/super/superCues.js';
import { CUE_NOTES, SUPER_SOUNDS_KEY, cueMayPlay, setSuperSounds, superSoundsEnabled } from '../../dashboard/src/lib/superSfx.js';

describe('cues', () => {
  it('every stage verb has its own cue; reading verbs have none', () => {
    for (const v of ['delegate', 'open', 'half', 'present', 'stack', 'float', 'close', 'group', 'ungroup', 'merge', 'answer']) expect(cueOf(v), v).not.toBeNull();
    for (const v of ['state', 'read', 'brief', 'queue-list', 'constructor']) expect(cueOf(v), v).toBeNull();
    expect(CUE_MS).toBeLessThanOrEqual(1200);
  });

  it('G1: held while dragging or typing; then one at a time, REVEAL_GAP_MS apart', () => {
    expect(holdsNewCards({ dragging: true, typedAt: 0, now: 10_000 })).toBe(true);
    expect(holdsNewCards({ dragging: false, typedAt: 9_000, now: 10_000 })).toBe(true);
    expect(holdsNewCards({ dragging: false, typedAt: 10_000 - TYPING_HOLD_MS, now: 10_000 })).toBe(false);
    expect(revealStep({ pending: ['a', 'b'], dragging: true, typedAt: 0, lastRevealAt: 0, now: 10_000 })).toEqual({ reveal: null, wakeAt: null });
    expect(revealStep({ pending: ['a'], dragging: false, typedAt: 9_500, lastRevealAt: 0, now: 10_000 })).toEqual({ reveal: null, wakeAt: 9_500 + TYPING_HOLD_MS });
    expect(revealStep({ pending: ['a', 'b'], dragging: false, typedAt: 0, lastRevealAt: 0, now: 10_000 })).toEqual({ reveal: 'a', wakeAt: 10_000 + REVEAL_GAP_MS });
    expect(revealStep({ pending: ['b'], dragging: false, typedAt: 0, lastRevealAt: 10_000, now: 10_100 })).toEqual({ reveal: null, wakeAt: 10_000 + REVEAL_GAP_MS });
  });
});

describe('verb sounds', () => {
  it('each cue is short and soft', () => {
    for (const [kind, notes] of Object.entries(CUE_NOTES)) {
      expect(notes.length, kind).toBeGreaterThan(0);
      for (const [at, , dur, gain] of notes) {
        expect(at + dur, kind).toBeLessThanOrEqual(0.5);
        expect(gain, kind).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it('quiet while typing, while speaking, when not in front, too often, or switched off', () => {
    const f = { speaking: false, typedAt: 0, focused: true, now: 10_000 };
    expect(cueMayPlay(f, 0, true)).toBe(true);
    expect(cueMayPlay(f, 0, false)).toBe(false);
    expect(cueMayPlay({ ...f, speaking: true }, 0, true)).toBe(false);
    expect(cueMayPlay({ ...f, focused: false }, 0, true)).toBe(false);
    expect(cueMayPlay({ ...f, typedAt: 9_000 }, 0, true)).toBe(false);
    expect(cueMayPlay(f, 9_900, true)).toBe(false);
  });

  it('the Settings switch is stored per machine and on by default', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    expect(superSoundsEnabled(s)).toBe(true);
    setSuperSounds(false, s);
    expect(m.get(SUPER_SOUNDS_KEY)).toBe('0');
    expect(superSoundsEnabled(s)).toBe(false);
  });
});

describe('a closed card fades out where it stood; with reduced motion it is gone at once (owner, 2026-10-21)', async () => {
  const { readFileSync } = await import('node:fs');
  const { withGhosts } = await import('../../dashboard/src/components/sleepy/super/useStageCues.js');
  const css = readFileSync(new URL('../../dashboard/src/components/sleepy/super/SuperSurface.css', import.meta.url), 'utf-8');
  const card = (id: string) => ({ id });

  it('the fading card keeps its index among the others (its node is not moved, an iframe in it does not reload)', () => {
    expect(withGhosts([card('a'), card('c')], [{ card: card('b'), index: 1 }]).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(withGhosts([card('b')], [{ card: card('a'), index: 0 }, { card: card('c'), index: 2 }]).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    // Back in the record meanwhile: drawn once, as itself.
    expect(withGhosts([card('a'), card('b')], [{ card: card('b'), index: 0 }]).map((c) => c.id)).toEqual(['a', 'b']);
    expect(withGhosts([], [{ card: card('x'), index: 9 }]).map((c) => c.id)).toEqual(['x']);
  });

  it('close = a one-time opacity fade to 0 on transform/opacity only; reduced motion = no animation, opacity 0 at once', () => {
    const fade = /@keyframes super-cue-fade \{([^}]*\}[^}]*)\}/.exec(css)?.[1] ?? '';
    expect(fade).toMatch(/to \{ opacity: 0;/);
    expect(fade).not.toMatch(/width|height|top|left|filter/);
    expect(css).toMatch(/\.super-card-frame\[data-cue='close'\] \.super-card-clip,\s*\.super-card-frame\[data-cue='close'\] \.super-card-lift \{ animation: super-cue-fade 360ms ease-in both; \}/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.super-card-frame\[data-cue='close'\] \{ opacity: 0; \}/);
    expect(reduced).toMatch(/\.super-card-frame\[data-cue='close'\] \.super-card-lift \{ animation: none; \}/);
    expect(css).not.toMatch(/super-cue[\w-]*[^;]*infinite/);
  });
});
