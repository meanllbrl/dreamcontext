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
