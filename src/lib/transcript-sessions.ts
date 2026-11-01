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

import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { userPromptOf } from './transcript-history.js';
import { listClaudeAccounts } from './claude-accounts.js';

/** One past conversation, as the history picker shows it. */
export interface PastSession {
  /** The conversation UUID — what `claude --resume <id>` takes. */
  id: string;
  /** The name the conversation carried in its tab when one was remembered, else the first
   *  thing the user said, one-lined. Never empty (such a file is skipped). */
  title: string;
  /** `title` is a remembered tab name, not a clipped first prompt — the client may show it whole. */
  named: boolean;
  /** Present only on a queried listing: the title or message line that holds the query, one-lined
   *  and clipped around it ({@link matchSnippet}), so a hit says WHY it matched. */
  match?: string;
  /** Present only on a queried listing: where the query was found. `title` = the row's own name;
   *  `prompt` = a message of yours the index already held; `content` = only somewhere deeper in
   *  the conversation (your messages or the agent's replies). Rows are ranked in this order. */
  matchIn?: 'title' | 'prompt' | 'content';
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
  /** {@link isUnattendedRun}. */
  unattended: boolean;
  haystack: string;
  /** The haystack's lines in their own case (title, harvested prompts, last prompt), for the
   *  match snippet. Bounded like the haystack. */
  lines: string[];
}

/**
 * Search case folding, Turkish-aware and length-preserving: İ, I and ı all fold to i (a default
 * toLowerCase turns İ into i + a combining dot, so "istanbul" never found "İstanbul"). Same
 * length, so {@link matchSnippet}'s index into the folded line cuts the original. Mirrored in
 * dashboard/src/components/sleepy/phoneList.ts (drift test in tests/unit/phone-chat-list).
 */
export function foldCase(s: string): string {
  return s.replace(/[İIı]/g, 'i').toLowerCase();
}

/**
 * The line a hit is shown by: the first of `lines` holding `token` (case-insensitive),
 * whitespace collapsed, clipped to about `radius` characters either side of the word with `…`
 * where it was cut. '' when no line holds it (a branch-only hit).
 */
export function matchSnippet(lines: readonly string[], token: string, radius = 60): string {
  const t = foldCase(token);
  if (!t) return '';
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const at = foldCase(line).indexOf(t);
    if (at < 0) continue;
    const from = Math.max(0, at - radius);
    const to = Math.min(line.length, at + t.length + radius);
    return `${from > 0 ? '…' : ''}${line.slice(from, to).trim()}${to < line.length ? '…' : ''}`;
  }
  return '';
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
  // Delegate has four modes, and three of them open on their own brief — a mode the picker
  // did not know about would list its runs as conversations the user had typed.
  { prefix: "let's think this dreamcontext task through together", source: 'dashboard/src/lib/delegateModes.ts' },
  { prefix: 'check whether this dreamcontext task is actually done', source: 'dashboard/src/lib/delegateModes.ts' },
  { prefix: 'summarize this dreamcontext task for me', source: 'dashboard/src/lib/delegateModes.ts' },
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

/** Words of a query that are searched; the rest are ignored. */
const MAX_QUERY_TOKENS = 8;

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

/** The brief of a scheduled run: every other brief of ours opens a tab a person sits at. */
const SCHEDULED_BRIEF = 'you are scheduled dreamcontext automation';

/**
 * Did this conversation run with nobody at it? An agent run ({@link isAgentRun}), less the briefs
 * that open a person's own chat (a task handed to a tab, the sleep agent): those are a person's,
 * running or not. Its first prompt answers for a session nothing else knows.
 */
export function isUnattendedRun(firstPrompt: string): boolean {
  if (!isAgentRun(firstPrompt)) return false;
  const lower = firstPrompt.trim().toLowerCase();
  return lower.startsWith(SCHEDULED_BRIEF) || !OWN_AGENT_BRIEFS.some((b) => lower.startsWith(b.prefix));
}

export function transcriptIsUnattendedRun(path: string): boolean {
  try {
    const { head, tail } = readEnds(path);
    return isUnattendedRun(promptLabel(scanChunk(head, 1).prompts[0] ?? (tail ? scanChunk(tail, 1).prompts[0] : '') ?? ''));
  } catch { return false; }
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

  const haystack = foldCase([title, ...headScan.prompts, lastRaw, headScan.gitBranch]
    .join('\n')
    .slice(0, HAYSTACK_MAX));
  // The same text in its own case, for the snippet; bounded to the haystack's budget.
  const lines: string[] = [];
  let budget = HAYSTACK_MAX;
  for (const l of [title, ...headScan.prompts, lastRaw]) {
    if (!l || budget <= 0) continue;
    const cut = l.slice(0, budget);
    lines.push(cut);
    budget -= cut.length;
  }

  return {
    id,
    title,
    named: false,
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
    unattended: isUnattendedRun(promptLabel(firstRaw)),
    haystack,
    lines,
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
  return resolveProjectDirUnder(claudeProjectsBase(home), projectRoot);
}

/**
 * Every directory holding THIS project's conversations, one per Claude account the app knows
 * (`claude-accounts.ts`). An account's sandbox normally SHARES `projects/` with the real
 * `~/.claude` (a symlink — see `claude-account-sandbox.ts`), so the usual answer is one dir;
 * a sandbox whose `projects/` is a real directory of its own contributes its sessions too.
 * Deduplicated by real path.
 */
export function resolveProjectDirs(projectRoot: string, home: string = homedir()): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string | null) => {
    if (!dir) return;
    let real = dir;
    try { real = realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(dir);
  };
  add(resolveProjectDir(projectRoot, home));
  let accounts: ReturnType<typeof listClaudeAccounts> = [];
  try { accounts = listClaudeAccounts(home); } catch { /* no register — one account */ }
  for (const a of accounts) {
    if (!a.configDir) continue;
    // A sandbox dir stands in for HOME: its transcripts live under `<configDir>/projects`.
    add(resolveProjectDirUnder(join(a.configDir, 'projects'), projectRoot));
  }
  return out;
}

/** {@link resolveProjectDir} against an explicit `projects` base (HOME's, or an account
 *  sandbox's). */
function resolveProjectDirUnder(base: string, projectRoot: string): string | null {
  const key = `${base} ${projectRoot}`;
  const cached = dirCache.get(key);
  if (cached !== undefined) return cached;
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

/** One transcript file of the project, as a listing considers it. */
export interface TranscriptFile {
  path: string;
  id: string;
  mtimeMs: number;
  size: number;
}

/**
 * The project's transcript files across every account dir ({@link resolveProjectDirs}),
 * newest-mtime first, capped at {@link MAX_SCANNED_FILES}. Stat only — no content is read.
 * One conversation id found in two dirs is the same conversation: the newer copy wins.
 */
export function listTranscriptFiles(
  projectRoot: string,
  home: string = homedir(),
): { files: TranscriptFile[]; truncated: boolean } {
  const byId = new Map<string, TranscriptFile>();
  for (const dir of resolveProjectDirs(projectRoot, home)) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = JSONL_RE.exec(name);
      if (!m) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile() || st.size === 0) continue;
        const prev = byId.get(m[1]);
        if (!prev || st.mtimeMs > prev.mtimeMs) byId.set(m[1], { path, id: m[1], mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  // Stat first, sort by recency, and only THEN read file contents: the newest N are what
  // anyone scrolls, and a project with thousands of transcripts must not pay a head+tail
  // read for the ones it will never show.
  const all = [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const truncated = all.length > MAX_SCANNED_FILES;
  return { files: truncated ? all.slice(0, MAX_SCANNED_FILES) : all, truncated };
}

/** Full conversation text of a transcript, from `transcript-content-index.ts`. `folded` is
 *  {@link foldCase} of `text` (same length). Undefined = not indexed (yet). */
export type ContentLookup = (path: string) => { text: string; folded: string } | undefined;

/** Occurrences of `needle` in `hay`, counted up to `cap` — a ranking signal, not a statistic. */
function countOf(hay: string, needle: string, cap = 20): number {
  let n = 0;
  let at = hay.indexOf(needle);
  while (at >= 0 && n < cap) { n++; at = hay.indexOf(needle, at + needle.length); }
  return n;
}

/**
 * The snippet for a content-only hit: the message (one line of the index) holding `needle`,
 * clipped around it like {@link matchSnippet}. '' when it is not there.
 */
export function contentSnippet(text: string, folded: string, needle: string, radius = 60): string {
  const at = folded.indexOf(needle);
  if (at < 0) return '';
  const lineStart = folded.lastIndexOf('\n', at) + 1;
  const nl = folded.indexOf('\n', at);
  const lineEnd = nl < 0 ? folded.length : nl;
  const from = Math.max(lineStart, at - radius);
  const to = Math.min(lineEnd, at + needle.length + radius);
  return `${from > lineStart ? '…' : ''}${text.slice(from, to).trim()}${to < lineEnd ? '…' : ''}`;
}

/**
 * Every past conversation of `projectRoot`, newest activity first.
 *
 * `query` matches case-insensitively. Every token must appear somewhere (AND, not OR) in the
 * session's title, the prompts harvested from its head, its most recent prompt, its branch —
 * or, when `content` is given, anywhere in what was said in it (your messages and the agent's
 * replies, from `transcript-content-index.ts`). A queried listing is RANKED, not date-ordered:
 * every token in the title first, then a hit among the prompts already in the summary, then a
 * content-only hit; within a tier, the whole query as a phrase beats scattered words, then more
 * occurrences beat fewer, then the newer session wins.
 *
 * Machine-spawned sessions (goal-skill builders, the Sleep chip's agent, scheduled
 * automations, council personas — see {@link isAgentRun}) are EXCLUDED unless
 * `includeAgentRuns` is set. They outnumber real conversations several to one in a project
 * that uses the orchestration skills, and none of them is a chat anyone means to return to.
 */
/**
 * The Super Agent's sessions in a ranked listing (owner 2026-10-31), judged before any limit:
 *  - `group`, no query: the owner's rows, and one `group` (how many, the last activity);
 *  - `group`, a query: every match, so a search hides nothing;
 *  - `only`: the Super's sessions, agent runs or not.
 * `agentRuns` counts only what is withheld from the owner's rows.
 */
export function partitionSuper<R extends { s: { id: string; updatedAt: number; agentRun?: boolean } }>(
  ranked: readonly R[], owned: ReadonlySet<string>, mode: 'group' | 'only', queried: boolean, includeAgentRuns: boolean,
): { shown: R[]; agentRuns: number; group?: { count: number; lastAt: number } } {
  const supers = ranked.filter((r) => owned.has(r.s.id));
  if (mode === 'only') return { shown: supers, agentRuns: 0 };
  const mine = ranked.filter((r) => !owned.has(r.s.id));
  const agentRuns = includeAgentRuns ? 0 : mine.filter((r) => r.s.agentRun).length;
  const keep = (r: R) => includeAgentRuns || !r.s.agentRun;
  if (queried) return { shown: ranked.filter((r) => owned.has(r.s.id) || keep(r)), agentRuns };
  return {
    shown: mine.filter(keep), agentRuns,
    ...(supers.length ? { group: { count: supers.length, lastAt: Math.max(...supers.map((r) => r.s.updatedAt)) } } : {}),
  };
}

export function listPastSessions(
  projectRoot: string,
  opts: {
    home?: string;
    query?: string;
    limit?: number;
    includeAgentRuns?: boolean;
    /** Sessions this listing must not know of at all: gone before the query, so neither a row, a
     *  total nor the withheld count answers for what they contain. */
    hide?: (session: { id: string; unattended: boolean }) => boolean;
    /** The new shell's History: the project's Super Agent as one entry (`partitionSuper`). */
    superRows?: { owned: ReadonlySet<string>; mode: 'group' | 'only' };
    /** The name each conversation carried in its tab (`session-titles.ts`), keyed by
     *  conversation UUID. Preferred over the first prompt, and searchable. */
    titles?: ReadonlyMap<string, string>;
    /** Full-text lookup; absent = search the summary haystack only (the old behaviour). */
    content?: ContentLookup;
    /** Precomputed {@link listTranscriptFiles} (the caller already needed it to index). */
    files?: { files: TranscriptFile[]; truncated: boolean };
  } = {},
): ListPastSessionsResult {
  const home = opts.home ?? homedir();
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const { files: scanned, truncated } = opts.files ?? listTranscriptFiles(projectRoot, home);

  const all: Array<IndexedSession & { path: string }> = [];
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
    if (!summary) continue;
    if (opts.hide?.(summary)) continue;
    // Applied per listing, never baked into the memo: a tab can be renamed without its
    // transcript changing, so a cached summary must not pin yesterday's name.
    const named = opts.titles?.get(summary.id);
    all.push(named && named !== summary.title
      ? {
        ...summary,
        path: c.path,
        title: named,
        named: true,
        // The first prompt stops being the title, so a one-turn session shows it underneath
        // instead of nothing.
        preview: summary.preview || summary.title,
        haystack: `${foldCase(named)}\n${summary.haystack}`,
        lines: [named, ...summary.lines],
      }
      : { ...summary, path: c.path });
  }

  const folded = foldCase(opts.query ?? '').trim();
  // Distinct words, and few of them: each one is a pass over every indexed conversation, so a
  // pasted paragraph must not turn one request into a hundred scans.
  const tokens = [...new Set(folded.split(/\s+/).filter(Boolean))].slice(0, MAX_QUERY_TOKENS);
  const phrase = tokens.join(' ');

  type Ranked = { s: (typeof all)[number]; tier: 0 | 1 | 2; phrase: boolean; score: number; match: string };
  let ranked: Ranked[];
  if (tokens.length === 0) {
    ranked = all.map((s) => ({ s, tier: 0, phrase: false, score: 0, match: '' }));
  } else {
    ranked = [];
    for (const s of all) {
      const title = foldCase(s.title);
      const body = opts.content?.(s.path);
      // Each token must be found somewhere: the summary's haystack or the full text.
      if (!tokens.every((t) => s.haystack.includes(t) || !!body?.folded.includes(t))) continue;
      const tier: 0 | 1 | 2 = tokens.every((t) => title.includes(t)) ? 0
        : tokens.every((t) => s.haystack.includes(t)) ? 1 : 2;
      const hasPhrase = title.includes(phrase) || s.haystack.includes(phrase) || !!body?.folded.includes(phrase);
      let score = 0;
      for (const t of tokens) score += Math.log1p(countOf(s.haystack, t) + (body ? countOf(body.folded, t) : 0));
      // The snippet: the title for a title hit, else the summary line holding the phrase or
      // first word, else the deeper message holding it.
      const needle = hasPhrase ? phrase : tokens[0];
      let match = tier === 0 ? s.title : matchSnippet(s.lines, needle) || matchSnippet(s.lines, tokens[0]);
      if (!match && body) match = contentSnippet(body.text, body.folded, needle) || contentSnippet(body.text, body.folded, tokens[0]);
      ranked.push({ s, tier, phrase: hasPhrase, score, match });
    }
    ranked.sort((a, b) => a.tier - b.tier
      || Number(b.phrase) - Number(a.phrase)
      || b.score - a.score
      || b.s.updatedAt - a.s.updatedAt);
  }

  // Agent runs are filtered AFTER the query, so the count reported back is "how many of the
  // things you searched for are being held back" — the number the picker offers to reveal —
  // rather than a corpus-wide constant that says nothing about the current list.
  const parted = opts.superRows
    ? partitionSuper(ranked, opts.superRows.owned, opts.superRows.mode, !!folded, !!opts.includeAgentRuns)
    : { shown: opts.includeAgentRuns ? ranked : ranked.filter((r) => !r.s.agentRun), agentRuns: 0, group: undefined };
  const { shown, group } = parted;
  const agentRuns = opts.superRows ? parted.agentRuns : ranked.length - shown.length;

  // `haystack`, `lines` and `path` are stripped here — they are the index, not the payload. A
  // queried listing says why each row matched, and where.
  const TIERS = ['title', 'prompt', 'content'] as const;
  const sessions = shown.slice(0, limit).map(({ s, tier, match }) => {
    const { haystack: _h, lines: _l, path: _p, unattended: _u, ...rest } = s;
    return tokens.length ? { ...rest, match, matchIn: TIERS[tier] } : rest;
  });
  return {
    sessions: opts.superRows ? sessions.map((s) => (opts.superRows!.owned.has(s.id) ? { ...s, super: true } : s)) : sessions,
    total: shown.length, agentRuns, truncated, ...(group ? { superGroup: group } : {}),
  };
}
