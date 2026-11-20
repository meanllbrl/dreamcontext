/**
 * The open board's place in the URL hash (`#wb=<slug>`), so a reload lands back on the same
 * board. The hash, not the path or query: the app's `?vault=` / `?page=` and the Lab's `/lab/…`
 * path already own those, and a hash change reloads nothing.
 *
 * No React, no CSS: root vitest imports this file.
 */

/** The board slug rule (src/lib/whiteboards/validate.ts). */
const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const KEY_BOARD = 'wb';
/** Left by the retired Canvas | Wiki mode: never read, dropped on the next write. */
const RETIRED_KEYS = ['wbmode', 'wbpage'] as const;

/** The board slug a hash carries, or null when it carries none or a malformed one. */
export function parseBoardHash(hash: string): string | null {
  const board = new URLSearchParams(hash.replace(/^#/, '')).get(KEY_BOARD);
  return board && BOARD_SLUG_RE.test(board) ? board : null;
}

/**
 * The board a reload lands back on: the hash as the window LOADED, until a board page first
 * writes the hash. The hash is one per window and the project in front rewrites it, so read
 * later it names another project's board (navigation B: a badge or ← opening this page in the
 * window's first project asked for the other project's board, a 404). Captured when this module
 * first loads, before any board page has written the hash; reading it is free of side effects
 * (StrictMode runs a state initializer twice).
 */
let loadBoard: string | null = typeof window === 'undefined' ? null : parseBoardHash(window.location.hash);
export function loadBoardHash(): string | null {
  return loadBoard;
}
/** A board page wrote the hash: from now on it says nothing about the load. */
export function forgetLoadBoardHash(): void {
  loadBoard = null;
}

/**
 * Write the board into a hash, keeping any other hash params as they were. A null or malformed
 * board leaves no board param. Returns '' when nothing is left.
 */
export function formatBoardHash(board: string | null, previous = ''): string {
  const params = new URLSearchParams(previous.replace(/^#/, ''));
  params.delete(KEY_BOARD);
  for (const key of RETIRED_KEYS) params.delete(key);
  if (board && BOARD_SLUG_RE.test(board)) params.set(KEY_BOARD, board);
  const s = params.toString();
  return s ? `#${s}` : '';
}

/** The hash with the board removed (leaving the board page), other params kept. */
export function clearBoardHash(previous: string): string {
  return formatBoardHash(null, previous);
}
