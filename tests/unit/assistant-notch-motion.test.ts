/**
 * The notch opens and folds with a VISIBLE grow (dashboard/src/components/assistant/notchMotion.ts).
 *
 * Owner, 2026-10-04: the notch "just appears". The transparent window used to animate its
 * frame while the island inside it was drawn at full size, so nothing visibly grew. The plan
 * now lands the window in one step and grows the island in CSS; these pin the order (frame
 * first on open, CSS first on fold), last-request-wins, and reduced motion.
 */
import { describe, it, expect } from 'vitest';
import {
  NOTCH_GROW_MS, drawsOpen, islandClip, planMotion, type MotionPhase,
} from '../../dashboard/src/components/assistant/notchMotion';

const motion = { reduced: false };
const reduced = { reduced: true };

describe('planMotion: open', () => {
  it('from the pill: the window lands on the panel at once, THEN the island grows from the pill rect', () => {
    const plan = planMotion('closed', 'open', motion);
    expect(plan?.phase).toBe('opening');
    expect(plan?.steps).toEqual([
      { kind: 'frame', to: 'panel', ms: 0 },
      { kind: 'css', to: 'panel', from: 'rect', ms: NOTCH_GROW_MS },
      { kind: 'settle', phase: 'open' },
    ]);
  });

  it('the grow is a breath: ~220 ms', () => {
    expect(NOTCH_GROW_MS).toBeGreaterThanOrEqual(150);
    expect(NOTCH_GROW_MS).toBeLessThanOrEqual(300);
  });

  it('during a fold: grows back from wherever the island is now, never from the pill', () => {
    const plan = planMotion('folding', 'open', motion);
    expect(plan?.phase).toBe('opening');
    expect(plan?.steps[0]).toEqual({ kind: 'frame', to: 'panel', ms: 0 });
    expect(plan?.steps[1]).toEqual({ kind: 'css', to: 'panel', from: 'current', ms: NOTCH_GROW_MS });
    expect(plan?.steps.at(-1)).toEqual({ kind: 'settle', phase: 'open' });
  });

  it('already open or opening: nothing to do', () => {
    expect(planMotion('open', 'open', motion)).toBeNull();
    expect(planMotion('opening', 'open', motion)).toBeNull();
  });
});

describe('planMotion: fold', () => {
  it('from open: the island shrinks to the pill FIRST, then the window lands on the pill frame', () => {
    const plan = planMotion('open', 'fold', motion);
    expect(plan?.phase).toBe('folding');
    expect(plan?.steps).toEqual([
      { kind: 'css', to: 'pill', from: 'current', ms: NOTCH_GROW_MS },
      { kind: 'frame', to: 'pill', ms: 0 },
      { kind: 'settle', phase: 'closed' },
    ]);
  });

  it('during an open: shrinks from its midpoint, and the frame still lands last', () => {
    const plan = planMotion('opening', 'fold', motion);
    expect(plan?.steps.map((s) => s.kind)).toEqual(['css', 'frame', 'settle']);
    expect(plan?.steps[0]).toMatchObject({ from: 'current', to: 'pill' });
  });

  it('already closed or folding: nothing to do', () => {
    expect(planMotion('closed', 'fold', motion)).toBeNull();
    expect(planMotion('folding', 'fold', motion)).toBeNull();
  });
});

describe('planMotion: every frame step is instant, every run ends on its own request', () => {
  const phases: MotionPhase[] = ['closed', 'opening', 'open', 'folding'];
  for (const from of phases) {
    for (const req of ['open', 'fold'] as const) {
      it(`${req} from ${from}`, () => {
        const plan = planMotion(from, req, motion);
        if (!plan) return;
        for (const s of plan.steps) if (s.kind === 'frame') expect(s.ms).toBe(0);
        expect(plan.steps.at(-1)).toEqual({ kind: 'settle', phase: req === 'open' ? 'open' : 'closed' });
        const frame = plan.steps.find((s) => s.kind === 'frame');
        expect(frame).toMatchObject({ to: req === 'open' ? 'panel' : 'pill' });
      });
    }
  }

  it('a chain of requests (open, fold, open, fold) settles on the last one', () => {
    let phase: MotionPhase = 'closed';
    let last: MotionPhase = 'closed';
    for (const req of ['open', 'fold', 'open', 'fold', 'open'] as const) {
      const plan = planMotion(phase, req, motion);
      expect(plan).not.toBeNull();
      phase = plan!.phase;
      const settle = plan!.steps.at(-1);
      if (settle?.kind === 'settle') last = settle.phase;
    }
    expect(phase).toBe('opening');
    expect(last).toBe('open');
  });
});

describe('planMotion: prefers-reduced-motion', () => {
  it('open: no CSS step, the window lands and the state settles at once', () => {
    expect(planMotion('closed', 'open', reduced)?.steps).toEqual([
      { kind: 'frame', to: 'panel', ms: 0 },
      { kind: 'settle', phase: 'open' },
    ]);
  });
  it('fold: no CSS step either', () => {
    expect(planMotion('open', 'fold', reduced)?.steps).toEqual([
      { kind: 'frame', to: 'pill', ms: 0 },
      { kind: 'settle', phase: 'closed' },
    ]);
  });
});

describe('drawsOpen', () => {
  it('the island is drawn open while opening, open, and on its way back to the pill', () => {
    expect(drawsOpen('closed')).toBe(false);
    expect(drawsOpen('opening')).toBe(true);
    expect(drawsOpen('open')).toBe(true);
    expect(drawsOpen('folding')).toBe(true);
  });
});

describe('islandClip', () => {
  it('a rect is anchored top-centre with a flat top and rounded bottom corners', () => {
    expect(islandClip({ width: 300, height: 38 }, '16px'))
      .toBe('inset(0px calc(50% - 150px) calc(100% - 38px) calc(50% - 150px) round 0px 0px 16px 16px)');
  });
  it('null is the whole root, still with the rounded bottom', () => {
    expect(islandClip(null, '20px')).toBe('inset(0px 0px 0px 0px round 0px 0px 20px 20px)');
  });
  it('half pixels survive, long fractions do not', () => {
    expect(islandClip({ width: 461, height: 100.123 }, '1rem'))
      .toBe('inset(0px calc(50% - 230.5px) calc(100% - 100.12px) calc(50% - 230.5px) round 0px 0px 1rem 1rem)');
  });
});
