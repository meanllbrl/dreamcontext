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
`;

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
