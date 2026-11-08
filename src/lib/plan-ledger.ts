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
import { PLAN_REVISION_RECIPE, PLAN_STOP_CARD } from './plan-review-rules.js';

// ─── Shape ───────────────────────────────────────────────────────────────────

export const PLAN_LEDGER_VERSION = 1;
export const PLAN_BUDGET_BASE = 8;
export const PLAN_NAME_RE = /^[a-z0-9-]{1,80}$/;
export const FIXED_SECOND_LENSES = ['security', 'edge-cases'] as const;
export const PLAN_LENSES = ['critic', 'security', 'edge-cases', 'pragmatist'] as const;
export type PlanLens = typeof PLAN_LENSES[number];

export type LensVerdict = 'PENDING' | 'SOLID' | 'NEEDS_WORK' | 'PROPOSALS' | 'UNPARSED' | 'ABANDONED';
export type FindingLevel = 'Critical' | 'Major';
export const FINDING_KINDS = ['premise', 'contract', 'security', 'criteria', 'map'] as const;

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
}

export interface LedgerRound {
  n: number;
  openedAt: string;
  snapshotSha: string;
  openSeq?: number;
  lenses: Record<string, LensRecord>;
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
  [extra: string]: unknown;
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
  if (!Array.isArray(l.lenses) || l.lenses.length !== 2) return 'lenses must be the fixed pair';
  if (!l.budget || typeof l.budget.base !== 'number' || typeof l.budget.extra !== 'number') return 'missing budget';
  if (!Array.isArray(l.events) || !Array.isArray(l.rounds)) return 'missing events or rounds';
  for (const r of l.rounds) {
    if (!r || typeof r.n !== 'number' || !r.lenses || typeof r.lenses !== 'object') return 'a round is malformed';
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
}

export interface ParsedReview {
  verdict: LensVerdict;
  findings: LedgerFinding[];
  closed: Array<{ id: string; why: string }>;
  proposals: string[];
  /** Why the review is UNPARSED, with the lines the CLI expected. Empty = accepted. */
  errors: string[];
}

const FINDING_START_RE = /^\s*\d+\.\s*\[/;
const FINDING_RE = /^\s*(\d+)\.\s*\[(Critical|Major)\]\s*id:\s*([^|]+?)\s*\|\s*class:\s*([^|]+?)\s*\|\s*kind:\s*([^|]+?)\s*(?:\|\s*(.*))?$/i;
const CLOSED_RE = /^\s*closed:\s*([^|]+?)\s*\|\s*(.+?)\s*$/i;
const PROPOSAL_RE = /^\s*-\s*(cut|defer|premise):\s*(.+)$/i;
const SECTION_END_RE = /^\s*(?:#+\s*)?(?:build notes|non-blocking)\b/i;

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
  const pragmatist = ctx.lens === 'pragmatist';
  const allowed = pragmatist ? ['PROPOSALS', 'SOLID'] : ['SOLID', 'NEEDS_WORK'];
  let verdict: LensVerdict = allowed.includes(head) ? (head as LensVerdict) : 'UNPARSED';
  if (verdict === 'UNPARSED') errors.push(`first line must be exactly ${allowed.map((v) => `\`${v}\``).join(' or ')}`);

  const findings: LedgerFinding[] = [];
  const closed: Array<{ id: string; why: string }> = [];
  const proposals: string[] = [];
  const restated = new Set<string>();
  let blockingLines = 0;
  let inBlocking = true;
  let current: LedgerFinding | null = null;

  for (const raw of lines.slice(lines.indexOf(first) + 1)) {
    const line = raw.replace(/\*\*/g, '');
    if (SECTION_END_RE.test(line)) { inBlocking = false; current = null; continue; }
    const c = CLOSED_RE.exec(line);
    if (c) { closed.push({ id: c[1].trim(), why: c[2].trim() }); current = null; continue; }
    const p = PROPOSAL_RE.exec(line);
    if (p && pragmatist) { proposals.push(`${p[1].toLowerCase()}: ${p[2].trim()}`); continue; }
    if (!inBlocking) continue;
    if (FINDING_START_RE.test(line)) {
      blockingLines += 1;
      current = null;
      const m = FINDING_RE.exec(line);
      if (!m) { errors.push(`unreadable finding line: "${raw.trim().slice(0, 120)}"`); continue; }
      const [, k, lvl, rawId, cls, kind, rest] = m;
      const level = (lvl[0].toUpperCase() + lvl.slice(1).toLowerCase()) as FindingLevel;
      const id = rawId.trim();
      const kindN = kind.trim().toLowerCase();
      if (!(FINDING_KINDS as readonly string[]).includes(kindN)) {
        errors.push(`finding ${k}: kind must be one of ${FINDING_KINDS.join('|')}, got "${kind.trim()}"`);
        continue;
      }
      const fresh = { id: `r${ctx.round}-${ctx.lens}-${k}`, level, cls: normClass(cls), kind: kindN, text: (rest ?? '').trim() };
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
  if (!pragmatist) {
    const closedOwn = new Set(closed.map((c) => c.id).filter((id) => ctx.ownOpen.has(id)));
    const missing = [...ctx.ownOpen.keys()].filter((id) => !restated.has(id) && !closedOwn.has(id));
    if (missing.length > 0) {
      errors.push(`own open ids neither re-stated nor closed: ${missing.join(', ')}. Expected for each: \`closed: <id> | <why>\` or the finding re-stated with \`id: <id>\``);
    }
  }
  if (errors.length > 0) verdict = 'UNPARSED';
  return { verdict, findings, closed: closed.filter((c) => ctx.ownOpen.has(c.id)), proposals, errors };
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

const COMPLETE: readonly LensVerdict[] = ['SOLID', 'NEEDS_WORK'];
const CLEARING_DECISIONS: readonly LedgerEventKind[] = ['continue', 'narrow', 'split', 'abandon'];

/** The lens that owns an id (`r3-edge-cases-1` → `edge-cases`); null for a malformed id. */
export function ownerOf(id: string): string | null {
  return /^r\d+-(.+)-\d+$/.exec(id)?.[1] ?? null;
}

/** When a round completed on the ledger clock: every fixed lens holds SOLID or NEEDS_WORK. */
export function roundCompleteSeq(ledger: Ledger, round: LedgerRound): number | null {
  let max = round.openSeq ?? 0;
  for (const lens of ledger.lenses) {
    const rec = round.lenses[lens];
    if (!rec || !COMPLETE.includes(rec.verdict)) return null;
    max = Math.max(max, rec.seq ?? 0);
  }
  return max;
}

/** Class aliases from `merge-class`, applied everywhere: a merge only ever grows a count. */
function classResolver(events: LedgerEvent[]): (c: string) => string {
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
  const fixed = ledger.lenses;
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
    for (const lens of fixed) {
      for (const f of r.lenses[lens]?.findings ?? []) {
        if (f.level === 'Major' && accepted.has(f.id)) continue;
        if (cut.has(f.id)) continue;
        if (!out.has(f.id)) out.set(f.id, { ...f, cls: resolve(f.cls), lens, round: r.n });
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
    for (const lens of fixed) {
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
    const limit = ledger.budget.base + extra;
    if (open.length > 0 && !unlimited && r.n >= limit) standing.push({ kind: 'budget' });
    if (unlimited) {
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
  const reopened = afterLatest.some((e) => e.kind === 'add' || e.kind === 'split');
  // The open set: the latest complete round's, minus everything accepted since.
  const open = latestOpen.filter((f) => !(f.level === 'Major' && accepted.has(f.id)));
  const done = !abandoned && roundComplete && latestComplete === round && open.length === 0 && !reopened;
  if (done) standing = [];

  const splitEvents = afterLatest.filter((e) => e.kind === 'split');
  const splitPending = splitEvents.length > 0
    ? { classes: [...new Set(splitEvents.flatMap((e) => (e.classes ?? []).map(resolve)))], moved: splitEvents.flatMap((e) => e.moved ?? []) }
    : null;

  const verdicts: Record<string, LensVerdict> = {};
  for (const lens of fixed) verdicts[lens] = latest?.lenses[lens]?.verdict ?? 'PENDING';
  const pendingCriticals = latest && !roundComplete
    ? fixed.flatMap((l) => (latest.lenses[l]?.findings ?? []).filter((f) => f.level === 'Critical').map((f) => f.id))
    : [];

  let next: NextAction;
  if (abandoned) next = { kind: 'abandoned' };
  else if (!latest) next = { kind: 'review', lenses: [...fixed], redispatch: [] };
  else if (!roundComplete) {
    const lenses = fixed.filter((l) => !COMPLETE.includes(latest.lenses[l]?.verdict ?? 'PENDING'));
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
    if (r.ledger.task !== taskSlug) continue;
    const s = computePlanState(r.ledger);
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
