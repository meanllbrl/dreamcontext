import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { getTaskBackend } from '../../src/lib/task-backend/index.js';
import {
  OBJECTIONS_REL_PATH,
  currentObjection,
  objectToTask,
  objectionView,
  readObjectionsStrict,
  type ObjectionInput,
} from '../../src/lib/task-objection.js';
import { DECLINED_REL_PATH } from '../../src/lib/task-declined.js';
import { setRule, readRules } from '../../src/lib/task-filing-rules.js';

/**
 * "Object to this task" (lib/task-objection.ts): the five kinds, each step idempotent, a crash
 * between any two steps finished by calling again (one record, one criterion), two calls at once
 * (one record), and the refusals: a broken ledger is never overwritten, closed targets, a live
 * sleep cycle, a task with open sub-tasks.
 */

let projectRoot: string;
let ctx: string;
let prevAuto: string | undefined;

function writeTask(slug: string, fm: Record<string, unknown>, body = '## Why\nBecause.\n\n## Acceptance Criteria\n\n- [ ] existing\n\n## Changelog\n'): void {
  const front = { name: slug, status: 'todo', priority: 'medium', urgency: 'medium', parent_task: null, related_feature: null, version: null, ...fm };
  writeFileSync(join(ctx, 'state', `${slug}.md`), matter.stringify(body, front), 'utf-8');
}

function read(slug: string): { fm: Record<string, unknown>; body: string } {
  const p = matter(readFileSync(join(ctx, 'state', `${slug}.md`), 'utf-8'));
  return { fm: p.data, body: p.content };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const NOTE = 'Bu aslında X görevinin bir kriteriydi, ayrı görev değil.';

function obj(over: Partial<ObjectionInput>): ObjectionInput {
  return { task: 'sleep-made', as: 'criterion-on', target: 'real-work', note: NOTE, via: 'ui', ...over };
}

beforeEach(() => {
  const raw = join(tmpdir(), `obj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  mkdirSync(join(ctx, 'overrides'), { recursive: true });
  writeFileSync(join(ctx, 'overrides', 'task.md'), '---\nstatuses:\n  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }\n---\n', 'utf-8');
  writeTask('sleep-made', { name: 'Sleep Made This', filed_by: 'sleep', filing_basis: { kind: 'ask', quote: 'q', at: '2026-10-23', verified: true } });
  writeTask('real-work', { name: 'Real Work' });
  writeTask('closed-work', { name: 'Closed Work', status: 'completed' });
  writeTask('a-child', { name: 'A Child', parent_task: 'real-work' });
  prevAuto = process.env.DREAMCONTEXT_AUTO_SLEEP;
  delete process.env.DREAMCONTEXT_AUTO_SLEEP;
});

afterEach(() => {
  if (prevAuto !== undefined) process.env.DREAMCONTEXT_AUTO_SLEEP = prevAuto;
  rmSync(projectRoot, { recursive: true, force: true });
});

const backend = () => getTaskBackend(ctx);

describe('the five kinds', () => {
  it('criterion-on: a criterion on the target, a log line, the task cancelled, applied last', async () => {
    const r = await objectToTask(ctx, backend(), obj({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.steps).toEqual(['criterion', 'log', 'cancel']);
    expect(r.record.applied?.action).toBe('criterion-on');
    expect(r.record.snapshot.filed_by).toBe('sleep');
    expect(read('real-work').body).toContain(`- [ ] Sleep Made This (itiraz ${r.record.id})`);
    expect(read('sleep-made').fm.status).toBe('cancelled');
    expect(read('sleep-made').body).toContain(`itiraz ${r.record.id}`);
    expect(existsSync(join(ctx, 'state', 'sleep-made.md'))).toBe(true);
  });

  it('subtask-of: the parent link, the task stays open', async () => {
    const r = await objectToTask(ctx, backend(), obj({ as: 'subtask-of' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.steps).toEqual(['parent', 'log']);
    expect(read('sleep-made').fm.parent_task).toBe('real-work');
    expect(read('sleep-made').fm.status).toBe('todo');
  });

  it('duplicate-of: a log on the target, the task cancelled', async () => {
    const r = await objectToTask(ctx, backend(), obj({ as: 'duplicate-of' }));
    expect(r.ok).toBe(true);
    expect(read('real-work').body).toMatch(/itiraz obj_[A-Za-z0-9]+: «Sleep Made This»/);
    expect(read('sleep-made').fm.status).toBe('cancelled');
  });

  it('not-a-task and wrong-project: declined (no target), the task cancelled', async () => {
    const r = await objectToTask(ctx, backend(), obj({ as: 'not-a-task', target: 'real-work' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.target).toBeNull();
    const declined = JSON.parse(readFileSync(join(ctx, DECLINED_REL_PATH), 'utf-8'));
    expect(declined[0]).toMatchObject({ key: 'sleep-made-this', topic: 'Sleep Made This' });
    writeTask('other-proj', { name: 'Other Project Thing' });
    const w = await objectToTask(ctx, backend(), obj({ task: 'other-proj', as: 'wrong-project', target: null }));
    expect(w.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(ctx, DECLINED_REL_PATH), 'utf-8'))[0].reason).toMatch(/Another project/);
  });
});

describe('crash between steps, then the same call again', () => {
  for (const crashAfter of ['criterion', 'log', 'cancel']) {
    it(`crash after ${crashAfter}: one record, one criterion, one log line`, async () => {
      const first = await objectToTask(ctx, backend(), obj({}), { crashAfter });
      expect(first.ok).toBe(false);
      const ledger1 = readObjectionsStrict(ctx);
      expect(ledger1).toHaveLength(1);
      expect(ledger1[0].applied).toBeNull();
      // After a crash on the LAST step the task is already cancelled: the retry must still finish.
      const again = await objectToTask(ctx, backend(), obj({}));
      expect(again.ok).toBe(true);
      const ledger = readObjectionsStrict(ctx);
      expect(ledger).toHaveLength(1);
      expect(ledger[0].applied).not.toBeNull();
      expect(count(read('real-work').body, ledger[0].id)).toBe(1);
      expect(count(read('sleep-made').body, `itiraz ${ledger[0].id}`)).toBe(1);
    });
  }

  it('an applied objection sent again answers with it (a double click is not an error)', async () => {
    const a = await objectToTask(ctx, backend(), obj({}));
    const b = await objectToTask(ctx, backend(), obj({}));
    expect(b).toMatchObject({ ok: true, outcome: 'already_applied' });
    if (a.ok && b.ok) expect(b.record.id).toBe(a.record.id);
  });

  it('two calls at once: one record, one criterion', async () => {
    const [a, b] = await Promise.all([
      objectToTask(ctx, backend(), obj({})),
      objectToTask(ctx, backend(), obj({})),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const ledger = readObjectionsStrict(ctx);
    expect(ledger).toHaveLength(1);
    expect(count(read('real-work').body, ledger[0].id)).toBe(1);
  });

  it('an unfinished objection of another kind blocks with objection_pending; resume finishes it', async () => {
    await objectToTask(ctx, backend(), obj({}), { crashAfter: 'criterion' });
    const other = await objectToTask(ctx, backend(), obj({ as: 'not-a-task' }));
    expect(other).toMatchObject({ ok: false, status: 409, code: 'objection_pending' });
    const id = readObjectionsStrict(ctx)[0].id;
    const resumed = await objectToTask(ctx, backend(), { task: 'sleep-made', as: '', note: '', via: 'agent', resume: id });
    expect(resumed.ok).toBe(true);
  });

  it('an unfinished objection whose target is gone is superseded by a new one', async () => {
    await objectToTask(ctx, backend(), obj({}), { crashAfter: 'criterion' });
    rmSync(join(ctx, 'state', 'real-work.md'));
    const fresh = await objectToTask(ctx, backend(), obj({ as: 'not-a-task' }));
    expect(fresh.ok).toBe(true);
    const ledger = readObjectionsStrict(ctx);
    expect(ledger.map((r) => r.error)).toEqual(['superseded', null]);
    expect(currentObjection(ledger, 'sleep-made')?.as).toBe('not-a-task');
  });
});

describe('finishing a record whose world moved', () => {
  it('criterion-on whose target was deleted: the same call supersedes it (409) and a new objection works', async () => {
    // A record that stopped before its criterion step.
    writeFileSync(join(ctx, OBJECTIONS_REL_PATH), JSON.stringify([{
      id: 'obj_stuck00001', task: 'sleep-made', snapshot: { name: 'Sleep Made This', description: '', why: '', filing_basis: null, filed_by: 'sleep', created_at: '' },
      as: 'criterion-on', target: 'real-work', note: NOTE, by: 'owner', via: 'ui', at: '2026-10-23T09:00:00.000Z', steps: [], error: 'boom', applied: null,
    }]));
    rmSync(join(ctx, 'state', 'real-work.md'));
    const again = await objectToTask(ctx, backend(), obj({}));
    expect(again).toMatchObject({ ok: false, status: 409, code: 'objection_target_gone' });
    expect(readObjectionsStrict(ctx)[0].error).toBe('superseded');
    expect(currentObjection(readObjectionsStrict(ctx), 'sleep-made')).toBeNull();
    const fresh = await objectToTask(ctx, backend(), obj({ as: 'not-a-task', target: null }));
    expect(fresh.ok).toBe(true);
  });

  it('subtask-of whose parent closed since: superseded, never a link to a closed task', async () => {
    writeFileSync(join(ctx, OBJECTIONS_REL_PATH), JSON.stringify([{
      id: 'obj_stuck00002', task: 'sleep-made', snapshot: { name: 'Sleep Made This', description: '', why: '', filing_basis: null, filed_by: 'sleep', created_at: '' },
      as: 'subtask-of', target: 'real-work', note: NOTE, by: 'owner', via: 'ui', at: '2026-10-23T09:00:00.000Z', steps: [], error: 'boom', applied: null,
    }]));
    writeTask('real-work', { name: 'Real Work', status: 'completed' });
    const r = await objectToTask(ctx, backend(), obj({ as: 'subtask-of' }));
    expect(r).toMatchObject({ ok: false, code: 'objection_target_gone' });
    expect(read('sleep-made').fm.parent_task).toBeNull();
  });

  it('a task that grew open sub-tasks before Finish is not cancelled', async () => {
    await objectToTask(ctx, backend(), obj({}), { crashAfter: 'criterion' });
    writeTask('late-child', { name: 'Late Child', parent_task: 'sleep-made' });
    const r = await objectToTask(ctx, backend(), obj({}));
    expect(r).toMatchObject({ ok: false, status: 409, code: 'has_open_children' });
    expect(read('sleep-made').fm.status).toBe('todo');
  });

  it('a side effect that landed before the ledger recorded its step is not repeated', async () => {
    // The criterion is already on the target, the ledger never wrote the step: the retry skips it.
    writeFileSync(join(ctx, OBJECTIONS_REL_PATH), JSON.stringify([{
      id: 'obj_sidefx0001', task: 'sleep-made', snapshot: { name: 'Sleep Made This', description: '', why: '', filing_basis: null, filed_by: 'sleep', created_at: '' },
      as: 'criterion-on', target: 'real-work', note: NOTE, by: 'owner', via: 'ui', at: '2026-10-23T09:00:00.000Z', steps: [], error: null, applied: null,
    }]));
    await backend().insertSection('real-work', 'Acceptance Criteria', '- [ ] Sleep Made This (itiraz obj_sidefx0001)', { position: 'bottom', replacePlaceholders: true });
    const r = await objectToTask(ctx, backend(), obj({}));
    expect(r.ok).toBe(true);
    expect(count(read('real-work').body, 'obj_sidefx0001')).toBe(1);
  });
});

describe('refusals', () => {
  it('a ledger holding a record this build cannot read is refused, not filtered and rewritten', async () => {
    const raw = JSON.stringify([{ id: 'obj_future', task: 'x', as: 'not-a-task', at: '2026-10-23T09:00:00Z' }]);
    writeFileSync(join(ctx, OBJECTIONS_REL_PATH), raw, 'utf-8');
    expect(await objectToTask(ctx, backend(), obj({}))).toMatchObject({ ok: false, code: 'objection_ledger_unreadable' });
    expect(readFileSync(join(ctx, OBJECTIONS_REL_PATH), 'utf-8')).toBe(raw);
  });

  it('a ledger that does not parse is refused and left as it was', async () => {
    writeFileSync(join(ctx, OBJECTIONS_REL_PATH), '{ broken', 'utf-8');
    const r = await objectToTask(ctx, backend(), obj({}));
    expect(r).toMatchObject({ ok: false, status: 500, code: 'objection_ledger_unreadable' });
    expect(readFileSync(join(ctx, OBJECTIONS_REL_PATH), 'utf-8')).toBe('{ broken');
  });

  it('a declined ledger that does not parse stops the decline step without overwriting it', async () => {
    writeFileSync(join(ctx, DECLINED_REL_PATH), 'not json', 'utf-8');
    const r = await objectToTask(ctx, backend(), obj({ as: 'not-a-task', target: null }));
    expect(r).toMatchObject({ ok: false, code: 'objection_step_failed' });
    expect(readFileSync(join(ctx, DECLINED_REL_PATH), 'utf-8')).toBe('not json');
    expect(readObjectionsStrict(ctx)[0].error).toMatch(/does not parse/);
    expect(read('sleep-made').fm.status).toBe('todo');
  });

  it('closed, missing or self targets; a short note; a cancelled task', async () => {
    expect(await objectToTask(ctx, backend(), obj({ target: 'closed-work' }))).toMatchObject({ ok: false, code: 'target_closed' });
    expect(await objectToTask(ctx, backend(), obj({ target: 'nope' }))).toMatchObject({ ok: false, code: 'target_missing' });
    expect(await objectToTask(ctx, backend(), obj({ target: 'sleep-made' }))).toMatchObject({ ok: false, code: 'self' });
    expect(await objectToTask(ctx, backend(), obj({ note: 'too short' }))).toMatchObject({ ok: false, code: 'note_too_short' });
    writeTask('gone', { status: 'cancelled' });
    expect(await objectToTask(ctx, backend(), obj({ task: 'gone' }))).toMatchObject({ ok: false, code: 'task_cancelled' });
    expect(existsSync(join(ctx, OBJECTIONS_REL_PATH))).toBe(false);
  });

  it('subtask-of a task that is itself a sub-task follows the two-level rule', async () => {
    expect(await objectToTask(ctx, backend(), obj({ as: 'subtask-of', target: 'a-child' }))).toMatchObject({ ok: false, code: 'parent_is_child' });
  });

  it('a task with open sub-tasks cannot be cancelled by an objection', async () => {
    const r = await objectToTask(ctx, backend(), obj({ task: 'real-work', target: 'sleep-made' }));
    expect(r).toMatchObject({ ok: false, status: 409, code: 'has_open_children' });
    if (!r.ok) expect(r.message).toContain('a-child');
  });

  it('a live sleep cycle refuses new objections and resumes alike', async () => {
    process.env.DREAMCONTEXT_AUTO_SLEEP = '1';
    expect(await objectToTask(ctx, backend(), obj({}))).toMatchObject({ ok: false, code: 'sleep_running' });
  });
});

describe('read contract', () => {
  it('pending, then applied, then the rule resting on it; a rule deleted by hand reads as null', async () => {
    await objectToTask(ctx, backend(), obj({}), { crashAfter: 'log' });
    let ledger = readObjectionsStrict(ctx);
    const empty = { rules: [], dismissed: [] };
    expect(objectionView(ledger, 'sleep-made', empty, () => 'Real Work')).toMatchObject({ pending: true, targetName: 'Real Work', rule: null });
    await objectToTask(ctx, backend(), obj({}));
    ledger = readObjectionsStrict(ctx);
    const id = ledger[0].id;
    const set = setRule(ctx, { title: 'Criteria stay criteria', dont: 'file a step as a task', do: 'add it as a criterion', restsOn: [id] }, new Set([id]));
    expect(set.ok).toBe(true);
    const read1 = readRules(ctx);
    if (read1.state !== 'ok') throw new Error('rules unreadable');
    expect(objectionView(ledger, 'sleep-made', read1.doc, () => null)).toMatchObject({ pending: false, rule: { id: 'R1', title: 'Criteria stay criteria' } });
    expect(objectionView(ledger, 'sleep-made', { rules: [], dismissed: [] }, () => null)?.rule).toBeNull();
    expect(objectionView(ledger, 'real-work', read1.doc, () => null)).toBeNull();
  });
});
