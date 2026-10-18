/**
 * The Proposals section's API (C4) and the feedback helpers it draws from.
 *
 * The dashboard is the owner's path: accept/reject/keep go through without the
 * agent-environment check (E9), the list carries everything the section draws
 * (proposals with their suggested parent, sleep-filed tasks, the brake, the
 * weekly trend, the reason chips), and bad input is refused with a 4xx.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleFiledTaskKeep,
  handleFiledTaskReject,
  handleTaskProposalAccept,
  handleTaskProposalReject,
  handleTaskProposalsCount,
  handleTaskProposalsList,
} from '../../src/server/routes/task-proposals.js';
import { addProposal, readProposals, recordFiled } from '../../src/lib/task-proposals.js';
import {
  DUPLICATE_MAX_TIGHTENING,
  kindBlock,
  readFeedback,
  tightenedReviewThreshold,
  weeklyAcceptance,
  type TaskFeedbackEntry,
} from '../../src/lib/task-feedback.js';

let projectRoot: string;
let root: string;
let stateDir: string;
const WHY = 'The board forgets the owner\'s filter on every visit, so it is re-applied by hand.';

beforeEach(() => {
  const raw = join(tmpdir(), `dc-proute-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  root = join(projectRoot, '_dream_context');
  stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, 'overrides'), { recursive: true });
  writeFileSync(join(root, 'overrides', 'task.md'), [
    '---', 'statuses:', '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }', '---', '',
  ].join('\n'));
  writeFileSync(join(stateDir, 'board-epic.md'), '---\nname: Board epic\nstatus: in_progress\n---\n\n## Why\n\nBoard.\n');
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
  await h(req(body), res, params, root);
  return { code, json: out ? JSON.parse(out) : {} };
}

describe('GET /api/task-proposals', () => {
  it('draws proposals with their suggested parent, sleep-filed tasks, the brake, the trend and the chips', async () => {
    addProposal(root, { name: 'Remember the filter', why: WHY, quote: 'remember my filter', basis: 'discussion', parent: 'board-epic' });
    writeFileSync(join(stateDir, 'filed-one.md'), '---\nname: Filed one\nstatus: todo\n---\n');
    recordFiled(root, { slug: 'filed-one', name: 'Filed one', why: WHY, quote: 'q q q q', basis: 'ask', parent: null });
    recordFiled(root, { slug: 'gone-away', name: 'Gone', why: WHY, quote: 'q q q q', basis: 'ask', parent: null });
    const { code, json } = await call(handleTaskProposalsList);
    expect(code).toBe(200);
    // 'gone-away' left the board: neither listed nor counted, so the badge can clear.
    expect(json.waiting).toBe(2);
    expect((json.proposals as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'Remember the filter', parentName: 'Board epic' });
    expect((json.filed as Array<Record<string, unknown>>).map((f) => f.slug)).toEqual(['filed-one']);
    expect(json.brake).toMatchObject({ open: true });
    expect((json.trend as unknown[]).length).toBe(8);
    expect((json.reasons as Array<{ key: string }>).map((r) => r.key)).toContain('too-small');
    expect((await call(handleTaskProposalsCount)).json).toEqual({ waiting: 2 });
    expect((json.proposals as unknown[]).length + (json.filed as unknown[]).length).toBe(2);
  });
});

describe('the owner\'s decisions', () => {
  it('accept with an edited Why and the suggested parent → a child in Next; the diff is feedback', async () => {
    const p = addProposal(root, { name: 'Remember the filter', why: WHY, quote: 'remember my filter', basis: 'discussion', parent: 'board-epic' });
    const { code, json } = await call(handleTaskProposalAccept, { id: p.id }, { why: `${WHY} Measured: 9 times a day.` });
    expect(code).toBe(200);
    expect(json).toMatchObject({ slug: 'remember-the-filter', parent: 'board-epic' });
    const card = readFileSync(join(stateDir, 'remember-the-filter.md'), 'utf-8');
    expect(card).toMatch(/^parent_task: board-epic$/m);
    expect(card).toMatch(/^queue: next$/m);
    expect(readFeedback(root)[0].diff?.why?.to).toContain('9 times a day');
    expect((await call(handleTaskProposalAccept, { id: p.id }, {})).code).toBe(409);
  });

  it('accept with parent:null files it top-level', async () => {
    const p = addProposal(root, { name: 'Remember the filter', why: WHY, quote: 'remember my filter', basis: 'discussion', parent: 'board-epic' });
    const { json } = await call(handleTaskProposalAccept, { id: p.id }, { parent: null });
    expect(json.parent).toBeNull();
  });

  it('reject needs a known reason; filed tasks reject to cancelled and keep', async () => {
    const p = addProposal(root, { name: 'Remember the filter', why: WHY, quote: 'remember my filter', basis: 'discussion' });
    expect((await call(handleTaskProposalReject, { id: p.id }, { reason: 'meh' })).code).toBe(400);
    expect((await call(handleTaskProposalReject, { id: p.id }, { reason: 'wrong-project', note: 'tilki' })).code).toBe(200);
    expect(readFeedback(root)[0]).toMatchObject({ reason: 'wrong-project', note: 'tilki' });

    writeFileSync(join(stateDir, 'filed-one.md'), '---\nname: Filed one\nstatus: todo\n---\n');
    recordFiled(root, { slug: 'filed-one', name: 'Filed one', why: WHY, quote: 'q q q q', basis: 'ask', parent: null });
    expect((await call(handleFiledTaskReject, { slug: 'filed-one' }, { reason: 'not-work' })).code).toBe(200);
    expect(readFileSync(join(stateDir, 'filed-one.md'), 'utf-8')).toMatch(/^status: cancelled$/m);

    recordFiled(root, { slug: 'filed-two', name: 'Filed two', why: WHY, quote: 'q q q q', basis: 'ask', parent: null });
    expect((await call(handleFiledTaskKeep, { slug: 'filed-two' })).code).toBe(200);
    expect(readProposals(root).filed.find((f) => f.slug === 'filed-two')!.outcome).toBe('kept');
  });

  it('refuses unsafe ids and slugs', async () => {
    expect((await call(handleTaskProposalAccept, { id: '../etc' }, {})).code).toBe(400);
    expect((await call(handleFiledTaskKeep, { slug: '../x' })).code).toBe(400);
    expect((await call(handleTaskProposalReject, { id: 'tp_missing00' }, { reason: 'too-small' })).code).toBe(404);
  });
});

describe('feedback helpers', () => {
  const e = (over: Partial<TaskFeedbackEntry>): TaskFeedbackEntry => ({
    id: 'x', at: new Date().toISOString(), source: 'proposal', verdict: 'reject',
    proposal: { name: 'n', why: 'w' }, basis: 'discussion', quote: 'q', ...over,
  });

  it('tightening is capped and ignores the eval set', () => {
    const many = Array.from({ length: 20 }, () => e({ reason: 'already-exists' }));
    expect(tightenedReviewThreshold(many, 0.91).threshold).toBe(Number((0.91 - DUPLICATE_MAX_TIGHTENING).toFixed(4)));
    expect(tightenedReviewThreshold([e({ reason: 'already-exists', source: 'sleep-eval' })], 0.91).threshold).toBe(0.91);
  });

  it('a kind block names the reason most of its rejects carry', () => {
    const text = { name: 'Document the export flag', why: 'The export flag is undocumented in the README.' };
    const rejects = [
      e({ reason: 'too-small', proposal: text }),
      e({ reason: 'not-work', proposal: text }),
      e({ reason: 'too-small', proposal: text }),
    ];
    expect(kindBlock(rejects, text)?.reason).toBe('too-small');
  });

  it('the weekly trend counts keeps and rejects per ISO week', () => {
    const now = new Date('2026-10-17T12:00:00Z'); // a Saturday
    const trend = weeklyAcceptance([
      e({ verdict: 'keep', at: '2026-10-13T10:00:00Z' }),
      e({ verdict: 'reject', at: '2026-10-14T10:00:00Z' }),
      e({ verdict: 'keep', at: '2026-10-06T10:00:00Z' }),
    ], 2, now);
    expect(trend).toEqual([
      { week: '2026-10-05', kept: 1, rejected: 0, rate: 1 },
      { week: '2026-10-12', kept: 1, rejected: 1, rate: 0.5 },
    ]);
  });
});
