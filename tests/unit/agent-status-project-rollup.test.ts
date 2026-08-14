/**
 * Unit tests for rollupProject — the project-level counterpart to rollupKind. A background
 * project's chip in the tab strip needs three things at once: what colour to draw (worst-of
 * urgency), what number to badge (how many chats are actually live), and whether to bounce
 * (anything waiting on the user). Each is a distinct rule with its own failure mode, so each
 * gets its own coverage rather than one blended assertion.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveSessionStatus, rollupProject, KIND_RANK,
  type SessionRow, type SessionStatusKind,
} from '../../dashboard/src/components/sleepy/agentStatus.js';

/** Minimal row factory — mirrors tests/unit/agent-status.test.ts's `row()` plus an
 *  `attention` override, since rollupProject's `waiting` count reads that field too. */
function row(
  id: string,
  kind: SessionStatusKind,
  opts: { sessionKind?: SessionRow['kind']; attention?: boolean } = {},
): SessionRow {
  const infoByKind: Record<SessionStatusKind, () => SessionRow['info']> = {
    saved: () => deriveSessionStatus({ dormant: true }),
    starting: () => deriveSessionStatus({ status: 'connecting' }),
    working: () => deriveSessionStatus({ status: 'open', busy: true }),
    asking: () => deriveSessionStatus({ status: 'open', asking: true }),
    ready: () => deriveSessionStatus({ status: 'open' }),
    ended: () => deriveSessionStatus({ status: 'closed' }),
  };
  return {
    id,
    title: id,
    kind: opts.sessionKind ?? 'agent',
    info: infoByKind[kind](),
    attention: opts.attention ?? false,
  };
}

describe('rollupProject', () => {
  it('worst is the KIND_RANK worst-of, same as rollupKind — asking beats working beats ready', () => {
    expect(rollupProject([row('a', 'ready'), row('b', 'working')]).worst).toBe('working');
    expect(rollupProject([row('a', 'working'), row('b', 'asking'), row('c', 'ended')]).worst).toBe('asking');
    // Cross-check directly against KIND_RANK so this doesn't silently drift from the
    // urgency order rollupKind is defined by.
    const rows = [row('a', 'saved'), row('b', 'ready'), row('c', 'starting')];
    const expectedWorst = rows.reduce<SessionStatusKind>(
      (worst, r) => (KIND_RANK[r.info.kind] > KIND_RANK[worst] ? r.info.kind : worst),
      'ended',
    );
    expect(rollupProject(rows).worst).toBe(expectedWorst);
  });

  it('excludes saved rows from live', () => {
    const r = rollupProject([row('a', 'saved'), row('b', 'working')]);
    expect(r.live).toBe(1);
  });

  it('excludes ended rows from live', () => {
    const r = rollupProject([row('a', 'ended'), row('b', 'asking')]);
    expect(r.live).toBe(1);
  });

  it('excludes shell rows from live even when the session is otherwise open/ready', () => {
    const r = rollupProject([
      row('a', 'ready', { sessionKind: 'shell' }),
      row('b', 'working', { sessionKind: 'shell' }),
      row('c', 'ready'),
    ]);
    expect(r.live).toBe(1);
  });

  it('REGRESSION LOCK — a project whose only row is a live shell reports live:0 (badge quiet) but alive:1 (must not be evicted)', () => {
    const r = rollupProject([row('a', 'ready', { sessionKind: 'shell' })]);
    expect(r.live).toBe(0);
    expect(r.alive).toBe(1);
  });

  it('excludes saved and ended rows from alive too', () => {
    const r = rollupProject([row('a', 'saved'), row('b', 'ended'), row('c', 'ready')]);
    expect(r.alive).toBe(1);
  });

  it('a mixed project (one live chat + one live shell) reports live:1, alive:2', () => {
    const r = rollupProject([row('a', 'working'), row('b', 'ready', { sessionKind: 'shell' })]);
    expect(r.live).toBe(1);
    expect(r.alive).toBe(2);
  });

  it('a row that is both asking and attention-flagged counts once in waiting', () => {
    const r = rollupProject([row('a', 'asking', { attention: true })]);
    expect(r.waiting).toBe(1);
  });

  it('attention alone (without asking) still counts toward waiting', () => {
    const r = rollupProject([row('a', 'ready', { attention: true })]);
    expect(r.waiting).toBe(1);
  });

  it('empty input reads as all-zero with worst "ended", matching rollupKind', () => {
    expect(rollupProject([])).toEqual({
      worst: 'ended', live: 0, waiting: 0, alive: 0, asking: 0, working: 0, idle: 0,
    });
  });

  it('a project of only dormant (saved) rows has live: 0 and alive: 0 — no badge, safely evictable', () => {
    const r = rollupProject([row('a', 'saved'), row('b', 'saved')]);
    expect(r.live).toBe(0);
    expect(r.alive).toBe(0);
    expect(r.worst).toBe('saved');
  });
});

/*
 * The chip's three status bubbles. These counts replaced a single dot-plus-badge that could
 * only say HOW MANY chats a project held — never how many were working, how many were blocked
 * on an answer, or that anything was loading. Each rule below is one of those questions, and
 * the partition invariant at the end is what keeps the three of them honest together.
 */
describe('rollupProject — status bubble counts', () => {
  it('splits live rows across the three buckets', () => {
    const r = rollupProject([
      row('a', 'asking'), row('b', 'working'), row('c', 'working'), row('d', 'ready'),
    ]);
    expect(r).toMatchObject({ asking: 1, working: 2, idle: 1 });
  });

  it('starting folds into working — a session attaching its PTY is a session doing something', () => {
    const r = rollupProject([row('a', 'starting'), row('b', 'working')]);
    expect(r.working).toBe(2);
    expect(r.idle).toBe(0);
  });

  it('attention alone lands in asking, not idle — a chat that rang its bell wants you', () => {
    const r = rollupProject([row('a', 'ready', { attention: true })]);
    expect(r).toMatchObject({ asking: 1, working: 0, idle: 0 });
  });

  it('a WORKING row that also rang its bell counts as asking, once — the urgent bucket wins', () => {
    const r = rollupProject([row('a', 'working', { attention: true })]);
    expect(r).toMatchObject({ asking: 1, working: 0, idle: 0 });
    expect(r.live).toBe(1);
  });

  it('saved and ended rows are counted in NO bucket — they are not chats you have', () => {
    const r = rollupProject([row('a', 'saved'), row('b', 'ended'), row('c', 'ready')]);
    expect(r).toMatchObject({ asking: 0, working: 0, idle: 1 });
  });

  it('shells are excluded from every bucket, so a lone dev-server terminal draws no bubble', () => {
    const r = rollupProject([
      row('a', 'working', { sessionKind: 'shell' }),
      row('b', 'ready', { sessionKind: 'shell' }),
    ]);
    expect(r).toMatchObject({ asking: 0, working: 0, idle: 0, live: 0 });
    expect(r.alive).toBe(2); // still holds real PTYs — the ceiling must not evict it
  });

  it('REGRESSION LOCK — a shell ringing its bell moves `waiting` (the bounce) but no bubble', () => {
    // `waiting` and `asking` look redundant and are not: waiting counts every kind so the
    // chip still jumps for a finished build, while the bubbles stay a chat-only partition of
    // `live`. Collapsing the two would either stop the bounce or break the invariant below.
    const r = rollupProject([row('a', 'ready', { sessionKind: 'shell', attention: true })]);
    expect(r.waiting).toBe(1);
    expect(r.asking).toBe(0);
  });

  it('INVARIANT — asking + working + idle === live, across every mix', () => {
    const mixes: SessionRow[][] = [
      [],
      [row('a', 'ready')],
      [row('a', 'asking'), row('b', 'working'), row('c', 'starting'), row('d', 'ready')],
      [row('a', 'saved'), row('b', 'ended'), row('c', 'ready', { attention: true })],
      [row('a', 'working', { sessionKind: 'shell' }), row('b', 'asking'), row('c', 'ready')],
      [row('a', 'asking', { attention: true }), row('b', 'working', { attention: true })],
    ];
    for (const rows of mixes) {
      const r = rollupProject(rows);
      expect(r.asking + r.working + r.idle).toBe(r.live);
    }
  });
});
