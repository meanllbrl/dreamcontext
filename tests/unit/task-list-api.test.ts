/**
 * `GET /api/tasks` returns cards without bodies; `GET /api/tasks/:slug` returns the whole
 * card with parsed criteria, its parent and its children (plan r3 § W4, C5 criterion
 * "GET /api/tasks gövdesiz kart döner; Türkçe isimler olduğu gibi görünür").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const journalReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/lib/task-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/task-journal.js')>();
  return {
    ...actual,
    readJournalRaw: (...args: Parameters<typeof actual.readJournalRaw>) => {
      journalReads.count += 1;
      return actual.readJournalRaw(...args);
    },
  };
});

const { handleTasksGet, handleTasksList } = await import('../../src/server/routes/tasks.js');
const { resetTaskReadMemo } = await import('../../src/lib/task-backend/local.js');
const { call } = await import('../helpers/fake-http.js');

const TURKISH = 'Gölge İşleri: ığdır şubesi ödemesi';
let ctx: string;
let projectRoot: string;

function card(slug: string, fm: Record<string, string>, body: string): void {
  const lines = ['---', `id: "task_${slug.replace(/[^a-z]/g, '').slice(0, 8)}"`, ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), '---', '', body];
  writeFileSync(join(ctx, 'state', `${slug}.md`), lines.join('\n'));
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  mkdirSync(join(ctx, 'state', 'journal'), { recursive: true });
  resetTaskReadMemo();
  journalReads.count = 0;

  // A 300 KB legacy card: its history still in the card.
  const history = Array.from({ length: 6000 }, (_, i) => `### 2026-01-01 - Session update\n- step ${i} of a long legacy history, padded to weigh like the real one`).join('\n\n');
  card('legacy-giant', { name: '"Legacy giant"', status: 'in_progress', created_at: '"2026-01-01"', updated_at: '"2026-01-01"' },
    `## Why\n\nBecause.\n\n## Acceptance Criteria\n\n- [x] Old work (evidence: legacy)\n- [ ] More work\n\n## Changelog\n\n${history}\n`);
  card('parent-task', { name: '"Parent task"', status: 'in_progress', created_at: '"2026-10-01"', updated_at: '"2026-10-01"', cycle: 'cy_abc12345', rank: '10' },
    '## Why\n\nThe deliverable.\n\n## Acceptance Criteria\n\n- [ ] Ships\n');
  card('child-one', { name: '"Child one"', status: 'completed', parent_task: 'parent-task', created_at: '"2026-10-01"', updated_at: '"2026-10-01"', queue: 'next' },
    '## Why\n\nStep one.\n\n## Acceptance Criteria\n\n- [x] Parser works (evidence: cmd:je_abc1234567)\n- [x] Looks right (observed) (evidence: owner:je_def1234567)\n');
  card('child-two', { name: `"${TURKISH}"`, status: 'todo', parent_task: 'parent-task', created_at: '"2026-10-01"', updated_at: '"2026-10-01"', queue: 'later' },
    '## Why\n\nStep two.\n\n## Acceptance Criteria\n\n- [ ] Ödeme geçer\n');
  writeFileSync(join(ctx, 'state', 'journal', 'child-two.md'), '### 2026-10-02 10:00 - log [je_journal0001]\n- a journal entry\n');
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('GET /api/tasks: cards, never bodies', () => {
  it('carries no body, section or journal field, stays small for a 300 KB card, and never reads a journal', async () => {
    const { code, body } = await call(handleTasksList, ctx, {}, { method: 'GET' });
    expect(code).toBe(200);
    const tasks = body.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(4);
    for (const t of tasks) {
      for (const k of ['body', 'rawBody', 'raw', 'why', 'user_stories', 'acceptance_criteria', 'constraints', 'technical_details', 'notes', 'changelog', 'sections']) {
        expect(t, `${t.slug} carries ${k}`).not.toHaveProperty(k);
      }
    }
    const giant = tasks.find((t) => t.slug === 'legacy-giant')!;
    expect(giant.bytes as number).toBeGreaterThan(300_000);
    expect(JSON.stringify(giant).length).toBeLessThan(2048);
    expect(journalReads.count).toBe(0);
  });

  it('counts criteria, rolls up children and carries the placement', async () => {
    const tasks = (await call(handleTasksList, ctx, {}, { method: 'GET' })).body.tasks as Array<Record<string, unknown>>;
    const by = (s: string) => tasks.find((t) => t.slug === s)!;
    expect(by('legacy-giant').criteria).toEqual({ total: 2, done: 1 });
    expect(by('parent-task').children).toEqual({ total: 2, done: 1 });
    expect(by('child-one').children).toBeNull();
    expect(by('parent-task')).toMatchObject({ cycle: 'cy_abc12345', queue: null, rank: 10 });
    expect(by('child-two')).toMatchObject({ queue: 'later', cycle: null });
  });

  it('a Turkish name round-trips byte for byte', async () => {
    const tasks = (await call(handleTasksList, ctx, {}, { method: 'GET' })).body.tasks as Array<Record<string, unknown>>;
    expect(tasks.find((t) => t.slug === 'child-two')!.name).toBe(TURKISH);
  });
});

describe('GET /api/tasks/:slug: the whole card', () => {
  it('returns the body, parsed criteria with evidence kinds, and the parent', async () => {
    const { code, body } = await call(handleTasksGet, ctx, { slug: 'child-one' }, { method: 'GET' });
    expect(code).toBe(200);
    const task = body.task as Record<string, unknown>;
    expect(task.body).toContain('Parser works');
    expect(task.criteria).toEqual([
      { n: 1, text: 'Parser works', checked: true, ref: 'cmd:je_abc1234567', kind: 'cmd', observed: false },
      { n: 2, text: 'Looks right (observed)', checked: true, ref: 'owner:je_def1234567', kind: 'owner', observed: true },
    ]);
    expect(task.parent).toEqual({ slug: 'parent-task', name: 'Parent task', status: 'in_progress' });
    expect(task.children).toEqual([]);
    expect(task).toMatchObject({ queue: 'next', cycle: null, rank: null });
  });

  it('a parent carries its children as list cards; a Turkish name stays verbatim in the detail too', async () => {
    const parent = (await call(handleTasksGet, ctx, { slug: 'parent-task' }, { method: 'GET' })).body.task as Record<string, unknown>;
    const kids = parent.children as Array<Record<string, unknown>>;
    expect(kids.map((k) => k.slug).sort()).toEqual(['child-one', 'child-two']);
    expect(kids.find((k) => k.slug === 'child-two')).not.toHaveProperty('body');
    const child = (await call(handleTasksGet, ctx, { slug: 'child-two' }, { method: 'GET' })).body.task as Record<string, unknown>;
    expect(child.name).toBe(TURKISH);
    expect(child.changelog).toContain('a journal entry');
  });

  it('404 for an unknown slug, 400 for an unsafe one', async () => {
    expect((await call(handleTasksGet, ctx, { slug: 'nope' }, { method: 'GET' })).code).toBe(404);
    expect((await call(handleTasksGet, ctx, { slug: '../x' }, { method: 'GET' })).code).toBe(400);
  });
});
