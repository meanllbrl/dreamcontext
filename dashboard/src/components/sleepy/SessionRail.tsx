/**
 * The left session-list RAIL was removed in the top-bar-tabs redesign — every session is
 * now a tab in the overlay's top bar ({@link AgentTabs}) and a chip in the collapsed dock
 * ({@link AgentDock}). This module is kept ONLY as a back-compat re-export of the
 * `SessionRow` view-model (whose canonical home is now `agentStatus.ts`), so existing
 * importers keep resolving. Prefer importing `SessionRow` from `./agentStatus` directly.
 */
export type { SessionRow } from './agentStatus';
