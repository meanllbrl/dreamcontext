/**
 * transcript-sessions — the PAST Claude conversations of one project, as a
 * searchable, resumable index.
 *
 * Claude Code files every conversation it has ever had in a project under
 * `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, and never deletes them. That
 * directory IS the chat history — the app just had no way to read it as a list, so a
 * conversation you closed was gone unless you had kept its tab.
 *
 * The hard constraint this module exists to respect: those files are BIG. This repo's
 * own project dir is ~1 GB across ~400 transcripts, several of them 10–18 MB. Reading
 * them to build a list would take seconds and hundreds of MB of RSS every time a popup
 * opened. So:
 *
 *   • Never read a whole transcript. Each file contributes a bounded HEAD read (where the
 *     first prompt — the session's title — lives) and, only if it is bigger than that, a
 *     bounded TAIL read (where the most recent prompt lives). ~192 KB per file, worst case.
 *   • Memoize by (path, mtimeMs, size). A transcript is append-only, so an unchanged
 *     mtime+size means an unchanged summary — after the first listing, only the handful of
 *     sessions that actually ran again pay for a re-read.
 *   • Search runs over a per-session haystack built during that same read (title + every
 *     prompt found in the head + the last prompt) — so a query costs no I/O at all once
 *     the index is warm.
 *
 * Truncated edge lines (a head/tail cut lands mid-line, and mid-UTF-8) simply fail to
 * parse and are skipped, which is the same tolerance the whole transcript layer already
 * has: these files are written by a DIFFERENT program than ours, so unknown or unreadable
 * shapes are the norm, never an error.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { userPromptOf } from './transcript-history.js';

/** One past conversation, as the history picker shows it. */
export interface PastSession {
  /** The conversation UUID — what `claude --resume <id>` takes. */
  id: string;
  /** First thing the user said, one-lined. Never empty (such a file is skipped). */
  title: string;
  /** Most recent thing the user said, one-lined. '' when it would just repeat the title. */
  preview: string;
  /** Last write to the transcript (ms epoch) — "when did I last talk to this session". */
  updatedAt: number;
  /** First user entry's timestamp (ms epoch), null when the log carried none. */
  startedAt: number | null;
  sizeBytes: number;
  /** Branch the session was working on, '' when the log carried none. */
  gitBranch: string;
  /** This conversation was opened BY a machine, not typed into by a person — see
   *  {@link isAgentRun}. Hidden from the picker unless it is deliberately asked for. */
  agentRun: boolean;
}

/** A {@link PastSession} plus the lowercased search haystack, which stays server-side —
 *  shipping every session's prompts to the client would be megabytes for a list view. */
interface IndexedSession extends PastSession {
  haystack: string;
}

// ─── Agent runs vs. your own conversations ───────────────────────────────────
//
// `~/.claude/projects/<slug>/` holds EVERY conversation rooted in this project, and most of
// them were never yours. A goal-skill run spawns a planner plus an implementer per wave, the
// Sleep chip spawns a consolidation agent, an automation fires on a schedule, a council seats
// a persona per debater — each is a full CLI session filed exactly like the chat you typed.
// On this repo they are the MAJORITY: 27 sleep runs and ~60 goal-skill builders against a few
// dozen real conversations, all of which would bury the one you were looking for.
//
// A sub-agent dispatched with the Agent TOOL is already excluded structurally (its turns are
// `isSidechain`, and its own transcript lives under `<id>/subagents/`). What is left is the
// class that has no structural marker at all: a session spawned by `claude -p "<brief>"` from
// inside another session, which the CLI records identically to yours — same `entrypoint`,
// same `userType`, same `promptSource` (verified across this corpus 2026-08-01). So the only
// honest signal is the FIRST PROMPT: who wrote it, and to whom.
//
// Two rules, both read off that prompt:
//
//  1. The briefs THIS app and CLI write verbatim when they spawn an agent for you. These are
//     ours, so matching them is exact, not a guess — each entry below is the real opening of
//     a real constant, and its source file is named so the two can be kept in step.
//  2. The role-assignment shape every orchestrated brief opens with ("You are the
//     goal-planner…", "ROLE: You are a PLAN REVIEWER…"), optionally behind a thinking
//     directive or a `# Your role` heading. Nobody talking to their own agent introduces
//     themselves to it that way.
//
// Rule 2 is a heuristic, so it is never destructive: filtered rows are COUNTED and the picker
// says how many it is holding back, with one click to show them.

/** Openings of the agent briefs this project writes itself. Lowercased comparisons. */
const OWN_AGENT_BRIEFS: ReadonlyArray<{ prefix: string; source: string }> = [
  { prefix: 'think hard. run a full dreamcontext memory consolidation', source: 'dashboard/src/lib/sleepAgent.ts' },
  { prefix: 'think hard. run the /dream-sync flow', source: 'dashboard/src/lib/brainResolveAgent.ts' },
  { prefix: 'work on this dreamcontext task and drive it to completion', source: 'dashboard/src/lib/delegateAgent.ts' },
  { prefix: 'you are scheduled dreamcontext automation', source: 'src/lib/automations/runner.ts' },
];

/** A leading thinking directive (`ultrathink`, `Think hard.`, `Think deeply.`) — a
 *  spawn-time knob, not part of what the brief says. */
const THINK_DIRECTIVE_RE = /^(?:ultra\s*think|think(?:\s+(?:hard(?:er)?|deeply|step by step))?)\b[.:!,]?\s+/i;
/** A leading `# Your role` / `## Role:` heading, which several briefs open with. */
const ROLE_HEADING_RE = /^#{1,4}\s*(?:your\s+)?role\s*[:.]?\s+/i;
/** The role assignment itself, with or without a `ROLE:` label. `**bold**` role names are
 *  common in these briefs, so the marker is allowed to sit between "the" and the name. */
const ROLE_OPENER_RE = /^(?:role\s*[:—-]\s*)?you are (?:the|a|an|our)\b/i;

/**
 * Was this conversation opened by a machine rather than typed into by a person?
 *
 * Takes the session's FIRST prompt (already one-lined). See the block comment above for why
 * the first prompt is the only available signal and what the two rules are.
 */
export function isAgentRun(firstPrompt: string): boolean {
  const text = firstPrompt.trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (OWN_AGENT_BRIEFS.some((b) => lower.startsWith(b.prefix))) return true;

  // Peel the spawn-time wrappers, then ask whether what remains assigns a role. Bounded to a
  // few passes: `ultrathink\n\n# Your role\nYou are…` stacks at most two.
  let rest = text;
  for (let i = 0; i < 3; i++) {
    const next = rest.replace(THINK_DIRECTIVE_RE, '').replace(ROLE_HEADING_RE, '');
    if (next === rest) break;
    rest = next;
  }
  return ROLE_OPENER_RE.test(rest);
}

/** Bytes read from the start of a transcript — enough to reach the first user prompt past
 *  the CLI's session preamble (queue ops, hook attachments; this repo's own SessionStart
 *  blob is ~18 KB inline) with a wide margin. */
const HEAD_BYTES = 128 * 1024;
/** Bytes read from the end of a transcript, for the most recent prompt. */
const TAIL_BYTES = 64 * 1024;
/** Prompts harvested from the head into the search haystack. The first few say what a
 *  session was about; the rest is what full-text search over 1 GB would cost. */
const MAX_HEAD_PROMPTS = 12;
const TITLE_MAX = 120;
const PREVIEW_MAX = 200;
const HAYSTACK_MAX = 4000;

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;

/** Cap on the transcripts summarized in one listing, newest-mtime first. A project dir
 *  that has accumulated thousands of sessions must not turn one popup into thousands of
 *  file reads; the excess is reported as `truncated` rather than silently dropped. */
const MAX_SCANNED_FILES = 1200;

const JSONL_RE = /^([A-Za-z0-9_-]{1,128})\.jsonl$/;

/**
 * Claude Code's directory name for a project: every character outside `[A-Za-z0-9]`
 * becomes `-`. Verified against the real `~/.claude/projects` on 2026-08-01 —
 * `/Users/me/projects/dreamcontext` → `-Users-me-projects-dreamcontext`, and a worktree
 * `…/dreamcontext/.claude-worktrees/x` → `…-dreamcontext--claude-worktrees-x` (the `.`
 * collapsing to a second `-` is what produces the doubled dash).
 *
 * This encoding is another program's implementation detail, so it is only ever a FAST
 * PATH — {@link resolveProjectDir} falls back to reading each dir's own recorded `cwd`
 * when the guess misses, and that fallback is what keeps this working if the encoding
 * changes.
 */
export function claudeProjectDirName(projectRoot: string): string {
  return projectRoot.replace(/[^A-Za-z0-9]/g, '-');
}

function claudeProjectsBase(home: string): string {
  return join(home, '.claude', 'projects');
}

/** Read at most `length` bytes at `position`. '' on any error (an unreadable transcript
 *  is a session we skip, never a throw). */
function readAt(fd: number, position: number, length: number): string {
  if (length <= 0) return '';
  try {
    const buf = Buffer.allocUnsafe(length);
    const n = readSync(fd, buf, 0, length, position);
    return n > 0 ? buf.subarray(0, n).toString('utf8') : '';
  } catch {
    return '';
  }
}

/**
 * The bounded head + tail of one transcript. The tail is empty when the whole file
 * already fits in the head read (nothing to add).
 *
 * The size is taken from the OPEN descriptor rather than from the caller's earlier
 * `statSync`: the tail is read at `size - TAIL_BYTES`, so a size that understates the
 * file by even two bytes lands the read short of EOF and truncates the very last line —
 * which is the one holding the newest prompt. A live session appends between the listing's
 * stat and this read, so that skew is a normal event, not a hypothetical.
 */
function readEnds(path: string): { head: string; tail: string } {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const head = readAt(fd, 0, Math.min(size, HEAD_BYTES));
    const tailLen = Math.min(Math.max(0, size - HEAD_BYTES), TAIL_BYTES);
    const tail = tailLen > 0 ? readAt(fd, size - tailLen, tailLen) : '';
    return { head, tail };
  } catch {
    return { head: '', tail: '' };
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/** Collapse a prompt to one line and clip it — a title/preview is a label, and a pasted
 *  30-line stack trace must not become a 30-line row. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A whitespace-free absolute path — the shape a dropped/pasted file leaves at the front
 *  of a prompt. Anchored, so it only ever matches at the position being stripped. */
const LEADING_PATH_RE = /^\/\S+\s+/;

/**
 * The label part of a prompt: the same text with any leading absolute paths removed.
 *
 * Dropping a screenshot into the composer prefixes the message with its absolute path, and
 * this app's own temp paths are ~80 characters of `/Users/<me>/projects/<x>/_dream_context/
 * tmp/agent-drops/<epoch>-…` before the human's first word. Clipped to a row width, EVERY
 * such session reads as the same unidentifiable path. Stripped only while something is left
 * to show — a prompt that is nothing but a path keeps it, since that IS the message.
 */
export function promptLabel(text: string): string {
  let out = text.trim();
  while (LEADING_PATH_RE.test(out)) {
    const stripped = out.replace(LEADING_PATH_RE, '').trim();
    if (!stripped) break;
    out = stripped;
  }
  return out;
}

function parseTimestamp(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

interface ScanResult {
  prompts: string[];
  /** The newest `last-prompt` RECORD in the chunk. The CLI writes one of these
   *  (`{type:'last-prompt', lastPrompt, sessionId}`, observed on 2.1.220) alongside each
   *  turn, already truncated to a preview length — which makes it the reliable source for
   *  "what did I last ask this session", because the tail of a long turn is usually all
   *  tool output with the user's own entry far above the tail window. */
  lastPromptRecord: string;
  /** True when ANY entry in the chunk marks itself a sidechain — an old-CLI sub-agent
   *  file, which is not a conversation anyone resumes. */
  sidechain: boolean;
  cwd: string;
  gitBranch: string;
  firstTimestamp: number | null;
}

/**
 * Pull the human prompts + session metadata out of one chunk of transcript JSONL.
 * `maxPrompts` bounds how many are kept (see the note at the push below). Lines that don't
 * parse — the truncated line at a chunk boundary, or any shape a newer CLI writes — are
 * skipped.
 */
export function scanChunk(chunk: string, maxPrompts: number): ScanResult {
  const out: ScanResult = {
    prompts: [], lastPromptRecord: '', sidechain: false, cwd: '', gitBranch: '', firstTimestamp: null,
  };
  if (!chunk) return out;
  for (const line of chunk.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (!out.cwd && typeof obj.cwd === 'string') out.cwd = obj.cwd;
    if (!out.gitBranch && typeof obj.gitBranch === 'string') out.gitBranch = obj.gitBranch;
    // A sub-agent's turns. In a PARENT transcript this marker means "someone else's
    // conversation" — the same guard `parseTranscriptHistory` applies when replaying.
    if (obj.isSidechain === true) { out.sidechain = true; continue; }
    if (obj.type === 'last-prompt') {
      if (typeof obj.lastPrompt === 'string' && obj.lastPrompt.trim()) out.lastPromptRecord = obj.lastPrompt.trim();
      continue;
    }
    if (obj.type !== 'user') continue;
    const text = userPromptOf(obj);
    if (!text) continue;
    if (out.firstTimestamp === null) out.firstTimestamp = parseTimestamp(obj.timestamp);
    // Past `maxPrompts`, the final slot keeps being overwritten — so `prompts[0]` is
    // always the FIRST prompt in the chunk and `prompts.at(-1)` always the MOST RECENT
    // one, whatever the cap. (`maxPrompts: 1` is the degenerate case the tail scan uses:
    // one slot, holding the latest.)
    if (out.prompts.length < maxPrompts) out.prompts.push(text);
    else out.prompts[out.prompts.length - 1] = text;
  }
  return out;
}

/**
 * Summarize one transcript file into a listable session. Returns null when the file holds
 * nothing a person would recognize — no human prompt at all (a tab opened and never used,
 * or a session whose every entry is machine-generated) or an old-CLI sub-agent sidechain.
 * Neither is a conversation worth offering to resume.
 */
export function summarizeTranscript(
  path: string,
  id: string,
  stat: { mtimeMs: number; size: number },
): IndexedSession | null {
  const { head, tail } = readEnds(path);
  const headScan = scanChunk(head, MAX_HEAD_PROMPTS);
  if (headScan.sidechain) return null;
  // The tail scan keeps only the most recent prompt (maxPrompts 1 → the slot is
  // overwritten), which is all a preview needs.
  const tailScan = tail ? scanChunk(tail, 1) : null;
  if (tailScan?.sidechain) return null;

  const firstRaw = headScan.prompts[0] ?? tailScan?.prompts[0] ?? '';
  // Newest first: a real user entry inside the tail window, else the CLI's own
  // `last-prompt` record (which survives a tail full of tool output), else — for a session
  // that fits entirely in the head — the last prompt the head scan saw.
  const lastRaw = tailScan?.prompts[tailScan.prompts.length - 1]
    || tailScan?.lastPromptRecord
    || headScan.prompts[headScan.prompts.length - 1]
    || headScan.lastPromptRecord
    || '';

  const title = oneLine(promptLabel(firstRaw), TITLE_MAX);
  // Whitespace-only or unprintable prompts one-line down to nothing — a row with no label
  // is not a conversation anyone can pick out of a list.
  if (!title) return null;
  // A one-turn session's newest prompt IS its title, and must not be repeated under it.
  // `last-prompt` records arrive pre-truncated by the CLI, so the two can't be compared
  // whole — a common prefix is the only honest test.
  const lastLabel = oneLine(promptLabel(lastRaw), PREVIEW_MAX);
  const preview = !lastLabel || title.startsWith(lastLabel.replace(/…$/, '')) || lastLabel.startsWith(title.replace(/…$/, ''))
    ? ''
    : lastLabel;

  const haystack = [title, ...headScan.prompts, lastRaw, headScan.gitBranch]
    .join('\n')
    .slice(0, HAYSTACK_MAX)
    .toLowerCase();

  return {
    id,
    title,
    preview,
    updatedAt: stat.mtimeMs,
    startedAt: headScan.firstTimestamp,
    sizeBytes: stat.size,
    gitBranch: headScan.gitBranch || tailScan?.gitBranch || '',
    // Classified on the LABEL, not on `title` and not on the raw text: the title is clipped
    // to a row width (which can cut the opening mid-phrase), while the raw text can carry a
    // leading attachment path — and both ends of the classifier's rules are anchored to the
    // START of the prompt.
    agentRun: isAgentRun(promptLabel(firstRaw)),
    haystack,
  };
}

// ─── Project-dir resolution ──────────────────────────────────────────────────

/** Resolved dirs, keyed by project root. Claude Code creates a project dir once and keeps
 *  it, so this never needs invalidating within a server's lifetime. */
const dirCache = new Map<string, string | null>();

/** The `cwd` a project dir's transcripts record, read from the head of up to three of its
 *  files. '' when the dir is empty or holds nothing with a cwd. */
function recordedCwd(dir: string): string {
  let files: string[];
  try { files = readdirSync(dir); } catch { return ''; }
  let probed = 0;
  for (const name of files) {
    if (!JSONL_RE.test(name)) continue;
    if (++probed > 3) break;
    let fd = -1;
    try {
      fd = openSync(join(dir, name), 'r');
      const scan = scanChunk(readAt(fd, 0, 16 * 1024), 1);
      if (scan.cwd) return scan.cwd;
    } catch {
      /* skip an unreadable probe */
    } finally {
      if (fd >= 0) { try { closeSync(fd); } catch { /* already gone */ } }
    }
  }
  return '';
}

/**
 * The `~/.claude/projects` directory holding THIS project's conversations. Tries the
 * slug encoding first (one `existsSync`), then falls back to asking each project dir what
 * `cwd` its own transcripts record — authoritative, encoding-independent, and bounded by
 * the number of projects the user has ever opened.
 */
export function resolveProjectDir(projectRoot: string, home: string = homedir()): string | null {
  const key = `${home} ${projectRoot}`;
  const cached = dirCache.get(key);
  if (cached !== undefined) return cached;

  const base = claudeProjectsBase(home);
  let resolved: string | null = null;
  const guess = join(base, claudeProjectDirName(projectRoot));
  if (existsSync(guess)) {
    resolved = guess;
  } else {
    try {
      for (const name of readdirSync(base)) {
        const dir = join(base, name);
        if (recordedCwd(dir) === projectRoot) { resolved = dir; break; }
      }
    } catch {
      /* no projects dir at all — no history, not an error */
    }
  }
  dirCache.set(key, resolved);
  return resolved;
}

// ─── Listing ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** null memoizes "this file holds no listable conversation" — worth caching, since the
   *  answer is stable and re-deriving it costs the same read as a real summary. */
  summary: IndexedSession | null;
}

const summaryCache = new Map<string, CacheEntry>();

/**
 * Ceiling on memoized summaries, across every vault the server has listed. Each entry
 * holds a ~4 KB haystack, so this bounds the index at a few tens of MB on a machine with
 * a lot of history — and the desktop server is long-lived, so "it only grows" is not an
 * acceptable answer. Overflowing DROPS the whole map rather than evicting cleverly: the
 * next listing rebuilds only the transcripts it actually shows, which is the same work an
 * LRU would have done, without the bookkeeping.
 */
const MAX_CACHED_SUMMARIES = 5000;

/** Test seam — the module-level caches are process-lifetime by design. */
export function clearTranscriptSessionCaches(): void {
  summaryCache.clear();
  dirCache.clear();
}

export interface ListPastSessionsResult {
  sessions: PastSession[];
  /** Listable conversations matching the query, before `limit`. */
  total: number;
  /** How many matching conversations were WITHHELD as agent runs ({@link isAgentRun}) —
   *  0 when `includeAgentRuns` is on. The picker reports this rather than quietly
   *  shrinking the list. */
  agentRuns: number;
  /** True when the project dir held more transcripts than one listing scans. */
  truncated: boolean;
}

/**
 * Every past conversation of `projectRoot`, newest activity first.
 *
 * `query` matches case-insensitively against the session's title, the prompts harvested
 * from its head, its most recent prompt, and its branch — every token must appear
 * somewhere in that haystack (AND, not OR), so a second word narrows rather than widens.
 *
 * Machine-spawned sessions (goal-skill builders, the Sleep chip's agent, scheduled
 * automations, council personas — see {@link isAgentRun}) are EXCLUDED unless
 * `includeAgentRuns` is set. They outnumber real conversations several to one in a project
 * that uses the orchestration skills, and none of them is a chat anyone means to return to.
 */
export function listPastSessions(
  projectRoot: string,
  opts: { home?: string; query?: string; limit?: number; includeAgentRuns?: boolean } = {},
): ListPastSessionsResult {
  const home = opts.home ?? homedir();
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const dir = resolveProjectDir(projectRoot, home);
  if (!dir) return { sessions: [], total: 0, agentRuns: 0, truncated: false };

  let names: string[];
  try { names = readdirSync(dir); } catch { return { sessions: [], total: 0, agentRuns: 0, truncated: false }; }

  // Stat first, sort by recency, and only THEN read file contents: the newest N are what
  // anyone scrolls, and a project with thousands of transcripts must not pay a head+tail
  // read for the ones it will never show.
  const candidates: Array<{ path: string; id: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    const m = JSONL_RE.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size === 0) continue;
      candidates.push({ path, id: m[1], mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const truncated = candidates.length > MAX_SCANNED_FILES;
  const scanned = truncated ? candidates.slice(0, MAX_SCANNED_FILES) : candidates;

  const all: IndexedSession[] = [];
  for (const c of scanned) {
    const hit = summaryCache.get(c.path);
    let summary: IndexedSession | null;
    if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) {
      summary = hit.summary;
    } else {
      summary = summarizeTranscript(c.path, c.id, c);
      if (summaryCache.size >= MAX_CACHED_SUMMARIES) summaryCache.clear();
      summaryCache.set(c.path, { mtimeMs: c.mtimeMs, size: c.size, summary });
    }
    if (summary) all.push(summary);
  }

  const tokens = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const matched = tokens.length === 0
    ? all
    : all.filter((s) => tokens.every((t) => s.haystack.includes(t)));

  // Agent runs are filtered AFTER the query, so the count reported back is "how many of the
  // things you searched for are being held back" — the number the picker offers to reveal —
  // rather than a corpus-wide constant that says nothing about the current list.
  const shown = opts.includeAgentRuns ? matched : matched.filter((s) => !s.agentRun);
  const agentRuns = matched.length - shown.length;

  // `haystack` is stripped here — it is the index, not the payload.
  const sessions = shown.slice(0, limit).map(({ haystack: _drop, ...rest }) => rest);
  return { sessions, total: shown.length, agentRuns, truncated };
}
