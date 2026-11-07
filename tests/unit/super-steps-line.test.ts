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
import { liveLabel, nowStep, stepFailed, stepsDuration, turnClock } from '../../dashboard/src/components/sleepy/super/superSteps.js';
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

  it('puts a landed run away behind the answer that follows it, and only that answer', () => {
    const pane = src('dashboard/src/components/sleepy/ChatPane.tsx');
    // Landed only: never the accruing tail, never a run with a step still running.
    expect(pane).toMatch(/seg\.kind !== 'run' \|\| accruing\(i\) \|\| seg\.items\.some\(\(it\) => it\.kind === 'tool' && it\.status === 'running'\)\) return;/);
    // The next VISIBLE thing must be the answer text; otherwise the chip stays.
    expect(pane).toContain("if (!next || next.kind !== 'single' || next.item.kind !== 'text' || !next.item.text?.trim() || doneRepeats.has(next.item.id)) return;");
    // The run holding the live browser is never put away.
    expect(pane).toContain('if (browserHostToolId && seg.items.some((it) => it.id === browserHostToolId)) return;');
    expect(pane).toContain('hidden={hostedRuns.has(runKeyOf(seg.items))}');
    // No way back to a put-away run: the hover "steps" link is gone (owner 2026-11-08).
    expect(pane).not.toContain('stepsKey');
    expect(pane).not.toContain('openSteps');
    // A one-piece answer group (the lone answer) draws no reply line.
    expect(pane).toContain('const lines = [...spans.values()].filter((l) => l.n > 1);');
    const row = src('dashboard/src/components/sleepy/chat/TranscriptItem.tsx');
    expect(row).not.toContain('super-steps-link');
    expect(row).not.toContain('onToggleSteps');
    expect(src('dashboard/src/components/sleepy/super/SuperSurface.css')).not.toContain('.super-steps-link');
    expect(src('dashboard/src/context/I18nContext.tsx')).not.toMatch(/'super\.steps\.(show|hide)'/);
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
    for (const key of ['one', 'many', 'seconds', 'minutes', 'failedOne', 'failedMany', 'working', 'waiting', 'thinking', 'starting']) {
      const lines = i18n.split('\n').filter((l) => l.includes(`'super.steps.${key}':`));
      expect(lines, key).toHaveLength(2);
      for (const l of lines) expect(l).not.toContain('—');
    }
  });

  // Owner 2026-11-07: the separate "Working… 28s" pill made the chat jump a row in every thinking
  // gap. In the Super view the live line carries the turn's clock and says "Thinking" instead.
  it('says "Thinking" between steps, the step in hand during one, and waiting on the owner', () => {
    const en: Record<string, string> = { 'super.steps.thinking': 'Thinking', 'super.steps.waiting': 'Waiting for you', 'super.steps.working': 'Working' };
    const t = (k: string) => en[k] ?? k;
    const landed = [bash('a', 'dreamcontext tasks list'), bash('b', 'dreamcontext tasks log x "y"')];
    expect(liveLabel(landed, false, t)).toBe('Thinking');
    const running = [...landed, bash('c', 'dreamcontext tasks create "Fix it"', 'running')];
    expect(liveLabel(running, false, t)).toBe(nowStep(running));
    expect(liveLabel(running, false, t).endsWith('…')).toBe(true);
    expect(liveLabel(running, true, t)).toBe('Waiting for you');
  });

  it('reads the turn clock from 0 s, then as the chip does', () => {
    const tr: Record<string, string> = { 'super.steps.seconds': '{n} sn', 'super.steps.minutes': '{n} dk' };
    const t = (k: string) => tr[k] ?? k;
    expect(turnClock(0, t)).toBe('0 sn');
    expect(turnClock(400, t)).toBe('0 sn');
    expect(turnClock(28_300, t)).toBe('28 sn');
    expect(turnClock(125_000, t)).toBe('2 dk 5 sn');
  });

  it('draws no Working pill in the Super view: the live line carries the clock instead', () => {
    const pane = src('dashboard/src/components/sleepy/ChatPane.tsx');
    // The plain Chat keeps its pill; the Super view never draws it.
    expect(pane).toMatch(/\{working && !superView && \(\s*<WorkingIndicator/);
    expect(pane).not.toMatch(/\{working && \(\s*<WorkingIndicator/);
    // With a live steps line as the tail, nothing extra; without one, the same quiet line stands in.
    expect(pane).toContain("const superLineLive = superView && liveTail >= 0 && liveSegments[liveTail].kind === 'run' && accruingAt(liveTail);");
    expect(pane).toMatch(/\{working && superView && !superLineLive && \(\s*<SuperLiveLine/);
    expect(pane).toContain('startedAt={conv.turnStartedAt}');
    const line = src('dashboard/src/components/sleepy/super/SuperStepsLine.tsx');
    expect(line).toContain('const label = live ? liveLabel(items, waiting, t) : parts.join');
    expect(line.match(/className="super-steps-time"/g)).toHaveLength(2);
    // The clock ticks only on the turn's own tail, and the start label is translated.
    expect(line).toContain('useTurnClock(startedAt, stillAccruing && !hidden)');
    expect(pane).toContain("t('super.steps.starting').replace('{tool}'");
    expect(pane).not.toMatch(/<SuperLiveLine[^>]*'Starting /);
    const css = src('dashboard/src/components/sleepy/super/SuperSurface.css');
    expect(css).toContain('.super-steps-time {');
  });
});
