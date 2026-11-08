/**
 * plan-ledger — the planning loop's state, as a pure function of what was recorded.
 *
 * A plan's review loop used to live in the lead's head and its handoff notes: the round count
 * reset on every owner addition and every new session, "the same finding twice" meant the
 * same WORDS, and nothing stopped a class of problem from coming back round after round (the
 * Telegram plan ran 30 rounds; one class of leak took 15 of them). The ledger records what
 * happened (rounds, each lens's parsed review, the owner's decisions) and everything else is
 * computed here: which findings are open, how many rounds each class has cost, which stop
 * stands, whether the plan is done, and the one gap every door into Develop asks.
 *
 * Pure: no fs, no clock. `plan-store.ts` reads and writes the files; `cli/commands/plan.ts`
 * is the only writer. The contract is the plan's "State model" and "Stops" sections
 * (task planlama-dongusu-sinif-bazli-…, 2026-11-08), restated where each rule is applied.
 */

import type { HandoffGap } from './handoff-readiness.js';
import { CODE_REVISION_RECIPE, CODE_STOP_CARD } from './code-review-rules.js';
import { PLAN_REVISION_RECIPE, PLAN_STOP_CARD } from './plan-review-rules.js';

// ─── Shape ───────────────────────────────────────────────────────────────────

export const PLAN_LEDGER_VERSION = 1;
export const PLAN_BUDGET_BASE = 8;
export const PLAN_NAME_RE = /^[a-z0-9-]{1,80}$/;
export const FIXED_SECOND_LENSES = ['security', 'edge-cases'] as const;
export const PLAN_LENSES = ['critic', 'security', 'edge-cases', 'pragmatist'] as const;
export type PlanLens = typeof PLAN_LENSES[number];

export type LensVerdict = 'PENDING' | 'SOLID' | 'NEEDS_WORK' | 'PROPOSALS' | 'PASS' | 'FAIL' | 'UNPARSED' | 'ABANDONED';
export type FindingLevel = 'Critical' | 'Major';
export const FINDING_KINDS = ['premise', 'contract', 'security', 'criteria', 'map'] as const;

/**
 * Code mode (2026-11-08, task develop-inceleme-dongusu-…): the SAME ledger runs a Develop
 * run's code review loop. Measured over 390 Develop runs: of 180 blocking findings inside
 * review loops, 42% were holes the previous fix opened and 32% another site of the same
 * class, and 39% of the "Major"s were small. So the plan's class rule (2nd counted round →
 * redesign, 3rd → the owner's stop card) applies unchanged; what differs is the reviewers
 * (the end review's `reviewer` or its team), the verdict (PASS / FAIL), the finding's third
 * field (where it came from, not what it violates) and a harm line every blocking finding
 * must carry. There is no round cap: rounds are counted, never limited.
 */
export type LedgerMode = 'plan' | 'code';
export const CODE_LENSES = ['reviewer', 'review-edge-cases', 'review-security', 'review-frontend', 'review-cloud-functions'] as const;
/** Where a code finding came from: the previous fix opened it, another site of a known class, or neither. */
export const CODE_ORIGINS = ['new', 'fix-hole', 'same-class'] as const;

export interface LedgerFinding {
  id: string;
  level: FindingLevel;
  cls: string;
  kind: string;
  /** The finding's own sentence and evidence, kept so a split can carry it to another task. */
  text?: string;
}

export interface LensRecord {
  verdict: LensVerdict;
  dispatchedAt: string;
  file?: string;
  findings: LedgerFinding[];
  closed?: Array<{ id: string; why: string }>;
  proposals?: string[];
  /** Why the review was not accepted (UNPARSED) or not delivered (ABANDONED). */
  note?: string;
  recordedAt?: string;
  /** Position on the ledger's one clock (`Ledger.seq`); orders reviews against events. */
  seq?: number;
  /** Code mode: this lens's scope when it differs from the round's (a team member in round 1). */
  paths?: string[];
  /** Code mode: blocking-shaped findings with no concrete harm, recorded as Minor. */
  downgraded?: Array<{ id: string; cls: string; text: string }>;
}

export interface LedgerRound {
  n: number;
  openedAt: string;
  snapshotSha: string;
  openSeq?: number;
  lenses: Record<string, LensRecord>;
  /** Code mode: the tree this round reviews, the tree it is read against, and the paths. */
  tree?: string;
  base?: string;
  paths?: string[];
}

export type LedgerEventKind = 'continue' | 'narrow' | 'split' | 'accept' | 'add' | 'merge' | 'redesign' | 'abandon';

export interface LedgerEvent {
  at: string;
  round: number;
  kind: LedgerEventKind;
  note?: string;
  finding?: string;
  cls?: string;
  into?: string;
  /** split: the whole classes moved, the ids they held, and the follow-up task. */
  classes?: string[];
  moved?: string[];
  task?: string;
  seq?: number;
}

export interface Ledger {
  v: number;
  plan: string;
  goal: string;
  task: string;
  lenses: string[];
  budget: { base: number; extra: number; unlimited: boolean };
  createdAt: string;
  seq?: number;
  events: LedgerEvent[];
  rounds: LedgerRound[];
  /** Absent = a plan (every ledger written before code mode). */
  mode?: LedgerMode;
  /** Code mode: the run's start tree and the task's criteria, read once at open. */
  start?: string;
  criteria?: string;
  [extra: string]: unknown;
}

export const isCodeLedger = (ledger: Pick<Ledger, 'mode'>): boolean => ledger.mode === 'code';

/** The lenses a round waits on: a plan's fixed pair, or the code round's own set. */
export function roundLenses(ledger: Ledger, round: LedgerRound): string[] {
  return isCodeLedger(ledger) ? Object.keys(round.lenses) : ledger.lenses;
}

/** Trimmed and lowercased: "Build Gate " and "build gate" are one class. */
export function normClass(cls: string): string {
  return cls.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The ledger's one clock. Every review and event takes the next tick. */
export function nextSeq(ledger: Ledger): number {
  ledger.seq = (ledger.seq ?? 0) + 1;
  return ledger.seq;
}

/** Shape check for a ledger read from disk. A failure means every verb refuses. */
export function ledgerProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'not a JSON object';
  const l = raw as Partial<Ledger>;
  if (l.v !== PLAN_LEDGER_VERSION) return `unknown ledger version ${JSON.stringify(l.v)} (this CLI reads v${PLAN_LEDGER_VERSION})`;
  if (typeof l.plan !== 'string' || typeof l.task !== 'string') return 'missing plan or task';
  if (l.mode !== undefined && l.mode !== 'plan' && l.mode !== 'code') return `unknown mode ${JSON.stringify(l.mode)}`;
  const code = l.mode === 'code';
  const lensSet: readonly string[] = code ? CODE_LENSES : PLAN_LENSES;
  if (code) {
    if (!Array.isArray(l.lenses) || l.lenses.length === 0 || new Set(l.lenses).size !== l.lenses.length || l.lenses.some((x) => !lensSet.includes(x as string))) {
      return `lenses must be a non-empty set of ${CODE_LENSES.join(', ')}`;
    }
  } else if (!Array.isArray(l.lenses) || l.lenses.length !== 2 || l.lenses[0] !== 'critic' || !(FIXED_SECOND_LENSES as readonly string[]).includes(l.lenses[1] as string)) {
    return 'lenses must be the fixed pair (critic + security or edge-cases)';
  }
  if (!l.budget || typeof l.budget.base !== 'number' || typeof l.budget.extra !== 'number') return 'missing budget';
  if (!Array.isArray(l.events) || !Array.isArray(l.rounds)) return 'missing events or rounds';
  if (code && l.start !== undefined && !GIT_OBJECT_RE.test(String(l.start))) return 'start must be a git object id';
  for (const e of l.events) {
    if (!e || typeof e !== 'object' || typeof (e as LedgerEvent).kind !== 'string') return 'an event is malformed';
    for (const k of ['moved', 'classes'] as const) if ((e as LedgerEvent)[k] !== undefined && !Array.isArray((e as LedgerEvent)[k])) return `an event's ${k} is not a list`;
  }
  for (const r of l.rounds) {
    if (!r || typeof r.n !== 'number' || !r.lenses || typeof r.lenses !== 'object') return 'a round is malformed';
    if (code && Object.keys(r.lenses).length === 0) return `round ${r.n} has no lenses`;
    // A packet prints these into the git commands a reviewer runs: only an object id may reach it.
    if (code && [r.tree, r.base].some((t) => t !== undefined && !GIT_OBJECT_RE.test(String(t)))) return `round ${r.n}: tree and base must be git object ids`;
    for (const [lens, rec] of Object.entries(r.lenses)) {
      if (!lensSet.includes(lens)) return `unknown lens "${lens}" in round ${r.n}`;
      if (!rec || typeof rec !== 'object' || typeof rec.verdict !== 'string' || !Array.isArray(rec.findings)) return `round ${r.n} ${lens} is malformed`;
      if (rec.closed !== undefined && !Array.isArray(rec.closed)) return `round ${r.n} ${lens}: closed is not a list`;
      if (rec.findings.some((f) => !f || typeof f.id !== 'string' || typeof f.cls !== 'string' || typeof f.level !== 'string')) return `round ${r.n} ${lens}: a finding is malformed`;
    }
  }
  return null;
}

// ─── Review parsing ─────────────────────────────────────────────────────────

export interface ParseContext {
  round: number;
  lens: string;
  /** This lens's open findings (id → level) as of the latest complete round. */
  ownOpen: Map<string, FindingLevel>;
  /** Every other id open on the plan (another lens's): re-stating one is advisory. */
  otherOpen: Set<string>;
  /** Owner-accepted ids (Major). */
  accepted: Set<string>;
  /** Moved ids already closed `cut`. */
  cut: Set<string>;
  /** Code mode: the review format of a code reviewer, and the class names a `same-class` may use. */
  mode?: LedgerMode;
  knownClasses?: Set<string>;
}

export interface ParsedReview {
  verdict: LensVerdict;
  findings: LedgerFinding[];
  closed: Array<{ id: string; why: string }>;
  proposals: string[];
  /** Why the review is UNPARSED, with the lines the CLI expected. Empty = accepted. */
  errors: string[];
  /** Code mode: Majors written without a concrete harm, kept as Minor (never open, never counted). */
  downgraded: Array<{ id: string; cls: string; text: string }>;
  /** Code mode: the reviewer ran out of turns (`PARTIAL`); its text is kept for the re-dispatch. */
  partial?: boolean;
}

const CODE_FINDING_RE = /^\s*(\d+)\.\s*\[(Critical|Major)\]\s*id:\s*([^|]+?)\s*\|\s*class:\s*([^|]+?)\s*\|\s*origin:\s*([^|]+?)\s*(?:\|\s*(.*))?$/i;
/** A START, NOW, FIX or base tree as the code ledger stores it. */
export const GIT_OBJECT_RE = /^[0-9a-f]{7,64}$/;
/** The `harm:` field wherever it stands among the fields after origin (backticks allowed). */
const HARM_RE = /(?:^|\|)\s*`?harm`?\s*:\s*(.*)$/i;
/** The harm a finding's field tail names, or undefined when it has no `harm:` field. */
export function harmOf(rest: string): string | undefined {
  return HARM_RE.exec(rest)?.[1];
}
/** A harm that names nobody and nothing ("none", "n/a", "-", "tbd") is no harm; length is no measure. */
export function hasConcreteHarm(harm: string | undefined): boolean {
  const h = (harm ?? '').trim().replace(/[.!]+$/, '');
  return h !== '' && !/^(?:none|n\/?a|-+|tbd|todo|unknown|minor|cosmetic|\?+)$/i.test(h);
}

const FINDING_START_RE = /^\s*\d+\.\s*\[/;
const FINDING_RE = /^\s*(\d+)\.\s*\[(Critical|Major)\]\s*id:\s*([^|]+?)\s*\|\s*class:\s*([^|]+?)\s*\|\s*kind:\s*([^|]+?)\s*(?:\|\s*(.*))?$/i;
const CLOSED_RE = /^\s*closed:\s*([^|]+?)\s*\|\s*(.+?)\s*$/i;
const PROPOSAL_RE = /^\s*-\s*(cut|defer|premise):\s*(.+)$/i;
const SECTION_END_RE = /^\s*(?:#+\s*)?(?:build notes|non-blocking)\b/i;
/** A severity token that marks a blocking finding, wherever the line starts. */
const LEVEL_TOKEN_RE = /\[\s*(?:critical|major)\s*\]/i;

/**
 * Parse a lens's raw review against the format in PLAN_REVIEW_RULES. Never throws: a review
 * the ledger cannot read is `UNPARSED`, with the reasons, so the lead re-dispatches it into
 * the same round instead of the loop counting a guess.
 */
export function parseReview(text: string, ctx: ParseContext): ParsedReview {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const errors: string[] = [];
  const first = lines.find((l) => l.trim() !== '') ?? '';
  const head = first.replace(/[*#`]/g, '').trim().toUpperCase();
  const code = ctx.mode === 'code';
  const pragmatist = !code && ctx.lens === 'pragmatist';
  const allowed = code ? ['PASS', 'FAIL'] : pragmatist ? ['PROPOSALS', 'SOLID'] : ['SOLID', 'NEEDS_WORK'];
  let verdict: LensVerdict = allowed.includes(head) ? (head as LensVerdict) : 'UNPARSED';
  const partial = code && head === 'PARTIAL';
  if (partial) errors.push('`PARTIAL` is not a verdict: the reviewer ran out of turns. Its text is kept and handed to the fresh copy, which re-states its findings and reads the `Not reviewed:` paths');
  else if (verdict === 'UNPARSED') errors.push(`first line must be exactly ${allowed.map((v) => `\`${v}\``).join(' or ')}`);

  const downgraded: Array<{ id: string; cls: string; text: string }> = [];
  const findings: LedgerFinding[] = [];
  const closed: Array<{ id: string; why: string }> = [];
  const proposals: string[] = [];
  const restated = new Set<string>();
  let blockingLines = 0;
  let inBlocking = true;
  let current: LedgerFinding | null = null;
  const seenK = new Set<string>();

  for (const raw of lines.slice(lines.indexOf(first) + 1)) {
    const line = raw.replace(/\*\*/g, '');
    if (SECTION_END_RE.test(line)) { inBlocking = false; current = null; continue; }
    const c = CLOSED_RE.exec(line);
    if (c) { closed.push({ id: c[1].trim(), why: c[2].trim() }); current = null; continue; }
    const p = PROPOSAL_RE.exec(line);
    if (p && pragmatist) { proposals.push(`${p[1].toLowerCase()}: ${p[2].trim()}`); continue; }
    if (!inBlocking) continue;
    if (!FINDING_START_RE.test(line) && LEVEL_TOKEN_RE.test(line)) {
      // A blocking finding written in another shape (a bullet, "1)") would be skipped silently.
      blockingLines += 1;
      errors.push(`unreadable finding line (use \`<k>. [Critical|Major] id: …\`): "${raw.trim().slice(0, 120)}"`);
      current = null;
      continue;
    }
    if (FINDING_START_RE.test(line)) {
      blockingLines += 1;
      current = null;
      const m = (code ? CODE_FINDING_RE : FINDING_RE).exec(line);
      if (!m) {
        errors.push(code
          ? `unreadable finding line (use \`<k>. [Critical|Major] id: <id|new> | class: <name> | origin: <new|fix-hole|same-class> | harm: <who loses what>\`): "${raw.trim().slice(0, 120)}"`
          : `unreadable finding line: "${raw.trim().slice(0, 120)}"`);
        continue;
      }
      const [, k, lvl, rawId, cls, kind, rest] = m;
      if (seenK.has(k)) {
        // Two findings numbered alike would get one id and the open set would keep only one.
        errors.push(`finding number ${k} is used twice: number the blocking list 1, 2, 3… once`);
        continue;
      }
      seenK.add(k);
      const level = (lvl[0].toUpperCase() + lvl.slice(1).toLowerCase()) as FindingLevel;
      const id = rawId.trim();
      const kindN = kind.trim().toLowerCase();
      const kinds: readonly string[] = code ? CODE_ORIGINS : FINDING_KINDS;
      if (!kinds.includes(kindN)) {
        errors.push(`finding ${k}: ${code ? 'origin' : 'kind'} must be one of ${kinds.join('|')}, got "${kind.trim()}"`);
        continue;
      }
      let text = (rest ?? '').trim();
      if (code) {
        const harm = harmOf(text);
        if (kindN === 'same-class' && !(ctx.knownClasses ?? new Set()).has(normClass(cls))) {
          errors.push(`finding ${k}: origin \`same-class\` needs a class from the packet's Known classes, got "${cls.trim()}"`);
          continue;
        }
        if (!hasConcreteHarm(harm)) {
          if (level === 'Critical') {
            errors.push(`finding ${k}: a Critical names its harm: \`| harm: <the user or the data that is hurt, and how>\``);
            continue;
          }
          if (ctx.ownOpen.has(id)) {
            // An open finding leaves only by `closed:`; re-stated without its harm it would slip out.
            errors.push(`finding ${k}: ${id} is open, so re-state it with its harm, or close it: \`closed: ${id} | <why>\``);
            continue;
          }
          // A Major with no concrete harm is a Minor: kept in the record, never open, never counted.
          downgraded.push({ id: `r${ctx.round}-${ctx.lens}-${k}`, cls: normClass(cls), text: text.slice(0, 300) });
          blockingLines -= 1;
          continue;
        }
        text = `harm: ${harm!.trim()}`;
      }
      const fresh = { id: `r${ctx.round}-${ctx.lens}-${k}`, level, cls: normClass(cls), kind: kindN, text };
      if (id.toLowerCase() === 'new') { findings.push(fresh); current = fresh; continue; }
      if (ctx.ownOpen.has(id)) {
        restated.add(id);
        const f = { ...fresh, id };
        findings.push(f);
        current = f;
        continue;
      }
      if (ctx.accepted.has(id)) {
        // An accepted Major listed again is ignored; listed higher it is a new finding.
        if (level === 'Critical') { findings.push(fresh); current = fresh; }
        continue;
      }
      if (ctx.cut.has(id) || ctx.otherOpen.has(id)) continue; // moved-and-cut, or advisory
      findings.push(fresh); // an id this ledger does not hold open: a new finding
      current = fresh;
      continue;
    }
    if (current && line.trim() !== '') {
      const add = line.trim();
      if ((current.text ?? '').length < 600) current.text = `${current.text ? `${current.text} ` : ''}${add}`.slice(0, 600);
    }
  }

  if (verdict === 'SOLID' && blockingLines > 0) {
    errors.push('`SOLID` cannot carry blocking findings: drop them to Build notes, or answer `NEEDS_WORK`');
  }
  if (verdict === 'PROPOSALS' && blockingLines > 0) errors.push('the pragmatist never blocks: list proposals, not findings');
  if (verdict === 'NEEDS_WORK' && blockingLines === 0) errors.push('`NEEDS_WORK` needs at least one blocking finding line');
  if (verdict === 'PASS' && blockingLines > 0) errors.push('`PASS` cannot carry blocking findings: move them under `Non-blocking`, or answer `FAIL`');
  if (verdict === 'FAIL' && blockingLines === 0) {
    // Every blocking finding was a Major with no harm: a review of Minors is a pass.
    if (downgraded.length > 0) verdict = 'PASS';
    else errors.push('`FAIL` needs at least one blocking finding line');
  }
  if (!pragmatist) {
    const closedOwn = new Set(closed.map((c) => c.id).filter((id) => ctx.ownOpen.has(id)));
    const missing = [...ctx.ownOpen.keys()].filter((id) => !restated.has(id) && !closedOwn.has(id));
    if (missing.length > 0) {
      errors.push(`own open ids neither re-stated nor closed: ${missing.join(', ')}. Expected for each: \`closed: <id> | <why>\` or the finding re-stated with \`id: <id>\``);
    }
  }
  if (errors.length > 0) verdict = 'UNPARSED';
  return { verdict, findings, closed: closed.filter((c) => ctx.ownOpen.has(c.id)), proposals, errors, downgraded, ...(partial ? { partial } : {}) };
}

// ─── State ──────────────────────────────────────────────────────────────────

export type StopKind = 'redesign' | 'class' | 'budget' | 'churn';
export interface PlanStop { kind: StopKind; cls?: string }

export interface OpenFinding extends LedgerFinding { lens: string; round: number }

export type NextAction =
  | { kind: 'abandoned' }
  | { kind: 'review'; lenses: string[]; redispatch: string[] }
  | { kind: 'revise' }
  | { kind: 'redesign'; classes: string[] }
  | { kind: 'stop'; stops: PlanStop[] }
  | { kind: 'done' };

export interface PlanState {
  plan: string;
  task: string;
  abandoned: boolean;
  /** Latest round number (0 = none opened). */
  round: number;
  roundComplete: boolean;
  latestComplete: number;
  /** Per fixed lens, the verdict in the latest round. */
  verdicts: Record<string, LensVerdict>;
  open: OpenFinding[];
  accepted: string[];
  /** Moved ids not yet closed `cut` (owed to their lens), and those already cut. */
  moved: string[];
  cut: string[];
  classCounts: Record<string, number>;
  knownClasses: string[];
  budget: { base: number; extra: number; unlimited: boolean; limit: number | null };
  stops: PlanStop[];
  done: boolean;
  /** A split after the latest complete round: the next round needs a `split:` line. */
  splitPending: { classes: string[]; moved: string[] } | null;
  /** Criticals recorded in a round still in progress (abandon counts them). */
  pendingCriticals: string[];
  next: NextAction;
}

const COMPLETE: readonly LensVerdict[] = ['SOLID', 'NEEDS_WORK', 'PASS', 'FAIL'];
export const isCompleteVerdict = (v: LensVerdict | undefined): boolean => !!v && COMPLETE.includes(v);
const CLEARING_DECISIONS: readonly LedgerEventKind[] = ['continue', 'narrow', 'split', 'abandon'];

/** The lens that owns an id (`r3-edge-cases-1` → `edge-cases`); null for a malformed id. */
export function ownerOf(id: string): string | null {
  return /^r\d+-(.+)-\d+$/.exec(id)?.[1] ?? null;
}

/** When a round completed on the ledger clock: every lens it waits on holds a verdict. */
export function roundCompleteSeq(ledger: Ledger, round: LedgerRound): number | null {
  let max = round.openSeq ?? 0;
  for (const lens of roundLenses(ledger, round)) {
    const rec = round.lenses[lens];
    if (!rec || !COMPLETE.includes(rec.verdict)) return null;
    max = Math.max(max, rec.seq ?? 0);
  }
  return max;
}

/** Class aliases from `merge-class`, applied everywhere: a merge only ever grows a count. */
export function classResolver(events: LedgerEvent[]): (c: string) => string {
  const alias = new Map<string, string>();
  for (const e of events) if (e.kind === 'merge' && e.cls && e.into) alias.set(normClass(e.cls), normClass(e.into));
  return (c: string) => {
    let cur = normClass(c);
    for (let i = 0; i < 20 && alias.has(cur); i += 1) cur = alias.get(cur)!;
    return cur;
  };
}

/**
 * Everything about a plan, computed from the recorded reviews and events in ledger-clock
 * order. Stops arise when a round completes (only the latest complete round's stops can stand,
 * because a standing stop refuses the next round) and are cleared by the events after it.
 */
export function computePlanState(ledger: Ledger): PlanState {
  const resolve = classResolver(ledger.events);
  const code = isCodeLedger(ledger);
  const lensesOf = (r: LedgerRound): string[] => roundLenses(ledger, r);
  const rounds = [...ledger.rounds].sort((a, b) => a.n - b.n);
  const events = [...ledger.events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  type Item = { seq: number; event?: LedgerEvent; complete?: LedgerRound };
  const items: Item[] = events.map((e) => ({ seq: e.seq ?? 0, event: e }));
  for (const r of rounds) {
    const s = roundCompleteSeq(ledger, r);
    if (s !== null) items.push({ seq: s + 0.5, complete: r });
  }
  items.sort((a, b) => a.seq - b.seq);

  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  const accepted = new Set<string>();
  const movedSeq = new Map<string, number>();
  const cut = new Set<string>();
  let unlimited = false;
  let extra = 0;
  let standing: PlanStop[] = [];
  let prevOpen: number | null = null;
  let churnRun = 0;
  let latestComplete = 0;
  let latestCompleteSeq = -1;
  let latestOpen: OpenFinding[] = [];
  let abandoned = false;

  const openOf = (r: LedgerRound): OpenFinding[] => {
    const out = new Map<string, OpenFinding>();
    for (const lens of lensesOf(r)) {
      for (const f of r.lenses[lens]?.findings ?? []) {
        if (f.level === 'Major' && accepted.has(f.id)) continue;
        if (cut.has(f.id)) continue;
        const prev = out.get(f.id);
        // One id twice (an old ledger, a hand edit): never let a Major hide a Critical.
        if (!prev || (prev.level === 'Major' && f.level === 'Critical')) out.set(f.id, { ...f, cls: resolve(f.cls), lens, round: r.n });
      }
    }
    return [...out.values()];
  };

  for (const it of items) {
    if (it.event) {
      const e = it.event;
      if (e.kind === 'accept' && e.finding) accepted.add(e.finding);
      if (e.kind === 'redesign') standing = standing.filter((s) => !(s.kind === 'redesign' && s.cls === resolve(e.cls ?? '')));
      if (e.kind === 'split') for (const id of e.moved ?? []) movedSeq.set(id, it.seq);
      if (CLEARING_DECISIONS.includes(e.kind)) {
        // ONE decision clears every stop standing now, except a redesign (only its Changes
        // line clears it, or a split that moves its class away).
        const hadBudget = standing.some((s) => s.kind === 'budget');
        const splitClasses = new Set((e.classes ?? []).map(resolve));
        standing = standing.filter((s) => s.kind === 'redesign' && !(e.kind === 'split' && splitClasses.has(s.cls ?? '')));
        if (e.kind === 'continue') unlimited = true;
        if ((e.kind === 'narrow' || e.kind === 'split') && hadBudget) extra += 2;
        if (e.kind === 'abandon') abandoned = true;
        churnRun = 0;
      }
      continue;
    }
    const r = it.complete!;
    // A moved id closed `cut` by its owning lens in a round opened after the split leaves for good.
    for (const lens of lensesOf(r)) {
      for (const c of r.lenses[lens]?.closed ?? []) {
        const ms = movedSeq.get(c.id);
        if (ms !== undefined && (r.openSeq ?? 0) > ms && /^cut\b/i.test(c.why) && ownerOf(c.id) === lens) cut.add(c.id);
      }
    }
    const open = openOf(r);
    const classes = [...new Set(open.map((f) => f.cls))];
    const newClass = classes.some((c) => !seen.has(c));
    for (const c of classes) { counts[c] = (counts[c] ?? 0) + 1; seen.add(c); }
    standing = [];
    for (const c of classes) {
      if (counts[c] === 2) standing.push({ kind: 'redesign', cls: c });
      else if (counts[c] >= 3) standing.push({ kind: 'class', cls: c });
    }
    // Code mode counts rounds and never limits them (owner, 2026-11-08): the class stop is its brake.
    const limit = ledger.budget.base + extra;
    if (!code && open.length > 0 && !unlimited && r.n >= limit) standing.push({ kind: 'budget' });
    if (unlimited && !code) {
      churnRun = prevOpen !== null && open.length >= prevOpen && newClass ? churnRun + 1 : 0;
      if (churnRun >= 3) standing.push({ kind: 'churn' });
    }
    prevOpen = open.length;
    latestComplete = r.n;
    latestCompleteSeq = it.seq;
    latestOpen = open;
  }

  const latest = rounds[rounds.length - 1];
  const round = latest?.n ?? 0;
  const roundComplete = !!latest && roundCompleteSeq(ledger, latest) !== null;
  const afterLatest = events.filter((e) => (e.seq ?? 0) > latestCompleteSeq);
  // An addition made after the latest round OPENED was never reviewed (that round read the old
  // snapshot), so it reopens the plan even when it landed before the round completed.
  const latestOpenSeq = latest?.openSeq ?? 0;
  const reopened = afterLatest.some((e) => e.kind === 'split')
    || events.some((e) => e.kind === 'add' && (e.seq ?? 0) > latestOpenSeq);
  // The open set: the latest complete round's, minus everything accepted since.
  const open = latestOpen.filter((f) => !(f.level === 'Major' && accepted.has(f.id)));
  const done = !abandoned && roundComplete && latestComplete === round && open.length === 0 && !reopened;
  if (done) standing = [];

  const splitEvents = afterLatest.filter((e) => e.kind === 'split');
  const splitPending = splitEvents.length > 0
    ? { classes: [...new Set(splitEvents.flatMap((e) => (e.classes ?? []).map(resolve)))], moved: splitEvents.flatMap((e) => e.moved ?? []) }
    : null;

  const verdicts: Record<string, LensVerdict> = {};
  const latestLenses = latest ? lensesOf(latest) : [...ledger.lenses];
  for (const lens of latestLenses) verdicts[lens] = latest?.lenses[lens]?.verdict ?? 'PENDING';
  const pendingCriticals = latest && !roundComplete
    ? latestLenses.flatMap((l) => (latest.lenses[l]?.findings ?? []).filter((f) => f.level === 'Critical').map((f) => f.id))
    : [];

  let next: NextAction;
  if (abandoned) next = { kind: 'abandoned' };
  else if (!latest) next = { kind: 'review', lenses: [...ledger.lenses], redispatch: [] };
  else if (!roundComplete) {
    const lenses = latestLenses.filter((l) => !COMPLETE.includes(latest.lenses[l]?.verdict ?? 'PENDING'));
    next = { kind: 'review', lenses, redispatch: lenses.filter((l) => ['UNPARSED', 'ABANDONED'].includes(latest.lenses[l]?.verdict ?? '')) };
  } else if (done) next = { kind: 'done' };
  else if (standing.some((s) => s.kind !== 'redesign')) next = { kind: 'stop', stops: standing };
  else if (standing.length > 0) next = { kind: 'redesign', classes: standing.map((s) => s.cls!) };
  else next = { kind: 'revise' };

  return {
    plan: ledger.plan,
    task: ledger.task,
    abandoned,
    round,
    roundComplete,
    latestComplete,
    verdicts,
    open,
    accepted: [...accepted],
    moved: [...movedSeq.keys()].filter((id) => !cut.has(id)),
    cut: [...cut],
    classCounts: counts,
    knownClasses: [...seen].map(resolve).filter((c, i, a) => a.indexOf(c) === i),
    budget: { base: ledger.budget.base, extra, unlimited, limit: unlimited ? null : ledger.budget.base + extra },
    stops: standing,
    done,
    splitPending,
    pendingCriticals,
    next,
  };
}

/** May the pragmatist join round `n`? Round 1, and the first round opened after an `add`. */
export function pragmatistAllowed(ledger: Ledger, n: number): boolean {
  if (n === 1) return true;
  const rounds = [...ledger.rounds].sort((a, b) => a.n - b.n);
  const cur = rounds.find((r) => r.n === n);
  const prev = rounds.find((r) => r.n === n - 1);
  if (!cur || !prev) return false;
  return ledger.events.some((e) => e.kind === 'add' && (e.seq ?? 0) > (prev.openSeq ?? 0) && (e.seq ?? 0) < (cur.openSeq ?? Infinity));
}

/** Lines `<prefix>: <class> | …` in the plan's `## Changes in this revision` section. */
export function changesLines(planText: string, prefix: 'redesign' | 'split'): string[] {
  const changes = planSection(planText, 'Changes in this revision') ?? '';
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?${prefix}:\\s*(.+?)\\s*\\|`, 'i');
  return changes.split('\n').map((l) => re.exec(l)?.[1]).filter((x): x is string => !!x).map((s) => s.trim());
}

/**
 * Lines `<prefix>: <a> | <b> | …` anywhere in a code loop's fix note, split on `|` and trimmed.
 * A line whose parts after the prefix are not all filled in does not count.
 */
export function noteLines(text: string, prefix: 'sweep' | 'redesign' | 'split', parts: number): string[][] {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?${prefix}:\\s*(.+)$`, 'i');
  return text.replace(/\r\n/g, '\n').split('\n')
    .map((l) => re.exec(l)?.[1])
    .filter((x): x is string => !!x)
    .map((rest) => rest.split('|').map((p) => p.trim()))
    .filter((p) => p.length >= parts && p.slice(0, parts).every((x) => x.length > 0 && !/^<.*>$/.test(x)));
}

/** The body of the plan's `## <title…>` section (prefix match), or null. */
export function planSection(planText: string, title: string): string | null {
  const lines = planText.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase().startsWith(title.toLowerCase()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^##\s+/.test(lines[i])) { end = i; break; }
  return lines.slice(start + 1, end).join('\n').trim();
}

// ─── What the lead is told ──────────────────────────────────────────────────

/**
 * The lenses the next code round waits on: the whole review in round 1, then only a lens that
 * still owns an open id or a moved id it has not closed `cut` (the fresh re-check of the
 * develop recipe: one per reviewer that raised a blocking finding).
 */
export function nextRoundLenses(ledger: Ledger, s: PlanState): string[] {
  if (ledger.rounds.length === 0) return [...ledger.lenses];
  const owners = new Set<string>([...s.open.map((f) => f.lens), ...s.moved.map((id) => ownerOf(id)).filter((x): x is string => !!x)]);
  return ledger.lenses.filter((l) => owners.has(l)).concat([...owners].filter((l) => !ledger.lenses.includes(l)));
}

/** A CLI line for this ledger: `dreamcontext plan <verb> <plan>` or `dreamcontext builder review <verb> <task> --loop <loop>`. */
export function loopCommand(ledger: Ledger, verb: string, rest = ''): string {
  const tail = rest ? ` ${rest}` : '';
  return isCodeLedger(ledger)
    ? `dreamcontext builder review ${verb} ${ledger.task}${ledger.plan === 'end' ? '' : ` --loop ${ledger.plan}`}${tail}`
    : `dreamcontext plan ${verb} ${ledger.plan}${tail}`;
}

function codeStopCard(ledger: Ledger, s: PlanState): string {
  const why = s.stops.filter((x) => x.kind === 'class').map((x) => `"${x.cls}" sınıfı ${s.classCounts[x.cls!]}. turunda hâlâ açık: düzeltmeler sınıfı kapatmıyor.`);
  const byClass = new Map<string, OpenFinding[]>();
  for (const f of s.open) byClass.set(f.cls, [...(byClass.get(f.cls) ?? []), f]);
  const passed = Object.entries(s.verdicts).filter(([, v]) => v === 'PASS').map(([l]) => l);
  const order = recommendation(s);
  const criticals = s.open.filter((f) => f.level === 'Critical');
  const lines = [
    `İnceleme durdu → ${ledger.task}${ledger.plan === 'end' ? '' : ` (${ledger.plan})`}`,
    '',
    `Neden: ${why.join(' ')}`,
    `Sağlam olan: ${passed.length > 0 ? `${passed.join(', ')} PASS; ` : ''}açık sınıf dışındaki her şey incelemeden geçti.`,
    'Açık sınıflar:',
    ...[...byClass.keys()].map((c) => `- ${c}: ${byClass.get(c)!.length} bulgu (${byClass.get(c)!.map((f) => `${f.id} ${f.level}`).join(', ')}), ${s.classCounts[c] ?? 1}. tur`),
    `Tur: ${s.latestComplete} (tavan yok; sınıf tekrarı durdurur)`,
    '',
    'Seçenekler (öneri ilk sırada):',
    ...order.map((k, i) => `${i + 1}. ${CODE_STOP_CARD[k].label}${i === 0 ? ' (önerilen)' : ''}: ${CODE_STOP_CARD[k].detail}`),
  ];
  if (criticals.length > 0) {
    lines.push('', `Kritik bulgu açık kalır (${criticals.map((f) => f.id).join(', ')}): Daralt ve Devam'da bu işte kalır, Böl'de takip görevinin işaretsiz kriteri olur; hiçbir seçenek onu düşürmez.`);
  }
  lines.push('', `Owner's pick → \`${loopCommand(ledger, 'decide', '<narrow|split|continue> --note "<his words>"')}\` (split also needs --task <follow-up> --class <c>).`);
  return lines.join('\n');
}

function codeNextAction(ledger: Ledger, s: PlanState): string {
  const n = s.next;
  switch (n.kind) {
    case 'abandoned': return 'Next: nothing. This review loop was abandoned.';
    case 'review': {
      const opening = s.round === 0 || s.roundComplete;
      const lines = n.lenses.map((l) => `- ${l}: \`${loopCommand(ledger, 'packet', `--lens ${l}`)}\`${n.redispatch.includes(l) ? ' (re-dispatch: its review did not land)' : ''}, then \`${loopCommand(ledger, 'record', `--lens ${l} --file <its review>`)}\``);
      return [`Next: review ${n.lenses.join(' + ')}${opening ? ` (opens round ${s.round + 1})` : ` (round ${s.round})`}.`, ...lines].join('\n');
    }
    case 'done': return `Next: done. Every reviewer of round ${s.latestComplete} PASS with nothing open: record review-end, then the final check.`;
    case 'stop': return `Next: STOP. Ask the owner this card (an owner card; a Super Agent never answers it):\n\n${codeStopCard(ledger, s)}`;
    case 'redesign':
    case 'revise': {
      const classes = [...new Set(s.open.map((f) => f.cls))];
      const redesign = n.kind === 'redesign' ? n.classes : [];
      const lenses = nextRoundLenses(ledger, s);
      const split = s.splitPending ? [`  split: ${s.splitPending.classes.join(', ')} | <what this run no longer carries>`] : [];
      return [
        `Next: ${n.kind === 'redesign' ? `redesign. ${redesign.length === 1 ? 'This class is' : 'These classes are'} in a 2nd counted round, so the fix moves to the one place that covers the whole class` : 'fix by class'}, then write the fix note and re-review.`,
        `Write the fix note, changes.md in the loop folder (\`${loopCommand(ledger, 'status')}\` prints the folder); round ${s.round + 1} opens only when it carries:`,
        ...classes.map((c) => `  sweep: ${c} | <every sibling path you checked> | <the one place you fixed it>`),
        ...redesign.map((c) => `  redesign: ${c} | <the one layer that now covers the whole class>`),
        ...split,
        `Then: \`${loopCommand(ledger, 'packet', `--lens ${lenses[0] ?? 'reviewer'} --tree <FIX> --paths <files the fix changed>`)}\` opens round ${s.round + 1} for ${lenses.join(' + ')}.`,
        '',
        CODE_REVISION_RECIPE,
      ].join('\n');
    }
  }
}

function budgetLine(s: PlanState): string {
  return s.budget.unlimited ? `${s.latestComplete} rounds used, unlimited (owner: Devam)` : `${s.latestComplete} / ${s.budget.limit} rounds used`;
}

function recommendation(s: PlanState): Array<keyof typeof PLAN_STOP_CARD> {
  const kinds = new Set(s.stops.map((x) => x.kind));
  if (kinds.has('class') || kinds.has('churn')) return ['narrow', 'split', 'continue'];
  const openClasses = new Set(s.open.map((f) => f.cls));
  return openClasses.size <= 1 ? ['continue', 'narrow', 'split'] : ['split', 'narrow', 'continue'];
}

/**
 * The stop card, filled from the ledger. The lead asks it as an owner card (AskUserQuestion),
 * in plain words; the owner's pick goes back through `plan decide`.
 */
export function renderStopCard(ledger: Ledger, s: PlanState): string {
  if (isCodeLedger(ledger)) return codeStopCard(ledger, s);
  const why = s.stops.filter((x) => x.kind !== 'redesign').map((x) => {
    if (x.kind === 'class') return `"${x.cls}" sınıfı ${s.classCounts[x.cls!]}. turunda hâlâ açık: düzeltmeler sınıfı kapatmıyor.`;
    if (x.kind === 'budget') return `${s.latestComplete}. tur bitti ve plan hâlâ geçmedi (bütçe ${s.budget.limit} tur).`;
    return 'Son 3 turda açık bulgu sayısı düşmedi ve her turda yeni bir sınıf çıktı.';
  });
  const byClass = new Map<string, OpenFinding[]>();
  for (const f of s.open) byClass.set(f.cls, [...(byClass.get(f.cls) ?? []), f]);
  const openCls = [...byClass.keys()];
  const solid = Object.entries(s.verdicts).filter(([, v]) => v === 'SOLID').map(([l]) => l);
  const order = recommendation(s);
  const criticals = s.open.filter((f) => f.level === 'Critical');
  const lines = [
    `Plan durdu → ${ledger.plan}`,
    '',
    `Neden: ${why.join(' ')}`,
    `Sağlam olan: ${solid.length > 0 ? `${solid.join(', ')} merceği SOLID; ` : ''}açık sınıf dışındaki her şey incelemeden geçti.`,
    'Açık sınıflar:',
    ...openCls.map((c) => `- ${c}: ${byClass.get(c)!.length} bulgu (${byClass.get(c)!.map((f) => `${f.id} ${f.level}`).join(', ')}), ${s.classCounts[c] ?? 1}. tur`),
    `Tur: ${budgetLine(s)}`,
    '',
    'Seçenekler (öneri ilk sırada):',
    ...order.map((k, i) => `${i + 1}. ${PLAN_STOP_CARD[k].label}${i === 0 ? ' (önerilen)' : ''}: ${PLAN_STOP_CARD[k].detail}`),
  ];
  if (criticals.length > 0) {
    lines.push('', `Kritik bulgu açık kalır (${criticals.map((f) => f.id).join(', ')}): Daralt ve Devam'da bu planda kalır, Böl'de takip görevinin işaretsiz kriteri olur; hiçbir seçenek onu düşürmez.`);
  }
  lines.push('', `Owner's pick → \`dreamcontext plan decide ${ledger.plan} <narrow|split|continue> --note "<his words>"\` (split also needs --task <follow-up> --class <c>).`);
  return lines.join('\n');
}

/** The one next action, as the lead reads it in `plan status`. */
export function renderNextAction(ledger: Ledger, s: PlanState): string {
  if (isCodeLedger(ledger)) return codeNextAction(ledger, s);
  const n = s.next;
  switch (n.kind) {
    case 'abandoned': return 'Next: nothing. This plan was abandoned; `plan open --task` starts a new one.';
    case 'review': {
      const lines = n.lenses.map((l) => `- ${l}: \`dreamcontext plan packet ${ledger.plan} --lens ${l}\`${n.redispatch.includes(l) ? ' (re-dispatch: its review did not land)' : ''}, then \`plan record ${ledger.plan} --lens ${l} --file <its review>\``);
      return [`Next: review ${n.lenses.join(' + ')}${s.round === 0 ? ' (opens round 1)' : ` (round ${s.round})`}.`, ...lines].join('\n');
    }
    case 'done': return `Next: done. Both lenses SOLID with nothing open. Write it into the task: \`dreamcontext plan link ${ledger.plan}\`.`;
    case 'stop': return `Next: STOP. Ask the owner this card (an owner card; a Super Agent never answers it):\n\n${renderStopCard(ledger, s)}`;
    case 'redesign': {
      const req = n.classes.map((c) => `redesign: ${c} | <the new layer that covers the whole class>`);
      return [`Next: redesign. ${n.classes.length === 1 ? 'This class is' : 'These classes are'} in a 2nd counted round, so the fix moves to the layer covering the whole class. The next round opens only when \`## Changes in this revision\` carries:`, ...req.map((r) => `  ${r}`), '', PLAN_REVISION_RECIPE].join('\n');
    }
    default: {
      const split = s.splitPending ? `\nAfter the split, \`## Changes in this revision\` must carry \`split: ${s.splitPending.classes.join(', ')} | <what was cut>\`; each moved id (${s.splitPending.moved.join(', ')}) is owed to its lens.` : '';
      return `Next: revise, then \`plan packet\` opens round ${s.round + 1}.${split}\n\n${PLAN_REVISION_RECIPE}`;
    }
  }
}

// ─── The gate on every door into Develop ────────────────────────────────────

export type LedgerReadResult =
  | { ok: true; ledger: Ledger; dir: string }
  | { ok: false; path: string; problem: string };

/**
 * The plan's half of "may this task go to Develop?". Asked by `plan link`, `tasks ready` and
 * the Develop button's readiness route; each appends these to `developHandoffGaps`'s, which
 * stays pure over task text. A task no ledger names gets nothing new. A ledger this machine
 * cannot read refuses every task here: it cannot say which task it names.
 */
export function planGateGaps(ledgers: readonly LedgerReadResult[], taskSlug: string): HandoffGap[] {
  const gaps: HandoffGap[] = [];
  for (const r of ledgers) {
    if (!r.ok) {
      gaps.push({ field: 'plan', problem: `unreadable plan ledger ${r.path} (${r.problem}): repair it, or move that plan folder out of tmp/plans/` });
      continue;
    }
    if (r.ledger.task !== taskSlug || isCodeLedger(r.ledger)) continue; // a code review loop is no plan
    let s: PlanState;
    try {
      s = computePlanState(r.ledger);
    } catch (err) {
      gaps.push({ field: 'plan', problem: `unreadable plan ledger ${r.dir}/ledger.json (${err instanceof Error ? err.message : String(err)}): repair it, or move that plan folder out of tmp/plans/` });
      continue;
    }
    if (s.abandoned) continue;
    const status = `dreamcontext plan status ${r.ledger.plan}`;
    const crit = s.open.filter((f) => f.level === 'Critical').map((f) => f.id).concat(s.pendingCriticals);
    const majors = s.open.filter((f) => f.level === 'Major').map((f) => f.id);
    if (crit.length > 0) gaps.push({ field: 'plan', problem: `open Critical finding${crit.length > 1 ? 's' : ''} ${[...new Set(crit)].join(', ')} on plan ${r.ledger.plan}: see \`${status}\`` });
    if (majors.length > 0) gaps.push({ field: 'plan', problem: `open Major finding${majors.length > 1 ? 's' : ''} ${majors.join(', ')} on plan ${r.ledger.plan} (not accepted by the owner): see \`${status}\`` });
    if (!s.done) gaps.push({ field: 'plan', problem: `plan ${r.ledger.plan} is not done (round ${s.round}, ${s.next.kind}): see \`${status}\`` });
  }
  return gaps;
}
