/**
 * The drawer's Super Agent row (D6, flagged F2). It is always there, so a click has to work on
 * every project:
 *  - the stage is already up: show it;
 *  - the project has a chat: hand over, as the hand-over button does;
 *  - it has none: start a chat FIRST, then hand over once that tab is in the roster. Today's
 *    hand-over needs a chat to adopt.
 *
 * The starter chat runs `auto` whatever the project remembers (`bp = false` with
 * `explicitBypass = true`, the delegate path's exemption), and nothing writes the remembered
 * permission mode, so the other chats and the next new tab keep theirs.
 */
export type SuperRowPlan = 'show-stage' | 'hand-over' | 'spawn-then-hand-over' | 'unavailable';

export function planSuperRow(s: {
  /** The record says handed over (`superState.enabled`). */
  enabled: boolean;
  /** At least one live chat or agent tab the hand-over can adopt. */
  hasChat: boolean;
  canSpawn: boolean;
}): SuperRowPlan {
  if (s.enabled) return 'show-stage';
  if (s.hasChat) return 'hand-over';
  return s.canSpawn ? 'spawn-then-hand-over' : 'unavailable';
}

/** The starter chat's launch: a chat, in `auto`, exempt from the remembered bypass. */
export const SUPER_ROW_SPAWN = { kind: 'chat', bypass: false, explicitBypass: true } as const;

export interface SuperRowDeps {
  showStage(): void;
  handOver(): Promise<void>;
  /** Starts the chat and registers its tab; returns its id. Throws when nothing started. */
  spawnChat(): string;
  /** Resolves once the new tab is in the roster the hand-over reads. */
  whenRegistered(id: string): Promise<void>;
}

/** Run the plan. A spawn that throws ends it: no hand-over without the chat it would adopt. */
export async function runSuperRow(plan: SuperRowPlan, deps: SuperRowDeps): Promise<void> {
  if (plan === 'unavailable') return;
  if (plan === 'show-stage') { deps.showStage(); return; }
  if (plan === 'spawn-then-hand-over') {
    let id: string;
    try { id = deps.spawnChat(); } catch (err) {
      console.warn('[drawer] the Super Agent row could not start a chat:', err);
      return;
    }
    await deps.whenRegistered(id);
  }
  await deps.handOver();
}
