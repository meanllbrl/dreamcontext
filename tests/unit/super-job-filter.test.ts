/**
 * The agenda's job filter (super-v3 D9, K11): whole turns whose head names the job stay, an open
 * question card's anchor always stays, and only the Super whose stage set it narrows.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inJob, jobTokensOf, keepJobTurns } from '../../dashboard/src/components/sleepy/super/superJobFilter.js';
import { agendaAboutBlock } from '../../dashboard/src/components/sleepy/super/superHandover.js';

const state = {
  pad: [{ id: 'n1', for: 'kidA' }, { id: 'n2', for: 'kidB' }, { id: 'n3' }],
  queue: [{ id: 'q1', sessionId: 'kidA' }, { id: 'q2', sessionId: 'kidB' }],
  containers: [{ id: 'cA', ref: 'kidA' }, { id: 'cB', ref: 'kidB' }],
};
const names = jobTokensOf(state, 'kidA');
const about = (note: string) => `${agendaAboutBlock({ section: 'now', note, text: 'Checkout' })}\nhow is it going?`;

describe('jobTokensOf', () => {
  it('the job, its lines, items and cards; nothing for another job', () => {
    expect([...names].sort()).toEqual(['cA', 'kidA', 'n1', 'q1']);
    expect(jobTokensOf(null, 'kidA').size).toBe(0);
  });
});

describe('inJob and keepJobTurns', () => {
  const items = [
    { id: 'u1', kind: 'user', text: about('n1') },
    { id: 'a1', kind: 'text', text: 'Going well.' },
    { id: 'u2', kind: 'user', text: about('n2') },
    { id: 'a2', kind: 'text', text: 'The other one.' },
    { id: 'u3', kind: 'user', text: '[super events] batch=b1\n- item=q1 child=kidA kind=question' },
    { id: 't3', kind: 'tool', text: '' },
    { id: 'u4', kind: 'user', text: 'Unrelated message' },
    { id: 'a4', kind: 'text', text: 'Answer with a question card' },
  ];
  it('nothing narrowed: the same array', () => {
    expect(keepJobTurns(items, null, new Set(), names)).toBe(items);
  });
  it('an About head naming the job keeps its whole turn, the Super reply with it', () => {
    expect(inJob(items[0], 'kidA', names)).toBe(true);
    expect(inJob(items[2], 'kidA', names)).toBe(false);
    const kept = keepJobTurns(items, 'kidA', new Set(), names).map((x) => x.id);
    expect(kept).toContain('u1');
    expect(kept).toContain('a1');
    expect(kept).not.toContain('u2');
    expect(kept).not.toContain('a2');
    expect(kept).not.toContain('u4');
  });
  it('an open question card anchor is never hidden', () => {
    expect(keepJobTurns(items, 'kidA', new Set(['a4']), names).map((x) => x.id)).toContain('a4');
  });
});

describe('the chat and the stage wiring', () => {
  const root = join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy');
  const pane = readFileSync(join(root, 'ChatPane.tsx'), 'utf-8');
  const surface = readFileSync(join(root, 'super', 'SuperSurface.tsx'), 'utf-8');
  it('only the owning Super chat narrows; Show all clears', () => {
    expect(pane).toContain("useJobFilterFor(session.mode === 'super' && !session.superMirror ? session.claudeId : null)");
    expect(pane).toContain('if (jobFilter) kept = keepJobTurns(kept, jobFilter, new Set(questionCards.keys()));');
    expect(pane).toContain('onClick={() => setJobFilter(null)}');
    expect(surface).toContain('publishJobTokens(jobTokensOf(state, jobFilter), state.session ?? null);');
  });
});
