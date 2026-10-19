import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Marker tests for the fold-by-default work: exact-string presence checks that
 * the SOURCE skill/agent docs still describe the gates the CLI enforces.
 *
 * WHY THIS FILE EXISTS. The gates are only half the feature. A verb the skill
 * does not describe is invisible — the specialist never learns that a refusal
 * names a flag, that an idea can be declined awake, or that sessions must be read
 * newest-last (Feature Integration Pattern: "an unwired feature is functionally
 * absent"). Code has tests to stop it regressing; prose had nothing, so a tidy-up
 * pass could delete the rule and every suite would stay green. These are presence
 * checks only — no logic, no judgement about the wording around them.
 *
 * ALWAYS the repo sources under `skill/` and `agents/`, NEVER an installed copy
 * under `.claude/`: those are regenerated from here by `dreamcontext update`, so
 * asserting on them would test the copy and miss the drift.
 */

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

describe('agents/sleep-tasks.md — the protocol the bar cannot enforce', () => {
  const content = read('agents/sleep-tasks.md');

  it.each([
    ['the scope test',            'Lands in THIS project?'],
    ['the direct-evidence rubric', 'Direct evidence — file now; indirect — defer'],
    ['the deferred-candidate flag family', 'task-candidate:'],
    ['the latest-session-wins report line', 'Killed by a later session'],
  ])('names %s', (_what, marker) => {
    expect(content).toContain(marker);
  });

  it('points at a connection verb that actually exists', () => {
    // `dreamcontext peers list` does not exist; `link ls` is the real one. A
    // documented non-verb makes the scope test a silent no-op.
    expect(content).toContain('dreamcontext link ls');
  });

  it('tells the specialist how a review-band refusal is lifted', () => {
    expect(content).toContain('--neighbor-checked');
  });
});

describe('skill/SKILL.md — the awake half of the declined ledger', () => {
  const content = read('skill/SKILL.md');

  it('rule 5 tells the agent to record work the user drops', () => {
    const rule5 = content.slice(content.indexOf('5. **Work over ~5 minutes needs a task'));
    expect(rule5.slice(0, rule5.indexOf('\n6.'))).toContain('tasks decline');
  });

  it('the bookmark checkpoint table routes a dropped plan to `tasks decline`, not a bookmark', () => {
    const table = content.slice(content.indexOf('**Checkpoints — after each, pause and bookmark:**'));
    expect(table.slice(0, table.indexOf('**Rules:**'))).toContain('tasks decline');
  });
});

describe('skill/references/sleep.md — the brief and the flag family', () => {
  const content = read('skill/references/sleep.md');

  it.each([
    ['the chronological session sort',   'sort_by(.stopped_at)'],
    ['what that ordering means',         'later sessions override earlier ones'],
    ['the deferred-candidate flag family', 'task-candidate:'],
  ])('documents %s', (_what, marker) => {
    expect(content).toContain(marker);
  });
});

describe('skill/references/tasks-and-features.md — the CLI surface', () => {
  const content = read('skill/references/tasks-and-features.md');

  it.each(['--neighbor-checked', 'tasks decline', 'tasks undecline'])(
    'documents `%s`',
    (marker) => {
      expect(content).toContain(marker);
    },
  );
});
