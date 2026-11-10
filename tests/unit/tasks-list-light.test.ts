/**
 * Opening a project is slow (owner, 2026-11-10): the Super screen asked `GET /api/tasks` for every
 * task's whole text (19.9 MB for 867 tasks) to show names, statuses and progress bars, read on one
 * thread; `/api/tasks/members` read every task again. These pin the fix:
 *   - `?view=summary` carries no body sections, and a card's numbers come out the same;
 *   - the full list is unchanged for the Tasks page;
 *   - the members route does not read each task through `get()` again;
 *   - the bulk read yields to the event loop (another request is answered in between).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleTasksList, handleTasksMembers } from '../../src/server/routes/tasks.js';
import { LocalTaskBackend, forgetTaskRead, readTaskFile, resetTaskReadMemo } from '../../src/lib/task-backend/local.js';
import { criteriaProgress } from '../../dashboard/src/components/sleepy/super/tileModel.js';
import { SUMMARY_WHY_MAX } from '../../src/lib/task-list-summary.js';

type Body = { tasks: Array<Record<string, unknown>>; members?: Array<{ slug: string }> };

function makeRes(): { res: ServerResponse; body: () => Body; bytes: () => number } {
  let raw = '';
  const res = {
    writeHead() {},
    setHeader() {},
    end(data: string) { raw = data; },
  } as unknown as ServerResponse;
  return { res, body: () => JSON.parse(raw) as Body, bytes: () => Buffer.byteLength(raw) };
}
const reqOf = (url: string) => ({ method: 'GET', url, headers: { host: 'localhost' } }) as unknown as IncomingMessage;

let tmp: string;
let ctx: string;

const LONG = 'Bu satır kartın göstermediği uzun bir ayrıntı. '.repeat(400);

function seed(slug: string, extra = ''): void {
  writeFileSync(join(ctx, 'state', `${slug}.md`), `---
id: task_${slug}
name: ${slug} adı
description: Kısa açıklama
priority: high
urgency: medium
status: in_progress
created_at: '2026-11-01'
updated_at: '2026-11-02'
tags:
  - 'person:kerem-yilmaz'
parent_task: null
related_feature: null
---

## Why

${LONG}

## Acceptance Criteria

Giriş paragrafı, kutu değil.

- [x] **Birinci** kriter tamam
- [ ] İkinci kriter [bağlantı](https://example.invalid) ile ${'uzun '.repeat(200)}
* [ ] Üçüncü kriter
- [X] Dördüncü

### Bir alt başlık
- [ ] Beşinci

## Technical Details

${LONG}

## Changelog

${LONG}
${extra}`);
}

beforeEach(() => {
  tmp = join(tmpdir(), `tasks-light-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  ctx = join(tmp, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  resetTaskReadMemo();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/tasks?view=summary', () => {
  it('drops every body section but keeps what a card reads, with the same progress numbers', async () => {
    seed('alpha');
    const light = makeRes();
    await handleTasksList(reqOf('/api/tasks?view=summary'), light.res, {}, ctx);
    const full = makeRes();
    await handleTasksList(reqOf('/api/tasks'), full.res, {}, ctx);

    const l = light.body().tasks[0];
    const f = full.body().tasks[0];
    for (const k of ['body', 'technical_details', 'changelog', 'notes', 'user_stories', 'constraints', 'sections', 'attachments', 'objection']) {
      expect(l, k).not.toHaveProperty(k);
    }
    for (const k of ['slug', 'id', 'name', 'description', 'priority', 'status', 'updated_at', 'tags', 'agent_job']) {
      expect(l[k], k).toEqual(f[k]);
    }
    expect((l.why as string).length).toBeLessThanOrEqual(SUMMARY_WHY_MAX);
    expect(l.why as string).toBe(`${(f.why as string).slice(0, SUMMARY_WHY_MAX - 1)}…`);
    const lp = criteriaProgress(l.acceptance_criteria as string);
    const fp = criteriaProgress(f.acceptance_criteria as string);
    expect(lp.done).toBe(fp.done);
    expect(lp.total).toBe(fp.total);
    expect(lp.total).toBe(5);
    // The one long criterion is cut past what a one-line row shows; its start is the same text.
    expect(lp.next!.endsWith('…')).toBe(true);
    expect(fp.next!.startsWith(lp.next!.slice(0, -1).trimEnd())).toBe(true);
    expect(lp.upcoming.length).toBe(fp.upcoming.length);
    expect(lp.upcoming[1]).toBe(fp.upcoming[1]);
    // The point of it: a fraction of the bytes.
    expect(light.bytes() * 10).toBeLessThan(full.bytes());
  });

  it('leaves the full list (the Tasks page) exactly as it was', async () => {
    seed('alpha');
    const full = makeRes();
    await handleTasksList(reqOf('/api/tasks'), full.res, {}, ctx);
    const t = full.body().tasks[0];
    const file = readTaskFile(join(ctx, 'state', 'alpha.md'));
    expect(t.body).toBe(file.body);
    expect(t.technical_details).toBe(file.technical_details);
    expect(t.changelog).toBe(file.changelog);
    expect(t.sections).toEqual(['Why', 'Acceptance Criteria', 'Technical Details', 'Changelog']);
    expect(t).toHaveProperty('attachments');
    expect(t).toHaveProperty('objection');
  });
});

describe('GET /api/tasks/members', () => {
  it('finds assignees without reading each task again through get()', async () => {
    seed('alpha');
    seed('beta');
    const get = vi.spyOn(LocalTaskBackend.prototype, 'get');
    const { res, body } = makeRes();
    await handleTasksMembers(reqOf('/api/tasks/members'), res, {}, ctx);
    expect(body().members!.map((m) => m.slug)).toContain('kerem-yilmaz');
    expect(get).not.toHaveBeenCalled();
  });
});

describe('LocalTaskBackend.readAll', () => {
  it('lets another callback run while it reads, and answers list() order', async () => {
    for (let i = 0; i < 120; i++) seed(`t-${String(i).padStart(3, '0')}`);
    const backend = new LocalTaskBackend(join(ctx, 'state'));
    let between = false;
    setImmediate(() => { between = true; });
    let doneFirst = false;
    const p = backend.readAll().then((all) => { doneFirst = !between; return all; });
    const all = await p;
    expect(doneFirst).toBe(false);
    expect(all.map((t) => t.slug)).toEqual((await backend.list()).map((s) => s.name));
    expect(all[0]).toEqual(readTaskFile(join(ctx, 'state', `${all[0].slug}.md`)));
  });
});

describe('readAll after a write', () => {
  it('never hands a caller that came after a write the pass that started before it', async () => {
    for (let i = 0; i < 120; i++) seed(`t-${String(i).padStart(3, '0')}`);
    const backend = new LocalTaskBackend(join(ctx, 'state'));
    const first = backend.readAll(); // has listed the files already: the new task is not among them
    // A create's own steps while that pass still reads: the file appears and this process
    // forgets its read (every backend write ends that way).
    seed('t-new');
    forgetTaskRead(join(ctx, 'state', 't-new.md'));
    const second = await backend.readAll();
    expect((await first).some((t) => t.slug === 't-new')).toBe(false);
    expect(second.some((t) => t.slug === 't-new')).toBe(true);
  });
});
