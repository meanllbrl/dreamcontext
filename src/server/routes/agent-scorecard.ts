/**
 * The member SCORECARD card's routes (plan uye-karnesi C5, C6).
 *
 *   GET  /api/agents/:slug/scorecard?before=<cursor>     the card, its recent runs and trend
 *   POST /api/agents/:slug/scorecard/rate                {run, stars|null, note?}
 *   POST /api/agents/:slug/scorecard/criteria            {op: 'add'|'remove', id?, text?}
 *   POST /api/agents/:slug/scorecard/verdict             {run, id, met: boolean|null}
 *   POST /api/agents/:slug/scorecard/lessons/:id/undo
 *   POST /api/agents/:slug/scorecard/lessons/:id/use
 *   POST /api/agents/:slug/scorecard/goal                {insight, baseline?, target} | {clear: true}
 *   POST /api/agents/:slug/scorecard/check               {run}   (Try again)
 *   POST /api/agents/:slug/scorecard/draft               {run}   (Try again)
 *   POST /api/agents/:slug/scorecard/fresh
 *
 * Every POST is the owner's page only (`refuseUnlessOwnerPage`). On a phone socket one filter
 * (`phoneScope`) drops every rating, check, lesson and goal of a project the phone may not reach,
 * `rate` takes only a run of the request project and `undo` only a lesson of one.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { refuseUnlessOwnerPage } from '../owner-page.js';
import { isMacExposed, isPhoneSocket } from '../phone-origin.js';
import { vaultNameForContextRoot } from '../../lib/app-link.js';
import { projectKey } from '../../lib/local-store.js';
import { runChildAlive } from '../../lib/automations/store.js';
import { agentActivity, runIsActive, type AgentActivity } from '../automation-job.js';
import { findLiveChat } from './agent-chat-live.js';
import {
  SCORECARD_LIMITS, ScorecardRefused, effectiveState, projectKeyOfRun, readScorecard, runKeyFor, startFresh,
  withScorecard, type MemberCard, type ScorecardScope,
} from '../../lib/agents/scorecard.js';
import {
  addCriterion, assertNotRunning, clearGoal, goalCandidates, goalSeries, ownerBlockChars, rateRun, rateableRuns, removeCriterion,
  setGoal, setVerdict, trendOf, undoLesson, useLesson,
} from '../../lib/agents/scorecard-ops.js';
import { spawnScorecardJob, type SpawnScorecardFn } from '../../lib/agents/scorecard-judge.js';

/** Tests swap the detached spawn for a recorder. */
let spawnJob: SpawnScorecardFn = spawnScorecardJob;
export function setScorecardSpawnForTests(fn: SpawnScorecardFn | null): void {
  spawnJob = fn ?? spawnScorecardJob;
}

function refused(res: ServerResponse, err: unknown): void {
  if (err instanceof ScorecardRefused) { sendError(res, err.status, err.code, err.message); return; }
  const e = err as { code?: unknown; message?: string };
  if (e?.code === 'not_owner') { sendError(res, 403, 'not_owner', e.message ?? 'Not yours.'); return; }
  console.error('[scorecard]', err);
  sendError(res, 500, 'scorecard_failed', 'The scorecard could not be changed.');
}

// ─── The phone's narrowing (C6) ─────────────────────────────────────────────────

/** The vault name a card's run key belongs to, or null when it cannot be told (fail closed). */
function vaultOfRun(runKey: string, scope: ScorecardScope, card: MemberCard, here: { key: string; vault: string }): string | null {
  const pk = projectKeyOfRun(runKey);
  if (scope.prefix === '') return pk === null ? here.vault : null;
  if (pk === null) return null;
  if (pk === here.key) return here.vault;
  const r = Object.values(card.ratings).find((x) => x?.project?.key === pk);
  return r?.project?.vault || null;
}

/** On a phone: only what belongs to a project the phone may reach. On the laptop: the card as is. */
export function phoneScope(req: Pick<IncomingMessage, 'socket'>, card: MemberCard, scope: ScorecardScope, contextRoot: string): MemberCard {
  if (!isPhoneSocket(req)) return card;
  const here = { key: projectKey(dirname(contextRoot)), vault: vaultNameForContextRoot(contextRoot) ?? '' };
  const ok = (runKey: string): boolean => {
    const v = vaultOfRun(runKey, scope, card, here);
    return !!v && isMacExposed(v);
  };
  return {
    ...card,
    ratings: Object.fromEntries(Object.entries(card.ratings).filter(([k, r]) => ok(k) && isMacExposed(r?.project?.vault))),
    checks: Object.fromEntries(Object.entries(card.checks).filter(([k]) => ok(k))),
    lessons: card.lessons.filter((l) => ok(l.run)),
    goal: card.goal && isMacExposed(card.goal.project?.vault) ? card.goal : null,
    usedQuoteTurns: [],
  };
}

// ─── GET ─────────────────────────────────────────────────────────────────────────

export async function handleScorecardGet(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string): Promise<void> {
  const projectRoot = dirname(contextRoot);
  try {
    const read = readScorecard(projectRoot, params.slug);
    const card = phoneScope(req, read.card, read.scope, contextRoot);
    const url = new URL(req.url || '/', 'http://localhost');
    const before = url.searchParams.get('before');
    const activity = new Map<string, AgentActivity | null>();
    const activityOf = (source: string): AgentActivity | null => {
      if (!activity.has(source)) activity.set(source, agentActivity(contextRoot, source));
      return activity.get(source) ?? null;
    };
    const page = rateableRuns(projectRoot, params.slug, {
      before: before && before.length <= 512 ? before : null,
      maxSessions: 20,
      live: {
        isLive: (id) => findLiveChat(id) !== null,
        isHeld: (id) => !!findLiveChat(id)?.holder?.(),
        isRunActive: (source, runId) => runIsActive(activityOf(source), runId) || runChildAlive(contextRoot, source, runId),
        isRunHeld: (source, runId) => !!activityOf(source)?.runs?.some((r) => r.runId === runId),
      },
    });
    const runs = page.runs.map((s) => {
      const runKey = runKeyFor(read.scope, s.key);
      const rating = card.ratings[runKey];
      const check = card.checks[runKey];
      return {
        key: s.key, runKey, title: s.title, startedAt: s.startedAt, lastAt: s.lastAt, status: s.status,
        rating: rating ? { ...rating, draft: effectiveState(rating.draft) } : null,
        check: check ? effectiveState(check) : null,
        lessons: card.lessons.filter((l) => l.run === runKey && l.status !== 'replaced'),
      };
    });
    // The goal's band: only in its own project, never its numbers elsewhere (D18).
    let goal: Record<string, unknown> | null = null;
    if (card.goal) {
      const here = card.goal.project?.key === projectKey(projectRoot);
      const series = here ? goalSeries(projectRoot, card.goal.insight) : null;
      goal = here
        ? { ...card.goal, here: true, gone: !series, ...(series ? { title: series.title, latest: series.latest, unit: series.unit, points: series.points } : {}) }
        : { insight: card.goal.insight, project: card.goal.project, here: false };
    }
    const phone = isPhoneSocket(req);
    sendJson(res, 200, {
      card: { ...card, goal: undefined, usedQuoteTurns: undefined },
      runs,
      nextBefore: page.nextBefore,
      trend: trendOf(card),
      ownerBlockChars: ownerBlockChars(card),
      blockWarnChars: SCORECARD_LIMITS.blockWarnChars,
      goal,
      candidates: phone ? [] : goalCandidates(projectRoot),
      phone,
      ...(read.damaged ? { damaged: read.damaged } : {}),
    });
  } catch (err) {
    refused(res, err);
  }
}

// ─── POSTs ───────────────────────────────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string) => Promise<void>;

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const b = await parseJsonBody(req).catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {};
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function post(what: string, fn: (body: Record<string, unknown>, ctx: { req: IncomingMessage; params: Record<string, string>; contextRoot: string; projectRoot: string }) => unknown): Handler {
  return async (req, res, params, contextRoot) => {
    if (refuseUnlessOwnerPage(req, res, what)) return;
    try {
      const body = await bodyOf(req);
      const out = await fn(body, { req, params, contextRoot, projectRoot: dirname(contextRoot) });
      sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      refused(res, err);
    }
  };
}

export const handleScorecardRate = post('rates a member\'s run', (body, { params, projectRoot }) => {
  const run = str(body.run);
  const stars = body.stars === null ? null : typeof body.stars === 'number' ? body.stars : NaN;
  if (!run || (stars !== null && !Number.isInteger(stars))) throw new ScorecardRefused('invalid_args', 400, 'Give {run, stars} (stars null clears).');
  // `rateRun` resolves the run in THIS project's history: a phone rates only the request project's runs.
  // An absent note keeps the stored one; '' clears it.
  const r = rateRun(projectRoot, params.slug, { run, stars, note: str(body.note), by: 'owner' });
  if (r.draft) spawnJob({ kind: 'draft', projectRoot, member: params.slug, run: r.runKey });
  return r;
});

export const handleScorecardCriteria = post('changes a member\'s lines of good work', (body, { params, projectRoot }) => {
  if (body.op === 'add') return { id: addCriterion(projectRoot, params.slug, str(body.text) ?? '') };
  if (body.op === 'remove') { removeCriterion(projectRoot, params.slug, str(body.id) ?? ''); return { ok: true }; }
  throw new ScorecardRefused('invalid_args', 400, 'op is add or remove.');
});

export const handleScorecardVerdict = post('sets a check\'s verdict', (body, { params, projectRoot }) => {
  const met = body.met === null ? null : typeof body.met === 'boolean' ? body.met : undefined;
  if (met === undefined) throw new ScorecardRefused('invalid_args', 400, 'met is true, false or null.');
  setVerdict(projectRoot, params.slug, str(body.run) ?? '', str(body.id) ?? '', met);
  return { ok: true };
});

export const handleScorecardLessonUndo = post('undoes a lesson', (_body, { req, params, projectRoot, contextRoot }) => {
  if (isPhoneSocket(req)) {
    // A phone undoes only a lesson of a run of the request project.
    const { card, scope } = readScorecard(projectRoot, params.slug);
    const narrowed = phoneScope(req, card, scope, contextRoot);
    const l = narrowed.lessons.find((x) => x.id === params.id);
    const own = l && (scope.prefix === '' ? projectKeyOfRun(l.run) === null : l.run.startsWith(scope.prefix));
    if (!own) throw new ScorecardRefused('unknown_lesson', 404, 'No such lesson in this project.');
  }
  return undoLesson(projectRoot, params.slug, params.id);
});

export const handleScorecardLessonUse = post('uses a lesson that waits', (_body, { params, projectRoot }) => useLesson(projectRoot, params.slug, params.id));

export const handleScorecardGoal = post('links a member\'s goal', (body, { params, projectRoot }) => {
  if (body.clear === true) { clearGoal(projectRoot, params.slug); return { ok: true }; }
  const insight = str(body.insight);
  const target = typeof body.target === 'number' ? body.target : NaN;
  const baseline = typeof body.baseline === 'number' ? body.baseline : null;
  if (!insight) throw new ScorecardRefused('invalid_args', 400, 'Pick a Lab card.');
  return setGoal(projectRoot, params.slug, { insight, target, baseline });
});

/** Try again: the route refuses a live `running` itself, before any spawn (C5). */
function retry(kind: 'check' | 'draft'): Handler {
  return post(kind === 'check' ? 'checks a run again' : 'writes a lesson again', (body, { params, projectRoot }) => {
    const run = str(body.run);
    if (!run) throw new ScorecardRefused('invalid_args', 400, 'Name the run.');
    const { card, scope } = readScorecard(projectRoot, params.slug);
    const runKey = runKeyFor(scope, run.includes('/') && projectKeyOfRun(run) ? run.slice(run.indexOf('/') + 1) : run);
    assertNotRunning(card, runKey, kind);
    if (kind === 'draft' && !card.ratings[runKey]?.note) throw new ScorecardRefused('invalid_args', 400, 'That run has no note.');
    if (kind === 'draft') {
      // Mark it starting, so the card shows it at once and a second tap is refused.
      withScorecard(projectRoot, params.slug, (c) => {
        assertNotRunning(c, runKey, kind);
        const r = c.ratings[runKey];
        if (r?.noteFold) r.draft = { state: 'running', attempts: r.draft?.noteFold === r.noteFold ? r.draft.attempts : 0, at: new Date().toISOString(), noteFold: r.noteFold };
        return true;
      });
    } else {
      withScorecard(projectRoot, params.slug, (c) => {
        assertNotRunning(c, runKey, kind);
        const ch = c.checks[runKey];
        if (ch) { ch.state = 'running'; delete ch.pid; delete ch.pidStart; ch.at = new Date().toISOString(); }
        else c.checks[runKey] = { state: 'running', attempts: 0, at: new Date().toISOString(), criteriaHash: '', verdicts: [], costUsd: 0 };
        return true;
      });
    }
    void scope;
    spawnJob({ kind, projectRoot, member: params.slug, run: runKey });
    return { ok: true };
  });
}

export const handleScorecardCheck = retry('check');
export const handleScorecardDraft = retry('draft');

export const handleScorecardFresh = post('starts a member\'s scorecard fresh', (_body, { params, projectRoot }) => startFresh(projectRoot, params.slug));

/** Read the card after a write (tests). */
export function cardFor(projectRoot: string, slug: string): MemberCard {
  return readScorecard(projectRoot, slug).card;
}
