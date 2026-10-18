import { execFile } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { findTranscriptBySessionId } from './transcript-locate.js';
import { TEAMMATE_SESSION_RE } from './goal-live.js';

/**
 * A headless builder (`claude -p --session-id <uuid>`) as a TEAMMATE: its brief, its steps and
 * its status, all asked of the one thing that knows them — the run's own transcript.
 *
 * The orchestrator's bookkeeping (`goal-live state T1=done`) is what it MEANT to happen; the
 * transcript is what did. A builder that crashed never gets its `done` written, and one that
 * the orchestrator forgot to mark keeps running in the file forever. So the status here is
 * read off the log `claude -p` writes for itself, in this order of trust:
 *
 *   1. a `cost-state` line after the latest assignment — the CLI writes it when the process
 *      EXITS (verified 2.1.281: the last line of every finished `-p` run). With a clean final
 *      answer (`end_turn`) that is `done`; without one (killed mid-tool, an API error) it is
 *      `failed`.
 *   2. no exit record: the process is asked directly — its argv carries the id, since the id
 *      is how it was started (`--session-id X`, `--resume X`). Alive is `running`; gone
 *      without an exit record is `stopped` (a SIGKILL, a closed laptop, a crashed machine).
 *   3. the process table unreadable: a transcript written to recently reads as `running`,
 *      a quiet one as `stopped`. Fail open toward what can be observed, never "forever".
 *
 * "The latest assignment" is the last `queue-operation enqueue`: every `-p` run, and every
 * `--resume` of one, starts with one carrying the prompt it was given. It is the brief.
 */

export type TeammateStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface TeammateStep {
  toolUseId: string;
  name: string;
  input?: unknown;
  status: 'running' | 'done' | 'error';
}

export interface TeammateSummary {
  session: string;
  status: TeammateStatus;
  /** The prompt of the latest assignment. */
  brief?: string;
  /** Epoch ms of the latest assignment. */
  startedAt?: number;
  /** Epoch ms of the run's exit record, when it has one. */
  endedAt?: number;
  /** Epoch ms of the transcript's last write. */
  updatedAt: number;
  /** The final answer, once there is one. */
  result?: string;
  /** What it is on right now: the tool calls of this assignment, newest last, capped. */
  steps: TeammateStep[];
  toolUses: number;
  durationMs?: number;
  model?: string;
}

/** The last N tool calls a card shows as action lines. */
export const TEAMMATE_STEP_CAP = 6;
/** Brief and result are prose for a card and a header, not a document. */
export const TEAMMATE_TEXT_CAP = 4000;
/** A tool input on an action line is a label, never a payload. */
const STEP_INPUT_CAP = 600;
/** Without a process table, a transcript quiet for longer than this is not "running". */
export const TEAMMATE_QUIET_MS = 5 * 60 * 1000;
/** The most of a transcript ever read: its tail. A long run's head is copied history. */
export const TEAMMATE_READ_CAP_BYTES = 16 * 1024 * 1024;

function cap(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function capInput(input: unknown): unknown {
  if (input == null) return input;
  try {
    const s = JSON.stringify(input);
    if (s.length <= STEP_INPUT_CAP) return input;
  } catch { return undefined; }
  if (typeof input !== 'object') return undefined;
  // Keep the fields a label is made of, each capped: a Write's `content` is not a label.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = cap(v, 200);
  }
  return out;
}

function ts(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

interface Row { type?: unknown; operation?: unknown; content?: unknown; timestamp?: unknown; totalDuration?: unknown; message?: { stop_reason?: unknown; model?: unknown; content?: unknown } }

/** Everything a summary reads off the transcript's TEXT — the part worth caching while the file
 *  is unchanged. The status, which also depends on the clock and the process table, is
 *  {@link finishSummary}'s. */
interface TeammateDigest {
  brief?: string;
  startedAt?: number;
  model?: string;
  /** Every tool call of the latest assignment, in order (never mutated after the digest). */
  steps: TeammateStep[];
  exit: Row | null;
  lastAnswer: { text: string; clean: boolean } | null;
}

/**
 * Summarize one headless run's transcript. Pure: the file's text, its mtime, the clock and the
 * liveness answer are all passed in, so every state is reproducible in a test. `alive` is null
 * when the process table could not be read.
 */
export function summarizeTeammateTranscript(
  session: string, raw: string, mtimeMs: number, nowMs: number, alive: boolean | null,
): TeammateSummary {
  return finishSummary(session, digestTeammateTranscript(raw), mtimeMs, nowMs, alive);
}

function digestTeammateTranscript(raw: string): TeammateDigest {
  const rows: Row[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as unknown;
      if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(o as Row);
    } catch { /* a half-written last line, or a foreign one */ }
  }

  let assigned = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].type === 'queue-operation' && rows[i].operation === 'enqueue') { assigned = i; break; }
  }
  const summary: TeammateDigest = { steps: [], exit: null, lastAnswer: null };
  if (assigned >= 0) {
    const brief = rows[assigned].content;
    if (typeof brief === 'string' && brief.trim()) summary.brief = cap(brief.trim(), TEAMMATE_TEXT_CAP);
    // The run began at its FIRST assignment, the spawn: a resume is new work for the same run,
    // and must not move its card after what followed the spawn or shrink its clock to one turn.
    const spawned = rows.find((r) => r.type === 'queue-operation' && r.operation === 'enqueue');
    summary.startedAt = ts(spawned?.timestamp) ?? ts(rows[assigned].timestamp);
  }

  const steps: TeammateStep[] = [];
  const stepAt = new Map<string, number>();
  let exit: Row | null = null;
  let lastAnswer: { text: string; clean: boolean } | null = null;
  for (let i = assigned + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.type === 'cost-state') { exit = row; continue; }
    const content = row.message?.content;
    if (row.type === 'assistant') {
      if (typeof row.message?.model === 'string' && row.message.model !== '<synthetic>') summary.model = row.message.model;
      const texts: string[] = [];
      let usedTool = false;
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text.trim());
          if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
            usedTool = true;
            stepAt.set(b.id, steps.length);
            steps.push({ toolUseId: b.id, name: b.name, input: capInput(b.input), status: 'running' });
          }
        }
      }
      if (texts.length) lastAnswer = { text: texts.join('\n\n'), clean: row.message?.stop_reason === 'end_turn' };
      else if (usedTool) lastAnswer = null;
      continue;
    }
    if (row.type === 'user' && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const at = stepAt.get(b.tool_use_id);
        if (at !== undefined) steps[at].status = b.is_error === true ? 'error' : 'done';
      }
    }
  }
  summary.steps = steps;
  summary.exit = exit;
  summary.lastAnswer = lastAnswer;
  return summary;
}

function finishSummary(
  session: string, d: TeammateDigest, mtimeMs: number, nowMs: number, alive: boolean | null,
): TeammateSummary {
  const summary: TeammateSummary = { session, status: 'running', steps: [], toolUses: 0, updatedAt: mtimeMs };
  if (d.brief !== undefined) summary.brief = d.brief;
  if (d.startedAt !== undefined) summary.startedAt = d.startedAt;
  if (d.model !== undefined) summary.model = d.model;
  const { exit, lastAnswer } = d;
  summary.toolUses = d.steps.length;
  // Copies: the digest may be cached, and a finished run's open steps are rewritten below.
  summary.steps = d.steps.slice(-TEAMMATE_STEP_CAP).map((s) => ({ ...s }));

  if (exit) {
    summary.endedAt = mtimeMs;
    if (typeof exit.totalDuration === 'number' && exit.totalDuration >= 0) summary.durationMs = exit.totalDuration;
    summary.status = lastAnswer?.clean ? 'done' : 'failed';
  } else if (alive === true) {
    summary.status = 'running';
  } else if (alive === false) {
    summary.status = 'stopped';
  } else {
    summary.status = nowMs - mtimeMs <= TEAMMATE_QUIET_MS ? 'running' : 'stopped';
  }
  // A step still open when the run is over did not finish.
  if (summary.status !== 'running') {
    for (const s of summary.steps) if (s.status === 'running') s.status = 'error';
  }
  if (lastAnswer && summary.status !== 'running') summary.result = cap(lastAnswer.text, TEAMMATE_TEXT_CAP);
  return summary;
}

// ─── Reading the file safely ─────────────────────────────────────────────────────

/**
 * The transcript of a registered teammate, read under the vault-content rules even though it
 * is not vault content: the id reaches us through a brain-synced, hand-editable live file, so
 * it is held to a strict UUID BEFORE the filesystem; the file is found by scanning the
 * projects dir (the cwd-slug is claude's business, and a worktree run lives under a different
 * one than the pane's); a symlink is refused (lstat); the real path must sit inside the real
 * projects dir; and only the tail up to {@link TEAMMATE_READ_CAP_BYTES} is read.
 */
export function readTeammateTranscript(session: string, home: string = homedir()): { raw: string; mtimeMs: number } | null {
  if (!TEAMMATE_SESSION_RE.test(session)) return null;
  const path = findTranscriptBySessionId([session], home);
  if (!path) return null;
  try {
    if (!lstatSync(path).isFile()) return null;
    const root = realpathSync(join(home, '.claude', 'projects'));
    const real = realpathSync(path);
    if (!real.startsWith(root + sep)) return null;
    const fd = openSync(real, 'r');
    try {
      const st = fstatSync(fd);
      const start = Math.max(0, st.size - TEAMMATE_READ_CAP_BYTES);
      const buf = Buffer.alloc(st.size - start);
      readSync(fd, buf, 0, buf.length, start);
      let raw = buf.toString('utf-8');
      // A tail read starts mid-line: drop the fragment rather than parse half a row.
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
      return { raw, mtimeMs: st.mtimeMs };
    } finally { closeSync(fd); }
  } catch {
    return null;
  }
}

/** Digests by real path, valid while the file's (size, mtime) are unchanged. The teammate list
 *  is polled every few seconds per pane; a finished run's transcript never changes again. */
const digests = new Map<string, { size: number; mtimeMs: number; digest: TeammateDigest }>();
const DIGEST_MAX = 128;
let digestReads = 0;

/**
 * {@link readTeammateTranscript} + {@link summarizeTeammateTranscript} for the polled list,
 * under the same file rules, read asynchronously and only when the file changed since the last
 * poll. Null when there is no readable transcript (the caller's "not on disk yet").
 */
export async function summarizeTeammateFile(
  session: string, nowMs: number, alive: boolean | null, home: string = homedir(),
): Promise<TeammateSummary | null> {
  if (!TEAMMATE_SESSION_RE.test(session)) return null;
  const path = findTranscriptBySessionId([session], home);
  if (!path) return null;
  try {
    if (!(await lstat(path)).isFile()) return null;
    const root = await realpath(join(home, '.claude', 'projects'));
    const real = await realpath(path);
    if (!real.startsWith(root + sep)) return null;
    const fh = await open(real, 'r');
    try {
      const st = await fh.stat();
      const hit = digests.get(real);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
        return finishSummary(session, hit.digest, st.mtimeMs, nowMs, alive);
      }
      const start = Math.max(0, st.size - TEAMMATE_READ_CAP_BYTES);
      const buf = Buffer.alloc(st.size - start);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
        if (bytesRead <= 0) break;
        got += bytesRead;
      }
      digestReads += 1;
      let raw = buf.toString('utf-8', 0, got);
      // A tail read starts mid-line: drop the fragment rather than parse half a row.
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
      const digest = digestTeammateTranscript(raw);
      digests.delete(real);
      digests.set(real, { size: st.size, mtimeMs: st.mtimeMs, digest });
      if (digests.size > DIGEST_MAX) digests.delete(digests.keys().next().value as string);
      return finishSummary(session, digest, st.mtimeMs, nowMs, alive);
    } finally { await fh.close().catch(() => {}); }
  } catch {
    return null;
  }
}

/** Tests only: how many transcripts {@link summarizeTeammateFile} has actually read, and a reset. */
export function teammateDigestReads(): number {
  return digestReads;
}
export function resetTeammateDigests(): void {
  digests.clear();
  digestReads = 0;
}

// ─── Is it still alive? ─────────────────────────────────────────────────────────

let psCache: { at: number; text: string | null } | null = null;
let psInFlight: Promise<string | null> | null = null;
/** One `ps` snapshot serves every pane's teammate poll for this long. */
const PS_TTL_MS = 5000;

/** The process table's command lines, one `ps` for every caller within {@link PS_TTL_MS}. */
function processTable(nowMs: number): Promise<string | null> {
  if (psCache && nowMs - psCache.at < PS_TTL_MS) return Promise.resolve(psCache.text);
  if (psInFlight) return psInFlight;
  psInFlight = new Promise<string | null>((resolve) => {
    execFile('ps', ['-axww', '-o', 'args='], { maxBuffer: 16 * 1024 * 1024, timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  }).then((text) => {
    psCache = { at: Date.now(), text };
    psInFlight = null;
    return text;
  });
  return psInFlight;
}

/**
 * Which of these runs still have a `claude` process. The id is in the process's own argv,
 * because the id is how it was started. Null for every id when the table cannot be read
 * (no `ps`: the caller falls back to how recently the transcript was written).
 */
export async function teammatesAlive(sessions: readonly string[], nowMs: number = Date.now()): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const table = sessions.length ? await processTable(nowMs) : null;
  const lines = table ? table.split('\n').filter((l) => /(?:^|[/\s])claude(?:\s|$)/.test(l)) : null;
  for (const id of sessions) out.set(id, lines ? lines.some((l) => l.includes(id)) : null);
  return out;
}

/** Tests only: forget the cached process table. */
export function resetTeammateProcessCache(): void {
  psCache = null;
  psInFlight = null;
}
