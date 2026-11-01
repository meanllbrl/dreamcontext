import { createContext, useContext } from 'react';
import { useEmbed } from '../../embed/embedMode';

/**
 * "This conversation is an app chat": the one key the app-chat rules hang on, whichever pane the
 * conversation opens in. Model text in an app chat is input from whatever the assistant read, so:
 *
 *  - no HTML the assistant wrote is drawn live: a `dream-html` block, a question's preview, a
 *    board's HTML or web widget, a board's web embed, an HTML insight body. A sandboxed frame
 *    can still reach a host with no request any page policy sees (`<link rel=preconnect>`,
 *    WebRTC STUN/TURN carry data in a host name or a TURN username), so the frame is not drawn
 *    at all. The reader sees a notice where it would have been (`ModelHtmlOff`);
 *  - no remote media (`MarkdownPreview`, `dropRemoteMedia`).
 *
 * ChatPane provides it from `session.appChat` (the server says so on connect and in History), so
 * the main pane holds the rule too; the app window's frame holds it with no provider at all,
 * because everything in that document is an app chat (`useEmbed`).
 *
 * Every component that draws a frame of supplied HTML asks `useInAppChat()`; a walking test
 * (`appChatHtmlOff.test.ts`) fails on a new frame that does not.
 */
export const AppChatContext = createContext(false);

export function useInAppChat(): boolean {
  const flagged = useContext(AppChatContext);
  const embed = useEmbed();
  return flagged || !!embed;
}
