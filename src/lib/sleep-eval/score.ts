import { createHash } from 'node:crypto';
import { foldAscii } from '../fold-ascii.js';
import type { FeedbackReason, LabelItem, SleepEvalScoring, TaskFeedbackEntry } from './types.js';

/**
 * Scoring one eval run against the owner's labels. Pure: the similarity function is
 * passed in, so the arithmetic is pinned by tests and the matcher (embeddings, or the
 * lexical fallback) is recorded in the report.
 *
 * The owner's gold, per labelled item (an unlabelled or rejected candidate is not gold):
 *   opened + keep            should be opened
 *   opened + reject(reason)  must not be opened, for that reason
 *   explicit-ask + keep      should be captured (a task, or folded into one)
 *   sub-detail + keep        should land under `parent`
 *   abandoned + keep         must not be opened (abandoned)
 *   other-project + keep     must not be opened (wrong project)
 *   style-correction + keep  should become a pattern
 */

export interface OutputTask {
  slug: string;
  name: string;
  why: string;
  parent: string | null;
}

export interface OutputFold {
  /** The existing task the run wrote into. */
  slug: string;
  /** That task's own parent, to credit a fold into a sibling under the right parent. */
  parent: string | null;
  text: string;
}

export interface OutputPattern {
  path: string;
  text: string;
}

/** What one round of a run changed in its scratch vault. */
export interface RoundOutput {
  round: string;
  opened: OutputTask[];
  folds: OutputFold[];
  patterns: OutputPattern[];
  /** Board task names, for the duplicate check. */
  boardNames: Array<{ slug: string; name: string }>;
  error?: string | null;
}

/** Similarity in [0,1] between two texts. */
export type Similarity = (a: string, b: string) => number;

type Negative = 'already-exists' | 'abandoned' | 'wrong-project' | 'other';

interface GoldItem {
  item: LabelItem;
  positive: boolean;
  negative: Negative | null;
  /** For a positive: open a new task, or put it into `parent` (a criterion or a sub-task). */
  mode?: 'open' | 'fold';
  /** The task it belongs in (mode 'fold'); null when the owner said "an existing task" without one. */
  parent?: string | null;
}

/**
 * The owner's answer per item. A card answered with an OUTCOME ("what should sleep have
 * done?") is read directly; older yes/no answers keep their category's meaning.
 */
export function goldFor(items: LabelItem[], labels: Map<string, TaskFeedbackEntry>): GoldItem[] {
  const out: GoldItem[] = [];
  for (const item of items) {
    const label = labels.get(item.id);
    if (!label) continue;
    if (item.category === 'style-correction') {
      if (label.verdict === 'keep') out.push({ item, positive: true, negative: null });
      continue;
    }
    if (label.outcome === 'nothing' || (label.verdict === 'reject' && item.category === 'opened')) {
      out.push({ item, positive: false, negative: negativeOf(label.reason ?? null) });
      continue;
    }
    if (label.outcome === 'new-task') { out.push({ item, positive: true, negative: null, mode: 'open', parent: null }); continue; }
    if (label.outcome === 'add-to-task') { out.push({ item, positive: true, negative: null, mode: 'fold', parent: item.parent ?? null }); continue; }
    // Older yes/no answers.
    if (label.verdict !== 'keep') continue;
    if (item.category === 'opened') out.push({ item, positive: true, negative: null, mode: item.parent ? 'fold' : 'open', parent: item.parent ?? null });
    else if (item.category === 'abandoned') out.push({ item, positive: false, negative: 'abandoned' });
    else if (item.category === 'other-project') out.push({ item, positive: false, negative: 'wrong-project' });
    else if (item.category === 'sub-detail') out.push({ item, positive: true, negative: null, mode: 'fold', parent: item.parent ?? null });
    else out.push({ item, positive: true, negative: null, mode: 'open', parent: null });
  }
  return out;
}

function negativeOf(reason: FeedbackReason | null): Negative {
  if (reason === 'already-exists' || reason === 'abandoned' || reason === 'wrong-project') return reason;
  return 'other';
}

/** The text an item is matched on: what it is, why, and the owner's own words. */
export function itemText(item: LabelItem, label?: TaskFeedbackEntry): string {
  const name = label?.diff?.name?.to ?? item.name;
  const why = label?.diff?.why?.to ?? item.why;
  return [name, why, item.quote].filter(Boolean).join('. ');
}

export function taskText(t: { name: string; why: string }): string {
  return [t.name, t.why].filter(Boolean).join('. ');
}

export interface Ratio {
  hit: number;
  total: number;
}

export interface RoundScore {
  round: string;
  error: string | null;
  opened: number;
  kept: number;
  duplicates: number;
  abandoned: number;
  wrongProject: number;
  /** Opened as a new task what belonged in an existing one. */
  shouldFold: number;
  /** Opened tasks no labelled item matches: counted as not kept, listed for the owner. */
  unknown: OutputTask[];
  asks: Ratio;
  parents: Ratio;
  patterns: Ratio;
  /** Gold items in this round, and how many items are still unlabelled. */
  gold: number;
}

/**
 * Greedy one-to-one matching: the most similar (output, item) pairs first, each side used
 * once, only pairs at or above the threshold.
 */
export function matchPairs<A, B>(as: A[], bs: B[], score: (a: A, b: B) => number, threshold: number): Array<[A, B, number]> {
  const pairs: Array<[number, number, number]> = [];
  as.forEach((a, i) => bs.forEach((b, j) => {
    const s = score(a, b);
    if (s >= threshold) pairs.push([i, j, s]);
  }));
  pairs.sort((x, y) => y[2] - x[2]);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: Array<[A, B, number]> = [];
  for (const [i, j, s] of pairs) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    out.push([as[i], bs[j], s]);
  }
  return out;
}

export function scoreRound(
  items: LabelItem[],
  labels: Map<string, TaskFeedbackEntry>,
  out: RoundOutput,
  sim: Similarity,
  scoring: Pick<SleepEvalScoring, 'matchThreshold' | 'duplicateThreshold'>,
): RoundScore {
  const gold = goldFor(items.filter((i) => i.round === out.round), labels);
  const textOf = (g: GoldItem) => itemText(g.item, labels.get(g.item.id));
  const t = scoring.matchThreshold;

  // 1. Every opened task against every gold item (positive or negative).
  const openedMatches = matchPairs(out.opened, gold, (o, g) => sim(taskText(o), textOf(g)), t);
  const matchedOpened = new Map(openedMatches.map(([o, g]) => [o, g]));
  let kept = 0, duplicates = 0, abandoned = 0, wrongProject = 0;
  const unknown: OutputTask[] = [];
  let shouldFold = 0;
  for (const o of out.opened) {
    const g = matchedOpened.get(o);
    // Belonged in an existing task: a sub-task under the right parent is fine, a new top-level task is not.
    if (g?.positive && g.mode === 'fold' && (g.parent ? o.parent !== g.parent : !o.parent)) { shouldFold++; continue; }
    if (g?.positive) { kept++; continue; }
    if (g?.negative === 'already-exists') { duplicates++; continue; }
    if (g?.negative === 'abandoned') { abandoned++; continue; }
    if (g?.negative === 'wrong-project') { wrongProject++; continue; }
    if (g) continue; // rejected for another reason: not kept, already counted by precision
    const twin = out.boardNames.some((b) => sim(taskText(o), b.name) >= scoring.duplicateThreshold);
    if (twin) duplicates++;
    else unknown.push(o);
  }

  // 2. Captured asks and the parent each went under. An item is captured by an opened task
  //    (matched above) or by text folded into an existing task.
  const positives = gold.filter((g) => g.positive);
  const unmatchedPositives = positives.filter((g) => ![...matchedOpened.values()].includes(g));
  const foldMatches = matchPairs(out.folds, unmatchedPositives, (f, g) => sim(f.text, textOf(g)), t);
  const capturedBy = new Map<GoldItem, { parent: string | null; foldSlug: string | null }>();
  for (const [o, g] of openedMatches) if (g.positive) capturedBy.set(g, { parent: o.parent, foldSlug: null });
  for (const [f, g] of foldMatches) capturedBy.set(g, { parent: f.parent, foldSlug: f.slug });

  const askItems = positives.filter((g) => g.item.category !== 'style-correction' && g.item.category !== 'opened');
  const asks: Ratio = { hit: askItems.filter((g) => capturedBy.has(g)).length, total: askItems.length };

  const parentItems = positives.filter((g) => g.mode === 'fold' && g.parent);
  const parents: Ratio = {
    total: parentItems.length,
    hit: parentItems.filter((g) => {
      const c = capturedBy.get(g);
      if (!c) return false;
      return c.foldSlug === g.parent || c.parent === g.parent;
    }).length,
  };

  // 3. Corrections that became a pattern: any changed pattern file close enough to one.
  const corrections = positives.filter((g) => g.item.category === 'style-correction');
  const patternParas = out.patterns.flatMap((p) => p.text.split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x.length > 20));
  const patterns: Ratio = {
    total: corrections.length,
    hit: corrections.filter((g) => patternParas.some((para) => sim(para, textOf(g)) >= t)).length,
  };

  return {
    round: out.round,
    error: out.error ?? null,
    opened: out.opened.length,
    kept,
    duplicates,
    abandoned,
    wrongProject,
    shouldFold,
    unknown,
    asks,
    parents,
    patterns,
    gold: gold.length,
  };
}

export interface RunScore {
  rounds: RoundScore[];
  opened: number;
  kept: number;
  duplicates: number;
  abandoned: number;
  wrongProject: number;
  shouldFold: number;
  precision: number | null;
  askRecall: number | null;
  parentRate: number | null;
  patternRate: number | null;
  /** Mean of the defined rates — the one number the close gate compares. */
  composite: number | null;
  gold: number;
}

const rate = (r: Ratio): number | null => (r.total > 0 ? r.hit / r.total : null);

/** Micro-average across rounds: every item weighs the same, wherever it sits. */
export function aggregate(rounds: RoundScore[]): RunScore {
  const sum = (f: (r: RoundScore) => number) => rounds.reduce((n, r) => n + f(r), 0);
  const ratio = (f: (r: RoundScore) => Ratio): Ratio => ({ hit: sum((r) => f(r).hit), total: sum((r) => f(r).total) });
  const opened = sum((r) => r.opened);
  const kept = sum((r) => r.kept);
  const precision = opened > 0 ? kept / opened : null;
  const askRecall = rate(ratio((r) => r.asks));
  const parentRate = rate(ratio((r) => r.parents));
  const patternRate = rate(ratio((r) => r.patterns));
  const defined = [precision, askRecall, parentRate, patternRate].filter((x): x is number => x !== null);
  return {
    rounds,
    opened,
    kept,
    duplicates: sum((r) => r.duplicates),
    abandoned: sum((r) => r.abandoned),
    wrongProject: sum((r) => r.wrongProject),
    shouldFold: sum((r) => r.shouldFold ?? 0),
    precision,
    askRecall,
    parentRate,
    patternRate,
    composite: defined.length > 0 ? defined.reduce((a, b) => a + b, 0) / defined.length : null,
    gold: sum((r) => r.gold),
  };
}

/** A fingerprint of the labels a score was computed against: scores compare only on equal ones. */
export function labelsHash(entries: TaskFeedbackEntry[]): string {
  const canon = [...entries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => [e.id, e.verdict, e.outcome ?? '', e.reason ?? '', e.diff?.name?.to ?? '', e.diff?.why?.to ?? '']);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

// ─── Similarity providers ────────────────────────────────────────────────────

function words(s: string): Set<string> {
  return new Set(
    foldAscii(s.toLowerCase())
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

/** Lexical fallback when the embedding model is not available: Jaccard over folded words. */
export const lexicalSimilarity: Similarity = (a, b) => {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
};

/** Cosine of two L2-normalized vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * A similarity backed by precomputed vectors: every text the scorer will compare must be
 * in `vectors` (the runner embeds them all once, in one batch).
 */
export function vectorSimilarity(vectors: Map<string, Float32Array>, fallback: Similarity = lexicalSimilarity): Similarity {
  return (a, b) => {
    const va = vectors.get(a);
    const vb = vectors.get(b);
    return va && vb ? cosine(va, vb) : fallback(a, b);
  };
}

/** Every text `scoreRound` may compare, so they can be embedded up front. */
export function textsToEmbed(items: LabelItem[], labels: Map<string, TaskFeedbackEntry>, outputs: RoundOutput[]): string[] {
  const set = new Set<string>();
  for (const i of items) set.add(itemText(i, labels.get(i.id)));
  for (const o of outputs) {
    for (const t of o.opened) set.add(taskText(t));
    for (const f of o.folds) set.add(f.text);
    for (const b of o.boardNames) set.add(b.name);
    for (const p of o.patterns) for (const para of p.text.split(/\n\s*\n/)) if (para.trim().length > 20) set.add(para.trim());
  }
  return [...set];
}
