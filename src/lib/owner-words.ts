/**
 * The owner-words ledger (learning loop C3): what the owner typed, as the app's server saw him type it.
 *
 * One line per owner turn in `<home>/.dreamcontext/owner-words/<YYYY-MM>.jsonl`, written only by
 * {@link appendOwnerTurn}, which only the server's `writeOwnerTurn` calls (the hook never writes).
 * `own` is ONLY what he typed: no quote-reply, no About or agenda block, no forward. Nothing else of
 * the turn is kept. The file is machine-local (0600, dir 0700) and never synced.
 *
 * Two questions, two functions. {@link sameConversation} answers G1's "did he say it here" (any
 * shared id). {@link occasion} answers "is this another time he said it": the live session the
 * server observed when the turn was written, never the pane's pin or the tab id.
 *
 * Gate G1 itself lives in `learn` (src/cli/commands/learn.ts); the quote test it uses is here
 * ({@link quoteCovers}, {@link findQuoteTurn}) so every caller measures a quote the same way.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tokenize } from './recall.js';

export type OwnerTurnVia = 'composer' | 'phone' | 'telegram';
export const OWNER_TURN_VIAS: readonly OwnerTurnVia[] = ['composer', 'phone', 'telegram'];

export interface OwnerTurnLine {
  /** ISO time the server wrote the turn. */
  at: string;
  /** Unique turn id, from {@link newOwnerTurnId}. */
  turn: string;
  /** Realpath of the project root whose `_dream_context` the chat runs in ('' when none). */
  vault: string;
  /** Chat kind as the server knows it (free string, never decides anything). */
  surface: string;
  via: OwnerTurnVia;
  /** Every id the server has for the chat (deduped, non-empty). */
  keys: string[];
  /** The occasion: the live session id the server last observed, or the id it pinned; '' if none. */
  session: string;
  /** ONLY what he typed. */
  own: string;
}

/** Whole month files older than this (after the month ended) are removed by {@link pruneOwnerWords}. */
export const OWNER_WORDS_MAX_AGE_DAYS = 45;

/** One turn never holds more than this much of his text (a pasted wall stays bounded). */
const OWN_MAX_CHARS = 64 * 1024;

const MONTH_FILE_RE = /^(\d{4})-(\d{2})\.jsonl$/;

export function ownerWordsDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'owner-words');
}

export function newOwnerTurnId(): string {
  return `t${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

function monthOf(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-/.exec(iso);
  return m ? `${m[1]}-${m[2]}` : null;
}

function cleanKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  for (const k of keys) {
    if (typeof k !== 'string') continue;
    const v = k.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The line's shape, or null. Shared by the writer and the reader so both refuse the same things. */
export function normalizeOwnerTurn(raw: unknown): OwnerTurnLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string';
  if (!str(r.at) || Number.isNaN(Date.parse(r.at)) || !monthOf(r.at)) return null;
  if (!str(r.turn) || !r.turn.trim()) return null;
  if (!str(r.own)) return null;
  if (!OWNER_TURN_VIAS.includes(r.via as OwnerTurnVia)) return null;
  return {
    at: r.at,
    turn: r.turn.trim(),
    vault: str(r.vault) ? r.vault : '',
    surface: str(r.surface) ? r.surface : '',
    via: r.via as OwnerTurnVia,
    keys: cleanKeys(r.keys),
    session: str(r.session) ? r.session.trim() : '',
    own: r.own.length > OWN_MAX_CHARS ? r.own.slice(0, OWN_MAX_CHARS) : r.own,
  };
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/**
 * Append one turn. Never throws: a failed write is swallowed with one console.warn (an owner turn
 * must reach his chat whatever the ledger does). One write() per line, file 0600, dir 0700.
 */
export function appendOwnerTurn(line: OwnerTurnLine, opts: { home?: string } = {}): void {
  try {
    const clean = normalizeOwnerTurn(line);
    if (!clean) throw new Error('not an owner turn line');
    const dir = ownerWordsDir(opts.home ?? homedir());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (isSymlink(dir)) throw new Error(`${dir} is a symlink`);
    const file = join(dir, `${monthOf(clean.at)}.jsonl`);
    if (isSymlink(file)) throw new Error(`${file} is a symlink`);
    const fd = openSync(file, 'a', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, `${JSON.stringify(clean)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    console.warn(`[dreamcontext] owner words not recorded: ${(err as Error).message}`);
  }
}

function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Every readable turn, oldest first. A torn or foreign line is skipped; readers cross the month
 * boundary. `since` (ISO) keeps turns at or after it; `vault` keeps one project's turns.
 */
export function readOwnerTurns(opts: { home?: string; since?: string; vault?: string } = {}): OwnerTurnLine[] {
  const dir = ownerWordsDir(opts.home ?? homedir());
  if (isSymlink(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir).filter((n) => MONTH_FILE_RE.test(n)).sort(); } catch { return []; }
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const sinceMonth = opts.since ? monthOf(new Date(Number.isNaN(sinceMs) ? 0 : sinceMs).toISOString()) : null;
  const vault = opts.vault ? realOrSelf(opts.vault) : null;
  const out: OwnerTurnLine[] = [];
  for (const name of names) {
    if (sinceMonth && name.slice(0, 7) < sinceMonth) continue;
    const file = join(dir, name);
    if (isSymlink(file)) continue;
    let text: string;
    try { text = readFileSync(file, 'utf-8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { continue; }
      const t = normalizeOwnerTurn(parsed);
      if (!t) continue;
      if (!Number.isNaN(sinceMs) && Date.parse(t.at) < sinceMs) continue;
      if (vault !== null && t.vault !== vault && realOrSelf(t.vault) !== vault) continue;
      out.push(t);
    }
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}

/** G1's question, "did he say it here": one shared id is a yes. */
export function sameConversation(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a.map((k) => k.trim()).filter(Boolean));
  return b.some((k) => set.has(k.trim()));
}

/** The counting question's unit: the live session of the turn ('' when the server had none). */
export function occasion(t: OwnerTurnLine): string {
  return t.session;
}

/**
 * The ids `learn` can see for its own conversation, the same kinds the server puts in `keys[]`:
 * the Claude session id (never under a bridge tool, where it is the server's parent's), the chat
 * tab's id the server sets for a child, the Codex thread id.
 */
export function conversationKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const tool = env.DREAMCONTEXT_AGENT_TOOL;
  const bridge = tool === 'codex' || tool === 'antigravity';
  const keys = [
    bridge ? '' : env.CLAUDE_CODE_SESSION_ID,
    env.DREAMCONTEXT_TAB_SESSION,
    tool === 'codex' ? env.CODEX_THREAD_ID : '',
  ];
  return cleanKeys(keys);
}

/** Remove whole month files that ended more than `maxAgeDays` ago. Never rewrites the current month. */
export function pruneOwnerWords(opts: { home?: string; now?: Date; maxAgeDays?: number } = {}): string[] {
  const dir = ownerWordsDir(opts.home ?? homedir());
  if (isSymlink(dir)) return [];
  const now = (opts.now ?? new Date()).getTime();
  const maxAge = (opts.maxAgeDays ?? OWNER_WORDS_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    const m = MONTH_FILE_RE.exec(name);
    if (!m) continue;
    const monthEnd = Date.UTC(Number(m[1]), Number(m[2]), 1); // first day of the next month
    if (now - monthEnd <= maxAge) continue;
    const file = join(dir, name);
    if (isSymlink(file)) continue;
    try { rmSync(file, { force: true }); removed.push(name); } catch { /* next sleep tries again */ }
  }
  return removed;
}

// ─── The quote test (G1) ────────────────────────────────────────────────────

/** A quote must cover this share of its content terms, in order, inside one turn's `own`. */
export const QUOTE_COVERAGE = 0.8;
/** A quote with fewer content terms than this proves nothing (it would match everything). */
export const QUOTE_MIN_TERMS = 2;

function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** True when `quote` covers at least {@link QUOTE_COVERAGE} of its content terms, in order, in `own`. */
export function quoteCovers(quote: string, own: string, ownTerms?: readonly string[]): boolean {
  const q = tokenize(quote);
  if (q.length < QUOTE_MIN_TERMS) return false;
  const o = ownTerms ?? tokenize(own);
  return lcsLength(q, o) / q.length >= QUOTE_COVERAGE;
}

export interface QuoteResolution {
  /** The earliest turn whose `own` covers the quote, preferring this conversation's turns. */
  turn: OwnerTurnLine | null;
  /** True when that turn is in the calling conversation (G1 for an awake call). */
  here: boolean;
}

/**
 * Where a quote was typed. The earliest turn of THIS conversation that covers it; else the
 * earliest turn anywhere (so a child forwarding his line and the Super citing it name one turn).
 */
export function findQuoteTurn(
  quote: string,
  turns: readonly OwnerTurnLine[],
  keys: readonly string[],
  cache: Map<string, string[]> = new Map(),
): QuoteResolution {
  const termsOf = (t: OwnerTurnLine): string[] => {
    let terms = cache.get(t.turn);
    if (!terms) { terms = tokenize(t.own); cache.set(t.turn, terms); }
    return terms;
  };
  let anywhere: OwnerTurnLine | null = null;
  for (const t of turns) {
    if (!quoteCovers(quote, t.own, termsOf(t))) continue;
    if (keys.length > 0 && sameConversation(keys, t.keys)) return { turn: t, here: true };
    if (!anywhere) anywhere = t;
  }
  return { turn: anywhere, here: false };
}
