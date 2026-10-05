import { getAutomation } from '../automations/store.js';
import { WhiteboardCorruptError, WhiteboardNotFoundError } from './errors.js';
import { liveElements } from './ops.js';
import { readWhiteboard } from './store.js';
import { widgetPayloadOf, type WhiteboardElement } from './widgets.js';

/**
 * The agents a board carries: one entry per live `agent` card. Read by `whiteboard show
 * --json` (so an agent reading its board knows who else is on it) and by the Assistant's
 * `agent --board` routing.
 */
export interface BoardAgent {
  /** The card's element id. */
  id: string;
  /** The automation slug the card points at. */
  slug: string;
  /** The agent's title, else the card's stamped title, else the slug. */
  title: string;
  /** The agent's manifest names THIS board as its home (`whiteboard: <board>`): it acts only
   *  here. False for an agent that is only attached. */
  home: boolean;
  /** No manifest by that slug: the card stays on the board and says so. */
  missing: boolean;
}

/** The agents among `elements` (a board's elements), resolved against the manifests. */
export function agentsOnElements(contextRoot: string, board: string, elements: readonly WhiteboardElement[]): BoardAgent[] {
  const out: BoardAgent[] = [];
  for (const el of liveElements(elements)) {
    const dc = widgetPayloadOf(el);
    if (dc?.kind !== 'agent' || !dc.ref) continue;
    const manifest = getAutomation(contextRoot, dc.ref);
    out.push({
      id: el.id,
      slug: dc.ref,
      title: manifest?.title || dc.title || dc.ref,
      home: manifest?.whiteboard === board,
      missing: !manifest,
    });
  }
  return out;
}

/**
 * The agent cards on one board. A board that does not exist or does not parse has none: this
 * is a read for routing and listing, and both callers already report a missing board their
 * own way. Any other failure is thrown.
 */
export function boardAgents(contextRoot: string, board: string): BoardAgent[] {
  try {
    return agentsOnElements(contextRoot, board, readWhiteboard(contextRoot, board).board.elements);
  } catch (err) {
    if (err instanceof WhiteboardNotFoundError || err instanceof WhiteboardCorruptError) return [];
    throw err;
  }
}
