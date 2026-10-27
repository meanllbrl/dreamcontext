/**
 * Why a board card could not draw its board, said precisely, and whether to ask again.
 *
 * Every failed read used to say "couldn't be read", so a whiteboard card whose board was simply
 * not on disk yet (a Super stage card opened before its board was written) looked broken, and
 * stayed that way until it was remounted (owner 2026-10-27). Pure, so root vitest pins it.
 */

/** A failed board read, for the card. */
export interface BoardFailure {
  /** The few words the card shows. */
  note: string;
  /** The server's own sentence, for the tooltip and the fullscreen view. */
  detail: string;
  /** The board is not on disk (yet): worth asking again, it may still be written. */
  missing: boolean;
}

/** The route's error slug: `RequestError.code`, read by shape so this module imports nothing. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

export function boardFailure(err: unknown): BoardFailure {
  const detail = err instanceof Error ? err.message : String(err ?? '');
  switch (codeOf(err)) {
    case 'not_found': return { note: 'not in this project yet', detail, missing: true };
    case 'too_large': return { note: 'too large to draw here', detail, missing: false };
    case 'needs_grant':
    case 'invalid_path': return { note: 'outside this project', detail, missing: false };
    case 'desktop_only':
    case 'phone_unavailable': return { note: 'opens in the desktop app', detail, missing: false };
    default: return { note: "couldn't be read", detail, missing: false };
  }
}

/** A missing board is asked for again, slower each time… */
export const BOARD_RETRY_MS = [3_000, 5_000, 10_000, 20_000, 30_000] as const;
/** …for about twenty minutes, then it rests: a board named in an old transcript and long since
 *  deleted must not be polled for as long as that chat stays open. */
export const BOARD_MAX_RETRIES = 40;

/** The wait before retry number `tries` (0-based) of a missing board, or null to stop. */
export function boardRetryDelay(failure: BoardFailure, tries: number): number | null {
  if (!failure.missing || tries >= BOARD_MAX_RETRIES) return null;
  return BOARD_RETRY_MS[Math.min(tries, BOARD_RETRY_MS.length - 1)];
}
