/**
 * The chat MODES the composer offers, and what each row says about itself.
 *
 * MIRRORED in `src/server/chat-modes.ts` (`CHAT_MODES` / `ChatMode` / `DEFAULT_CHAT_MODE`).
 * That file owns the BEHAVIOUR — the per-mode system-prompt append and the sanitizer's
 * allowlist; this one owns the MENU's copy. The split is deliberate: prose the user reads in
 * a popover has no business travelling to the server, and a system-prompt brief has no
 * business being edited to fix a menu typo. Change one side, change the other;
 * `tests/unit/chat-mode-mirror.test.ts` pins the id lists so they cannot drift apart
 * silently.
 *
 * Deliberately React-free — no JSX, no imports at all. The mirror test imports BOTH sides
 * under root vitest's plain-Node environment (see `chat-surface-lockstep.test.ts` for the
 * same trick), and a `.tsx` pulling in React would turn a two-line list comparison into a
 * component test.
 */

export type ChatMode = 'basic' | 'plan' | 'develop' | 'jarvis';

export interface ChatModeRow {
  id: ChatMode;
  /** What the trigger prints and the menu row is titled. */
  name: string;
  /** One line under the name: what picking this actually changes about how the agent works. */
  insight: string;
  /** Chip beside the name. Only J.A.R.V.I.S carries one. */
  badge?: string;
  /** Rendered, but unpickable — the row exists so the capability is announced, not offered. */
  disabled?: boolean;
}

/**
 * The menu's rows, in the order they are drawn (a 2×2 grid — see `.chat-cmp-scroll.is-grid`).
 *
 * ORDER IS PART OF THE MIRROR: the test compares this list's ids to `CHAT_MODES` positionally,
 * so "add a mode to one side only" and "reorder one side only" both fail loudly rather than
 * leaving a mode the server accepts and the menu never shows.
 */
export const CHAT_MODE_ROWS: readonly ChatModeRow[] = [
  { id: 'basic', name: 'Basic', insight: 'Plain Claude. No mode enabled.' },
  { id: 'plan', name: 'Plan', insight: 'Asks, drafts, gets reviewed, ends with a task.' },
  { id: 'develop', name: 'Develop', insight: 'Builds in waves, reviewed and validated.' },
  {
    id: 'jarvis',
    name: 'J.A.R.V.I.S',
    insight: 'Talk with the agent.',
    badge: 'Soon',
    disabled: true,
  },
];

/** What a chat is in when nothing asked for anything else. There is deliberately no
 *  user-settable default — the mode menu has no "Set as default" (owner call), so a fresh
 *  chat is plain Claude Code and a mode is a per-session choice. */
export const DEFAULT_CHAT_MODE: ChatMode = 'basic';

/** The row for `mode`. Falls back to Basic rather than returning null: every caller here is
 *  rendering a label, and a trigger with no word on it is worse than one naming the default. */
export function chatModeRow(mode: ChatMode): ChatModeRow {
  return CHAT_MODE_ROWS.find((r) => r.id === mode) ?? CHAT_MODE_ROWS[0];
}
