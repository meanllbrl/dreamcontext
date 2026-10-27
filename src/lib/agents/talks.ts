import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveAgentSession } from '../agent-session-map.js';
import { listAgentSessions, type AgentSessionEntry } from '../local-store.js';
import { isSafeSessionId } from '../transcript-locate.js';
import { parseTranscriptHistoryEx } from '../transcript-history.js';

/**
 * An agent's TALKS on this machine: the conversations the owner had with it (its stage, a Chat
 * tab's "Talk to it"), read from Claude's own transcripts. The history reader (`history.ts`), the
 * new session's briefing and `dreamcontext agents history` all read them through here.
 *
 * Costs are what this file is about. A talk's place in the history needs no parse (its start is
 * its index `at`, its last activity the transcript's mtime), and a transcript is found with ONE
 * listing of `~/.claude/projects` per lookup, each project folder re-listed only when its mtime
 * moved. Words are parsed only for the talks a page shows, cached by path + mtime + size.
 */

/** A talk longer than this returns its newest rows and `truncated` (the rest is one click away). */
export const TALK_MAX_ROWS = 400;
const ROWS_CACHE_MAX = 32;

/** Counters the tests read (cache hits are what the plan promises). */
export const talkStats = { projectListings: 0, talkParses: 0 };
export function resetTalkStats(): void {
  talkStats.projectListings = 0;
  talkStats.talkParses = 0;
}

/** project folder → its `.jsonl` names, re-listed when the folder's mtime moved. */
const dirCache = new Map<string, { mtimeMs: number; files: Set<string> }>();
/** `<resolved>|<id>` → the transcript last found for that pair. Kept while the file exists; a miss
 *  is never cached (the dir-mtime listing makes a fresh miss cheap, and only a fresh miss prunes). */
const pathCache = new Map<string, string>();
const rowsCache = new Map<string, { mtimeMs: number; size: number; rows: TalkRow[]; truncated: boolean }>();

export interface TalkRow {
  id: string;
  kind: 'user' | 'agent';
  text: string;
  at: string;
}

/** One request's transcript finder: lists `~/.claude/projects` at most once. */
export interface TalkLookup {
  find(id: string): string | null;
}

export function newTalkLookup(contextRoot: string | null, home: string = homedir()): TalkLookup {
  const base = join(home, '.claude', 'projects');
  let index: Map<string, string> | null = null;
  const listing = (): Map<string, string> => {
    if (index) return index;
    index = new Map();
    let dirs: string[] = [];
    try {
      if (existsSync(base)) {
        talkStats.projectListings++;
        dirs = readdirSync(base);
      }
    } catch { dirs = []; }
    const live = new Set<string>();
    for (const d of dirs) {
      const dir = join(base, d);
      live.add(dir);
      let mtimeMs: number;
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) continue;
        mtimeMs = st.mtimeMs;
      } catch { continue; }
      let hit = dirCache.get(dir);
      if (!hit || hit.mtimeMs !== mtimeMs) {
        let names: string[] = [];
        try { names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { names = []; }
        hit = { mtimeMs, files: new Set(names) };
        dirCache.set(dir, hit);
      }
      for (const n of hit.files) if (!index.has(n)) index.set(n, join(dir, n));
    }
    for (const dir of [...dirCache.keys()]) if (dirname(dir) === base && !live.has(dir)) dirCache.delete(dir);
    return index;
  };
  return {
    find(id: string): string | null {
      if (!isSafeSessionId(id)) return null;
      const resolved = contextRoot ? resolveAgentSession(contextRoot, id) : '';
      const pair = `${resolved}|${id}`;
      const cached = pathCache.get(pair);
      if (cached) {
        if (existsSync(cached)) return cached;
        pathCache.delete(pair);
      }
      const all = listing();
      for (const cand of [resolved, id]) {
        if (!cand || !isSafeSessionId(cand)) continue;
        const p = all.get(`${cand}.jsonl`);
        if (p && existsSync(p)) {
          if (pathCache.size > 2048) pathCache.clear();
          pathCache.set(pair, p);
          return p;
        }
      }
      return null;
    },
  };
}

/** A transcript's last activity, epoch ms, or null when it cannot be read. */
export function transcriptMtime(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/**
 * A talk's words: the owner's prompts and the agent's text replies, oldest first. Filtered before
 * the cap, so a tool-heavy talk still starts at its beginning; more than `max` ⇒ the newest `max`
 * and `truncated`. Cached by path + mtime + size (LRU).
 */
export function readTalkRows(
  path: string,
  sessionId: string,
  max: number = TALK_MAX_ROWS,
): { rows: TalkRow[]; truncated: boolean } {
  let st: { mtimeMs: number; size: number };
  try { st = statSync(path); } catch { return { rows: [], truncated: false }; }
  const key = `${path}\0${max}`;
  const hit = rowsCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    rowsCache.delete(key);
    rowsCache.set(key, hit);
    return { rows: hit.rows, truncated: hit.truncated };
  }
  let raw = '';
  try { raw = readFileSync(path, 'utf-8'); } catch { return { rows: [], truncated: false }; }
  talkStats.talkParses++;
  const { items, truncated } = parseTranscriptHistoryEx(raw, { kinds: ['user', 'text'], max });
  const fallbackAt = new Date(st.mtimeMs).toISOString();
  const rows: TalkRow[] = items.map((it, i) => ({
    id: `${sessionId}:${it.uuid ?? i}`,
    kind: it.kind === 'user' ? 'user' : 'agent',
    text: it.text ?? '',
    at: it.at ? new Date(it.at).toISOString() : fallbackAt,
  }));
  // Ids must be unique inside a talk: a uuid row and an index row can never collide, but two rows
  // of one assistant message share no uuid (text rows carry none), so the index disambiguates.
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    if (seen.has(r.id)) r.id = `${sessionId}:${i}`;
    seen.add(r.id);
  });
  rowsCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, rows, truncated });
  while (rowsCache.size > ROWS_CACHE_MAX) rowsCache.delete(rowsCache.keys().next().value as string);
  return { rows, truncated };
}

/** The raw transcript text, lowercased, for a search's cheap precheck. '' when unreadable. */
export function readTalkRawLower(path: string): string {
  try { return readFileSync(path, 'utf-8').toLowerCase(); } catch { return ''; }
}

/**
 * The words of this machine's talks with `agent` since `sinceMs`, for a new session's briefing.
 * Its own session is never included. Never throws.
 */
export function recentTalkRows(
  contextRoot: string,
  agent: string,
  opts: { sinceMs: number; excludeSession?: string | null; home?: string },
): (TalkRow & { session: string })[] {
  try {
    const projectRoot = dirname(contextRoot);
    const entries: AgentSessionEntry[] = listAgentSessions(projectRoot, agent, opts.home);
    if (entries.length === 0) return [];
    const lookup = newTalkLookup(contextRoot, opts.home ?? homedir());
    const out: (TalkRow & { session: string })[] = [];
    for (const e of entries) {
      if (opts.excludeSession && e.id === opts.excludeSession) continue;
      const path = lookup.find(e.id);
      if (!path) continue;
      const mtime = transcriptMtime(path);
      if (mtime === null || mtime < opts.sinceMs) continue;
      for (const r of readTalkRows(path, e.id).rows) {
        if (Date.parse(r.at) >= opts.sinceMs) out.push({ ...r, session: e.id });
      }
    }
    return out;
  } catch {
    return [];
  }
}
