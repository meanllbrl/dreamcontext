import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import matter from 'gray-matter';
import {
  handleTasksCreate,
  handleTasksGet,
  handleTasksList,
  handleTasksObjection,
  handleTasksReadiness,
  handleTasksUpdate,
} from '../../src/server/routes/tasks.js';
import { OBJECTIONS_REL_PATH } from '../../src/lib/task-objection.js';

/**
 * The task routes' side of filing and objections: POST stamps `filed_by` the way
 * lib/filing-basis.ts decides (a request with no `by` is the owner even mid-cycle), the parent
 * link rides the create, PATCH refuses to complete a parent with open sub-tasks (409) and only
 * validates a parent that changes, every task read carries `filed_by`, `filing_basis` and
 * `objection`, and `POST /api/tasks/:slug/objection` is the objection engine over HTTP.
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

function jsonReq(method: string, body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (stream as { method?: string }).method = method;
  (stream as { headers?: Record<string, string> }).headers = { 'content-type': 'application/json' };
  return stream;
}

const getReq = { method: 'GET', headers: {} } as unknown as IncomingMessage;

let projectRoot: string;
let ctx: string;
let prevAuto: string | undefined;
let prevSemantic: string | undefined;

function writeTask(slug: string, fm: Record<string, unknown>, body = '## Why\nBecause.\n\n## Changelog\n'): void {
  const front = { name: slug, status: 'todo', priority: 'medium', urgency: 'medium', parent_task: null, related_feature: null, version: null, ...fm };
  writeFileSync(join(ctx, 'state', `${slug}.md`), matter.stringify(body, front), 'utf-8');
}

function fmOf(slug: string): Record<string, unknown> {
  return matter(readFileSync(join(ctx, 'state', `${slug}.md`), 'utf-8')).data;
}

async function call(
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>,
  params: Record<string, string>,
  body?: unknown,
  method = 'POST',
): Promise<{ status: number; body: any }> {
  const r = makeRes();
  await handler(body === undefined ? getReq : jsonReq(method, body), r.res, params, ctx);
  return { status: r.status(), body: r.body() };
}

beforeEach(() => {
  const raw = join(tmpdir(), `trf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  mkdirSync(join(ctx, 'overrides'), { recursive: true });
  writeFileSync(join(ctx, 'overrides', 'task.md'), '---\nstatuses:\n  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }\n---\n', 'utf-8');
  writeTask('parent', { name: 'Parent Task' });
  writeTask('closed', { name: 'Closed', status: 'completed' });
  writeTask('kid', { name: 'Kid', parent_task: 'parent' });
  writeTask('sleepy', { name: 'Sleepy', filed_by: 'sleep', filing_basis: { kind: 'ask', quote: 'the owner asked for this', at: '2026-10-23', verified: true } });
  prevAuto = process.env.DREAMCONTEXT_AUTO_SLEEP;
  prevSemantic = process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC;
  delete process.env.DREAMCONTEXT_AUTO_SLEEP;
  process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC = '0';
});

afterEach(() => {
  if (prevAuto === undefined) delete process.env.DREAMCONTEXT_AUTO_SLEEP; else process.env.DREAMCONTEXT_AUTO_SLEEP = prevAuto;
  if (prevSemantic === undefined) delete process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC; else process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC = prevSemantic;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('POST /api/tasks — filed_by on every path', () => {
  it('no `by` is the owner even while a sleep cycle is live', async () => {
    process.env.DREAMCONTEXT_AUTO_SLEEP = '1';
    const r = await call(handleTasksCreate, {}, { name: 'Owner Form', why: 'x' });
    expect(r.status).toBe(201);
    expect(r.body.task).toMatchObject({ filed_by: 'human', filing_basis: null });
    expect(fmOf('owner-form').filed_by).toBe('human');
  });

  it('by sleep with no basis on a top-level task is a 400', async () => {
    process.env.DREAMCONTEXT_AUTO_SLEEP = '1';
    const r = await call(handleTasksCreate, {}, { name: 'Sleep Idea', why: 'A reason long enough to pass the why floor of the bar.', by: 'sleep' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('basis_required');
  });

  it('by agent with no basis records an agent and a derived note', async () => {
    const r = await call(handleTasksCreate, {}, { name: 'Agent Thing', why: 'Opened by an agent', by: 'agent' });
    expect(r.status).toBe(201);
    expect(r.body.task).toMatchObject({ filed_by: 'agent', filing_basis: { kind: 'note', quote: 'Opened by an agent' } });
  });

  it('a sub-task is created with its link in the same write; a closed parent is refused', async () => {
    const r = await call(handleTasksCreate, {}, { name: 'Sub One', parent_task: 'parent' });
    expect(r.status).toBe(201);
    expect(fmOf('sub-one')).toMatchObject({ parent_task: 'parent', filed_by: 'human' });
    const closed = await call(handleTasksCreate, {}, { name: 'Sub Two', parent_task: 'closed' });
    expect(closed.status).toBe(400);
    expect(closed.body.error).toBe('parent_closed');
  });
});

describe('PATCH /api/tasks/:slug — the close gate and the parent check', () => {
  it('a parent with an open sub-task cannot complete (409, names it); a cancelled one never blocks', async () => {
    const r = await call(handleTasksUpdate, { slug: 'parent' }, { status: 'completed' }, 'PATCH');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('parent_has_open_children');
    expect(r.body.message).toContain('kid');
    expect(fmOf('parent').status).toBe('todo');
    await call(handleTasksUpdate, { slug: 'kid' }, { status: 'cancelled' }, 'PATCH');
    expect((await call(handleTasksUpdate, { slug: 'parent' }, { status: 'completed' }, 'PATCH')).status).toBe(200);
  });

  it('re-sending the parent a sub-task already has is not validated again', async () => {
    writeTask('under-closed', { name: 'Under Closed', parent_task: 'closed' });
    const r = await call(handleTasksUpdate, { slug: 'under-closed' }, { parent_task: 'closed', priority: 'high' }, 'PATCH');
    expect(r.status).toBe(200);
    const moved = await call(handleTasksUpdate, { slug: 'sleepy' }, { parent_task: 'closed' }, 'PATCH');
    expect(moved.status).toBe(400);
    expect(moved.body.error).toBe('parent_closed');
  });
});

describe('reads and the objection route', () => {
  it('GET list and GET one carry filed_by, filing_basis and objection', async () => {
    const list = await call(handleTasksList, {});
    const sleepy = list.body.tasks.find((t: { slug: string }) => t.slug === 'sleepy');
    expect(sleepy).toMatchObject({ filed_by: 'sleep', filing_basis: { kind: 'ask' }, objection: null });
    const one = await call(handleTasksGet, { slug: 'kid' });
    expect(one.body.task).toMatchObject({ filed_by: null, filing_basis: null, objection: null });
  });

  it('POST objection applies it, the task reads its box, and the same POST again is a 200', async () => {
    const r = await call(handleTasksObjection, { slug: 'sleepy' }, { as: 'criterion-on', target: 'parent', note: 'Bu Parent Task görevinin bir adımıydı.' });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('applied');
    expect(r.body.task.status).toBe('cancelled');
    expect(r.body.task.objection).toMatchObject({ as: 'criterion-on', target: 'parent', targetName: 'Parent Task', pending: false, rule: null });
    const again = await call(handleTasksObjection, { slug: 'sleepy' }, { as: 'criterion-on', target: 'parent', note: 'Bu Parent Task görevinin bir adımıydı.' });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('already_applied');
    const got = await call(handleTasksGet, { slug: 'sleepy' });
    expect(got.body.task.objection.id).toBe(r.body.task.objection.id);
  });

  it('refusals come back with their status and code; a broken ledger is a 500 and stays as it was', async () => {
    expect((await call(handleTasksObjection, { slug: 'sleepy' }, { as: 'not-a-task', note: 'short' })).body.error).toBe('note_too_short');
    expect((await call(handleTasksObjection, { slug: 'sleepy' }, { as: 'subtask-of', target: '../x', note: 'a note that is long enough' })).status).toBe(400);
    const parentObj = await call(handleTasksObjection, { slug: 'parent' }, { as: 'not-a-task', note: 'a note that is long enough' });
    expect(parentObj.status).toBe(409);
    expect(parentObj.body.error).toBe('has_open_children');
    writeFileSync(join(ctx, OBJECTIONS_REL_PATH), '[{', 'utf-8');
    const broken = await call(handleTasksObjection, { slug: 'sleepy' }, { as: 'not-a-task', note: 'a note that is long enough' });
    expect(broken.status).toBe(500);
    expect(readFileSync(join(ctx, OBJECTIONS_REL_PATH), 'utf-8')).toBe('[{');
    // and the board still loads
    expect((await call(handleTasksList, {})).status).toBe(200);
  });

  it('readiness returns notes for a wave map with no wave sub-tasks, never as a gap', async () => {
    writeTask('planned', { name: 'Planned' }, '## Why\nx\n\n## Acceptance Criteria\n\n- [ ] a\n- [ ] Validation method: tests\n\n## Technical Details\n\nWAVE MAP: EXECUTION: lead | W1 (src/a.ts) | W2 (src/b.ts)\n');
    const r = await call(handleTasksReadiness, { slug: 'planned' });
    expect(r.body.ready).toBe(true);
    expect(r.body.gaps).toEqual([]);
    expect(r.body.notes[0]).toMatch(/no wave sub-tasks exist yet/);
  });
});
