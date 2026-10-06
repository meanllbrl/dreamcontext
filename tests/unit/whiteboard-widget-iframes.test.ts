/**
 * The whiteboard's two iframe sites (D6, D7), pinned the way `chat-html.test.ts` pins chat's.
 *
 * A board can come from a shared repo, so its HTML block is held to a LOWER trust bar than a
 * chat answer: chat's sandbox with the input bridge removed. The constants alone prove nothing
 * (a constant nobody spells out on the JSX is the exact failure `lib/sandboxHtml.ts` warns
 * about), so these tests read the component sources as well as calling the pure builders.
 *
 * Root vitest, no DOM: the message handler is exercised through its pure gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOARD_HTML_CSS, BOARD_HTML_SANDBOX, BOARD_HTML_MAX_HEIGHT, BOARD_HTML_MIN_SCALE, buildBoardHtmlSrcdoc, fitScale, readBoardFrameMessage,
  BOARD_WHEEL_KEY, BOARD_WHEEL_MAX_DELTA, readBoardWheelMessage, boardAfterWheel,
} from '../../dashboard/src/components/whiteboard/htmlWidgetFrame.js';
import {
  HEIGHT_BRIDGE, REACH_BRIDGE, KIT_BEHAVIOUR, HEIGHT_MESSAGE_KEY, PRESS_MESSAGE_KEY, CHORD_MESSAGE_KEY,
} from '../../dashboard/src/components/sleepy/chat/chatHtmlKit.js';
import { SANDBOX_CSP, SANDBOX_ALLOW } from '../../dashboard/src/lib/sandboxHtml.js';

const WB_DIR = join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/whiteboard');
const read = (rel: string) => readFileSync(join(WB_DIR, rel), 'utf-8');

/** Every `<iframe …>` JSX opening tag in a source file. */
function iframeTags(src: string): string[] {
  return [...src.matchAll(/<iframe\b[\s\S]*?\/?>/g)].map((m) => m[0]);
}

/** Import specifiers of a source file, with the names they pull in. */
function imports(src: string): string {
  return [...src.matchAll(/import\s+[\s\S]*?from\s+['"][^'"]+['"]/g)].map((m) => m[0]).join('\n');
}

describe('HtmlWidget — the board HTML block (D6)', () => {
  const widget = read('widgets/HtmlWidget.tsx');
  const frame = read('htmlWidgetFrame.ts');

  it('sandboxes with allow-scripts ONLY — no same-origin, popups, forms or navigation', () => {
    expect(BOARD_HTML_SANDBOX).toBe('allow-scripts');
    const tags = iframeTags(widget);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('sandbox={BOARD_HTML_SANDBOX}');
    expect(widget + frame).not.toMatch(/allow-popups|allow-same-origin|allow-top-navigation|allow-forms/);
  });

  it('denies every device permission: allow={SANDBOX_ALLOW}, which is the empty string', () => {
    expect(SANDBOX_ALLOW).toBe('');
    expect(iframeTags(widget)[0]).toContain('allow={SANDBOX_ALLOW}');
  });

  it('never touches the chat input bridge: no REACH_BRIDGE, no KIT_BEHAVIOUR, no buildChatSrcdoc', () => {
    for (const src of [widget, frame]) {
      const imp = imports(src);
      expect(imp).not.toMatch(/\bREACH_BRIDGE\b/);
      expect(imp).not.toMatch(/\bKIT_BEHAVIOUR\b/);
      expect(imp).not.toMatch(/\bbuildChatSrcdoc\b/);
      expect(imp).not.toMatch(/readChordMessage|readPressMessage/);
    }
    // And nothing the frame sends is replayed as a DOM event.
    expect(widget).not.toMatch(/dispatchEvent/);
  });

  it('builds the srcdoc from the shared primitives: CSP first, HEIGHT_BRIDGE only', () => {
    const doc = buildBoardHtmlSrcdoc({ html: '<p class="dc-p">hi</p>', tokens: {}, scheme: 'dark' });
    expect(doc.indexOf('Content-Security-Policy')).toBeGreaterThan(-1);
    expect(doc).toContain(SANDBOX_CSP);
    expect(doc.indexOf(SANDBOX_CSP)).toBeLessThan(doc.indexOf('<p class="dc-p">hi</p>'));
    expect(doc).toContain(HEIGHT_BRIDGE);
    expect(doc).not.toContain(REACH_BRIDGE);
    expect(doc).not.toContain(KIT_BEHAVIOUR);
    expect(doc).toContain('color-scheme: dark');
  });

  it('A19: resets a lone dc-card frame with styling only, after the kit and before the markup', () => {
    const doc = buildBoardHtmlSrcdoc({ html: '<div class="dc-card">x</div>', tokens: {}, scheme: 'light' });
    expect(doc).toContain(BOARD_HTML_CSS);
    expect(BOARD_HTML_CSS).toMatch(/body > \.dc-card:only-child/);
    expect(BOARD_HTML_CSS).toMatch(/border:\s*none/);
    // Pure CSS: no url(), no @import, no script.
    expect(BOARD_HTML_CSS).not.toMatch(/url\(|@import|<script/i);
    expect(doc.indexOf(SANDBOX_CSP)).toBeLessThan(doc.indexOf(BOARD_HTML_CSS));
    expect(doc.indexOf(BOARD_HTML_CSS)).toBeLessThan(doc.indexOf('<div class="dc-card">x</div>'));
  });

  it('tears the frame down on a second load, with the card the plan names', () => {
    expect(widget).toMatch(/loads\.current\s*>=\s*2/);
    expect(widget).toContain('This block tried to open a web page');
  });
});

describe('HtmlWidget — the host message gate', () => {
  const frameWin = { name: 'our frame' };
  const otherWin = { name: 'some other frame' };

  it('accepts a height from its own frame, clamped to 4000', () => {
    expect(readBoardFrameMessage({ source: frameWin, data: { [HEIGHT_MESSAGE_KEY]: 321 } }, frameWin)).toBe(321);
    expect(readBoardFrameMessage({ source: frameWin, data: { [HEIGHT_MESSAGE_KEY]: 99999 } }, frameWin))
      .toBe(BOARD_HTML_MAX_HEIGHT);
    expect(BOARD_HTML_MAX_HEIGHT).toBe(4000);
  });

  it('ignores a height from any other window', () => {
    expect(readBoardFrameMessage({ source: otherWin, data: { [HEIGHT_MESSAGE_KEY]: 300 } }, frameWin)).toBeNull();
    expect(readBoardFrameMessage({ source: frameWin, data: { [HEIGHT_MESSAGE_KEY]: 300 } }, null)).toBeNull();
  });

  it('a chord or press posted by the frame is ignored and changes nothing', () => {
    // What a hostile block would post to select-all and delete the board around it.
    const hostile = [
      { [CHORD_MESSAGE_KEY]: { type: 'keydown', key: 'a', code: 'KeyA', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } },
      { [CHORD_MESSAGE_KEY]: { type: 'keydown', key: 'Backspace', code: 'Backspace', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false } },
      { [PRESS_MESSAGE_KEY]: 'down' },
      { [PRESS_MESSAGE_KEY]: 'up' },
    ];
    // A stand-in scene and the widget's own state: the handler's only effect is setHeight.
    const scene = { elements: [{ id: 'r1', version: 3 }] };
    const before = JSON.stringify(scene);
    let height: number | null = null;
    for (const data of hostile) {
      const next = readBoardFrameMessage({ source: frameWin, data }, frameWin);
      if (next !== null) height = next;
    }
    expect(height).toBeNull();
    expect(JSON.stringify(scene)).toBe(before);
  });
});

describe('HtmlWidget — a wheel the block hands back to the board', () => {
  const frameWin = { id: 'frame' };
  const wheel = (v: unknown) => ({ source: frameWin, data: { [BOARD_WHEEL_KEY]: v } });

  it('the block carries the wheel bridge', () => {
    const doc = buildBoardHtmlSrcdoc({ html: '<p>x</p>', tokens: {}, scheme: 'light' });
    expect(doc).toContain(`${BOARD_WHEEL_KEY}:`);
    expect(doc).toMatch(/addEventListener\('wheel'[\s\S]*passive: false/);
  });

  it('is taken only from this frame, only while the pointer is over it', () => {
    expect(readBoardWheelMessage(wheel({ dx: 0, dy: 40 }), frameWin, true)).toEqual({ dx: 0, dy: 40, pinch: false, shift: false, at: null });
    expect(readBoardWheelMessage(wheel({ dx: 0, dy: 40, x: 12, y: 30 }), frameWin, true)?.at).toEqual({ x: 12, y: 30 });
    expect(readBoardWheelMessage(wheel({ dx: 0, dy: 40 }), frameWin, false)).toBeNull();
    expect(readBoardWheelMessage({ source: { id: 'other' }, data: { [BOARD_WHEEL_KEY]: { dx: 0, dy: 40 } } }, frameWin, true)).toBeNull();
    expect(readBoardWheelMessage(wheel({ dx: 0, dy: 40 }), null, true)).toBeNull();
  });

  it('caps each axis and refuses a malformed or empty wheel', () => {
    expect(readBoardWheelMessage(wheel({ dx: -99999, dy: 99999, pinch: true }), frameWin, true))
      .toEqual({ dx: -BOARD_WHEEL_MAX_DELTA, dy: BOARD_WHEEL_MAX_DELTA, pinch: true, shift: false, at: null });
    for (const bad of [null, 'x', { dx: 'a', dy: 1 }, { dx: 0, dy: Number.NaN }, { dx: 0, dy: 0 }, { dy: 3 }]) {
      expect(readBoardWheelMessage(wheel(bad), frameWin, true)).toBeNull();
    }
    // A height is not a wheel, and a wheel is not a height.
    expect(readBoardWheelMessage({ source: frameWin, data: { [HEIGHT_MESSAGE_KEY]: 300 } }, frameWin, true)).toBeNull();
    expect(readBoardFrameMessage(wheel({ dx: 0, dy: 40 }), frameWin)).toBeNull();
  });
});

describe('boardAfterWheel — the board moves for a wheel a block handed back', () => {
  const view = { scrollX: 100, scrollY: 50, zoom: 2, offsetLeft: 10, offsetTop: 20 };
  const anchor = { clientX: 410, clientY: 220 };
  const sceneAt = (v: { scrollX: number; scrollY: number; zoom: number }) => ({
    x: (anchor.clientX - view.offsetLeft) / v.zoom - v.scrollX,
    y: (anchor.clientY - view.offsetTop) / v.zoom - v.scrollY,
  });

  it('pans by the delta at the current zoom, sideways with shift', () => {
    expect(boardAfterWheel(view, { dx: 20, dy: 40, pinch: false, shift: false }, anchor)).toEqual({ scrollX: 90, scrollY: 30, zoom: 2 });
    expect(boardAfterWheel(view, { dx: 0, dy: 40, pinch: false, shift: true }, anchor)).toEqual({ scrollX: 80, scrollY: 50, zoom: 2 });
  });

  it('a pinch zooms around the anchor: the scene point under it stays put', () => {
    const zin = boardAfterWheel(view, { dx: 0, dy: -8, pinch: true, shift: false }, anchor);
    expect(zin.zoom).toBeGreaterThan(2);
    expect(sceneAt(zin).x).toBeCloseTo(sceneAt(view).x, 6);
    expect(sceneAt(zin).y).toBeCloseTo(sceneAt(view).y, 6);
    const zout = boardAfterWheel(view, { dx: 0, dy: 8, pinch: true, shift: false }, anchor);
    expect(zout.zoom).toBeLessThan(2);
  });

  it('a pinch stays inside Excalidraw\'s zoom bounds', () => {
    expect(boardAfterWheel({ ...view, zoom: 0.1 }, { dx: 0, dy: 600, pinch: true, shift: false }, anchor).zoom).toBe(0.1);
    expect(boardAfterWheel({ ...view, zoom: 30 }, { dx: 0, dy: -600, pinch: true, shift: false }, anchor).zoom).toBe(30);
  });
});

describe('WebWidget — the web embed (D7)', () => {
  const widget = read('widgets/WebWidget.tsx');

  it('frames with scripts, same-origin and forms — never popups or top navigation', () => {
    const m = widget.match(/export const WEB_WIDGET_SANDBOX = '([^']*)'/);
    expect(m?.[1]).toBe('allow-scripts allow-same-origin allow-forms');
    const tags = iframeTags(widget);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('sandbox={WEB_WIDGET_SANDBOX}');
    expect(widget).not.toMatch(/allow-popups|allow-top-navigation|allow-modals/);
  });

  it('carries allow="" and no referrer', () => {
    const tag = iframeTags(widget)[0];
    expect(tag).toContain('allow=""');
    expect(tag).toContain('referrerPolicy="no-referrer"');
  });

  it('re-validates the URL at render time and gates the frame behind Load / a trusted host', () => {
    expect(widget).toContain('validateWebUrl(payload.url, window.location.origin)');
    // A page renders only once its target checked out as a page (`kind: 'url'`), and starts unloaded unless trusted.
    expect(widget).toMatch(/if \(!check\.ok\) \{/);
    expect(widget).toMatch(/useState\(\(\) => isTrustedHost\(page\.host\)\)/);
    // The frame renders only on the `loaded` branch.
    expect(widget).toMatch(/\{loaded \? \(\s*<iframe/);
    // A file never gets an iframe of its own: the board's reader draws it, after the file route said yes.
    expect(widget).toMatch(/access\.state === 'blocked'/);
    expect(widget).toMatch(/api\.post\('\/agent\/grant'/);
  });

  it('is the only iframe site besides the HTML block in the whiteboard folder', () => {
    const canvas = read('WhiteboardCanvas.tsx');
    expect(iframeTags(canvas)).toHaveLength(0);
  });
});

/** Owner 2026-10-05 ("HTML kapsamıyor"): a block shows whole in its card and fills it. */
describe('HTML block fits its card', () => {
  const box = { height: 300 };

  it('content that fits keeps full size', () => {
    expect(fitScale(1, box, 300)).toBe(1);
    expect(fitScale(1, box, 120)).toBe(1);
  });

  it('a taller block is drawn smaller, just enough to show whole', () => {
    expect(fitScale(1, box, 400)).toBeCloseTo(0.75);
  });

  it('only ever shrinks (a wider layout reports shorter; growing back would overflow again)', () => {
    // At 0.75 the frame is 400 tall; the wider layout now reports 380 (fits): stay.
    expect(fitScale(0.75, box, 400)).toBe(0.75);
    expect(fitScale(0.75, box, 380)).toBe(0.75);
    // Still over at the new width: shrink further.
    expect(fitScale(0.75, box, 450)).toBeCloseTo(300 / 450);
  });

  it('never below the floor: past it the block scrolls', () => {
    expect(fitScale(1, box, 5000)).toBe(BOARD_HTML_MIN_SCALE);
    expect(BOARD_HTML_MIN_SCALE).toBe(0.5);
  });

  it('no box or no report yet changes nothing', () => {
    expect(fitScale(1, { height: 0 }, 500)).toBe(1);
    expect(fitScale(0.8, box, 0)).toBe(0.8);
  });

  it('the body spans the frame and a lone root element stretches to it (styling only)', () => {
    expect(BOARD_HTML_CSS).toMatch(/body \{ min-height: 100vh; \}/);
    expect(BOARD_HTML_CSS).toMatch(/body > :only-child \{ flex: 1 0 auto; \}/);
    expect(BOARD_HTML_CSS).not.toMatch(/url\(|@import|<script/i);
  });

  it('spare height goes to the elastic blocks of a stacking root, never to a row or grid root', () => {
    const root = 'body > :is(.dc-doc, .dc-stack, .dc-card):only-child';
    expect(BOARD_HTML_CSS).toContain(`${root} { display: flex; flex-direction: column; }`);
    expect(BOARD_HTML_CSS).toMatch(/> :is\(\.dc-stack, \.dc-grid[^)]*\) \{ flex: 1 1 auto; \}/);
    expect(BOARD_HTML_CSS).toContain(`${root} > .dc-grid > .dc-stat > .dc-stat-label { flex: 1 1 auto; }`);
    // A dc-row or dc-grid at the root keeps its own layout: only the three stacking roots turn into a column.
    expect(BOARD_HTML_CSS).not.toMatch(/:is\([^)]*\.dc-(row|grid)[^)]*\):only-child/);
  });
});
