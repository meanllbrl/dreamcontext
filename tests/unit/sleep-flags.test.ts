import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  reconcileFlags,
  escalations,
  renderEscalationAsks,
  bumpPriority,
  parseFlagOption,
  planCuratorTask,
  isTaskCandidateFlag,
  taskCandidates,
  renderTaskCandidateLine,
  TASK_CANDIDATE_PREFIX,
  readSleepFlags,
  writeSleepFlags,
  RECIDIVISM_ESCALATION_CYCLES,
  ORPHAN_TAG_CURATOR_THRESHOLD,
  CURATOR_TASK_SLUG,
  type SleepFlag,
} from '../../src/lib/sleep-flags.js';

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `sleep-flags-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'state'), { recursive: true });
  return dir;
}

const f = (key: string, task_slug: string | null = null) => ({ key, label: `label-${key}`, task_slug });

describe('reconcileFlags', () => {
  it('starts a new flag at consecutive_cycles 1 with first_seen === last_seen', () => {
    const t0 = '2026-07-01T00:00:00.000Z';
    const result = reconcileFlags([], [f('k1')], t0);
    expect(result).toEqual([
      { key: 'k1', label: 'label-k1', task_slug: null, first_seen: t0, last_seen: t0, consecutive_cycles: 1 },
    ]);
  });

  it('bumps consecutive_cycles across 3 cycles, preserving first_seen', () => {
    const t0 = '2026-07-01T00:00:00.000Z';
    const t1 = '2026-07-02T00:00:00.000Z';
    const t2 = '2026-07-03T00:00:00.000Z';
    const c1 = reconcileFlags([], [f('k1')], t0);
    const c2 = reconcileFlags(c1, [f('k1')], t1);
    const c3 = reconcileFlags(c2, [f('k1')], t2);
    expect(c3).toEqual([
      { key: 'k1', label: 'label-k1', task_slug: null, first_seen: t0, last_seen: t2, consecutive_cycles: 3 },
    ]);
  });

  it('drops a key absent this cycle, then restarts it at 1 if it recurs', () => {
    const t0 = '2026-07-01T00:00:00.000Z';
    const t1 = '2026-07-02T00:00:00.000Z';
    const t2 = '2026-07-03T00:00:00.000Z';
    const c1 = reconcileFlags([], [f('k1')], t0);
    const c2 = reconcileFlags(c1, [], t1); // absent this cycle
    expect(c2).toEqual([]);
    const c3 = reconcileFlags(c2, [f('k1')], t2);
    expect(c3).toEqual([
      { key: 'k1', label: 'label-k1', task_slug: null, first_seen: t2, last_seen: t2, consecutive_cycles: 1 },
    ]);
  });
});

describe('escalations', () => {
  const mk = (cc: number): SleepFlag => ({
    key: `k${cc}`, label: `l${cc}`, task_slug: null,
    first_seen: '2026-07-01', last_seen: '2026-07-01', consecutive_cycles: cc,
  });

  it('returns only flags at or above the escalation threshold', () => {
    const flags = [mk(1), mk(2), mk(3), mk(4)];
    expect(escalations(flags).map((x) => x.consecutive_cycles)).toEqual([3, 4]);
  });

  it('RECIDIVISM_ESCALATION_CYCLES is 3', () => {
    expect(RECIDIVISM_ESCALATION_CYCLES).toBe(3);
  });
});

describe('renderEscalationAsks', () => {
  it('renders one line per flag with the label and task slug', () => {
    const flags: SleepFlag[] = [
      { key: 'k1', label: 'Recurring task X', task_slug: 'fix-x', first_seen: 'a', last_seen: 'b', consecutive_cycles: 3 },
    ];
    const lines = renderEscalationAsks(flags);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Recurring task X');
    expect(lines[0]).toContain('fix-x');
  });
});

describe('bumpPriority', () => {
  it('bumps low -> medium -> high -> critical, capping at critical', () => {
    expect(bumpPriority('low')).toBe('medium');
    expect(bumpPriority('medium')).toBe('high');
    expect(bumpPriority('high')).toBe('critical');
    expect(bumpPriority('critical')).toBe('critical');
  });

  it('leaves an unrecognized priority unchanged', () => {
    expect(bumpPriority('urgent')).toBe('urgent');
  });
});

describe('parseFlagOption', () => {
  it('parses key::label with a null task_slug', () => {
    expect(parseFlagOption('k::label')).toEqual({ key: 'k', label: 'label', task_slug: null });
  });

  it('parses key::label::slug', () => {
    expect(parseFlagOption('k::label::slug')).toEqual({ key: 'k', label: 'label', task_slug: 'slug' });
  });

  it('returns null for malformed input', () => {
    expect(parseFlagOption('')).toBeNull();
    expect(parseFlagOption('nolabel')).toBeNull();
    expect(parseFlagOption('::x')).toBeNull();
  });
});

describe('planCuratorTask', () => {
  it('below the threshold: no action', () => {
    expect(planCuratorTask(149, null).action).toBe('none');
  });

  it('at the threshold (inclusive), no existing task: create', () => {
    expect(planCuratorTask(150, null).action).toBe('create');
    expect(planCuratorTask(150, null).slug).toBe(CURATOR_TASK_SLUG);
  });

  it('at the threshold, existing open task: refresh', () => {
    expect(planCuratorTask(150, { slug: CURATOR_TASK_SLUG, status: 'todo' }).action).toBe('refresh');
  });

  it('at the threshold, existing COMPLETED task: create (orphans recurred)', () => {
    expect(planCuratorTask(150, { slug: CURATOR_TASK_SLUG, status: 'completed' }).action).toBe('create');
  });

  it('above the threshold, existing in_progress task: refresh', () => {
    expect(planCuratorTask(200, { slug: CURATOR_TASK_SLUG, status: 'in_progress' }).action).toBe('refresh');
  });

  it('ORPHAN_TAG_CURATOR_THRESHOLD is 150', () => {
    expect(ORPHAN_TAG_CURATOR_THRESHOLD).toBe(150);
  });
});

describe('readSleepFlags / writeSleepFlags', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns [] when the file does not exist', () => {
    expect(readSleepFlags(root)).toEqual([]);
  });

  it('round-trips flags through state/.sleep-flags.json', () => {
    const flags: SleepFlag[] = [
      { key: 'k1', label: 'l1', task_slug: null, first_seen: 'a', last_seen: 'b', consecutive_cycles: 2 },
    ];
    writeSleepFlags(root, flags);
    expect(readSleepFlags(root)).toEqual(flags);
  });

  it('never writes to .sleep.json or .sleep-history.json', () => {
    writeSleepFlags(root, [{ key: 'k1', label: 'l1', task_slug: null, first_seen: 'a', last_seen: 'b', consecutive_cycles: 1 }]);
    expect(existsSync(join(root, 'state', '.sleep.json'))).toBe(false);
    expect(existsSync(join(root, 'state', '.sleep-history.json'))).toBe(false);
  });
});

/**
 * Deferred task candidates. A cycle with only INDIRECT evidence defers the work
 * as a `task-candidate:` flag instead of filing a task nobody asked for. The
 * streak contract is unchanged; what must NOT happen is escalation — there is
 * no task behind a candidate, so a priority bump and an "escalate?" ask would
 * both point at nothing.
 */

const candidate = (key: string, consecutive_cycles: number): SleepFlag => ({
  key: `${TASK_CANDIDATE_PREFIX}${key}`,
  label: `label-${key}`,
  task_slug: null,
  first_seen: '2026-09-01T00:00:00.000Z',
  last_seen: '2026-09-10T00:00:00.000Z',
  consecutive_cycles,
});

const problem = (key: string, consecutive_cycles: number): SleepFlag => ({
  key,
  label: `label-${key}`,
  task_slug: key,
  first_seen: '2026-09-01T00:00:00.000Z',
  last_seen: '2026-09-10T00:00:00.000Z',
  consecutive_cycles,
});

describe('isTaskCandidateFlag / taskCandidates', () => {
  it('recognises the prefix and nothing else', () => {
    expect(isTaskCandidateFlag({ key: 'task-candidate:sleep-brief-ordering' })).toBe(true);
    expect(isTaskCandidateFlag({ key: 'recurring-task:fix-x' })).toBe(false);
    // A key that merely CONTAINS the prefix is not one — the family is a prefix.
    expect(isTaskCandidateFlag({ key: 'x:task-candidate:y' })).toBe(false);
  });

  it('does not throw on a malformed on-disk entry (readSleepFlags casts, it does not validate)', () => {
    expect(isTaskCandidateFlag({ key: undefined as unknown as string })).toBe(false);
    expect(isTaskCandidateFlag({ key: 7 as unknown as string })).toBe(false);
  });

  it('separates candidates from recurring problems', () => {
    const flags = [candidate('a', 1), problem('recurring-task:fix-x', 3), candidate('b', 2)];
    expect(taskCandidates(flags).map((f) => f.key)).toEqual([
      'task-candidate:a', 'task-candidate:b',
    ]);
  });
});

describe('escalations excludes deferred task candidates', () => {
  it('a candidate at 5 cycles never escalates, while a recurring task at 3 does', () => {
    const flags = [candidate('discussed-idea', 5), problem('recurring-task:fix-x', 3)];
    expect(escalations(flags).map((f) => f.key)).toEqual(['recurring-task:fix-x']);
  });

  it('so no "escalate?" ask is ever rendered for one', () => {
    expect(renderEscalationAsks(escalations([candidate('discussed-idea', 9)]))).toEqual([]);
  });
});

describe('task candidates ride the unchanged reconcileFlags streak contract', () => {
  const t0 = '2026-07-01T00:00:00.000Z';
  const t1 = '2026-07-02T00:00:00.000Z';
  const t2 = '2026-07-03T00:00:00.000Z';
  const key = 'task-candidate:sleep-brief-ordering';

  it('bumps and preserves first_seen when re-observed', () => {
    const c1 = reconcileFlags([], [f(key)], t0);
    expect(c1[0].consecutive_cycles).toBe(1);
    const c2 = reconcileFlags(c1, [f(key)], t1);
    expect(c2[0]).toMatchObject({ first_seen: t0, last_seen: t1, consecutive_cycles: 2 });
  });

  it('is DROPPED when a cycle does not re-observe it — an idea nobody saw again dies', () => {
    const c1 = reconcileFlags([], [f(key)], t0);
    expect(reconcileFlags(c1, [], t1)).toEqual([]);
    // …and starts over at 1 if it comes back.
    expect(reconcileFlags([], [f(key)], t2)[0].consecutive_cycles).toBe(1);
  });

  it('parses from the CLI flag spec unchanged — one colon in the key is not the `::` separator', () => {
    expect(parseFlagOption('task-candidate:foo::"label"')).toEqual({
      key: 'task-candidate:foo', label: '"label"', task_slug: null,
    });
  });
});

describe('renderTaskCandidateLine', () => {
  it('is null when there is nothing deferred — no line, no noise', () => {
    expect(renderTaskCandidateLine([])).toBeNull();
    expect(renderTaskCandidateLine([problem('recurring-task:fix-x', 3)])).toBeNull();
  });

  it('counts the deferred candidates and how many are already recurring', () => {
    const line = renderTaskCandidateLine([
      candidate('a', 1), candidate('b', 2), candidate('c', 1),
      problem('recurring-task:fix-x', 4),
    ]);
    expect(line).toBe(
      'Deferred task candidates: 3 (1 seen ≥2 cycles — sleep-tasks files them when re-observed).',
    );
  });
});
