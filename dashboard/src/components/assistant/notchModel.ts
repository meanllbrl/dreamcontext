/** The notch pill's glance over every live chat (GET /api/assistant/rollup — counts only). */
export interface Rollup {
  starting: number;
  /** A turn genuinely in flight right now. */
  working: number;
  /** The registry would have called it working, but it shows no sign of life (the server's rule). */
  stale: number;
  asking: number;
  idle: number;
  proposals: number;
}

export const EMPTY_ROLLUP: Rollup = { starting: 0, working: 0, stale: 0, asking: 0, idle: 0, proposals: 0 };

/**
 * The route's body, read through a forward-compatible cast (`pattern-forward-compatible-field`):
 * a server that does not send `stale` yet (or sends junk for any count) reads as 0, so the pill
 * is right before and after the server learns the field.
 */
export function readRollup(raw: unknown): Rollup {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Rollup, unknown>>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    starting: n(o.starting), working: n(o.working), stale: n(o.stale),
    asking: n(o.asking), idle: n(o.idle), proposals: n(o.proposals),
  };
}

/** The tab strip's three bubble states (ProjectTabs.tsx, `data-state`). */
export type BubbleState = 'asking' | 'working' | 'idle';
export interface PillBubble { state: BubbleState; count: number }

/**
 * The pill's right ear speaks the tab strip's language: one bubble per status, in the strip's
 * fixed draw order (asking, working, idle), and a status with nothing in it draws NOTHING —
 * never a "0" bubble. Starting chats are working (the strip's green means "mid-turn or
 * connecting"). A stale chat is not doing anything, so it joins idle in the grey bubble: the
 * green ring is only ever the truth. The words (`pillLabel`) still tell stale apart.
 */
export function pillBubbles(r: Rollup): PillBubble[] {
  const counts: Record<BubbleState, number> = {
    asking: r.asking,
    working: r.working + r.starting,
    idle: r.idle + r.stale,
  };
  return (['asking', 'working', 'idle'] as const)
    .filter((state) => counts[state] > 0)
    .map((state) => ({ state, count: counts[state] }));
}

/** The same counts in words, for the aria-label and the tooltip: "1 working, 4 idle, 5 stale". */
export function pillLabel(r: Rollup): string {
  const parts: string[] = [];
  const working = r.working + r.starting;
  if (r.asking > 0) parts.push(`${r.asking} asking`);
  if (working > 0) parts.push(`${working} working`);
  if (r.idle > 0) parts.push(`${r.idle} idle`);
  if (r.stale > 0) parts.push(`${r.stale} stale`);
  if (r.proposals > 0) parts.push(`${r.proposals} waiting for your approval`);
  return parts.length ? parts.join(', ') : 'no chats';
}
