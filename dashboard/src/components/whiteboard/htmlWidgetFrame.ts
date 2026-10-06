/**
 * The HTML widget's sandbox (D6): chat's sandbox with the input bridge taken OUT.
 *
 * Board HTML can come from a shared repo, so the trust bar is lower than chat's, not equal to
 * it. Chat's srcdoc also injects `REACH_BRIDGE`, and its host replays posted chords and presses
 * as real DOM events. On a board, a hostile block could post ⌘A then Backspace, Excalidraw
 * would hear them, and the autosave would write the deletion. So this srcdoc is built from the
 * shared primitives directly: `buildSandboxSrcdoc` + the kit CSS (plus the board's frame reset) + `HEIGHT_BRIDGE`, nothing else.
 * No `KIT_BEHAVIOUR` either, so the kit's `dc-tabs` do not switch here; an author who wants
 * tabs writes their own inline script.
 *
 * The host accepts exactly one message: a height, from this frame's own window, clamped to
 * {@link BOARD_HTML_MAX_HEIGHT}. There is no token (the static `HEIGHT_BRIDGE` carries none),
 * so identity (`event.source === contentWindow`) is the gate.
 *
 * No React, no CSS: root vitest imports this file.
 */
import { buildSandboxSrcdoc } from '../../lib/sandboxHtml';
import { CHAT_HTML_KIT_CSS, HEIGHT_BRIDGE, readHeightMessage } from '../sleepy/chat/chatHtmlKit';

/** The only sandbox grant. Scripts yes; same-origin, popups, navigation and forms never. */
export const BOARD_HTML_SANDBOX = 'allow-scripts';

/** A board block may grow to this and no further. */
export const BOARD_HTML_MAX_HEIGHT = 4000;

/**
 * Board-only styling after the kit (A19). The widget is already a card, so a block whose whole
 * content is one `dc-card` would draw a second frame inside it: that card loses its border,
 * fill, radius, shadow and padding and its content sits straight on the widget. `!important`
 * because authors inline `style="padding:…"` on it. Styling only: nothing here reaches the CSP,
 * the sandbox or the bridge.
 */
export const BOARD_HTML_CSS = `
body > .dc-card:only-child {
  padding: 0 !important;
  border: none !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}
body { min-height: 100vh; }
body:has(> :only-child) { display: flex; flex-direction: column; }
body > :only-child { flex: 1 0 auto; }
`;

/**
 * How far a block may shrink to fit its card (owner, 2026-10-05: "HTML kapsamıyor", content
 * cut at the bottom and not filling the card). Below this the text stops being readable, so
 * the block stays at this scale and scrolls inside the card once it is active.
 */
export const BOARD_HTML_MIN_SCALE = 0.5;

/**
 * The scale a block is drawn at so all of it shows in its card: the frame is laid out at
 * `box / scale` and drawn scaled by `scale`. `contentHeight` is what the frame reported (the
 * body's height at the current layout width, never less than the frame since the body fills
 * it: BOARD_HTML_CSS). It only ever SHRINKS from `current`: a smaller scale lays the block out
 * wider, which makes it shorter, and growing back on that report would narrow it and overflow
 * again (an endless back and forth). The caller starts again from 1 when the box or the
 * markup changes.
 */
export function fitScale(current: number, box: { height: number }, contentHeight: number): number {
  if (!(box.height > 0) || !(contentHeight > 0)) return current;
  const viewport = box.height / current;
  if (contentHeight <= viewport + 1) return current;
  return Math.max(BOARD_HTML_MIN_SCALE, Math.min(current, box.height / contentHeight));
}

export function buildBoardHtmlSrcdoc(input: {
  html: string;
  tokens: Record<string, string>;
  scheme: 'light' | 'dark';
}): string {
  return buildSandboxSrcdoc({
    html: input.html,
    css: CHAT_HTML_KIT_CSS + BOARD_HTML_CSS,
    tokens: input.tokens,
    scheme: input.scheme,
    headScript: HEIGHT_BRIDGE,
  });
}

/**
 * The host's message gate. Returns the height to apply, or null to ignore the message.
 * Anything that is not a height from this frame (a chord, a press, another frame's message)
 * is null and changes nothing.
 */
export function readBoardFrameMessage(
  event: { source: unknown; data: unknown },
  frameWindow: unknown,
): number | null {
  if (!frameWindow || event.source !== frameWindow) return null;
  const h = readHeightMessage(event.data);
  if (h === null) return null;
  return Math.min(BOARD_HTML_MAX_HEIGHT, h);
}
