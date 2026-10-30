import type { OpenProject } from './WindowChrome';

/* The window's instance ceiling rules, moved out of `WindowChrome.tsx` unchanged so they can be
   tested without mounting the chrome (new-shell-ceiling.test.ts). */

/** Instances actually mounted right now (cold chips cost nothing). */
export function liveInstanceCount(open: OpenProject[]): number {
  return open.reduce((n, p) => (p.cold ? n : n + 1), 0);
}

/**
 * The oldest instance it is SAFE to tear down, or null when there is none.
 *
 * The null-rollup case is the load-bearing one. `rollup === null` means the instance has not
 * published its state yet — freshly mounted, just revived from a cold chip, or (until T19
 * lands the publisher) simply never.
 * It does **not** mean idle. Reading null as "nothing running here" would tear down an
 * instance holding a live chat, killing its PTY mid-conversation, which is the single thing
 * this whole design is not allowed to do. So an instance is evictable only once it has said,
 * in its own words, that it has nothing live.
 *
 * The active instance is never a candidate either: the user is looking at it.
 *
 * Reads `alive`, never `live`. `live` is a PRESENTATION count for the chip badge — it
 * excludes shells on purpose, because a plain terminal has no agent behind it and isn't an
 * "active chat". A dev server or build watch running in a shell is exactly the kind of PTY
 * this ceiling must never kill, and it would report `live: 0` while still very much alive.
 * `alive` counts every session still holding a live PTY/WebSocket, shells included — it is
 * the only field allowed to gate a teardown.
 */
export function oldestEvictable(open: OpenProject[], keep: readonly string[]): OpenProject | null {
  for (const p of open) {
    if (p.cold || keep.includes(p.vault)) continue;
    if (p.rollup !== null && p.rollup.alive === 0) return p;
  }
  return null;
}

/** Tear an instance down to a cold chip: it unmounts, its chip stays, its rollup is void. */
export function chill(open: OpenProject[], vault: string): OpenProject[] {
  return open.map((p) => (p.vault === vault ? { ...p, cold: true, rollup: null } : p));
}
