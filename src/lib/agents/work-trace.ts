/**
 * A member's past work (plan uye-gecmis-is, C1): one small record per real JOB, written by the
 * system, never by the agent's habit (pattern a-record-kept-by-habit-goes-stale).
 *
 * Two sources, one shape: a run (the runner, after its child ran) and a member CONVERSATION's
 * transcript. A chat job is derived from the transcript ONLY, by one rule ({@link classifyUserEntry}),
 * never at the sender: every frame any path writes into a member conversation lands in its
 * transcript, read in Claude's shape on all three tools (D3).
 *
 * Where it lives (D5), on this Mac only, never in a brain and never synced:
 *   global member   ~/.dreamcontext/agents/<slug>/work/
 *   project member  ~/.dreamcontext/local/<projectKey>/work/<slug>/
 * Traces under `<YYYY-MM>/<md5(key)>.json`, one cursor and one lock per transcript under
 * `cursors/`, and `gen.log` (one line per write, drop or rename, read by the server's index).
 * 0600 files, 0700 dirs; every path is checked (G1): safe slug, safe names, no links, contained.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { acquireFileLockWithin, releaseFileLock } from '../file-lock.js';
import { dropAgentWork, localDir, projectKey, listAgentSessions } from '../local-store.js';
import { isInjectedUserRecord, isSystemNoiseMessage } from '../transcript-records.js';
import { isServerContinuationText, SUPER_BIRTH_OPENINGS, APP_BRIEF_OPENINGS } from '../usage-readers.js';
import { findTranscriptBySessionId, isSafeSessionId } from '../transcript-locate.js';
import { findCodexRollout, CODEX_THREAD_RE } from '../t3-bridge/codex-threads.js';
import { antigravityTranscriptsDir } from '../antigravity-conversation.js';
import { isCodexRollout, readTranscriptText } from '../codex-rollout.js';
import { globalAgentHome, memberScope, type MemberScope } from './scope.js';
import { isSafeAutomationSlug } from './slot.js';

// ─── Shape (D2) ─────────────────────────────────────────────────────────────

export type AskBy = 'owner' | 'super' | 'window' | 'app' | 'schedule' | 'server';
export interface TraceAsk { by: AskBy; text: string }
export type TraceStatus = 'ok' | 'failed' | 'interrupted';

export interface WorkTrace {
  v: 1;
  /** md5 of `key`, 32 hex: the file name. */
  id: string;
  /** `<transcript id>:<ask entry uuid or hash>` for a chat job; `run:<slug>:<fire ISO>` for a run. */
  key: string;
  kind: 'run' | 'job';
  /** The job's opening time (ISO). */
  at: string;
  project: { key: string; name: string; root: string };
  asks: TraceAsk[];
  /** The latest reply that is not a refusal (head and tail, ≤ 900 chars). */
  did: string;
  /** Paths its tool calls wrote or edited, over the whole job (≤ 1,200 chars). */
  files: string[];
  status: TraceStatus;
  /** How far the source was read: a transcript byte offset; a run's end time (ms). */
  through: number;
  /** The transcript this job is in (chat jobs). */
  transcript?: string;
  /** A run's published document (≤ 900 chars). */
  document?: string;
  /** A run's karne key (a later rating join is a lookup). */
  runKey?: string;
  /** The app a run served (an app run sees only its own app's runs). */
  app?: string;
}

export const ASK_MAX_CHARS = 600;
export const DID_MAX_CHARS = 900;
export const FILES_MAX_CHARS = 1_200;
const TRACE_NAME_RE = /^[0-9a-f]{32}\.json$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const GEN_LINE_MAX = 511;

// ─── Bounds (by bytes and code points, never a count) ─────────────────────

/** At most `max` code points: the head, ' … ', the tail. Never cuts a surrogate pair. */
export function headTail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cps = Array.from(flat);
  if (cps.length <= max) return flat;
  const keep = Math.max(0, max - 3);
  const head = Math.ceil(keep * 0.6);
  return `${cps.slice(0, head).join('')} … ${cps.slice(cps.length - (keep - head)).join('')}`;
}

function capText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cps = Array.from(flat);
  return cps.length <= max ? flat : `${cps.slice(0, max - 1).join('')}…`;
}

/** Files unioned in order, until the joined list would pass {@link FILES_MAX_CHARS}. */
function boundFiles(files: readonly string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const f of files) {
    if (!f || out.includes(f)) continue;
    const cost = f.length + 2;
    if (used + cost > FILES_MAX_CHARS) break;
    out.push(f);
    used += cost;
  }
  return out;
}

export function traceId(key: string): string {
  return createHash('md5').update(key, 'utf8').digest('hex');
}

// ─── Reading a transcript (D3) ──────────────────────────────────────────────

type Rec = Record<string, unknown>;

/** One transcript line, parsed, with where it ends in the text that was read. */
export interface TranscriptRecord { rec: Rec; end: number }

/** Parse JSONL text into records, each with its end offset (+ `base`). A bad line is skipped. */
export function parseRecords(text: string, base = 0): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  let at = 0;
  const bytes = Buffer.from(text, 'utf-8');
  while (at < bytes.length) {
    let nl = bytes.indexOf(0x0a, at);
    if (nl < 0) nl = bytes.length;
    const line = bytes.subarray(at, nl).toString('utf-8').trim();
    const end = base + nl + 1;
    at = nl + 1;
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as unknown;
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) out.push({ rec: rec as Rec, end: Math.min(end, base + bytes.length) });
    } catch { /* a torn last line: read again next time */ }
  }
  return out;
}

const contentOf = (rec: Rec): unknown => (rec.message as { content?: unknown } | undefined)?.content ?? rec.content;
const roleOf = (rec: Rec): string => {
  if (typeof rec.type === 'string' && (rec.type === 'user' || rec.type === 'assistant')) return rec.type;
  const m = rec.message as { role?: unknown } | undefined;
  return typeof m?.role === 'string' ? m.role : String(rec.type ?? '');
};
const tsOf = (rec: Rec): number | null => {
  const t = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : typeof rec.timestamp === 'number' ? rec.timestamp : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The entry's own text: the string content, or the FIRST text block (what was sent). */
function entryText(content: unknown): { text: string; image: boolean } {
  if (typeof content === 'string') return { text: content, image: false };
  if (!Array.isArray(content)) return { text: '', image: false };
  let text: string | null = null;
  let image = false;
  for (const b of content) {
    if (typeof b === 'string') { if (text === null) text = b; continue; }
    if (!b || typeof b !== 'object') continue;
    const block = b as { type?: unknown; text?: unknown };
    if (block.type === 'image') image = true;
    if (block.type === 'text' && typeof block.text === 'string' && text === null) text = block.text;
  }
  return { text: text ?? '', image };
}

const hasToolResult = (content: unknown): boolean =>
  Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result');

const PROVENANCE_FIELDS = ['isMeta', 'promptSource', 'turnOrigin', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'entrypoint', 'origin'];
const LOCAL_COMMAND_RE = /^\s*<(local-command-(stdout|stderr|caveat))>/;
const INTERRUPT_RE = /^\s*\[Request interrupted/;

/** A prompt entry: one user frame that may open, join or leave a job. */
export interface PromptEntry {
  /** Index of its record in the records list. */
  index: number;
  /** `uuid`, or a hash of time + text + occurrence for an entry with none. */
  id: string;
  /** Byte offset where its record starts (the previous record's end). */
  start: number;
  at: number | null;
  text: string;
  image: boolean;
  /** A folded steer (`attachment{type:'queued_command'}`). */
  steer: boolean;
  /** `<command-name>`: the command's name and arguments. */
  command: { name: string; args: string } | null;
}

function commandOf(text: string): { name: string; args: string } | null {
  const m = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text);
  if (!m) return null;
  const a = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  return { name: m[1]!, args: (a?.[1] ?? '').trim() };
}

/** The prompt text of a folded steer, or null (none, or a task notification). */
function steerText(rec: Rec): string | null {
  const att = rec.attachment as { type?: unknown; prompt?: unknown } | undefined;
  if (rec.type !== 'attachment' || !att || att.type !== 'queued_command') return null;
  const { text } = entryText(att.prompt);
  if (/<\/?task-notification\b/.test(text)) return null;
  return text.trim() ? text : null;
}

/**
 * The transcript's PROMPT entries, chosen by record fields first (D3): a `type: 'user'` record
 * that is not a sidechain, a tool result, an injected record, nor a local-command caveat or stdout;
 * plus folded steers. Only for a record with NO provenance field does the text fallback apply.
 */
export function promptEntries(records: readonly TranscriptRecord[], base = 0): PromptEntry[] {
  const out: PromptEntry[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!.rec;
    const start = i === 0 ? base : records[i - 1]!.end;
    const steer = steerText(rec);
    let text: string;
    let image = false;
    if (steer !== null) {
      text = steer;
    } else {
      if (roleOf(rec) !== 'user' || (rec.type !== undefined && rec.type !== 'user')) continue;
      if (rec.isSidechain === true || rec.toolUseResult !== undefined) continue;
      const content = contentOf(rec);
      if (hasToolResult(content)) continue;
      if (isInjectedUserRecord(rec) || rec.isSynthetic === true) continue;
      const t = entryText(content);
      text = t.text;
      image = t.image;
      if (LOCAL_COMMAND_RE.test(text) || INTERRUPT_RE.test(text)) continue;
      const provenance = PROVENANCE_FIELDS.some((f) => rec[f] !== undefined);
      if (!provenance && !image && isSystemNoiseMessage(text)) continue;
      if (!text.trim() && !image) continue;
    }
    const at = tsOf(rec);
    let id = typeof rec.uuid === 'string' && rec.uuid ? rec.uuid : '';
    if (!id) {
      const base0 = `${at ?? ''}\0${text}`;
      const n = (seen.get(base0) ?? 0) + 1;
      seen.set(base0, n);
      id = `h${createHash('sha1').update(`${base0}\0${n}`, 'utf8').digest('hex').slice(0, 20)}`;
    }
    out.push({ index: i, id, start, at, text, image, steer: steer !== null, command: steer !== null ? null : commandOf(text) });
  }
  return out;
}

// ─── Written paths (one extractor for every source) ───────────────────────

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Every path a tool call wrote or edited, in order, deduplicated. Claude, run and Codex frames alike. */
export function toolWrites(frames: readonly Rec[]): string[] {
  const out: string[] = [];
  const add = (p: unknown) => { if (typeof p === 'string' && p.trim() && !out.includes(p.trim())) out.push(p.trim()); };
  for (const f of frames) {
    const content = (f.message as { content?: unknown } | undefined)?.content ?? f.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const block = b as { type?: unknown; name?: unknown; input?: Record<string, unknown> };
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
      const input = block.input ?? {};
      if (WRITE_TOOLS.has(block.name)) add(input.file_path ?? input.notebook_path ?? input.path);
      else if (block.name === 'apply_patch' || typeof input.patch === 'string') {
        const raw = String(input.patch ?? input.input ?? '');
        for (const m of raw.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(m[1]);
      }
    }
  }
  return out;
}

// ─── What one segment did ─────────────────────────────────────────────────

interface SegmentWork {
  /** Any assistant reaction (text, thinking, tool call, refusal) before the first injected record. */
  worked: boolean;
  /** Assistant texts that are not refusals, in order. */
  replies: string[];
  files: string[];
  /** Ends on a tool call or an interrupt with no reply after. */
  interrupted: boolean;
  /** Work after the first injected record (the CLI's own turn after a notification). */
  tail: { replies: string[]; files: string[]; interrupted: boolean } | null;
  end: number;
  lastAt: number | null;
}

function isRefusal(rec: Rec): boolean {
  if (rec.isApiErrorMessage === true || rec.is_api_error_message === true || rec.error !== undefined) return true;
  const { text } = entryText(contentOf(rec));
  return /^\s*API Error\b/.test(text);
}

function assistantBlocks(rec: Rec): { text: string; tool: boolean; any: boolean } {
  const content = contentOf(rec);
  if (typeof content === 'string') return { text: content, tool: false, any: content.trim() !== '' };
  if (!Array.isArray(content)) return { text: '', tool: false, any: false };
  let text = '';
  let tool = false;
  let any = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as { type?: unknown; text?: unknown; thinking?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') { text += `${block.text}\n`; if (block.text.trim()) any = true; }
    else if (block.type === 'tool_use') { tool = true; any = true; }
    else if (block.type === 'thinking' || block.type === 'redacted_thinking') any = true;
  }
  return { text: text.trim(), tool, any };
}

function segmentWork(records: readonly TranscriptRecord[], from: number, to: number): SegmentWork {
  const head = { replies: [] as string[], files: [] as string[], interrupted: false };
  let tail: SegmentWork['tail'] = null;
  let part = head;
  let worked = false;
  let lastAt: number | null = null;
  for (let i = from + 1; i < to; i++) {
    const rec = records[i]!.rec;
    const t = tsOf(rec);
    if (t !== null) lastAt = t;
    if (roleOf(rec) === 'user' && rec.type !== 'attachment') {
      const content = contentOf(rec);
      if (!hasToolResult(content) && rec.toolUseResult === undefined && isInjectedUserRecord(rec) && !tail && rec.isMeta !== true) {
        tail = { replies: [], files: [], interrupted: false };
        part = tail;
        continue;
      }
      const { text } = entryText(content);
      if (INTERRUPT_RE.test(text)) part.interrupted = true;
      continue;
    }
    if (roleOf(rec) !== 'assistant' || rec.isSidechain === true) continue;
    const b = assistantBlocks(rec);
    if (part === head && (b.any || isRefusal(rec))) worked = true;
    if (isRefusal(rec)) continue;
    if (b.text) { part.replies.push(b.text); part.interrupted = false; }
    else if (b.tool) part.interrupted = true;
    for (const f of toolWrites([rec])) if (!part.files.includes(f)) part.files.push(f);
  }
  return { worked, replies: head.replies, files: head.files, interrupted: head.interrupted, tail, end: records[to - 1]?.end ?? 0, lastAt };
}

// ─── The one rule (D3) ──────────────────────────────────────────────────

export type EntryClass = 'ask' | 'continuation' | 'none';

const EVENTS_HEAD = '[super events]';
const REQUEST_TEXT_RE = /Super Agent'tan: ([\s\S]*?)<\/untrusted-project-output>/g;

/** A `[super events]` batch: its request texts, and whether it carries a request or a reply item. */
function superBatch(text: string): { requests: string[]; reply: boolean } | null {
  if (!text.trimStart().startsWith(EVENTS_HEAD)) return null;
  const requests: string[] = [];
  if (/^- item=\S+ event=request\b/m.test(text)) {
    for (const m of text.matchAll(REQUEST_TEXT_RE)) if (m[1]!.trim()) requests.push(m[1]!.trim());
    if (requests.length === 0) requests.push('a request from the Super Agent');
  }
  return { requests, reply: /^- item=\S+ event=reply\b/m.test(text) };
}

export interface OpenJobView { lastAsk: string; repliedSinceLastAsk: boolean }

/**
 * One prompt entry's class, in D3's precedence:
 *   1. `none` by what followed it (no assistant reaction), or a pure `[super events]` batch;
 *   2. `ask` when it is the transcript's first non-none entry;
 *   3. `continuation`: a server text, a folded steer, a Super reply batch, a resubmit of the open
 *      job's last ask with no reply between;
 *   4. `ask` for everything else that worked.
 */
export function classifyUserEntry(
  entry: Pick<PromptEntry, 'text' | 'steer'>,
  ctx: { openJob: OpenJobView | null; first: boolean; segmentWorked: boolean },
): EntryClass {
  const text = entry.text.trimStart();
  if (entry.steer) return 'continuation';
  if (!ctx.segmentWorked) return 'none';
  const batch = superBatch(text);
  if (batch && batch.requests.length === 0 && !batch.reply) return 'none';
  if (ctx.first) return 'ask';
  if (batch && batch.requests.length === 0) return 'continuation';
  if (!batch && isServerContinuationText(text)) return 'continuation';
  if (ctx.openJob && !ctx.openJob.repliedSinceLastAsk
    && ctx.openJob.lastAsk === capText(askTextOf({ text: entry.text, command: commandOf(entry.text) }), ASK_MAX_CHARS)) return 'continuation';
  return 'ask';
}

/** The server's blocks after the sent text: never part of an ask or a query. */
const SERVER_BLOCK_CUT = /(^|\n)\s*(<super-|<owner-|\[super (?!events|schedule))/;
const MACHINE_BLOCK_RE = /<task-notification>[\s\S]*?(?:<\/task-notification>|$)|<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;

function askTextOf(entry: Pick<PromptEntry, 'text' | 'command'>): string {
  if (entry.command) return entry.command.args || `/${entry.command.name}`;
  let text = entry.text;
  const cut = SERVER_BLOCK_CUT.exec(text);
  if (cut && cut.index > 0) text = text.slice(0, cut.index);
  const at = text.indexOf('<owner-msg');
  if (at > 0) text = text.slice(0, at);
  return text.replace(MACHINE_BLOCK_RE, ' ').trim();
}

/**
 * The hook's half of the rule (D3, D8): what a member chat turn searches on, or null. It cannot
 * see a segment, so it never knows `none` by outcome: it skips a pure event batch, a server text
 * and a bare command name; a command searches on its arguments (two words at least); a path-led
 * message keeps its whole text.
 */
export function hookQueryOf(prompt: string): string | null {
  const text = String(prompt ?? '').trimStart();
  if (!text) return null;
  const batch = superBatch(text);
  if (batch) return batch.requests.length > 0 && !batch.requests[0]!.startsWith('a request from') ? capText(batch.requests.join(' '), 2_000) : null;
  if (isServerContinuationText(text)) return null;
  const command = commandOf(text);
  const slash = !command && /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.split('\n')[0]!.trim());
  const isPath = /^\/[^\s/]+\/\S*/.test(text);
  if (command || (slash && !isPath)) {
    const args = command ? command.args : (slash ? (slash[2] ?? '') : '');
    return args.trim().split(/\s+/).filter(Boolean).length >= 2 ? capText(args, 2_000) : null;
  }
  const q = askTextOf({ text, command: null }).replace(/\s+/g, ' ').trim();
  return q.length >= 3 ? capText(q, 2_000) : null;
}

// ─── Deriving jobs from records ────────────────────────────────────────

export interface DeriveOptions {
  transcriptId: string;
  project: WorkTrace['project'];
  /** A run's own session: entries before `chatFrom` are the run's (traced by the runner). */
  runSession?: boolean;
  chatFrom?: number | null;
  /** Byte offset of the transcript's real first non-none entry, when already known (a resumed read). */
  firstAt?: number | null;
  /** Texts the owner-words ledger holds for this conversation (the `by: owner` label). */
  ownerTexts?: ReadonlySet<string>;
  /** Month for an entry with no time (kept in the cursor). */
  fallbackMonth?: string;
  /** The handoff record's title, for a stage's handoff first entry that names no task. */
  handoffTitle?: string | null;
}

export interface DerivedJobs {
  traces: WorkTrace[];
  /** Where the next read starts: the last job's ask, or an unclosed none entry. */
  resumeAt: number;
  /** The real first non-none entry's offset (null: none seen yet). */
  firstAt: number | null;
  end: number;
}

const HANDOFF_PREFIX = 'Handoff: ';

function byOf(text: string, first: boolean, owner: ReadonlySet<string> | undefined): AskBy {
  const t = text.trimStart();
  if (t.startsWith(EVENTS_HEAD)) return 'super';
  if (t.startsWith('[super schedule]')) return 'schedule';
  if (SUPER_BIRTH_OPENINGS.some((p) => t.startsWith(p))) return 'super';
  if (APP_BRIEF_OPENINGS.some((p) => t.startsWith(p))) return 'app';
  if (first && isServerContinuationText(t)) return 'server';
  if (owner && owner.has(t.trim())) return 'owner';
  return 'window';
}

interface OpenJob {
  key: string;
  at: number | null;
  askStart: number;
  asks: TraceAsk[];
  replies: string[];
  files: string[];
  interrupted: boolean;
  repliedSinceLastAsk: boolean;
  through: number;
}

function monthOf(ms: number | null, fallback: string): string {
  if (ms === null) return fallback;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Cut the records into segments and apply the rule (pure). A job exists only for work: a reply
 * text or a written file (D1). `base`: the byte offset `records` start at.
 */
export function deriveJobs(records: readonly TranscriptRecord[], opts: DeriveOptions, base = 0): DerivedJobs {
  const entries = promptEntries(records, base);
  const jobs: OpenJob[] = [];
  let open: OpenJob | null = null;
  let firstAt = opts.firstAt ?? null;
  let resumeAt = records.length ? records[records.length - 1]!.end : base;
  let trailingNone: number | null = null;

  const addWork = (job: OpenJob, w: { replies: string[]; files: string[]; interrupted: boolean }, end: number) => {
    if (w.replies.length) { job.replies.push(...w.replies); job.repliedSinceLastAsk = true; job.interrupted = w.interrupted; }
    else if (w.interrupted) job.interrupted = true;
    for (const f of w.files) if (!job.files.includes(f)) job.files.push(f);
    job.through = Math.max(job.through, end);
  };

  for (let n = 0; n < entries.length; n++) {
    const e = entries[n]!;
    const nextIndex = n + 1 < entries.length ? entries[n + 1]!.index : records.length;
    const seg = segmentWork(records, e.index, nextIndex);
    const closed = n + 1 < entries.length;
    // A run's own session: the run's part is the runner's.
    if (opts.runSession && (opts.chatFrom == null || e.at === null || e.at < opts.chatFrom)) continue;
    const isFirst = !opts.runSession && (firstAt === null || e.start === firstAt);
    const cls = classifyUserEntry(e, {
      openJob: open ? { lastAsk: open.asks[open.asks.length - 1]?.text ?? '', repliedSinceLastAsk: open.repliedSinceLastAsk } : null,
      first: isFirst,
      segmentWorked: seg.worked,
    });
    if (cls === 'none') {
      if (!closed && trailingNone === null) trailingNone = e.start;
      if (open && seg.tail) addWork(open, seg.tail, seg.end);
      continue;
    }
    if (firstAt === null && !opts.runSession) firstAt = e.start;
    if (cls === 'continuation') {
      if (!open) continue;
      if (e.steer) open.asks.push({ by: byOf(e.text, false, opts.ownerTexts), text: capText(askTextOf(e), ASK_MAX_CHARS) });
      const recap = e.text.trimStart().startsWith('[super recap]');
      addWork(open, recap ? { ...seg, replies: [] } : seg, seg.end);
      if (seg.tail) addWork(open, seg.tail, seg.end);
      continue;
    }
    // An ask opens a job.
    const batch = superBatch(e.text);
    let asks: TraceAsk[];
    if (batch && batch.requests.length) asks = batch.requests.map((t) => ({ by: 'super' as const, text: capText(t, ASK_MAX_CHARS) }));
    else {
      let text = askTextOf(e);
      if (!text && e.image) text = '(a picture)';
      if (e.text.startsWith(HANDOFF_PREFIX) && opts.handoffTitle) text = `${opts.handoffTitle}: ${text}`;
      asks = [{ by: byOf(e.text, isFirst, opts.ownerTexts), text: capText(text, ASK_MAX_CHARS) }];
    }
    open = {
      key: `${opts.transcriptId}:${e.id}`, at: e.at, askStart: e.start, asks, replies: [], files: [],
      interrupted: false, repliedSinceLastAsk: false, through: e.start,
    };
    jobs.push(open);
    addWork(open, seg, seg.end);
    if (seg.tail) addWork(open, seg.tail, seg.end);
  }

  if (open) resumeAt = open.askStart;
  if (trailingNone !== null && trailingNone < resumeAt) resumeAt = trailingNone;
  if (jobs.length === 0 && trailingNone !== null) resumeAt = trailingNone;

  const traces: WorkTrace[] = [];
  for (const j of jobs) {
    const did = j.replies.length ? headTail(j.replies[j.replies.length - 1]!, DID_MAX_CHARS) : '';
    const files = boundFiles(j.files);
    if (!did && files.length === 0) continue; // not work (D1)
    traces.push({
      v: 1, id: traceId(j.key), key: j.key, kind: 'job',
      at: j.at !== null ? new Date(j.at).toISOString() : `${opts.fallbackMonth ?? monthOf(Date.now(), '')}-01T00:00:00.000Z`,
      project: opts.project, asks: j.asks, did, files,
      status: j.interrupted ? 'interrupted' : 'ok', through: j.through, transcript: opts.transcriptId,
    });
  }
  return { traces, resumeAt, firstAt, end: records.length ? records[records.length - 1]!.end : base };
}

// ─── Where a member's work lives (D5, G1) ─────────────────────────────

export interface MemberRef { slug: string; scope: MemberScope }

/** The member's work root, or null for an unsafe slug or a member that is not here. */
export function workRoot(slug: string, projectRoot: string, home: string = homedir(), scope?: MemberScope | null): string | null {
  if (!isSafeAutomationSlug(slug)) return null;
  const s = scope ?? memberScope(join(projectRoot, '_dream_context'), slug, home);
  if (s === 'global') return join(globalAgentHome(slug, home), 'work');
  if (s === 'project') return join(localDir(projectRoot, home), 'work', slug);
  return null;
}

/** The folder a work root must sit in, never created here (a member home, a project local dir). */
function rootParent(root: string, scope: MemberScope): string {
  return scope === 'global' ? dirname(root) : dirname(dirname(root));
}

function isLinkOrMissing(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return true; }
}

/** `abs` resolves inside `root` (both realpath'd), never through a link. */
export function containedIn(root: string, abs: string): boolean {
  try {
    const r = realpathSync(root);
    const a = realpathSync(abs);
    const rel = relative(r, a);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
  } catch { return false; }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: false, mode: 0o700 });
}

/** Make `root` and `leaf` under it, never the parent; every step must not be a link. */
function ensureUnder(root: string, scope: MemberScope, leaf: string | null): boolean {
  const parent = rootParent(root, scope);
  if (isLinkOrMissing(parent)) return false;
  if (scope === 'project') {
    const workDir = dirname(root);
    if (!existsSync(workDir)) { try { ensureDir(workDir); } catch { /* raced */ } }
    if (isLinkOrMissing(workDir)) return false;
  }
  if (!existsSync(root)) { try { ensureDir(root); } catch { /* raced */ } }
  if (isLinkOrMissing(root) || !lstatSync(root).isDirectory()) return false;
  if (leaf) {
    const dir = join(root, leaf);
    if (!existsSync(dir)) { try { ensureDir(dir); } catch { /* raced */ } }
    if (isLinkOrMissing(dir) || !containedIn(root, dir)) return false;
  }
  return true;
}

let loggedUnreadable = new Set<string>();
function logOnce(what: string, err: unknown): void {
  if (loggedUnreadable.has(what)) return;
  loggedUnreadable.add(what);
  if (process.env.DREAMCONTEXT_DEBUG) console.error(`[work-trace] ${what}: ${(err as Error)?.message ?? err}`);
}
export function _resetWorkTraceLog(): void { loggedUnreadable = new Set(); }

// ─── gen.log ────────────────────────────────────────────────────────

export interface GenLine { m?: string; n?: string; op?: 'drop' | 'rename'; to?: string }

export function genLogPath(root: string): string { return join(root, 'gen.log'); }

/** Append one line (O_APPEND, < 512 bytes). Never throws. */
export function appendGen(root: string, line: GenLine): void {
  try {
    const p = genLogPath(root);
    if (existsSync(p) && isLinkOrMissing(p)) return;
    const text = JSON.stringify(line).slice(0, GEN_LINE_MAX);
    const fd = openSync(p, 'a', 0o600);
    try { writeSync(fd, `${text}\n`); } finally { closeSync(fd); }
  } catch (e) { logOnce('gen.log', e); }
}

// ─── Store ──────────────────────────────────────────────────────────

function tracePath(root: string, month: string, id: string): string {
  return join(root, month, `${id}.json`);
}

/** Read one trace file, or null (missing, a link, outside the root, not a trace). */
export function readTraceFile(root: string, file: string): WorkTrace | null {
  try {
    if (!TRACE_NAME_RE.test(basename(file)) || !MONTH_RE.test(basename(dirname(file)))) return null;
    const st = lstatSync(file);
    if (!st.isFile()) return null;
    if (!containedIn(root, file)) return null;
    const t = JSON.parse(readFileSync(file, 'utf-8')) as WorkTrace;
    return t && t.v === 1 && typeof t.key === 'string' && t.id === basename(file, '.json') ? t : null;
  } catch (e) { logOnce(file, e); return null; }
}

/** Every trace file of a root: `[month, name]`. */
export function listTraceFiles(root: string): Array<{ month: string; name: string }> {
  const out: Array<{ month: string; name: string }> = [];
  let months: string[];
  try { if (isLinkOrMissing(root)) return out; months = readdirSync(root).filter((m) => MONTH_RE.test(m)).sort(); } catch { return out; }
  for (const m of months) {
    const dir = join(root, m);
    if (isLinkOrMissing(dir)) continue;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) if (TRACE_NAME_RE.test(n)) out.push({ month: m, name: n });
  }
  return out;
}

export interface WriteTarget { slug: string; projectRoot: string; home?: string }

/** The member's current scope here; a renamed project member's new slug when a rename line names it. */
function liveScope(t: WriteTarget): { slug: string; scope: MemberScope; root: string } | null {
  const home = t.home ?? homedir();
  const ctx = join(t.projectRoot, '_dream_context');
  let slug = t.slug;
  let scope = memberScope(ctx, slug, home);
  if (!scope) {
    // A writer that finds its member renamed writes under the new name.
    const old = join(localDir(t.projectRoot, home), 'work', `.renamed-${slug}`);
    try {
      if (lstatSync(old).isFile()) {
        const to = readFileSync(old, 'utf-8').trim();
        if (isSafeAutomationSlug(to) && memberScope(ctx, to, home) === 'project') { slug = to; scope = 'project'; }
      }
    } catch { /* not renamed */ }
  }
  if (!scope) return null;
  const root = workRoot(slug, t.projectRoot, home, scope);
  return root ? { slug, scope, root } : null;
}

/**
 * Write one trace (async, fail-open). Creates `work/` and its month only under an existing member
 * home or project local dir; re-checks the member right before the rename (a member deleted
 * meanwhile gets nothing); never replaces a trace whose stored `through` is ahead; appends to
 * `gen.log`. True when written.
 */
export async function writeTrace(target: WriteTarget, trace: WorkTrace): Promise<boolean> {
  try {
    if (!TRACE_NAME_RE.test(`${trace.id}.json`) || trace.id !== traceId(trace.key)) return false;
    const month = MONTH_RE.test(trace.at.slice(0, 7)) ? trace.at.slice(0, 7) : null;
    if (!month) return false;
    let live = liveScope(target);
    if (!live || !ensureUnder(live.root, live.scope, month)) return false;
    const file = tracePath(live.root, month, trace.id);
    const existing = readTraceFile(live.root, file);
    if (existing && existing.through > trace.through) return false;
    if (existing && JSON.stringify(existing) === JSON.stringify(trace)) return true;
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(trace), { encoding: 'utf-8', mode: 0o600 });
    live = liveScope(target);
    if (!live || !containedIn(live.root, dirname(file))) { rmSync(tmp, { force: true }); return false; }
    const again = readTraceFile(live.root, file);
    if (again && again.through > trace.through) { rmSync(tmp, { force: true }); return false; }
    await rename(tmp, file);
    appendGen(live.root, { m: month, n: trace.id });
    return true;
  } catch (e) { logOnce('write', e); return false; }
}

/** Every trace of a member (reading the files: the slow path, never on the hot path). */
export function readAllTraces(root: string): WorkTrace[] {
  const out: WorkTrace[] = [];
  for (const f of listTraceFiles(root)) {
    const t = readTraceFile(root, join(root, f.month, f.name));
    if (t) out.push(t);
  }
  return out;
}

// ─── Lifecycle (C7) ────────────────────────────────────────────────

/** A member's work dies with it: its folder goes (local-store owns the death). A global member's goes with its home. */
export function dropMemberWork(slug: string, projectRoot: string, home: string = homedir()): void {
  dropAgentWork(projectRoot, slug, home);
}

/** A renamed project member keeps its traces: the folder moves, and a note names the new slug. */
export function renameMemberWork(from: string, to: string, projectRoot: string, home: string = homedir()): void {
  if (!isSafeAutomationSlug(from) || !isSafeAutomationSlug(to)) return;
  const base = join(localDir(projectRoot, home), 'work');
  const src = join(base, from);
  const dst = join(base, to);
  try {
    if (!lstatSync(src).isDirectory() || existsSync(dst)) return;
    appendGen(src, { op: 'rename', to });
    renameSync(src, dst);
    try { const tmp = join(base, `.renamed-${from}.tmp`); writeFileSyncSafe(tmp, to); renameSync(tmp, join(base, `.renamed-${from}`)); } catch { /* the move is what matters */ }
  } catch { /* nothing to move */ }
}

function writeFileSyncSafe(p: string, text: string): void {
  const fd = openSync(p, 'w', 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

// ─── Transcripts of a member (D4) ────────────────────────────────

export type TranscriptTool = 'claude' | 'codex' | 'antigravity';

export interface TranscriptCursor {
  v: 1;
  tool: TranscriptTool;
  /** The pin or pane the transcript came from (a label). */
  pin?: string;
  project: WorkTrace['project'];
  /** The first member-chat init's time on this transcript (ms). */
  chatFrom?: number | null;
  /** Where the next read starts (Claude only; a converted file is re-read whole). */
  from?: number;
  firstAt?: number | null;
  /** The month a key with no time is filed under. */
  month?: string;
  /** The file size last derived (a moved transcript is derived again). */
  size?: number;
  mtimeMs?: number;
}

export function cursorPath(root: string, transcriptId: string): string | null {
  return isSafeSessionId(transcriptId) ? join(root, 'cursors', `${transcriptId}.json`) : null;
}

export function readCursor(root: string, transcriptId: string): TranscriptCursor | null {
  const p = cursorPath(root, transcriptId);
  if (!p) return null;
  try {
    if (!lstatSync(p).isFile() || !containedIn(root, p)) return null;
    const c = JSON.parse(readFileSync(p, 'utf-8')) as TranscriptCursor;
    return c && c.v === 1 ? c : null;
  } catch { return null; }
}

async function writeCursor(target: WriteTarget, transcriptId: string, cursor: TranscriptCursor): Promise<boolean> {
  const live = liveScope(target);
  if (!live || !ensureUnder(live.root, live.scope, 'cursors')) return false;
  const p = cursorPath(live.root, transcriptId);
  if (!p) return false;
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(cursor), { encoding: 'utf-8', mode: 0o600 });
    if (!liveScope(target)) { rmSync(tmp, { force: true }); return false; }
    await rename(tmp, p);
    return true;
  } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* gone */ } logOnce('cursor', e); return false; }
}

const projectRef = (projectRoot: string): WorkTrace['project'] => ({ key: projectKey(projectRoot), name: basename(projectRoot), root: projectRoot });

/**
 * C4(b): a MAIN `system:init` of a member chat names a transcript. Its cursor is written once
 * (tool, pin, project, `chatFrom`), through the member check: a deleted member's open chat
 * recreates nothing.
 */
export async function noteTranscript(
  target: WriteTarget,
  transcriptId: string,
  info: { tool: TranscriptTool; pin?: string; at?: number },
): Promise<boolean> {
  if (!isSafeSessionId(transcriptId)) return false;
  const live = liveScope(target);
  if (!live) return false;
  if (readCursor(live.root, transcriptId)) return true;
  const now = info.at ?? Date.now();
  return writeCursor(target, transcriptId, {
    v: 1, tool: info.tool, ...(info.pin ? { pin: info.pin } : {}), project: projectRef(target.projectRoot),
    chatFrom: now, month: monthOf(now, ''),
  });
}

export interface LocatedTranscript { id: string; tool: TranscriptTool; path: string }

/** One transcript by its OWN id (never through a pin map). */
export function locateTranscript(id: string, tool: TranscriptTool | null, home: string = homedir()): LocatedTranscript | null {
  if (!isSafeSessionId(id)) return null;
  if (tool === 'codex' || (tool === null && CODEX_THREAD_RE.test(id) && !findTranscriptBySessionId([id], home))) {
    const p = findCodexRollout(id, join(home, '.codex'));
    if (p) return { id, tool: 'codex', path: p };
    if (tool === 'codex') return null;
  }
  if (tool === 'antigravity') {
    const p = join(antigravityTranscriptsDir(home), `${id}.jsonl`);
    return existsSync(p) ? { id, tool, path: p } : null;
  }
  const p = findTranscriptBySessionId([id], home);
  if (!p) return null;
  return { id, tool: p.startsWith(antigravityTranscriptsDir(home)) ? 'antigravity' : 'claude', path: p };
}

/** The ids C4(b) noted for a member (its cursors). */
function cursorIds(root: string): string[] {
  try {
    const dir = join(root, 'cursors');
    if (isLinkOrMissing(dir)) return [];
    return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => isSafeSessionId(id));
  } catch { return []; }
}

/**
 * D4's set of one member's transcripts in one project, each located by its own id: every id the
 * session index lists, every id a cursor noted, and an old pin's current successor.
 */
export function transcriptsOf(
  slug: string,
  projectRoot: string,
  opts: { home?: string; successor?: (id: string) => string | null } = {},
): LocatedTranscript[] {
  const home = opts.home ?? homedir();
  const root = workRoot(slug, projectRoot, home);
  const ids = new Map<string, TranscriptTool | null>();
  for (const e of listAgentSessions(projectRoot, slug, home)) ids.set(e.id, null);
  if (root) {
    for (const id of cursorIds(root)) {
      const c = readCursor(root, id);
      if (c && c.project.key !== projectKey(projectRoot)) continue;
      ids.set(id, c?.tool ?? null);
    }
  }
  if (opts.successor) {
    for (const id of [...ids.keys()]) {
      try { const s = opts.successor(id); if (s && s !== id && !ids.has(s)) ids.set(s, null); } catch { /* no map */ }
    }
  }
  const out: LocatedTranscript[] = [];
  for (const [id, tool] of ids) {
    const t = locateTranscript(id, tool, home);
    if (t) out.push(t);
  }
  return out;
}

// ─── Deriving one transcript (D4) ──────────────────────────────────

export interface DeriveTranscriptOptions {
  home?: string;
  tool?: TranscriptTool;
  path?: string;
  /** Is this a run's own session (`isAutomationBoundSession` / `isNotedRunSession`)? */
  runSession?: (id: string) => { run: true; endedAt: number | null } | null;
  ownerTexts?: ReadonlySet<string>;
  lockWaitMs?: number;
}

const LOCK_STALE_MS = 60_000;

/**
 * Lock, read from the cursor's open-job position, derive, write each job's trace, store the
 * cursor, unlock. A stale lock of a dead pid is taken over. Returns the traces written.
 */
export async function deriveTranscript(slug: string, projectRoot: string, transcriptId: string, opts: DeriveTranscriptOptions = {}): Promise<WorkTrace[]> {
  const home = opts.home ?? homedir();
  const target: WriteTarget = { slug, projectRoot, home };
  const live = liveScope(target);
  if (!live || !isSafeSessionId(transcriptId)) return [];
  if (!ensureUnder(live.root, live.scope, 'cursors')) return [];
  const lock = join(live.root, 'cursors', `${transcriptId}.lock`);
  if (!(await acquireFileLockWithin(lock, { waitMs: opts.lockWaitMs ?? 5_000, staleMs: LOCK_STALE_MS, verifyPidLiveness: true }))) return [];
  try {
    const cursor = readCursor(live.root, transcriptId);
    const loc = opts.path ? { id: transcriptId, tool: opts.tool ?? 'claude', path: opts.path } : locateTranscript(transcriptId, opts.tool ?? cursor?.tool ?? null, home);
    if (!loc) return [];
    let st: ReturnType<typeof statSync>;
    try { st = statSync(loc.path); } catch { return []; }
    if (cursor && cursor.size === st.size && cursor.mtimeMs === st.mtimeMs) return [];
    const whole = loc.tool !== 'claude' || isCodexRollout(loc.path);
    const from = whole ? 0 : Math.min(cursor?.from ?? 0, st.size);
    let text: string;
    if (whole) text = readTranscriptText(loc.path);
    else {
      const buf = await readFile(loc.path);
      text = buf.subarray(from).toString('utf-8');
    }
    const run = opts.runSession?.(transcriptId) ?? null;
    const month = cursor?.month ?? monthOf(Date.now(), '');
    const derived = deriveJobs(parseRecords(text, from), {
      transcriptId, project: cursor?.project ?? projectRef(projectRoot),
      runSession: run !== null, chatFrom: run ? (cursor?.chatFrom ?? run.endedAt ?? null) : null,
      firstAt: whole ? null : (cursor?.firstAt ?? null), ownerTexts: opts.ownerTexts, fallbackMonth: month,
    }, from);
    const written: WorkTrace[] = [];
    for (const t of derived.traces) if (await writeTrace(target, t)) written.push(t);
    await writeCursor(target, transcriptId, {
      v: 1, tool: loc.tool, ...(cursor?.pin ? { pin: cursor.pin } : {}),
      project: cursor?.project ?? projectRef(projectRoot),
      chatFrom: cursor?.chatFrom ?? null, from: whole ? 0 : derived.resumeAt, firstAt: derived.firstAt,
      month, size: st.size, mtimeMs: st.mtimeMs,
    });
    return written;
  } finally {
    releaseFileLock(lock);
  }
}

// ─── A run's trace (C4, runner) ─────────────────────────────────

export interface RunTraceInput {
  member: string;
  projectRoot: string;
  slug: string;
  fireIso: string;
  finishedAt: Date;
  ask: { by: AskBy; text: string };
  result: string | null;
  document: string | null;
  status: 'ok' | 'failed' | 'timeout' | string;
  sessionId: string | null;
  tool: TranscriptTool;
  app?: string | null;
  home?: string;
}

/** The run's trace, built from what the runner holds and its own session's written paths. */
export function buildRunTrace(input: RunTraceInput): WorkTrace | null {
  const home = input.home ?? homedir();
  let files: string[] = [];
  if (input.sessionId) {
    const loc = locateTranscript(input.sessionId, input.tool, home);
    if (loc) {
      try { files = toolWrites(parseRecords(readTranscriptText(loc.path)).map((r) => r.rec)); } catch { files = []; }
    }
  }
  const did = input.result && input.status !== 'failed' ? headTail(input.result, DID_MAX_CHARS) : (input.result ? headTail(input.result, DID_MAX_CHARS) : '');
  const boundedFiles = boundFiles(files);
  if (!did && boundedFiles.length === 0) return null;
  const key = `run:${input.slug}:${input.fireIso}`;
  return {
    v: 1, id: traceId(key), key, kind: 'run', at: input.fireIso, project: projectRef(input.projectRoot),
    asks: [{ by: input.ask.by, text: capText(input.ask.text, ASK_MAX_CHARS) }], did, files: boundedFiles,
    status: input.status === 'ok' ? 'ok' : input.status === 'timeout' ? 'interrupted' : 'failed',
    through: input.finishedAt.getTime(),
    ...(input.document ? { document: headTail(input.document, DID_MAX_CHARS) } : {}),
    runKey: key,
    ...(input.app ? { app: input.app } : {}),
  };
}

/** Write a run's trace. A write error never changes the run's outcome. */
export async function writeRunTrace(input: RunTraceInput): Promise<boolean> {
  try {
    const t = buildRunTrace(input);
    if (!t) return false;
    return await writeTrace({ slug: input.member, projectRoot: input.projectRoot, home: input.home }, t);
  } catch { return false; }
}

/** `mkdir -p` that is async (exported for the index's tests). */
export async function mkdirp(dir: string): Promise<void> { await mkdir(dir, { recursive: true, mode: 0o700 }); }
