/**
 * K14 (plan super-v3): the presentation window is as wide as what it shows. Compared with the
 * approved mockups' own drawn windows (tests/unit/fixtures/super-v3/frames.json, written by
 * scripts/verify/super-v3-oracle.mjs): frames 07a (a phone shot), 07b (a PDF page) and 07c (a
 * desktop page) within ±2 px, at the mockup's stage (1356 wide, 20 px gaps, window 684 tall).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PRESENT_WIN, contentShape, presentWidth, type PresentContent } from '../../dashboard/src/components/sleepy/super/superLayout.js';

interface Frame { present?: { x: number; y: number; width: number; height: number } }
const FRAMES = JSON.parse(readFileSync(new URL('./fixtures/super-v3/frames.json', import.meta.url), 'utf-8')) as Record<string, Frame>;

/** The mockup's stage: 1356 wide, 20 px between the chat, the window and the edges. */
const MOCK = { width: 1356, pad: 20 };
const room = MOCK.width - 3 * MOCK.pad - PRESENT_WIN.CHAT_MIN;
const PHONE = 390 / 844;
const A4 = 595 / 842;

const CASES: Array<[string, PresentContent]> = [
  ['07a-sunum-dar', { kind: 'phone', aspect: PHONE }],
  ['07b-sunum-orta', { kind: 'pdf', aspect: A4 }],
  ['07c-sunum-genis', { kind: 'desk' }],
];

describe('presentWidth equals the drawn window on frames 07a/b/c', () => {
  for (const [name, content] of CASES) {
    it(name, () => {
      const drawn = FRAMES[name].present!;
      const w = presentWidth(content, drawn.height - PRESENT_WIN.TITLE_H, 1, room);
      expect(Math.abs(w - drawn.width), `${name}: ${w} vs ${drawn.width}`).toBeLessThanOrEqual(2);
    });
  }
});

describe('presentWidth rules', () => {
  it('a session tab is 600, an album 520, a desktop album 760', () => {
    expect(presentWidth({ kind: 'session' }, 640, 1)).toBe(600);
    expect(presentWidth({ kind: 'album' }, 640, 1)).toBe(520);
    expect(presentWidth({ kind: 'albumdesk' }, 640, 1)).toBe(760);
  });
  it('never under the tabs floor (160 + 170 per tab)', () => {
    expect(presentWidth({ kind: 'phone', aspect: PHONE }, 640, 4)).toBe(160 + 4 * 170);
  });
  it('never more than the room that leaves the chat its floor', () => {
    expect(presentWidth({ kind: 'desk' }, 640, 1, 500)).toBe(500);
    expect(presentWidth({ kind: 'desk' }, 640, 1, -10)).toBe(0);
  });
});

describe('contentShape', () => {
  it('maps each card to what it shows', () => {
    expect(contentShape({ kind: 'chat' })).toEqual({ kind: 'session' });
    expect(contentShape({ kind: 'team' })).toEqual({ kind: 'session' });
    expect(contentShape({ kind: 'pdf' })).toEqual({ kind: 'pdf', aspect: A4 });
    expect(contentShape({ kind: 'pdf', aspect: 0.5 })).toEqual({ kind: 'pdf', aspect: 0.5 });
    expect(contentShape({ kind: 'image', aspect: PHONE })).toEqual({ kind: 'phone', aspect: PHONE });
    expect(contentShape({ kind: 'image', aspect: 1.6 })).toEqual({ kind: 'desk' });
    expect(contentShape({ kind: 'web', aspect: PHONE })).toEqual({ kind: 'phone', aspect: PHONE });
    expect(contentShape({ kind: 'web' })).toEqual({ kind: 'desk' });
    expect(contentShape({ kind: 'group' }, 3)).toEqual({ kind: 'album' });
    expect(contentShape(undefined)).toEqual({ kind: 'desk' });
  });
});
