import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { getAgent } from './store.js';
import { threadEntriesHere } from './agent-sync.js';
import { listSharedAgentSlugs } from '../automations/sharing.js';
import { getAutomation, listAutomations, readAutomationCache } from '../automations/store.js';
import { readMachineIdentity } from '../machine-id.js';
import { isThreadDayFile, parseDayFile, threadReadWatermark, threadSlugDir } from '../automations/threads.js';
import { feedCutoffDay, readRunHead, runDocumentPath, runUnread, toBrainRelative } from '../automations/feed.js';
import { pendingQuestionOfRun } from '../automations/hitl.js';
import { ownerQuietReader, superJobReader } from '../automations/super-quiet.js';
import { privateSources } from '../automations/history.js';
import { runChatSession } from '../automations/run-chat.js';
import type { RunEvent, ThreadEntry } from '../automations/types.js';
import {
  listAgentSessions, markSessionHadTurns, pruneAgentSessions, type AgentSessionEntry,
} from '../local-store.js';
import { newTalkLookup, readTalkRawLower, readTalkRows, TALK_MAX_ROWS, transcriptMtime } from './talks.js';

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
  rows: HistoryRow[];
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

/** Every entry of a source, by id, the ids inside the feed's unread window (the newest 14 calendar
 *  days, the feed's own window), and the day file each entry came from: its name says which
 *  machine wrote it, also for a shared routine whose threads sync with agent sync off. */
function readSource(contextRoot: string, source: string): { entries: ThreadEntry[]; windowIds: Set<string>; fileOf: Map<string, string> } {
  let dir: string;
  try { dir = threadSlugDir(contextRoot, source); } catch { return { entries: [], windowIds: new Set(), fileOf: new Map() }; }
  let names: string[];
  try { names = readdirSync(dir).filter(isThreadDayFile).sort(); } catch { names = []; }
  const present = new Set(names.map((n) => join(dir, n)));
  // A day file retention deleted leaves the cache with its folder's listing.
  for (const p of [...dayCache.keys()]) if (p.startsWith(dir + sep) && !present.has(p)) dayCache.delete(p);
  const days = [...new Set(names.map((n) => n.slice(0, 10)))];
  const cutoffDay = feedCutoffDay();
  const windowDays = new Set(days.filter((d) => d >= cutoffDay));
  const byId = new Map<string, ThreadEntry>();
  const windowIds = new Set<string>();
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
    const inWindow = windowDays.has(name.slice(0, 10));
    for (const e of hit.entries) {
      if (!byId.has(e.id)) { byId.set(e.id, e); fileOf.set(e.id, name); }
      if (inWindow) windowIds.add(e.id);
    }
  }
  const entries = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries, windowIds, fileOf };
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
  const nowMs = (opts.now ?? new Date()).getTime();
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
    const { entries, windowIds, fileOf } = readSource(contextRoot, source);
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
      // Unread exactly as the feed counts it: the run's entries inside the feed's window.
      const windowed = runEntries.filter((e) => windowIds.has(e.id));
      const u = runUnread(windowed, watermark, quietOf(source, runEntries));
      unreadCount += u.unreadPosts;
      let lastMs = -Infinity;
      let lastAt = runEntries[runEntries.length - 1].at;
      for (const e of runEntries) {
        const t = timeOf(e.at);
        if (t > lastMs) { lastMs = t; lastAt = e.at; }
      }
      const key = `${source}::${runId}`;
      const unread = u.unread;
      const newestId = windowed.length ? u.newestId : runUnread(runEntries, null).newestId;
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
