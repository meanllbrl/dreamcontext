/**
 * The ONE task-filing standard (owner, 2026-11-12) is worded the same everywhere an agent is told
 * about tasks: the briefings embed the constant, the instruction files carry it verbatim.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_FILING_STANDARD } from '../../src/lib/task-filing-standard.js';
import { modeBriefing } from '../../src/server/chat-modes.js';

const root = join(__dirname, '..', '..');
const flat = (s: string): string => s.replace(/\s+/g, ' ');
const STD = flat(TASK_FILING_STANDARD);

describe('the task-filing standard', () => {
  it.each([
    'skill/SKILL.md',
    'skill-agent-core/SKILL.md',
    'skill/references/tasks-and-features.md',
    'skill/references/super-orchestration.md',
    'skill-goal-skill/SKILL.md',
    'src/templates/CLAUDE.md',
  ])('%s carries it verbatim', (file) => {
    expect(flat(readFileSync(join(root, file), 'utf-8'))).toContain(STD);
  });

  it.each(['plan', 'develop'] as const)('the %s briefing embeds it', (mode) => {
    expect(flat(modeBriefing(mode, { worktreeAllowed: true }))).toContain(STD);
  });

  it('the Super briefing embeds it', () => {
    expect(flat(readFileSync(join(root, 'src/server/chat-modes.ts'), 'utf-8'))).toMatch(/- Tasks: \$\{TASK_FILING_STANDARD\}/);
  });

  it('has no numeric cap and keeps the one mechanical rule', () => {
    expect(TASK_FILING_STANDARD).not.toMatch(/a day|per day|at most \d/);
    expect(TASK_FILING_STANDARD).toContain('A Super child never opens one: the Super does.');
  });
});
