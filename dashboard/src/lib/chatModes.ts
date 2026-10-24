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

/** `train` is Train Me — the agent learns the owner's taste from swipe decks and A/B picks,
 *  then writes what it learned into a pattern (or an automation's playbook) behind a confirm.
 *  `assistant` is the dreamcontext Assistant's own mode — bound server-side to its hidden
 *  vault and never a row in the picker below. `super` is the project's Super Agent: only the
 *  Chat header's hand-over button starts it, so it is never a picker row either. `jarvis` is
 *  retired: voice lives in the notch. */
export type ChatMode = 'basic' | 'plan' | 'develop' | 'train' | 'assistant' | 'super';

export interface ChatModeRow {
  id: ChatMode;
  /** What the trigger prints and the menu row is titled. Display only: the id is what
   *  sessions store, so a renamed row never changes what a saved chat means. */
  name: string;
  /** The version of this mode's BRIEF, printed beside its name the way a model picker prints
   *  a model's. Mirrors `MODE_VERSIONS` in `src/server/chat-modes.ts`, where the brief lives;
   *  the mirror test fails when a brief changes and its version does not. */
  version: string;
  /** One line under the name: what picking this actually changes about how the agent works. */
  insight: string;
  /** Chip beside the name for a mode that is ANNOUNCED BUT NOT OFFERED — J.A.R.V.I.S wore
   *  "Soon" here until the voice work landed. It travels with `disabled` and the mirror test
   *  enforces the pair: `disabled` without a badge is a dead row the user pokes at, and a
   *  badge without `disabled` is a selectable mode with no behaviour behind it. */
  badge?: string;
  /**
   * Chip beside the name for a mode that IS offered and is not finished — ALPHA, BETA.
   *
   * Deliberately NOT `badge`. That field means "announced, not offered" and is paired with
   *  `disabled` by a test which catches a real mistake; saying how mature a WORKING mode is
   *  is the opposite claim, so overloading the field would have bought one word by deleting
   *  the guard. A maturity chip never disables anything.
   *
   * Owner call, 2026-09-13, looking at this menu: the J.A.R.V.I.S card carried nothing,
   * which reads as finished, while the Voice settings card two screens away said BETA. Both
   * now say ALPHA — one step below beta, and the same word on both surfaces.
   */
  maturity?: string;
  /** Rendered, but unpickable — the row exists so the capability is announced, not offered.
   *  Read by `AgentSurface.knownChatMode()`, which is what makes it a real gate rather than
   *  a styling flag: a disabled mode is one the spawn will not honour. */
  disabled?: boolean;
}

/**
 * The menu's rows, in the order they are drawn (one list, the way a model picker lists models).
 *
 * ORDER IS PART OF THE MIRROR: the test compares this list's ids to `CHAT_MODES` positionally,
 * so "add a mode to one side only" and "reorder one side only" both fail loudly rather than
 * leaving a mode the server accepts and the menu never shows.
 */
export const CHAT_MODE_ROWS: readonly ChatModeRow[] = [
  // Basic stays Basic until it can switch modes by itself (owner, 2026-10-12). When the
  // dreamcontext MCP lets a chat change its own mode, this row becomes Pilot 2.0: a name that
  // promises the capability only once it exists.
  { id: 'basic', name: 'Basic', version: '1.0', insight: 'Plain Claude. No mode enabled.' },
  { id: 'plan', name: 'Planner', version: '1.2', insight: 'Asks, drafts, gets reviewed, ends with a task.' },
  { id: 'develop', name: 'Developer', version: '1.2', insight: 'Builds in waves, checks each one, then a clean review.' },
  { id: 'train', name: 'Train Me', version: '0.1', insight: 'Learns your taste from swipes and picks, then writes a pattern.', maturity: 'ALPHA' },
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
