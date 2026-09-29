import { describe, it, expect } from 'vitest';
import {
  countMoments,
  parseRegistrySids,
  percentiles,
  selectSessions,
} from '../../eval/sleep-debt/rescore.js';

const SID_A = '11111111-2222-4333-8444-555555555555';
const SID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('parseRegistrySids', () => {
  it('reads every spawned / resumed / respawned registry line, deduped', () => {
    const md = [
      `- w1-A spawned sid ${SID_A} pid 93679 cfg -`,
      `- w1-A resumed sid ${SID_A} pid 7768 cfg -`,
      `- w2-B respawned sid ${SID_B} pid 12 cfg /tmp/acct`,
    ].join('\n');
    expect(parseRegistrySids(md).sort()).toEqual([SID_A, SID_B].sort());
  });

  it('ignores prose that merely mentions a session id', () => {
    expect(parseRegistrySids(`the lead's session ${SID_A} ran long`)).toEqual([]);
    expect(parseRegistrySids(`w1-A done`)).toEqual([]);
  });
});

describe('selectSessions', () => {
  const history = [
    { consolidated_at: '2026-06-10T12:00:00.000Z', session_ids: ['s1', 's2', 's1'] },
    { consolidated_at: '2026-06-08T09:00:00.000Z', session_ids: ['s0'] },
  ];
  const ledger = {
    last_consolidated_at: '2026-06-10T12:00:00.000Z',
    sessions: [
      { session_id: 's3', transcript_path: '/p/s3.jsonl', spawn: { by: 'develop', via: 'env' } },
      { session_id: 's2', transcript_path: '/p/s2.jsonl' },
    ],
  };

  it('bounds the chosen history entry at the NEXT-older consolidation, then adds the ledger', () => {
    const { sessions, consolidatedAt, sinceISO } = selectSessions(history, ledger, 0);
    expect(consolidatedAt).toBe('2026-06-10T12:00:00.000Z');
    expect(sinceISO).toBe('2026-06-08T09:00:00.000Z');
    expect(sessions.map(s => [s.sessionId, s.source, s.sinceISO])).toEqual([
      ['s1', 'history', '2026-06-08T09:00:00.000Z'],
      ['s2', 'history', '2026-06-08T09:00:00.000Z'],
      ['s3', 'ledger', '2026-06-10T12:00:00.000Z'],
    ]);
    expect(sessions[2].storedSpawn).toEqual({ by: 'develop', via: 'env' });
    expect(sessions[2].transcriptPath).toBe('/p/s3.jsonl');
  });

  it('the oldest entry has no bound; malformed input yields nothing, never a throw', () => {
    expect(selectSessions(history, null, 1).sessions.map(s => [s.sessionId, s.sinceISO])).toEqual([['s0', null]]);
    expect(selectSessions('nope', 42, 0).sessions).toEqual([]);
    expect(selectSessions([{ session_ids: [7, null, ''] }], { sessions: [null, {}] }, 0).sessions).toEqual([]);
  });
});

describe('countMoments', () => {
  it('separates corrections, brief-shaped corrections and decisions', () => {
    const counts = countMoments([
      { message: 'User correction: no, use the staging endpoint', salience: 2 },
      { message: 'User correction: You are builder w1-A on task demo-task', salience: 2 },
      { message: 'User correction: Review wave 2 of demo-task', salience: 2 },
      { message: 'Decision: we decided to keep the cache', salience: 2 },
      { message: 'Error resolved by code change: boom', salience: 1 },
    ]);
    expect(counts).toEqual({ corrections: 3, decisions: 1, briefShaped: 2 });
  });
});

describe('percentiles', () => {
  it('nearest-rank over an unsorted input; empty is all zeros', () => {
    const p = percentiles([5, 1, 3, 2, 4, 6, 8, 7, 10, 9]);
    expect(p.p50).toBe(6);
    expect(p.p10).toBe(2);
    expect(p.p95).toBe(10);
    expect(percentiles([])).toEqual({ p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0 });
  });
});
