/**
 * The report page's picture bridge (layout/frameImageBridge.ts): a click on a picture in a sandboxed
 * report page is posted to the host, which opens its own viewer. The page's own scripts can post
 * the same shape, so the host keeps only data:image sources and the clicked picture must survive.
 */
import { describe, it, expect } from 'vitest';
import { IMAGE_BRIDGE, IMAGE_MESSAGE_KEY, MAX_IMAGES, readImageMessage, releaseFrameFocus } from '../../dashboard/src/components/layout/frameImageBridge.js';

const msg = (m: unknown) => ({ [IMAGE_MESSAGE_KEY]: m });
const png = (n: number) => ({ src: `data:image/png;base64,AAA${n}`, alt: `a${n}` });

describe('readImageMessage', () => {
  it('reads the pictures and which was clicked', () => {
    expect(readImageMessage(msg({ index: 1, images: [png(0), png(1)] }))).toEqual({ index: 1, images: [png(0), png(1)] });
  });

  it('keeps only data:image sources and re-points the index', () => {
    const r = readImageMessage(msg({ index: 2, images: [{ src: 'https://x.test/a.png', alt: '' }, png(1), png(2)] }));
    expect(r).toEqual({ index: 1, images: [png(1), png(2)] });
  });

  it('refuses when the clicked picture is not an allowed source', () => {
    expect(readImageMessage(msg({ index: 0, images: [{ src: 'javascript:alert(1)', alt: '' }, png(1)] }))).toBeNull();
    expect(readImageMessage(msg({ index: 0, images: [{ src: 'data:text/html;base64,AAA', alt: '' }] }))).toBeNull();
  });

  it('caps the count and ignores other shapes', () => {
    const many = Array.from({ length: MAX_IMAGES + 5 }, (_, i) => png(i));
    expect(readImageMessage(msg({ index: 0, images: many }))?.images).toHaveLength(MAX_IMAGES);
    for (const bad of [null, 'x', {}, msg(null), msg({ index: 'a', images: [png(0)] }), msg({ index: 0.5, images: [png(0)] }), msg({ index: 0, images: 'x' })]) {
      expect(readImageMessage(bad)).toBeNull();
    }
  });
});

describe('IMAGE_BRIDGE', () => {
  it('only listens: it never stops or cancels the page\'s own click', () => {
    expect(IMAGE_BRIDGE).not.toContain('preventDefault()');
    expect(IMAGE_BRIDGE).not.toContain('stopPropagation');
    expect(IMAGE_BRIDGE).toContain('e.defaultPrevented');
  });
  it('is valid script', () => {
    expect(() => new Function(IMAGE_BRIDGE)).not.toThrow();
  });
});

describe('mayOpenFromFrame: a page opens the viewer only as the answer to a click into its frame', () => {
  it('needs a fresh arm, a live activation where reported, and a quiet moment after a close', async () => {
    const { mayOpenFromFrame, REOPEN_COOLDOWN_MS, ARM_TTL_MS } = await import('../../dashboard/src/components/layout/frameImageBridge');
    const base = { now: 10_000, closedAt: 0, active: true as boolean | undefined, armedAt: 9_800 as number | null };
    expect(mayOpenFromFrame(base)).toBe(true);
    expect(mayOpenFromFrame({ ...base, armedAt: null })).toBe(false); // a timer in the page, activation from typing elsewhere
    expect(mayOpenFromFrame({ ...base, armedAt: 10_000 - ARM_TTL_MS - 1 })).toBe(false); // a stale click cannot wait for a timer
    expect(mayOpenFromFrame({ ...base, active: false })).toBe(false);
    expect(mayOpenFromFrame({ ...base, active: undefined })).toBe(true); // no userActivation API: the arm alone
    expect(mayOpenFromFrame({ ...base, active: undefined, armedAt: null })).toBe(false); // …and never open by default
    expect(mayOpenFromFrame({ ...base, closedAt: 10_000 - REOPEN_COOLDOWN_MS + 1 })).toBe(false);
    expect(mayOpenFromFrame({ ...base, closedAt: 10_000 - REOPEN_COOLDOWN_MS })).toBe(true);
  });
});

describe('releaseFrameFocus', () => {
  // WebKit's iframe: blur() leaves the focus where it was (owner 2026-11-03, the second picture never opened).
  const setup = () => {
    const doc: { activeElement: unknown } = { activeElement: null };
    const frame = { ownerDocument: doc, blur: () => {} } as unknown as Element;
    const anchorOpts: (FocusOptions | undefined)[] = [];
    const anchor = { focus: (o?: FocusOptions) => { anchorOpts.push(o); doc.activeElement = anchor; } } as unknown as HTMLElement;
    return { doc, frame, anchor, anchorOpts };
  };

  it('moves focus out of a focused frame even where frame.blur() does nothing', () => {
    const { doc, frame, anchor, anchorOpts } = setup();
    doc.activeElement = frame;
    releaseFrameFocus(frame, anchor);
    expect(doc.activeElement).toBe(anchor);
    expect(anchorOpts).toEqual([{ preventScroll: true }]);
  });

  it('leaves focus alone when the frame does not hold it', () => {
    const { doc, frame, anchor } = setup();
    const chat = {};
    doc.activeElement = chat;
    releaseFrameFocus(frame, anchor);
    releaseFrameFocus(null, anchor);
    releaseFrameFocus(frame, null);
    expect(doc.activeElement).toBe(chat);
  });
});
