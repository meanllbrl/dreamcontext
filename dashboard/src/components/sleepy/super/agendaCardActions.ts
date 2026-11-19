import { createContext, useContext } from 'react';

/** The agenda card's own actions (To Others, side by side) for its ≡ menu: a 344 px card has no room
 *  for them as hover buttons beside the head tools, so SuperContainer offers them here. */
export interface AgendaCardAction { key: string; label: string; go: () => void }
const Ctx = createContext<AgendaCardAction[]>([]);
export const AgendaCardActionsProvider = Ctx.Provider;
export const useAgendaCardActions = () => useContext(Ctx);
