/**
 * A picture chip shows the picture (owner 2026-11-07: "hover yapınca görsem fotoyu güzel olur").
 *
 *   1. The thumbnail is a real <img> in the glyph's room, never a CSS background on that inline
 *      run: WebKit (the Mac app) did not paint the background, so the chip read as an empty grey
 *      box there while Chromium, where the checks ran, painted it.
 *   2. Hovering a sent picture shows a card with the whole picture, kept inside the window
 *      (`peekBox`), and the native file-name tooltip no longer covers it.
 *   3. A clip or another file shows its icon and name, never a broken picture.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { PictureChip } from '../../dashboard/src/components/sleepy/chat/ComposerRefLayer.js';
import { PEEK_MAX, chipThumbFor, peekBox } from '../../dashboard/src/components/sleepy/chat/picturePeekBox.js';

const VIEW = { w: 1440, h: 900 };
const chip = (left: number, top: number) => ({ left, top, right: left + 160, bottom: top + 22 });

describe('the thumbnail', () => {
  const url = '/api/agent/file?path=%2Fv%2F_dream_context%2Ftmp%2Fagent-drops%2F1-shot.png&raw=1&vault=v';

  it('is an <img> in the room, not a CSS background (sent bubble and composer alike)', () => {
    for (const sent of [true, false]) {
      const html = renderToStaticMarkup(createElement(PictureChip, { img: url, lead: '  ', rest: ' shot.png', sent, peek: sent, title: '1-shot.png' }));
      expect(html).toContain(`<img class="chat-cmp-hl-thumb-img" src="${url.replace(/&/g, '&amp;')}"`);
      expect(html).not.toContain('background-image');
    }
  });

  it('a sent picture drops the native tooltip (the card shows the picture) but keeps its name for a screen reader', () => {
    const html = renderToStaticMarkup(createElement(PictureChip, { img: url, lead: '  ', rest: ' shot.png', sent: true, peek: true, title: '1-shot.png', onOpen: () => {} }));
    expect(html).not.toContain('title=');
    expect(html).toContain('aria-label="1-shot.png"');
    expect(html).toContain('role="button"');
  });

  it('a chip with no picture keeps its icon and its tooltip', () => {
    const html = renderToStaticMarkup(createElement(PictureChip, { icon: '🎞', lead: '  ', rest: ' clip.mp4', sent: true, title: 'clip.mp4' }));
    expect(html).toContain('data-icon="🎞"');
    expect(html).toContain('title="clip.mp4"');
    expect(html).not.toContain('<img');
  });
});

describe('chipThumbFor', () => {
  it('a picture shows itself; a clip or a document its icon', () => {
    expect(chipThumbFor('/v/tmp/agent-drops/1-Screenshot.PNG')).toEqual({ picture: true });
    expect(chipThumbFor('/v/a.jpeg')).toEqual({ picture: true });
    expect(chipThumbFor('/v/a.svg')).toEqual({ picture: true });
    expect(chipThumbFor('/v/tmp/agent-drops/phone-1-rec.mp4')).toEqual({ picture: false, icon: '🎞' });
    expect(chipThumbFor('/v/brief.pdf')).toEqual({ picture: false, icon: '📄' });
  });
});

describe('peekBox: the hover card', () => {
  it('above the chip when it fits, the picture at its own aspect within 320 x 240', () => {
    const b = peekBox(chip(200, 600), { w: 676, h: 608 }, VIEW);
    expect(b.side).toBe('above');
    expect(b.height).toBe(PEEK_MAX.h);
    expect(b.width).toBe(Math.round(676 * (240 / 608)));
    expect(b.top + b.height).toBe(600 - 8);
    expect(b.left).toBe(200);
  });

  it('below the chip when the top has no room', () => {
    const b = peekBox(chip(200, 40), { w: 800, h: 400 }, VIEW);
    expect(b.side).toBe('below');
    expect(b.top).toBe(62 + 8);
    expect(b.width).toBe(320);
    expect(b.height).toBe(160);
  });

  it('never upscales a small picture', () => {
    const b = peekBox(chip(200, 600), { w: 120, h: 80 }, VIEW);
    expect([b.width, b.height]).toEqual([120, 80]);
  });

  it('stays inside the window at the right edge and on a phone', () => {
    const r = peekBox(chip(1400, 600), { w: 1000, h: 500 }, VIEW);
    expect(r.left + r.width).toBeLessThanOrEqual(VIEW.w - 8);
    const phone = { w: 390, h: 844 };
    const p = peekBox(chip(300, 700), { w: 2000, h: 1000 }, phone);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(phone.w - 8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it('a short window shrinks the card to the larger side instead of overflowing', () => {
    const short = { w: 800, h: 200 };
    const b = peekBox({ left: 100, top: 80, right: 200, bottom: 100 }, { w: 400, h: 400 }, short);
    expect(b.side).toBe('below');
    expect(b.top).toBeGreaterThanOrEqual(8);
    expect(b.top + b.height).toBeLessThanOrEqual(short.h - 8);
    expect(b.width).toBe(b.height);
  });
});
