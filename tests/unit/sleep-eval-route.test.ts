import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSleepEvalLabelsGet, handleSleepEvalLabelsPost } from '../../src/server/routes/sleep-eval.js';
import { writeRound } from '../../src/lib/sleep-eval/fixtures.js';
import { readLabels } from '../../src/lib/sleep-eval/labels.js';

// The labelling deck's API on a fictional brain ("Larkspur", a recipe app).

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function post(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

let dir: string;
let ctx: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sleep-eval-route-'));
  ctx = join(dir, '_dream_context');
  mkdirSync(join(ctx, 'tmp', 'sleep-eval'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(): void {
  writeFileSync(join(ctx, 'tmp', 'sleep-eval', 'set.json'), JSON.stringify({ version: 1, createdAt: '2026-05-03T00:00:00Z', source: ctx, rounds: ['r1'], scoring: { matchThreshold: 0.86, duplicateThreshold: 0.92, gateTolerance: 0.05 } }));
  writeRound(ctx, {
    id: 'r1', consolidatedAt: '2026-05-02T20:00:00Z', previousAt: null, summary: '', board: [], sessions: [],
    opened: [{ id: 'r1:opened:1', round: 'r1', category: 'opened', name: 'Recipe photos survive import', why: 'Owners re-attach photos', quote: '', slug: 'recipe-photos', basis: 'unknown' }],
    candidates: [
      { id: 'r1:abandoned:1', round: 'r1', category: 'abandoned', name: 'Meal planner', why: '', quote: 'let us drop the planner', basis: 'discussion' },
      { id: 'r1:sub-detail:1', round: 'r1', category: 'sub-detail', name: 'Pantry sorts by expiry', why: '', quote: 'sort the pantry by expiry', parent: 'pantry-view', basis: 'ask' },
      { id: 'r1:style-correction:1', round: 'r1', category: 'style-correction', name: 'Say it plainly', why: '', quote: 'plain words please', basis: 'discussion' },
    ],
  });
  mkdirSync(join(ctx, 'tmp', 'sleep-eval', 'board'), { recursive: true });
  writeFileSync(join(ctx, 'tmp', 'sleep-eval', 'board', 'pantry-view.md'), '---\nname: Pantry view\n---\n');
}

describe('sleep-eval labels route', () => {
  it('reports inactive when no test set exists', async () => {
    const r = makeRes();
    await handleSleepEvalLabelsGet({} as IncomingMessage, r.res, {}, ctx);
    expect(r.status()).toBe(200);
    expect(r.body()).toMatchObject({ active: false, total: 0, pending: [] });
  });

  it('lists pending cards and records a verdict; a reject of an opened task needs a reason', async () => {
    seed();
    const g = makeRes();
    await handleSleepEvalLabelsGet({} as IncomingMessage, g.res, {}, ctx);
    expect(g.body()).toMatchObject({ active: true, total: 4, labelled: 0 });
    expect(g.body().pending.map((p: { id: string }) => p.id)).toEqual(['r1:opened:1', 'r1:abandoned:1', 'r1:sub-detail:1', 'r1:style-correction:1']);
    expect(g.body().reasons).toContain('already-exists');

    const bad = makeRes();
    await handleSleepEvalLabelsPost(post({ id: 'r1:opened:1', verdict: 'reject' }), bad.res, {}, ctx);
    expect(bad.status()).toBe(400);

    const ok = makeRes();
    await handleSleepEvalLabelsPost(post({ id: 'r1:opened:1', verdict: 'reject', reason: 'too-small', note: 'a criterion, not a task' }), ok.res, {}, ctx);
    expect(ok.status()).toBe(200);
    expect(ok.body()).toMatchObject({ labelled: 1, total: 4 });

    const cand = makeRes();
    await handleSleepEvalLabelsPost(post({ id: 'r1:abandoned:1', verdict: 'keep' }), cand.res, {}, ctx);
    expect(cand.body()).toMatchObject({ labelled: 2 });

    // An outcome answer: "nothing" needs a reason; the card's parent comes back as a NAME.
    const noReason = makeRes();
    await handleSleepEvalLabelsPost(post({ id: 'r1:sub-detail:1', outcome: 'nothing' }), noReason.res, {}, ctx);
    expect(noReason.status()).toBe(400);
    const g2 = makeRes();
    await handleSleepEvalLabelsGet({} as IncomingMessage, g2.res, {}, ctx);
    expect(g2.body().pending.find((p: { id: string }) => p.id === 'r1:sub-detail:1')).toMatchObject({ parent: 'pantry-view', parentName: 'Pantry view' });
    const into = makeRes();
    await handleSleepEvalLabelsPost(post({ id: 'r1:sub-detail:1', outcome: 'add-to-task' }), into.res, {}, ctx);
    expect(into.status()).toBe(200);
    const rule = makeRes();
    await handleSleepEvalLabelsPost(post({ id: 'r1:style-correction:1', outcome: 'new-task' }), rule.res, {}, ctx);
    expect(rule.status()).toBe(400);

    const unknown = makeRes();
    await handleSleepEvalLabelsPost(post({ id: 'nope', verdict: 'keep' }), unknown.res, {}, ctx);
    expect(unknown.status()).toBe(400);

    expect(readLabels(ctx).map((l) => [l.id, l.verdict, l.outcome ?? null, l.reason, l.note ?? null])).toEqual([
      ['r1:opened:1', 'reject', null, 'too-small', 'a criterion, not a task'],
      ['r1:abandoned:1', 'keep', null, null, null],
      ['r1:sub-detail:1', 'keep', 'add-to-task', null, null],
    ]);
  });
});
