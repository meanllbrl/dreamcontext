import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { getAgent } from './store.js';
import { threadEntriesHere } from './agent-sync.js';
import { listSharedAgentSlugs } from '../automations/sharing.js';
import { listAutomations, readAutomationCache } from '../automations/store.js';
import { isThreadDayFile, parseDayFile, threadReadWatermark, threadSlugDir } from '../automations/threads.js';
import { FEED_UNREAD_DAYS, runUnread } from '../automations/feed.js';
import { privateSources } from '../automations/history.js';
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
 *    (`agent`) and the owner's words (`user`); `system` entries feed its status and `newestId`;
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
}

export interface HistorySession {
  key: string;
  kind: 'run' | 'talk';
  source: string;
  title: string;
  startedAt: string;
  lastAt: string;
  status: 'ok' | 'failed' | 'skipped' | 'running' | null;
  durationMs: number | null;
  newestId: string | null;
  unread: boolean;
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
  /** The server marks `hadTurns` the first time it finds a transcript; the CLI never writes. */
  markTurns?: boolean;
  maxSessions?: number;
  maxRows?: number;
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

/** Every entry of a source, by id, plus the ids inside the feed's unread window (the newest
 *  {@link FEED_UNREAD_DAYS} days of files, the feed's own I/O window). */
function readSource(contextRoot: string, source: string): { entries: ThreadEntry[]; windowIds: Set<string> } {
  let dir: string;
  try { dir = threadSlugDir(contextRoot, source); } catch { return { entries: [], windowIds: new Set() }; }
  let names: string[];
  try { names = readdirSync(dir).filter(isThreadDayFile).sort(); } catch { names = []; }
  const present = new Set(names.map((n) => join(dir, n)));
  // A day file retention deleted leaves the cache with its folder's listing.
  for (const p of [...dayCache.keys()]) if (p.startsWith(dir + sep) && !present.has(p)) dayCache.delete(p);
  const days = [...new Set(names.map((n) => n.slice(0, 10)))];
  const windowDays = new Set(days.slice(Math.max(0, days.length - FEED_UNREAD_DAYS)));
  const byId = new Map<string, ThreadEntry>();
  const windowIds = new Set<string>();
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
      if (!byId.has(e.id)) byId.set(e.id, e);
      if (inWindow) windowIds.add(e.id);
    }
  }
  const entries = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries, windowIds };
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

function runStatus(entries: readonly ThreadEntry[], run: RunEvent | null): HistorySession['status'] {
  for (const e of entries) if (e.kind === 'system' && e.event && TERMINAL[e.event]) return TERMINAL[e.event];
  if (run) {
    if (run.status === 'ok') return 'ok';
    if (run.status === 'failed' || run.status === 'timeout') return 'failed';
  }
  return entries.some((e) => e.kind === 'system' && e.event === 'started') ? 'running' : null;
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
    const { entries, windowIds } = readSource(contextRoot, source);
    if (entries.length === 0) continue;
    const here = opts.audience === 'agent' ? threadEntriesHere(contextRoot, source, home) : null;
    const watermark = threadReadWatermark(contextRoot, source, home);
    const cache = readAutomationCache(contextRoot, source);
    const runsByFire = new Map((cache?.history ?? []).map((r) => [r.firedAt, r]));
    const byRun = new Map<string, ThreadEntry[]>();
    for (const e of entries) {
      if (here && !here.has(e.id)) continue;
      const list = byRun.get(e.runId);
      if (list) list.push(e); else byRun.set(e.runId, [e]);
    }
    const title = titleOf(source);
    for (const [runId, runEntries] of byRun) {
      // Unread exactly as the feed counts it: the run's entries inside the feed's window.
      const windowed = runEntries.filter((e) => windowIds.has(e.id));
      const u = runUnread(windowed, watermark);
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
        build: () => ({
          key, kind: 'run', source, title,
          startedAt: runEntries[0].at,
          lastAt,
          status: runStatus(runEntries, run),
          durationMs: run?.durationMs ?? threadDuration(runEntries),
          newestId,
          unread,
          rows: posts.map((e) => ({
            id: e.id,
            kind: e.kind === 'user' ? 'user' as const : 'agent' as const,
            text: postText(e),
            at: e.at,
            ...(e.files?.length ? { files: e.files } : {}),
          })),
        }),
      });
    }
  }

  // Talks: this machine's index. Ordering needs no parse — start = index `at`, last = mtime.
  const sessions: AgentSessionEntry[] = listAgentSessions(projectRoot, slug, home);
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
  who: 'owner' | 'agent';
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
      hits.push({ key: s.key, kind: s.kind, title: s.title, at: r.at, who: r.kind === 'user' ? 'owner' : 'agent', text: r.text });
    }
    if (hits.length >= limit) {
      const more = candidates.slice(i + 1).some((d) => below(d, cur));
      return { hits: hits.slice(0, limit), nextBefore: more ? cursorOf(c) : null };
    }
  }
  return { hits, nextBefore: null };
}
