/**
 * THE usage ledger: every number on the Stats screen comes out of this one file's rows.
 *
 * A row is what a transcript says a request cost, grouped by hour. Sleep, memory and limit hits
 * are marks ON those rows, never a second count, so nothing can be added twice. Eco's saving is
 * not here at all: it is an estimate and stays outside every total (usage-report.ts).
 *
 * ── Who ran a session ────────────────────────────────────────────────────────────────
 * A sandbox account's `projects/` is a SYMLINK to `~/.claude/projects`, so every account writes
 * into one folder and the folder says nothing about the account. What does: Claude Code makes
 * `<configDir>/session-env/<session id>/` for each session it runs there. Codex's shadow homes
 * link `sessions/` the same way, and a rollout carries `creator_account_id` instead. Roots are
 * walked by realpath so the shared folder is read once.
 *
 * ── The cache ────────────────────────────────────────────────────────────────────────
 * 14 GB of logs on the owner's Mac: `~/.dreamcontext/usage-scan-cache.json` holds each file's
 * rows, keyed by path + size + mtime, so only a changed file is read again. A log that is gone
 * keeps its rows: Claude Code prunes old transcripts and what they cost still happened.
 *
 * ── Dedupe across files ──────────────────────────────────────────────────────────────
 * The key is message.id + requestId across EVERY file, never per file: a resumed or forked
 * session can copy a message. Each file keeps a hash of the keys it counted, so a rescanned file
 * skips what another file already holds and each key is counted exactly once.
 *
 * The file holds numbers, session ids and working folders. No prompt, no reply: a prompt is a time
 * and who wrote it (rules in usage-readers.ts `humanTurn`, `firstTurnKind`). A record's uuid goes
 * in the same key list, so a forked session's copied prompts are counted once.
 */
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { listClaudeAccounts } from './claude-accounts.js';
import {
  claudeInjection, claudeLimitHit, claudeSleepMark, claudeSuperSends, firstPromptText, firstTurnKind, humanTurn, initialCodexState,
  originOfFirstPrompt, parseClaudeRecord, turnKind, parseCodexRecord, type CodexScanState, type LimitHit, type PromptKind, type SessionOrigin, type UsageLine,
} from './usage-readers.js';

export const LEDGER_VERSION = 3;
/** Rows older than this leave the cache: the widest range the screen shows is 90 days. */
const KEEP_MS = 100 * 86_400_000;
/** A sleep whose `done` never came stops claiming the chat's later turns after this long. */
const OPEN_SPAN_MS = 2 * 3_600_000;

/** [hour start ms, model index, fast?, input, cacheRead, cacheWrite, output, sleep span (-1 none),
 *  memory first read, memory carried, 1-hour cache writes (part of cacheWrite), index into
 *  `accounts`]. Positional: 100k rows must stay small on disk. */
export type LedgerRow = [number, number, 0 | 1, number, number, number, number, number, number, number, number, number];

/** [time ms, who wrote it, index into `accounts`]. Times only, never the words. */
export type LedgerPrompt = [number, PromptKind, number];

export interface LedgerFile {
  s: number;
  m: number;
  tool: 'claude' | 'codex' | 'antigravity';
  session: string;
  cwd: string;
  /** A sub-agent's file: its `agentType` and the effort it ran at (`agent-*.meta.json`). */
  agent?: string;
  effort?: string;
  origin?: 'sleep' | 'automation';
  /** Account id (`primary` included) or Codex's creator id. Absent = nothing says who. */
  account?: string;
  /** A session that moved accounts mid-way (the auto-switch at a limit): [from ms, account],
   *  oldest first. A row names its entry at index 11 and a hit carries its own `account`, both
   *  decided request by request while scanning; `account` is the last entry. */
  accounts?: Array<[number, string]>;
  first: number;
  last: number;
  reqs: number;
  /** Context size of the first and last request: all input the model read for it. */
  ctx0: number;
  ctx1: number;
  rows: LedgerRow[];
  /** In-chat sleeps: [start ms, end ms or 0]. Row index 7 points here. */
  spans: Array<[number, number]>;
  hits: Array<LimitHit & { account?: string }>;
  snapshots: number;
  recalls: number;
  /** A main session's prompts, as first read. An adopted chat's `owner` entry may be a Super send. */
  prompts: LedgerPrompt[];
  /** A Super session's `super send` calls: [time ms, child id as written]. */
  sends: Array<[number, string]>;
  /** base64 of the Float64 hashes of the keys this file counted. */
  keys: string;
}

export interface Ledger {
  version: number;
  models: string[];
  files: Record<string, LedgerFile>;
}

export interface ScanProgress { done: number; total: number }

export interface ScanRoot { dir: string; tool: 'claude' | 'codex' | 'antigravity' }

function emptyLedger(): Ledger { return { version: LEDGER_VERSION, models: [], files: {} }; }

export function ledgerPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'usage-scan-cache.json');
}

/** 53-bit string hash (cyrb53, public domain). Fits a double, so a key costs 8 bytes. */
export function hashKey(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const encodeKeys = (keys: number[]): string => Buffer.from(new Float64Array(keys).buffer).toString('base64');

function decodeKeys(s: string): Float64Array {
  if (!s) return new Float64Array(0);
  const b = Buffer.from(s, 'base64');
  const out = new Float64Array(b.length >> 3);
  for (let i = 0; i < out.length; i++) out[i] = b.readDoubleLE(i * 8);
  return out;
}

export function loadLedger(home: string = homedir()): Ledger {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(home), 'utf-8')) as Ledger;
    return raw?.version === LEDGER_VERSION && raw.files && Array.isArray(raw.models) ? raw : emptyLedger();
  } catch {
    return emptyLedger();
  }
}

function saveLedger(ledger: Ledger, home: string): void {
  const file = ledgerPath(home);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* no cache this time: the next open reads the logs again */ }
}

/** Every folder holding logs, each once: an account's `projects/` is usually a link to the same one. */
export function ledgerRoots(home: string = homedir()): ScanRoot[] {
  const roots: ScanRoot[] = [];
  const seen = new Set<string>();
  const add = (dir: string, tool: ScanRoot['tool']) => {
    let real: string;
    try { real = realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    roots.push({ dir: real, tool });
  };
  add(join(home, '.claude', 'projects'), 'claude');
  let accounts: ReturnType<typeof listClaudeAccounts> = [];
  try { accounts = listClaudeAccounts(home); } catch { /* the default folder still counts */ }
  for (const a of accounts) if (a.configDir) add(join(a.configDir, 'projects'), 'claude');
  add(join(home, '.codex', 'sessions'), 'codex');
  add(join(home, '.codex', 'archived_sessions'), 'codex');
  // Antigravity: the transcripts Stop writes from each conversation (antigravity-conversation.ts),
  // in Claude's line shape with the agent's own token counts. No model name rides along.
  add(join(home, '.dreamcontext', 't3', 'transcripts'), 'antigravity');
  return roots;
}

async function walk(dir: string, out: Array<{ path: string; tool: ScanRoot['tool']; size: number; mtime: number }>, tool: ScanRoot['tool']): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, tool);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try { const st = await stat(p); out.push({ path: p, tool, size: st.size, mtime: st.mtimeMs }); } catch { /* gone mid-walk */ }
    }
  }
}

/**
 * Session id → the accounts it ran on, from each config dir's `session-env/`: oldest first, each
 * from the moment its folder was born. One session can hold several: the auto-switch resumes it
 * on the next account at a limit, so the tokens before the switch belong to the first account.
 */
export function sessionAccounts(home: string = homedir()): Map<string, Array<[number, string]>> {
  const out = new Map<string, Array<[number, string]>>();
  const read = (configDir: string, account: string) => {
    const dir = join(configDir, 'session-env');
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      let at = 0;
      try { at = lstatSync(join(dir, name)).birthtimeMs; } catch { continue; }
      const list = out.get(name) ?? [];
      list.push([at, account]);
      out.set(name, list);
    }
  };
  let accounts: ReturnType<typeof listClaudeAccounts> = [];
  try { accounts = listClaudeAccounts(home); } catch { /* the default folder still answers */ }
  const primary = accounts.find((a) => a.configDir === null);
  read(join(home, '.claude'), primary?.id ?? 'primary');
  for (const a of accounts) if (a.configDir) read(a.configDir, a.id);
  for (const list of out.values()) list.sort((x, y) => x[0] - y[0]);
  return out;
}

/** Which entry held the session at `ts`. Before the first switch it is the first one. */
export function accountIndexAt(list: Array<[number, string]> | undefined, ts: number): number {
  if (!list) return 0;
  let at = 0;
  list.forEach(([from], i) => { if (from <= ts) at = i; });
  return at;
}

/** Who a row's tokens belong to. */
export function rowAccount(file: Pick<LedgerFile, 'account' | 'accounts'>, row: LedgerRow): string | undefined {
  return file.accounts?.[row[11]]?.[1] ?? file.account;
}

interface SubagentMeta { agentType?: string; effort?: string }

function readMeta(path: string): SubagentMeta {
  try {
    const raw = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf-8')) as Record<string, unknown>;
    return {
      ...(typeof raw.agentType === 'string' ? { agentType: raw.agentType } : {}),
      ...(typeof raw.effort === 'string' ? { effort: raw.effort } : {}),
    };
  } catch {
    return {};
  }
}

const hourOf = (ts: number): number => Math.floor(ts / 3_600_000) * 3_600_000;

interface ScanContext { intern: (m: string) => number; seen: Set<number>; sessions: Map<string, Array<[number, string]>> }

/** Read one log start to end. Yields to the event loop between chunks, so a scan never blocks the server. */
async function scanFile(path: string, tool: ScanRoot['tool'], size: number, mtime: number, ctx: ScanContext): Promise<LedgerFile | null> {
  const isSub = /[/\\]subagents[/\\]agent-[^/\\]+\.jsonl$/.test(path);
  const meta = isSub ? readMeta(path) : {};
  const session = isSub ? basename(dirname(dirname(path))) : basename(path, '.jsonl');
  const file: LedgerFile = {
    s: size, m: mtime, tool, session, cwd: '', first: 0, last: 0, reqs: 0, ctx0: 0, ctx1: 0,
    rows: [], spans: [], hits: [], snapshots: 0, recalls: 0, prompts: [], sends: [], keys: '',
    ...(meta.agentType ? { agent: meta.agentType } : {}), ...(meta.effort ? { effort: meta.effort } : {}),
  };
  const rowsByKey = new Map<string, LedgerRow>();
  const counted: number[] = [];
  // Each key's row and largest output: the first record of a message holds a partial
  // `output_tokens`, so the repeats may only ever raise that one number.
  const localSeen = new Map<number, { row: LedgerRow; output: number }>();
  const heldBy = tool === 'claude' ? ctx.sessions.get(session) : undefined;
  const codex: CodexScanState = initialCodexState();
  let origin: SessionOrigin = null;
  let promptRead = isSub;
  let openSpan = -1;
  let pendingMem = 0;
  let carriedMem = 0;
  let sessionKind: PromptKind | null = null;
  const promptIds = new Set<number>();
  const sendCalls = new Set<string>();

  const addPrompt = (rec: Record<string, unknown>) => {
    const turn = humanTurn(rec);
    if (!turn) return;
    if (turn.uuid !== null) {
      const id = hashKey(`prompt:${turn.uuid}`);
      if (promptIds.has(id) || ctx.seen.has(id)) return;
      promptIds.add(id);
      counted.push(id);
    }
    const first = sessionKind === null;
    if (first) sessionKind = firstTurnKind(turn, origin);
    const kind = first ? (sessionKind as PromptKind) : turnKind(turn, sessionKind as PromptKind, origin);
    file.prompts.push([turn.ts, kind, accountIndexAt(heldBy, turn.ts)]);
  };

  const count = (line: UsageLine) => {
    let hash: number | null = null;
    if (line.dedupeKey !== null) {
      hash = hashKey(line.dedupeKey);
      const mine = localSeen.get(hash);
      if (mine) {
        if (line.totals.output > mine.output) { mine.row[6] += line.totals.output - mine.output; mine.output = line.totals.output; }
        return;
      }
      if (ctx.seen.has(hash)) return;
      counted.push(hash);
    }
    if (openSpan >= 0 && line.ts - file.spans[openSpan][0] > OPEN_SPAN_MS) openSpan = -1;
    const model = ctx.intern(line.model);
    const hour = hourOf(line.ts);
    const fast: 0 | 1 = line.speed === 'fast' ? 1 : 0;
    const who = accountIndexAt(heldBy, line.ts);
    const key = `${hour}|${model}|${fast}|${openSpan}|${who}`;
    let row = rowsByKey.get(key);
    if (!row) { row = [hour, model, fast, 0, 0, 0, 0, openSpan, 0, 0, 0, who]; rowsByKey.set(key, row); }
    const t = line.totals;
    row[3] += t.input; row[4] += t.cacheRead; row[5] += t.cacheWrite; row[6] += t.output; row[10] += t.cacheWrite1h ?? 0;
    if (hash !== null) localSeen.set(hash, { row, output: t.output });
    row[8] += pendingMem; row[9] += carriedMem;
    carriedMem += pendingMem;
    pendingMem = 0;
    if (!file.first) file.first = line.ts;
    file.last = Math.max(file.last, line.ts);
    file.reqs += 1;
    const context = t.input + t.cacheRead + t.cacheWrite;
    if (!file.ctx0) file.ctx0 = context;
    file.ctx1 = context;
  };

  const claudeLine = (b: Buffer) => {
    const usage = b.includes('"usage"');
    const hook = !usage && b.includes('"hook_success"');
    const compact = !usage && !hook && b.includes('"compact_boundary"');
    // A tool result is most of a log and never a prompt: its raw key means no parse. In a person's
    // text the same word has escaped quotes, so it cannot match.
    const user = !isSub && b.includes('"type":"user"') && !b.includes('"tool_use_id"');
    if (!usage && !hook && !compact && !user) return;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(b.toString('utf-8')) as Record<string, unknown>; } catch { return; }
    if (!file.cwd && typeof rec.cwd === 'string') file.cwd = rec.cwd;
    if (user) {
      if (!promptRead) {
        const text = firstPromptText(rec);
        if (text !== null) { promptRead = true; origin = originOfFirstPrompt(text); }
      }
      addPrompt(rec);
    }
    if (compact) { if (rec.subtype === 'compact_boundary') carriedMem = 0; return; }
    if (hook) {
      const inj = claudeInjection(rec);
      if (inj) { pendingMem += inj.tokens; if (inj.kind === 'snapshot') file.snapshots += 1; else file.recalls += 1; }
      return;
    }
    const hit = claudeLimitHit(rec);
    if (hit !== null) {
      const who = heldBy?.[accountIndexAt(heldBy, hit.ts)]?.[1];
      file.hits.push(who ? { ...hit, account: who } : hit);
      return;
    }
    if (b.includes('super send')) {
      const at = Date.parse(String(rec.timestamp));
      for (const [id, child] of claudeSuperSends(rec)) {
        if (Number.isFinite(at) && !sendCalls.has(`${id}|${child}`)) { sendCalls.add(`${id}|${child}`); file.sends.push([at, child]); }
      }
    }
    const mark = claudeSleepMark(rec);
    if (mark === 'start' && openSpan < 0) {
      const at = Date.parse(String(rec.timestamp));
      if (Number.isFinite(at)) { file.spans.push([at, 0]); openSpan = file.spans.length - 1; }
    }
    const line = parseClaudeRecord(rec);
    if (line) count(line);
    if (mark === 'done' && openSpan >= 0) {
      const at = Date.parse(String(rec.timestamp));
      file.spans[openSpan][1] = Number.isFinite(at) ? at : file.last;
      openSpan = -1;
    }
  };

  const codexLine = (b: Buffer) => {
    if (!b.includes('"token_count"') && !b.includes('"session_meta"') && !b.includes('"turn_context"') && !b.includes('"thread_settings_applied"')) return;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(b.toString('utf-8')) as Record<string, unknown>; } catch { return; }
    const line = parseCodexRecord(rec, codex);
    if (line) count(line);
  };

  const onLine = tool === 'codex' ? codexLine : claudeLine;
  try {
    let tail: Buffer = Buffer.alloc(0);
    for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
      const b = tail.length ? Buffer.concat([tail, chunk as Buffer]) : (chunk as Buffer);
      let start = 0;
      let nl: number;
      while ((nl = b.indexOf(10, start)) >= 0) {
        onLine(b.subarray(start, nl));
        start = nl + 1;
      }
      tail = b.subarray(start);
    }
    if (tail.length) onLine(tail);
  } catch {
    return null;
  }

  if (tool === 'codex') {
    if (codex.sessionId) file.session = codex.sessionId;
    file.cwd = codex.cwd;
    if (codex.creator) file.account = codex.creator;
  }
  if (origin) file.origin = origin;
  for (const h of counted) ctx.seen.add(h);
  file.keys = encodeKeys(counted);
  file.rows = [...rowsByKey.values()];
  return file;
}

// ── One scan at a time ───────────────────────────────────────────────────────────────

interface LedgerState { ledger: Ledger | null; running: Promise<void> | null; progress: ScanProgress | null; finishedAt: number }

const states = new Map<string, LedgerState>();

function stateFor(home: string): LedgerState {
  let s = states.get(home);
  if (!s) { s = { ledger: null, running: null, progress: null, finishedAt: 0 }; states.set(home, s); }
  return s;
}

export function currentLedger(home: string = homedir()): Ledger {
  const s = stateFor(home);
  if (!s.ledger) s.ledger = loadLedger(home);
  return s.ledger;
}

export function scanProgress(home: string = homedir()): ScanProgress | null {
  return stateFor(home).progress;
}

/** Bring the ledger up to date. A second caller joins the scan already running. */
export function scanLedger(home: string = homedir(), roots: ScanRoot[] = ledgerRoots(home)): Promise<void> {
  const state = stateFor(home);
  if (state.running) return state.running;
  // Said at once: the first read must already know a scan is on, or the screen would not ask again.
  state.progress = { done: 0, total: 0 };
  state.running = runScan(home, roots, state).finally(() => {
    state.running = null;
    state.progress = null;
    state.finishedAt = Date.now();
  });
  return state.running;
}

/** A read of the screen starts a scan at most this often. */
export const SCAN_EVERY_MS = 60_000;

/** Called on each read of the screen: starts a scan in the background, never waits for it. */
export function freshenLedger(home: string = homedir()): void {
  const state = stateFor(home);
  if (state.running || Date.now() - state.finishedAt < SCAN_EVERY_MS) return;
  void scanLedger(home).catch(() => { /* the last ledger stays on screen */ });
}

async function runScan(home: string, roots: ScanRoot[], state: LedgerState): Promise<void> {
  const ledger = currentLedger(home);
  const found: Array<{ path: string; tool: ScanRoot['tool']; size: number; mtime: number }> = [];
  for (const root of roots) await walk(root.dir, found, root.tool);
  // Oldest first, so the first copy of a message keeps it, as T3's readdir order does.
  found.sort((a, b) => a.mtime - b.mtime);
  const keepFrom = Date.now() - KEEP_MS;
  const stale = found.filter((f) => {
    if (f.mtime < keepFrom) return false; // out of every range, and its entry is gone: never reread
    const c = ledger.files[f.path];
    return !c || c.s !== f.size || c.m !== f.mtime;
  });

  const accounts = sessionAccounts(home);
  if (stale.length > 0) {
    state.progress = { done: 0, total: stale.length };
    const staleSet = new Set(stale.map((f) => f.path));
    const seen = new Set<number>();
    for (const [path, entry] of Object.entries(ledger.files)) {
      if (staleSet.has(path)) continue;
      for (const k of decodeKeys(entry.keys)) seen.add(k);
    }
    const index = new Map(ledger.models.map((m, i) => [m, i]));
    const intern = (m: string): number => {
      let i = index.get(m);
      if (i === undefined) { i = ledger.models.length; ledger.models.push(m); index.set(m, i); }
      return i;
    };
    for (const f of stale) {
      const entry = await scanFile(f.path, f.tool, f.size, f.mtime, { intern, seen, sessions: accounts });
      if (entry) {
        // Codex lines have no key: a rollout moved to `archived_sessions` is the same requests.
        if (entry.tool === 'codex') {
          for (const [path, other] of Object.entries(ledger.files)) {
            if (path !== f.path && other.tool === 'codex' && other.session === entry.session) delete ledger.files[path];
          }
        }
        ledger.files[f.path] = entry;
      }
      state.progress = { done: state.progress.done + 1, total: stale.length };
    }
  }

  // Sessions Claude Code has pruned keep the account they were first seen on.
  let changed = stale.length > 0;
  const cutoff = Date.now() - KEEP_MS;
  for (const [path, entry] of Object.entries(ledger.files)) {
    if (entry.last && entry.last < cutoff) { delete ledger.files[path]; changed = true; continue; }
    if (entry.tool !== 'claude') continue;
    const list = accounts.get(entry.session);
    if (!list) continue;
    // A row and a hit point into this list, so it only ever grows at the end: an account leaving
    // the register or a pruned folder must not move what was already counted.
    const held = entry.accounts ?? (entry.account ? [[0, entry.account] as [number, string]] : []);
    const merged = held.length ? [...held, ...list.filter(([, id]) => !held.some(([, o]) => o === id))] : list;
    const last = merged[merged.length - 1][1];
    const moved = merged.length > 1 ? merged : undefined;
    if (entry.account !== last || (moved && JSON.stringify(entry.accounts) !== JSON.stringify(moved))) {
      entry.account = last;
      if (moved) entry.accounts = moved;
      changed = true;
    }
  }
  if (changed) saveLedger(ledger, home);
}

export function ledgerFileExists(home: string = homedir()): boolean {
  return existsSync(ledgerPath(home));
}

/** Newest log time on disk, for the "as of" line. */
export function ledgerAsOf(home: string = homedir()): number | null {
  try { return statSync(ledgerPath(home)).mtimeMs; } catch { return null; }
}
