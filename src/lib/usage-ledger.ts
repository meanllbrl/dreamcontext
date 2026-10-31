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
 * The file holds numbers, session ids and working folders. No prompt, no reply.
 */
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { listClaudeAccounts } from './claude-accounts.js';
import {
  claudeInjection, claudeLimitHit, claudeSleepMark, firstPromptText, initialCodexState, originOfFirstPrompt,
  parseClaudeRecord, parseCodexRecord, type CodexScanState, type LimitHit, type SessionOrigin, type UsageLine,
} from './usage-readers.js';

export const LEDGER_VERSION = 1;
/** Rows older than this leave the cache: the widest range the screen shows is 90 days. */
const KEEP_MS = 100 * 86_400_000;
/** A sleep whose `done` never came stops claiming the chat's later turns after this long. */
const OPEN_SPAN_MS = 2 * 3_600_000;

/** [hour start ms, model index, fast?, input, cacheRead, cacheWrite, output, sleep span (-1 none),
 *  memory first read, memory carried]. Positional: 100k rows must stay small on disk. */
export type LedgerRow = [number, number, 0 | 1, number, number, number, number, number, number, number];

export interface LedgerFile {
  s: number;
  m: number;
  tool: 'claude' | 'codex';
  session: string;
  cwd: string;
  /** A sub-agent's file: its `agentType` and the effort it ran at (`agent-*.meta.json`). */
  agent?: string;
  effort?: string;
  origin?: 'sleep' | 'automation';
  /** Account id (`primary` included) or Codex's creator id. Absent = nothing says who. */
  account?: string;
  first: number;
  last: number;
  reqs: number;
  /** Context size of the first and last request: all input the model read for it. */
  ctx0: number;
  ctx1: number;
  rows: LedgerRow[];
  /** In-chat sleeps: [start ms, end ms or 0]. Row index 7 points here. */
  spans: Array<[number, number]>;
  hits: LimitHit[];
  snapshots: number;
  recalls: number;
  /** base64 of the Float64 hashes of the keys this file counted. */
  keys: string;
}

export interface Ledger {
  version: number;
  models: string[];
  files: Record<string, LedgerFile>;
}

export interface ScanProgress { done: number; total: number }

export interface ScanRoot { dir: string; tool: 'claude' | 'codex' }

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

/** Session id → account, from each config dir's `session-env/`. The newest folder wins a shared session. */
export function sessionAccounts(home: string = homedir()): Map<string, string> {
  const best = new Map<string, { account: string; at: number }>();
  const read = (configDir: string, account: string) => {
    const dir = join(configDir, 'session-env');
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      let at = 0;
      try { at = lstatSync(join(dir, name)).mtimeMs; } catch { continue; }
      const prev = best.get(name);
      if (!prev || at > prev.at) best.set(name, { account, at });
    }
  };
  let accounts: ReturnType<typeof listClaudeAccounts> = [];
  try { accounts = listClaudeAccounts(home); } catch { /* the default folder still answers */ }
  const primary = accounts.find((a) => a.configDir === null);
  read(join(home, '.claude'), primary?.id ?? 'primary');
  for (const a of accounts) if (a.configDir) read(a.configDir, a.id);
  return new Map([...best].map(([k, v]) => [k, v.account]));
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

interface ScanContext { intern: (m: string) => number; seen: Set<number> }

/** Read one log start to end. Yields to the event loop between chunks, so a scan never blocks the server. */
async function scanFile(path: string, tool: ScanRoot['tool'], size: number, mtime: number, ctx: ScanContext): Promise<LedgerFile | null> {
  const isSub = /[/\\]subagents[/\\]agent-[^/\\]+\.jsonl$/.test(path);
  const meta = isSub ? readMeta(path) : {};
  const session = isSub ? basename(dirname(dirname(path))) : basename(path, '.jsonl');
  const file: LedgerFile = {
    s: size, m: mtime, tool, session, cwd: '', first: 0, last: 0, reqs: 0, ctx0: 0, ctx1: 0,
    rows: [], spans: [], hits: [], snapshots: 0, recalls: 0, keys: '',
    ...(meta.agentType ? { agent: meta.agentType } : {}), ...(meta.effort ? { effort: meta.effort } : {}),
  };
  const rowsByKey = new Map<string, LedgerRow>();
  const counted: number[] = [];
  const localSeen = new Set<number>();
  const codex: CodexScanState = initialCodexState();
  let origin: SessionOrigin = null;
  let promptRead = isSub;
  let openSpan = -1;
  let pendingMem = 0;
  let carriedMem = 0;

  const count = (line: UsageLine) => {
    if (line.dedupeKey !== null) {
      const h = hashKey(line.dedupeKey);
      if (localSeen.has(h) || ctx.seen.has(h)) return;
      localSeen.add(h);
      counted.push(h);
    }
    if (openSpan >= 0 && line.ts - file.spans[openSpan][0] > OPEN_SPAN_MS) openSpan = -1;
    const model = ctx.intern(line.model);
    const hour = hourOf(line.ts);
    const fast: 0 | 1 = line.speed === 'fast' ? 1 : 0;
    const key = `${hour}|${model}|${fast}|${openSpan}`;
    let row = rowsByKey.get(key);
    if (!row) { row = [hour, model, fast, 0, 0, 0, 0, openSpan, 0, 0]; rowsByKey.set(key, row); }
    const t = line.totals;
    row[3] += t.input; row[4] += t.cacheRead; row[5] += t.cacheWrite; row[6] += t.output;
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
    const user = !promptRead && b.includes('"type":"user"');
    if (!usage && !hook && !compact && !user) return;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(b.toString('utf-8')) as Record<string, unknown>; } catch { return; }
    if (!file.cwd && typeof rec.cwd === 'string') file.cwd = rec.cwd;
    if (user) {
      const text = firstPromptText(rec);
      if (text !== null) { promptRead = true; origin = originOfFirstPrompt(text); }
    }
    if (compact) { if (rec.subtype === 'compact_boundary') carriedMem = 0; return; }
    if (hook) {
      const inj = claudeInjection(rec);
      if (inj) { pendingMem += inj.tokens; if (inj.kind === 'snapshot') file.snapshots += 1; else file.recalls += 1; }
      return;
    }
    const hit = claudeLimitHit(rec);
    if (hit !== null) { file.hits.push(hit); return; }
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

  const onLine = tool === 'claude' ? claudeLine : codexLine;
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
  const stale = found.filter((f) => {
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
      const entry = await scanFile(f.path, f.tool, f.size, f.mtime, { intern, seen });
      if (entry) ledger.files[f.path] = entry;
      state.progress = { done: state.progress.done + 1, total: stale.length };
    }
  }

  // Sessions Claude Code has pruned keep the account they were first seen on.
  let changed = stale.length > 0;
  const cutoff = Date.now() - KEEP_MS;
  for (const [path, entry] of Object.entries(ledger.files)) {
    if (entry.last && entry.last < cutoff) { delete ledger.files[path]; changed = true; continue; }
    if (entry.tool !== 'claude') continue;
    const account = accounts.get(entry.session);
    if (account && entry.account !== account) { entry.account = account; changed = true; }
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
