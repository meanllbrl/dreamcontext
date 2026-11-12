/**
 * sleep-packet — everything the sleep specialists used to rebuild by hand, built once by the CLI.
 *
 * SL-1 (overnight audit, 2026-11-12): sleep-tasks spent 68% of its run before its first write
 * re-deriving its own input (a throwaway Python script over `transcript distill` for the owner's
 * turns, a 972 KB `tasks list --all --json` filtered by hand, `.sleep.json` and git re-parsed in
 * every specialist). This module builds that input deterministically:
 *
 *  - the cycle's sessions, OLDEST → NEWEST (latest session wins), each with every turn the owner
 *    TYPED since the last consolidation that covered it (`humanTurnText`: never a task
 *    notification, a skill loader or a compaction summary);
 *  - the open board as one line per task, plus the in_review tasks that look ready to close
 *    (SL-8) and the ones whose last STATUS CHANGE is old (not their last edit);
 *  - git log and status since the last consolidation, for the project and its linked repos;
 *  - the active version, the filing rules, the recidivism flags, and the facts that switch whole
 *    prompt sections off (SL-14: a single-person brain, no automation output, no app findings).
 *
 * NOTHING IS DROPPED SILENTLY (knowledge/patterns/a-delete-is-never-inferred-from-absence.md).
 * Owner turns are capped EVENLY (water-filling): when the cycle's turns exceed the budget, every
 * long turn is cut to the same length and each cut names how many characters went and the
 * command that shows the whole turn. No turn is ever omitted, so no ask can hide behind a long
 * neighbour. A session whose transcript cannot be read is listed as such, never left out.
 *
 * Read-only: building a packet writes nothing but the packet itself (see `writeSleepPacket`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { humanTurnText } from './transcript-records.js';
import { slugify } from './id.js';
import { resolveTranscript } from './transcript-locate.js';
import { readSleepFlags, type SleepFlag } from './sleep-flags.js';
import type { SleepState, SleepHistoryEntry } from './sleep-consolidation.js';
import type { TaskData, TaskSummary } from './task-backend/types.js';
import { isTerminal, type StatusDef } from './task-status.js';
import {
  knownIssuesText, ownerWordsBlock, readToolErrorTally, renderOwnerWords, renderRepeatedErrors, repeatedErrors,
  tallyToolErrors, toolErrorTallyFile, toolErrorsOf, writeToolErrorTally,
  type OwnerWordsBlock, type RepeatedError, type ToolError,
} from './sleep-learns.js';

/** Where `sleep start` writes the packet, relative to `_dream_context/` (gitignored `tmp/`). */
export const PACKET_DIR_REL = 'tmp/sleep';
export const PACKET_MD_REL = `${PACKET_DIR_REL}/packet.md`;
export const PACKET_BOARD_REL = `${PACKET_DIR_REL}/board.md`;
export const PACKET_JSON_REL = `${PACKET_DIR_REL}/packet.json`;

/** Total characters of owner turns before even capping starts. ~40K chars ≈ 10-20K tokens. */
export const OWNER_TURN_BUDGET = 40_000;
/** A cut turn never drops below this, even when the budget is overrun: an ask must stay readable. */
export const MIN_TURN_CAP = 400;
/** A task whose last status change is this old is stale (SL-8: keyed on status, not on `updated`). */
export const STALE_STATUS_DAYS = 21;
const GIT_LINES = 40;
const BOARD_NAME_CHARS = 110;
const LAST_MESSAGE_CHARS = 400;

export interface PacketTurn {
  /** ISO timestamp of the record, when the transcript carries one. */
  at: string | null;
  text: string;
  /** Characters cut from the middle of this turn (0 = whole). */
  cut: number;
}

export interface PacketSession {
  id: string;
  stopped_at: string | null;
  score: number | null;
  task_slugs: string[];
  /** Set when dreamcontext or an orchestrator spawned the session: its typed turns are the
   *  spawner's prompt, never the owner's. */
  spawn: string | null;
  last_assistant_message: string | null;
  /** The turns a person typed (for a spawned session: the prompts it was given). */
  turns: PacketTurn[];
  /** Turns the server or harness wrote on the user role, counted by kind (`super events`, …). */
  machine_turns: Record<string, number>;
  /** Turns from this time on (the last consolidation that covered this session), or null = all. */
  turns_since: string | null;
  /** Why no turns could be read, when none could. */
  transcript_problem: string | null;
  /** The session digest on disk, when there is one (relative to `_dream_context/`). */
  digest: string | null;
  /** Tool results the transcript marks as errors or that say `command not found`, folded (C5). */
  tool_errors?: ToolError[];
}

export interface BoardRow {
  slug: string;
  status: string;
  updated: string;
  name: string;
  version: string | null;
  parent: string | null;
}

export interface ReviewRow {
  slug: string;
  name: string;
  version: string | null;
  criteria: number;
  ticked: number;
  /** YYYY-MM-DD of the newest `Status →` changelog entry, or null when none is recorded. */
  last_status_change: string | null;
  /** How the version reached the owner: `released`, `installed` (at or below the running CLI), or null. */
  shipped: 'released' | 'installed' | null;
}

export interface GitBlock {
  repo: string;
  path: string;
  log: string[];
  status: string[];
  /** Distinct commit authors since the boundary, bots left out. */
  authors: string[];
  /** Lines left out of either list (named, never silent). */
  more: number;
  problem: string | null;
}

export interface PacketFacts {
  people: number;
  single_person: boolean;
  /** Distinct non-bot git authors since the last sleep, across the project and its linked repos. */
  git_authors: number;
  automation_outputs: number;
  app_findings: number;
  objectives: boolean;
  marketing: boolean;
  learning: boolean;
  depth: string | null;
}

export interface SleepPacket {
  generated_at: string;
  epoch: string | null;
  since: string | null;
  sessions: PacketSession[];
  owner_turns: { total_chars: number; budget: number; per_turn_cap: number | null; cut_turns: number };
  board: { open: BoardRow[]; counts: Record<string, number> };
  ready_to_close: ReviewRow[];
  stale_review: ReviewRow[];
  git: GitBlock[];
  active_version: string | null;
  filing_rules: string[];
  flags: SleepFlag[];
  /** The cycle's bookmarks, ★★★ first, then oldest first. */
  bookmarks: Array<{ id: string; salience: number; message: string; task_slug: string | null; session_id: string | null; auto: boolean }>;
  facts: PacketFacts;
  /** His own words since the last sleep, from the owner-words ledger (learning loop C5). */
  owner_words?: OwnerWordsBlock;
  /** Tool errors seen in two or more sessions on two or more days (D16a). */
  repeated_errors?: RepeatedError[];
}

// ─── Owner turns ─────────────────────────────────────────────────────────────

/**
 * Harness blocks that ride inside a typed user record: CLAUDE.md and hook reminders, slash
 * command echoes, local command output, the app's own context blocks. Their text is not the
 * owner's, so the packet strips them and keeps what is left.
 */
const INJECTED_BLOCK = /<(system-reminder|command-name|command-message|local-command-stdout|local-command-stderr|dreamcontext-[a-z-]+|ide_[a-z_]+)>[\s\S]*?<\/\1>/g;
/** What the owner typed after a slash command: kept, as `/cmd <args>`. */
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/g;
/** A turn the server or the app wrote on the user role: never an owner ask. */
const MACHINE_PREFIX = /^\[(super events|delegated-session event)\]/;

/** What the owner wrote in a turn's text, or the machine kind when none of it is theirs. */
export function cleanTurn(text: string): { text: string } | { machine: string } {
  const trimmed = text.trim();
  const prefix = MACHINE_PREFIX.exec(trimmed);
  if (prefix) return { machine: prefix[1] };
  // A sub-agent's completion ping (its full report rides inside): the harness's, never the owner's.
  if (/<task-notification\b/i.test(trimmed)) return { machine: 'task notification' };
  const command = /<command-name>\s*([^<\s]+)\s*<\/command-name>/.exec(trimmed);
  // The arguments of a slash command are what the owner typed (`/develop fix the login bug`):
  // they stay, prefixed with the command, while the echo tags around them go.
  const withArgs = trimmed.replace(COMMAND_ARGS, (_m, args: string) => {
    const a = args.trim();
    return a ? ` ${command ? `${command[1]} ` : ''}${a} ` : ' ';
  });
  const rest = withArgs.replace(INJECTED_BLOCK, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!rest) return { machine: command ? `command ${command[1]}` : 'harness block' };
  if (MACHINE_PREFIX.test(rest)) return { machine: MACHINE_PREFIX.exec(rest)![1] };
  return { text: rest };
}

/** The owner's words a mid-turn message carried (`attachment{type:'queued_command'}`), or null. */
function queuedCommandText(rec: Record<string, unknown>): string | null {
  const att = rec.attachment as { type?: unknown; prompt?: unknown } | undefined;
  if (rec.type !== 'attachment' || !att || att.type !== 'queued_command') return null;
  const p = att.prompt;
  const blocks = typeof p === 'string' ? [p] : Array.isArray(p)
    ? p.map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    : [];
  const text = blocks.map((t) => t.trim()).filter(Boolean).join('\n').trim();
  return text || null;
}

export interface TypedTurns {
  turns: PacketTurn[];
  /** Turns set aside as machine-written, counted by kind (named in the packet, never silent). */
  machine: Record<string, number>;
  /** Tool errors read in the same pass (learning loop C5). */
  errors?: ToolError[];
}

/**
 * Every turn a person typed in a transcript after `since` (ISO), in order: user records that
 * pass `humanTurnText`, and messages sent while a turn ran (queued commands). Harness blocks
 * inside a turn are stripped; a turn left with nothing of the owner's is counted by kind.
 * Never throws.
 */
export function readTypedTurns(path: string, since: string | null): TypedTurns {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { turns: [], machine: {} };
  }
  const sinceMs = since ? Date.parse(since) : NaN;
  const turns: PacketTurn[] = [];
  const machine: Record<string, number> = {};
  const errors: ToolError[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    const recAt = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    if (Number.isNaN(sinceMs) || !recAt || Date.parse(recAt) > sinceMs) errors.push(...toolErrorsOf(rec));
    const text = humanTurnText(rec) ?? queuedCommandText(rec);
    if (!text) continue;
    const at = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    if (!Number.isNaN(sinceMs) && at && Date.parse(at) <= sinceMs) continue;
    const clean = cleanTurn(text);
    if ('machine' in clean) {
      machine[clean.machine] = (machine[clean.machine] ?? 0) + 1;
      continue;
    }
    // The same message recorded twice (a queued message is also written as its user turn):
    // one copy is the turn, the echo is counted, never shown twice.
    const prev = turns[turns.length - 1];
    if (prev && prev.text === clean.text) {
      machine['repeat of the previous turn'] = (machine['repeat of the previous turn'] ?? 0) + 1;
      continue;
    }
    turns.push({ at, text: clean.text, cut: 0 });
  }
  return { turns, machine, errors };
}

/**
 * The single per-turn cap that fits `lengths` into `budget` (water-filling), or null when they
 * already fit. Floored at `floor`: past that the budget is overrun rather than an ask cut short.
 */
export function evenTurnCap(lengths: number[], budget: number, floor: number = MIN_TURN_CAP): number | null {
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= budget) return null;
  const sorted = [...lengths].sort((a, b) => a - b);
  let remaining = budget;
  let left = sorted.length;
  for (const len of sorted) {
    const share = Math.floor(remaining / left);
    if (len <= share) {
      remaining -= len;
      left -= 1;
      continue;
    }
    return Math.max(floor, share);
  }
  return Math.max(floor, Math.floor(budget / Math.max(1, lengths.length)));
}

/** Cut `text` to `cap` characters: its head and its tail, with the middle named. */
export function cutTurn(text: string, cap: number, sessionId: string): { text: string; cut: number } {
  if (text.length <= cap) return { text, cut: 0 };
  const head = Math.ceil(cap * 0.7);
  const tail = cap - head;
  const cut = text.length - head - tail;
  const marker = ` … [${cut} chars cut; whole turn: dreamcontext transcript distill ${sessionId}] … `;
  return { text: text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : ''), cut };
}

/** Apply one even cap across every session's turns, in place. Returns the cap used. */
export function capTurnsEvenly(sessions: PacketSession[], budget: number = OWNER_TURN_BUDGET): { cap: number | null; cutTurns: number; total: number } {
  const lengths = sessions.flatMap((s) => s.turns.map((t) => t.text.length));
  const total = lengths.reduce((a, b) => a + b, 0);
  const cap = evenTurnCap(lengths, budget);
  let cutTurns = 0;
  if (cap !== null) {
    for (const s of sessions) {
      s.turns = s.turns.map((t) => {
        const c = cutTurn(t.text, cap, s.id);
        if (c.cut > 0) cutTurns += 1;
        return { at: t.at, text: c.text, cut: c.cut };
      });
    }
  }
  return { cap, cutTurns, total };
}

/** When the last consolidation that covered `sessionId` ran (the `transcript distill` rule). */
export function turnsSince(sessionId: string, history: SleepHistoryEntry[]): string | null {
  const h = history.find((e) => Array.isArray(e.session_ids) && e.session_ids.includes(sessionId));
  return h?.consolidated_at ?? null;
}

/** The cycle's sessions, oldest → newest, with their typed turns. */
export function packetSessions(contextRoot: string, state: SleepState, history: SleepHistoryEntry[]): PacketSession[] {
  const sessions = [...state.sessions].sort((a, b) => {
    const x = a.stopped_at ? Date.parse(a.stopped_at) : Number.POSITIVE_INFINITY;
    const y = b.stopped_at ? Date.parse(b.stopped_at) : Number.POSITIVE_INFINITY;
    return x - y;
  });
  return sessions.map((s) => {
    const since = turnsSince(s.session_id, history);
    let turns: PacketTurn[] = [];
    let machine: Record<string, number> = {};
    let errors: ToolError[] | undefined;
    let problem: string | null = null;
    if (!s.transcript_path) {
      problem = 'no transcript path recorded';
    } else {
      const loc = resolveTranscript(s.transcript_path, { sessionId: s.session_id });
      if (!loc.mainPath) problem = `transcript not found (${s.transcript_path})`;
      else ({ turns, machine, errors } = readTypedTurns(loc.mainPath, since));
    }
    const digestRel = `state/.session-digests/${s.session_id}.md`;
    const digestAbs = join(contextRoot, digestRel);
    let digest: string | null = null;
    try {
      if (existsSync(digestAbs) && lstatSync(digestAbs).isFile()) digest = digestRel;
    } catch { digest = null; }
    const last = s.last_assistant_message;
    return {
      id: s.session_id,
      stopped_at: s.stopped_at,
      score: s.score,
      task_slugs: Array.isArray(s.task_slugs) ? s.task_slugs : [],
      spawn: s.spawn ? `${s.spawn.by}/${s.spawn.via}` : null,
      last_assistant_message: last ? (last.length > LAST_MESSAGE_CHARS ? `${last.slice(0, LAST_MESSAGE_CHARS)}…` : last) : null,
      turns,
      machine_turns: machine,
      turns_since: since,
      transcript_problem: problem,
      digest,
      ...(errors && errors.length > 0 ? { tool_errors: errors } : {}),
    };
  });
}

// ─── Board ───────────────────────────────────────────────────────────────────

function day(iso: string | null | undefined): string {
  return typeof iso === 'string' ? iso.slice(0, 10) : '';
}

/** One line per open task, newest first. */
export function boardRows(tasks: TaskSummary[], statuses: StatusDef[]): BoardRow[] {
  return tasks
    .filter((t) => !isTerminal(statuses, t.status))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map((t) => ({
      slug: basename(t.file, '.md'),
      status: t.status,
      updated: day(t.updated_at),
      // A listing row's `name` is its slug; the sentence a person wrote is its description.
      name: t.description.length > BOARD_NAME_CHARS ? `${t.description.slice(0, BOARD_NAME_CHARS)}…` : t.description,
      version: t.version,
      parent: t.parent_task,
    }));
}

/** Ticked and total checkbox criteria in an Acceptance Criteria section. */
export function countCriteria(section: string): { total: number; ticked: number } {
  let total = 0;
  let ticked = 0;
  for (const line of section.split('\n')) {
    const m = /^\s*[-*]\s+\[([ xX])\]/.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1] !== ' ') ticked += 1;
  }
  return { total, ticked };
}

/** YYYY-MM-DD of the newest `### <date> - Status → …` changelog header, or null. */
export function lastStatusChange(changelog: string): string | null {
  let newest: string | null = null;
  const re = /^#{2,4}\s+(\d{4}-\d{2}-\d{2})\b[^\n]*Status\s*(?:→|->)/gm;
  for (const m of changelog.matchAll(re)) {
    if (!newest || m[1] > newest) newest = m[1];
  }
  return newest;
}

/** Numeric semver compare on the first three parts (`0.41.10` > `0.41.9`); NaN parts read as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** How a task's version reached the owner: a published release, or a cut at or below the running CLI. */
export function shippedState(
  version: string | null,
  releases: Array<{ version: string; status: string }>,
  runningVersion: string | null,
): ReviewRow['shipped'] {
  if (!version || !/^v?\d+\.\d+/.test(version)) return null;
  if (releases.some((r) => r.version === version && r.status === 'released')) return 'released';
  if (runningVersion && /^\d+\.\d+/.test(runningVersion) && compareVersions(version, runningVersion) <= 0) return 'installed';
  return null;
}

/** Days between a YYYY-MM-DD and `now`. */
function ageDays(date: string, now: Date): number {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? 0 : Math.floor((now.getTime() - t) / 86_400_000);
}

/**
 * The review-kind tasks, split into ready to close (every criterion ticked, at least one, and
 * shipped) and stale (last status change 21+ days ago, not ready). A task with no recorded
 * status change falls back to `created_at`: the status it holds was set at birth or before the
 * changelog recorded it.
 */
export function reviewRows(
  tasks: TaskData[],
  releases: Array<{ version: string; status: string }>,
  runningVersion: string | null,
  now: Date,
): { ready: ReviewRow[]; stale: ReviewRow[] } {
  const ready: ReviewRow[] = [];
  const stale: ReviewRow[] = [];
  for (const t of tasks) {
    const c = countCriteria(t.acceptance_criteria ?? '');
    const row: ReviewRow = {
      slug: t.slug,
      name: t.name.length > BOARD_NAME_CHARS ? `${t.name.slice(0, BOARD_NAME_CHARS)}…` : t.name,
      version: t.version,
      criteria: c.total,
      ticked: c.ticked,
      last_status_change: lastStatusChange(t.changelog ?? ''),
      shipped: shippedState(t.version, releases, runningVersion),
    };
    if (c.total > 0 && c.ticked === c.total && row.shipped) {
      ready.push(row);
      continue;
    }
    const since = row.last_status_change ?? day(t.created_at);
    if (since && ageDays(since, now) >= STALE_STATUS_DAYS) stale.push(row);
  }
  const byOldest = (a: ReviewRow, b: ReviewRow) => String(a.last_status_change ?? '').localeCompare(String(b.last_status_change ?? ''));
  return { ready: ready.sort(byOldest), stale: stale.sort(byOldest) };
}

// ─── Git ─────────────────────────────────────────────────────────────────────

/** The bot filter of `src/lib/attribution.ts` (BOT_SLUG_FRAGMENTS), applied to an author name. */
function isBot(author: string): boolean {
  const slug = author.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return slug.includes('github-actions') || slug.includes('dependabot');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
}

/** git log (since `since`) and status of one checkout, capped with the rest counted. */
export function gitBlock(repo: string, path: string, since: string | null): GitBlock {
  try {
    const top = git(path, ['rev-parse', '--show-toplevel']).trim();
    if (!top) return { repo, path, log: [], status: [], authors: [], more: 0, problem: 'not a git checkout' };
    // --all: work lands on feature branches and worktrees, rarely on the checked-out one.
    const logArgs = ['log', '--all', '--oneline', '--decorate=short', ...(since ? [`--since=${since}`] : ['-n', String(GIT_LINES)])];
    const log = git(path, logArgs).split('\n').filter(Boolean);
    const status = git(path, ['status', '--short']).split('\n').filter(Boolean);
    const authors = [...new Set(
      git(path, ['log', '--all', '--format=%an', ...(since ? [`--since=${since}`] : ['-n', String(GIT_LINES)])])
        .split('\n').map((a) => a.trim()).filter((a) => a && !isBot(a)),
    )].sort();
    const more = Math.max(0, log.length - GIT_LINES) + Math.max(0, status.length - GIT_LINES);
    return { repo, path, log: log.slice(0, GIT_LINES), status: status.slice(0, GIT_LINES), authors, more, problem: null };
  } catch (err) {
    return { repo, path, log: [], status: [], authors: [], more: 0, problem: ((err as Error).message ?? String(err)).split('\n')[0] };
  }
}

// ─── Assembly ────────────────────────────────────────────────────────────────

export interface PacketInputs {
  contextRoot: string;
  state: SleepState;
  history: SleepHistoryEntry[];
  tasks: TaskSummary[];
  /** Full views of the review-kind tasks only (criteria and changelog are read from them). */
  reviewTasks: TaskData[];
  statuses: StatusDef[];
  releases: Array<{ version: string; status: string }>;
  runningVersion: string | null;
  activeVersion: string | null;
  filingRules: string[];
  repos: Array<{ name: string; path: string }>;
  people: number;
  automationOutputs: number;
  appFindings: number;
  learning: boolean;
  now?: Date;
  /** Where the owner-words ledger, the rules stores and the tool-error tally live (tests). */
  home?: string;
}

export function buildSleepPacket(i: PacketInputs): SleepPacket {
  const now = i.now ?? new Date();
  const since = i.state.last_consolidated_at ?? null;
  const sessions = packetSessions(i.contextRoot, i.state, i.history);
  const capped = capTurnsEvenly(sessions);
  const open = boardRows(i.tasks, i.statuses);
  const counts: Record<string, number> = {};
  for (const t of i.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const review = reviewRows(i.reviewTasks, i.releases, i.runningVersion, now);
  const objectivesDir = join(i.contextRoot, 'core', 'objectives');
  const git = i.repos.map((r) => gitBlock(r.name, r.path, since));
  const authors = new Set(git.flatMap((g) => g.authors));
  // What sleep learns from (C5): his words, and the tally of tool errors across sessions. Each is
  // best-effort: a broken ledger or tally never stops the packet, and the block says what it has.
  let ownerWords: OwnerWordsBlock | undefined;
  try { ownerWords = ownerWordsBlock(i.contextRoot, since, { home: i.home }); } catch { ownerWords = undefined; }
  let repeated: RepeatedError[] | undefined;
  try {
    const file = toolErrorTallyFile(i.contextRoot, i.home);
    let tally = readToolErrorTally(file);
    for (const s of sessions) if (s.tool_errors?.length) tally = tallyToolErrors(tally, s.id, s.tool_errors, now);
    tally = tallyToolErrors(tally, '', [], now);
    writeToolErrorTally(file, tally);
    repeated = repeatedErrors(tally, knownIssuesText(i.contextRoot));
  } catch { repeated = undefined; }
  return {
    generated_at: now.toISOString(),
    epoch: i.state.sleep_started_at ?? null,
    since,
    sessions,
    owner_turns: { total_chars: capped.total, budget: OWNER_TURN_BUDGET, per_turn_cap: capped.cap, cut_turns: capped.cutTurns },
    board: { open, counts },
    ready_to_close: review.ready,
    stale_review: review.stale,
    git,
    active_version: i.activeVersion,
    filing_rules: i.filingRules,
    flags: readSleepFlags(i.contextRoot),
    bookmarks: [...(i.state.bookmarks ?? [])]
      .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0) || String(a.created_at).localeCompare(String(b.created_at)))
      .map((b) => ({ id: b.id, salience: b.salience, message: b.message, task_slug: b.task_slug ?? null, session_id: b.session_id ?? null, auto: b.capture === true })),
    facts: {
      people: i.people,
      single_person: i.people <= 1,
      git_authors: authors.size,
      automation_outputs: i.automationOutputs,
      app_findings: i.appFindings,
      objectives: hasMarkdown(objectivesDir),
      marketing: existsSync(join(i.contextRoot, 'marketing')),
      learning: i.learning,
      depth: i.state.consolidation_depth ?? null,
    },
    ...(ownerWords ? { owner_words: ownerWords } : {}),
    ...(repeated ? { repeated_errors: repeated } : {}),
  };
}

function hasMarkdown(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** The section switches a packet's facts turn on (SL-14), one line each. */
export function factSwitches(f: PacketFacts): string[] {
  const out: string[] = [];
  if (f.single_person) out.push(`Single-person brain (${f.people} on the roster): sleep-tasks skips §2.5 (person tags).`);
  else out.push(`Multi-person brain (${f.people} on the roster): sleep-tasks runs §2.5.`);
  // Detection is how a second person is first noticed, so B.5 is skipped only when nothing hints at one.
  if (f.single_person && f.git_authors <= 1) out.push(`One git author since the last sleep: sleep-state skips Pass B.5 (people detection) unless a session shows a second person.`);
  else out.push(`${f.git_authors} git author(s) since the last sleep: sleep-state runs Pass B.5.`);
  if (f.automation_outputs === 0) out.push('No automation output pending: sleep-product skips B7.');
  else out.push(`${f.automation_outputs} automation output(s) pending: sleep-product runs B7.`);
  if (f.app_findings === 0) out.push('No app findings: sleep-product skips B8.');
  else out.push(`App findings waiting (${f.app_findings}): sleep-product runs B8.`);
  out.push(f.objectives ? 'Objectives exist: sleep-tasks runs grooming (d).' : 'No objectives: sleep-tasks skips grooming (d).');
  return out;
}

function fence(text: string): string {
  // A turn may contain its own fences; indent instead of fencing so nothing can break out.
  return text.split('\n').map((l) => `    ${l}`).join('\n');
}

export function renderSleepPacket(p: SleepPacket): string {
  const L: string[] = [];
  L.push('# Sleep packet');
  L.push('');
  L.push(`Built ${p.generated_at} · epoch ${p.epoch ?? 'none'} · since ${p.since ?? 'never consolidated'} · depth ${p.facts.depth ?? 'n/a'} · active version ${p.active_version ?? 'NONE (create one before filing)'}`);
  L.push(`Read this instead of rebuilding it: sessions, owner turns, git and flags are here; the task board is in ${PACKET_BOARD_REL.split('/').pop()} next to it (sleep-tasks reads both). Sessions run OLDEST → NEWEST: a later session overrides an earlier one.`);
  L.push('');
  L.push('## Facts (sections they switch)');
  for (const s of factSwitches(p.facts)) L.push(`- ${s}`);
  L.push('');
  L.push(`## Sessions (${p.sessions.length})`);
  const ot = p.owner_turns;
  L.push(ot.per_turn_cap === null
    ? `Owner turns: ${ot.total_chars} chars, all whole.`
    : `Owner turns: ${ot.total_chars} chars over the ${ot.budget} budget, so ${ot.cut_turns} long turn(s) were cut evenly to ${ot.per_turn_cap} chars each (head and tail kept, the cut named). No turn is left out.`);
  for (const s of p.sessions) {
    L.push('');
    const tasks = s.task_slugs.length ? s.task_slugs.join(', ') : 'no task';
    L.push(`### ${s.stopped_at ?? 'still open'} · ${s.id}${s.spawn ? ` · SPAWNED (${s.spawn}): its turns are the spawner's prompt, not the owner's` : ''}`);
    L.push(`Tasks: ${tasks} · score ${s.score ?? 'pending'}${s.turns_since ? ` · turns since ${s.turns_since}` : ''}${s.digest ? ` · digest ${s.digest}` : ''}`);
    if (s.transcript_problem) L.push(`Transcript: ${s.transcript_problem}. Its asks cannot be read here; say so in your report.`);
    if (s.last_assistant_message) L.push(`Last reply: ${s.last_assistant_message.replace(/\s+/g, ' ')}`);
    if (!s.transcript_problem && s.turns.length === 0) L.push('No typed turns in this window.');
    const machine = Object.entries(s.machine_turns);
    if (machine.length) L.push(`Machine-written turns set aside (not the owner's): ${machine.map(([k, v]) => `${k} ×${v}`).join(', ')}.`);
    s.turns.forEach((t, idx) => {
      L.push(`- Turn ${idx + 1}${t.at ? ` (${t.at})` : ''}${t.cut ? ` [cut ${t.cut} chars]` : ''}:`);
      L.push(fence(t.text));
    });
  }
  if (p.owner_words) { L.push(''); L.push(...renderOwnerWords(p.owner_words)); }
  if (p.repeated_errors) { L.push(''); L.push(...renderRepeatedErrors(p.repeated_errors)); }
  L.push('');
  L.push('## Git since the last consolidation (all branches)');
  for (const g of p.git) {
    L.push(`### ${g.repo} (${g.path})`);
    if (g.problem) { L.push(`unreadable: ${g.problem}`); continue; }
    L.push(g.log.length ? 'log:' : 'log: no commits');
    for (const l of g.log) L.push(`  ${l}`);
    L.push(g.status.length ? 'status:' : 'status: clean');
    for (const l of g.status) L.push(`  ${l}`);
    if (g.more > 0) L.push(`(${g.more} more line(s): run git yourself)`);
  }
  L.push('');
  L.push('## Filing rules');
  if (p.filing_rules.length === 0) L.push('none learned yet');
  for (const l of p.filing_rules) L.push(l.startsWith('!') ? `WARNING: ${l.slice(1)}` : l);
  L.push('');
  L.push(`## Bookmarks (${p.bookmarks.length})`);
  if (p.bookmarks.length === 0) L.push('none');
  for (const b of p.bookmarks) L.push(`- ${'★'.repeat(Math.max(1, Math.min(3, b.salience)))} ${b.message.replace(/\s+/g, ' ')}${b.task_slug ? ` · task ${b.task_slug}` : ' · no task'}${b.auto ? ' · auto-captured' : ''}`);
  L.push('');
  L.push(`## Recidivism flags (${p.flags.length})`);
  if (p.flags.length === 0) L.push('none');
  for (const f of p.flags) L.push(`- ${f.key} · ${f.consecutive_cycles} cycle(s) · ${f.label}${f.task_slug ? ` · task ${f.task_slug}` : ''}`);
  L.push('');
  return L.join('\n');
}

/** The board half of the packet: the open board, ready to close, stale reviews (sleep-tasks). */
export function renderSleepBoard(p: SleepPacket): string {
  const L: string[] = [];
  const counts = Object.entries(p.board.counts).map(([k, v]) => `${k} ${v}`).join(' · ');
  L.push('# Sleep packet: task board');
  L.push('');
  L.push(`Built ${p.generated_at}. Your BOARD MAP: hold it for the whole pass instead of \`tasks list --all --json\`.`);
  L.push('');
  L.push(`## Open board (${p.board.open.length} open; all statuses: ${counts || 'none'})`);
  L.push('slug | status | updated | version | name (only where it says more than the slug)');
  for (const r of p.board.open) {
    const name = slugify(r.name) === r.slug || r.slug.startsWith(slugify(r.name)) ? '' : r.name;
    L.push(`${r.slug} | ${r.status} | ${r.updated} | ${r.version ?? '-'} | ${name}${r.parent ? ` (sub-task of ${r.parent})` : ''}`);
  }
  L.push('');
  L.push(`## Ready to close (${p.ready_to_close.length}): in review, every criterion ticked, its version shipped`);
  L.push('slug · ticked · version · in review since');
  if (p.ready_to_close.length === 0) L.push('none');
  for (const r of p.ready_to_close) L.push(`- ${r.slug} · ${r.ticked}/${r.criteria} · ${r.version} ${r.shipped} · ${r.last_status_change ?? 'unrecorded'}`);
  L.push('');
  L.push(`## In review, status unchanged ${STALE_STATUS_DAYS}+ days and not ready (${p.stale_review.length})`);
  L.push('slug · ticked · last status change · version');
  if (p.stale_review.length === 0) L.push('none');
  for (const r of p.stale_review) L.push(`- ${r.slug} · ${r.ticked}/${r.criteria} · ${r.last_status_change ?? 'unrecorded'} · ${r.version ?? 'no version'}${r.shipped ? ` ${r.shipped}` : ''}`);
  L.push('');
  return L.join('\n');
}

/** Write the packet (packet.md, board.md, packet.json) under `_dream_context/tmp/sleep/`. */
export function writeSleepPacket(contextRoot: string, packet: SleepPacket): { md: string; board: string; json: string } {
  const md = join(contextRoot, PACKET_MD_REL);
  const board = join(contextRoot, PACKET_BOARD_REL);
  const json = join(contextRoot, PACKET_JSON_REL);
  // Soul: a vault path is never followed through a symlink. tmp/ or tmp/sleep/ planted as a link
  // would aim this write (owner turns) somewhere else.
  for (const dir of [join(contextRoot, 'tmp'), dirname(md)]) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`refusing to write the sleep packet: ${dir} is a symlink`);
  }
  mkdirSync(dirname(md), { recursive: true });
  for (const f of [md, board, json]) {
    if (existsSync(f) && lstatSync(f).isSymbolicLink()) throw new Error(`refusing to write the sleep packet: ${f} is a symlink`);
  }
  writeFileSync(md, renderSleepPacket(packet), 'utf-8');
  writeFileSync(board, renderSleepBoard(packet), 'utf-8');
  writeFileSync(json, JSON.stringify(packet, null, 2) + '\n', 'utf-8');
  return { md, board, json };
}
