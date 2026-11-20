import { isValidRefFor, readWidgetPayload } from './widgetModel';

/** One agent card on a board: its element and the agent it names (its conversation follows the
 *  card, boardAgentScratch `adoptBoardCards`). */
export interface BoardCard {
  elementId: string;
  agent: string;
}

/** The live agent cards in a scene (or a board file's elements), in scene order. */
export function agentCardsOf(elements: readonly unknown[] | undefined): BoardCard[] {
  const out: BoardCard[] = [];
  for (const el of Array.isArray(elements) ? elements : []) {
    const e = el as { id?: unknown; isDeleted?: boolean; customData?: unknown } | null;
    const payload = readWidgetPayload(e);
    if (!e || e.isDeleted || typeof e.id !== 'string' || payload?.kind !== 'agent' || !isValidRefFor('agent', payload.ref)) continue;
    out.push({ elementId: e.id, agent: payload.ref });
  }
  return out;
}
