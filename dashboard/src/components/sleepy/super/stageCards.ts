import { createContext, useContext } from 'react';

/**
 * What the Super chat knows of the stage's cards (owner 2026-10-31: a card named in a message is a
 * chip): its kind (the icon), a picture card's picture, and the one action, bring it into view.
 * Provided around the handed-over Super chat only; elsewhere a card chip draws from the words it
 * was sent with and does nothing on a click.
 */
export interface StageCardInfo {
  /** A container kind (`chat`, `image`, …) or `group`. */
  kind: string;
  /** A picture card's picture (an `/api/agent/file` URL). */
  img?: string;
}

export interface StageCards {
  /** The card or group with this id on the stage now, or null (closed, or never here). */
  cardOf: (id: string) => StageCardInfo | null;
  /** Bring it into view: a card side by side with the centre, a group's panel open. */
  open: (id: string) => void;
}

export const StageCardsContext = createContext<StageCards | null>(null);

export function useStageCards(): StageCards | null {
  return useContext(StageCardsContext);
}
