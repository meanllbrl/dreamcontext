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

/** The tab strip's bubble states the pill draws (ProjectTabs.tsx, `data-state`). */
export type BubbleState = 'asking' | 'working';
export interface PillBubble { state: BubbleState; count: number }

/**
 * The pill's right ear speaks the tab strip's language: one bubble per status, in the strip's
 * fixed draw order (asking, working), and a status with nothing in it draws NOTHING — never a
 * "0" bubble. Starting chats are working (the strip's green means "mid-turn or connecting").
 * Idle and stale chats draw no bubble: at a glance they are not news, and the left ear says
 * who/what while this ear says how many. The words (`pillLabel`) still count them.
 */
export function pillBubbles(r: Rollup): PillBubble[] {
  const bubbles: PillBubble[] = [
    { state: 'asking', count: r.asking },
    { state: 'working', count: r.working + r.starting },
  ];
  return bubbles.filter((b) => b.count > 0);
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
  /** What the Assistant itself is doing on the owner's request (`assistantActivityLine`). */
  self?: string | null;
  /** Running automations, newest first. */
  running?: RunningAutomation[];
}): string {
  if (input.asker) return `${input.asker} needs you`;
  if (input.proposals > 0) return input.proposals === 1 ? 'Waiting for your yes' : `${input.proposals} waiting for your yes`;
  // The owner just asked for this: what the Assistant is doing comes before anyone else's news.
  if (input.self) return input.self;
  if (input.finished) return `${input.finished} finished`;
  const running = input.handoffs.filter((h) => handoffPhase(h) === 'running');
  if (running.length === 1) return `${running[0].vault} is on it`;
  if (running.length > 1) return `${running.length} projects on it`;
  const automations = input.running ?? [];
  if (automations.length === 1) return `${automations[0].title || automations[0].slug} is running`;
  if (automations.length > 1) return `${automations.length} automations running`;
  // A bare count is the right ear's job (the green bubble); the left ear says who or what.
  return input.name;
}

// ─── The inbox (GET /api/assistant/inbox) ─────────────────────────────────────────────

/** A chat that finished a turn while its project was not on screen. */
export interface FinishedNotice {
  id: string;
  kind: 'finished';
  at: number;
  sessionId: string;
  vault: string;
  mode: string;
  title: string;
  lastText: string;
}

/** An account hit its limit; `toAccount` took over when a chat moved. */
export interface AccountNotice {
  id: string;
  kind: 'account';
  at: number;
  account: string;
  toAccount: string | null;
  window: 'session' | 'weekly' | 'unknown' | null;
  until: number | null;
  exhausted: boolean;
  vault: string | null;
  sessionId: string | null;
}

export type InboxNotice = FinishedNotice | AccountNotice;

/** One unread thing an automation said: a post, a failed run's reason, a question for the owner. */
export interface AutomationPost {
  key: string;
  vault: string;
  slug: string;
  title: string;
  hasPhoto: boolean;
  runId: string;
  at: string;
  status: string;
  textFrom: string;
  text: string;
  needsYou: boolean;
  newestId: string;
}

export interface RunningAutomation {
  vault: string;
  slug: string;
  title: string;
  hasPhoto: boolean;
  since: number;
  runId: string | null;
}

export interface Inbox {
  lookingAt: string | null;
  notices: InboxNotice[];
  posts: AutomationPost[];
  running: RunningAutomation[];
  muted: Array<{ vault: string; slug: string }>;
}

export const EMPTY_INBOX: Inbox = { lookingAt: null, notices: [], posts: [], running: [], muted: [] };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** The route's body through a forward-compatible cast: a junk row is dropped, never drawn. */
export function readInbox(raw: unknown): Inbox {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const arr = (k: string) => (Array.isArray(o[k]) ? o[k] as unknown[] : []);
  const rec = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : null);
  const notices: InboxNotice[] = [];
  for (const r of arr('events')) {
    const e = rec(r);
    if (!e || typeof e.id !== 'string' || num(e.at) === null) continue;
    if (e.kind === 'finished' && typeof e.sessionId === 'string' && typeof e.vault === 'string') {
      notices.push({
        id: e.id, kind: 'finished', at: num(e.at)!, sessionId: e.sessionId, vault: e.vault, mode: str(e.mode),
        title: unwrapUntrusted(e.title), lastText: unwrapUntrusted(e.lastText),
      });
    } else if (e.kind === 'account' && typeof e.account === 'string') {
      const w = e.window === 'session' || e.window === 'weekly' || e.window === 'unknown' ? e.window : null;
      notices.push({
        id: e.id, kind: 'account', at: num(e.at)!, account: e.account, toAccount: typeof e.toAccount === 'string' ? e.toAccount : null,
        window: w, until: num(e.until), exhausted: e.exhausted === true,
        vault: typeof e.vault === 'string' ? e.vault : null, sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
      });
    }
  }
  const posts: AutomationPost[] = [];
  for (const r of arr('posts')) {
    const p = rec(r);
    if (!p || typeof p.key !== 'string' || typeof p.vault !== 'string' || !SLUG_RE.test(str(p.slug)) || typeof p.newestId !== 'string') continue;
    posts.push({
      key: p.key, vault: p.vault, slug: str(p.slug), title: unwrapUntrusted(p.title) || str(p.slug), hasPhoto: p.hasPhoto === true,
      runId: str(p.runId), at: str(p.at), status: str(p.status), textFrom: str(p.textFrom), text: unwrapUntrusted(p.text),
      needsYou: p.needsYou === true, newestId: p.newestId,
    });
  }
  const running: RunningAutomation[] = [];
  for (const r of arr('running')) {
    const a = rec(r);
    if (!a || typeof a.vault !== 'string' || !SLUG_RE.test(str(a.slug)) || num(a.since) === null) continue;
    running.push({
      vault: a.vault, slug: str(a.slug), title: unwrapUntrusted(a.title) || str(a.slug), hasPhoto: a.hasPhoto === true,
      since: num(a.since)!, runId: typeof a.runId === 'string' ? a.runId : null,
    });
  }
  const muted = arr('muted').map(rec).filter((m): m is Record<string, unknown> => !!m && typeof m.vault === 'string' && SLUG_RE.test(str(m.slug)))
    .map((m) => ({ vault: m.vault as string, slug: str(m.slug) }));
  return { lookingAt: typeof o.lookingAt === 'string' ? o.lookingAt : null, notices, posts, running, muted };
}

/** How long an unread finished chat keeps its name on the collapsed pill ("acme finished"). */
export const FINISHED_PILL_MS = 10 * 60_000;

/**
 * The project of the newest finished chat the owner has not acted on yet, if it is recent. The
 * peek folds after a while; the pill keeps saying it, so a finish missed at a glance is not lost.
 */
export function recentFinishedVault(notices: InboxNotice[], now = Date.now()): string | null {
  for (const n of notices) {
    if (n.kind === 'finished' && now - n.at <= FINISHED_PILL_MS) return n.vault;
  }
  return null;
}

/** An announcement that waits for the peek to be free holds this many; the oldest drop first. */
export const PEEK_QUEUE_CAP = 3;

/**
 * Add new arrivals to the announcement queue: deduped by id, newest kept when over the cap.
 * Arrivals that land while the peek is busy (a waiting prompt, a progress line, the notch open,
 * another announcement) wait here instead of being listed silently.
 */
export function enqueuePeeks<T extends { id: string }>(queue: T[], fresh: T[], cap = PEEK_QUEUE_CAP): T[] {
  const ids = new Set(queue.map((q) => q.id));
  const next = [...queue, ...fresh.filter((f) => !ids.has(f.id))];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** A running automation's identity across polls: a new `since` is a new turn. */
export const runKey = (r: Pick<RunningAutomation, 'vault' | 'slug' | 'since'>) => `${r.vault}::${r.slug}::${r.since}`;

/** "12:40" — a clock time in the owner's locale. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** An account notice in one line: who hit what, and who took over. */
export function accountLine(n: AccountNotice): string {
  const cap = n.window === 'weekly' ? 'weekly limit' : n.window === 'session' ? '5-hour limit' : 'limit';
  const back = n.until ? ` · back at ${clock(n.until)}` : '';
  if (n.toAccount) return `${n.account} hit its ${cap} → switched to ${n.toAccount}${back}`;
  if (n.exhausted) return `Every account is at its limit${back}`;
  return `${n.account} hit its ${cap}${back}`;
}

/** The photo URL of an automation (the project's own route; a 404 draws the initial). */
export function automationPhotoUrl(vault: string, slug: string): string {
  return `/api/automations/${encodeURIComponent(slug)}/photo?vault=${encodeURIComponent(vault)}`;
}

// ─── What the Assistant is doing (the collapsed pill while it works) ──────────────────

/** The bits of a transcript item `assistantActivityLine` reads. */
export type ActivityItem =
  | { kind: 'tool'; name: string; input: unknown; status: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'user' }
  | { kind: string };

const VERB_LINE: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/dreamcontext\s+assistant\s+chat\s+(?:'([^']+)'|"([^"]+)"|(\S+))/, (m) => `Asking ${m[1] ?? m[2] ?? m[3]}…`],
  [/dreamcontext\s+assistant\s+(?:send|answer)\b/, () => 'Writing to a project…'],
  [/dreamcontext\s+assistant\s+watch\b/, () => 'Waiting for an answer…'],
  [/dreamcontext\s+assistant\s+broadcast\b/, () => 'Writing to every project…'],
  [/dreamcontext\s+assistant\s+look\b/, () => 'Looking at your screen…'],
  [/dreamcontext\s+assistant\s+(?:open|focus|tile)\b/, () => 'Arranging windows…'],
  [/dreamcontext\s+assistant\s+(?:sessions|projects)\b/, () => 'Checking your projects…'],
  [/dreamcontext\s+(?:memory\s+)?recall\b/, () => 'Remembering…'],
];

/** The first sentence of a line, clipped for a pill. */
function firstSentence(t: string, max = 48): string {
  const flat = t.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?…])(\s|$)/.exec(flat);
  const s = m ? m[1] : flat;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * One line for the pill while the Assistant works on the owner's request: its newest progress
 * sentence, else what its running tool is doing in the owner's words, else "Thinking…". Only
 * this turn counts (items after the last `user`).
 */
export function assistantActivityLine(items: ActivityItem[], progress: string | null): string {
  let from = 0;
  for (let i = items.length - 1; i >= 0; i--) { if (items[i].kind === 'user') { from = i + 1; break; } }
  const turn = items.slice(from);
  for (let i = turn.length - 1; i >= 0; i--) {
    const it = turn[i];
    if (it.kind === 'tool' && 'status' in it && it.status === 'running') {
      const input = (it as { input: unknown }).input;
      const cmd = input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string'
        ? (input as { command: string }).command : '';
      for (const [re, line] of VERB_LINE) {
        const m = re.exec(cmd);
        if (m) return line(m);
      }
      break;
    }
    if (it.kind === 'text') break;
  }
  if (progress && progress.trim()) return firstSentence(progress);
  return 'Thinking…';
}
