import { randomBytes } from 'node:crypto';
import { readRunAnswer } from '../automations/feed.js';
import { listQuestions } from '../automations/hitl.js';
import { readAutomationCache } from '../automations/store.js';
import { plainPostText, readThread } from '../automations/threads.js';
import type { AutomationQuestion, ThreadEntry } from '../automations/types.js';
import { wrapUntrusted } from '../assistant/autonomy.js';
import { MAX_CONTAINERS, MAX_FLOAT, MAX_READ_BYTES, MAX_TEAM_JOBS, floatCount, trimTeamJobs, type SuperQueueItem, type SuperState, type SuperTeamJob, type TeamJobConclusion, type TeamJobEvent, type TeamJobStatus } from './types.js';
import { runChatSession } from '../automations/run-chat.js';
import { countEvent, newQueueId } from './inbox.js';
import { makeRoom } from './room.js';
import { memberTeamCardId, superEntry, superIdOfMember } from './store.js';

/**
 * A team job that is a `request` in the member's own Super (plan-r10 1, Wave 2): its card and
 * `super state` read the MEMBER's record, never a thread. The inbox registers where that record's
 * item is read from (its cache of each super's last record): this module imports none of it.
 */
type RequestSource = (contextRoot: string, member: string, requestId: string) => SuperQueueItem | null;
/** Kept on the (hoisted) function itself, never a module `let`: the inbox registers it while this
 *  module may still be evaluating (inbox.ts and team.ts import each other). */
export function setRequestSource(fn: RequestSource | null): void { (setRequestSource as unknown as { fn: RequestSource | null }).fn = fn; }
function requestSourceOf(): RequestSource | null { return (setRequestSource as unknown as { fn?: RequestSource | null }).fn ?? null; }

/** A request job's status and line, from the member's record: queued until its turn carries it,
 *  running while it is delivered or accepted, done at `team done`. */
export function requestJobStatus(contextRoot: string, job: SuperTeamJob): { status: TeamJobStatus; lastLine: string } {
  const source = requestSourceOf();
  const item = job.request && source ? source(contextRoot, job.member, job.request) : null;
  if (job.told === 'done' && !item) return { status: 'done', lastLine: job.brief };
  if (!item) return { status: job.told === 'done' ? 'done' : 'queued', lastLine: job.brief };
  if (item.state === 'done') return { status: 'done', lastLine: firstLine(item.result ?? job.brief, 200) };
  // The member was turned off: the job waits, undelivered (main was told once).
  if (!superEntry(contextRoot, superIdOfMember(job.member)).enabled) return { status: 'failed', lastLine: 'The member is turned off: this job waits until the owner turns it on.' };
  if (item.state === 'pending') return { status: 'queued', lastLine: job.brief };
  return { status: 'running', lastLine: job.brief };
}

/**
 * The Super Agent's jobs for the project's AI Team (`super team ask`, task
 * super-agent-ai-team-uyelerine-is-verir-…). A job is NOT a second mechanism: it went into the
 * member's own thread through the AI Team's say path (`sayToAgent`), so the member's model and
 * approval rule it, and it runs at once in its own session and thread run. The record only names
 * where it landed; what it says now is read from the say job while that is in memory, and from
 * the member's thread after. A `reply` job with `queued` is a record from before jobs ran in
 * parallel, written when a busy member queued it: still read, never written.
 */

export function newTeamJobId(): string {
  return `team-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** Record a job (newest first, capped: a member's current root is never cut), put its member's
 *  card on the stage (or point that card at it when it is the member's new root), and close every
 *  open approval question about its member: a member that just took a job is approved. */
export function recordTeamJob(s: SuperState, job: SuperTeamJob): void {
  s.team = trimTeamJobs([job, ...s.team.filter((j) => j.id !== job.id)], MAX_TEAM_JOBS);
  dropOrphanTeamCards(s);
  // A follow-up continues its member's conversation: the member's ONE card shows it, put back when
  // it was retired or closed meanwhile (the same id, so never a second card).
  const root = job.followUpOf ? memberRoot(s, job.member) : job;
  if (root) ensureTeamContainer(s, job.member, root.id);
  for (const q of s.queue) if (q.kind === 'approval' && q.member === job.member && q.state !== 'done') q.state = 'done';
}

/** A card whose job fell off the record goes with it (no tile without a job). */
function dropOrphanTeamCards(s: SuperState): void {
  const kept = new Set(s.team.map((j) => j.id));
  s.containers = s.containers.filter((c) => c.kind !== 'team' || kept.has(c.ref));
}

/** A member's chain root now: its newest job with no `followUpOf` (plan-r10 1b). */
export function memberRoot(s: Pick<SuperState, 'team'>, member: string): SuperTeamJob | null {
  return s.team.find((j) => j.member === member && !j.followUpOf) ?? null;
}

/**
 * A member's ONE card (plan-r10 1b, `i74xj5`): square, id `containerIdFor('team', 'member:' + slug)`,
 * its `ref` the member's current root. A new root on the same member moves the card's `ref` and
 * keeps its place, drop and size. A first card is placed like a child's chat card (floating while
 * the stage has room, in Others when it is full; a full record retires its oldest finished cards
 * first, and adds none only when every card must stay).
 */
export function ensureTeamContainer(s: SuperState, member: string, rootId: string): string | null {
  const id = memberTeamCardId(member);
  const have = s.containers.find((c) => c.id === id && c.kind === 'team')
    // A card from before the member's own id (one per job): it becomes the member's card.
    ?? s.containers.find((c) => c.kind === 'team' && s.team.find((j) => j.id === c.ref)?.member === member);
  if (have) {
    if (have.id !== id) {
      for (const g of s.groups) g.cards = g.cards.map((x) => (x === have.id ? id : x));
      if (s.view.card === have.id) s.view.card = id;
      if (s.view.cards) s.view.cards = s.view.cards.map((x) => (x === have.id ? id : x));
      have.id = id;
    }
    have.ref = rootId;
    return id;
  }
  makeRoom(s, 1, [id]);
  if (s.containers.length >= MAX_CONTAINERS) return null;
  s.containers.push({ id, kind: 'team', ref: rootId, shape: 'square', place: floatCount(s) < MAX_FLOAT ? 'float' : 'others' });
  return id;
}

/** How many of a member's conversation's turns its current root carries (the root and every
 *  follow-up on it): the 20-turn rotation reads it. */
export function chainTurns(s: Pick<SuperState, 'team'>, root: SuperTeamJob): number {
  return 1 + s.team.filter((j) => j.followUpOf === root.id).length;
}

/** The follow-ups of a root still waiting for the conversation's turn slot (`queued`). */
export function waitingFollowUps(contextRoot: string, s: Pick<SuperState, 'team'>, root: SuperTeamJob): number {
  return s.team.filter((j) => {
    if (j.followUpOf !== root.id || j.open !== true) return false;
    const live = liveSource ? liveSource(contextRoot, j) : null;
    return live?.kind === 'reply' ? live.status === 'running' && live.phase === 'waiting' : j.queued;
  }).length;
}

/** The chain's recent posts and asks, oldest first, as the preamble of a NEW root on the same card
 *  (a rotation, or a continue that could not be made): the scheduled-member recent-thread idea
 *  (`sayToAgent`), so the fresh run knows where the conversation stood. '' when there is nothing. */
export function chainPreamble(contextRoot: string, root: SuperTeamJob, maxChars = 900): string {
  let entries: ThreadEntry[] = [];
  try { entries = readThread(contextRoot, root.member, { runId: root.runId }); } catch { entries = []; }
  const lines = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((e) => (e.kind === 'agent' || e.kind === 'user') && e.text.trim())
    .map((e) => `${e.kind === 'user' ? 'Asked' : 'You said'}: ${firstLine(e.text, 200)}`);
  if (!lines.length) return '';
  const out: string[] = [];
  let used = 0;
  for (const l of lines.reverse()) {
    if (used + l.length + 1 > maxChars) break;
    out.unshift(l);
    used += l.length + 1;
  }
  return out.length ? `Earlier in this conversation (recent posts, for context):\n${out.join('\n')}\n\nNow:\n` : '';
}

/** Where the say path's live jobs are read from: the server injects it (this module imports no
 *  server code), so the window's view can say what each team card is doing now. */
let liveSource: ((contextRoot: string, job: SuperTeamJob) => LiveSayJob | null) | null = null;
export function setTeamLiveSource(fn: typeof liveSource): void { liveSource = fn; }

/** Where the owner's reply on a run is told to the Super's side: the server injects it (the say
 *  route imports nothing of the super's routes). */
export type TeamFollowUpNote = (contextRoot: string, reply: { member: string; runId: string; entryId: string; jobId: string; text: string }) => void;
let followUpNote: TeamFollowUpNote | null = null;
export function setTeamFollowUpNote(fn: TeamFollowUpNote | null): void { followUpNote = fn; }
export function noteTeamFollowUp(...args: Parameters<TeamFollowUpNote>): void { followUpNote?.(...args); }

/** Where a team job whose ending is still owed to the super is watched: the server injects it
 *  (this module imports no server code). */
let jobWatcher: ((contextRoot: string, jobId: string) => void) | null = null;
export function setTeamJobWatcher(fn: typeof jobWatcher): void { jobWatcher = fn; }

/** A team job whose ending (done or stuck) is still owed to the super: `open`, or told a question
 *  by a record from before `open` existed. A job that was never owed an event is never watched. */
export function teamJobOwed(j: SuperTeamJob): boolean {
  return j.open === true || j.told === 'question';
}

/** Arm the watch of every team job whose ending is still owed, from the record: a watch lives in
 *  memory, the record survives a restart and an answer days later. */
export function armTeamJobWatches(contextRoot: string, s: Pick<SuperState, 'team' | 'enabled' | 'session'>): void {
  if (!jobWatcher || !s.enabled || !s.session) return;
  // A request job is the member's own Super's: no thread to watch (its events come from team done).
  for (const j of s.team) if (!j.request && (teamJobOwed(j) || teamJobTrailing(j))) jobWatcher(contextRoot, j.id);
}

/** How long a job whose ending was told is still read for a late post (a background wait that
 *  outlived its turn). A resumed turn is a follow-up with its own record, so this has one job. */
export const TEAM_TRAIL_MS = 24 * 60 * 60_000;

export function teamJobTrailing(j: SuperTeamJob, now = Date.now()): boolean {
  return j.toldEndAt !== undefined && !j.concluded && now - j.toldEndAt < TEAM_TRAIL_MS;
}

/** A finished job's row never changes: read once per process, not on every push. Keyed by
 *  vault and job; pruned to the jobs still shown on each read. */
const finished = new Map<string, TeamLiveRow>();

/** A team card's row: what it does now, and the real session behind it (`sessionId`: the run's
 *  own Claude session, bound when the run began; absent while unknown or for a job that keeps none). */
export interface TeamLiveRow {
  status: TeamJobStatus; lastLine: string; sessionId?: string;
  /** This machine bound the session to the run, so a reply can resume it. A session only noted
   *  while it ran (a one-off job, a killed run) shows but cannot be continued. */
  resumable?: true;
  /** The member's previous root's session, after a rotation (plan-r10 1b): the card's "önceki
   *  konuşma" opens it. Absent when there is none or this Mac does not know it. */
  prevSessionId?: string;
}

/** The session a job's run lives in, as every surface believes it (`runChatSession`). */
function jobSession(contextRoot: string, j: SuperTeamJob): { sessionId?: string; resumable?: true } {
  // A request lives in the member's own Super chat: its session is the card's.
  if (j.request) {
    const sid = superEntry(contextRoot, superIdOfMember(j.member)).session;
    return sid ? { sessionId: sid } : {};
  }
  try {
    const chat = runChatSession(contextRoot, j.member, j.runId);
    return chat ? { sessionId: chat.claudeId, ...(chat.resumable ? { resumable: true as const } : {}) } : {};
  } catch { return {}; }
}

/** Status and last line of every team job that has a card on the stage (the window's view). */
export function teamLiveRows(contextRoot: string, s: Pick<SuperState, 'team' | 'containers'>): Record<string, TeamLiveRow> | undefined {
  const shown = new Set(s.containers.filter((c) => c.kind === 'team').map((c) => c.ref));
  const keyOf = (id: string) => `${contextRoot}\u0000${id}`;
  const live = new Set([...shown].map(keyOf));
  for (const k of finished.keys()) if (k.startsWith(`${contextRoot}\u0000`) && !live.has(k)) finished.delete(k);
  if (!shown.size) return undefined;
  const out: Record<string, TeamLiveRow> = {};
  for (const j of s.team) {
    if (!shown.has(j.id)) continue;
    // The owner's follow-up on this conversation is this card's work now, however old the job.
    const next = s.team.find((x) => x.followUpOf === j.id && x.open === true);
    if (next) finished.delete(keyOf(j.id));
    const hit = finished.get(keyOf(j.id));
    if (hit) { out[j.id] = hit; continue; }
    try {
      const own = teamJobStatus(contextRoot, j, liveSource ? liveSource(contextRoot, j) : null);
      const status = next ? teamJobStatus(contextRoot, next, liveSource ? liveSource(contextRoot, next) : null).status : own.status;
      // A member's one card after a rotation: the conversation before this one.
      const prevRoot = j.followUpOf ? undefined : s.team.filter((x) => x.member === j.member && !x.followUpOf && x.startedAt < j.startedAt)[0];
      const prevSession = prevRoot ? jobSession(contextRoot, prevRoot).sessionId : undefined;
      const row: TeamLiveRow = { status, lastLine: own.lastLine, ...jobSession(contextRoot, j), ...(prevSession ? { prevSessionId: prevSession } : {}) };
      out[j.id] = row;
      // A reply is final only once its outcome is recorded (its zero-post mirror lands just after it
      // settles); a job whose ending is still owed to the super is never final (an answer resumes it),
      // nor one the owner can still continue.
      if ((status === 'done' || status === 'failed') && !next && !teamJobOwed(j) && !teamJobTrailing(j) && (j.jobKind === 'run' || j.outcome)) finished.set(keyOf(j.id), row);
    } catch { /* a card with no status reads as its job only */ }
  }
  return out;
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
/** A run the runner recorded but never ran to an end the thread can hold (no `started`, so no
 *  terminal entry): over, never running. Read from the run cache. */
const NEVER_RAN = new Set(['blocked', 'deferred', 'orphaned']);
/** A board-only run's named denial (`board-scope.ts` `boardLimitReason`): the job's last line. */
const BOARD_LIMIT_MARK = 'is limited to its board:';
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
  return DONE.has(status) ? 'done' : FAILED.has(status) || NEVER_RAN.has(status) ? 'failed' : null;
}

/**
 * A team job's status and last line, from its member's thread (and the live job when there is
 * one). Only what came AFTER the job's own ask counts.
 *
 * A REPLY (a scheduled member's conversation, or an old record's queue) cannot be read from the
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
  const { ordered, after } = jobThread(contextRoot, job);
  const liveReply = live?.kind === 'reply' ? live : null;

  if (job.jobKind === 'reply') {
    const lastLine = lastAgentLine(replyWindow(job, liveReply, after));
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
    // A board-only run that was denied a step names why: that reason is the line the Super and
    // the member's card read, ahead of whatever the agent said before it stopped.
    if (FAILED.has(e.event)) return { status: 'failed', lastLine: e.text.includes(BOARD_LIMIT_MARK) ? boardLimitLine(e.text) : lastLine };
  }
  if (live?.kind === 'run') return { status: live.status === 'success' ? 'done' : 'failed', lastLine };
  // A lost terminal write (or a missing ask entry) must not read running for ever: the run cache
  // is the record, and it knows (`feed.ts` statusFor does the same).
  const cached = cachedRunStatus(contextRoot, job);
  if (cached) return { status: cached, lastLine };
  return { status: 'running', lastLine };
}

/** A REPLY's own entries among what came after its ask: the member's posts from the moment it got
 *  the lock (not queued: nothing held the member, so all of them). */
function replyWindow(job: SuperTeamJob, liveReply: Extract<LiveSayJob, { kind: 'reply' }> | null, after: ThreadEntry[]): ThreadEntry[] {
  const from = liveReply ? liveReply.deliveredAt : job.deliveredAt;
  const to = liveReply ? liveReply.endedAt : job.endedAt;
  return from !== undefined
    ? after.filter((e) => { const ms = entryMs(e.id); return ms >= from && (to === undefined || ms <= to + MIRROR_SLACK_MS); })
    : job.queued ? [] : after;
}

/**
 * The member's whole answer to a team job (`super read <team-id>`, and the head of its `event=done`
 * item): its LAST post first (the one the last line reads, usually the result), then the earlier
 * posts after the ask in order, from the same window `teamJobLive` reads; a fresh run that posted
 * nothing answered in its document (`readRunAnswer`). '' when there is nothing yet. At most
 * MAX_READ_BYTES of it.
 */
export function teamJobAnswer(contextRoot: string, job: SuperTeamJob, live: LiveSayJob | null): string {
  if (job.request) {
    const source = requestSourceOf();
    const item = source ? source(contextRoot, job.member, job.request) : null;
    return item?.result ?? '';
  }
  const { after } = jobThread(contextRoot, job);
  // A run's window is every post after its ask, the one `teamJobLive` reads (plan r8 §B). A follow-up
  // asked while the member still runs lands in the same run: task super-takip-sorusu-cevap-penceresi.
  const window = job.jobKind === 'reply' ? replyWindow(job, live?.kind === 'reply' ? live : null, after) : after;
  const posts = window.filter((e) => e.kind === 'agent' && e.text.trim()).map((e) => e.text.trim());
  let text = posts.length ? [posts[posts.length - 1], ...posts.slice(0, -1)].join('\n\n') : '';
  if (job.jobKind === 'run') {
    // The final message: every `super read` of a long report ends up here.
    text = withDocument(contextRoot, job, live, text);
  }
  const buf = Buffer.from(text, 'utf-8');
  return buf.length > MAX_READ_BYTES ? buf.subarray(0, MAX_READ_BYTES).toString('utf-8').replace(/\uFFFD+$/, '') : text;
}

/** A run's document: its final message, which the thread never holds. */
function runDocument(contextRoot: string, job: SuperTeamJob): string {
  try { return readRunAnswer(contextRoot, job.member, job.runId)?.text.trim() ?? ''; } catch { return ''; }
}

/** The document joined to a run's posts. It leads, unless the owner answered a question of the
 *  run: a resume never rewrites the document, so it is the first turn's, and the posts are newer. */
function withDocument(contextRoot: string, job: SuperTeamJob, live: LiveSayJob | null, posts: string): string {
  const doc = runDocument(contextRoot, job);
  if (!doc || posts.includes(doc)) return posts;
  if (!posts) return doc;
  return jobQuestions(contextRoot, job, live).some((q) => q.state === 'answered') ? `${posts}\n\n${doc}` : `${doc}\n\n${posts}`;
}

/** The share of a done job's answer its `[super events]` item carries; `super read` has the rest. */
export const TEAM_ANSWER_EXCERPT = 600;

/** The job's run in its member's thread, in id order, and what came after the job's own ask.
 *  `fromMs` reads only from the day before that moment on (an answer days later). */
function jobThread(contextRoot: string, job: SuperTeamJob, fromMs?: number): { ordered: ThreadEntry[]; after: ThreadEntry[] } {
  let entries: ThreadEntry[] = [];
  // Only the day files a run can be in: from the day before its fire day (a day file is named by
  // the writer's local date, the run id is UTC), never the member's whole history.
  const fired = fromMs ?? Date.parse(job.runId);
  const fromDay = Number.isFinite(fired) ? new Date(fired - 86_400_000).toISOString().slice(0, 10) : undefined;
  try { entries = readThread(contextRoot, job.member, { runId: job.runId, ...(fromDay ? { fromDay } : {}) }); } catch { entries = []; }
  const ordered = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const at = job.entryId ? ordered.findIndex((e) => e.id === job.entryId) : ordered.findIndex((e) => e.kind === 'user');
  return { ordered, after: at >= 0 ? ordered.slice(at + 1) : [] };
}

/** A question written a moment before the server stamped the job (one machine, one clock). */
const QUESTION_SLACK_MS = 2_000;

/** The questions the job's run asked the owner, oldest first: asked of the subject, the member's
 *  question store, never the thread (a run that asks with `automations propose` writes no `asked`
 *  entry; a resumed turn can ask again on the same run). Only from the job's own turn on: a REPLY
 *  shares a busy member's run, so only what was asked once it got the member (`deliveredAt`) is
 *  its; one never delivered (refused, or still waiting) asked nothing. */
function jobQuestions(contextRoot: string, job: SuperTeamJob, live: LiveSayJob | null): AutomationQuestion[] {
  const from = job.jobKind === 'reply'
    ? (live?.kind === 'reply' ? live.deliveredAt : undefined) ?? job.deliveredAt
    : job.startedAt - QUESTION_SLACK_MS;
  if (from === undefined) return [];
  let all: AutomationQuestion[] = [];
  try { all = listQuestions(contextRoot, job.member); } catch { all = []; }
  return all.filter((q) => q.kind === 'flow-hitl' && q.runFiredAt === job.runId && Date.parse(q.createdAt) >= from);
}

/** The `replied` entry an ANSWER's resume writes last (`resumeWithAnswer`), told apart from a
 *  reply turn's own `replied` by its server-written sentence. */
function answerResumeEnded(e: ThreadEntry): boolean {
  return e.kind === 'system' && e.event === 'replied' && e.via === 'runner' && /^Question answered via /.test(e.text);
}

/** Where a team job stands for the super: `question` while a question of its run waits on the
 *  owner (that question named), `done` or `stuck` once it ended (with the line that ended it, when
 *  the end is an answer's resumed turn), null while it is queued or runs. */
export interface TeamJobEnding { kind: TeamJobEvent | null; question?: AutomationQuestion; lastLine?: string }

/**
 * A team job's ending now. After the owner answered, the ending is the last answer's resumed
 * turn's: every answer's resume writes one `replied` last, so the job ended once there is one for
 * each answer since the first, and its outcome is the last question's own resolution (an error is
 * stuck). A member gone, or a turn lost with the server, is the job's watch's to conclude.
 */
export function teamJobEnding(contextRoot: string, job: SuperTeamJob, live: LiveSayJob | null): TeamJobEnding {
  const qs = jobQuestions(contextRoot, job, live);
  const waiting = qs.filter((q) => q.state === 'pending');
  if (waiting.length) return { kind: 'question', question: waiting[waiting.length - 1] };
  const answered = qs.filter((q) => q.state === 'answered' && q.answeredAt).sort((a, b) => a.answeredAt!.localeCompare(b.answeredAt!));
  const last = answered[answered.length - 1];
  if (last) {
    const first = Date.parse(answered[0].answeredAt!);
    const resumes = jobThread(contextRoot, job, first).ordered.filter((e) => answerResumeEnded(e) && entryMs(e.id) >= first);
    // One per answer, and one at or after the LAST answer: an attempt that resumed nothing (a
    // refused or failed spawn, the question reopened) still writes its `replied`, so the count alone
    // could end a job whose real resume is still running.
    const lastMs = Date.parse(last.answeredAt!);
    if (resumes.length < answered.length || !resumes.some((e) => entryMs(e.id) >= lastMs)) return { kind: null };
    const line = firstLine(last.resolutionError ?? last.resolutionNote ?? '', 300);
    return { kind: last.resolutionError ? 'stuck' : 'done', ...(line ? { lastLine: line } : {}) };
  }
  const { status } = teamJobLive(contextRoot, job, live);
  return { kind: status === 'done' ? 'done' : status === 'failed' ? 'stuck' : null };
}

/** A team job's status and last line as the card and `super state` show them: the same reading
 *  as the super's events (a run that asked reads asking, never done), the thread for the rest. */
export function teamJobStatus(contextRoot: string, job: SuperTeamJob, live: LiveSayJob | null): { status: TeamJobStatus; lastLine: string } {
  if (job.request) return requestJobStatus(contextRoot, job);
  // A stuck its watch concluded (gone, lost with the server) stays what the super was told.
  if (job.concluded) return { status: 'failed', lastLine: CONCLUDED_LINES[job.concluded] };
  const row = teamJobLive(contextRoot, job, live);
  const end = teamJobEnding(contextRoot, job, live);
  const status: TeamJobStatus = end.kind === 'question' ? 'asking'
    : end.kind === 'done' ? 'done'
    : end.kind === 'stuck' ? 'failed'
    : row.status === 'queued' ? 'queued' : 'running';
  return { status, lastLine: end.lastLine ?? row.lastLine };
}

/** A concluded stuck's last line, in the server's words. */
export const CONCLUDED_LINES: Record<TeamJobConclusion, string> = {
  gone: 'The member is no longer in the AI Team.',
  lost: 'Outcome unknown: its turn ended with no record (the server stopped during it).',
};

/** What a team job's ending tells the super now (`teamJobEnding`'s kind). */
export function teamJobEvent(contextRoot: string, job: SuperTeamJob, live: LiveSayJob | null): TeamJobEvent | null {
  return teamJobEnding(contextRoot, job, live).kind;
}

/**
 * A team job's ending becomes ONE event for the super, batched like a child's: a pending
 * `done`/`stuck`/`question` item naming the job (`team`). Each question of its run is its own
 * event (`toldQuestion`); `told` keeps the same one from being queued twice, whoever calls; a
 * done or stuck is final. Called inside the record write when the say path's job settled and by
 * the job's watch. Returns whether an item was added.
 */
export function noteTeamJobEnd(
  contextRoot: string, s: SuperState, jobId: string, live: LiveSayJob | null, now = Date.now(),
  /** The job's watch concluded it stuck itself (the member gone, the turn lost with the server). */
  concluded?: TeamJobConclusion,
): boolean {
  const job = s.team.find((j) => j.id === jobId);
  // With the mode off nobody is told: the job's ending stays unsaid, and it reaches the owner
  // (automations/super-quiet.ts reads a job the Super was never told as his).
  if (!job || !s.session || !s.enabled || job.told === 'done' || job.told === 'stuck') return false;
  // A turn concluded lost is read once more inside this write: an ending that landed since wins.
  const read = concluded === 'gone' ? null : teamJobEnding(contextRoot, job, live);
  const conclude = concluded === 'gone' || (concluded === 'lost' && read?.kind === null);
  const end: TeamJobEnding = conclude ? { kind: 'stuck', lastLine: CONCLUDED_LINES[concluded!] } : read!;
  if (conclude) job.concluded = concluded;
  const qid = end.question?.id;
  // A question item stands only while that question is the one waiting.
  if (end.kind !== 'question' || qid !== job.toldQuestion) {
    for (const q of s.queue) if (q.team === jobId && q.kind === 'question' && q.state === 'pending') q.state = 'done';
  }
  if (!end.kind || (end.kind === job.told && qid === job.toldQuestion)) return false;
  job.told = end.kind;
  if (qid) job.toldQuestion = qid; else delete job.toldQuestion;
  if (end.kind !== 'question') { delete job.open; job.toldEndAt = now; }
  // An answer already queued stays: it says something the ending does not repeat.
  for (const q of s.queue) if (q.team === jobId && q.state === 'pending' && !q.partial) q.state = 'done';
  s.queue.push({
    id: newQueueId(), sessionId: s.session, kind: end.kind, state: 'pending', createdAt: now, team: jobId,
    ...(end.kind === 'question' ? {} : { posts: claimPosts(contextRoot, s, job) }),
  });
  countEvent(s);
  return true;
}

/** A post stands this long before it is an event of its own: a member's last post is followed by
 *  its run's end within seconds, and that ending carries it. */
export const TEAM_POST_SETTLE_MS = 45_000;

/** The first job of a job's chain (the owner's follow-ups continue it): it holds `toldPost`. */
function chainRoot(s: Pick<SuperState, 'team'>, job: SuperTeamJob): SuperTeamJob {
  return (job.followUpOf ? s.team.find((j) => j.id === job.followUpOf) : undefined) ?? job;
}

/** Every post of a chain, in id order: its run after its first ask. */
function chainPosts(contextRoot: string, root: SuperTeamJob): ThreadEntry[] {
  const { after } = jobThread(contextRoot, root);
  // A record from when a busy member queued a reply shares that member's run: only its own window.
  return (root.queued ? replyWindow(root, null, after) : after).filter((e) => e.kind === 'agent' && e.text.trim());
}

function untoldPosts(contextRoot: string, s: Pick<SuperState, 'team'>, job: SuperTeamJob): ThreadEntry[] {
  const root = chainRoot(s, job);
  return chainPosts(contextRoot, root).filter((e) => root.toldPost === undefined || e.id > root.toldPost);
}

/** What is new for the super, marked as told: the one place a post moves to "told". */
function claimPosts(contextRoot: string, s: Pick<SuperState, 'team'>, job: SuperTeamJob): NonNullable<SuperQueueItem['posts']> {
  const root = chainRoot(s, job);
  const fresh = untoldPosts(contextRoot, s, job);
  const range = { ...(root.toldPost ? { after: root.toldPost } : {}) };
  if (!fresh.length) return range;
  root.toldPost = fresh[fresh.length - 1].id;
  return { ...range, upto: root.toldPost };
}

/** A post waits for the super: read outside the record's write first, so a quiet tick writes nothing. */
export function teamPostsDue(contextRoot: string, s: Pick<SuperState, 'team'>, job: SuperTeamJob, now = Date.now()): boolean {
  const fresh = untoldPosts(contextRoot, s, job);
  return fresh.length > 0 && now - entryMs(fresh[fresh.length - 1].id) >= TEAM_POST_SETTLE_MS;
}

/**
 * An answer that no ending carries becomes ONE event: a post of a job still going (the member said
 * its result and went on waiting), or a late one. Named by the newest job of its chain.
 */
export function noteTeamJobPosts(contextRoot: string, s: SuperState, jobId: string, now = Date.now()): boolean {
  const job = s.team.find((j) => j.id === jobId);
  if (!job || !s.session || !s.enabled || !teamPostsDue(contextRoot, s, job, now)) return false;
  const root = chainRoot(s, job);
  const newest = s.team.find((j) => j.followUpOf === root.id) ?? root;
  s.queue.push({
    id: newQueueId(), sessionId: s.session, kind: 'done', state: 'pending', createdAt: now, team: newest.id,
    partial: true, posts: claimPosts(contextRoot, s, newest),
  });
  countEvent(s);
  return true;
}

/**
 * The owner wrote on a team job's own conversation: the reply is a job like any reply job, so its
 * ending and answers reach the super through the same events, with what he wrote. No card (it
 * continues the job's own). Returns the new job, null when the run is no team job's.
 */
export function recordTeamFollowUp(
  contextRoot: string, s: SuperState,
  reply: { member: string; runId: string; entryId: string; jobId: string; text: string },
  now = Date.now(),
): SuperTeamJob | null {
  if (!s.enabled || !s.session) return null;
  const root = s.team.find((j) => j.member === reply.member && j.runId === reply.runId && !j.followUpOf);
  if (!root) return null;
  // A job told before posts were counted: what it already said is not new.
  if (root.toldPost === undefined && root.told && root.told !== 'question') {
    const before = chainPosts(contextRoot, root).filter((e) => e.id < reply.entryId);
    if (before.length) root.toldPost = before[before.length - 1].id;
  }
  const job: SuperTeamJob = {
    id: newTeamJobId(), member: reply.member, runId: reply.runId, entryId: reply.entryId,
    jobKind: 'reply', jobId: reply.jobId, queued: false,
    brief: firstLine(reply.text, 200), startedAt: now, open: true, followUpOf: root.id,
  };
  // Over the cap the oldest follow-ups go first, never a member's current root (plan-r10 1b).
  s.team = trimTeamJobs([job, ...s.team], MAX_TEAM_JOBS);
  dropOrphanTeamCards(s);
  return job;
}

/** A team item is no longer true: its job left the record, a later ending replaced it, or (read
 *  from `contextRoot` when given) its question is no longer the one waiting on the owner. */
export function staleTeamItem(s: Pick<SuperState, 'team'>, q: SuperQueueItem, contextRoot?: string): boolean {
  const job = s.team.find((j) => j.id === q.team);
  if (q.partial) return !job;
  // A request job's events come from the member's own Super, never from a thread.
  if (job?.request) return q.kind === 'question' ? false : job.told !== q.kind;
  if (!job || job.told !== q.kind) return true;
  if (q.kind !== 'question' || contextRoot === undefined) return false;
  const end = teamJobEnding(contextRoot, job, null);
  return end.kind !== 'question' || end.question?.id !== job.toldQuestion;
}

/** A team item's result goes to the owner: he asked for the job through the super. */
export function awaitedTeamItem(s: Pick<SuperState, 'team'>, q: SuperQueueItem): boolean {
  return (q.kind === 'done' || q.kind === 'stuck') && s.team.find((j) => j.id === q.team)?.awaited === true;
}

/** One team item inside a `[super events]` batch: the server's line, then the member's text fenced. */
export function teamItemLines(contextRoot: string, vault: string, s: Pick<SuperState, 'team'>, q: SuperQueueItem): string[] {
  const job = s.team.find((j) => j.id === q.team);
  if (!job) return [`- item=${q.id} team=${q.team} event=${q.kind} moved-on`];
  if (job.request) return requestJobLines(contextRoot, vault, s, job, q);
  const live = liveSource ? liveSource(contextRoot, job) : null;
  const row = teamJobStatus(contextRoot, job, live);
  const end = teamJobEnding(contextRoot, job, live);
  const status = q.kind === 'question' ? 'asking' : row.status;
  const lines = [`- item=${q.id} team=${job.id} member=${job.member} event=${q.partial ? 'answer' : q.kind}${job.followUpOf ? (job.by === 'super' ? ' followup=super' : ' followup=owner') : ''}${awaitedTeamItem(s, q) ? ` awaited=owner${job.origin ? ` origin=${job.origin}` : ''}` : ''} status=${status}${q.kind === 'stuck' && row.lastLine.includes(BOARD_LIMIT_MARK) ? ' reason=board-limit' : ''}`];
  if (job.followUpOf && job.by !== 'super') {
    const asked = jobThread(contextRoot, job).ordered.find((e) => e.id === job.entryId)?.text ?? job.brief;
    lines.push(wrapUntrusted(vault, `The owner wrote to the member: ${asked.slice(0, TEAM_ANSWER_EXCERPT)}`));
  } else if (job.brief) lines.push(wrapUntrusted(vault, `Brief: ${job.brief}`));
  const asked = q.kind === 'question' && end.question?.id === job.toldQuestion ? end.question : undefined;
  if (asked) lines.push(wrapUntrusted(vault, `Question: ${firstLine(asked.question, 300)}`));
  const lastLine = q.kind === 'question' ? teamJobLive(contextRoot, job, live).lastLine : row.lastLine;
  if (q.kind === 'done') {
    // The answer itself, so the super can relay it without a second call: the member's final post
    // first (an answered question's resolution line leads when that is how it ended).
    let answer = q.posts?.upto ? itemPosts(contextRoot, s, job, q.posts) : q.posts?.after ? '' : teamJobAnswer(contextRoot, job, live);
    if (q.partial) { if (answer) lines.push(...answerLines(vault, job, answer)); return lines; }
    // A run's final message is in its document, never a post: it leads, so no post cuts it out.
    // The resumed turn said its all in earlier events: the first turn's document is not news.
    const staleDoc = q.posts?.after !== undefined && !answer && jobQuestions(contextRoot, job, live).some((x) => x.state === 'answered');
    if (job.jobKind === 'run' && !staleDoc) answer = withDocument(contextRoot, job, live, answer);
    if (q.posts?.after && !answer && !end.lastLine) { lines.push('  (No new answer: what it said reached you in an earlier event.)'); return lines; }
    if (end.lastLine && !answer.includes(end.lastLine)) answer = answer ? `${end.lastLine}\n\n${answer}` : end.lastLine;
    if (!answer) answer = lastLine;
    if (answer) lines.push(...answerLines(vault, job, answer));
    return lines;
  }
  if (lastLine) lines.push(wrapUntrusted(vault, `Last line: ${lastLine}`));
  // A stuck claimed the posts it ended on: they are delivered here or never.
  if (q.kind === 'stuck' && q.posts?.upto) lines.push(...answerLines(vault, job, itemPosts(contextRoot, s, job, q.posts)));
  return lines;
}

/** The posts one item delivers: its last first, as `teamJobAnswer` reads a whole answer. */
function itemPosts(contextRoot: string, s: Pick<SuperState, 'team'>, job: SuperTeamJob, range: NonNullable<SuperQueueItem['posts']>): string {
  const posts = chainPosts(contextRoot, chainRoot(s, job))
    .filter((e) => (range.after === undefined || e.id > range.after) && e.id <= (range.upto as string))
    .map((e) => e.text.trim());
  return posts.length ? [posts[posts.length - 1], ...posts.slice(0, -1)].join('\n\n') : '';
}

/**
 * One event of a job main gave a member's own Super (plan-r10 1): its `team done` (the result), a
 * note that closes nothing (event=answer), or the member's QUESTION to main, which only main
 * answers (`super team answer`), or asks the owner as its own question.
 */
function requestJobLines(contextRoot: string, vault: string, s: Pick<SuperState, 'team'>, job: SuperTeamJob, q: SuperQueueItem): string[] {
  const status = q.kind === 'question' ? 'asking' : requestJobStatus(contextRoot, job).status;
  const event = q.kind === 'question' ? 'question' : q.partial ? 'answer' : q.kind;
  const lines = [`- item=${q.id} team=${job.id} member=${job.member} event=${event} from=member-super${awaitedTeamItem(s, q) ? ` awaited=owner${job.origin ? ` origin=${job.origin}` : ''}` : ''} status=${status}`];
  if (job.brief) lines.push(wrapUntrusted(vault, `Brief: ${job.brief}`));
  if (q.kind === 'question') {
    lines.push(wrapUntrusted(vault, `Question: ${q.text ?? ''}`));
    lines.push(`  This member's Super asks YOU, about the job you gave it: answer with \`dreamcontext super team answer ${q.id} "<answer>"\`; if only the owner can say, ask him with your own \`super ask\` (never forward the member).`);
    return lines;
  }
  if (q.text) lines.push(...answerLines(vault, job, q.text));
  return lines;
}

function answerLines(vault: string, job: SuperTeamJob, answer: string): string[] {
  const cut = answer.length > TEAM_ANSWER_EXCERPT;
  return [
    wrapUntrusted(vault, `Answer: ${cut ? `${answer.slice(0, TEAM_ANSWER_EXCERPT).trimEnd()}…` : answer}`),
    ...(cut ? [`  (cut: the whole answer: \`dreamcontext super read ${job.id}\`)`] : []),
  ];
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

/** The board-limit sentence out of a failure entry ("Failed after 2m: <reason> | <more>"). */
function boardLimitLine(text: string): string {
  const at = text.indexOf(BOARD_LIMIT_MARK);
  const start = text.lastIndexOf(': ', at) >= 0 && text.lastIndexOf(': ', at) < at ? text.lastIndexOf(': ', at) + 2 : 0;
  return firstLine(text.slice(start).split(' | ')[0], 400);
}

function lastAgentLine(entries: ThreadEntry[]): string {
  const last = [...entries].reverse().find((e) => e.kind === 'agent' && e.text.trim());
  return last ? firstLine(last.text, 300) : '';
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
