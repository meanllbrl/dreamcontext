import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateId, today } from './id.js';
import { safeResolveInside } from './safe-resolve.js';
import { inspectSleepLock, type SleepState } from './sleep-consolidation.js';
import { withSleepStateLock } from './sleep-state-lock.js';
import {
  candidateSimilarity,
  CorruptStoreError,
  isFeedbackReason,
  liveVerdicts,
  readFeedback,
  readFeedbackStrict,
  reasonLabel,
  type FeedbackReason,
  type TaskFeedbackEntry,
} from './task-feedback.js';
import { withTaskFileLock } from './task-file-lock.js';

/**
 * task-filing-rules — the "Görev açma kuralları" pattern, learned from rejects.
 *
 * `knowledge/patterns/task-filing-rules.md` is a normal pattern file (synced,
 * recalled, a `/pattern-…` command) whose `## Rules` section is written ONLY
 * through this module, so every rule keeps the shape the owner asked for:
 *
 *   - it CITES the reject records it rests on (ids in `.task-feedback.json`),
 *     and the count shown is computed from them, never typed;
 *   - it gives one "don't file like this" and one "file like this" example;
 *   - a new rule that resembles an existing one is refused ("merge instead"),
 *     and `merge` folds two rules into one;
 *   - the file never grows past {@link RULES_MAX_CHARS} / {@link MAX_RULES}.
 *
 * Sleep distils the rules (judgement: which rejects share a lesson, which rule
 * contradicts which) and writes them with `tasks rules set|merge`; the owner can
 * revert any change in one click from the Tasks screen. Every change is in
 * `state/.task-filing-rules-history.json`, which is what a revert reads.
 *
 * READ IS ENFORCED, NOT ASKED FOR. `dreamcontext tasks rules` prints the rules
 * and stamps `filing_rules_read: { hash, epoch }` into `.sleep.json`; while a
 * sleep is live, `tasks create --by sleep` and `tasks propose` refuse until that
 * stamp matches the CURRENT rules and the CURRENT epoch (task-filing-bar.ts).
 * `sleep start` prints the same text so the main agent's brief carries it.
 */

export const RULES_REL_PATH = 'knowledge/patterns/task-filing-rules.md';
export const RULES_HISTORY_REL_PATH = 'state/.task-filing-rules-history.json';
/** The whole file, frontmatter included. Past it, a rule must be merged or dropped first. */
export const RULES_MAX_CHARS = 8000;
export const MAX_RULES = 15;
/** A new rule this close to an existing one (stems of title + examples) must be merged into it. */
export const RULE_SIMILARITY = 0.5;
const MAX_HISTORY = 200;
const FIELD_MAX = 240;
/** The lock every rule change holds: the file and its history change together. */
const RULES_LOCK_KEY = '.task-filing-rules';

export interface FilingRule {
  /** `R<n>`, stable for the rule's life. */
  id: string;
  title: string;
  dont: string;
  do: string;
  /** The reject records (feedback ids) the rule rests on. */
  restsOn: string[];
  /** Reason counts at the time of writing, e.g. `{ "too-small": 2 }`. */
  reasons: Partial<Record<FeedbackReason, number>>;
  updated: string;
  by: 'sleep' | 'owner' | 'agent';
}

export interface RuleChange {
  at: string;
  by: FilingRule['by'];
  action: 'add' | 'update' | 'merge' | 'revert';
  id: string;
  before: FilingRule | null;
  after: FilingRule | null;
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}

// ─── The markdown file ───────────────────────────────────────────────────────

const RULE_META = /^<!-- rule (\{.*\}) -->$/;

function rulesPath(contextRoot: string): string {
  return safeResolveInside(contextRoot, RULES_REL_PATH);
}

/** The raw file, or '' when there is none yet. Never throws. */
export function readRulesText(contextRoot: string): string {
  try {
    const p = rulesPath(contextRoot);
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  } catch {
    return '';
  }
}

/** Parse the `## Rules` section. A hand-edited rule without its meta line is skipped. */
export function parseRules(text: string): FilingRule[] {
  const out: FilingRule[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = /^### (R\d+) · (.+)$/.exec(lines[i]);
    if (!head) continue;
    const meta = RULE_META.exec((lines[i + 1] ?? '').trim());
    if (!meta) continue;
    let m: Partial<FilingRule>;
    try { m = JSON.parse(meta[1]) as Partial<FilingRule>; } catch { continue; }
    let dont = '';
    let doIt = '';
    for (let j = i + 2; j < lines.length && !lines[j].startsWith('#'); j++) {
      const d = /^- \*\*Don't:\*\* (.*)$/.exec(lines[j]);
      const k = /^- \*\*Do:\*\* (.*)$/.exec(lines[j]);
      if (d) dont = d[1].trim();
      if (k) doIt = k[1].trim();
    }
    out.push({
      id: head[1],
      title: head[2].trim(),
      dont,
      do: doIt,
      restsOn: Array.isArray(m.restsOn) ? m.restsOn.filter((x): x is string => typeof x === 'string') : [],
      reasons: m.reasons && typeof m.reasons === 'object' ? m.reasons : {},
      updated: typeof m.updated === 'string' ? m.updated : '',
      by: m.by === 'owner' || m.by === 'agent' ? m.by : 'sleep',
    });
  }
  return out;
}

export function readRules(contextRoot: string): FilingRule[] {
  return parseRules(readRulesText(contextRoot));
}

function reasonLine(rule: FilingRule): string {
  const parts = Object.entries(rule.reasons)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([r, n]) => `${isFeedbackReason(r) ? reasonLabel(r) : r} ×${n}`);
  const n = rule.restsOn.length;
  return `Rests on ${n} reject${n === 1 ? '' : 's'}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.`;
}

/** The whole file for a rule set. `id` keeps the knowledge id across rewrites. */
export function renderRules(rules: FilingRule[], knowledgeId: string, date: string = today()): string {
  const body = rules.length === 0
    ? '_No rules yet: none of the owner\'s rejects has been distilled into one._'
    : rules.map((r) => [
      `### ${r.id} · ${r.title}`,
      `<!-- rule ${JSON.stringify({ restsOn: r.restsOn, reasons: r.reasons, updated: r.updated, by: r.by })} -->`,
      reasonLine(r),
      '',
      `- **Don't:** ${r.dont}`,
      `- **Do:** ${r.do}`,
    ].join('\n')).join('\n\n');
  return [
    '---',
    `id: ${knowledgeId}`,
    'name: Task filing rules',
    'description: >-',
    '  What sleep must not file as a task, distilled from the owner\'s rejects on the',
    '  Tasks screen. Every rule cites the rejects it rests on. Sleep reads this before',
    '  it files or proposes anything, and the CLI refuses until it has.',
    'tags:',
    "  - 'kind:pattern'",
    "  - 'topic:task'",
    "  - 'topic:sleep'",
    'pinned: true',
    `date: '${date}'`,
    '---',
    '',
    '## Why This Exists',
    '',
    'The tasks sleep opened were mostly not wanted. Each reject on the Tasks screen carries a reason',
    '(already exists, discussed then dropped, too small, badly written, wrong project, not work);',
    'sleep folds those rejects into the rules below, and the owner can revert any rule in one click.',
    'Written only by `dreamcontext tasks rules set|merge|revert`: hand edits to a rule are overwritten.',
    '',
    '## Rules',
    '',
    body,
    '',
  ].join('\n');
}

function knowledgeIdOf(text: string): string {
  return /^id: (\S+)$/m.exec(text)?.[1] ?? generateId('know');
}

/** The file for a rule set, refused past the size cap. Writes nothing. */
function checkedRulesText(contextRoot: string, rules: FilingRule[]): string {
  const text = renderRules(rules, knowledgeIdOf(readRulesText(contextRoot)));
  if (text.length > RULES_MAX_CHARS) {
    throw new RuleError(`The rules would be ${text.length} characters, over the ${RULES_MAX_CHARS} cap. `
      + 'Merge similar rules (tasks rules merge) or shorten the examples first.');
  }
  return text;
}

function writeRulesText(contextRoot: string, text: string): void {
  const p = rulesPath(contextRoot);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, p);
}

/**
 * Commit one change: history FIRST, then the file. A change the file never got is
 * a harmless history line (reverting it restores what the file already says); a
 * file change with no history line could never be reverted.
 */
function commitChange(contextRoot: string, rules: FilingRule[], changes: RuleChange[]): void {
  const text = checkedRulesText(contextRoot, rules);
  appendHistory(contextRoot, changes);
  writeRulesText(contextRoot, text);
}

/** Every rule change runs under one lock, so two writers never lose each other's change. */
function underRulesLock<T>(contextRoot: string, fn: () => T): T {
  try {
    return withTaskFileLock(contextRoot, RULES_LOCK_KEY, fn);
  } catch (err) {
    if (err instanceof CorruptStoreError) throw new RuleError(err.message);
    throw err;
  }
}

// ─── History (what a revert reads) ───────────────────────────────────────────

/** Missing = no changes yet; a file that exists but cannot be read throws {@link CorruptStoreError}. */
function readRuleHistoryStrict(contextRoot: string): RuleChange[] {
  const p = safeResolveInside(contextRoot, RULES_HISTORY_REL_PATH);
  if (!existsSync(p)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    throw new CorruptStoreError(RULES_HISTORY_REL_PATH);
  }
  if (!Array.isArray(parsed)) throw new CorruptStoreError(RULES_HISTORY_REL_PATH);
  return (parsed as RuleChange[]).filter((c) => c && typeof c.id === 'string');
}

/** For display. Never throws: an unreadable file reads as no changes. */
export function readRuleHistory(contextRoot: string): RuleChange[] {
  try {
    return readRuleHistoryStrict(contextRoot);
  } catch {
    return [];
  }
}

/** Refuses an unreadable history rather than replace it (a revert reads it). */
function appendHistory(contextRoot: string, changes: RuleChange[]): void {
  const history = readRuleHistoryStrict(contextRoot);
  const p = safeResolveInside(contextRoot, RULES_HISTORY_REL_PATH);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...changes, ...history].slice(0, MAX_HISTORY), null, 2) + '\n', 'utf-8');
  renameSync(tmp, p);
}

/** The latest change per rule, newest first — the Tasks screen's "recently updated rules". */
export function recentRuleChanges(contextRoot: string, limit = 5): Array<RuleChange & { title: string }> {
  const seen = new Set<string>();
  const out: Array<RuleChange & { title: string }> = [];
  for (const c of readRuleHistory(contextRoot)) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ ...c, title: (c.after ?? c.before)?.title ?? c.id });
    if (out.length >= limit) break;
  }
  return out;
}

// ─── Writing rules ───────────────────────────────────────────────────────────

/** Live rejects no rule cites yet: what the next distillation has to read. */
export function uncitedRejects(contextRoot: string): TaskFeedbackEntry[] {
  const cited = new Set(readRules(contextRoot).flatMap((r) => r.restsOn));
  return liveVerdicts(readFeedback(contextRoot)).filter((e) => e.verdict === 'reject' && !cited.has(e.id));
}

function clean(field: string, value: string | undefined): string {
  const v = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!v) throw new RuleError(`--${field} is required.`);
  if (v.length > FIELD_MAX) throw new RuleError(`--${field} is ${v.length} characters; keep it under ${FIELD_MAX}.`);
  return v;
}

function citations(contextRoot: string, ids: string[]): { restsOn: string[]; reasons: FilingRule['reasons'] } {
  const rejects = new Map(liveVerdicts(readFeedbackStrict(contextRoot)).filter((e) => e.verdict === 'reject').map((e) => [e.id, e]));
  const restsOn = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
  if (restsOn.length === 0) throw new RuleError('A rule rests on the owner\'s rejects: pass --rests-on <feedback ids> (see `tasks rules pending`).');
  const missing = restsOn.filter((id) => !rejects.has(id));
  if (missing.length > 0) {
    throw new RuleError(`Not a reject on record: ${missing.join(', ')}. A rule cites only real rejects (see \`tasks rules pending\`).`);
  }
  const reasons: FilingRule['reasons'] = {};
  for (const id of restsOn) {
    const r = rejects.get(id)!.reason;
    if (isFeedbackReason(r)) reasons[r] = (reasons[r] ?? 0) + 1;
  }
  return { restsOn, reasons };
}

function ruleText(r: Pick<FilingRule, 'title' | 'dont' | 'do'>): string {
  return `${r.title}\n${r.dont}\n${r.do}`;
}

export interface RuleInput {
  title?: string;
  dont?: string;
  do?: string;
  restsOn?: string[];
  by: FilingRule['by'];
}

/**
 * Add a rule (no `id`) or rewrite one (`id`). An edit keeps the old citations
 * unless new ones are given, and may ADD citations; a new rule that resembles
 * an existing one is refused in favour of a merge.
 */
export function setRule(contextRoot: string, id: string | null, input: RuleInput): FilingRule {
  return underRulesLock(contextRoot, () => {
    const rules = readRules(contextRoot);
    const at = new Date().toISOString();
    if (id) {
      const i = rules.findIndex((r) => r.id === id);
      if (i < 0) throw new RuleError(`No rule ${id}.`);
      const before = rules[i];
      const cites = input.restsOn ? citations(contextRoot, [...before.restsOn, ...input.restsOn]) : { restsOn: before.restsOn, reasons: before.reasons };
      const after: FilingRule = {
        id,
        title: input.title !== undefined ? clean('title', input.title) : before.title,
        dont: input.dont !== undefined ? clean('dont', input.dont) : before.dont,
        do: input.do !== undefined ? clean('do', input.do) : before.do,
        ...cites,
        updated: at,
        by: input.by,
      };
      rules[i] = after;
      commitChange(contextRoot, rules, [{ at, by: input.by, action: 'update', id, before, after }]);
      return after;
    }
    if (rules.length >= MAX_RULES) throw new RuleError(`There are already ${MAX_RULES} rules: merge two before adding one.`);
    const draft = { title: clean('title', input.title), dont: clean('dont', input.dont), do: clean('do', input.do) };
    const twin = rules.find((r) => candidateSimilarity(ruleText(r), ruleText(draft)) >= RULE_SIMILARITY);
    if (twin) {
      throw new RuleError(`This resembles ${twin.id} "${twin.title}". Fold it in: dreamcontext tasks rules set ${twin.id} --rests-on <ids> (and edit its text if the lesson changed).`);
    }
    const next = Math.max(0, ...rules.map((r) => Number(r.id.slice(1)) || 0), ...readRuleHistoryStrict(contextRoot).map((c) => Number(c.id.slice(1)) || 0)) + 1;
    const rule: FilingRule = { id: `R${next}`, ...draft, ...citations(contextRoot, input.restsOn ?? []), updated: at, by: input.by };
    commitChange(contextRoot, [...rules, rule], [{ at, by: input.by, action: 'add', id: rule.id, before: null, after: rule }]);
    return rule;
  });
}

/** Fold `drop` into `keep`: citations are unioned, `drop` disappears; both are history entries. */
export function mergeRules(contextRoot: string, keepId: string, dropId: string, input: Omit<RuleInput, 'restsOn'>): FilingRule {
  if (keepId === dropId) throw new RuleError('Merge two different rules.');
  return underRulesLock(contextRoot, () => {
    const rules = readRules(contextRoot);
    const keep = rules.find((r) => r.id === keepId);
    const drop = rules.find((r) => r.id === dropId);
    if (!keep || !drop) throw new RuleError(`No rule ${!keep ? keepId : dropId}.`);
    const at = new Date().toISOString();
    const merged: FilingRule = {
      id: keepId,
      title: input.title !== undefined ? clean('title', input.title) : keep.title,
      dont: input.dont !== undefined ? clean('dont', input.dont) : keep.dont,
      do: input.do !== undefined ? clean('do', input.do) : keep.do,
      ...citations(contextRoot, [...keep.restsOn, ...drop.restsOn]),
      updated: at,
      by: input.by,
    };
    commitChange(contextRoot, rules.filter((r) => r.id !== dropId).map((r) => (r.id === keepId ? merged : r)), [
      { at, by: input.by, action: 'merge', id: dropId, before: drop, after: null },
      { at, by: input.by, action: 'merge', id: keepId, before: keep, after: merged },
    ]);
    return merged;
  });
}

/**
 * Undo the latest change to one rule: it goes back to how it was before that
 * change (a rule that change created disappears; one it removed comes back).
 * The undo is itself a history entry, so it can be undone too.
 *
 * `expectAt` is the `at` of the change the caller SAW (the Tasks screen sends
 * it): when the latest change is a different one, the revert is refused. A
 * double tap would otherwise undo the first tap's own revert.
 */
export function revertRule(
  contextRoot: string,
  id: string,
  by: FilingRule['by'] = 'owner',
  expectAt?: string,
): FilingRule | null {
  return underRulesLock(contextRoot, () => {
    const last = readRuleHistoryStrict(contextRoot).find((c) => c.id === id);
    if (!last) throw new RuleError(`Rule ${id} has no recorded change to revert.`);
    if (expectAt !== undefined && last.at !== expectAt) {
      throw new RuleError(`Rule ${id} changed since you looked (its latest change is now a ${last.action} by ${last.by}). Look again before reverting.`);
    }
    const rules = readRules(contextRoot);
    const current = rules.find((r) => r.id === id) ?? null;
    const restored = last.before;
    const next = rules.filter((r) => r.id !== id);
    if (restored) {
      const at = rules.findIndex((r) => r.id === id);
      if (at >= 0) next.splice(at, 0, restored);
      else next.push(restored);
    }
    next.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    commitChange(contextRoot, next, [{ at: new Date().toISOString(), by, action: 'revert', id, before: current, after: restored }]);
    return restored;
  });
}

// ─── The read receipt ────────────────────────────────────────────────────────

/** Hash of what sleep must have read: the rules file as it is now ('' = none yet). */
export function rulesHash(contextRoot: string): string {
  return createHash('sha256').update(readRulesText(contextRoot)).digest('hex').slice(0, 16);
}

function readSleepJson(contextRoot: string): (SleepState & { filing_rules_read?: { hash?: string; epoch?: string | null } }) | null {
  try {
    return JSON.parse(readFileSync(join(contextRoot, 'state', '.sleep.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/** The epoch of a live (not stale) sleep, or null when no sleep is running. */
export function liveSleepEpoch(contextRoot: string, nowMs = Date.now()): string | null {
  const state = readSleepJson(contextRoot);
  if (!state) return null;
  const lock = inspectSleepLock(state, nowMs);
  return lock.locked && !lock.stale ? state.sleep_started_at : null;
}

/** Stamp that the rules as they are NOW were read in the live sleep. No-op with no sleep running. */
export function stampRulesRead(contextRoot: string): boolean {
  if (!liveSleepEpoch(contextRoot)) return false;
  const res = withSleepStateLock(contextRoot, () => {
    const state = readSleepJson(contextRoot);
    if (!state?.sleep_started_at) return false;
    state.filing_rules_read = { hash: rulesHash(contextRoot), epoch: state.sleep_started_at };
    writeFileSync(join(contextRoot, 'state', '.sleep.json'), JSON.stringify(state, null, 2) + '\n', 'utf-8');
    return true;
  });
  return res.locked && res.value === true;
}

/**
 * Null when filing may proceed; otherwise the refusal. Only a LIVE sleep is
 * held to it: "before sleep files a task, it has read the current rules".
 */
export function rulesReadRefusal(contextRoot: string): string | null {
  const epoch = liveSleepEpoch(contextRoot);
  if (!epoch) return null;
  const read = readSleepJson(contextRoot)?.filing_rules_read;
  if (read?.epoch === epoch && read.hash === rulesHash(contextRoot)) return null;
  return read?.epoch === epoch
    ? 'The task-filing rules changed since you read them. Read them again first: dreamcontext tasks rules'
    : 'Read the task-filing rules before filing or proposing anything this cycle: dreamcontext tasks rules';
}

/** The rules as sleep reads them (the `## Rules` section, or a line saying there are none). */
export function rulesForBrief(contextRoot: string): string {
  const rules = readRules(contextRoot);
  if (rules.length === 0) return 'Task-filing rules: none yet (no reject has been distilled into one).';
  return [
    `Task-filing rules (${RULES_REL_PATH}, from the owner's rejects):`,
    ...rules.map((r) => `- ${r.id} ${r.title} — don't: ${r.dont} — do: ${r.do} (${r.restsOn.length} reject${r.restsOn.length === 1 ? '' : 's'})`),
  ].join('\n');
}
