import { useEffect, useState } from 'react';

/**
 * A RUN'S STATE, as the channel draws it: how long it has taken, how long it has been going,
 * and what its thread's closing row still needs to say.
 *
 * Pure helpers plus one clock, kept out of `AgentMessage` so they can be tested without
 * rendering a message.
 */

/** "4m 12s" / "41s". Matches the runner's own wording in the thread's system rows, so the
 *  same run never reports its length two different ways, and a running row's live time
 *  reads in the same words its finished duration will. */
export function runDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

const FAILURE_HEAD = /^((?:Failed|Timed out) after [^:]+): ([\s\S]+)$/;

const normalise = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, '');

/**
 * The run's closing row without the reason the thread already shows.
 *
 * The runner closes a failed run with "Failed after 3s: <reason>", and the reason is the
 * run's own opening line, which is exactly what the thread's ROOT prints. Read top to
 * bottom, the panel said one sentence twice. When the reason equals the root's text, the
 * row keeps only the one new fact, "Failed after 3s". Anything else (a different reason, an
 * ask thread whose root is the reader's question, a row that is not a failure) is returned
 * as written: the server's sentence is never re-authored, only shortened.
 */
export function trimFailureEcho(text: string, rootText: string | null): string {
  if (!rootText) return text;
  const m = FAILURE_HEAD.exec(text.trim());
  if (!m) return text;
  return normalise(m[2]) === normalise(rootText) ? m[1] : text;
}

/** One second: the elapsed time's resolution. */
const TICK_MS = 1000;

/**
 * The current time, re-read every second while `active`, so a running row's elapsed time
 * climbs on its own. Idle when nothing is running, so a quiet channel re-renders nothing.
 * Not motion: it keeps ticking under `prefers-reduced-motion`.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
