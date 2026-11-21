/**
 * Gate G1, once (plan global-uye-ogrenme D13): where his quoted words were typed, for every caller
 * that acts on them (`learn`, `agents edit`/`revert`, the `team-amend` route). And the filter a
 * change to something that rides in every project must also pass: that his words are ABOUT the
 * lines it changes ({@link quoteCoversChange}).
 */
import { findQuoteTurn, occasion, type OwnerTurnLine } from './owner-words.js';
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
 * quote, and the change as a whole two (all, when it has fewer): so a removed guard line that
 * shares one of his words is NOT covered. A filter, never a proof: text that repeats two of his
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
  const need = Math.min(2, changeTerms.size);
  if (need === 0) return true;
  if (added.length > 0 && sharedTerms(q, added) < 1) return false;
  if (removed.length > 0 && sharedTerms(q, removed) < 1) return false;
  return sharedTerms(q, [...added, ...removed]) >= need;
}
