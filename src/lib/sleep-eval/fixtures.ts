import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readFrontmatter } from '../frontmatter.js';
import { findTranscriptBySessionId, listSubagentTranscripts, resolveTranscript } from '../transcript-locate.js';
import {
  DEFAULT_SCORING,
  SLEEP_EVAL_SET_VERSION,
  sleepEvalRoot,
  type FixtureRound,
  type FixtureSession,
  type LabelItem,
  type SleepEvalSet,
} from './types.js';

/**
 * Cutting the fixed test set out of this brain's real history.
 *
 * A round is one entry of `state/.sleep-history.json` that still has every transcript on
 * disk. For each chosen round we keep:
 *   - its transcripts, CUT at the round's consolidation time (a session kept running after
 *     the sleep; the sleep never saw what came later) and COMPACTED to the records
 *     `transcript distill` reads (tool output bodies are never distilled, so they go);
 *   - the board it saw: the tasks that existed before it;
 *   - the tasks the real sleep opened, read from the sleep-tasks sub-agent's own
 *     transcript (`tasks create … --by sleep` → `Task created: <slug>.md`).
 */

export const MIN_ROUNDS = 10;
/** Sub-agent transcripts kept per session — the distiller's own harvest cap. */
const SUBAGENT_COPY_CAP = 20;
/** Tool-result text kept per block. distill never reads it; a trace is enough to debug. */
const TOOL_RESULT_KEEP = 300;

interface HistoryEntry {
  consolidated_at?: string;
  summary?: string;
  session_ids?: string[];
}

export interface RoundCandidate {
  id: string;
  consolidatedAt: string;
  previousAt: string | null;
  summary: string;
  sessionIds: string[];
  /** Transcripts still on disk, by session id. */
  transcripts: Map<string, string>;
}

/** `2026-10-14T21:21:30.476Z` → `r-20261014-2121`. */
export function roundId(consolidatedAt: string): string {
  const m = consolidatedAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `r-${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}` : `r-${consolidatedAt.replace(/[^0-9]/g, '').slice(0, 12)}`;
}

function readHistory(contextRoot: string): HistoryEntry[] {
  const p = join(contextRoot, 'state', '.sleep-history.json');
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Every past round whose transcripts are ALL still on disk, newest first, each with the
 * consolidation time of the round before it (its window's lower edge).
 */
export function listRoundCandidates(contextRoot: string, home: string = homedir()): RoundCandidate[] {
  const history = readHistory(contextRoot)
    .filter((h): h is Required<Pick<HistoryEntry, 'consolidated_at'>> & HistoryEntry => typeof h.consolidated_at === 'string')
    .sort((a, b) => b.consolidated_at.localeCompare(a.consolidated_at));
  const out: RoundCandidate[] = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const ids = (h.session_ids ?? []).filter((s) => typeof s === 'string');
    if (ids.length === 0) continue;
    const transcripts = new Map<string, string>();
    for (const id of ids) {
      const p = findTranscriptBySessionId([id], home);
      if (p) transcripts.set(id, p);
    }
    if (transcripts.size !== ids.length) continue;
    out.push({
      id: roundId(h.consolidated_at),
      consolidatedAt: h.consolidated_at,
      previousAt: history[i + 1]?.consolidated_at ?? null,
      summary: h.summary ?? '',
      sessionIds: ids,
      transcripts,
    });
  }
  return out;
}

// ─── Compaction ──────────────────────────────────────────────────────────────

export interface CompactStats {
  recordsIn: number;
  recordsOut: number;
  bytesOut: number;
  /** Bytes of the original up to the cut — what today's distiller would have opened. */
  bytesBeforeCut: number;
  lastTimestamp: string | null;
  lastAssistantMessage: string;
}

function trimToolResults(rec: Record<string, unknown>): void {
  delete rec.toolUseResult;
  const msg = rec.message as { content?: unknown } | undefined;
  if (!msg || !Array.isArray(msg.content)) return;
  for (const block of msg.content as Array<Record<string, unknown>>) {
    if (!block || block.type !== 'tool_result') continue;
    const c = block.content;
    if (typeof c === 'string') {
      block.content = c.slice(0, TOOL_RESULT_KEEP);
    } else if (Array.isArray(c)) {
      const text = c
        .map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : ''))
        .join('\n');
      block.content = text.slice(0, TOOL_RESULT_KEEP);
    }
  }
}

function assistantText(rec: Record<string, unknown>): string {
  const msg = rec.message as { role?: unknown; content?: unknown } | undefined;
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return '';
  return (msg.content as Array<{ type?: unknown; text?: unknown }>)
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

/**
 * Copy a transcript up to `cutoff`, keeping only records that carry a `message` (all
 * `distillTranscript` reads) and trimming tool-result bodies (which it never reads).
 * Records with no timestamp are kept: distill keeps them too.
 */
export function compactTranscript(src: string, dest: string, cutoff: string): CompactStats {
  const raw = readFileSync(src, 'utf-8');
  const lines = raw.split('\n');
  const kept: string[] = [];
  let recordsIn = 0;
  let bytesBeforeCut = 0;
  let lastTimestamp: string | null = null;
  let lastAssistantMessage = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    recordsIn++;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    if (ts && ts > cutoff) continue;
    bytesBeforeCut += Buffer.byteLength(line, 'utf-8') + 1;
    if (!rec.message) continue;
    if (ts) lastTimestamp = ts;
    const said = assistantText(rec);
    if (said) lastAssistantMessage = said;
    trimToolResults(rec);
    kept.push(JSON.stringify(rec));
  }
  mkdirSync(dirname(dest), { recursive: true });
  const body = kept.length > 0 ? kept.join('\n') + '\n' : '';
  writeFileSync(dest, body, 'utf-8');
  return {
    recordsIn,
    recordsOut: kept.length,
    bytesOut: Buffer.byteLength(body, 'utf-8'),
    bytesBeforeCut,
    lastTimestamp,
    lastAssistantMessage: lastAssistantMessage.slice(0, 2000),
  };
}

// ─── What the real sleep opened ──────────────────────────────────────────────

export interface SleepFiling {
  slug: string;
  at: string;
  /** The directory the filing session ran in. */
  cwd?: string;
  name: string;
  why: string;
  parent: string | null;
}

/** Minimal POSIX-ish word splitter: enough for `tasks create "<name>" -w '<why>' …`. */
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let any = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) { cur += cmd[++i]; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; any = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = ''; any = false;
      continue;
    }
    cur += ch; any = true;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** Split a command line on UNQUOTED `;`, `&&`, `||`, `|` and newlines. */
export function shellSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) { cur += ch + cmd[++i]; continue; }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { cur += ch + cmd[++i]; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && cmd[i + 1] === '&')) {
      out.push(cur);
      cur = '';
      if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The name/why/parent of a `tasks create` command line, or null when it is not one. */
export function parseTaskCreate(cmd: string): { name: string; why: string; parent: string | null; bySleep: boolean } | null {
  // A Bash call may chain commands; take the segment holding the create.
  const segment = shellSegments(cmd).find((s) => /\btasks\s+create\b/.test(s));
  if (!segment) return null;
  const words = shellWords(segment.slice(segment.search(/\btasks\s+create\b/)));
  // words[0] = tasks, words[1] = create
  let name = '';
  let why = '';
  let parent: string | null = null;
  let bySleep = false;
  for (let i = 2; i < words.length; i++) {
    const w = words[i];
    if (w === '-w' || w === '--why') { why = words[++i] ?? ''; continue; }
    if (w === '--parent' || w === '--parent-task') { parent = words[++i] ?? null; continue; }
    if (w === '--by') { bySleep = (words[++i] ?? '') === 'sleep'; continue; }
    if (w.startsWith('-')) {
      // Every other option of `tasks create` takes a value except the known booleans.
      if (!/^--(?:yes|json|no-|allow-)/.test(w) && i + 1 < words.length && !words[i + 1].startsWith('-')) i++;
      continue;
    }
    if (!name) name = w;
  }
  if (!name) return null;
  return { name, why, parent, bySleep };
}

const CREATED_RE = /Task created:\s*([A-Za-z0-9._-]+?)\.md/;

function toolResultText(block: Record<string, unknown>): string {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('\n');
  }
  return '';
}

/**
 * Scan one transcript for `tasks create … --by sleep` calls whose result printed a slug.
 * A refused create (no `Task created:` line) is not a filing.
 */
export function filingsInTranscript(path: string): SleepFiling[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  if (!raw.includes('tasks create')) return [];
  const pending = new Map<string, { at: string; cwd?: string; name: string; why: string; parent: string | null }>();
  const out: SleepFiling[] = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('tasks create') && !line.includes('Task created')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = rec.message as { role?: unknown; content?: unknown } | undefined;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && block.name === 'Bash') {
        const cmd = (block.input as { command?: unknown } | undefined)?.command;
        if (typeof cmd !== 'string') continue;
        const parsed = parseTaskCreate(cmd);
        if (!parsed || !parsed.bySleep) continue;
        pending.set(String(block.id), {
          at: typeof rec.timestamp === 'string' ? rec.timestamp : '',
          ...(typeof rec.cwd === 'string' ? { cwd: rec.cwd } : {}),
          name: parsed.name,
          why: parsed.why,
          parent: parsed.parent,
        });
      } else if (block.type === 'tool_result') {
        const p = pending.get(String(block.tool_use_id));
        if (!p) continue;
        const m = toolResultText(block).match(CREATED_RE);
        if (m) out.push({ slug: m[1], ...p });
        pending.delete(String(block.tool_use_id));
      }
    }
  }
  return out;
}

/**
 * Every sleep filing on this machine between `from` and `to` whose slug belongs to THIS
 * brain (another vault's sleep files there, not here). Only sub-agent transcripts are read:
 * `--by sleep` is the sleep-tasks specialist's signature.
 */
export function findSleepFilings(
  home: string,
  from: string,
  to: string,
  isBrainTask: (slug: string, cwd?: string) => boolean,
): SleepFiling[] {
  const base = join(home, '.claude', 'projects');
  if (!existsSync(base)) return [];
  const fromMs = Date.parse(from);
  const out: SleepFiling[] = [];
  const seen = new Set<string>();
  for (const proj of safeReaddir(base)) {
    const projDir = join(base, proj);
    for (const sess of safeReaddir(projDir)) {
      const subDir = join(projDir, sess, 'subagents');
      for (const f of safeReaddir(subDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(subDir, f);
        try {
          if (statSync(p).mtimeMs < fromMs) continue;
        } catch {
          continue;
        }
        for (const filing of filingsInTranscript(p)) {
          if (filing.at <= from || filing.at > to) continue;
          if (!isBrainTask(filing.slug, filing.cwd) || seen.has(filing.slug)) continue;
          seen.add(filing.slug);
          out.push(filing);
        }
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

// ─── Selection and the board ─────────────────────────────────────────────────

/**
 * Pick the rounds: every round where the real sleep opened something (they carry the
 * keep/reject labels), then the lightest remaining rounds until `min` are in. Lightest =
 * fewest sessions, so one eval run stays affordable.
 */
export function selectRounds(
  candidates: RoundCandidate[],
  openedByRound: Map<string, number>,
  min: number = MIN_ROUNDS,
): RoundCandidate[] {
  const ranked = [...candidates].sort((a, b) => {
    const fa = (openedByRound.get(a.id) ?? 0) > 0 ? 0 : 1;
    const fb = (openedByRound.get(b.id) ?? 0) > 0 ? 0 : 1;
    if (fa !== fb) return fa - fb;
    if (a.sessionIds.length !== b.sessionIds.length) return a.sessionIds.length - b.sessionIds.length;
    return a.consolidatedAt.localeCompare(b.consolidatedAt);
  });
  const withFilings = ranked.filter((r) => (openedByRound.get(r.id) ?? 0) > 0);
  const take = Math.max(min, withFilings.length);
  return ranked.slice(0, take).sort((a, b) => a.consolidatedAt.localeCompare(b.consolidatedAt));
}

export interface BoardTask {
  slug: string;
  createdAt: string;
  /** File birth time, the only same-day ordering signal a task file has. */
  bornMs: number;
}

/**
 * The board a round saw: tasks created before its day, plus same-day tasks born before the
 * consolidation, minus anything a sleep opened at or after this round (those are what the
 * round is tested on, or did not exist yet).
 */
export function boardAt(tasks: BoardTask[], consolidatedAt: string, openedFromHere: Set<string>): string[] {
  const day = consolidatedAt.slice(0, 10);
  const cutMs = Date.parse(consolidatedAt);
  return tasks
    .filter((t) => {
      if (openedFromHere.has(t.slug)) return false;
      if (!t.createdAt) return false;
      if (t.createdAt < day) return true;
      return t.createdAt === day && t.bornMs > 0 && t.bornMs < cutMs;
    })
    .map((t) => t.slug)
    .sort();
}

function readBoardTasks(stateDir: string): BoardTask[] {
  const out: BoardTask[] = [];
  for (const f of safeReaddir(stateDir)) {
    if (!f.endsWith('.md')) continue;
    const p = join(stateDir, f);
    try {
      const { data } = readFrontmatter<{ created_at?: unknown }>(p);
      const createdAt = typeof data.created_at === 'string' ? data.created_at.slice(0, 10)
        : data.created_at instanceof Date ? data.created_at.toISOString().slice(0, 10) : '';
      out.push({ slug: basename(f, '.md'), createdAt, bornMs: statSync(p).birthtimeMs || 0 });
    } catch {
      /* an unreadable task is not on the board */
    }
  }
  return out;
}

function taskExists(contextRoot: string, slug: string): boolean {
  return existsSync(join(contextRoot, 'state', `${slug}.md`)) || existsSync(join(contextRoot, 'state', 'archive', `${slug}.md`));
}

/** `parent_task` of a brain task (live or archived), null when unset or unreadable. */
function taskParent(contextRoot: string, slug: string): string | null {
  for (const p of [join(contextRoot, 'state', `${slug}.md`), join(contextRoot, 'state', 'archive', `${slug}.md`)]) {
    if (!existsSync(p)) continue;
    try {
      const { data } = readFrontmatter<{ parent_task?: unknown }>(p);
      return typeof data.parent_task === 'string' && data.parent_task ? data.parent_task : null;
    } catch {
      return null;
    }
  }
  return null;
}

function filingToItem(roundIdValue: string, n: number, f: SleepFiling): LabelItem {
  return {
    id: `${roundIdValue}:opened:${n}`,
    round: roundIdValue,
    category: 'opened',
    name: f.name,
    why: f.why,
    quote: '',
    session: null,
    parent: f.parent,
    slug: f.slug,
    basis: 'unknown',
  };
}

// ─── Build ───────────────────────────────────────────────────────────────────

export interface BuildOptions {
  home?: string;
  min?: number;
  /** Rebuild even when a set already exists (labels are kept; ids are stable). */
  force?: boolean;
  log?: (line: string) => void;
}

export function readEvalSet(contextRoot: string): SleepEvalSet | null {
  const p = join(sleepEvalRoot(contextRoot), 'set.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SleepEvalSet;
  } catch {
    return null;
  }
}

export function readRound(contextRoot: string, id: string): FixtureRound | null {
  const p = join(sleepEvalRoot(contextRoot), 'fixtures', id, 'round.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as FixtureRound;
  } catch {
    return null;
  }
}

export function writeRound(contextRoot: string, round: FixtureRound): void {
  const dir = join(sleepEvalRoot(contextRoot), 'fixtures', round.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'round.json'), JSON.stringify(round, null, 2) + '\n', 'utf-8');
}

/**
 * Freeze the test set. Idempotent per round: an existing round keeps its candidates (the
 * owner may already have labelled them), so a rebuild never orphans a label.
 */
/** Where a round's frozen board, history and declines live: the set root, or its source's dir. */
export function sourceDataDir(contextRoot: string, round: Pick<FixtureRound, 'source'>): string {
  const root = sleepEvalRoot(contextRoot);
  return round.source ? join(root, 'sources', round.source.name) : root;
}

/** The brain a round was cut from (this brain unless the round names another source). */
export function roundSourceCtx(contextRoot: string, round: Pick<FixtureRound, 'source'>): string {
  return round.source?.ctx ?? contextRoot;
}

/**
 * Freeze the chosen rounds of ONE brain: its board, history and declines once, then each
 * round's compacted transcripts, board cut and real filings. Returns the round ids.
 */
function freezeSource(
  contextRoot: string,
  srcCtx: string,
  source: { name: string; ctx: string } | null,
  opts: BuildOptions,
): string[] {
  const home = opts.home ?? homedir();
  const log = opts.log ?? (() => {});
  const prefix = source ? `${source.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-` : '';
  const candidates = listRoundCandidates(srcCtx, home).map((c) => ({ ...c, id: `${prefix}${c.id}` }));
  if (candidates.length === 0) throw new Error(`No past sleep round of ${srcCtx} still has its transcripts on disk.`);
  const oldest = candidates[candidates.length - 1];
  // A filing is this brain's when its task still exists here, or when the sleep that filed it
  // ran inside this brain's project (a task renamed or deleted since, e.g. by a ClickUp sync).
  const project = dirname(srcCtx);
  const ranHere = (cwd?: string) => !!cwd && (cwd === project || cwd.startsWith(`${project}/`));
  const filings = findSleepFilings(home, oldest.previousAt ?? '0000', candidates[0].consolidatedAt, (s, cwd) => taskExists(srcCtx, s) || ranHere(cwd));
  const filingsByRound = new Map<string, SleepFiling[]>();
  for (const f of filings) {
    const round = candidates.find((c) => (c.previousAt === null || f.at > c.previousAt) && f.at <= c.consolidatedAt);
    if (!round) continue;
    filingsByRound.set(round.id, [...(filingsByRound.get(round.id) ?? []), f]);
  }
  const chosen = selectRounds(candidates, new Map([...filingsByRound].map(([k, v]) => [k, v.length])), opts.min ?? MIN_ROUNDS);
  log(`${source?.name ?? 'this brain'}: ${candidates.length} rounds still have transcripts; ${chosen.length} chosen; ${filings.length} sleep filings found.`);

  // Freeze the board once: every task file as it stands now.
  const dataDir = sourceDataDir(contextRoot, { source: source ?? undefined });
  const stateDir = join(srcCtx, 'state');
  const boardDir = join(dataDir, 'board');
  mkdirSync(boardDir, { recursive: true });
  const boardTasks = readBoardTasks(stateDir);
  for (const t of boardTasks) copyFileSync(join(stateDir, `${t.slug}.md`), join(boardDir, `${t.slug}.md`));
  for (const extra of ['.task-declined.json', '.task-tombstones.json']) {
    const p = join(stateDir, extra);
    if (existsSync(p)) copyFileSync(p, join(dataDir, extra.replace(/^\./, '')));
  }
  writeFileSync(join(dataDir, 'sleep-history.json'), JSON.stringify(readHistory(srcCtx), null, 2) + '\n', 'utf-8');

  const root = sleepEvalRoot(contextRoot);
  for (const c of chosen) {
    const prior = readRound(contextRoot, c.id);
    const roundDir = join(root, 'fixtures', c.id);
    const sessions: FixtureSession[] = [];
    for (const id of c.sessionIds) {
      const src = c.transcripts.get(id)!;
      const rel = join('sessions', `${id}.jsonl`);
      const stats = compactTranscript(src, join(roundDir, rel), c.consolidatedAt);
      const subagents: string[] = [];
      const loc = resolveTranscript(src, { sessionId: id });
      for (const sub of listSubagentTranscripts(loc, { max: SUBAGENT_COPY_CAP })) {
        const subRel = join('sessions', id, 'subagents', basename(sub));
        const subStats = compactTranscript(sub, join(roundDir, subRel), c.consolidatedAt);
        if (subStats.recordsOut > 0) subagents.push(subRel);
      }
      sessions.push({
        session_id: id,
        file: rel,
        stopped_at: stats.lastTimestamp ?? c.consolidatedAt,
        last_assistant_message: stats.lastAssistantMessage,
        subagents,
      });
    }
    sessions.sort((a, b) => a.stopped_at.localeCompare(b.stopped_at));
    const openedHere = (filingsByRound.get(c.id) ?? []);
    const openedFromHere = new Set(filings.filter((f) => f.at > (c.previousAt ?? '')).map((f) => f.slug));
    const round: FixtureRound = {
      id: c.id,
      ...(source ? { source } : {}),
      consolidatedAt: c.consolidatedAt,
      previousAt: c.previousAt,
      summary: c.summary,
      sessions,
      board: boardAt(boardTasks, c.consolidatedAt, openedFromHere),
      opened: openedHere.map((f, i) => filingToItem(c.id, i + 1, { ...f, parent: f.parent ?? taskParent(srcCtx, f.slug) })),
      candidates: prior?.candidates ?? [],
      ...(prior?.parked ? { parked: prior.parked } : {}),
    };
    writeRound(contextRoot, round);
    log(`${c.id}: ${sessions.length} sessions, board ${round.board.length}, opened ${round.opened.length}`);
  }
  return chosen.map((c) => c.id);
}

function writeEvalSet(contextRoot: string, set: SleepEvalSet): void {
  writeFileSync(join(sleepEvalRoot(contextRoot), 'set.json'), JSON.stringify(set, null, 2) + '\n');
}

/**
 * Freeze the test set from this brain. Idempotent per round: an existing round keeps its
 * candidates (the owner may already have labelled them), so a rebuild never orphans a label.
 * Rounds added from another brain (`addEvalSource`) survive a rebuild of this brain's part.
 */
export function buildEvalSet(contextRoot: string, opts: BuildOptions = {}): SleepEvalSet {
  const existing = readEvalSet(contextRoot);
  if (existing && !opts.force) return existing;
  const own = freezeSource(contextRoot, contextRoot, null, opts);
  const foreign = (existing?.rounds ?? []).filter((id) => readRound(contextRoot, id)?.source);
  const set: SleepEvalSet = {
    version: SLEEP_EVAL_SET_VERSION,
    createdAt: new Date().toISOString(),
    source: contextRoot,
    rounds: [...own, ...foreign],
    scoring: existing?.scoring ?? { ...DEFAULT_SCORING },
  };
  writeEvalSet(contextRoot, set);
  return set;
}

/**
 * Add rounds cut from ANOTHER brain on this machine (the owner's other projects make the
 * set richer). The sleep under test stays this brain's specialist; the round's board,
 * history, declines and project files come from the source brain. Re-adding a source
 * replaces its rounds. Changing the set's rounds makes it a new set version (`createdAt`),
 * so an older baseline can never be compared with runs on it.
 */
export function addEvalSource(contextRoot: string, srcCtx: string, name: string, opts: BuildOptions = {}): SleepEvalSet {
  const existing = readEvalSet(contextRoot);
  if (!existing) throw new Error('No test set yet: build this brain\'s rounds first.');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error('Source name must be 1-40 letters, digits, - or _.');
  if (!existsSync(join(srcCtx, 'state', '.sleep-history.json'))) throw new Error(`${srcCtx} has no sleep history.`);
  const added = freezeSource(contextRoot, srcCtx, { name, ctx: srcCtx }, opts);
  const kept = existing.rounds.filter((id) => readRound(contextRoot, id)?.source?.name !== name);
  const set: SleepEvalSet = { ...existing, createdAt: new Date().toISOString(), rounds: [...kept, ...added] };
  writeEvalSet(contextRoot, set);
  return set;
}
