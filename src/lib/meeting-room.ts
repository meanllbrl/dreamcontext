import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listVaults } from './vaults.js';

/**
 * MEETING ROOM — the single machine-wide place where ALL agents convene.
 *
 * Deliberately NOT peer mail. Mail is vault-to-vault correspondence, duplicated
 * on both ends behind a connection consent gate. The room is ONE global surface
 * owned by no vault: a thread lives under `~/.dreamcontext/meeting-room/` and
 * never inside any vault's `state/`. Participants are every registered vault
 * that still exists on disk — the launcher is the consent, no connection needed.
 *
 * THE ONE INVARIANT this module enforces in code, not by convention: at most one
 * thread is active (`closedAt === null`) at any moment. Opening a new thread
 * closes the active one first ({@link createThread}), and every write path that
 * could produce a second active thread runs through that same door. History is
 * kept — closing archives, it never deletes — and a CLOSED thread still accepts
 * appends, because an in-flight agent run of the old thread must land its answer
 * where the question was asked (truthful history beats tidy history).
 *
 * All mutations are SYNCHRONOUS read-modify-write on one JSON file per thread
 * ({@link mutateThread}). In a single-threaded process that makes each mutation
 * atomic without a lock — the documented assumption is that exactly ONE
 * orchestrator process (the launcher-mode server) writes here. If a second
 * launcher window ever becomes possible, this needs a real file lock.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export const MEETING_SCHEMA_VERSION = 1;

/** Who wrote a message: the room's owner, one agent, or the room itself. */
export type MeetingAuthorKind = 'user' | 'agent' | 'system';

export type ParticipantRunState = 'idle' | 'thinking' | 'replied' | 'passed' | 'error';

export interface MeetingMessage {
  id: string;
  /** Display author: 'you' is never stored — the user is stored as `user`. */
  author: string;
  authorKind: MeetingAuthorKind;
  body: string;
  createdAt: string;
  /** True only for the thread's root announcement. */
  root?: boolean;
}

export interface MeetingParticipant {
  /** Registered vault name — the mention token, exactly as registered. */
  name: string;
  /** One-line identity glance (peer-summary `whatItIs`); '' degrades to name-only. */
  whatItIs: string;
  state: ParticipantRunState;
  /** Populated when state === 'error' — the run's failure, verbatim. */
  error?: string;
  /** Total headless runs this agent has consumed in this thread (cap: 3). */
  runs: number;
}

export interface MeetingThread {
  version: number;
  id: string;
  /** First line of the announcement, capped — the history rail's label. */
  title: string;
  createdAt: string;
  /** null while this is THE active thread; ISO stamp once archived. */
  closedAt: string | null;
  participants: MeetingParticipant[];
  messages: MeetingMessage[];
  /** Mention-triggered runs consumed in this thread (directed + follow-up, cap: 8). */
  mentionRuns: number;
}

/** What the history rail needs — never the full message list. */
export interface MeetingThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  closedAt: string | null;
}

// ─── Caps ─────────────────────────────────────────────────────────────────────

/**
 * Body cap — MAX_PROMPT_CHARS parity (agent-spawn-shared.ts): a message becomes
 * part of a headless run's prompt, so the two limits must agree.
 */
export const MAX_MEETING_BODY_CHARS = 8000;
/** Mention-triggered runs (directed + follow-up) allowed per thread. */
export const MAX_MENTION_RUNS_PER_THREAD = 8;
/** Total headless runs one agent may consume in one thread. */
export const MAX_RUNS_PER_AGENT = 3;

const TITLE_CHARS = 80;

// ─── Sanitize ─────────────────────────────────────────────────────────────────

/**
 * Meeting sanitize — deliberately NOT peer-mail's `sanitizeBody`.
 *
 * Peer mail collapses `\r\n\t` to spaces because a mail body rides through
 * readline paths where a bare newline submits a partial line. A meeting
 * announcement is multiline markdown BY DESIGN (house rules, numbered asks), and
 * the prompt it lands in is passed as a single execve argument where a newline
 * is inert — so newlines and tabs SURVIVE here. Everything else that could
 * corrupt the run is still stripped: NUL and the rest of the control range
 * (minus \n\t), and the same 8000-char cap peer mail enforces.
 */
export function sanitizeMeetingBody(raw: string): string {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, MAX_MEETING_BODY_CHARS)
    .trim();
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/** `~/.dreamcontext/meeting-room` (injectable home, test-isolation pattern). */
export function meetingDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'meeting-room');
}

export function threadsDir(home: string = homedir()): string {
  return join(meetingDir(home), 'threads');
}

/** True iff `id` is a well-formed thread id — the only shape allowed in a path. */
export function isThreadId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]{10,17}-[0-9a-f]{8}$/.test(v);
}

function threadPath(id: string, home?: string): string {
  if (!isThreadId(id)) throw new Error(`Malformed thread id: ${String(id)}`);
  return join(threadsDir(home), `${id}.json`);
}

/** Time-prefixed id: a plain filename sort of the threads dir is chronological. */
function newId(now: number = Date.now()): string {
  return `${now}-${randomBytes(4).toString('hex')}`;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

function isThread(raw: unknown): raw is MeetingThread {
  if (raw === null || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.version === 'number' &&
    isThreadId(o.id) &&
    typeof o.title === 'string' &&
    typeof o.createdAt === 'string' &&
    (o.closedAt === null || typeof o.closedAt === 'string') &&
    Array.isArray(o.participants) &&
    Array.isArray(o.messages) &&
    typeof o.mentionRuns === 'number'
  );
}

/** One thread, or null when absent/corrupt. Never throws on content. */
export function readThread(id: string, home?: string): MeetingThread | null {
  const path = threadPath(id, home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return isThread(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every thread's summary, newest first (filename sort is chronological). */
export function listThreads(home?: string): MeetingThreadSummary[] {
  const dir = threadsDir(home);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: MeetingThreadSummary[] = [];
  for (const f of files.sort().reverse()) {
    const t = readThread(f.slice(0, -'.json'.length), home);
    if (t) out.push({ id: t.id, title: t.title, createdAt: t.createdAt, closedAt: t.closedAt });
  }
  return out;
}

/** THE active thread (closedAt === null), or null. At most one exists. */
export function activeThread(home?: string): MeetingThread | null {
  for (const s of listThreads(home)) {
    if (s.closedAt === null) return readThread(s.id, home);
  }
  return null;
}

// ─── Write ────────────────────────────────────────────────────────────────────

function writeThread(thread: MeetingThread, home?: string): void {
  const path = threadPath(thread.id, home);
  mkdirSync(threadsDir(home), { recursive: true });
  writeFileSync(path, JSON.stringify(thread, null, 2) + '\n', 'utf-8');
}

/**
 * Synchronous read-modify-write of one thread — the single writer door every
 * transition goes through. No awaits inside, so within one process two
 * mutations can never interleave. Returns the written thread, or null when the
 * thread does not exist.
 */
export function mutateThread(
  id: string,
  fn: (thread: MeetingThread) => void,
  home?: string,
): MeetingThread | null {
  const thread = readThread(id, home);
  if (!thread) return null;
  fn(thread);
  writeThread(thread, home);
  return thread;
}

/**
 * The roster: every registered vault that still exists on disk (has its
 * `_dream_context/`). No connection requirement — the room is a user→agents
 * channel and owning the launcher is the consent.
 */
export function meetingRoster(home?: string): Array<{ name: string; projectRoot: string }> {
  return listVaults(home)
    .filter((v) => existsSync(join(v.path, '_dream_context')))
    .map((v) => ({ name: v.name, projectRoot: v.path }));
}

export interface CreateThreadInput {
  /** The root announcement, raw — sanitized here. */
  body: string;
  /** Roster snapshot: name + identity glance per participant. */
  participants: Array<{ name: string; whatItIs: string }>;
}

/**
 * Open a new thread — THE invariant lives here. Any currently-active thread is
 * closed first, in the same synchronous pass, so there is no instant at which
 * two threads are active. Returns null when the announcement sanitizes to
 * nothing.
 */
export function createThread(
  input: CreateThreadInput,
  home?: string,
  now: Date = new Date(),
): MeetingThread | null {
  const body = sanitizeMeetingBody(input.body);
  if (!body) return null;

  // Close whatever is active — opening IS the archive action for its predecessor.
  const open = activeThread(home);
  if (open) {
    mutateThread(open.id, (t) => { t.closedAt = now.toISOString(); }, home);
  }

  const id = newId(now.getTime());
  const firstLine = body.split('\n', 1)[0].replace(/^#+\s*/, '').trim();
  const thread: MeetingThread = {
    version: MEETING_SCHEMA_VERSION,
    id,
    title: firstLine.length > TITLE_CHARS ? `${firstLine.slice(0, TITLE_CHARS - 1)}…` : firstLine,
    createdAt: now.toISOString(),
    closedAt: null,
    participants: input.participants.map((p) => ({
      name: p.name,
      whatItIs: p.whatItIs,
      state: 'idle' as const,
      runs: 0,
    })),
    messages: [
      {
        id: newId(now.getTime()),
        author: 'user',
        authorKind: 'user',
        body,
        createdAt: now.toISOString(),
        root: true,
      },
    ],
    mentionRuns: 0,
  };
  writeThread(thread, home);
  return thread;
}

/** Close the active thread (no-op when none). Returns the closed thread. */
export function closeActiveThread(home?: string, now: Date = new Date()): MeetingThread | null {
  const open = activeThread(home);
  if (!open) return null;
  return mutateThread(open.id, (t) => { t.closedAt = now.toISOString(); }, home);
}

/**
 * Append a message. Works on CLOSED threads on purpose: an in-flight run of an
 * archived thread finishes and lands its answer where the question was asked.
 * Returns the appended message, or null when the thread is missing or the body
 * sanitizes to nothing.
 */
export function appendMessage(
  threadId: string,
  msg: { author: string; authorKind: MeetingAuthorKind; body: string },
  home?: string,
  now: Date = new Date(),
): MeetingMessage | null {
  const body = sanitizeMeetingBody(msg.body);
  if (!body) return null;
  const message: MeetingMessage = {
    id: newId(now.getTime()),
    author: msg.author,
    authorKind: msg.authorKind,
    body,
    createdAt: now.toISOString(),
  };
  const written = mutateThread(threadId, (t) => { t.messages.push(message); }, home);
  return written ? message : null;
}

/** Flip one participant's run state (and error text). No-op on unknown names. */
export function setParticipantState(
  threadId: string,
  name: string,
  state: ParticipantRunState,
  error?: string,
  home?: string,
): void {
  mutateThread(threadId, (t) => {
    const p = t.participants.find((x) => x.name === name);
    if (!p) return;
    p.state = state;
    if (error !== undefined) p.error = error;
    else delete p.error;
  }, home);
}
