import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';

/**
 * MUTATION TEST for the stale-`at` guard inside the accept lock.
 *
 * The real guard is `planAccept`'s identity check, which runs INSIDE the task lock
 * against a fresh read (LocalTaskBackend.acceptSuggestion → lockedMutate). Here the
 * check is REMOVED (planAccept is handed the stored `at` whatever the caller sent).
 * The stale accept then writes — proving that the 409 test in
 * priority-suggestion.test.ts ("a stale at answers 409 suggestion_changed and writes
 * nothing") depends on that guard and would go red without it. The control case in
 * this file runs the SAME scenario with the real guard and expects the refusal.
 */

const mutate = { removeGuard: false };

vi.mock('../../src/lib/priority-suggestion.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/priority-suggestion.js')>();
  return {
    ...real,
    planAccept: (target: Parameters<typeof real.planAccept>[0], at: string, ...rest: unknown[]) => {
      const stored = target.priority_suggestion?.at;
      const passAt = mutate.removeGuard && stored ? stored : at;
      return (real.planAccept as (...a: unknown[]) => unknown)(target, passAt, ...rest);
    },
  };
});

const { LocalTaskBackend } = await import('../../src/lib/task-backend/local.js');
const { createObjective } = await import('../../src/lib/objectives-store.js');
const { buildRoadmapModel } = await import('../../src/lib/roadmap-model.js');
const { objectiveLiveness } = await import('../../src/lib/scoring-work.js');

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  const raw = join(tmpdir(), `dc-prio-mut-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  createObjective(contextRoot, { slug: 'mrr', title: 'MRR' });
  writeFileSync(
    join(contextRoot, 'state', 't.md'),
    matter.stringify('## Why\nx\n', { name: 't', status: 'todo', priority: 'medium', urgency: 'medium' }),
  );
});

afterEach(() => {
  mutate.removeGuard = false;
  rmSync(projectRoot, { recursive: true, force: true });
});

async function staleAccept(): Promise<{ threw: unknown; changed: boolean }> {
  const b = new LocalTaskBackend(join(contextRoot, 'state'));
  const live = objectiveLiveness(buildRoadmapModel(contextRoot));
  const input = { reach: 6, impact: 3, confidence: 75, effort: 0.5, objective: 'mrr', why: 'w' };
  const first = (await b.suggestPriority('t', input, live)).priority_suggestion!.at;
  await new Promise((r) => setTimeout(r, 2));
  await b.suggestPriority('t', { ...input, reach: 8 }, live); // the record the owner has NOT seen
  const before = readFileSync(join(contextRoot, 'state', 't.md'), 'utf-8');
  let threw: unknown = null;
  try {
    await b.acceptSuggestion('t', first, {}, live);
  } catch (err) {
    threw = err;
  }
  return { threw, changed: readFileSync(join(contextRoot, 'state', 't.md'), 'utf-8') !== before };
}

describe('stale-at guard inside the accept lock (mutation test)', () => {
  it('control: with the guard, a stale accept is refused suggestion_changed and writes nothing', async () => {
    const r = await staleAccept();
    expect(r.threw).toMatchObject({ code: 'suggestion_changed' });
    expect(r.changed).toBe(false);
  });

  it('mutant: with the guard removed, the stale accept writes the unseen values (the protection is gone)', async () => {
    mutate.removeGuard = true;
    const r = await staleAccept();
    expect(r.threw).toBeNull();
    expect(r.changed).toBe(true);
  });
});
