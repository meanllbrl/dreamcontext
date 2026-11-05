/**
 * The Super Agent's tool steps as one quiet line (owner 2026-11-06, draft A):
 *  - in the Super view a dreamcontext call no longer breaks the run, and one step already folds;
 *    the plain Chat keeps its rule (a dreamcontext call keeps its own row, runs start at 3);
 *  - a member's answer to Super (`super team done`) still keeps its own place;
 *  - a failed step (tool error or the CLI's `✗`) is counted and drawn outside the line;
 *  - the chip's duration reads in seconds, then minutes, from the dashboard's i18n.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nowStep, stepFailed, stepsDuration } from '../../dashboard/src/components/sleepy/super/superSteps.js';
import { segmentToolRuns } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const bash = (id: string, command: string, status: 'running' | 'done' | 'error' = 'done', result?: string) =>
  ({ kind: 'tool' as const, id, toolUseId: id, name: 'Bash', input: { command }, status, startedAt: 0, result });

describe('the quiet steps line', () => {
  it('folds a single step in the Super view and leaves the plain Chat at three', () => {
    const one = [bash('a', 'dreamcontext tasks list')];
    expect(segmentToolRuns(one, () => true, 1)).toEqual([{ kind: 'run', items: one }]);
    expect(segmentToolRuns(one, () => true, 3)).toEqual([{ kind: 'single', item: one[0] }]);
  });

  it('wires the Super rule into ChatPane: dreamcontext calls group, team done stays out', () => {
    const pane = src('dashboard/src/components/sleepy/ChatPane.tsx');
    expect(pane).toContain('if (superView) return teamDoneText(command) === null;');
    expect(pane).toContain('const minToolRun = superView ? 1 : MIN_TOOL_RUN;');
    expect(pane).toContain('minRun: minToolRun,');
    expect(pane).not.toMatch(/segmentToolRuns\([^)]*MIN_TOOL_RUN/);
    expect(pane).toContain('<SuperStepsLine');
  });

  it('counts a failed step: the tool error, or a dreamcontext call that printed ✗', () => {
    expect(stepFailed(bash('a', 'ls', 'error'))).toBe(true);
    expect(stepFailed(bash('b', 'dreamcontext tasks status nope done', 'done', '✗ Task not found: nope'))).toBe(true);
    expect(stepFailed(bash('c', 'dreamcontext tasks list', 'done', 'Tasks: 3'))).toBe(false);
    expect(stepFailed(bash('d', 'dreamcontext tasks list', 'running'))).toBe(false);
  });

  it('names the step in hand in plain words, never the raw command', () => {
    const now = nowStep([bash('a', 'dreamcontext tasks list'), bash('b', 'dreamcontext tasks create "Fix it"', 'running')]);
    expect(now.endsWith('…')).toBe(true);
    expect(now).not.toContain('dreamcontext');
  });

  it('reads the duration in seconds up to 99, then minutes', () => {
    const tr: Record<string, string> = { 'super.steps.seconds': '{n} sn', 'super.steps.minutes': '{n} dk' };
    const t = (k: string) => tr[k] ?? k;
    expect(stepsDuration(61_000, t)).toBe('61 sn');
    expect(stepsDuration(125_000, t)).toBe('2 dk 5 sn');
    expect(stepsDuration(42_400, t)).toBe('42 sn');
    expect(stepsDuration(120_000, t)).toBe('2 dk');
    expect(stepsDuration(10, t)).toBe('1 sn');
  });

  it('has every visible string in EN and TR, without an em dash', () => {
    const i18n = src('dashboard/src/context/I18nContext.tsx');
    for (const key of ['one', 'many', 'seconds', 'minutes', 'failedOne', 'failedMany', 'working', 'waiting']) {
      const lines = i18n.split('\n').filter((l) => l.includes(`'super.steps.${key}':`));
      expect(lines, key).toHaveLength(2);
      for (const l of lines) expect(l).not.toContain('—');
    }
  });
});
