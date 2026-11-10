/**
 * What a routine is waiting on the OWNER for, derived from the facts on disk (plan K7).
 *
 * A routine stops on him in several ways that today reach no surface he always sees: a run asked
 * a question, a changed manifest waits for approval, a run is refused because it was never
 * approved, an orphaned child blocks every fire, a light (read-only) run ended "ok" while the
 * mode refused what it needed, a post holds a card only he can act on. Each is already a fact on
 * disk; this module only READS them, so nothing has to remember to report one.
 *
 * Every need names a `fact`: a stable id of the fact on disk. The same fact read twice gives the
 * same id (a refusal folded onto one history row tick after tick is ONE fact), so the queue side
 * (`syncRoutineNeeds`, W5) can ring once per fact and close the item when the fact leaves the disk.
 *
 * NOT needs, on purpose: a failed or timed-out run (the runner already announces it), a bypass
 * run's denials (those are the hook's own guidance), "runs on <machine>", "read-only here",
 * a Super automation refused off its schedule, a deferred fire.
 *
 * `routineNeeds` is pure; `readRoutineFacts` is the one disk reader and never throws.
 */
import { homedir } from 'node:os';
import { allPendingQuestions } from './hitl.js';
import { manifestHash } from './registry.js';
import { listAutomations, readAutomationCache } from './store.js';
import { readThread } from './threads.js';
import { ownerCardsIn } from '../super/owner-wait.js';
// Type only: the runner is a heavy module and the queue side reads this on every sweep.
import type { DeniedCall } from './runner.js';
import type { AutomationQuestion, RunStatus } from './types.js';

export type RoutineNeedKind =
  | 'question' | 'awaiting-approval' | 'awaiting-review' | 'not-approved' | 'change-pending' | 'orphaned' | 'denials' | 'owner-card';

export interface RoutineNeed {
  slug: string;
  /** The AI Team member the routine runs as; absent when it has none (a Super automation). */
  member?: string;
  /** The routine's own title. */
  title: string;
  /** Stable id of the fact on disk. */
  fact: string;
  kind: RoutineNeedKind;
  /** One plain line for the owner (the routine's own words where it has some: untrusted). */
  text: string;
}

/** One history row as far as a need reads it. `light` and `deniedCalls` are written by the
 *  runner's record of a light run (W5); a row from before that has neither and is never a
 *  `denials` fact, which is the safe direction (a bypass run's denials are never one either). */
export interface RoutineRunRow {
  status: RunStatus;
  firedAt: string;
  startedAt: string;
  error: string | null;
  permissionDenials: number;
  light?: true;
  deniedCalls?: DeniedCall[];
}

/** The newest run post of a routine and whether the owner wrote after it. */
export interface RoutinePost { id: string; text: string; answered: boolean }

export interface RoutineFactsOf {
  slug: string;
  title: string;
  member?: string;
  /** The manifest's current hash (the change on disk): what a not-approved or change-pending
   *  fact is keyed by, so a refusal repeated every tick stays one fact and a new change is a new
   *  one. Null when it cannot be computed. */
  hash: string | null;
  /** History row 0. */
  newest: RoutineRunRow | null;
  /** The newest row of a light run, wherever it sits in the history. */
  newestLight: RoutineRunRow | null;
  post: RoutinePost | null;
}

export type RoutineQuestion = Pick<AutomationQuestion, 'id' | 'slug' | 'kind' | 'question'>;

export interface RoutineFacts {
  routines: RoutineFactsOf[];
  /** Pending questions only (`allPendingQuestions`). */
  questions: RoutineQuestion[];
}

const TEXT_MAX = 300;
/** The runner's own caps (runner.ts MAX_DENIED_CALLS, DENIED_INPUT_CAP), applied again on read:
 *  the cache file is brain-synced, so a row may come from anywhere. */
const MAX_DENIED_CALLS = 10;
const DENIED_INPUT_CAP = 2000;

/** One line: control characters out, whitespace folded, capped. */
function oneLine(raw: string, max = TEXT_MAX): string {
  const flat = String(raw).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}\u2026` : flat;
}

/**
 * Which `blocked` row is his: the runner writes these from fixed sentences (runner.ts, step 2),
 * so the sentence is the tell. `not approved (` = never approved (or no prior approval to ask
 * from); `waits for your approval` = a change waits for his card. Every other blocked sentence
 * (another machine, someone else's agent, a Super automation called off schedule, a tool that
 * cannot run the task) is not something he settles by answering, so it is no need.
 */
export function blockedKind(error: string | null): 'not-approved' | 'change-pending' | null {
  if (!error) return null;
  if (error.startsWith('not approved (')) return 'not-approved';
  if (error.includes('waits for your approval')) return 'change-pending';
  return null;
}

const KIND_ORDER: readonly RoutineNeedKind[] = ['awaiting-approval', 'not-approved', 'change-pending', 'question', 'awaiting-review', 'orphaned', 'denials', 'owner-card'];

/** PURE. One need per fact, sorted by slug and then by kind. */
export function routineNeeds(facts: RoutineFacts): RoutineNeed[] {
  const out: RoutineNeed[] = [];
  const seen = new Set<string>();
  const bySlug = new Map(facts.routines.map((r) => [r.slug, r]));
  const push = (r: Pick<RoutineFactsOf, 'slug' | 'title' | 'member'>, kind: RoutineNeedKind, fact: string, text: string) => {
    const key = `${r.slug}\n${fact}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ slug: r.slug, ...(r.member ? { member: r.member } : {}), title: r.title, fact, kind, text: oneLine(text) });
  };

  for (const q of facts.questions) {
    // A question whose routine is gone from the list still waits on him: named by its slug.
    const r = bySlug.get(q.slug) ?? { slug: q.slug, title: q.slug };
    // The runner's awaiting rows are the question seen from the schedule's side: one fact, the
    // question, so the row and the question never ring twice.
    const kind: RoutineNeedKind = q.kind === 'approval' ? 'awaiting-approval'
      : bySlug.get(q.slug)?.newest?.status === 'awaiting-review' ? 'awaiting-review' : 'question';
    push(r, kind, `q:${q.id}`, q.question.split(/\n\s*\n/)[0] ?? q.question);
  }

  for (const r of facts.routines) {
    const row = r.newest;
    if (row?.status === 'blocked') {
      const kind = blockedKind(row.error);
      if (kind) push(r, kind, `${kind}:${r.hash ?? row.firedAt}`, row.error ?? '');
    } else if (row?.status === 'orphaned') {
      // Coalesced onto one row while the owed fire stays the same: the fire is the fact.
      push(r, 'orphaned', `orphaned:${row.firedAt}`, row.error ?? 'a previous run is still running with no runner');
    }
    // An awaiting row with no pending question left was answered: nothing waits on him.

    const light = r.newestLight;
    const denied = light?.deniedCalls ?? [];
    if (light && light.light === true && light.status === 'ok' && denied.length > 0) {
      const shown = denied.slice(0, 3).map((d) => `${d.tool}: ${d.input}`).join('; ');
      const n = Math.max(denied.length, light.permissionDenials);
      push(r, 'denials', `denials:${light.startedAt}`, `${n} call${n === 1 ? ' was' : 's were'} refused: ${shown}`);
    }

    if (r.post && !r.post.answered) {
      const cards = ownerCardsIn(r.post.text);
      if (cards.length) push(r, 'owner-card', `card:${r.post.id}`, cards.map((c) => c.line).join('; '));
    }
  }

  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)));
}

// ─── Disk ─────────────────────────────────────────────────────────────────────

const STATUSES: readonly string[] = ['ok', 'failed', 'timeout', 'blocked', 'deferred', 'orphaned', 'awaiting-review', 'awaiting-approval'];

/** A history row re-read field by field: a hand-edited or older row degrades to fewer facts. */
function readRow(raw: unknown): RoutineRunRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== 'string' || !STATUSES.includes(r.status)) return null;
  if (typeof r.firedAt !== 'string' || typeof r.startedAt !== 'string') return null;
  const denied = Array.isArray(r.deniedCalls)
    ? r.deniedCalls
      .filter((d): d is DeniedCall => !!d && typeof d === 'object' && typeof (d as DeniedCall).tool === 'string' && typeof (d as DeniedCall).input === 'string')
      .slice(0, MAX_DENIED_CALLS)
      .map((d) => ({ tool: d.tool.slice(0, 200), input: d.input.slice(0, DENIED_INPUT_CAP) }))
    : [];
  return {
    status: r.status as RunStatus,
    firedAt: r.firedAt,
    startedAt: r.startedAt,
    error: typeof r.error === 'string' ? r.error : null,
    permissionDenials: typeof r.permissionDenials === 'number' && Number.isFinite(r.permissionDenials) ? r.permissionDenials : 0,
    ...(r.light === true ? { light: true as const } : {}),
    ...(denied.length ? { deniedCalls: denied } : {}),
  };
}

/** Days of thread a post read opens: the newest post is in the newest files. */
const POST_DAYS = 2;

/** The newest agent post, and whether the owner wrote after it (an app's words are never his). */
function newestPost(contextRoot: string, slug: string): RoutinePost | null {
  const entries = readThread(contextRoot, slug, { days: POST_DAYS });
  let at = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].kind === 'agent') { at = i; break; }
  if (at < 0) return null;
  const post = entries[at];
  const answered = entries.slice(at + 1).some((e) => e.kind === 'user' && !e.app);
  return { id: post.id, text: post.text, answered };
}

/** Everything {@link routineNeeds} reads, from disk. NEVER THROWS: a broken file is no fact. */
export function readRoutineFacts(contextRoot: string, opts: { home?: string } = {}): RoutineFacts {
  const home = opts.home ?? homedir();
  let questions: RoutineQuestion[] = [];
  try {
    questions = allPendingQuestions(contextRoot).map((q) => ({ id: q.id, slug: q.slug, kind: q.kind, question: q.question }));
  } catch { questions = []; }
  let manifests: ReturnType<typeof listAutomations> = [];
  try { manifests = listAutomations(contextRoot, home); } catch { manifests = []; }
  const routines: RoutineFactsOf[] = [];
  for (const m of manifests) {
    try {
      let hash: string | null = null;
      try { hash = manifestHash(m); } catch { hash = null; }
      let history: unknown[] = [];
      try {
        const cache = readAutomationCache(contextRoot, m.slug);
        history = Array.isArray(cache?.history) ? cache.history : [];
      } catch { history = []; }
      const newest = readRow(history[0]);
      let newestLight: RoutineRunRow | null = null;
      for (const raw of history) {
        const row = readRow(raw);
        if (row?.light) { newestLight = row; break; }
      }
      let post: RoutinePost | null = null;
      try { post = newestPost(contextRoot, m.slug); } catch { post = null; }
      routines.push({
        slug: m.slug,
        title: m.title || m.slug,
        // A Super automation is the Super's own turn, never a member's (agents/store.ts getAgent).
        ...(m.target !== 'super' && m.agent ? { member: m.agent } : {}),
        hash, newest, newestLight, post,
      });
    } catch {
      // one routine's broken record costs only that routine
    }
  }
  return { routines, questions };
}
