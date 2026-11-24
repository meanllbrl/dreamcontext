import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { vaultNameForContextRoot } from '../app-link.js';
import { readThreadRun } from '../automations/threads.js';
import { listInsights, readCache } from '../lab/store.js';
import { bindingSeriesOf } from '../lab/sync.js';
import type { SeriesPoint } from '../lab/types.js';
import { conversationKeysFromEnv, findQuoteTurn, OWNER_WORDS_MAX_AGE_DAYS, quoteCovers, readOwnerTurns, sameConversation } from '../owner-words.js';
import { rateAskAnchor } from '../automations/super-quiet.js';
import { isDeliveryNoteEntries, listAgentHistory, recentRunFacts, requestFacts, superJobSession, type HistorySession, type ListHistoryOptions } from './history.js';
import { amendmentRisks } from './amendments.js';
import {
  NO_WRITE, SCORECARD_LIMITS, ScorecardRefused, TERMINAL_RUN_STATUSES, activeCriteria, askState, foldNote, isLiveRunning, isRunKey,
  newId, projectKeyOfRun, readScorecard, resolveScorecard, runKeyFor, sessionKeyOf, splitSessionKey, withScorecard,
  type Check, type Correction, type Goal, type Lesson, type MemberCard, type ProjectRef, type RatedBy, type Rating, type ScorecardScope,
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
  return isDeliveryNoteEntries(entries);
}

/** D2 restated by W3 C9: a run whose live status is terminal, or that has a first terminal entry in
 *  its thread (`request`: a reply turn in flight, an agent review pending), never a delivery note. */
export function isRateableSession(contextRoot: string, s: HistorySession): boolean {
  const ended = (!!s.status && TERMINAL_RUN_STATUSES.has(s.status)) || !!s.request;
  return s.kind === 'run' && ended && !isDeliveryNote(contextRoot, s);
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

/** The run of this member whose history key is `sessionKey`, or null (paged, newest first). Past
 *  D2's history, a job the main Super handed it (W3 E9), read from that one run's thread. */
export function findRun(projectRoot: string, member: string, sessionKey: string, home?: string): { run: HistorySession | null; rateable: boolean; viaSuper?: true } {
  const contextRoot = contextRootOf(projectRoot);
  let before: string | null = null;
  for (;;) {
    const page = listAgentHistory(contextRoot, member, { audience: 'owner', runsOnly: true, before, maxSessions: 50, maxRows: Number.MAX_SAFE_INTEGER, home });
    const hit = page.sessions.find((s) => s.key === sessionKey);
    if (hit) return { run: hit, rateable: isRateableSession(contextRoot, hit) };
    if (!page.nextBefore) break;
    before = page.nextBefore;
  }
  const job = superJobSession(contextRoot, member, sessionKey, home);
  if (job) return { run: job, rateable: !!job.request, viaSuper: true };
  return { run: null, rateable: false };
}

/** W3 C9: how many of this member's runs ask to be rated right now ("N to rate"): every run whose
 *  run id falls in the last 4 days, judged by `askState` against the card. No count cap. */
export function openRequestCount(projectRoot: string, member: string, nowMs: number = Date.now(), home?: string): number {
  const { card, scope } = readScorecard(projectRoot, member, home);
  return recentRunFacts(contextRootOf(projectRoot), member, nowMs, 4, home)
    .filter((r) => askState(r.facts, card.ratings[runKeyFor(scope, r.key)], nowMs) === 'open').length;
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
  /** Absent (undefined or null) keeps the run's stored note; '' clears it (his own edit only); text
   *  replaces it. A re-rate with stars only never erases his note or retires its lesson. */
  note?: string | null;
  by: RatedBy;
  /** The owner's words (an agent session must give them). */
  quote?: string;
  /** W3 E12: the stars are the Super's reading of his words. Agent session, `--quote` and `--run` only. */
  judged?: boolean;
  /** Where his rating came from (W3 E5). */
  via?: 'mac' | 'telegram' | 'super';
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
  /** The lesson slot the draft is for: absent = the note's, `c:<id>` = a correction's (W3 C17). */
  slot?: string;
  /** W3 E12: `--judged` on a run he rated himself kept his stars. */
  keptOwnerStars?: true;
}

function cleanNote(note: string | null | undefined): string {
  return typeof note === 'string' ? note.replace(/\r\n/g, '\n').trim().slice(0, SCORECARD_LIMITS.noteChars) : '';
}

/** Every lesson slot of a run (a cleared rating). */
export const ALL_SLOTS = null;

/** Retire the run's live lesson (active or held) in one slot (absent: the note's; `c:<id>`: a
 *  correction's), or in every slot with {@link ALL_SLOTS}: a cleared rating or note, or a newer lesson. */
export function retireRunLessons(card: MemberCard, runKey: string, slot: string | undefined | typeof ALL_SLOTS): void {
  for (const l of card.lessons) {
    if (l.run !== runKey || (slot !== ALL_SLOTS && l.slot !== slot)) continue;
    if (l.status === 'active' || l.status === 'held') l.status = 'replaced';
  }
}

/**
 * The answer fold (W3 C16): what "he said exactly that" means for a short answer. Lower case, the
 * hub's voice marker removed, every punctuation mark removed, spaces collapsed. Not `foldNote`,
 * which keeps punctuation.
 */
export function answerFold(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('tr').replace(/🎙️?/gu, ' ').replace(/\p{P}/gu, ' ').replace(/\s+/g, ' ').trim();
}

type OwnerTurns = ReturnType<typeof readOwnerTurns>;

/**
 * The asked window (W3 C16): after the Super asked him about this run, his answer is the first
 * turn of THIS conversation at or after the ask that covers the quote or says exactly it (the
 * answer fold), skipping turns that already rated another run. Undefined: no ask is on record
 * (D16 applies). Null: an ask is on record and no turn of his answers it.
 */
function askedWindowTurn(
  contextRoot: string, sessionKey: string, quote: string, turns: OwnerTurns, keys: readonly string[],
  used: ReadonlySet<string>,
): OwnerTurns[number] | null | undefined {
  const parts = splitSessionKey(sessionKey);
  if (!parts) return undefined;
  const anchor = rateAskAnchor(contextRoot, parts.source, parts.runId);
  if (anchor === null) return undefined;
  if (keys.length === 0) return null;
  const want = answerFold(quote);
  const inWindow = turns
    .filter((t) => Date.parse(t.at) >= anchor && sameConversation(keys, t.keys) && !used.has(t.turn))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return inWindow.find((t) => quoteCovers(quote, t.own) || (want !== '' && answerFold(t.own) === want)) ?? null;
}

/** The fields that make up his note: kept together whenever an agent's write leaves it standing (E13). */
const HIS_NOTE_FIELDS = ['note', 'noteFold', 'quote', 'quoteTurn', 'draft'] as const satisfies readonly (keyof Rating)[];

export function rateRun(projectRoot: string, member: string, input: RateInput): RateResult {
  const now = input.now ?? new Date();
  const stars = input.stars;
  const contextRoot = contextRootOf(projectRoot);
  if (stars !== null && (!Number.isInteger(stars) || stars < 1 || stars > 5)) throw new ScorecardRefused('invalid_args', 400, 'Stars are 1 to 5.');
  // The member first: an unknown one is `unknown_member`, never "no run".
  resolveScorecard(projectRoot, member, input.home);
  const quote = input.quote ? input.quote.replace(/\s+/g, ' ').trim().slice(0, 500) : undefined;
  // E13: only he clears a rating (his stars, his note, every correction and its lesson); an agent
  // records his words, it never takes them away.
  if (stars === null && input.by !== 'owner') throw new ScorecardRefused('invalid_args', 400, 'Only the owner clears a rating: he clears it on the card.');
  if (input.judged) {
    if (input.by === 'owner') throw new ScorecardRefused('invalid_args', 400, '--judged is the Super\'s reading of his words: only from an agent session.');
    if (!quote) throw new ScorecardRefused('rate_needs_owner_words', 403, '--judged needs --quote "<his exact words>".');
    if (input.last || !input.run) throw new ScorecardRefused('invalid_args', 400, '--judged needs the run it grades (--run <key>), never --last.');
  }
  let sessionKey = '';
  if (!input.last) {
    sessionKey = sessionKeyOf(input.run ?? '');
    if (!isRunKey(sessionKey)) throw new ScorecardRefused('invalid_args', 400, 'Name the run (--run <source>::<runId>) or use --last.');
  }
  // The stored rating, read before the lock: a Super job's snapshot resolves it at any age, and the
  // asked window skips the turns this card already used. The lock re-checks what it writes.
  const peek = readScorecard(projectRoot, member, input.home);
  const peekPrev = sessionKey ? peek.card.ratings[runKeyFor(peek.scope, sessionKey)] : undefined;
  // An agent's rating carries his words, resolved to one of his turns (D16).
  let quoteTurn: string | undefined;
  let quoteAt: number | null = null;
  let quoteOwn = '';
  let windowed = false;
  if (input.by !== 'owner') {
    if (!quote) throw new ScorecardRefused('rate_needs_owner_words', 403, 'A rating from an agent needs --quote "<his exact words>".');
    const since = new Date(now.getTime() - OWNER_WORDS_MAX_AGE_DAYS * 86_400_000).toISOString();
    const turns = (input.turns ?? readOwnerTurns({ home: input.home, since })).filter((t) => t.at >= since);
    const keys = conversationKeysFromEnv(input.env ?? process.env);
    const own = new Set([peekPrev?.quoteTurn, ...(peekPrev?.corrections ?? []).map((c) => c.quoteTurn)].filter((x): x is string => !!x));
    const used = new Set(peek.card.usedQuoteTurns.filter((t) => !own.has(t)));
    const asked = sessionKey ? askedWindowTurn(contextRoot, sessionKey, quote, turns, keys, used) : undefined;
    if (asked === null) throw new ScorecardRefused('rate_needs_owner_words', 403, 'Those words are not his answer to you after you asked about this job: quote what he said.');
    if (asked) {
      windowed = true;
      quoteTurn = asked.turn;
      quoteOwn = asked.own;
      quoteAt = Date.parse(asked.at);
    } else {
      const hit = findQuoteTurn(quote, turns, keys);
      if (!hit.turn) throw new ScorecardRefused('rate_needs_owner_words', 403, 'Those words are not one of the owner\'s messages: quote what he said.');
      // His words in THIS conversation, like `learn`'s active gate: a session never rates on words
      // he typed to another one (a child, or a member that read them somewhere).
      if (keys.length === 0 || !hit.here) throw new ScorecardRefused('rate_needs_owner_words', 403, 'Those words were said in another conversation: a rating needs his words to you here.');
      quoteTurn = hit.turn.turn;
      quoteOwn = hit.turn.own;
      quoteAt = Date.parse(hit.turn.at);
    }
  }
  let session: { title: string; startedAt: string; status: string };
  let viaSuper = false;
  if (input.last) {
    // With his words, the run he meant ended before he spoke (a run that ends in between is not his).
    const last = lastRateableRun(projectRoot, member, quoteAt, input.home);
    if (!last) throw new ScorecardRefused('unknown_run', 404, 'This member has no finished run to rate.');
    sessionKey = last.key;
    session = { title: last.title, startedAt: last.startedAt, status: snapshotStatus(last) };
  } else if (peekPrev?.viaSuper) {
    // A rated Super job: its snapshot, whatever the record or the thread still holds (E9).
    session = { title: peekPrev.title, startedAt: peekPrev.runAt, status: peekPrev.status };
    viaSuper = true;
  } else {
    const found = findRun(projectRoot, member, sessionKey, input.home);
    if (!found.run) throw new ScorecardRefused('unknown_run', 404, `No run ${sessionKey} of this member here.`);
    if (!found.rateable) throw new ScorecardRefused('run_not_rateable', 409, 'Only a finished run can be rated.');
    session = { title: found.run.title, startedAt: found.run.startedAt, status: snapshotStatus(found.run) };
    viaSuper = !!found.viaSuper;
  }
  let given = input.note === undefined || input.note === null ? null : cleanNote(input.note);
  // An agent never erases his words (E13): an empty note from it keeps the stored one.
  if (input.by !== 'owner' && given === '') given = null;
  // A note an agent passes becomes a lesson in the member's prompt "as his words": it must BE his
  // words, from the turn the quote resolved to.
  if (input.by !== 'owner' && given) {
    // Whole words only: a cut word can flip his meaning ("artırma" cut to "artır").
    const covered = windowed ? answerFold(given) !== '' && ` ${answerFold(quoteOwn)} `.includes(` ${answerFold(given)} `) : quoteCovers(given, quoteOwn);
    if (!covered) throw new ScorecardRefused('rate_needs_owner_words', 403, 'The note must be his own words from that message: pass them as he said them, or rate without a note.');
  }
  const project = projectRefOf(projectRoot, input.home);
  return withScorecard(projectRoot, member, (card, scope) => {
    const runKey = runKeyFor(scope, sessionKey);
    const prev = card.ratings[runKey];
    const sameCorrection = quoteTurn ? prev?.corrections?.find((c) => c.quoteTurn === quoteTurn) : undefined;
    if (quoteTurn && card.usedQuoteTurns.includes(quoteTurn) && prev?.quoteTurn !== quoteTurn && !sameCorrection) {
      throw new ScorecardRefused('quote_used', 409, 'Those words already rated another run: one quote rates one run. Ask him for this one.');
    }
    if (quoteTurn && !card.usedQuoteTurns.includes(quoteTurn)) card.usedQuoteTurns.push(quoteTurn);
    if (stars === null) {
      delete card.ratings[runKey];
      retireRunLessons(card, runKey, ALL_SLOTS);
      return { runKey, rating: null, draft: false };
    }
    const at = now.toISOString();
    // E13: an agent's words never replace the note he already has. From another turn they become a
    // correction beside it (the same turn again: that correction, nothing new); from the note's own
    // turn they are the note itself. The rating keeps the note's quote and turn either way, so a
    // resend still finds both.
    const keepsNote = input.by !== 'owner' && !!given && !!prev?.note && foldNote(given) !== prev.noteFold;
    const correcting = keepsNote && prev!.quoteTurn !== quoteTurn;
    let correction: Correction | undefined;
    if (correcting && !sameCorrection) {
      const fold = foldNote(given!);
      if (!prev!.corrections?.some((c) => c.noteFold === fold)) {
        correction = { id: newId('co'), note: given!, noteFold: fold, quoteTurn: quoteTurn!, at };
      }
    }
    const note = keepsNote ? prev!.note! : given ?? prev?.note ?? '';
    const fold = note ? foldNote(note) : '';
    // E12: a judged rating never replaces his own stars.
    const keepOwner = !!input.judged && !!prev && !prev.judged;
    const corrections = [...(prev?.corrections ?? []), ...(correction ? [correction] : [])];
    const keepQuote = given === null && !quote;
    const rating: Rating = keepOwner ? { ...prev! } : {
      stars,
      firstAt: prev?.firstAt ?? at,
      at,
      by: input.judged ? 'super' : input.by,
      ...(quote ? { quote } : keepQuote && prev?.quote ? { quote: prev.quote } : {}),
      ...(quoteTurn ? { quoteTurn } : keepQuote && prev?.quoteTurn ? { quoteTurn: prev.quoteTurn } : {}),
      title: session.title,
      runAt: session.startedAt,
      status: session.status,
      project,
      via: input.via ?? (input.by === 'owner' ? 'mac' : 'super'),
      ...(input.judged ? { judged: true as const } : {}),
      ...(viaSuper || prev?.viaSuper ? { viaSuper: true as const } : {}),
    };
    delete rating.note; delete rating.noteFold; delete rating.corrections;
    if (!keepOwner) delete rating.draft;
    if (note) { rating.note = note; rating.noteFold = fold; }
    if (corrections.length) rating.corrections = corrections;
    let draft = false;
    let slot: string | undefined;
    if (correction) {
      // A correction's own lesson; the note's stays as it is. Words he undid are never drafted again.
      const undone = card.lessons.some((l) => l.run === runKey && l.noteFold === correction!.noteFold && l.status === 'undone');
      if (!undone) {
        correction.draft = { state: 'running', attempts: 0, at, noteFold: correction.noteFold };
        draft = true;
        slot = `c:${correction.id}`;
      }
    } else if (!keepsNote) {
      if (!note) {
        retireRunLessons(card, runKey, undefined);
      } else if (prev?.noteFold === fold && prev.draft) {
        // The same note: its draft (done, running or failed) carries over.
        rating.draft = prev.draft;
      } else {
        // A new note: the old lesson stays until the new one commits (D5). An undone lesson of the
        // same words is never drafted again.
        const undone = card.lessons.some((l) => l.run === runKey && l.slot === undefined && l.noteFold === fold && l.status === 'undone');
        if (!undone) {
          // `running` with no pid yet: "starting" for a few seconds, until the drafter marks itself.
          rating.draft = { state: 'running', attempts: 0, at, noteFold: fold };
          draft = true;
        }
      }
    }
    // E13 in one place: when an agent's words leave his note standing, the note is kept WHOLE, as
    // one unit: its text, its fold, the quote and turn it came from, and its lesson draft (running,
    // failed or done). Only stars, the correction list and the rating's own fields move.
    if (keepsNote) {
      for (const k of HIS_NOTE_FIELDS) {
        if (prev![k] === undefined) delete rating[k];
        else (rating as unknown as Record<string, unknown>)[k] = prev![k];
      }
    }
    card.ratings[runKey] = rating;
    return { runKey, rating, draft, ...(slot ? { slot } : {}), ...(keepOwner ? { keptOwnerStars: true as const } : {}) };
  }, { home: input.home })!;
}

/** A rating's status snapshot: the run's first terminal entry, never a live `waiting` or `running`. */
function snapshotStatus(s: HistorySession): string {
  if (s.request) return s.request.status;
  return s.status && TERMINAL_RUN_STATUSES.has(s.status) ? s.status : 'ok';
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
  const series = bindingSeriesOf(Array.isArray(cache.series) ? cache.series : [], manifest.binding ?? null);
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
export function commitLesson(card: MemberCard, runKey: string, text: string, noteFold: string, now: Date, slot?: string): Lesson {
  retireRunLessons(card, runKey, slot);
  const flags = amendmentRisks('', text);
  const lesson: Lesson = {
    id: newId('le'), text, run: runKey, noteFold, at: now.toISOString(),
    status: flags.length ? 'held' : 'active', ...(flags.length ? { flags } : {}), ...(slot ? { slot } : {}),
  };
  card.lessons.push(lesson);
  return lesson;
}


// ─── The Telegram request (W3 C10) ─────────────────────────────────────────────

/**
 * Give this run's result message its stars: one `TgAsk` per run, with the run's own `endedAt`, so
 * every Telegram path reads the Mac's clock. Null (the message goes without stars, as before) when
 * the run asks nothing (E1), already has a request or a rating, its member is gone or not this
 * Mac's, or the card cannot be written. Never throws.
 */
export function attachTelegramAsk(
  projectRoot: string, member: string, sessionKey: string, to: { botId: number; chatId: number },
  opts: { home?: string; now?: Date } = {},
): { askId: string; runKey: string; endedAt: string } | null {
  try {
    const parts = splitSessionKey(sessionKey);
    if (!parts) return null;
    const facts = requestFacts(contextRootOf(projectRoot), parts.source, parts.runId, opts.home);
    if (!facts || !facts.eligible) return null;
    const at = (opts.now ?? new Date()).toISOString();
    return withScorecard(projectRoot, member, (card, scope) => {
      const runKey = runKeyFor(scope, sessionKey);
      if (card.telegramAsks[runKey] || card.ratings[runKey]) return NO_WRITE;
      const askId = randomBytes(8).toString('hex');
      card.telegramAsks[runKey] = { askId, botId: String(to.botId), chatId: String(to.chatId), endedAt: facts.endedAt, notePromptIds: [], at };
      return { askId, runKey, endedAt: facts.endedAt };
    }, { home: opts.home }) ?? null;
  } catch {
    return null;
  }
}

/** The sent message's id on its request; returns the run's stars when he rated it meanwhile (the
 *  sender redraws them), else null. Never throws. */
export function setTelegramMessage(projectRoot: string, member: string, runKey: string, messageId: number, home?: string): number | null {
  try {
    return withScorecard(projectRoot, member, (card) => {
      const ask = card.telegramAsks[runKey];
      if (!ask) return NO_WRITE;
      ask.messageId = messageId;
      return card.ratings[runKey]?.stars ?? null;
    }, { home }) ?? null;
  } catch {
    return null;
  }
}
