import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import type { ChatSession } from '../chatSession';

/**
 * How the stage follows the live chats: ONE animation frame for every card, and each card
 * re-renders only what changed (task super-agent-ekrani-kasmaz…, scripts/verify/super-jank.mjs).
 *
 * Measured before: three streaming children re-rendered their whole card on every token — the
 * frame, its four action buttons, the ring and the tile — each card on a frame of its own (one
 * React commit per card per frame), and the Super Agent's own stream re-rendered the whole stage.
 * Now every subscriber of the stage runs in one shared frame (React batches them into one
 * commit), and a subscriber with a `select` re-renders only when what it draws from the session
 * (its status, the tile's line) is different from what it drew.
 *
 * 0 requests, like before: the sessions are the chats' own live ones in this window.
 */

const due = new Set<() => void>();
let frame = 0;

function run(): void {
  frame = 0;
  const fns = [...due];
  due.clear();
  for (const fn of fns) { try { fn(); } catch { /* one card must not stop the others */ } }
}

/** Run `fn` in the next shared frame (once, however often it is asked for before then). */
export function inNextFrame(fn: () => void): void {
  due.add(fn);
  if (frame) return;
  frame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(run)
    : (setTimeout(run, 16) as unknown as number);
}

/** Drop `fn` from the next shared frame (teardown). */
export function dropFromFrame(fn: () => void): void {
  due.delete(fn);
}

/** Tests only. */
export function _flushFrame(): void { run(); }

const ids = new WeakMap<ChatSession, number>();
let nextId = 1;
const idOf = (s: ChatSession | undefined): number => {
  if (!s) return 0;
  let id = ids.get(s);
  if (id === undefined) { id = nextId++; ids.set(s, id); }
  return id;
};

/**
 * Re-render on these sessions' events, at most once a shared frame. With `select`, only when
 * `select()` (what this component draws from them) changed since its last render.
 */
export function useLiveSessions(sessions: readonly (ChatSession | undefined)[], select?: () => string): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const selectRef = useRef(select);
  selectRef.current = select;
  const drawn = useRef<string | null>(null);
  // What this render drew: the baseline the next event is compared with.
  useLayoutEffect(() => { drawn.current = selectRef.current ? selectRef.current() : null; });
  const key = sessions.map(idOf).join('|');
  const live = useRef(sessions);
  live.current = sessions;
  useEffect(() => {
    const list = live.current.filter((s): s is ChatSession => !!s);
    if (!list.length) return undefined;
    const check = () => {
      const sel = selectRef.current;
      if (sel && sel() === drawn.current) return;
      force();
    };
    const offs = list.map((s) => s.subscribe(() => inNextFrame(check)));
    return () => { for (const off of offs) off(); dropFromFrame(check); };
  }, [key]);
}

/** One session; see {@link useLiveSessions}. */
export function useLiveSession(session: ChatSession | undefined, select?: () => string): void {
  useLiveSessions([session], select);
}
