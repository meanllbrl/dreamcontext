import { basename, dirname, join } from 'node:path';
import { vaultNameForContextRoot } from '../app-link.js';
import { readThreadRun } from '../automations/threads.js';
import { listInsights, readCache } from '../lab/store.js';
import { bindingSeriesOf } from '../lab/sync.js';
import type { SeriesPoint } from '../lab/types.js';
import { conversationKeysFromEnv, findQuoteTurn, OWNER_WORDS_MAX_AGE_DAYS, readOwnerTurns } from '../owner-words.js';
import { listAgentHistory, type HistorySession, type ListHistoryOptions } from './history.js';
import { amendmentRisks } from './amendments.js';
import {
  NO_WRITE, SCORECARD_LIMITS, ScorecardRefused, TERMINAL_RUN_STATUSES, activeCriteria, foldNote, isLiveRunning, isRunKey,
  newId, projectKeyOfRun, readScorecard, runKeyFor, sessionKeyOf, splitSessionKey, withScorecard,
  type Check, type Goal, type Lesson, type MemberCard, type ProjectRef, type RatedBy, type Rating, type ScorecardScope,
} from './scorecard.js';
import { projectKey } from '../local-store.js';

/**
 * What the owner (and the Super, with his words) does to a member's scorecard (plan uye-karnesi
 * C4, C5): rate a run, set his "what good looks like" lines, flip a check's verdict, undo or adopt
 * a lesson, link a goal. Each is one locked write (`withScorecard`); the model work it starts (a
 * lesson draft, a check) is the caller's to spawn, from what these return.
 */

const contextRootOf = (projectRoot: string): string => join(projectRoot, '_dream_context');

// ─── Runs ──────────────────────────────────────────────────────────────────────

/** A system line task delivery writes (`fanOutDelivered`): a run id with no `started` and nothing but system entries. */
export function isDeliveryNote(contextRoot: string, s: Pick<HistorySession, 'source' | 'key'>): boolean {
  const parts = splitSessionKey(s.key);
  if (!parts) return true;
  let entries;
  try { entries = readThreadRun(contextRoot, s.source, parts.runId); } catch { return false; }
  if (entries.length === 0) return false;
  return entries.every((e) => e.kind === 'system') && !entries.some((e) => e.event === 'started');
}

export function isRateableSession(contextRoot: string, s: HistorySession): boolean {
  return s.kind === 'run' && !!s.status && TERMINAL_RUN_STATUSES.has(s.status) && !isDeliveryNote(contextRoot, s);
}

export interface RunsPage {
  /** Rateable sessions of the page, newest first. */
  runs: HistorySession[];
  nextBefore: string | null;
}

/** One page of the member's runs (`runsOnly`: no talks, no job the main Super gave it), rateable ones only. */
export function rateableRuns(projectRoot: string, member: string, opts: { before?: string | null; maxSessions?: number; home?: string; live?: Pick<ListHistoryOptions, 'isRunActive' | 'isRunHeld' | 'isLive' | 'isHeld'> } = {}): RunsPage {
  const contextRoot = contextRootOf(projectRoot);
  const page = listAgentHistory(contextRoot, member, {
    ...(opts.live ?? {}),
    audience: 'owner', runsOnly: true, before: opts.before ?? null, maxSessions: opts.maxSessions ?? 20,
    maxRows: Number.MAX_SAFE_INTEGER, home: opts.home,
  });
  return { runs: page.sessions.filter((s) => isRateableSession(contextRoot, s)), nextBefore: page.nextBefore };
}

/** The run of this member whose history key is `sessionKey`, or null (paged, newest first). */
export function findRun(projectRoot: string, member: string, sessionKey: string, home?: string): { run: HistorySession | null; rateable: boolean } {
  const contextRoot = contextRootOf(projectRoot);
  let before: string | null = null;
  for (;;) {
    const page = listAgentHistory(contextRoot, member, { audience: 'owner', runsOnly: true, before, maxSessions: 50, maxRows: Number.MAX_SAFE_INTEGER, home });
    const hit = page.sessions.find((s) => s.key === sessionKey);
    if (hit) return { run: hit, rateable: isRateableSession(contextRoot, hit) };
    if (!page.nextBefore) return { run: null, rateable: false };
    before = page.nextBefore;
  }
}

/** The newest rateable run that ended at or before `atMs` (no bound: now). */
export function lastRateableRun(projectRoot: string, member: string, atMs: number | null, home?: string): HistorySession | null {
  let before: string | null = null;
  for (;;) {
    const page = rateableRuns(projectRoot, member, { before, maxSessions: 50, home });
    const hit = page.runs.find((s) => atMs === null || Date.parse(s.lastAt) <= atMs);
    if (hit) return hit;
    if (!page.nextBefore) return null;
    before = page.nextBefore;
  }
}

export function projectRefOf(projectRoot: string, home?: string): ProjectRef {
  let vault = '';
  try { vault = vaultNameForContextRoot(contextRootOf(projectRoot), home) ?? ''; } catch { vault = ''; }
  return { key: projectKey(projectRoot), vault, name: vault || basename(projectRoot) };
}

// ─── Rate ──────────────────────────────────────────────────────────────────────

export interface RateInput {
  /** The history key `<source>::<runId>`; with `last`, resolved here. */
  run?: string;
  last?: boolean;
  /** null clears the rating. */
  stars: number | null;
  note?: string | null;
  by: RatedBy;
  /** The owner's words (an agent session must give them). */
  quote?: string;
  home?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** Turns to resolve a quote against (tests); default the owner-words ledger. */
  turns?: ReturnType<typeof readOwnerTurns>;
}

export interface RateResult {
  runKey: string;
  rating: Rating | null;
  /** A lesson draft is due for this run (the caller spawns it). */
  draft: boolean;
}

function cleanNote(note: string | null | undefined): string {
  return typeof note === 'string' ? note.replace(/\r\n/g, '\n').trim().slice(0, SCORECARD_LIMITS.noteChars) : '';
}

/** Retire the run's live lesson (active or held): a cleared rating or note, or a newer lesson. */
function retireRunLessons(card: MemberCard, runKey: string): void {
  for (const l of card.lessons) if (l.run === runKey && (l.status === 'active' || l.status === 'held')) l.status = 'replaced';
}

export function rateRun(projectRoot: string, member: string, input: RateInput): RateResult {
  const now = input.now ?? new Date();
  const stars = input.stars;
  if (stars !== null && (!Number.isInteger(stars) || stars < 1 || stars > 5)) throw new ScorecardRefused('invalid_args', 400, 'Stars are 1 to 5.');
  // An agent's rating carries his words, resolved to one of his turns (D16).
  let quoteTurn: string | undefined;
  let quoteAt: number | null = null;
  const quote = input.quote ? input.quote.replace(/\s+/g, ' ').trim().slice(0, 500) : undefined;
  if (input.by !== 'owner') {
    if (!quote) throw new ScorecardRefused('rate_needs_owner_words', 403, 'A rating from an agent needs --quote "<his exact words>".');
    const since = new Date(now.getTime() - OWNER_WORDS_MAX_AGE_DAYS * 86_400_000).toISOString();
    const turns = input.turns ?? readOwnerTurns({ home: input.home, since });
    const hit = findQuoteTurn(quote, turns.filter((t) => t.at >= since), conversationKeysFromEnv(input.env ?? process.env));
    if (!hit.turn) throw new ScorecardRefused('rate_needs_owner_words', 403, 'Those words are not one of the owner\'s messages: quote what he said.');
    quoteTurn = hit.turn.turn;
    quoteAt = Date.parse(hit.turn.at);
  }
  let sessionKey: string;
  let session: HistorySession | null;
  if (input.last) {
    // With his words, the run he meant ended before he spoke (a run that ends in between is not his).
    session = lastRateableRun(projectRoot, member, quoteAt, input.home);
    if (!session) throw new ScorecardRefused('unknown_run', 404, 'This member has no finished run to rate.');
    sessionKey = session.key;
  } else {
    sessionKey = sessionKeyOf(input.run ?? '');
    if (!isRunKey(sessionKey)) throw new ScorecardRefused('invalid_args', 400, 'Name the run (--run <source>::<runId>) or use --last.');
    const found = findRun(projectRoot, member, sessionKey, input.home);
    if (!found.run) throw new ScorecardRefused('unknown_run', 404, `No run ${sessionKey} of this member here.`);
    if (!found.rateable) throw new ScorecardRefused('run_not_rateable', 409, 'Only a finished run can be rated.');
    session = found.run;
  }
  const note = cleanNote(input.note);
  const project = projectRefOf(projectRoot, input.home);
  return withScorecard(projectRoot, member, (card, scope) => {
    const runKey = runKeyFor(scope, sessionKey);
    const prev = card.ratings[runKey];
    if (quoteTurn && card.usedQuoteTurns.includes(quoteTurn) && prev?.quoteTurn !== quoteTurn) {
      throw new ScorecardRefused('quote_used', 409, 'Those words already rated another run: one quote rates one run. Ask him for this one.');
    }
    if (quoteTurn && !card.usedQuoteTurns.includes(quoteTurn)) card.usedQuoteTurns.push(quoteTurn);
    if (stars === null) {
      delete card.ratings[runKey];
      retireRunLessons(card, runKey);
      return { runKey, rating: null, draft: false };
    }
    const fold = note ? foldNote(note) : '';
    const at = now.toISOString();
    const rating: Rating = {
      stars,
      ...(note ? { note, noteFold: fold } : {}),
      firstAt: prev?.firstAt ?? at,
      at,
      by: input.by,
      ...(quote ? { quote } : {}),
      ...(quoteTurn ? { quoteTurn } : {}),
      title: session!.title,
      runAt: session!.startedAt,
      status: session!.status ?? 'ok',
      project,
    };
    let draft = false;
    if (!note) {
      retireRunLessons(card, runKey);
    } else if (prev?.noteFold === fold && prev.draft) {
      // The same note: its draft (done, running or failed) carries over.
      rating.draft = prev.draft;
    } else {
      // A new note: the old lesson stays until the new one commits (D5). An undone lesson of the
      // same words is never drafted again.
      const undone = card.lessons.some((l) => l.run === runKey && l.noteFold === fold && l.status === 'undone');
      if (!undone) {
        // `running` with no pid yet: "starting" for a few seconds, until the drafter marks itself.
        rating.draft = { state: 'running', attempts: 0, at, noteFold: fold };
        draft = true;
      }
    }
    card.ratings[runKey] = rating;
    return { runKey, rating, draft };
  }, { home: input.home })!;
}

// ─── Criteria, verdicts, lessons, goal ────────────────────────────────────────────

export function addCriterion(projectRoot: string, member: string, text: string, home?: string, now: Date = new Date()): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new ScorecardRefused('invalid_args', 400, 'Write the line.');
  if (clean.length > SCORECARD_LIMITS.criterionChars) throw new ScorecardRefused('invalid_args', 400, `A line is at most ${SCORECARD_LIMITS.criterionChars} characters.`);
  return withScorecard(projectRoot, member, (card) => {
    const id = newId('cr');
    card.criteria.push({ id, text: clean, at: now.toISOString() });
    return id;
  }, { home })!;
}

export function removeCriterion(projectRoot: string, member: string, id: string, home?: string, now: Date = new Date()): void {
  withScorecard(projectRoot, member, (card) => {
    const c = card.criteria.find((x) => x.id === id && !x.removedAt);
    if (!c) throw new ScorecardRefused('unknown_criterion', 404, `No line ${id}.`);
    c.removedAt = now.toISOString();
    return true;
  }, { home });
}

/** His verdict on one check line: met, not met, or unset (null). A later check never overwrites it. */
export function setVerdict(projectRoot: string, member: string, sessionKey: string, id: string, met: boolean | null, home?: string): void {
  withScorecard(projectRoot, member, (card, scope) => {
    const runKey = runKeyFor(scope, sessionKeyOf(sessionKey));
    const check = card.checks[runKey];
    if (!check) throw new ScorecardRefused('unknown_run', 404, 'That run has no check.');
    const v = check.verdicts.find((x) => x.id === id);
    if (!v) throw new ScorecardRefused('unknown_criterion', 404, `No check line ${id}.`);
    v.met = met;
    v.by = 'owner';
    delete v.why;
    return true;
  }, { home });
}

export function undoLesson(projectRoot: string, member: string, id: string, home?: string, now: Date = new Date()): Lesson {
  return withScorecard(projectRoot, member, (card) => {
    const l = card.lessons.find((x) => x.id === id);
    if (!l) throw new ScorecardRefused('unknown_lesson', 404, `No lesson ${id}.`);
    if (l.status === 'active' || l.status === 'held') {
      l.status = 'undone';
      l.undoneAt = now.toISOString();
    }
    return { ...l };
  }, { home })!;
}

export function useLesson(projectRoot: string, member: string, id: string, home?: string): Lesson {
  return withScorecard(projectRoot, member, (card) => {
    const l = card.lessons.find((x) => x.id === id);
    if (!l) throw new ScorecardRefused('unknown_lesson', 404, `No lesson ${id}.`);
    if (l.status !== 'held') throw new ScorecardRefused('invalid_args', 409, 'Only a lesson that waits can be used.');
    l.status = 'active';
    return { ...l };
  }, { home })!;
}

export interface GoalInput {
  insight: string;
  baseline?: number | null;
  target: number;
}

/** The insight's binding series and latest value in this project, or null when it is gone or not numeric. */
export function goalSeries(projectRoot: string, insight: string): { title: string; latest: number; points: SeriesPoint[]; unit: string | null } | null {
  const contextRoot = contextRootOf(projectRoot);
  let manifest;
  try { manifest = listInsights(contextRoot).find((i) => i.slug === insight); } catch { manifest = undefined; }
  if (!manifest) return null;
  let cache;
  try { cache = readCache(contextRoot, insight); } catch { cache = null; }
  if (!cache || typeof cache.latest !== 'number' || !Number.isFinite(cache.latest)) return null;
  const series = bindingSeriesOf(Array.isArray(cache.series) ? cache.series : [], (manifest as { binding?: never }).binding ?? null);
  const points = (series?.points ?? []).filter((p) => typeof p.v === 'number' && Number.isFinite(p.v));
  if (points.length === 0) return null;
  return { title: manifest.title, latest: cache.latest, points, unit: cache.unit ?? null };
}

/** The current project's insights a goal can link: a numeric latest and a dated binding series. */
export function goalCandidates(projectRoot: string): Array<{ slug: string; title: string; latest: number; unit: string | null }> {
  let all: { slug: string }[] = [];
  try { all = listInsights(contextRootOf(projectRoot)); } catch { all = []; }
  const out: Array<{ slug: string; title: string; latest: number; unit: string | null }> = [];
  for (const i of all) {
    const g = goalSeries(projectRoot, i.slug);
    if (g) out.push({ slug: i.slug, title: g.title, latest: g.latest, unit: g.unit });
  }
  return out;
}

export function setGoal(projectRoot: string, member: string, input: GoalInput, home?: string, now: Date = new Date()): Goal {
  const g = goalSeries(projectRoot, input.insight);
  if (!g) throw new ScorecardRefused('invalid_args', 400, 'That Lab card has no number to follow here.');
  const baseline = input.baseline ?? g.latest;
  const target = input.target;
  if (!Number.isFinite(baseline) || !Number.isFinite(target)) throw new ScorecardRefused('invalid_args', 400, 'The baseline and the target are numbers.');
  if (baseline === target) throw new ScorecardRefused('invalid_args', 400, 'The target must differ from the baseline.');
  const goal: Goal = { insight: input.insight, project: projectRefOf(projectRoot, home), baseline, target, linkedAt: now.toISOString() };
  withScorecard(projectRoot, member, (card) => { card.goal = goal; return true; }, { home });
  return goal;
}

export function clearGoal(projectRoot: string, member: string, home?: string): void {
  withScorecard(projectRoot, member, (card) => {
    if (!card.goal) return NO_WRITE;
    card.goal = null;
    return true;
  }, { home });
}

// ─── Model work state (marks before a spawn; the judge writes the result) ────────

/** Refuse a check or draft another live process is running (the route's pre-check). */
export function assertNotRunning(card: MemberCard, runKey: string, what: 'check' | 'draft'): void {
  const s = what === 'check' ? card.checks[runKey] : card.ratings[runKey]?.draft;
  if (s && isLiveRunning(s as { state: string; pid?: number; pidStart?: string; at: string })) {
    throw new ScorecardRefused('check_running', 409, what === 'check' ? 'A check of this run is running.' : 'This note\'s lesson is being written.');
  }
}

// ─── Trend ─────────────────────────────────────────────────────────────────────

export interface Trend {
  /** Average of the last 10 rated runs, to one decimal; null with no rating. */
  average: number | null;
  /** The same over the last 10 runs first rated at least 14 days ago; null when there are none. */
  before: number | null;
  /** The last 10 rated runs' stars, oldest first. */
  bars: number[];
  count: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function trendOf(card: MemberCard, now: Date = new Date()): Trend {
  const rated = Object.values(card.ratings).filter((r) => r && Number.isInteger(r.stars));
  const byRun = [...rated].sort((a, b) => (a.runAt < b.runAt ? 1 : a.runAt > b.runAt ? -1 : 0));
  const last = byRun.slice(0, 10);
  const avg = (rs: Rating[]): number | null => (rs.length ? round1(rs.reduce((s, r) => s + r.stars, 0) / rs.length) : null);
  const cutoff = now.getTime() - 14 * 86_400_000;
  const old = byRun.filter((r) => Date.parse(r.firstAt) <= cutoff).slice(0, 10);
  return { average: avg(last), before: avg(old), bars: last.map((r) => r.stars).reverse(), count: rated.length };
}

/** The length of the block the member reads (D8's warning line). */
export function ownerBlockChars(card: MemberCard): number {
  const crit = activeCriteria(card).reduce((s, c) => s + c.text.length + 3, 0);
  const les = card.lessons.filter((l) => l.status === 'active').reduce((s, l) => s + l.text.length + 3, 0);
  return crit + les;
}

// ─── The lesson commit (shared by the drafter) ────────────────────────────────────

/** D5 + D7 in one: the run's previous lesson replaced, the new one active or held. */
export function commitLesson(card: MemberCard, runKey: string, text: string, noteFold: string, now: Date): Lesson {
  retireRunLessons(card, runKey);
  const flags = amendmentRisks('', text);
  const lesson: Lesson = {
    id: newId('le'), text, run: runKey, noteFold, at: now.toISOString(),
    status: flags.length ? 'held' : 'active', ...(flags.length ? { flags } : {}),
  };
  card.lessons.push(lesson);
  return lesson;
}

