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
  BOARD_HTML_CSS, BOARD_HTML_SANDBOX, BOARD_HTML_MAX_HEIGHT, buildBoardHtmlSrcdoc, readBoardFrameMessage,
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
    expect(widget).toMatch(/useState\(\(\) => check\.ok && isTrustedHost\(check\.host\)\)/);
    // The frame renders only on the `loaded` branch.
    expect(widget).toMatch(/\{loaded \? \(\s*<iframe/);
  });

  it('is the only iframe site besides the HTML block in the whiteboard folder', () => {
    const canvas = read('WhiteboardCanvas.tsx');
    expect(iframeTags(canvas)).toHaveLength(0);
  });
});
