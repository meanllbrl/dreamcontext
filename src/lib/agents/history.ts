import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { getAgent } from './store.js';
import { threadEntriesHere } from './agent-sync.js';
import { listSharedAgentSlugs } from '../automations/sharing.js';
import { getAutomation, listAutomations, readAutomationCache } from '../automations/store.js';
import { readMachineIdentity } from '../machine-id.js';
import { isThreadDayFile, parseDayFile, threadDateStamp, threadReadWatermark, threadSlugDir } from '../automations/threads.js';
import {
  feedCutoffDay, openQuestionsByRun, readRunHead, runDocumentPath, runInUnreadWindow, runWindowUnread, toBrainRelative,
} from '../automations/feed.js';
import { pendingQuestionOfRun } from '../automations/hitl.js';
import { ownerQuietReader, superJobReader } from '../automations/super-quiet.js';
import { isAppRunSession, privateSources } from '../automations/history.js';
import { runChatSession } from '../automations/run-chat.js';
import { AGENT_CHAT_ENV, type RunEvent, type ThreadEntry } from '../automations/types.js';
import {
  listAgentSessions, markSessionHadTurns, pruneAgentSessions, type AgentSessionEntry,
} from '../local-store.js';
import { newTalkLookup, readTalkRawLower, readTalkRows, TALK_MAX_ROWS, transcriptMtime } from './talks.js';
import { request as httpRequest } from 'node:http';
import { projectKey } from '../local-store.js';
import { listTraceFiles, readTraceFile, workRoot, type WorkTrace } from './work-trace.js';
import { localIndex, WORK_SELECT_PATH, workServerPort } from './work-index.js';
import { RUN_APP_ENV } from './session-member.js';

/**
 * An agent's HISTORY: every run of its routines and every talk the owner had with it, as one list
 * of SESSIONS, newest activity first, paged. The AI Team pane draws it as one continuous flow; the
 * agent itself searches it (`dreamcontext agents history`).
 *
 * Every run and every talk stays its own Claude session. This module only READS them:
 *  - a RUN session = the thread entries of one `(source slug, runId)`; its rows are the posts
 *    (`agent`) and the owner's words (`user`); `system` entries feed its status and `newestId`.
 *    For the owner a run with no post has one row more, so no run reads as an empty "ran"
 *    (`bodyRow`);
 *  - a TALK session = one conversation in this machine's index (`agent-sessions.json`), its rows
 *    the user prompts and text replies of its transcript.
 *
 * Two AUDIENCES, one reader:
 *  - `owner` (the pane): the roster's sources (`agentConversationSlugs`, shared routines
 *    included), every machine's entries, this machine's talks;
 *  - `agent` (search and briefing): `privateSources` + this machine's entries only, exactly the
 *    rules of `buildRecentHistoryBlock`, plus this machine's talks.
 *
 * Ordering: a session's sort key is its LAST activity (`lastAt`), tie-broken by `key`; the cursor
 * `before=<lastAt>|<key>` is strict, so equal timestamps neither repeat nor drop a session.
 * Instants are compared numerically from the entries' own `at`, never from a file name.
 */

export type HistoryAudience = 'owner' | 'agent';

export interface HistoryRow {
  id: string;
  kind: 'user' | 'agent';
  text: string;
  at: string;
  files?: string[];
  /** An app's words: never read this row as the owner's. */
  via?: 'app';
  app?: string;
  /** A row no entry wrote, the body of a run that posted nothing: `answer` its result, `failure`
   *  why it ended, `note` what is known of it. */
  origin?: 'answer' | 'failure' | 'note';
}

export interface HistorySession {
  key: string;
  kind: 'run' | 'talk';
  source: string;
  title: string;
  startedAt: string;
  lastAt: string;
  status: 'ok' | 'failed' | 'skipped' | 'running' | 'waiting' | 'stopped' | null;
  durationMs: number | null;
  newestId: string | null;
  unread: boolean;
  /** A run with a published document here (`runDocumentPath`), posted or not. */
  hasDocument?: boolean;
  /** That document, as a tile: brain-relative path, name, and its opening sentence. */
  document?: { path: string; name: string; head?: string };
  /** The run's Claude session, from this machine's own records (`runChatSession`), never the
   *  synced cache. Owner audience only; absent when no steps can be opened here. */
  claudeId?: string;
  /** A reply can resume that session. */
  resumable?: true;
  /** The run started on another machine: nothing here can continue it. */
  elsewhere?: true;
  truncated?: true;
  missing?: true;
  /** A run's rating request facts (plan uye-karnesi W3 C9): present once it has a first terminal
   *  entry, whatever its live status (a reply turn in flight included). */
  request?: RequestFacts;
  rows: HistoryRow[];
}

/** W3 E1/E2: whether a run asks to be rated, and when its 72-hour window starts. Both come from the
 *  run's full thread; later turns never move them. */
export interface RequestFacts {
  eligible: boolean;
  /** The first terminal entry's time. */
  endedAt: string;
  /** The status that first terminal entry maps to (a rating's snapshot, never a live `running`). */
  status: NonNullable<HistorySession['status']>;
}

export interface HistoryPage {
  sessions: HistorySession[];
  nextBefore: string | null;
  unreadCount: number;
}

export interface ListHistoryOptions {
  audience: HistoryAudience;
  /** `<lastAt ISO>|<key>`: sessions strictly below it. */
  before?: string | null;
  /** A live session that is not history yet (the stage's own). */
  exclude?: string | null;
  home?: string;
  now?: Date;
  /** Is this conversation running right now? Given only by the server (the CLI cannot see live
   *  chats): only then is a turnless glance pruned. */
  isLive?: (id: string) => boolean;
  /** Is a socket holding it right now (a Chat tab in use)? Held talks wait until they end. */
  isHeld?: (id: string) => boolean;
  /** Is this run among the agent's turns in flight on this machine? Given only by the server: a
   *  run nothing holds can be said to have stopped only with this in hand. */
  isRunActive?: (source: string, runId: string) => boolean;
  /** Does a turn in flight name exactly this run? `isRunActive` also says yes for a turn that names
   *  no run yet; this one can speak for a finished run, whose resumed turn leaves no entry until
   *  it ends. */
  isRunHeld?: (source: string, runId: string) => boolean;
  /** The server marks `hadTurns` the first time it finds a transcript; the CLI never writes. */
  markTurns?: boolean;
  maxSessions?: number;
  maxRows?: number;
  /** Routine runs only (a member's Super page): no talks, and no job the main Super gave this
   *  member (its request and answer are already on that page, `super-quiet.ts`). */
  runsOnly?: boolean;
}

export const HISTORY_PAGE_SESSIONS = 8;
export const HISTORY_PAGE_ROWS = 300;

/** Counters the tests read. */
export const historyStats = { dayParses: 0 };
export function resetHistoryStats(): void { historyStats.dayParses = 0; }

// ─── Sources ────────────────────────────────────────────────────────────────────────

/** The thread slugs whose messages are this agent's conversation — the roster's own rule
 *  (`conversationSlugs` in the dashboard's teamModel): its call target and every automation that
 *  runs as it, call-mode and shared ones included. */
export function agentConversationSlugs(contextRoot: string, slug: string): string[] {
  const out = new Set([slug]);
  let manifests: { slug: string; agent?: string | null }[] = [];
  try { manifests = listAutomations(contextRoot); } catch { manifests = []; }
  for (const m of manifests) if ((m.agent ?? m.slug) === slug) out.add(m.slug);
  return [...out];
}

function sourcesFor(contextRoot: string, slug: string, audience: HistoryAudience): string[] {
  if (audience === 'owner') return agentConversationSlugs(contextRoot, slug);
  const agent = getAgent(contextRoot, slug);
  if (!agent || agent.shared || listSharedAgentSlugs(contextRoot).includes(slug)) return [];
  return privateSources(contextRoot, slug);
}

// ─── Day files, parsed once per change ──────────────────────────────────────────────

const dayCache = new Map<string, { mtimeMs: number; size: number; entries: ThreadEntry[] }>();

/** Every entry of a source, by id, and the day file each entry came from: its name says which
 *  machine wrote it, also for a shared routine whose threads sync with agent sync off. Which runs
 *  count as unread is `runInUnreadWindow`'s word, the feed's own rule, never a day file's. */
function readSource(contextRoot: string, source: string, fromDay?: string): { entries: ThreadEntry[]; fileOf: Map<string, string> } {
  let dir: string;
  try { dir = threadSlugDir(contextRoot, source); } catch { return { entries: [], fileOf: new Map() }; }
  let all: string[];
  try { all = readdirSync(dir).filter(isThreadDayFile).sort(); } catch { all = []; }
  const present = new Set(all.map((n) => join(dir, n)));
  // A run-scoped read (W3 C9): day files from `fromDay` on (names open with their local date).
  const names = fromDay ? all.filter((n) => n.slice(0, 10) >= fromDay) : all;
  // A day file retention deleted leaves the cache with its folder's listing.
  for (const p of [...dayCache.keys()]) if (p.startsWith(dir + sep) && !present.has(p)) dayCache.delete(p);
  const byId = new Map<string, ThreadEntry>();
  const fileOf = new Map<string, string>();
  for (const name of names) {
    const path = join(dir, name);
    let st: { mtimeMs: number; size: number };
    // stat BEFORE read: a file growing during the read is re-parsed next time.
    try { st = statSync(path); } catch { continue; }
    let hit = dayCache.get(path);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      let raw = '';
      try { raw = readFileSync(path, 'utf-8'); } catch { continue; }
      historyStats.dayParses++;
      hit = { mtimeMs: st.mtimeMs, size: st.size, entries: parseDayFile(raw) };
      dayCache.set(path, hit);
    }
    for (const e of hit.entries) {
      if (!byId.has(e.id)) { byId.set(e.id, e); fileOf.set(e.id, name); }
    }
  }
  const entries = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries, fileOf };
}

// ─── Candidates ─────────────────────────────────────────────────────────────────────

interface Candidate {
  key: string;
  lastMs: number;
  lastAt: string;
  build: () => HistorySession | null;
  /** The text a search matches against without building rows. */
  rawLower?: () => string;
}

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

const TERMINAL: Record<string, HistorySession['status']> = {
  ok: 'ok', replied: 'ok', failed: 'failed', timeout: 'failed', skipped: 'skipped',
};

/** How long past its own timeout a run started on another machine still reads as running. */
const ELSEWHERE_GRACE_MS = 10 * 60_000;

/** What a run with no terminal fact can be known to be, beyond its own thread. */
interface RunFacts {
  source: string;
  runId: string;
  contextRoot: string;
  isRunActive?: ListHistoryOptions['isRunActive'];
  isRunHeld?: ListHistoryOptions['isRunHeld'];
  /** The day file an entry came from. */
  fileOf: ReadonlyMap<string, string>;
  home: string;
  nowMs: number;
}

const terminalOf = (entries: readonly ThreadEntry[]): ThreadEntry | undefined =>
  entries.find((e) => e.kind === 'system' && e.event && TERMINAL[e.event]);

/** The file's name, never the ledger: with agent sync off the ledger answers "every entry is
 *  mine", and a shared routine's thread still arrives from the other machine mid-run. */
function writtenElsewhere(entry: ThreadEntry, fileOf: ReadonlyMap<string, string>, home: string): boolean {
  const file = fileOf.get(entry.id) ?? '';
  return /-[0-9a-f]{12}\.md$/.test(file) && !file.endsWith(`-${readMachineIdentity(home).id}.md`);
}

// ─── Rating requests (plan uye-karnesi W3, C9) ──────────────────────────────────────

/** A system line task delivery writes (`fanOutDelivered`): only system entries and no `started`.
 *  Never rateable, never a request. */
export function isDeliveryNoteEntries(entries: readonly ThreadEntry[]): boolean {
  return entries.length > 0 && entries.every((e) => e.kind === 'system') && !entries.some((e) => e.event === 'started');
}

/** The day a run-scoped read starts: one local day before the run id's own (day files are named by
 *  local date, run ids are UTC). Null when the run id is no time: read every file. */
export function runReadFromDay(runId: string): string | null {
  const t = Date.parse(runId);
  return Number.isFinite(t) ? threadDateStamp(new Date(t - 86_400_000)) : null;
}

/** Is `source` a member's conversation (the member itself, or a routine with a member)? A routine
 *  with no member (super-rutin) never asks. */
function isMemberSource(contextRoot: string, source: string): boolean {
  try { if (getAgent(contextRoot, source)) return true; } catch { /* not an agent */ }
  // A routine's `agent` must BE a member: a Super automation (`target: super`) composes with its own
  // slug as its agent, and `getAgent` refuses that slug.
  try {
    const agent = getAutomation(contextRoot, source)?.agent;
    return !!agent && !!getAgent(contextRoot, agent);
  } catch { return false; }
}

/** E1 + E2 from one run's full thread. Null when the run has no terminal entry yet. */
function requestFactsOf(
  contextRoot: string, source: string, run: readonly ThreadEntry[], fileOf: ReadonlyMap<string, string>, home: string,
  isSuperJob: (source: string, run: readonly ThreadEntry[]) => boolean,
): RequestFacts | null {
  const end = terminalOf(run);
  if (!end) return null;
  const started = run.find((e) => e.kind === 'system' && e.event === 'started');
  const eligible = end.event === 'ok'
    && !!started
    && !isDeliveryNoteEntries(run)
    && !writtenElsewhere(started, fileOf, home)
    && !writtenElsewhere(end, fileOf, home)
    && isMemberSource(contextRoot, source)
    && !isSuperJob(source, run);
  return { eligible, endedAt: end.at, status: TERMINAL[end.event!] ?? 'ok' };
}

/** One run's request facts, read from its own thread (from a day before the run id's day). */
export function requestFacts(contextRoot: string, source: string, runId: string, home: string = homedir()): RequestFacts | null {
  const { entries, fileOf } = readSource(contextRoot, source, runReadFromDay(runId) ?? undefined);
  const run = entries.filter((e) => e.runId === runId);
  if (run.length === 0) return null;
  return requestFactsOf(contextRoot, source, run, fileOf, home, superJobReader(contextRoot));
}

/**
 * A job the main Super handed this member (W3 E9, C16), read from its own run: the Super's ask
 * opened it (`superJobReader`) and its first terminal entry is the raw `ok`. Its title is the ask's
 * first line. Null for anything else (a failed Super job is not one: D2 rates it from history).
 */
export function superJobSession(contextRoot: string, member: string, sessionKey: string, home: string = homedir()): HistorySession | null {
  const at = sessionKey.indexOf('::');
  if (at <= 0) return null;
  const source = sessionKey.slice(0, at);
  const runId = sessionKey.slice(at + 2);
  if (source !== member) return null;
  const { entries, fileOf } = readSource(contextRoot, source, runReadFromDay(runId) ?? undefined);
  const run = entries.filter((e) => e.runId === runId);
  if (run.length === 0) return null;
  const isSuperJob = superJobReader(contextRoot);
  if (!isSuperJob(source, run)) return null;
  const end = terminalOf(run);
  // Still going: found, not yet rateable (`run_not_rateable`).
  if (end && end.event !== 'ok') return null;
  const ask = run.find((e) => e.kind === 'user');
  const title = (ask?.text ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200) || source;
  const request = requestFactsOf(contextRoot, source, run, fileOf, home, isSuperJob);
  return {
    key: sessionKey, kind: 'run', source, title,
    startedAt: run[0].at, lastAt: run[run.length - 1].at, status: end ? 'ok' : 'running',
    durationMs: threadDuration(run), hasDocument: false, newestId: run[run.length - 1].id, unread: false,
    ...(request ? { request } : {}),
    rows: [],
  };
}

/** Every run of this member whose run id (its fire time) falls in the last `days`, with its facts:
 *  each one's whole thread is read, so an old run with a fresh reply is never a candidate. */
export function recentRunFacts(
  contextRoot: string, member: string, nowMs: number, days: number, home: string = homedir(),
): Array<{ key: string; source: string; runId: string; facts: RequestFacts }> {
  const out: Array<{ key: string; source: string; runId: string; facts: RequestFacts }> = [];
  const isSuperJob = superJobReader(contextRoot);
  const fromMs = nowMs - days * 86_400_000;
  const fromDay = threadDateStamp(new Date(fromMs - 86_400_000));
  for (const source of agentConversationSlugs(contextRoot, member)) {
    const { entries, fileOf } = readSource(contextRoot, source, fromDay);
    const byRun = new Map<string, ThreadEntry[]>();
    for (const e of entries) {
      const t = Date.parse(e.runId);
      if (!Number.isFinite(t) || t < fromMs) continue;
      const list = byRun.get(e.runId);
      if (list) list.push(e); else byRun.set(e.runId, [e]);
    }
    for (const [runId, run] of byRun) {
      const facts = requestFactsOf(contextRoot, source, run, fileOf, home, isSuperJob);
      if (facts) out.push({ key: `${source}::${runId}`, source, runId, facts });
    }
  }
  return out;
}

function runStatus(entries: readonly ThreadEntry[], run: RunEvent | null, f: RunFacts): HistorySession['status'] {
  const end = terminalOf(entries);
  const ended = end ? TERMINAL[end.event!]
    : run?.status === 'ok' ? 'ok'
      : run?.status === 'failed' || run?.status === 'timeout' ? 'failed'
        : null;
  // A turn after the end (a reply, an answered question) that has not closed: while something
  // holds it, the run works. Never on the activity alone: it can hold a turn with no run id yet,
  // and every finished run would read as working.
  const later = end ? entries.filter((e) => e.id > end.id && (e.kind === 'user' || (e.kind === 'system' && e.event && TERMINAL[e.event]))).pop() : undefined;
  const reopened = later?.kind === 'user';
  if ((reopened && f.isRunActive?.(f.source, f.runId)) || (ended && f.isRunHeld?.(f.source, f.runId))) return 'running';
  if (ended && ended !== 'ok') return ended;
  // An `asked` entry alone says nothing: question records get pruned, the record is the fact. Above
  // a clean end: `review: agent` and `automations propose` finish `ok` and still wait on the owner.
  try {
    if (pendingQuestionOfRun(f.contextRoot, f.source, f.runId)) return 'waiting';
  } catch {
    // an unreadable question store costs this word, never the page
  }
  if (ended === 'ok') return 'ok';
  const started = entries.find((e) => e.kind === 'system' && e.event === 'started');
  if (!f.isRunActive) return started ? 'running' : null;
  if (f.isRunActive(f.source, f.runId)) return 'running';
  if (!started) return null;
  // The record of a question is gone: we do not know how it ended, so we do not say.
  if (entries.some((e) => e.kind === 'system' && e.event === 'asked')) return null;
  if (!writtenElsewhere(started, f.fileOf, f.home)) return 'stopped';
  // Another machine's run: only its own timeout can end the wait from here.
  let timeoutMinutes = 30;
  try { timeoutMinutes = getAutomation(f.contextRoot, f.source)?.timeoutMinutes ?? 30; } catch { /* the default */ }
  return f.nowMs - timeOf(started.at) < timeoutMinutes * 60_000 + ELSEWHERE_GRACE_MS ? 'running' : null;
}

/**
 * THE TOTAL RULE: the one row a run with no post gets, for the owner, so a run that happened never
 * reads as an empty "ran". Null only for a run with no system entry at all, which then has its
 * owner's words and nothing else that is known. The words a status names are the server's fallback;
 * the pane draws its own language over `note` rows of a run with that status.
 */
function bodyRow(
  contextRoot: string,
  entries: readonly ThreadEntry[],
  run: RunEvent | null,
  status: HistorySession['status'],
  lastAt: string,
): HistoryRow | null {
  const end = terminalOf(entries);
  const newest = [...entries].reverse().find((e) => e.kind === 'system');
  const row = (origin: NonNullable<HistoryRow['origin']>, text: string | null | undefined): HistoryRow | null =>
    (text ? { id: `body:${origin}`, kind: 'agent', text, at: end?.at ?? lastAt, origin } : null);
  const answer = (): string | null => end?.result ?? readRunHead(contextRoot, run);
  // A live turn on a finished run: what the run itself said stays its body.
  switch (status === 'running' && end ? TERMINAL[end.event!] : status) {
    case 'failed':
      return row('failure', end?.text || run?.error || newest?.text || 'The run failed and gave no reason.');
    case 'ok': return row('answer', answer()) ?? row('note', end?.text || newest?.text || 'Finished.');
    case 'skipped': return row('note', end?.text || newest?.text);
    // What the owner must judge stays on screen; the boundary says it waits.
    case 'waiting': return row('answer', answer()) ?? row('note', 'Waiting for your answer');
    case 'stopped': return row('note', 'Stopped, no result');
    case 'running': return row('note', 'Working');
    default: return row('note', newest?.text);
  }
}

/** A run's duration from its own thread (started → its terminal entry), when the run cache — the
 *  usual source — has no row for it (another machine's run, a pruned cache). */
function threadDuration(entries: readonly ThreadEntry[]): number | null {
  const started = entries.find((e) => e.kind === 'system' && e.event === 'started');
  const end = entries.find((e) => e.kind === 'system' && e.event && TERMINAL[e.event]);
  if (!started || !end) return null;
  const ms = timeOf(end.at) - timeOf(started.at);
  return ms > 0 ? ms : null;
}

function postText(e: ThreadEntry): string {
  const rows = e.summary?.map((r) => `- **${r.key}:** ${r.value}`).join('\n') ?? '';
  return [e.text, rows].filter((s) => s && s.trim()).join('\n\n');
}

interface Collected {
  candidates: Candidate[];
  unreadCount: number;
}

function collect(contextRoot: string, slug: string, opts: ListHistoryOptions): Collected {
  const home = opts.home ?? homedir();
  const projectRoot = dirname(contextRoot);
  const candidates: Candidate[] = [];
  let unreadCount = 0;
  const quietOf = ownerQuietReader(contextRoot);
  const isSuperJob = opts.runsOnly ? superJobReader(contextRoot) : null;
  const superJobOf = isSuperJob ?? superJobReader(contextRoot);
  const nowMs = (opts.now ?? new Date()).getTime();
  const cutoffDay = feedCutoffDay(opts.now);
  const openRuns = openQuestionsByRun(contextRoot);
  const agentTitle = (() => {
    try {
      const a = getAgent(contextRoot, slug);
      return a?.title || slug;
    } catch { return slug; }
  })();
  let manifests: { slug: string; title: string }[] = [];
  try { manifests = listAutomations(contextRoot); } catch { manifests = []; }
  const titleOf = (s: string): string => (s === slug ? agentTitle : manifests.find((m) => m.slug === s)?.title ?? s);

  for (const source of sourcesFor(contextRoot, slug, opts.audience)) {
    const { entries, fileOf } = readSource(contextRoot, source);
    if (entries.length === 0) continue;
    const here = opts.audience === 'agent' ? threadEntriesHere(contextRoot, source, home) : null;
    const watermark = threadReadWatermark(contextRoot, source, home);
    const cache = readAutomationCache(contextRoot, source);
    // Newest row per fire: the history is newest first, and a fire can hold two rows (a first
    // refusal, then the run itself).
    const runsByFire = new Map([...(cache?.history ?? [])].reverse().map((r) => [r.firedAt, r]));
    const byRun = new Map<string, ThreadEntry[]>();
    for (const e of entries) {
      if (here && !here.has(e.id)) continue;
      const list = byRun.get(e.runId);
      if (list) list.push(e); else byRun.set(e.runId, [e]);
    }
    const title = titleOf(source);
    for (const [runId, runEntries] of byRun) {
      if (isSuperJob?.(source, runEntries)) continue;
      // Unread exactly as the feed counts it: one window rule, anchored on the run's last activity.
      const inWindow = runInUnreadWindow(runEntries, cutoffDay, openRuns.has(`${source}::${runId}`));
      const u = runWindowUnread(runEntries, watermark, inWindow, quietOf(source, runEntries));
      unreadCount += u.unreadPosts;
      let lastMs = -Infinity;
      let lastAt = runEntries[runEntries.length - 1].at;
      for (const e of runEntries) {
        const t = timeOf(e.at);
        if (t > lastMs) { lastMs = t; lastAt = e.at; }
      }
      const key = `${source}::${runId}`;
      const unread = u.unread;
      const newestId = u.newestId;
      const run = runsByFire.get(runId) ?? null;
      const posts = runEntries.filter((e) => e.kind === 'user' || e.kind === 'agent');
      candidates.push({
        key, lastMs, lastAt,
        rawLower: () => posts.map((e) => postText(e)).join('\n').toLowerCase(),
        build: () => {
          const status = runStatus(runEntries, run, { source, runId, contextRoot, isRunActive: opts.isRunActive, isRunHeld: opts.isRunHeld, fileOf, home, nowMs });
          const rows: HistoryRow[] = posts.map((e) => ({
            id: e.id,
            kind: e.kind === 'user' ? 'user' as const : 'agent' as const,
            text: postText(e),
            at: e.at,
            ...(e.files?.length ? { files: e.files } : {}),
            ...(e.via === 'app' ? { via: 'app' as const, ...(e.app ? { app: e.app } : {}) } : {}),
          }));
          // Only what it said before it ended counts: an answer to a later reply is not the run's own
          // result, and the run's sentence stays above that reply.
          const end = terminalOf(runEntries);
          if (opts.audience === 'owner' && !posts.some((e) => e.kind === 'agent' && (!end || e.id < end.id))) {
            const body = bodyRow(contextRoot, runEntries, run, status, lastAt);
            // In its place: the owner's later words are not answered by what the run said before.
            const after = end ? posts.findIndex((e) => e.id > end.id) : -1;
            if (body) rows.splice(after < 0 ? rows.length : after, 0, body);
          }
          const chat = opts.audience === 'owner' ? runChatSession(contextRoot, source, runId, home) : null;
          const docPath = runDocumentPath(contextRoot, run);
          const docHead = docPath ? readRunHead(contextRoot, run) : null;
          const first = runEntries.find((e) => e.kind === 'system' && e.event === 'started') ?? runEntries[0];
          const request = requestFactsOf(contextRoot, source, runEntries, fileOf, home, superJobOf);
          return {
            key, kind: 'run', source, title,
            startedAt: runEntries[0].at,
            lastAt,
            status,
            durationMs: run?.durationMs ?? threadDuration(runEntries),
            newestId,
            unread,
            hasDocument: docPath !== null,
            ...(docPath ? { document: { path: toBrainRelative(contextRoot, docPath), name: basename(docPath), ...(docHead ? { head: docHead } : {}) } } : {}),
            ...(chat ? { claudeId: chat.claudeId, ...(chat.resumable ? { resumable: true as const } : {}) } : {}),
            ...(opts.audience === 'owner' && writtenElsewhere(first, fileOf, home) ? { elsewhere: true as const } : {}),
            ...(request ? { request } : {}),
            rows,
          };
        },
      });
    }
  }

  // Talks: this machine's index. Ordering needs no parse — start = index `at`, last = mtime.
  const sessions: AgentSessionEntry[] = opts.runsOnly ? [] : listAgentSessions(projectRoot, slug, home);
  if (sessions.length) {
    const lookup = newTalkLookup(contextRoot, home);
    const found: string[] = [];
    const glances: string[] = [];
    for (const s of sessions) {
      if (opts.exclude && s.id === opts.exclude) continue;
      if (opts.isHeld?.(s.id)) continue;
      const path = lookup.find(s.id);
      const key = `talk::${s.id}`;
      if (!path) {
        if (s.hadTurns) {
          const at = s.at;
          candidates.push({
            key, lastMs: timeOf(at), lastAt: at,
            build: () => ({
              key, kind: 'talk', source: slug, title: agentTitle, startedAt: at, lastAt: at,
              status: null, durationMs: null, newestId: null, unread: false, missing: true, rows: [],
            }),
          });
        } else if (opts.isLive && !opts.isLive(s.id)) {
          glances.push(s.id);
        }
        continue;
      }
      if (!s.hadTurns) found.push(s.id);
      const mtime = transcriptMtime(path);
      // Whole milliseconds: the cursor is an ISO string, and a fractional mtime would sort a hair
      // above the cursor it produced.
      const lastMs = mtime !== null ? Math.floor(mtime) : timeOf(s.at);
      const lastAt = new Date(lastMs).toISOString();
      const id = s.id;
      const startedAt = s.at;
      candidates.push({
        key, lastMs, lastAt,
        rawLower: () => readTalkRawLower(path),
        build: () => {
          const { rows, truncated } = readTalkRows(path, id, TALK_MAX_ROWS);
          // A talk with no words (opened, a slash command, nothing said) is no history.
          if (rows.length === 0) return null;
          return {
            key, kind: 'talk', source: slug, title: agentTitle, startedAt, lastAt,
            status: null, durationMs: null, newestId: null, unread: false,
            ...(truncated ? { truncated: true as const } : {}),
            rows: rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, at: r.at })),
          };
        },
      });
    }
    try {
      if (opts.markTurns && found.length) markSessionHadTurns(projectRoot, slug, found, home);
      if (opts.markTurns && glances.length) pruneAgentSessions(projectRoot, slug, glances, home);
    } catch {
      // the index is best effort: a busy lock costs a re-probe next time, never the page
    }
  }

  candidates.sort((a, b) => (b.lastMs - a.lastMs) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return { candidates, unreadCount };
}

/**
 * When this machine last really talked with `slug` in this project, from the session index and
 * its transcripts, or null. Lasting where the feed is a window (and absent on the phone); a
 * session opened and left without a word has no transcript and does not count.
 */
export function lastTalkAt(contextRoot: string, slug: string, home?: string): string | null {
  const sessions = listAgentSessions(dirname(contextRoot), slug, home);
  if (sessions.length === 0) return null;
  const lookup = newTalkLookup(contextRoot, home);
  let newest = 0;
  for (const s of sessions) {
    const path = lookup.find(s.id);
    if (!path && !s.hadTurns) continue;
    newest = Math.max(newest, (path ? transcriptMtime(path) : null) ?? timeOf(s.at));
  }
  return newest > 0 ? new Date(Math.floor(newest)).toISOString() : null;
}

/** `<lastAt ISO>|<key>` → its parts, or null when malformed. */
export function parseHistoryCursor(raw: string | null | undefined): { ms: number; key: string } | null {
  if (!raw) return null;
  const bar = raw.indexOf('|');
  if (bar <= 0) return null;
  const ms = Date.parse(raw.slice(0, bar));
  const key = raw.slice(bar + 1);
  return Number.isFinite(ms) && key ? { ms, key } : null;
}

const cursorOf = (c: Candidate): string => `${new Date(c.lastMs).toISOString()}|${c.key}`;

function below(c: Candidate, cur: { ms: number; key: string } | null): boolean {
  if (!cur) return true;
  return c.lastMs < cur.ms || (c.lastMs === cur.ms && c.key < cur.key);
}

/** One page of an agent's history. Never throws past a malformed agent (the caller 404s). */
export function listAgentHistory(contextRoot: string, slug: string, opts: ListHistoryOptions): HistoryPage {
  const { candidates, unreadCount } = collect(contextRoot, slug, opts);
  const cur = parseHistoryCursor(opts.before);
  const maxSessions = opts.maxSessions ?? HISTORY_PAGE_SESSIONS;
  const maxRows = opts.maxRows ?? HISTORY_PAGE_ROWS;
  const sessions: HistorySession[] = [];
  let rows = 0;
  let last: Candidate | null = null;
  let more = false;
  for (const c of candidates) {
    if (!below(c, cur)) continue;
    if (sessions.length >= maxSessions || rows >= maxRows) { more = true; break; }
    last = c;
    const s = c.build();
    if (!s) continue;
    sessions.push(s);
    rows += s.rows.length;
  }
  return { sessions, nextBefore: more && last ? cursorOf(last) : null, unreadCount };
}

export interface HistoryHit {
  key: string;
  kind: 'run' | 'talk';
  title: string;
  at: string;
  who: 'owner' | 'app' | 'agent';
  text: string;
}

/**
 * Search an agent's history for `query` (case-insensitive substring), newest session first, at most
 * `limit` hits (50). A transcript's raw text is checked for the term before it is parsed.
 * `nextBefore` continues a search the limit cut.
 */
export function searchAgentHistory(
  contextRoot: string,
  slug: string,
  query: string,
  opts: Omit<ListHistoryOptions, 'maxSessions' | 'maxRows'> & { limit?: number },
): { hits: HistoryHit[]; nextBefore: string | null } {
  const q = query.trim().toLowerCase();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 50));
  const { candidates } = collect(contextRoot, slug, opts);
  const cur = parseHistoryCursor(opts.before);
  const hits: HistoryHit[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!below(c, cur)) continue;
    if (q && c.rawLower && !c.rawLower().includes(q)) continue;
    const s = c.build();
    if (!s) continue;
    for (const r of [...s.rows].reverse()) {
      if (q && !r.text.toLowerCase().includes(q)) continue;
      hits.push({ key: s.key, kind: s.kind, title: s.title, at: r.at, who: r.kind === 'user' ? (r.via === 'app' ? 'app' : 'owner') : 'agent', text: r.text });
    }
    if (hits.length >= limit) {
      const more = candidates.slice(i + 1).some((d) => below(d, cur));
      return { hits: hits.slice(0, limit), nextBefore: more ? cursorOf(c) : null };
    }
  }
  return { hits, nextBefore: null };
}


// ─── Past work (plan uye-gecmis-is D12) ─────────────────────────────────

export interface TraceHit { id: string; line: string; at: number; projectKey: string }

/**
 * A member's past-work traces matching `query`, best first: through the running app's warm index,
 * else by reading the files here (slower, never wrong). `all`: every project for a global member.
 */
/**
 * Who reads a member's past work from this process (G2): an app's chat (`app-<slug>`) or an app's
 * run (the runner's RUN_APP_ENV on the live child; a finished run's session as a fallback, its app
 * unknown, so it sees nothing) reads as that app; anyone else is the owner (null). The ONE reading
 * for `history --search`, `history show` and the `--all` refusal.
 */
export function pastWorkViewer(contextRoot: string, env: NodeJS.ProcessEnv = process.env): { app: string | null } | null {
  const chat = env[AGENT_CHAT_ENV] ?? '';
  if (chat.startsWith('app-')) return { app: chat.length > 4 ? chat.slice(4) : null };
  const runApp = (env[RUN_APP_ENV] ?? '').trim();
  if (runApp) return { app: runApp };
  const sid = env.CLAUDE_CODE_SESSION_ID ?? env.CLAUDE_SESSION_ID ?? '';
  try { if (sid && isAppRunSession(contextRoot, sid)) return { app: null }; } catch { /* no cache */ }
  return null;
}

export async function searchPastWork(
  contextRoot: string,
  slug: string,
  query: string,
  /** `viewer`: an app's session (only that app's runs here, never `all`). */
  opts: { all?: boolean; home?: string; viaServer?: boolean; viewer?: { app: string | null } | null } = {},
): Promise<TraceHit[]> {
  const projectRoot = dirname(contextRoot);
  if (!query.trim()) return [];
  const viewer = opts.viewer ?? null;
  const all = opts.all === true && !viewer;
  if (opts.viaServer !== false) {
    const remote = await searchViaServer(slug, projectRoot, query, all, viewer, workServerPort(process.env, opts.home ?? homedir()));
    if (remote) return remote;
  }
  const local = localIndex(slug, projectRoot, opts.home ?? homedir());
  if (!local) return [];
  return local.idx.allMatches(query, { projectKey: projectKey(projectRoot), scope: local.scope }, all, viewer);
}

function searchViaServer(member: string, root: string, query: string, all: boolean, viewer: { app: string | null } | null, port: number): Promise<TraceHit[] | null> {
  const payload = JSON.stringify({ member, root, query, audience: viewer ? 'app' : 'owner', ...(viewer?.app ? { app: viewer.app } : {}), mode: 'search', all });
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: TraceHit[] | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { req.destroy(); done(null); }, 10_000);
    const req = httpRequest({ host: '127.0.0.1', port, path: WORK_SELECT_PATH, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return done(null);
        try {
          const p = JSON.parse(data) as { hits?: unknown };
          done(Array.isArray(p.hits) ? (p.hits as TraceHit[]).filter((h) => typeof h?.id === 'string' && typeof h?.line === 'string') : null);
        } catch { done(null); }
      });
      res.on('error', () => done(null));
    });
    req.on('error', () => done(null));
    req.end(payload);
  });
}

/** One whole trace by its id or its `w_<id8>` handle, among this project's members (and global ones). */
export function findTrace(contextRoot: string, handle: string, members: readonly string[], home?: string, viewer: { app: string | null } | null = null): WorkTrace | null {
  const want = handle.replace(/^w_/, '').toLowerCase();
  if (!/^[0-9a-f]{8,32}$/.test(want)) return null;
  const projectRoot = dirname(contextRoot);
  // An app sees only its own runs of this project (the same rule as its search).
  const here = projectKey(projectRoot);
  const visible = (t: WorkTrace) => !viewer || (t.kind === 'run' && !!viewer.app && t.app === viewer.app && t.project.key === here);
  for (const slug of members) {
    const root = workRoot(slug, projectRoot, home ?? homedir());
    if (!root) continue;
    for (const f of listTraceFiles(root)) {
      if (!f.name.startsWith(want)) continue;
      const t = readTraceFile(root, join(root, f.month, f.name));
      if (t && visible(t)) return t;
    }
  }
  return null;
}
