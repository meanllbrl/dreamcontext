import { createContext, useContext } from 'react';
import { BrowserLive } from './BrowserLive';

/**
 * WHERE the live browser is drawn: inside the step that is driving it (owner pick, 2026-10-09).
 *
 * Docked above the composer, the view read as a picture detached from the conversation. Now it
 * opens inside the LAST browser step of the transcript, the row the reader is already looking
 * at, and moves to the next such step as the agent works. A finished stretch that collapsed into
 * a run card keeps it under the run's header, so the window never vanishes into a closed group.
 *
 * Only one step hosts it: a column of live windows is the wall the tool-row collapse rule
 * exists to prevent. The pane decides which step (`hostToolId`); a row only asks "is it me".
 */

export interface BrowserHost {
  sessionId: string;
  /** The id of the last browser tool step in the transcript, or null. */
  hostToolId: string | null;
}

const BrowserHostContext = createContext<BrowserHost | null>(null);
export const BrowserHostProvider = BrowserHostContext.Provider;

/** A tool of a Playwright MCP server: `mcp__<server>__browser_<verb>`. */
export function isBrowserTool(name: string): boolean {
  return /^mcp__.+__browser_[a-z_]+$/.test(name);
}

/** The last browser step among `items`, which the pane passes in transcript order. */
export function lastBrowserToolId(items: ReadonlyArray<{ kind: string; id: string; name?: string }>): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === 'tool' && typeof it.name === 'string' && isBrowserTool(it.name)) return it.id;
  }
  return null;
}

/** Draws the live browser when `ids` contains this pane's host step. Nothing otherwise. */
export function BrowserSlot({ ids }: { ids: readonly string[] }) {
  const host = useContext(BrowserHostContext);
  if (!host?.hostToolId || !ids.includes(host.hostToolId)) return null;
  return (
    <div className="chat-browser-slot">
      <BrowserLive sessionId={host.sessionId} />
    </div>
  );
}
