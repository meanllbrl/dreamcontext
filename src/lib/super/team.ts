import { randomBytes } from 'node:crypto';
import { readRunAnswer } from '../automations/feed.js';
import { readAutomationCache } from '../automations/store.js';
import { plainPostText, readThreadRun } from '../automations/threads.js';
import type { ThreadEntry } from '../automations/types.js';
import { MAX_TEAM_JOBS, type SuperState, type SuperTeamJob, type TeamJobStatus } from './types.js';
import { newQueueId } from './inbox.js';

/**
 * The Super Agent's jobs for the project's AI Team (`super team ask`, task
 * super-agent-ai-team-uyelerine-is-verir-…). A job is NOT a second mechanism: it went into the
 * member's own thread through the AI Team's say path (`sayToAgent`), so the member's model,
 * approval and queue rule it. The record only names where it landed; what it says now is read
 * from the say job while that is in memory, and from the member's thread after.
 */

export function newTeamJobId(): string {
  return `team-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** Record a job (newest first, capped), and close every open approval question about its member:
 *  a member that just took a job is approved. */
export function recordTeamJob(s: SuperState, job: SuperTeamJob): void {
  s.team = [job, ...s.team.filter((j) => j.id !== job.id)].slice(0, MAX_TEAM_JOBS);
  for (const q of s.queue) if (q.kind === 'approval' && q.member === job.member && q.state !== 'done') q.state = 'done';
}

/**
 * The owner's question when a member the super chose is not approved on this machine: born
 * `escalated` (the owner's, never delivered to the super as a turn), in the server's words (the
 * super never captions it), once per member while it is open. Returns the open item's id.
 */
export function askOwnerToApprove(s: SuperState, member: string, ownerText: string, now = Date.now()): string | null {
  if (!s.session) return null;
  const open = s.queue.find((q) => q.kind === 'approval' && q.member === member && q.state !== 'done');
  if (open) return open.id;
  const id = newQueueId();
  s.queue.push({ id, sessionId: s.session, kind: 'approval', member, state: 'escalated', createdAt: now, ownerText });
  return id;
}

/** What the say path's own job says while it is in memory (`currentAutomationJob` /
 *  `currentReplyJob`, passed in by the route): null once it is gone. */
export type LiveSayJob =
  | { kind: 'run'; status: 'running' | 'success' | 'error' }
  | { kind: 'reply'; status: 'running' | 'ok' | 'refused' | 'failed'; phase: 'waiting' | 'delivering'; deliveredAt?: number; endedAt?: number };

/** A run's terminal events: `ok` ends a fresh run, `replied` a resumed turn. */
const DONE = new Set(['ok', 'replied']);
const FAILED = new Set(['failed', 'timeout', 'skipped']);
/** The zero-post mirror is written just after a reply settles: its id can be a moment late. */
const MIRROR_SLACK_MS = 5_000;

/** The ms an entry id encodes (`newThreadEntryId`: 9 base36 chars, then `_`); NaN if not ours. */
function entryMs(id: string): number {
  return Number.parseInt(id.slice(0, 9), 36);
}

/** A run's recorded outcome in the member's run cache (what `feed.ts` falls back to), if any. */
function cachedRunStatus(contextRoot: string, job: SuperTeamJob): TeamJobStatus | null {
  let status: string | undefined;
  try { status = readAutomationCache(contextRoot, job.member)?.history.find((e) => e.firedAt === job.runId)?.status; } catch { status = undefined; }
  if (!status) return null;
  return DONE.has(status) ? 'done' : FAILED.has(status) ? 'failed' : null;
}

/**
 * A team job's status and last line, from its member's thread (and the live job when there is
 * one). Only what came AFTER the job's own ask counts: a busy member's run went on past it, and
 * that run's ending and posts are not this job's.
 *
 * A REPLY (a busy member's queue, or a scheduled member's conversation) cannot be read from the
 * thread alone: its ending is a `replied`/`failed` like the busy turn's. So its ending is the say
 * job's (live, or `outcome` recorded when it settled), and its last line only the member's posts
 * from the moment it got the lock. A reply the say path no longer knows and that never recorded an
 * ending was lost with the server (a queued one waits in the server's memory): failed, with the
 * restart reconciliation's "outcome unknown" (`<entryId>~r`) as its last line when there is one.
 */
export function teamJobLive(
  contextRoot: string,
  job: SuperTeamJob,
  live: LiveSayJob | null,
): { status: TeamJobStatus; lastLine: string } {
  let entries: ThreadEntry[] = [];
  try { entries = readThreadRun(contextRoot, job.member, job.runId); } catch { entries = []; }
  const ordered = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const at = job.entryId ? ordered.findIndex((e) => e.id === job.entryId) : ordered.findIndex((e) => e.kind === 'user');
  const after = at >= 0 ? ordered.slice(at + 1) : [];
  const liveReply = live?.kind === 'reply' ? live : null;

  if (job.jobKind === 'reply') {
    const from = liveReply ? liveReply.deliveredAt : job.deliveredAt;
    const to = liveReply ? liveReply.endedAt : job.endedAt;
    // Not queued: nothing held the member, so its posts after the ask are this reply's.
    const mine = from !== undefined
      ? after.filter((e) => { const ms = entryMs(e.id); return ms >= from && (to === undefined || ms <= to + MIRROR_SLACK_MS); })
      : job.queued ? [] : after;
    const lastLine = lastAgentLine(mine);
    if (liveReply) {
      if (liveReply.status === 'ok') return { status: 'done', lastLine };
      if (liveReply.status === 'failed' || liveReply.status === 'refused') return { status: 'failed', lastLine };
      return { status: liveReply.phase === 'waiting' ? 'queued' : 'running', lastLine };
    }
    if (job.outcome) return { status: job.outcome, lastLine };
    // Lost with the server. The restart reconciliation's `<entryId>~r` says "outcome unknown":
    // never a success, but its sentence is the honest last line.
    const unknown = job.entryId ? ordered.find((e) => e.id === `${job.entryId}~r`) : undefined;
    return { status: 'failed', lastLine: lastLine || (unknown ? firstLine(unknown.text, 300) : '') };
  }

  let lastLine = lastAgentLine(after);
  // A fresh run that posted nothing answered in its document (what AI Team draws as its report):
  // its opening line, read through the same symlink-refusing reader.
  if (!lastLine) {
    const head = readRunAnswer(contextRoot, job.member, job.runId)?.text.split('\n').find((l) => l.trim() && !/^\s*(`{3,}|~{3,})/.test(l));
    if (head) lastLine = firstLine(plainPostText(head), 300);
  }
  if (live?.kind === 'run' && live.status === 'running') return { status: 'running', lastLine };
  for (const e of after) {
    if (e.kind !== 'system' || !e.event) continue;
    // A reconciliation entry (`~r`) closes a turn whose outcome nobody knows: not a success.
    if (e.id.endsWith('~r')) return { status: 'failed', lastLine: lastLine || firstLine(e.text, 300) };
    if (DONE.has(e.event)) return { status: 'done', lastLine };
    if (FAILED.has(e.event)) return { status: 'failed', lastLine };
  }
  if (live?.kind === 'run') return { status: live.status === 'success' ? 'done' : 'failed', lastLine };
  // A lost terminal write (or a missing ask entry) must not read running for ever: the run cache
  // is the record, and it knows (`feed.ts` statusFor does the same).
  const cached = cachedRunStatus(contextRoot, job);
  if (cached) return { status: cached, lastLine };
  return { status: 'running', lastLine };
}

/** Record a reply job's own ending once the say path's job settled. */
export function settleTeamJob(
  s: SuperState,
  id: string,
  end: { outcome: 'done' | 'failed'; deliveredAt?: number; endedAt?: number },
): void {
  const j = s.team.find((x) => x.id === id);
  if (!j) return;
  j.outcome = end.outcome;
  if (end.deliveredAt !== undefined) j.deliveredAt = end.deliveredAt;
  if (end.endedAt !== undefined) j.endedAt = end.endedAt;
}

/**
 * Close every open approval question whose member no longer waits on the owner (approved since,
 * turned off, or gone): one that stays open leads the strip and holds every later escalation
 * behind it. `waiting(member)` is the route's live check. Returns whether anything closed.
 */
export function closeSettledApprovals(s: SuperState, waiting: (member: string) => boolean): boolean {
  let closed = false;
  for (const q of s.queue) {
    if (q.kind !== 'approval' || q.state === 'done' || !q.member || waiting(q.member)) continue;
    q.state = 'done';
    closed = true;
  }
  return closed;
}

function lastAgentLine(entries: ThreadEntry[]): string {
  const last = [...entries].reverse().find((e) => e.kind === 'agent' && e.text.trim());
  return last ? firstLine(last.text, 300) : '';
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
