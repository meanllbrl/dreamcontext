/**
 * The task read memo (src/lib/task-backend/local.ts) — task: the desktop app stays light on an
 * 8GB MacBook Air, plan S8, AC5.
 *
 * `GET /api/tasks` runs `list()` and then `get()` per task; with a few hundred task files that
 * was the third-biggest cost on the idle server. A file is now re-read only when its stat
 * moved, and every backend write forgets its file. Counted at `readFileSync`, the way the AC
 * states it: a second list with no change reads 0 task files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Task-file reads, by absolute path, counted inside the state dir under test. */
const reads = vi.hoisted(() => ({ dir: '', count: 0, paths: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    const p = typeof args[0] === 'string' ? args[0] : '';
    if (reads.dir && p.startsWith(reads.dir) && p.endsWith('.md')) {
      reads.count += 1;
      reads.paths.push(p);
    }
    return real.readFileSync(...args);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

const { LocalTaskBackend, resetTaskReadMemo } = await import('../../src/lib/task-backend/local.js');

let root: string;
let state: string;

function taskFile(slug: string, body = '- [ ] first\n- [ ] second\n'): string {
  const p = join(state, `${slug}.md`);
  writeFileSync(p, `---
id: "task_${slug}"
name: "${slug}"
description: ""
priority: "medium"
urgency: "medium"
status: "todo"
created_at: "2026-10-17"
updated_at: "2026-10-17"
tags: []
parent_task: null
related_feature: null
version: null
---

## Why

Because.

## Acceptance Criteria

${body}
## Changelog
<!-- LIFO: newest entry at top -->
`);
  return p;
}

/** What the tasks route does: list, then get each. */
async function listAndGetAll(): Promise<unknown[]> {
  const backend = new LocalTaskBackend(state); // a backend per request, like the route
  const out: unknown[] = [];
  for (const s of await backend.list()) out.push(await backend.get(s.name));
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-task-memo-'));
  state = join(root, '_dream_context', 'state');
  mkdirSync(state, { recursive: true });
  reads.dir = resolve(state);
  reads.count = 0;
  reads.paths = [];
  resetTaskReadMemo();
});

afterEach(() => {
  reads.dir = '';
  rmSync(root, { recursive: true, force: true });
});

describe('task read memo', () => {
  it('a second list + get with no change reads 0 task files, and returns the same data', async () => {
    for (const s of ['alpha', 'beta', 'gamma']) taskFile(s);
    const first = await listAndGetAll();
    expect(reads.count).toBeGreaterThan(0);
    reads.count = 0;
    const second = await listAndGetAll();
    expect(reads.count).toBe(0);
    expect(second).toEqual(first);
  });

  it('one touched file is re-read alone', async () => {
    for (const s of ['alpha', 'beta', 'gamma']) taskFile(s);
    await listAndGetAll();
    taskFile('beta', '- [ ] first\n- [ ] second\n- [ ] third\n');
    reads.count = 0;
    reads.paths = [];
    await listAndGetAll();
    expect(reads.count).toBeGreaterThan(0);
    expect(new Set(reads.paths)).toEqual(new Set([resolve(state, 'beta.md')]));
  });

  it('a same-size checkbox flip written through the backend is seen', async () => {
    taskFile('alpha');
    const backend = new LocalTaskBackend(state);
    const before = await backend.get('alpha');
    expect(before?.acceptance_criteria).toContain('- [ ] first');
    const flipped = before!.rawBody.replace('- [ ] first', '- [x] first');
    expect(flipped.length).toBe(before!.rawBody.length);
    await backend.updateFields('alpha', {}, { body: flipped });
    const after = await new LocalTaskBackend(state).get('alpha');
    expect(after?.acceptance_criteria).toContain('- [x] first');
  });

  it('callers get copies: mutating a returned task never reaches the next caller', async () => {
    taskFile('alpha');
    const a = await new LocalTaskBackend(state).get('alpha');
    a!.tags.push('mutated');
    a!.name = 'changed';
    const b = await new LocalTaskBackend(state).get('alpha');
    expect(b?.tags).toEqual([]);
    expect(b?.name).toBe('alpha');
  });

  it('a deleted task drops out of the next list', async () => {
    taskFile('alpha');
    taskFile('beta');
    await listAndGetAll();
    await new LocalTaskBackend(state).delete('beta');
    const names = (await new LocalTaskBackend(state).list()).map((t) => t.name);
    expect(names).toEqual(['alpha']);
  });
});
