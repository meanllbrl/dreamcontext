/**
 * The `jobs` chat view's rows (plan super-v3 K7, D6): one row per job the Super runs, drawn from
 * the live record, never from numbers the Super retyped. Pure and dependency-free: the window
 * (`JobsView.tsx`) and Telegram (`blocks.ts`) read the same rows, each with its own "needs the
 * owner" rule passed in (`needsOwner` on the client, `owner-needs.ts` on the server).
 *
 * No time-left estimate anywhere (D4): a row carries its last update time, never a guess.
 */

export type JobRowState = 'waiting' | 'running' | 'stuck' | 'done';

export interface JobRow {
  /** The child session id, or the team job id for an AI Team member's job. */
  id: string;
  kind: 'child' | 'member';
  name: string;
  state: JobRowState;
  /** What it waits on the owner for, in one line ('' when nothing). */
  waitingOn: string;
  /** The queue item it waits with (the Answer target), when waiting. */
  itemId?: string;
  /** Epoch ms of its last update (the server's row time, else its start). */
  at: number;
}

export interface JobsSummary { rows: JobRow[]; total: number; waiting: number; running: number; done: number }

interface ChildLike {
  sessionId: string; brief: string; startedAt: number; row?: string; rowAt?: number; endedAt?: number; finishedAt?: number;
}
interface QueueLike {
  id: string; sessionId: string; kind: string; state: string; createdAt: number; member?: string;
  ownerText?: string; text?: string; ask?: { questions?: { question?: string }[] };
}
interface TeamLike { id: string; member: string; brief: string; startedAt: number; outcome?: string; endedAt?: number; open?: true; followUpOf?: string }
interface ContainerLike { kind: string; ref: string; title?: string }

export interface JobsSource {
  children: Readonly<Record<string, ChildLike>>;
  queue: readonly QueueLike[];
  team?: readonly TeamLike[];
  containers?: readonly ContainerLike[];
}

const ORDER: Record<JobRowState, number> = { waiting: 0, running: 1, stuck: 2, done: 3 };

function oneLine(s: unknown, max: number): string {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function askLine(q: QueueLike): string {
  if (q.kind === 'permission') return 'permission';
  if (q.kind === 'approval') return 'approval';
  return oneLine(q.ask?.questions?.[0]?.question || q.ownerText || q.text || '', 140);
}

function nameOf(src: JobsSource, ref: string, brief: string): string {
  const c = src.containers?.find((x) => (x.kind === 'chat' || x.kind === 'team') && x.ref === ref);
  const title = oneLine(c?.title, 80);
  if (title) return title;
  return oneLine(brief.split('\n').find((l) => l.trim()) ?? '', 80) || 'Job';
}

/**
 * Every job of the record (or only `ids`), waiting first, then running, stuck, done; newest update
 * first inside each. An ended child (`super end`) is no job any more and is left out.
 */
export function jobsRows(src: JobsSource, needsOwner: (q: QueueLike) => boolean, ids?: readonly string[]): JobsSummary {
  const only = ids && ids.length ? new Set(ids) : null;
  const waits = new Map<string, QueueLike>();
  for (const q of [...src.queue].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!needsOwner(q)) continue;
    const key = q.kind === 'approval' && q.member ? `member:${q.member}` : q.sessionId;
    if (!waits.has(key)) waits.set(key, q);
  }
  const rows: JobRow[] = [];
  for (const c of Object.values(src.children)) {
    if (c.endedAt !== undefined) continue;
    if (only && !only.has(c.sessionId)) continue;
    const q = waits.get(c.sessionId);
    const state: JobRowState = q || c.row === 'asking' || c.row === 'waiting' ? 'waiting'
      : c.row === 'working' || c.row === undefined ? 'running'
        : c.row === 'stuck' || c.row === 'gone' ? 'stuck' : 'done';
    rows.push({
      id: c.sessionId, kind: 'child', name: nameOf(src, c.sessionId, c.brief), state,
      waitingOn: q ? askLine(q) : '', ...(q ? { itemId: q.id } : {}),
      at: c.rowAt ?? c.finishedAt ?? c.startedAt,
    });
  }
  // An AI Team member's job: its member's root, once (follow-ups continue the same card).
  const seen = new Set<string>();
  for (const j of src.team ?? []) {
    if (j.followUpOf || seen.has(j.member) || j.endedAt !== undefined) continue;
    seen.add(j.member);
    if (only && !only.has(j.id)) continue;
    const q = waits.get(`member:${j.member}`);
    const state: JobRowState = q ? 'waiting' : j.outcome === 'failed' ? 'stuck' : j.outcome === 'done' || !j.open ? 'done' : 'running';
    rows.push({ id: j.id, kind: 'member', name: nameOf(src, j.id, j.brief), state, waitingOn: q ? askLine(q) : '', ...(q ? { itemId: q.id } : {}), at: j.startedAt });
  }
  rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.at - a.at);
  return {
    rows,
    total: rows.length,
    waiting: rows.filter((r) => r.state === 'waiting').length,
    running: rows.filter((r) => r.state === 'running').length,
    done: rows.filter((r) => r.state === 'done').length,
  };
}

/** Telegram's rendering: up to `max` lines, waiting first (the rows' own order). Names are the
 *  agent's words: the caller escapes the whole text. */
export function jobsLines(sum: JobsSummary, max = 5): string[] {
  const mark: Record<JobRowState, string> = { waiting: '✋', running: '▸', stuck: '⚠', done: '✓' };
  const lines = sum.rows.slice(0, max).map((r) => `${mark[r.state]} ${r.name}${r.waitingOn ? `: ${r.waitingOn}` : ''}`);
  if (sum.rows.length > max) lines.push(`+${sum.rows.length - max}`);
  return lines;
}
