/**
 * Align a raw transcript against a corrected one, and say exactly what changed.
 *
 * ── WHY AN ALIGNMENT AND NOT A ZIP ──────────────────────────────────────────────────────
 * A per-token diff presumes 1:1 correspondence, and this feature's own motivating example
 * breaks it: raw `Sırıp başlat` versus corrected `sleep, başlat` INSERTS a comma, desyncing
 * every later position under a naive zip. There is no diff library in this repo to fall back
 * on, so the alignment is specified rather than assumed: casefold, strip punctuation, run an
 * LCS, and read the operations off it.
 *
 * ── WHY EVERY OPERATION IS A CHANGE ─────────────────────────────────────────────────────
 * A `substitute` is a change; so is an `insert` (an inserted token has no raw counterpart, so
 * nothing can vouch for it) and so is a `delete` (the corrector must not silently drop
 * spoken content). There is no operation class that passes quietly, which is why the
 * token-count shape guard and the under-12-character carve-out an earlier design needed are
 * both absent: they existed to bound an auto-submit path that no longer exists.
 *
 * ── WHAT THE DISTANCE IS STILL FOR ──────────────────────────────────────────────────────
 * {@link similarity} survives with ALL of its gating power removed. It decides how loudly a
 * substitution is drawn in the confirmation UI — a replacement far from what was spoken is
 * highlighted harder than a near one — and nothing else. It must never decide WHETHER
 * confirmation happens. An adversarial search broke that idea decisively: 11 of 21 dangerous
 * pairs slipped under a 0.75 veto (`list`→`last` 0.25, `merge`→`purge` 0.40, `start`→`stop`
 * 0.60, `create`→`delete` 0.67, `ekle`→`sil` exactly 0.75), and no threshold separates them
 * because the legitimate `Sırıp`→`sleep` and the hostile `start`→`stop` BOTH score 0.60.
 * Sharper still: `kaydet`→`kaldır` (~0.67) needs no attacker at all, because `kaldır` is the
 * kind of word an ordinary task title puts in the lexicon by itself.
 */

/** One aligned operation. `equal` is the only one that is not a change. */
export type AlignOpKind = 'equal' | 'substitute' | 'insert' | 'delete';

export interface AlignOp {
  kind: AlignOpKind;
  /** The spoken token, or '' for an insert. */
  from: string;
  /** The corrected token, or '' for a delete. */
  to: string;
  /** 0..1 similarity between `from` and `to`, for a substitute. How LOUDLY the change is
   *  drawn — never whether it is shown. */
  similarity?: number;
}

/** Split on whitespace. Punctuation is handled by {@link fold}, not by the split, so a token
 *  and its trailing comma stay one token and the comma shows up as a change to that token. */
export function tokenize(text: string): string[] {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean);
}

/**
 * Casefold and strip punctuation for COMPARISON only — the original token is what is shown.
 *
 * `toLocaleLowerCase('tr')` rather than `toLowerCase()`: Turkish `I` lowercases to dotless
 * `ı`, and getting that wrong would make `Sırıp` and `SIRIP` compare unequal in a feature
 * whose entire subject is Turkish speech.
 */
export function fold(token: string): string {
  return String(token ?? '')
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}'’-]/gu, '');
}

/** Levenshtein distance, iterative two-row. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 for identical, 0 for nothing in common. See the header for what this may NOT decide. */
export function similarity(a: string, b: string): number {
  const x = fold(a);
  const y = fold(b);
  if (!x && !y) return 1;
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 1;
  return 1 - editDistance(x, y) / longest;
}

/**
 * Does `token` match lexicon term `term`, allowing for Turkish suffixes?
 *
 * Turkish attaches suffixes to loanwords constantly — `task'ın`, `sleep'i`, `lab'da` — and
 * this mode's briefing tells the agent to mirror Turkish, so the suffixed form is the MOST
 * COMMON real shape of a correct output, not an edge case. Requiring exact equality would
 * revert exactly the corrections the feature exists to make.
 *
 * Three shapes accepted: equal, equal up to an apostrophe (`sleep'i`), and equal after
 * dropping a short trailing suffix with no apostrophe (`taskin`). The last is deliberately
 * capped at three characters so `starting` does not match `star`.
 */
export function matchesLexiconTerm(token: string, term: string): boolean {
  const t = fold(token);
  const l = fold(term);
  if (!t || !l) return false;
  if (t === l) return true;
  const apostrophe = t.search(/['’]/);
  if (apostrophe > 0 && t.slice(0, apostrophe) === l) return true;
  if (t.length > l.length && t.length - l.length <= 3 && t.startsWith(l)) return true;
  return false;
}

/** True when `token` is any term in the lexicon, suffixes allowed. */
export function inLexicon(token: string, lexicon: readonly string[]): boolean {
  return lexicon.some((term) => matchesLexiconTerm(token, term));
}

/**
 * Align `raw` against `corrected` and return the operation list.
 *
 * Classic LCS over the FOLDED tokens, with the walk-back preferring `substitute` over an
 * adjacent delete+insert pair — a replaced word reads as one change to a person, and drawing
 * it as two would make the confirmation screen harder to check, which is the one thing it
 * cannot afford to be.
 */
export function alignTranscripts(raw: string, corrected: string): AlignOp[] {
  const a = tokenize(raw);
  const b = tokenize(corrected);
  const fa = a.map(fold);
  const fb = b.map(fold);

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = fa[i] === fb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (fa[i] === fb[j]) {
      ops.push({ kind: 'equal', from: a[i], to: b[j] });
      i++; j++;
      continue;
    }
    // Both sides have an unmatched token here AND neither is part of a longer common run
    // that the other could still reach — that is a replacement, not a drop next to an add.
    if (lcs[i + 1][j + 1] >= lcs[i + 1][j] && lcs[i + 1][j + 1] >= lcs[i][j + 1]) {
      ops.push({ kind: 'substitute', from: a[i], to: b[j], similarity: similarity(a[i], b[j]) });
      i++; j++;
      continue;
    }
    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: 'delete', from: a[i], to: '' });
      i++;
    } else {
      ops.push({ kind: 'insert', from: '', to: b[j] });
      j++;
    }
  }
  while (i < a.length) { ops.push({ kind: 'delete', from: a[i++], to: '' }); }
  while (j < b.length) { ops.push({ kind: 'insert', from: '', to: b[j++] }); }
  return ops;
}

/** Every op that is not `equal`. If this is empty the corrector changed nothing. */
export function changedOps(ops: readonly AlignOp[]): AlignOp[] {
  return ops.filter((op) => op.kind !== 'equal');
}
