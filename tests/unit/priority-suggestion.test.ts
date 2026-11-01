import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import matter from 'gray-matter';
import {
  effectiveSuggestion,
  planLinkMove,
  suggestionRefusal,
  hasLiveVerdict,
  deadLinkMark,
  type ObjectiveLiveness,
  type SuggestionTarget,
} from '../../src/lib/priority-suggestion.js';
import {
  createObjective,
  getObjective,
  updateObjective,
  deleteObjective,
  suggestObjective,
  acceptObjectiveSuggestion,
} from '../../src/lib/objectives-store.js';
import { buildRoadmapModel } from '../../src/lib/roadmap-model.js';
import { objectiveLiveness, scoringWork, topLevelOf, startScoring, stopScoring, isScoringRunning, touchScoring } from '../../src/lib/scoring-work.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import {
  handleRoadmapPriority,
  handleRoadmapScoringStart,
  handleTaskSuggestionAccept,
  handleTaskSuggestionDismiss,
  handleTaskObjectivesMove,
  handleObjectiveSuggestionAccept,
} from '../../src/server/routes/roadmap-priority.js';
import { handleObjectivesUpdate, handleObjectivesList, handleObjectivesCreate } from '../../src/server/routes/objectives.js';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { registerRoadmapCommand } from '../../src/cli/commands/roadmap.js';

/**
 * W1 of the priority board: the suggestion contract (priority_suggestion), objective
 * RICE, the locked accept/dismiss/move, scoringWork (N), and the CLI agent guard.
 */

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody };
}

function jsonReq(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (stream as { method?: string }).method = 'POST';
  (stream as { headers?: Record<string, string> }).headers = { 'content-type': 'application/json' };
  return stream;
}
const getReq = { method: 'GET', headers: {} } as unknown as IncomingMessage;

let projectRoot: string;
let contextRoot: string;
let prevCwd: string;
let prevSession: string | undefined;

function writeTask(slug: string, fm: Record<string, unknown> = {}): void {
  const front = { name: slug, status: 'todo', priority: 'medium', urgency: 'medium', parent_task: null, related_feature: null, version: null, updated_at: '2026-01-01', ...fm };
  writeFileSync(join(contextRoot, 'state', `${slug}.md`), matter.stringify('## Why\nBecause.\n', front), 'utf-8');
}
function fmOf(slug: string): Record<string, any> {
  return matter(readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8')).data;
}
function rawOf(slug: string): string {
  return readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
}
function objRaw(slug: string): string {
  return readFileSync(join(contextRoot, 'core', 'objectives', `${slug}.md`), 'utf-8');
}
function live(): ObjectiveLiveness[] {
  return objectiveLiveness(buildRoadmapModel(contextRoot));
}
const backend = (): LocalTaskBackend => new LocalTaskBackend(join(contextRoot, 'state'));

async function cli(...argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  registerRoadmapCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-prio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(join(contextRoot, 'core'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  prevSession = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevSession !== undefined) process.env.CLAUDE_CODE_SESSION_ID = prevSession;
  else delete process.env.CLAUDE_CODE_SESSION_ID;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

// ─── Pure resolver ─────────────────────────────────────────────────────────

describe('effectiveSuggestion (the one resolver)', () => {
  const objs: ObjectiveLiveness[] = [
    { slug: 'mrr', done: false, created_at: '2026-10-01' },
    { slug: 'old', done: true, created_at: '2026-01-01' },
  ];
  const sugg = { reach: 6, impact: 3, confidence: 75, effort: 0.5, objective: 'mrr', why: 'w', at: '2026-11-01T10:00:00.000Z-aaaa', dismissed_at: null, accepted_at: null };
  const target = (over: Partial<SuggestionTarget> = {}): SuggestionTarget => ({
    kind: 'task',
    rice: { reach: null, impact: null, confidence: null, effort: null },
    objectives: [],
    priority_suggestion: sugg,
    ...over,
  });

  it('drops the rice part of a scored task and the link part of a live-linked task', () => {
    expect(effectiveSuggestion(target(), objs)).toMatchObject({ rice: { reach: 6, effort: 0.5 }, objective: 'mrr' });
    expect(effectiveSuggestion(target({ rice: { reach: 1, impact: 1, confidence: 25, effort: 1 } }), objs)).toMatchObject({ rice: null, objective: 'mrr' });
    expect(effectiveSuggestion(target({ objectives: ['mrr'] }), objs)?.objective).toBeNull();
  });

  it('a task whose links are all dead counts as unlinked; a link to a done objective is no link part', () => {
    expect(effectiveSuggestion(target({ objectives: ['old', 'gone'] }), objs)?.objective).toBe('mrr');
    expect(effectiveSuggestion(target({ priority_suggestion: { ...sugg, objective: 'old' }, rice: { reach: 1, impact: 1, confidence: 25, effort: 1 } }), objs)).toBeNull();
    expect(deadLinkMark(['old'], objs)).toBe('objective done');
    expect(deadLinkMark(['old', 'gone'], objs)).toBe('objective missing');
    expect(deadLinkMark(['mrr', 'gone'], objs)).toBeNull();
  });

  it('dismissed and accepted records are not pending', () => {
    expect(effectiveSuggestion(target({ priority_suggestion: { ...sugg, dismissed_at: 'x' } }), objs)).toBeNull();
    expect(effectiveSuggestion(target({ priority_suggestion: { ...sugg, accepted_at: 'x' } }), objs)).toBeNull();
  });

  it('a verdict older than the newest live objective is ignored', () => {
    const v = { at: '2026-10-05T00:00:00.000Z-v', dismissed_at: null, accepted_at: null, no_objective: true };
    expect(hasLiveVerdict(v, objs)).toBe(true);
    expect(hasLiveVerdict(v, [...objs, { slug: 'new', done: false, created_at: '2026-10-06' }])).toBe(false);
    expect(hasLiveVerdict(v, [...objs, { slug: 'same', done: false, created_at: '2026-10-05' }])).toBe(true);
  });

  it('refusal: owner_scored only for rice fields the target holds, owner_linked only with a live link', () => {
    const scored = target({ rice: { reach: 5, impact: 5, confidence: 75, effort: 1 } });
    expect(suggestionRefusal(scored, { reach: 6, why: 'w' }, objs)).toBe('owner_scored');
    expect(suggestionRefusal(scored, { objective: 'mrr', why: 'w' }, objs)).toBeNull();
    expect(suggestionRefusal(target({ objectives: ['mrr'] }), { objective: 'mrr', why: 'w' }, objs)).toBe('owner_linked');
    expect(suggestionRefusal(target({ objectives: ['old'] }), { objective: 'mrr', why: 'w' }, objs)).toBeNull();
  });
});

describe('planLinkMove', () => {
  it('[A,B] A→B gives [B] and undo {add: A, index: 0}', () => {
    const p = planLinkMove(['a', 'b'], { remove: 'a', add: 'b' });
    expect(p.links).toEqual(['b']);
    expect(p.note).toBe('already_linked');
    expect(p.undo).toEqual({ remove: null, add: 'a', index: 0 });
  });
  it('replaces at the source position and undoes back there', () => {
    const p = planLinkMove(['a', 'b'], { remove: 'a', add: 'c' });
    expect(p.links).toEqual(['c', 'b']);
    expect(planLinkMove(p.links, { ...p.undo }).links).toEqual(['a', 'b']);
  });
  it('drop on Unlinked removes the source only', () => {
    const p = planLinkMove(['x', 'a', 'b'], { remove: 'a', add: null });
    expect(p.links).toEqual(['x', 'b']);
    expect(planLinkMove(p.links, p.undo).links).toEqual(['x', 'a', 'b']);
  });
});

// ─── Objective RICE round trip ─────────────────────────────────────────────

describe('objective reach/confidence', () => {
  it('round-trips through the store, the API, the model and the CLI; score equals computeRiceScore', async () => {
    createObjective(contextRoot, { slug: 'mrr', title: 'MRR', impact: 5, effort: 4 });
    // Absent on an existing file: null, no migration.
    expect(objRaw('mrr')).not.toMatch(/reach:/);
    const before = getObjective(contextRoot, 'mrr')!;
    expect(before.reach).toBeNull();
    expect(before.confidence).toBeNull();
    expect(before.score).toBeNull();

    const r = makeRes();
    await handleObjectivesUpdate(jsonReq({ reach: 7, confidence: 75 }), r.res, { slug: 'mrr' }, contextRoot);
    expect(r.status()).toBe(200);
    expect(r.body().objective).toMatchObject({ reach: 7, confidence: 75, score: 6.56 });

    const m = buildRoadmapModel(contextRoot).objectives[0];
    expect(m).toMatchObject({ reach: 7, confidence: 75, impact: 5, effort: 4, score: 6.56 });

    await cli('roadmap', 'objective', 'edit', 'mrr', '--reach', '8');
    expect(getObjective(contextRoot, 'mrr')!.score).toBe(7.5);

    const list = makeRes();
    await handleObjectivesList(getReq, list.res, {}, contextRoot);
    expect(list.body().objectives[0]).toMatchObject({ reach: 8, confidence: 75, score: 7.5 });

    const c = makeRes();
    await handleObjectivesCreate(jsonReq({ title: 'Other', reach: 3, confidence: 50, impact: 2, effort: 1 }), c.res, {}, contextRoot);
    expect(c.body().objective).toMatchObject({ reach: 3, confidence: 50, score: 3 });
  });

  it('a hand-written objective file without the new keys reads them as null', () => {
    mkdirSync(join(contextRoot, 'core', 'objectives'), { recursive: true });
    writeFileSync(join(contextRoot, 'core', 'objectives', 'legacy.md'), '---\ntitle: Legacy\nimpact: 3\neffort: 2\n---\n## Why\nx\n');
    expect(getObjective(contextRoot, 'legacy')).toMatchObject({ reach: null, confidence: null, score: null, priority_suggestion: null });
  });

  it('rejects out-of-scale reach and confidence', () => {
    createObjective(contextRoot, { slug: 'mrr', title: 'MRR' });
    expect(() => updateObjective(contextRoot, 'mrr', { reach: 11 })).toThrow(/Reach/);
    expect(() => updateObjective(contextRoot, 'mrr', { confidence: 60 })).toThrow(/Confidence/);
  });
});

// ─── Suggest / refusals ────────────────────────────────────────────────────

describe('tasks suggest', () => {
  beforeEach(() => {
    createObjective(contextRoot, { slug: 'mrr', title: 'MRR' });
  });

  it('carrying rice on a scored task refuses owner_scored and writes nothing', async () => {
    writeTask('scored', { rice: { reach: 5, impact: 5, confidence: 75, effort: 0.5 } });
    const before = rawOf('scored');
    await cli('tasks', 'suggest', 'scored', '--reach', '6', '--why', 'w', '--objective', 'mrr');
    expect(process.exitCode).toBe(1);
    expect(rawOf('scored')).toBe(before);
    await expect(backend().suggestPriority('scored', { reach: 6, objective: 'mrr', why: 'w' }, live())).rejects.toMatchObject({ code: 'owner_scored' });
    expect(rawOf('scored')).toBe(before);
  });

  it('a link-only suggestion on a scored task works and does not bump updated_at', async () => {
    writeTask('scored', { rice: { reach: 5, impact: 5, confidence: 75, effort: 0.5 } });
    await cli('tasks', 'suggest', 'scored', '--objective', 'mrr', '--why', 'Serves MRR directly.');
    expect(process.exitCode).toBeUndefined();
    const fm = fmOf('scored');
    expect(fm.priority_suggestion).toMatchObject({ objective: 'mrr', why: 'Serves MRR directly.' });
    expect(typeof fm.priority_suggestion.at).toBe('string');
    expect(fm.rice).toEqual({ reach: 5, impact: 5, confidence: 75, effort: 0.5 });
    expect(fm.objectives).toBeUndefined();
    expect(fm.updated_at).toBe('2026-01-01');
  });

  it('why alone is invalid; an incomplete rice part is refused', async () => {
    writeTask('t');
    await expect(backend().suggestPriority('t', { why: 'w' }, live())).rejects.toMatchObject({ code: 'invalid' });
    await expect(backend().suggestPriority('t', { reach: 3, objective: 'mrr', why: 'w' }, live())).rejects.toMatchObject({ code: 'incomplete' });
    await expect(backend().suggestPriority('t', { reach: 3, impact: 2, confidence: 50, effort: 1, why: 'w' }, live())).rejects.toMatchObject({ code: 'incomplete' });
    await cli('tasks', 'suggest', 't', '--reach', '3', '--impact', '2', '--confidence', '50', '--effort', '1', '--no-objective', '--why', 'Nothing fits.');
    expect(fmOf('t').priority_suggestion).toMatchObject({ no_objective: true });
  });

  it('a dismissed suggestion is not re-suggested without --again', async () => {
    writeTask('t');
    const b = backend();
    const t1 = await b.suggestPriority('t', { reach: 3, impact: 2, confidence: 50, effort: 1, objective: 'mrr', why: 'w' }, live());
    await b.dismissSuggestion('t', t1.priority_suggestion!.at);
    await expect(b.suggestPriority('t', { reach: 4, impact: 2, confidence: 50, effort: 1, objective: 'mrr', why: 'w' }, live())).rejects.toMatchObject({ code: 'dismissed' });
    await cli('tasks', 'suggest', 't', '--reach', '4', '--impact', '2', '--confidence', '50', '--effort', '1', '--objective', 'mrr', '--why', 'w');
    expect(process.exitCode).toBe(1);
    expect(scoringWork(contextRoot).items.map((i) => i.slug)).not.toContain('t');
    expect(scoringWork(contextRoot, { again: true }).items.map((i) => i.slug)).toContain('t');
    const again = await b.suggestPriority('t', { reach: 4, impact: 2, confidence: 50, effort: 1, objective: 'mrr', why: 'w' }, live(), { again: true });
    expect(again.priority_suggestion).toMatchObject({ reach: 4, dismissed_at: null });
  });

  it('objective suggest refuses per field across all four values', () => {
    for (const k of ['reach', 'impact', 'confidence', 'effort'] as const) {
      const slug = `obj-${k}`;
      const value = { reach: 7, impact: 5, confidence: 75, effort: 4 }[k];
      createObjective(contextRoot, { slug, title: slug, [k]: value });
      const before = objRaw(slug);
      const input = { reach: 6, impact: 4, confidence: 50, effort: 2, why: 'w' };
      expect(() => suggestObjective(contextRoot, slug, input, live())).toThrow(expect.objectContaining({ code: 'owner_scored' }));
      expect(objRaw(slug)).toBe(before);
      // Leaving out the held field succeeds.
      const { [k]: _held, ...rest } = input;
      suggestObjective(contextRoot, slug, rest, live());
      expect(getObjective(contextRoot, slug)!.priority_suggestion).toMatchObject(rest);
    }
  });

  it('objective suggest --reach --confidence on an objective with impact and effort: accept scores it and leaves impact and effort', async () => {
    createObjective(contextRoot, { slug: 'two', title: 'Two', impact: 5, effort: 4 });
    await cli('roadmap', 'objective', 'suggest', 'two', '--reach', '7', '--confidence', '75', '--why', 'Most teachers hit this.');
    expect(process.exitCode).toBeUndefined();
    const at = getObjective(contextRoot, 'two')!.priority_suggestion!.at;
    const r = makeRes();
    await handleObjectiveSuggestionAccept(jsonReq({ at }), r.res, { slug: 'two' }, contextRoot);
    expect(r.status()).toBe(200);
    expect(r.body()).toMatchObject({ outcome: 'applied', score: 6.56, filled: ['reach', 'confidence'] });
    expect(getObjective(contextRoot, 'two')).toMatchObject({ impact: 5, effort: 4, reach: 7, confidence: 75, score: 6.56 });
  });
});

// ─── Accept ────────────────────────────────────────────────────────────────

describe('accept', () => {
  beforeEach(() => {
    createObjective(contextRoot, { slug: 'mrr', title: 'MRR' });
    createObjective(contextRoot, { slug: 'retention', title: 'Retention' });
    writeTask('t');
  });
  const full = { reach: 6, impact: 3, confidence: 75, effort: 0.5, objective: 'mrr', why: 'w' };

  async function accept(at: string, rice?: Record<string, number>): Promise<{ status: number; body: any }> {
    const r = makeRes();
    await handleTaskSuggestionAccept(jsonReq({ at, rice }), r.res, { slug: 't' }, contextRoot);
    return { status: r.status(), body: r.body() };
  }

  it('lands rice and link together; a retry answers already_applied', async () => {
    const at = (await backend().suggestPriority('t', full, live())).priority_suggestion!.at;
    const a = await accept(at);
    expect(a).toMatchObject({ status: 200, body: { outcome: 'applied', objectives: ['mrr'] } });
    const fm = fmOf('t');
    expect(fm.rice).toMatchObject({ reach: 6, impact: 3, confidence: 75, effort: 0.5, score: 27 });
    expect(fm.objectives).toEqual(['mrr']);
    expect(fm.priority_suggestion).toMatchObject({ at, no_objective: false });
    expect(typeof fm.priority_suggestion.accepted_at).toBe('string');
    expect(fm.priority_suggestion.reach).toBeUndefined();
    const before = rawOf('t');
    const again = await accept(at);
    expect(again).toMatchObject({ status: 200, body: { outcome: 'already_applied' } });
    expect(rawOf('t')).toBe(before);
    expect((await accept('2026-01-01T00:00:00.000Z-zzzz')).status).toBe(409);
  });

  it('a score set by CLI after the suggestion is not changed by accept', async () => {
    const at = (await backend().suggestPriority('t', full, live())).priority_suggestion!.at;
    await cli('tasks', 'rice', 't', '--reach', '2', '--impact', '2', '--confidence', '50', '--effort', '2');
    const a = await accept(at);
    expect(a.body.outcome).toBe('applied');
    expect(fmOf('t').rice).toMatchObject({ reach: 2, impact: 2, confidence: 50, effort: 2 });
    expect(fmOf('t').objectives).toEqual(['mrr']);
  });

  it('a link added after the suggestion: accept does not add a second one', async () => {
    const at = (await backend().suggestPriority('t', full, live())).priority_suggestion!.at;
    await cli('tasks', 'objectives', 't', 'retention');
    await accept(at);
    expect(fmOf('t').objectives).toEqual(['retention']);
  });

  it('a deleted objective named by the suggestion: the rice part still lands and the link is reported dropped', async () => {
    const at = (await backend().suggestPriority('t', full, live())).priority_suggestion!.at;
    deleteObjective(contextRoot, 'mrr');
    const a = await accept(at);
    expect(a.body).toMatchObject({ outcome: 'applied', link_dropped: 'mrr' });
    expect(fmOf('t').rice).toMatchObject({ score: 27 });
    expect(fmOf('t').objectives ?? []).toEqual([]);
  });

  it('a stale at answers 409 suggestion_changed and writes nothing', async () => {
    const first = (await backend().suggestPriority('t', full, live())).priority_suggestion!.at;
    await new Promise((r) => setTimeout(r, 2));
    await backend().suggestPriority('t', { ...full, reach: 8 }, live());
    const before = rawOf('t');
    const a = await accept(first);
    expect(a).toMatchObject({ status: 409, body: { error: 'suggestion_changed' } });
    expect(rawOf('t')).toBe(before);
  });

  it('nothing effective answers nothing_to_apply and tombstones; the owner edits are applied', async () => {
    const at = (await backend().suggestPriority('t', full, live())).priority_suggestion!.at;
    await cli('tasks', 'rice', 't', '--reach', '2', '--impact', '2', '--confidence', '50', '--effort', '2');
    await cli('tasks', 'objectives', 't', 'retention');
    const a = await accept(at);
    expect(a.body.outcome).toBe('nothing_to_apply');
    expect(fmOf('t').priority_suggestion.accepted_at).toBeTruthy();

    writeTask('u');
    const at2 = (await backend().suggestPriority('u', full, live())).priority_suggestion!.at;
    const r = makeRes();
    await handleTaskSuggestionAccept(jsonReq({ at: at2, rice: { effort: 1 } }), r.res, { slug: 'u' }, contextRoot);
    expect(fmOf('u').rice).toMatchObject({ reach: 6, effort: 1, score: 13.5 });
  });

  it('a dismissed record answers 409 on accept', async () => {
    const at = (await backend().suggestPriority('t', full, live())).priority_suggestion!.at;
    const d = makeRes();
    await handleTaskSuggestionDismiss(jsonReq({ at }), d.res, { slug: 't' }, contextRoot);
    expect(d.status()).toBe(200);
    expect((await accept(at)).status).toBe(409);
  });
});

// ─── Move ──────────────────────────────────────────────────────────────────

describe('POST /api/tasks/:slug/objectives/move', () => {
  beforeEach(() => {
    for (const s of ['a', 'b', 'c']) createObjective(contextRoot, { slug: s, title: s.toUpperCase() });
  });
  async function move(body: Record<string, unknown>): Promise<any> {
    const r = makeRes();
    await handleTaskObjectivesMove(jsonReq(body), r.res, { slug: 't' }, contextRoot);
    return { status: r.status(), body: r.body() };
  }

  it('moves only the source link; a link added meanwhile survives the move and the undo', async () => {
    writeTask('t', { objectives: ['a'] });
    // Added elsewhere while the board was open:
    await cli('tasks', 'objectives', 't', 'a,c');
    const m = await move({ remove: 'a', add: 'b' });
    expect(m.status).toBe(200);
    expect(fmOf('t').objectives).toEqual(['b', 'c']);
    const u = await move(m.body.undo);
    expect(u.status).toBe(200);
    expect(fmOf('t').objectives).toEqual(['a', 'c']);
  });

  it('dropping where it is already linked removes the source only and says so; undo restores the position', async () => {
    writeTask('t', { objectives: ['a', 'b'] });
    const m = await move({ remove: 'a', add: 'b' });
    expect(m.body.note).toBe('already_linked');
    expect(fmOf('t').objectives).toEqual(['b']);
    expect(m.body.undo).toMatchObject({ add: 'a', index: 0, undo: true });
    await move(m.body.undo);
    expect(fmOf('t').objectives).toEqual(['a', 'b']);
  });

  it('removal (drop on Unlinked) and its undo', async () => {
    writeTask('t', { objectives: ['a', 'b'] });
    const m = await move({ remove: 'b', add: null });
    expect(fmOf('t').objectives).toEqual(['a']);
    await move(m.body.undo);
    expect(fmOf('t').objectives).toEqual(['a', 'b']);
  });

  it('a done objective is refused as a target but restored by an undo; a missing one fails', async () => {
    writeTask('t', { objectives: ['a'] });
    updateObjective(contextRoot, 'c', { status: 'done' });
    expect((await move({ remove: 'a', add: 'c' })).status).toBe(400);
    expect((await move({ add: 'c', undo: true })).status).toBe(200);
    expect(fmOf('t').objectives).toEqual(['a', 'c']);
    const missing = await move({ add: 'zzz', undo: true });
    expect(missing).toMatchObject({ status: 400, body: { error: 'invalid_objective' } });
  });
});

// ─── scoringWork (N) ──────────────────────────────────────────────────────

describe('scoringWork', () => {
  beforeEach(() => {
    createObjective(contextRoot, { slug: 'mrr', title: 'MRR' });
    createObjective(contextRoot, { slug: 'scored-obj', title: 'S', reach: 5, impact: 3, confidence: 75, effort: 2 });
    writeTask('unscored');
    writeTask('scored-unlinked', { rice: { reach: 9, impact: 5, confidence: 100, effort: 0.4 } });
    writeTask('scored-linked', { rice: { reach: 1, impact: 1, confidence: 25, effort: 1 }, objectives: ['mrr'] });
    writeTask('child', { parent_task: 'unscored' });
    writeTask('closed', { status: 'completed' });
  });

  it('counts open top-level tasks and unscored objectives only', () => {
    const w = scoringWork(contextRoot);
    expect(w.items.map((i) => `${i.kind}:${i.slug}`).sort()).toEqual(['objective:mrr', 'task:scored-unlinked', 'task:unscored']);
    expect(w.items.find((i) => i.slug === 'scored-unlinked')).toMatchObject({ missing: [], needs_link: true });
  });

  async function suggestAll(): Promise<void> {
    for (const it of scoringWork(contextRoot).items) {
      if (it.kind === 'objective') {
        suggestObjective(contextRoot, it.slug, { reach: 4, impact: 3, confidence: 50, effort: 2, why: 'w' }, live());
        continue;
      }
      const input: Record<string, unknown> = { why: 'w' };
      for (const k of it.missing) input[k] = { reach: 3, impact: 2, confidence: 50, effort: 1 }[k];
      if (it.needs_link) input.objective = 'mrr';
      await backend().suggestPriority(it.slug, input, live());
    }
  }

  it('one full agent pass excludes pending items; accepting every suggestion takes N to 0', async () => {
    await suggestAll();
    let w = scoringWork(contextRoot);
    expect(w.count).toBe(0);
    expect(w.pending).toBe(3);
    for (const slug of ['unscored', 'scored-unlinked']) {
      const at = (await backend().get(slug))!.priority_suggestion!.at;
      await backend().acceptSuggestion(slug, at, {}, live());
    }
    acceptObjectiveSuggestion(contextRoot, 'mrr', getObjective(contextRoot, 'mrr')!.priority_suggestion!.at, {}, live());
    w = scoringWork(contextRoot);
    expect(w).toMatchObject({ count: 0, pending: 0 });
  });

  it('dismissing everything left takes N to 0', async () => {
    await suggestAll();
    for (const slug of ['unscored', 'scored-unlinked']) {
      await backend().dismissSuggestion(slug, (await backend().get(slug))!.priority_suggestion!.at);
    }
    const r = makeRes();
    await handleTaskSuggestionDismiss(jsonReq({ at: 'nope' }), r.res, { slug: 'unscored' }, contextRoot);
    expect(r.status()).toBe(409);
    const { dismissObjectiveSuggestion } = await import('../../src/lib/objectives-store.js');
    dismissObjectiveSuggestion(contextRoot, 'mrr', getObjective(contextRoot, 'mrr')!.priority_suggestion!.at);
    expect(scoringWork(contextRoot)).toMatchObject({ count: 0, pending: 0 });
  });

  it('a no_objective verdict removes only the link side', async () => {
    const at = (await backend().suggestPriority('unscored', { reach: 3, impact: 2, confidence: 50, effort: 1, no_objective: true, why: 'w' }, live())).priority_suggestion!.at;
    expect(scoringWork(contextRoot).items.map((i) => i.slug)).not.toContain('unscored');
    await backend().acceptSuggestion('unscored', at, {}, live());
    expect(scoringWork(contextRoot).items.map((i) => i.slug)).not.toContain('unscored');
    expect(scoringWork(contextRoot, { again: true }).items.map((i) => i.slug)).toContain('unscored');
    // An unscored task with a verdict is still counted (score side open).
    await backend().suggestPriority('scored-unlinked', { no_objective: true, why: 'w' }, live());
    writeTask('verdict-only', { priority_suggestion: { no_objective: true, at: '2099-01-01T00:00:00.000Z-v', dismissed_at: null, accepted_at: '2099-01-01T00:00:00.000Z' } });
    expect(scoringWork(contextRoot).items.find((i) => i.slug === 'verdict-only')).toMatchObject({ needs_link: false, missing: ['reach', 'impact', 'confidence', 'effort'] });
  });

  it('roadmap unscored --json prints the payload', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cli('roadmap', 'unscored', '--json');
    const out = JSON.parse(spy.mock.calls.map((c) => c[0]).join('\n'));
    expect(out.count).toBe(3);
    expect(out.objectives.map((o: { slug: string }) => o.slug)).toContain('mrr');
  });
});

describe('the top-level rule (shared with the Tasks board)', () => {
  it('a child whose parent is open and a card is nested; otherwise it is its own card', () => {
    const tasks = [
      { slug: 'p', parent_task: null },
      { slug: 'c', parent_task: 'p' },
      { slug: 'orphan', parent_task: 'closed-parent' },
      { slug: 'grand', parent_task: 'c' },
      { slug: 'self', parent_task: 'self' },
    ];
    expect(topLevelOf(tasks).map((t) => t.slug)).toEqual(['p', 'orphan', 'grand', 'self']);
  });
});

// ─── Scoring marker + payload ─────────────────────────────────────────────

describe('scoring marker and the priority payload', () => {
  it('start is a compare-and-set; suggest refreshes only an active marker; done clears it', async () => {
    expect(isScoringRunning(contextRoot)).toBe(false);
    touchScoring(contextRoot);
    expect(isScoringRunning(contextRoot)).toBe(false);
    const a = makeRes();
    const b = makeRes();
    await handleRoadmapScoringStart(getReq, a.res, {}, contextRoot);
    await handleRoadmapScoringStart(getReq, b.res, {}, contextRoot);
    expect([a.status(), b.status()]).toEqual([200, 409]);
    expect(b.body()).toMatchObject({ started: false, error: 'already_running' });
    expect(isScoringRunning(contextRoot, Date.now() + 11 * 60_000)).toBe(false);
    await cli('roadmap', 'unscored', '--done');
    expect(isScoringRunning(contextRoot)).toBe(false);
    expect(startScoring(contextRoot)).toBe(true);
    stopScoring(contextRoot);
  });

  it('GET /api/roadmap/priority: cards, effective links, marks, counts and the button from one payload', async () => {
    createObjective(contextRoot, { slug: 'mrr', title: 'MRR' });
    createObjective(contextRoot, { slug: 'old', title: 'Old' });
    updateObjective(contextRoot, 'old', { status: 'done' });
    writeTask('linked', { objectives: ['mrr'], rice: { reach: 5, impact: 4, confidence: 100, effort: 1 }, status: 'in_progress' });
    writeTask('dead', { objectives: ['old'] });
    writeTask('missing', { objectives: ['nope'] });
    writeTask('kid', { parent_task: 'linked' });
    writeTask('gone', { status: 'completed' });
    const r = makeRes();
    await handleRoadmapPriority(getReq, r.res, {}, contextRoot);
    const p = r.body();
    expect(p.tasks.map((t: any) => t.slug).sort()).toEqual(['dead', 'linked', 'missing']);
    const by = Object.fromEntries(p.tasks.map((t: any) => [t.slug, t]));
    expect(by.linked).toMatchObject({ links: ['mrr'], score: 20, status_kind: 'active', subtask_count: 1, mark: null });
    expect(by.dead).toMatchObject({ links: [], mark: 'objective done' });
    expect(by.missing).toMatchObject({ links: [], mark: 'objective missing' });
    expect(p.scoring).toEqual({ count: 3, pending: 0, running: false });
    expect(p.objectives.find((o: any) => o.slug === 'mrr')).toMatchObject({ score: null, effective_suggestion: null });
    expect(p.objectives[0].priority_suggestion).toBeUndefined();
  });
});

// ─── CLI agent guard ──────────────────────────────────────────────────────

describe('agent guard on owner values', () => {
  it('tasks rice and objective edit refuse to change an owner value from an agent session without --owner', async () => {
    writeTask('t', { rice: { reach: 5, impact: 5, confidence: 75, effort: 1 } });
    createObjective(contextRoot, { slug: 'mrr', title: 'MRR', impact: 5, effort: 4 });
    process.env.CLAUDE_CODE_SESSION_ID = 'agent-session';
    const taskBefore = rawOf('t');
    const objBefore = objRaw('mrr');

    await cli('tasks', 'rice', 't', '--reach', '9');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await cli('tasks', 'rice', 't', '--clear');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(rawOf('t')).toBe(taskBefore);

    await cli('roadmap', 'objective', 'edit', 'mrr', '--impact', '2');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(objRaw('mrr')).toBe(objBefore);

    // An empty field may be filled; --owner lets the owner's explicit change through.
    await cli('roadmap', 'objective', 'edit', 'mrr', '--reach', '7');
    expect(process.exitCode).toBeUndefined();
    expect(getObjective(contextRoot, 'mrr')!.reach).toBe(7);
    await cli('tasks', 'rice', 't', '--reach', '9', '--owner');
    expect(fmOf('t').rice.reach).toBe(9);
    await cli('roadmap', 'objective', 'edit', 'mrr', '--impact', '2', '--owner');
    expect(getObjective(contextRoot, 'mrr')!.impact).toBe(2);
  });
});

// ─── Review fixes ─────────────────────────────────────────────────────────

describe('an objective slug is validated before any lock file is touched (review: Critical)', () => {
  it('a ../ slug never creates or deletes a *.lock outside the vault', async () => {
    const { utimesSync, existsSync: exists, readdirSync } = await import('node:fs');
    const outside = join(projectRoot, 'yarn.lock');
    writeFileSync(outside, 'not json: a real lockfile\n');
    const old = new Date(Date.now() - 3600_000);
    utimesSync(outside, old, old);
    const evil = '../../../../yarn';
    expect(() => updateObjective(contextRoot, evil, { impact: 1 })).toThrow(/not found/);
    expect(() => acceptObjectiveSuggestion(contextRoot, evil, 'x', {}, [])).toThrow(/not found/);
    expect(() => suggestObjective(contextRoot, evil, { reach: 1, impact: 1, confidence: 25, effort: 1, why: 'w' }, [])).toThrow();
    expect(exists(outside)).toBe(true);
    expect(readFileSync(outside, 'utf-8')).toBe('not json: a real lockfile\n');
    expect(exists(join(projectRoot, 'anything'))).toBe(false);
    expect(() => updateObjective(contextRoot, '../../../../anything/deep/x', { impact: 1 })).toThrow(/not found/);
    expect(exists(join(projectRoot, 'anything'))).toBe(false);
    // The route refuses an encoded traversal before reading the body.
    const r = makeRes();
    await handleObjectiveSuggestionAccept(jsonReq({ at: 'x' }), r.res, { slug: evil }, contextRoot);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('invalid_path');
    expect(readdirSync(projectRoot)).toContain('yarn.lock');
  });
});

describe('a live no_objective verdict survives a RICE-only re-suggestion (review: Major)', () => {
  it('rice cleared after a verdict, re-scored RICE-only, accepted: the link side stays closed and N reaches 0', async () => {
    createObjective(contextRoot, { slug: 'mrr', title: 'MRR' });
    writeTask('t');
    const b = backend();
    const first = await b.suggestPriority('t', { reach: 3, impact: 2, confidence: 50, effort: 1, no_objective: true, why: 'w' }, live());
    const verdictAt = first.priority_suggestion!.at;
    await b.acceptSuggestion('t', verdictAt, {}, live());
    await cli('tasks', 'rice', 't', '--clear');
    const item = scoringWork(contextRoot).items.find((i) => i.slug === 't')!;
    expect(item).toMatchObject({ needs_link: false });
    await new Promise((r) => setTimeout(r, 2));
    const again = await b.suggestPriority('t', { reach: 4, impact: 2, confidence: 50, effort: 1, why: 'rescored' }, live());
    expect(again.priority_suggestion).toMatchObject({ no_objective: true, verdict_at: verdictAt, reach: 4 });
    await b.acceptSuggestion('t', again.priority_suggestion!.at, {}, live());
    expect(fmOf('t').priority_suggestion).toMatchObject({ no_objective: true, verdict_at: verdictAt });
    expect(scoringWork(contextRoot).items.map((i) => i.slug)).not.toContain('t');
  });

  it('a carried verdict keeps its original day: an objective created after it still reopens the question', () => {
    const objs = [{ slug: 'new', done: false, created_at: '2026-11-02' }];
    const carried = { at: '2026-11-05T00:00:00.000Z-c', verdict_at: '2026-11-01T00:00:00.000Z-v', no_objective: true, dismissed_at: null, accepted_at: null };
    expect(hasLiveVerdict(carried, objs)).toBe(false);
  });
});
