/** "While you were away" (super-v3 D10, criterion 9): three tiles from the record, the span kept by the window, three chips that do what they say. */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _resetAwaySpans, awayHasAny, awaySummary, finishedOthersText, rememberAwaySpan } from '../../dashboard/src/components/sleepy/super/awaySummary.js';
import { needsOwner } from '../../dashboard/src/components/sleepy/super/superHandover.js';

const D = join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy');
const tiles = readFileSync(join(D, 'super', 'SuperAwayTiles.tsx'), 'utf-8');
const pane = readFileSync(join(D, 'ChatPane.tsx'), 'utf-8');
const surface = readFileSync(join(D, 'super', 'SuperSurface.tsx'), 'utf-8');

const child = (id: string, row: string, at: number, extra: Record<string, unknown> = {}) => ({ sessionId: id, brief: `Job ${id}`, startedAt: 1, row, rowAt: at, ...extra });
const NO = (q: unknown) => needsOwner(q as never);

describe('the away summary', () => {
  beforeEach(() => _resetAwaySpans());

  const record = {
    children: {
      a: child('a', 'done', 500), b: child('b', 'done', 900), c: child('c', 'done', 50),
      d: child('d', 'working', 800), e: child('e', 'working', 700),
      f: child('f', 'working', 600), g: child('g', 'working', 650),
      x: child('x', 'done', 999, { endedAt: 1000 }),
    },
    queue: [
      { id: 'q1', sessionId: 'f', kind: 'question', state: 'escalated', createdAt: 1, ownerText: 'Price?' },
      { id: 'q2', sessionId: 'g', kind: 'permission', state: 'pending', createdAt: 2, requestId: 'r' },
    ],
  };

  it('counts finished since he left, waiting and running, each led by its newest job', () => {
    const s = awaySummary(record, NO, { since: 100, until: 950, viaTelegram: 2 });
    expect(s.finished).toEqual({ n: 2, lead: 'Job b', others: ['Job a'] });
    expect(s.waiting).toMatchObject({ n: 2, lead: 'Job f', commands: 1, more: 0, itemId: 'q1', firstJob: 'f' });
    expect(s.running).toMatchObject({ n: 2, lead: 'Job d', at: 800, firstJob: 'd' });
    expect(s.finishedIds).toEqual(['b', 'a']);
  });

  it('without a known absence every finished job still on the record counts; no job = the ordinary empty state', () => {
    expect(awaySummary(record, NO, null).finished.n).toBe(3);
    expect(awayHasAny(awaySummary({ children: {}, queue: [] }, NO, null))).toBe(false);
  });

  it('keeps the span after the server clears it on his return', () => {
    expect(rememberAwaySpan('s1', { since: 10, until: 20, viaTelegram: 1 })).toEqual({ since: 10, until: 20, viaTelegram: 1 });
    expect(rememberAwaySpan('s1', { since: null })).toEqual({ since: 10, until: 20, viaTelegram: 1 });
    expect(rememberAwaySpan('s2', { since: null })).toBeNull();
  });

  it('names up to two other finished jobs', () => {
    const w = { too: '{names} too', more: 'and {n} more' };
    expect(finishedOthersText(['A', 'B'], w)).toBe('A and B too');
    expect(finishedOthersText(['A', 'B', 'C'], w)).toBe('A, B and 1 more');
    expect(finishedOthersText([], w)).toBe('');
  });
});

describe('the away screen', () => {
  it('is the Mac Super chat\'s empty state, with the ordinary one when there is nothing to tell', () => {
    expect(pane).toContain("<SuperAwayTiles session={session} fallback={<EmptyState />} />");
    expect(tiles).toContain('if (!sum || !awayHasAny(sum)) return <>{fallback}</>;');
  });
  it('no time left: the running tile says when its last step was', () => {
    expect(tiles).toContain("t('super.away.lastStep')");
    expect(tiles).not.toMatch(/minutes left|timeLeft/);
  });
  it('the chips: answer reveals the first waiting question, finished draws their rows, the stage opens', () => {
    expect(tiles).toContain('if (sum.waiting.itemId) revealQuestion(sum.waiting.itemId);');
    expect(tiles).toContain("<JobsView spec={{ type: 'jobs', ids: sum.finishedIds }} session={session} />");
    expect(tiles).toContain("onClick={() => openJobRow('stage')}");
    expect(surface).toContain("if (row === 'stage') { openStageRef.current(); return; }");
  });
});
