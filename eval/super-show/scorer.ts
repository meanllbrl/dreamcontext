/**
 * The scorer of `eval/super-show` (jarvis plan r9, AC11b): did the Super Agent SHOW the set the
 * owner asked to see, instead of telling it? Pure: the run's record and the answer in, a verdict
 * out. Pinned by `tests/unit/super-show-scorer.test.ts`, whose negative fixture is the owner's own
 * case of 2026-10-20 (the tasks written as a list, one card opened, another card closed).
 *
 * PASS only when ALL hold:
 *  (a) every gold item is a card on the stage: an ungrouped floating card, or a member of a
 *      floating group (a gold card in Others fails);
 *  (b) no item outside gold (a finished task) was opened;
 *  (c) the answer lists no items: no `-`, `*` or `1.` lines, and names at most one gold title;
 *  (d) the answer is at most two sentences;
 *  (e) more than 3 gold items sit in ONE group;
 *  (f) under capacity pressure (cards already open): no gold item skipped, at least one of the
 *      cards that were open went to Others, and none of them was closed.
 */

export interface ScoreCard { id: string; kind: string; ref: string; place: 'float' | 'others' }
export interface ScoreGroup { id: string; cards: string[]; place: 'float' | 'others' }

export interface ScoreCase {
  kind: string;
  /** The refs the owner's request means (open tasks, every insight …). */
  gold: string[];
  /** Refs of the same kind that must NOT be opened (finished tasks). */
  notGold: string[];
  /** Human titles of the gold items, to spot them named in the answer. */
  titles: string[];
  /** Ids of the cards open before the prompt (the capacity case). */
  preOpen?: string[];
}

export interface ScoreRun {
  containers: ScoreCard[];
  groups: ScoreGroup[];
  answer: string;
}

export interface Verdict { pass: boolean; failed: string[] }

/** Sentences in a reply: split on . ! ? followed by space or end, ignoring empty pieces. */
export function sentenceCount(text: string): number {
  return text.replace(/```[\s\S]*?```/g, ' ').split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter((s) => /\p{L}|\d/u.test(s)).length;
}

export function scoreShow(c: ScoreCase, run: ScoreRun): Verdict {
  const failed: string[] = [];
  const byRef = new Map(run.containers.filter((k) => k.kind === c.kind).map((k) => [k.ref, k] as const));
  const groupOf = new Map<string, ScoreGroup>();
  for (const g of run.groups) for (const id of g.cards) groupOf.set(id, g);
  const onStage = (k: ScoreCard): boolean => {
    const g = groupOf.get(k.id);
    return g ? g.place === 'float' : k.place === 'float';
  };

  // (a)
  const missing = c.gold.filter((ref) => { const k = byRef.get(ref); return !k || !onStage(k); });
  if (missing.length) failed.push(`a: not on the stage: ${missing.join(', ')}`);
  // (b)
  // A card that was already open before the prompt (the capacity case) is not "opened".
  const pre = new Set(c.preOpen ?? []);
  const extra = c.notGold.filter((ref) => { const k = byRef.get(ref); return !!k && !pre.has(k.id); });
  if (extra.length) failed.push(`b: opened outside the set: ${extra.join(', ')}`);
  // (c)
  const listLines = run.answer.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l));
  if (listLines.length) failed.push(`c: ${listLines.length} list line(s) in the answer`);
  const lower = run.answer.toLowerCase();
  const named = c.titles.filter((t) => t && lower.includes(t.toLowerCase()));
  if (named.length > 1) failed.push(`c: names ${named.length} items in the answer`);
  // (d)
  const n = sentenceCount(run.answer);
  if (n > 2) failed.push(`d: ${n} sentences`);
  // (e)
  if (c.gold.length > 3) {
    const groups = new Set(c.gold.map((ref) => { const k = byRef.get(ref); return k ? groupOf.get(k.id)?.id ?? null : null; }));
    if (groups.size !== 1 || groups.has(null)) failed.push('e: more than 3 items, not in one group');
  }
  // (f)
  if (c.preOpen?.length) {
    const have = new Map(run.containers.map((k) => [k.id, k] as const));
    const closed = c.preOpen.filter((id) => !have.has(id));
    if (closed.length) failed.push(`f: ${closed.length} open card(s) closed to make room`);
    const stacked = c.preOpen.filter((id) => have.get(id)?.place === 'others');
    if (!stacked.length) failed.push('f: no open card went to Others');
  }
  return { pass: failed.length === 0, failed };
}
