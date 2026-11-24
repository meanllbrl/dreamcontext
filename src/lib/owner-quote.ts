/**
 * Gate G1, once (plan global-uye-ogrenme D13): where his quoted words were typed, for every caller
 * that acts on them (`learn`, `agents edit`/`revert`, the `team-amend` route). And the filter a
 * change to something that rides in every project must also pass: that his words are ABOUT the
 * lines it changes ({@link quoteCoversChange}).
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conversationKeysFromEnv, findQuoteTurn, occasion, OWNER_WORDS_MAX_AGE_DAYS, readOwnerTurns, type OwnerTurnLine } from './owner-words.js';
import { tokenize } from './recall.js';
import { redactSecrets } from './telegram/format.js';

export const QUOTE_MAX_CHARS = 200;

export interface ResolvedQuote {
  /** His words as given, one line, redacted, at most {@link QUOTE_MAX_CHARS}. */
  text: string;
  turn: OwnerTurnLine | null;
  /** The turn is in the calling conversation. */
  here: boolean;
  /** The occasion of that turn ('' when none). */
  occasion: string;
}

export interface QuoteSet {
  quotes: ResolvedQuote[];
  /** One flag per quote: typed in THIS conversation. */
  here: boolean[];
  /** Every quote found a turn somewhere. */
  allResolved: boolean;
  /** Every quote was typed here, and the call has a conversation (G1 for an awake call). */
  allHere: boolean;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Resolve each quote to its ledger turn. `prefer`: turns to look past first (a saying again cites a
 * turn its rule does not cite yet). `keys` = the calling conversation's ids ([] for a sleep run).
 * Two quotes of one call name two turns when they can.
 */
export function resolveOwnerQuotes(
  rawQuotes: readonly string[],
  ctx: { keys: readonly string[]; turns: readonly OwnerTurnLine[]; prefer?: ReadonlySet<string> },
): QuoteSet {
  const turns = ctx.turns;
  const prefer = ctx.prefer ?? new Set<string>();
  const fresh = prefer.size > 0 ? turns.filter((t) => !prefer.has(t.turn)) : turns;
  const used = new Set<string>();
  const cache = new Map<string, string[]>();
  const quotes = rawQuotes.map(oneLine).filter(Boolean).map((q): ResolvedQuote => {
    const pools = [fresh.filter((t) => !used.has(t.turn)), fresh, turns];
    let hit = findQuoteTurn(q, pools[0]!, ctx.keys, cache);
    for (const pool of pools.slice(1)) { if (hit.turn) break; hit = findQuoteTurn(q, pool, ctx.keys, cache); }
    if (hit.turn) used.add(hit.turn.turn);
    return {
      text: redactSecrets(q).slice(0, QUOTE_MAX_CHARS),
      turn: hit.turn,
      here: hit.here,
      occasion: hit.turn ? occasion(hit.turn) : '',
    };
  });
  const here = quotes.map((q) => q.here);
  return {
    quotes,
    here,
    allResolved: quotes.length > 0 && quotes.every((q) => q.turn !== null),
    allHere: ctx.keys.length > 0 && quotes.length > 0 && here.every(Boolean),
  };
}

/**
 * G1 for one caller's quote (`agents edit`/`revert`, the `team-amend` route): was it typed in the
 * conversation `env` (or `keys`) names, relays included. Never throws: unreadable = not here.
 */
export function quoteTypedHere(quote: string, opts: { env?: NodeJS.ProcessEnv; keys?: readonly string[]; home?: string; now?: Date } = {}): boolean {
  try {
    const keys = opts.keys ?? conversationKeysFromEnv(opts.env ?? process.env);
    if (keys.length === 0 || !oneLine(quote)) return false;
    const now = opts.now ?? new Date();
    const since = new Date(now.getTime() - OWNER_WORDS_MAX_AGE_DAYS * 86_400_000).toISOString();
    const turns = readOwnerTurns({ ...(opts.home ? { home: opts.home } : {}), since });
    return resolveOwnerQuotes([quote], { keys, turns }).allHere;
  } catch {
    return false;
  }
}

// ─── Is he talking about these lines ────────────────────────────────────────

/** Two terms are one word told two ways: equal, or one shared stem of at least four letters. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i >= 4;
}

/** How many of the quote's terms name a term of `segments`. */
function sharedTerms(quoteTerms: readonly string[], segments: readonly string[]): number {
  const seg = new Set(tokenize(segments.join(' ')));
  let n = 0;
  for (const q of new Set(quoteTerms)) if ([...seg].some((t) => sameWord(q, t))) n += 1;
  return n;
}

/** Sentences (and lines) of a text, one line each. */
function sentences(text: string): string[] {
  return text.split(/\n|(?<=[.!?])\s+/).map(oneLine).filter(Boolean);
}

/**
 * Whether his words are about what this change adds and removes: the sentences of `after` that
 * `before` lacks, and of `before` that `after` lacks. Each changed side must share a term with the
 * quote, and a change that removes anything two in all (all, when it has fewer): so a removed
 * guard line that shares one of his words is NOT covered. A filter, never a proof: text that repeats two of his
 * words passes here and still meets `amendmentRisks`.
 */
export function quoteCoversChange(quote: string, before: string, after: string): boolean {
  const q = tokenize(quote);
  if (q.length === 0) return false;
  const was = new Set(sentences(before));
  const now = new Set(sentences(after));
  const added = [...now].filter((s) => !was.has(s));
  const removed = [...was].filter((s) => !now.has(s));
  if (added.length === 0 && removed.length === 0) return true;
  const changeTerms = new Set(tokenize([...added, ...removed].join(' ')));
  // Two shared terms only when something is removed (a guard line); an addition needs one.
  const need = removed.length > 0 ? Math.min(2, changeTerms.size) : Math.min(1, changeTerms.size);
  // A change with no term the tokenizer reads (another script, symbols only) is not shown to be
  // about his words: not covered (it waits for his card), never waved through.
  if (need === 0) return false;
  if (added.length > 0 && sharedTerms(q, added) < 1) return false;
  if (removed.length > 0 && sharedTerms(q, removed) < 1) return false;
  return sharedTerms(q, [...added, ...removed]) >= need;
}

/** At most this many keys of the delegating Super ride on a child (C3). */
export const MAX_DELEGATED_BY = 8;

function plainJson(path: string): unknown {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 8 * 1024 * 1024) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch { return null; }
}

/**
 * C3 (plan iyilesme-360 D3): a Super child's quote of its Super's chat is "here". The keys of the
 * Super conversation that delegated THIS session (`SuperChild.delegatedBy`, stamped by the server
 * at delegate time and carried on `--succeeds`), read from the main record and every member
 * Super's record. A session that is no child, an unreadable or linked record: []. Never throws.
 */
export function delegatingKeys(contextRoot: string | null | undefined, ownKeys: readonly string[]): string[] {
  if (!contextRoot || ownKeys.length === 0) return [];
  const own = new Set(ownKeys.filter(Boolean));
  const files = [join(contextRoot, 'state', '.super-agent.json')];
  const members = join(contextRoot, 'state', '.super', 'members');
  try {
    if (!lstatSync(members).isSymbolicLink()) {
      for (const n of readdirSync(members)) if (/^[a-z0-9][a-z0-9-]*\.json$/.test(n) && !n.includes('.read-marks')) files.push(join(members, n));
    }
  } catch { /* no member Supers */ }
  for (const f of files) {
    const rec = plainJson(f) as { children?: Record<string, { delegatedBy?: unknown }> } | null;
    const children = rec && typeof rec === 'object' && rec.children && typeof rec.children === 'object' ? rec.children : null;
    if (!children) continue;
    for (const [sid, ch] of Object.entries(children)) {
      if (!own.has(sid) || !ch || !Array.isArray(ch.delegatedBy)) continue;
      return ch.delegatedBy.filter((k): k is string => typeof k === 'string' && k !== '' && k.length <= 200).slice(0, MAX_DELEGATED_BY);
    }
  }
  return [];
}
