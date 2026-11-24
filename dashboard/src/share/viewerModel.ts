/**
 * The live-link board viewer's state (tunel-paylasim C7, D5, D13). No React, no Excalidraw: the
 * root vitest runs it as it is.
 *
 * The viewer polls `/__share/rev` every {@link POLL_MS}. What each answer means:
 *  - 200 `{rev}`: open; a new rev fetches the board again. A gone viewer that gets one opens again.
 *  - 410, or 401 (the session ended with the share): closed at once and for good ("Bu paylaşım
 *    kapandı"). These two are the ONLY final answers.
 *  - the guest's own network failing (status 0): nothing; a phone that drops for a while keeps
 *    its last frame and carries on when it is back.
 *  - anything else (404 `board_gone`, an edge 5xx such as Cloudflare's 530 while the owner's
 *    tunnel reconnects, a body that is not JSON): the last frame stays on the first miss; a second
 *    miss at least {@link GONE_AFTER_MS} after the first reads as gone. Gone keeps asking every
 *    {@link GONE_POLL_MS} and opens again on a good rev. Never a parse crash.
 */
export const POLL_MS = 3_000;
export const GONE_AFTER_MS = 5_000;
export const GONE_POLL_MS = 15_000;

export type ViewerPhase = 'loading' | 'open' | 'closed' | 'gone';

export interface ViewerState {
  phase: ViewerPhase;
  rev: string | null;
  /** When the current run of misses began (ms), null while answers are good. */
  missSince: number | null;
}

export const initialViewer: ViewerState = { phase: 'loading', rev: null, missSince: null };

/** The wait before the next poll in `state`. */
export function nextPollMs(state: ViewerState): number {
  return state.phase === 'gone' ? GONE_POLL_MS : POLL_MS;
}

/** One poll's outcome: the HTTP status (0 = the network) and the parsed body (null = not JSON). */
export interface PollAnswer { status: number; body: unknown }

export interface PollStep { state: ViewerState; refetch: boolean }

const revOf = (body: unknown): string | null => {
  const r = body && typeof body === 'object' ? (body as { rev?: unknown }).rev : null;
  return typeof r === 'string' && r ? r : null;
};

/** The next state after a poll answer at `now`. Only a closed viewer never reopens. */
export function onPoll(prev: ViewerState, answer: PollAnswer, now: number): PollStep {
  if (prev.phase === 'closed') return { state: prev, refetch: false };
  if (answer.status === 410 || answer.status === 401) return { state: { ...prev, phase: 'closed', missSince: null }, refetch: false };
  const rev = answer.status === 200 ? revOf(answer.body) : null;
  if (rev) {
    // Back from gone: the board is fetched again whatever its rev (the canvas was unmounted).
    if (prev.phase === 'gone') return { state: { phase: 'loading', rev: null, missSince: null }, refetch: true };
    return { state: { phase: prev.phase === 'loading' ? 'loading' : 'open', rev: prev.rev, missSince: null }, refetch: rev !== prev.rev };
  }
  if (answer.status === 0 || prev.phase === 'gone') return { state: prev, refetch: false };
  if (prev.missSince === null) return { state: { ...prev, missSince: now }, refetch: false };
  if (now - prev.missSince >= GONE_AFTER_MS) return { state: { ...prev, phase: 'gone' }, refetch: false };
  return { state: prev, refetch: false };
}

/** The board arrived (its rev is now the shown one). A closed or gone viewer ignores it. */
export function onBoard(prev: ViewerState, rev: string): ViewerState {
  if (prev.phase === 'closed' || prev.phase === 'gone') return prev;
  return { phase: 'open', rev, missSince: null };
}

/** The Turkish label of a widget kind on a guest's card (its content never travels). */
export function kindLabel(kind: unknown): string {
  switch (kind) {
    case 'task': return 'Görev kartı';
    case 'insight': return 'Insight kartı';
    case 'knowledge': return 'Sayfa';
    case 'lab-card': return 'Lab kartı';
    case 'agent': return 'Ajan kartı';
    case 'note': return 'Not';
    case 'todo': return 'Yapılacaklar';
    case 'html': return 'HTML kartı';
    case 'web': return 'Web kartı';
    case 'wiki': return 'Wiki kartı';
    default: return 'Kart';
  }
}
