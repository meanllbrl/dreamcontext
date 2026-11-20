/**
 * The `jobs` view (plan super-v3 K7, D6): the block names at most which jobs, the rows come from
 * the record (waiting first, then running, stuck, done; newest first inside), an ended child is no
 * job, and nothing anywhere draws a time-left estimate (D4).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseViewBlock } from '../../src/lib/chat-view-spec.js';
import { jobsRows, jobsLines } from '../../src/lib/super/jobs-view.js';
import { needsOwnerItem } from '../../src/lib/super/owner-needs.js';

const now = 1_800_000_000_000;
const kid = (id: string, brief: string, row: string, at: number, extra: Record<string, unknown> = {}) =>
  ({ sessionId: id, brief, adopted: false, startedAt: at - 1000, row, rowAt: at, ...extra });
const state = {
  children: {
    a: kid('a', 'Checkout screen in one step', 'working', now - 60_000),
    b: kid('b', 'Yearly plan price', 'asking', now - 120_000),
    c: kid('c', 'Login bug', 'done', now - 30_000),
    d: kid('d', 'Old job', 'working', now - 10_000, { endedAt: now - 5_000 }),
    e: kid('e', 'Reminder notifications', 'working', now - 5_000),
  },
  queue: [{ id: 'q1', sessionId: 'b', kind: 'question', state: 'escalated', createdAt: now - 100_000, ownerText: 'Which price: 990 or 1,190?' }],
  team: [],
  containers: [{ kind: 'chat', ref: 'a', title: 'Pocket Ledger checkout' }],
};
const needs = needsOwnerItem as (q: unknown) => boolean;

describe('the jobs block', () => {
  it('parses bare and with ids; a block that lists jobs itself is told its rows were ignored', () => {
    expect(parseViewBlock('{"type":"jobs"}').view).toEqual({ type: 'jobs' });
    expect(parseViewBlock('{"type":"jobs","ids":["a","b"]}').view).toEqual({ type: 'jobs', ids: ['a', 'b'] });
    const r = parseViewBlock('{"type":"jobs","rows":[{"name":"x","eta":"~6 min"}],"ids":["../x","a"]}');
    expect(r.view).toEqual({ type: 'jobs', ids: ['a'] });
    expect(r.notices.join(' ')).toMatch(/reads every job from the Super record/);
    expect(r.notices.join(' ')).toMatch(/not a job id/);
  });
});

describe('jobsRows', () => {
  it('rows equal the record: waiting first, then running newest first, then done; ended left out', () => {
    const s = jobsRows(state, needs);
    expect(s.rows.map((r) => r.id)).toEqual(['b', 'e', 'a', 'c']);
    expect(s).toMatchObject({ total: 4, waiting: 1, running: 2, done: 1 });
    expect(s.rows[0]).toMatchObject({ state: 'waiting', itemId: 'q1', waitingOn: 'Which price: 990 or 1,190?' });
    expect(s.rows.find((r) => r.id === 'a')?.name).toBe('Pocket Ledger checkout');
  });
  it('ids narrow the rows', () => {
    expect(jobsRows(state, needs, ['c', 'zz']).rows.map((r) => r.id)).toEqual(['c']);
  });
  it('a member job and its approval: the member row waits', () => {
    const s = jobsRows({ ...state, children: {}, queue: [{ id: 'qa', sessionId: 'sup', kind: 'approval', member: 'sage', state: 'escalated', createdAt: now }],
      team: [{ id: 'team-sage', member: 'sage', brief: 'Price scan', startedAt: now, open: true }] }, needs);
    expect(s.rows).toEqual([expect.objectContaining({ id: 'team-sage', kind: 'member', state: 'waiting', waitingOn: 'approval' })]);
  });
  it('Telegram: at most 5 lines, waiting first, the rest counted', () => {
    const many = { ...state, children: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, kid(`k${i}`, `Job ${i}`, 'working', now - i)])) };
    const lines = jobsLines(jobsRows({ ...many, children: { ...many.children, b: state.children.b } }, needs), 5);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^✋ Yearly plan price: Which price/);
    expect(lines[5]).toBe('+4');
  });
});

describe('no time left anywhere (D4)', () => {
  it('the jobs view and its model draw no "~N min" estimate', () => {
    const root = join(__dirname, '..', '..');
    const files = [join(root, 'src/lib/super/jobs-view.ts'), join(root, 'dashboard/src/components/sleepy/chat/JobsView.tsx')];
    for (const f of files) expect(readFileSync(f, 'utf-8')).not.toMatch(/~\s*\d+\s*min|left\b.*min|eta/i);
    const i18n = readFileSync(join(root, 'dashboard/src/context/I18nContext.tsx'), 'utf-8');
    expect(i18n.split('\n').filter((l) => /'super\.jobs\./.test(l)).join('\n')).not.toMatch(/~\s*\{?\w*\}?\s*min|left/i);
    expect(readdirSync(join(root, 'dashboard/src/components/sleepy/chat'))).toContain('JobsView.tsx');
  });
});
