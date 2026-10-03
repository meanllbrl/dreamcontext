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

/** One row of the open notch's glance (GET /api/assistant/glance). */
export interface GlanceChat {
  sessionId: string;
  vault: string;
  activity: 'asking' | 'working' | 'starting' | 'stale';
  title: string;
  ask: { id: string; kind: 'permission' | 'question'; tool: string; text: string } | null;
}

const GLANCE_ACTIVITIES = new Set(['asking', 'working', 'starting', 'stale']);

/**
 * The route wraps every project string in `<untrusted-project-output …>` for the assistant's
 * sake; the notch only DRAWS it (as text, never as markup), so the wrapper comes off here.
 */
export function unwrapUntrusted(s: unknown): string {
  if (typeof s !== 'string') return '';
  const m = /^<untrusted-project-output[^>]*>([\s\S]*)<\/untrusted-project-output>$/.exec(s);
  return (m ? m[1] : s).trim();
}

/** The glance body through a forward-compatible cast: a junk row is dropped, never drawn. */
export function readGlance(raw: unknown): GlanceChat[] {
  const rows = raw && typeof raw === 'object' && Array.isArray((raw as { chats?: unknown }).chats)
    ? (raw as { chats: unknown[] }).chats : [];
  const out: GlanceChat[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.sessionId !== 'string' || typeof o.vault !== 'string' || !GLANCE_ACTIVITIES.has(String(o.activity))) continue;
    const a = o.ask && typeof o.ask === 'object' ? o.ask as Record<string, unknown> : null;
    out.push({
      sessionId: o.sessionId,
      vault: o.vault,
      activity: o.activity as GlanceChat['activity'],
      title: unwrapUntrusted(o.title),
      ask: a && typeof a.id === 'string'
        ? { id: a.id, kind: a.kind === 'permission' ? 'permission' : 'question', tool: typeof a.tool === 'string' ? a.tool : '', text: unwrapUntrusted(a.text) }
        : null,
    });
  }
  return out;
}

/**
 * The notch's mood — one word the whole island wears (its tint, the pill's words):
 * `asking` when anything waits on the owner (a chat's prompt or a proposal), `working` while
 * a turn is in flight, `done` for a moment after the last turn ends, else `idle`.
 */
export type NotchMood = 'asking' | 'working' | 'done' | 'idle';
export function notchMood(r: Rollup, justFinished: boolean): NotchMood {
  if (r.asking > 0 || r.proposals > 0) return 'asking';
  if (r.working + r.starting > 0) return 'working';
  return justFinished ? 'done' : 'idle';
}

/** What a glance row says it is doing, in the owner's words. */
export function glanceStatus(c: GlanceChat): string {
  if (c.ask) return c.ask.kind === 'permission' ? 'needs permission' : 'has a question';
  if (c.activity === 'asking') return 'needs you';
  if (c.activity === 'stale') return 'quiet for a while';
  if (c.activity === 'starting') return 'starting';
  return 'working';
}

/** One thing the Assistant handed to a project (GET /api/assistant/glance → `delegations`). */
export interface Handoff {
  sessionId: string;
  vault: string;
  activity: 'starting' | 'working' | 'stale' | 'asking' | 'idle' | 'gone';
  startedAt: number;
  /** Set once the project's chat closed; the notch keeps it for an hour. */
  endedAt: number | null;
  brief: string;
  lastText: string;
  ask: GlanceChat['ask'];
}

const HANDOFF_ACTIVITIES = new Set(['starting', 'working', 'stale', 'asking', 'idle', 'gone']);

export function readHandoffs(raw: unknown): Handoff[] {
  const rows = raw && typeof raw === 'object' && Array.isArray((raw as { delegations?: unknown }).delegations)
    ? (raw as { delegations: unknown[] }).delegations : [];
  const out: Handoff[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.sessionId !== 'string' || typeof o.vault !== 'string' || !HANDOFF_ACTIVITIES.has(String(o.activity))) continue;
    const a = o.ask && typeof o.ask === 'object' ? o.ask as Record<string, unknown> : null;
    out.push({
      sessionId: o.sessionId,
      vault: o.vault,
      activity: o.activity as Handoff['activity'],
      startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
      endedAt: typeof o.endedAt === 'number' ? o.endedAt : null,
      brief: unwrapUntrusted(o.brief),
      lastText: unwrapUntrusted(o.lastText),
      ask: a && typeof a.id === 'string'
        ? { id: a.id, kind: a.kind === 'permission' ? 'permission' : 'question', tool: typeof a.tool === 'string' ? a.tool : '', text: unwrapUntrusted(a.text) }
        : null,
    });
  }
  return out;
}

/** A hand-off in the owner's words: is it still going, waiting, or done? */
export type HandoffPhase = 'running' | 'waiting' | 'done' | 'closed';
export function handoffPhase(h: Pick<Handoff, 'activity'>): HandoffPhase {
  if (h.activity === 'asking') return 'waiting';
  if (h.activity === 'idle') return 'done';
  if (h.activity === 'gone') return 'closed';
  return 'running';
}

/** "12s", "4m", "2h", "3d" — how long ago, short enough for a notch row. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * What the collapsed pill says, most urgent first. The pill is a ticker, not a nameplate:
 * it shows the assistant's name only when nothing else is worth saying.
 */
export function pillHeadline(input: {
  name: string;
  asker: string | null;
  proposals: number;
  finished: string | null;
  handoffs: Handoff[];
  working: number;
}): string {
  if (input.asker) return `${input.asker} needs you`;
  if (input.proposals > 0) return input.proposals === 1 ? 'Waiting for your yes' : `${input.proposals} waiting for your yes`;
  if (input.finished) return `${input.finished} finished`;
  const running = input.handoffs.filter((h) => handoffPhase(h) === 'running');
  if (running.length === 1) return `${running[0].vault} is on it`;
  if (running.length > 1) return `${running.length} projects on it`;
  if (input.working > 0) return input.working === 1 ? '1 working' : `${input.working} working`;
  return input.name;
}
