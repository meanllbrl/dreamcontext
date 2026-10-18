/**
 * The task migration's uncertain changes on the Tasks screen (Proposals
 * section): the agent keeps the task and suggests; the owner applies or keeps
 * it as is. They ride the section's list and badge but never touch sleep's
 * proposal store, its brake or its feedback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  applySuggestion,
  backlogDecisionsPending,
  backlogReport,
  decideTask,
  keepAsIs,
  readBacklogStore,
  runBacklogStep,
  suggestChange,
  waitingSuggestions,
} from '../../src/lib/backlog-migration.js';
import {
  handleTaskChangeApply,
  handleTaskChangeKeep,
  handleTaskProposalsCount,
  handleTaskProposalsList,
} from '../../src/server/routes/task-proposals.js';
import { PROPOSALS_REL_PATH } from '../../src/lib/task-proposals.js';
import { readFrontmatter } from '../../src/lib/frontmatter.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';

let projectRoot: string;
let ctx: string;
let stateDir: string;

function card(slug: string, extra: string[] = []): void {
  writeFileSync(join(stateDir, `${slug}.md`), [
    '---', `id: task_${slug}`, `name: ${slug.replace(/-/g, ' ')}`, `description: ${slug}`, 'status: todo',
    "created_at: '2026-09-01'", ...extra, '---', '', '## Why', '', 'Because.', '',
  ].join('\n'));
}
const fm = (slug: string) => readFrontmatter<Record<string, unknown>>(join(stateDir, `${slug}.md`)).data;
const backend = () => new LocalTaskBackend(stateDir);

beforeEach(() => {
  const raw = join(tmpdir(), `dc-bsug-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  stateDir = join(ctx, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(ctx, 'overrides'), { recursive: true });
  writeFileSync(join(ctx, 'overrides', 'task.md'), [
    '---', 'statuses:', '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }', '---', '',
  ].join('\n'));
  card('export-csv');
  card('maybe-dup-of-csv');
  card('export-epic');
  card('half-dead');
  card('someday');
  runBacklogStep(ctx);
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

function req(body?: unknown): IncomingMessage {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(r, { method: 'POST', headers: { 'content-type': 'application/json' } });
  return r;
}
type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: string) => Promise<void>;
async function call(h: Handler, params: Record<string, string> = {}, body?: unknown): Promise<{ code: number; json: Record<string, unknown> }> {
  let code = 0;
  let out = '';
  const res = {
    writeHead(c: number) { code = c; return res; },
    end(d?: string) { out = d ?? ''; return res; },
    setHeader() { return res; },
  } as unknown as ServerResponse;
  await h(req(body), res, params, ctx);
  return { code, json: out ? JSON.parse(out) : {} };
}

describe('suggesting', () => {
  it('keeps the task as it is, ends its wait, and puts the change on the Tasks screen', async () => {
    const rec = await suggestChange(ctx, backend(), 'maybe-dup-of-csv', { change: 'merge', target: 'export-csv', why: 'Both export CSV.', by: 'agent' });
    expect(rec).toMatchObject({ outcome: 'keep', by: 'agent' });
    expect(rec.suggestion).toMatchObject({ change: 'merge', target: 'export-csv' });
    expect(fm('maybe-dup-of-csv').status).toBe('todo');
    const rows = waitingSuggestions(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'maybe-dup-of-csv', change: 'merge', targetName: 'export csv', why: 'Both export CSV.' });
    expect(backlogReport(ctx).proposalsWaiting).toBe(1);
  });

  it('is checked up front, so that applying it later can work', async () => {
    await expect(suggestChange(ctx, backend(), 'someday', { change: 'merge', target: 'someday', why: 'x', by: 'agent' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(suggestChange(ctx, backend(), 'someday', { change: 'merge', target: 'nope', why: 'x', by: 'agent' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(suggestChange(ctx, backend(), 'someday', { change: 'parent', why: 'x', by: 'agent' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(suggestChange(ctx, backend(), 'someday', { change: 'later', why: '  ', by: 'agent' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await decideTask(ctx, backend(), 'export-csv', { outcome: 'keep', by: 'agent', parent: 'export-epic' });
    await expect(suggestChange(ctx, backend(), 'export-epic', { change: 'cancel', why: 'x', by: 'agent' }))
      .rejects.toMatchObject({ code: 'has_children' });
  });

  it('never touches sleep\'s proposal store (its brake and feedback stay clean)', async () => {
    await suggestChange(ctx, backend(), 'someday', { change: 'later', why: 'Parked for a year.', by: 'agent' });
    expect(existsSync(join(ctx, PROPOSALS_REL_PATH))).toBe(false);
  });
});

describe('the owner answers', () => {
  it('apply: a merge goes through the decision path (cancelled + absorbed_by), recorded as the owner\'s', async () => {
    const { suggestion } = await suggestChange(ctx, backend(), 'maybe-dup-of-csv', { change: 'merge', target: 'export-csv', why: 'Both export CSV.', by: 'agent' });
    const rec = await applySuggestion(ctx, backend(), 'maybe-dup-of-csv', suggestion!.id);
    expect(rec).toMatchObject({ outcome: 'merge', by: 'owner', into: 'export-csv' });
    expect(rec.suggestion?.resolved?.verdict).toBe('applied');
    expect(fm('maybe-dup-of-csv')).toMatchObject({ status: 'cancelled', absorbed_by: 'export-csv' });
    expect(existsSync(join(stateDir, 'maybe-dup-of-csv.md'))).toBe(true);
    expect(waitingSuggestions(ctx)).toEqual([]);
  });

  it('apply: under a parent, and to Later', async () => {
    const a = await suggestChange(ctx, backend(), 'export-csv', { change: 'parent', target: 'export-epic', why: 'A step of it.', by: 'agent' });
    await applySuggestion(ctx, backend(), 'export-csv', a.suggestion!.id);
    expect(fm('export-csv').parent_task).toBe('export-epic');
    const b = await suggestChange(ctx, backend(), 'someday', { change: 'later', why: 'Parked.', by: 'agent' });
    await applySuggestion(ctx, backend(), 'someday', b.suggestion!.id);
    expect(fm('someday').queue).toBe('later');
  });

  it('a feature: checked up front (exists, not a step, not already there), applied as the owner\'s move', async () => {
    const dir = join(ctx, 'knowledge', 'features');
    mkdirSync(dir, { recursive: true });
    for (const f of ['exports', 'agents']) writeFileSync(join(dir, `${f}.md`), ['---', `name: ${f}`, 'type: feature', 'related_tasks: []', '---', ''].join('\n'));
    await expect(suggestChange(ctx, backend(), 'export-csv', { change: 'feature', target: 'no-such-area', why: 'x', by: 'agent' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(suggestChange(ctx, backend(), 'export-csv', { change: 'feature', why: 'x', by: 'agent' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await decideTask(ctx, backend(), 'export-csv', { outcome: 'keep', by: 'owner', parent: 'export-epic' });
    await expect(suggestChange(ctx, backend(), 'export-csv', { change: 'feature', target: 'exports', why: 'x', by: 'owner' }))
      .rejects.toMatchObject({ code: 'invalid' });
    const { suggestion } = await suggestChange(ctx, backend(), 'half-dead', { change: 'feature', target: 'expo', why: 'It is about exports.', by: 'agent' });
    expect(suggestion).toMatchObject({ change: 'feature', target: 'exports' });
    expect(waitingSuggestions(ctx)).toEqual([expect.objectContaining({ slug: 'half-dead', change: 'feature', target: 'exports', targetName: 'exports' })]);
    const rec = await applySuggestion(ctx, backend(), 'half-dead', suggestion!.id);
    expect(rec).toMatchObject({ outcome: 'keep', by: 'owner' });
    expect(fm('half-dead').related_feature).toBe('exports');
    expect(rec.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'related_feature', before: null, after: 'exports', by: 'owner' })]));
  });

  it('keep as is: nothing on the card changes, the decision becomes the owner\'s, an agent cannot overrule it', async () => {
    const { suggestion } = await suggestChange(ctx, backend(), 'half-dead', { change: 'cancel', why: 'Looks abandoned.', by: 'agent' });
    const before = fm('half-dead');
    const rec = keepAsIs(ctx, 'half-dead', suggestion!.id);
    expect(rec).toMatchObject({ outcome: 'keep', by: 'owner' });
    expect(rec.suggestion?.resolved?.verdict).toBe('kept');
    expect(fm('half-dead')).toEqual(before);
    await expect(decideTask(ctx, backend(), 'half-dead', { outcome: 'cancel', by: 'agent', reason: 'x' }))
      .rejects.toMatchObject({ code: 'decided' });
  });

  it('a stale card (an answered or replaced suggestion) refuses', async () => {
    const first = await suggestChange(ctx, backend(), 'someday', { change: 'later', why: 'Parked.', by: 'agent' });
    const second = await suggestChange(ctx, backend(), 'someday', { change: 'cancel', why: 'Dead.', by: 'agent' });
    expect(() => keepAsIs(ctx, 'someday', first.suggestion!.id)).toThrow(/no longer the current one/);
    keepAsIs(ctx, 'someday', second.suggestion!.id);
    await expect(applySuggestion(ctx, backend(), 'someday', second.suggestion!.id)).rejects.toMatchObject({ code: 'stale' });
  });

  it('a suggestion about a task that closed meanwhile is not shown', async () => {
    await suggestChange(ctx, backend(), 'someday', { change: 'later', why: 'Parked.', by: 'agent' });
    await backend().updateFields('someday', { status: 'completed' });
    expect(waitingSuggestions(ctx)).toEqual([]);
  });

  it('suggesting ends the agent\'s part for that task (the agent task can finish while the owner decides)', async () => {
    const store = readBacklogStore(ctx)!;
    for (const slug of Object.keys(store.tasks)) {
      if (slug === 'someday') await suggestChange(ctx, backend(), slug, { change: 'later', why: 'Parked.', by: 'agent' });
      else await decideTask(ctx, backend(), slug, { outcome: 'keep', by: 'agent' });
    }
    expect(backlogDecisionsPending(ctx)).toBe(false);
    expect(waitingSuggestions(ctx)).toHaveLength(1);
  });
});

describe('the Proposals routes', () => {
  it('the list and the badge count the suggestions; apply and keep answer them; bad input is refused', async () => {
    const a = await suggestChange(ctx, backend(), 'maybe-dup-of-csv', { change: 'merge', target: 'export-csv', why: 'Same.', by: 'agent' });
    const b = await suggestChange(ctx, backend(), 'someday', { change: 'later', why: 'Parked.', by: 'agent' });

    const list = await call(handleTaskProposalsList);
    expect(list.code).toBe(200);
    expect(list.json.waiting).toBe(2);
    expect((list.json.changes as unknown[]).length).toBe(2);
    expect((await call(handleTaskProposalsCount)).json.waiting).toBe(2);

    expect((await call(handleTaskChangeApply, { slug: '../x' }, { id: a.suggestion!.id })).code).toBe(400);
    expect((await call(handleTaskChangeApply, { slug: 'maybe-dup-of-csv' }, {})).code).toBe(400);
    expect((await call(handleTaskChangeApply, { slug: 'maybe-dup-of-csv' }, { id: 'bs_notit' })).code).toBe(409);

    const applied = await call(handleTaskChangeApply, { slug: 'maybe-dup-of-csv' }, { id: a.suggestion!.id });
    expect(applied.code).toBe(200);
    expect(applied.json).toMatchObject({ outcome: 'merge', into: 'export-csv' });
    expect(fm('maybe-dup-of-csv').status).toBe('cancelled');

    const kept = await call(handleTaskChangeKeep, { slug: 'someday' }, { id: b.suggestion!.id });
    expect(kept.code).toBe(200);
    expect(fm('someday').queue).toBe('next');

    expect((await call(handleTaskProposalsCount)).json.waiting).toBe(0);
  });
});
