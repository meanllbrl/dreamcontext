import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readEvalSet, readRound, sourceDataDir } from './fixtures.js';
import { readFrontmatter } from '../frontmatter.js';
import {
  FEEDBACK_OUTCOMES,
  FEEDBACK_REASONS,
  type FeedbackOutcome,
  sleepEvalRoot,
  type FeedbackReason,
  type LabelItem,
  type TaskFeedbackEntry,
} from './types.js';

/**
 * The owner's verdicts on the test set. Same entry shape as `state/.task-feedback.json`,
 * kept apart from it on purpose: what sleep learns its filing rules from must never be the
 * answers it is graded against.
 */

export function labelsPath(contextRoot: string): string {
  return join(sleepEvalRoot(contextRoot), 'labels.json');
}

function isEntry(v: unknown): v is TaskFeedbackEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === 'string' && (e.verdict === 'keep' || e.verdict === 'reject') && typeof e.at === 'string';
}

/** Never throws: a corrupt file reads as "nothing labelled yet". */
export function readLabels(contextRoot: string): TaskFeedbackEntry[] {
  const p = labelsPath(contextRoot);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function writeLabels(contextRoot: string, entries: TaskFeedbackEntry[]): void {
  const p = labelsPath(contextRoot);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
  renameSync(tmp, p);
}

/** Every item of the frozen set, in round order: what the real sleep opened, then candidates. */
export function allLabelItems(contextRoot: string): LabelItem[] {
  const set = readEvalSet(contextRoot);
  if (!set) return [];
  const out: LabelItem[] = [];
  for (const id of set.rounds) {
    const round = readRound(contextRoot, id);
    if (!round) continue;
    out.push(...round.opened, ...round.candidates);
  }
  return out;
}

export interface LabelQueue {
  total: number;
  labelled: number;
  /** The cards that must be answered: every task a real sleep opened. */
  required: { total: number; labelled: number };
  pending: LabelItem[];
}

/** Items still waiting for a verdict (newest verdict per id wins). */
export function labelQueue(contextRoot: string): LabelQueue {
  const items = allLabelItems(contextRoot);
  const done = new Set(readLabels(contextRoot).map((e) => e.id));
  const opened = items.filter((i) => i.category === 'opened');
  return {
    total: items.length,
    labelled: items.filter((i) => done.has(i.id)).length,
    required: { total: opened.length, labelled: opened.filter((i) => done.has(i.id)).length },
    pending: deckOrder(items.filter((i) => !done.has(i.id))),
  };
}

/**
 * The order the deck asks in, so the owner can stop anywhere and still have useful
 * answers (owner 2026-10-16: "do I have to answer all 210?"): first every task a real
 * sleep opened (only the owner can say whether to keep it, and precision rests on them),
 * then the candidates round-robin across rounds, so an early stop still covers every round.
 */
export function deckOrder(items: LabelItem[]): LabelItem[] {
  const opened = items.filter((i) => i.category === 'opened');
  const byRound = new Map<string, LabelItem[]>();
  for (const i of items) {
    if (i.category === 'opened') continue;
    byRound.set(i.round, [...(byRound.get(i.round) ?? []), i]);
  }
  const queues = [...byRound.values()];
  const rest: LabelItem[] = [];
  for (let depth = 0; queues.some((q) => q.length > depth); depth++) {
    for (const q of queues) if (q[depth]) rest.push(q[depth]);
  }
  return [...opened, ...rest];
}

export interface LabelInput {
  id: string;
  /** Derived from `outcome` when one is given ('nothing' = reject). */
  verdict?: 'keep' | 'reject';
  outcome?: string | null;
  reason?: string | null;
  note?: string;
  name?: string;
  why?: string;
}

export class LabelError extends Error {}

/**
 * Record one verdict. A reject of a task sleep really opened must say why (one of the
 * five reasons): that reason is what the duplicate/abandoned counts are built from. A
 * reject of a model candidate only says the candidate is wrong; its reason is optional.
 * Re-labelling an item replaces its earlier verdict.
 */
export function recordLabel(contextRoot: string, input: LabelInput, now: Date = new Date()): TaskFeedbackEntry {
  const item = allLabelItems(contextRoot).find((i) => i.id === input.id);
  if (!item) throw new LabelError(`Unknown label item: ${input.id}`);
  let outcome: FeedbackOutcome | null = null;
  if (input.outcome) {
    if (!(FEEDBACK_OUTCOMES as readonly string[]).includes(input.outcome)) {
      throw new LabelError(`outcome must be one of: ${FEEDBACK_OUTCOMES.join(', ')}`);
    }
    if (item.category === 'style-correction') throw new LabelError('A repeated correction is a yes/no card: send verdict, not outcome.');
    outcome = input.outcome as FeedbackOutcome;
  }
  const verdict: 'keep' | 'reject' | undefined = outcome ? (outcome === 'nothing' ? 'reject' : 'keep') : input.verdict;
  if (verdict !== 'keep' && verdict !== 'reject') throw new LabelError('verdict must be keep or reject (or send an outcome)');
  let reason: FeedbackReason | null = null;
  if (input.reason) {
    if (!(FEEDBACK_REASONS as readonly string[]).includes(input.reason)) {
      throw new LabelError(`reason must be one of: ${FEEDBACK_REASONS.join(', ')}`);
    }
    reason = input.reason as FeedbackReason;
  }
  // "Do nothing" is the answer the duplicate / abandoned counts are built from: it must say why.
  if (verdict === 'reject' && (item.category === 'opened' || outcome === 'nothing') && !reason) {
    throw new LabelError('"Nothing" needs a reason.');
  }
  const diff: TaskFeedbackEntry['diff'] = {};
  if (input.name && input.name.trim() && input.name.trim() !== item.name) diff.name = { from: item.name, to: input.name.trim() };
  if (input.why && input.why.trim() && input.why.trim() !== item.why) diff.why = { from: item.why, to: input.why.trim() };
  const entry: TaskFeedbackEntry = {
    id: item.id,
    at: now.toISOString(),
    source: 'sleep-eval',
    verdict,
    ...(outcome ? { outcome } : {}),
    proposal: { name: item.name, why: item.why, parent: item.parent ?? null },
    basis: item.basis,
    quote: item.quote,
    reason: verdict === 'reject' ? reason : null,
    ...(input.note && input.note.trim() ? { note: input.note.trim().slice(0, 1000) } : {}),
    diff: Object.keys(diff).length > 0 ? diff : null,
  };
  const rest = readLabels(contextRoot).filter((e) => e.id !== item.id);
  writeLabels(contextRoot, [...rest, entry]);
  return entry;
}

/** id → newest verdict. */
export function labelIndex(entries: TaskFeedbackEntry[]): Map<string, TaskFeedbackEntry> {
  const map = new Map<string, TaskFeedbackEntry>();
  for (const e of entries) {
    const prev = map.get(e.id);
    if (!prev || prev.at <= e.at) map.set(e.id, e);
  }
  return map;
}

/**
 * A pending card as the deck shows it: the item plus the human NAME of the task it points
 * at (a slug tells the owner nothing) and the date of the round it came from.
 */
export interface LabelCard extends LabelItem {
  parentName?: string | null;
  source?: string | null;
}

export function labelCards(contextRoot: string, items: LabelItem[]): LabelCard[] {
  const names = new Map<string, string | null>();
  const nameOf = (dataDir: string, slug: string): string | null => {
    const key = `${dataDir}\0${slug}`;
    if (names.has(key)) return names.get(key) ?? null;
    let name: string | null = null;
    try {
      const { data } = readFrontmatter<{ name?: unknown }>(join(dataDir, 'board', `${slug}.md`));
      name = typeof data.name === 'string' ? data.name.replace(/\s+/g, ' ').trim() : null;
    } catch { /* an unknown slug shows as itself */ }
    names.set(key, name);
    return name;
  };
  const rounds = new Map<string, ReturnType<typeof readRound>>();
  return items.map((i) => {
    if (!rounds.has(i.round)) rounds.set(i.round, readRound(contextRoot, i.round));
    const round = rounds.get(i.round);
    const dataDir = sourceDataDir(contextRoot, round ?? {});
    return {
      ...i,
      parentName: i.parent ? nameOf(dataDir, i.parent) ?? i.parent : null,
      source: round?.source?.name ?? null,
    };
  });
}
