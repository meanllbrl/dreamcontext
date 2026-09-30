/**
 * The board's own sync decisions (plan D6 + r3.2), as BoardPage makes them through
 * `board/boardSync.ts`:
 *
 * - opening an all-fresh board starts NO job;
 * - an automatic job asks for the EXPIRED slugs only, and never carries a `force`;
 * - staleness counts from max(fetchedAt, checkedAt) against the TTL;
 * - a slug whose last run failed within max(TTL, 15 min) is left alone (the server's own
 *   automatic backoff, so the card never flickers "syncing" every minute);
 * - a slug already asked for, or already covered by a running / queued job, is not asked again;
 * - the card's freshness line knows the skip reason (ttl / upstream unchanged).
 *
 * Pure-function tests (no DOM harness in this repo) plus a source check that the page's
 * automatic path is exactly `planAutomaticSync` -> `startSync.mutate(req, …)` with no force.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  automaticSyncRequest, busySlugs, cardSyncState, expiredSlugs, freshReason, inErrorBackoff, isExpired,
  planAutomaticSync, RECHECK_MS,
} from '../../dashboard/src/components/lab/board/boardSync';
import type { InsightSummary, LabSyncJob } from '../../dashboard/src/hooks/useLab';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function summary(slug: string, over: Partial<InsightSummary> = {}): InsightSummary {
  return {
    slug, title: slug, category: null, group: null, render: 'line', size: null, width: null, height: null,
    unit: null, binding: null, latest: 1, fetchedAt: minutesAgo(5), granularity: 'day', error: null, errorAt: null,
    ttlMinutes: 60, staleMinutes: 5, stale: false, checkedAt: null, freshnessNote: null, tweaks: [],
    ...over,
  };
}

function job(over: Partial<LabSyncJob> = {}): LabSyncJob {
  return {
    id: 'j1', status: 'running', done: 0, total: 1, attempt: 1, startedAt: NOW, finishedAt: null,
    results: [], failed: [], error: null, slugs: ['a'], force: null, current: null, ...over,
  };
}

const board = (...list: InsightSummary[]) => Object.fromEntries(list.map((s) => [s.slug, s]));

describe('board open', () => {
  it('an all-fresh board starts zero jobs', () => {
    const all = board(summary('a'), summary('b', { fetchedAt: minutesAgo(59) }), summary('c', { ttlMinutes: 1440, fetchedAt: minutesAgo(600) }));
    expect(expiredSlugs(all, NOW)).toEqual([]);
    expect(planAutomaticSync(all, NOW)).toBeNull();
    expect(automaticSyncRequest([])).toBeNull();
  });

  it('asks for the expired slugs only (never-synced counts as expired)', () => {
    const mixed = board(
      summary('fresh'),
      summary('old', { fetchedAt: minutesAgo(61) }),
      summary('never', { fetchedAt: null }),
      summary('daily', { ttlMinutes: 1440, fetchedAt: minutesAgo(1441) }),
    );
    expect(planAutomaticSync(mixed, NOW)).toEqual({ slugs: ['daily', 'never', 'old'] });
  });

  it('an automatic request never carries a force', () => {
    const req = automaticSyncRequest(['a', 'b']);
    expect(req).toEqual({ slugs: ['a', 'b'] });
    expect(req && 'force' in req).toBe(false);
  });

  it('age counts from the newer of fetchedAt and checkedAt (an upstream-unchanged probe keeps it fresh)', () => {
    const probed = summary('a', { fetchedAt: minutesAgo(600), checkedAt: minutesAgo(10) });
    expect(isExpired(probed, NOW)).toBe(false);
    expect(isExpired(summary('a', { fetchedAt: minutesAgo(600), checkedAt: minutesAgo(61) }), NOW)).toBe(true);
    // A checkedAt OLDER than the fetch never makes data look older than it is.
    expect(isExpired(summary('a', { fetchedAt: minutesAgo(5), checkedAt: minutesAgo(900) }), NOW)).toBe(false);
  });
});

describe('error backoff (same rule as the server: max(TTL, 15 min))', () => {
  it('skips a slug that failed recently, asks again once the window passed', () => {
    const failedNow = summary('a', { fetchedAt: minutesAgo(120), error: 'boom', errorAt: minutesAgo(3), ttlMinutes: 5 });
    expect(inErrorBackoff(failedNow, NOW)).toBe(true);
    expect(expiredSlugs(board(failedNow), NOW)).toEqual([]);
    const failedLongAgo = { ...failedNow, errorAt: minutesAgo(16) };
    expect(inErrorBackoff(failedLongAgo, NOW)).toBe(false);
    expect(expiredSlugs(board(failedLongAgo), NOW)).toEqual(['a']);
  });

  it('a long TTL stretches the window beyond 15 minutes', () => {
    const s = summary('a', { fetchedAt: minutesAgo(2000), errorAt: minutesAgo(100), ttlMinutes: 120 });
    expect(inErrorBackoff(s, NOW)).toBe(true);
    expect(inErrorBackoff({ ...s, errorAt: minutesAgo(121) }, NOW)).toBe(false);
  });
});

describe('re-checks (60 s timer, visibility) do not re-ask', () => {
  it('re-checks every 60 s', () => {
    expect(RECHECK_MS).toBe(60_000);
  });

  it('a slug this page asked for within its window is not asked again', () => {
    const old = board(summary('a', { fetchedAt: minutesAgo(90) }), summary('b', { fetchedAt: minutesAgo(90) }));
    const recent = new Map([['a', NOW - 60_000]]);
    expect(expiredSlugs(old, NOW, { recent })).toEqual(['b']);
    expect(expiredSlugs(old, NOW, { recent: new Map([['a', NOW - 61 * 60_000]]) })).toEqual(['a', 'b']);
  });

  it('slugs a running or queued job covers are left to it; an unscoped job covers everything', () => {
    const old = board(summary('a', { fetchedAt: minutesAgo(90) }), summary('b', { fetchedAt: minutesAgo(90) }));
    expect(expiredSlugs(old, NOW, { busy: busySlugs(job({ slugs: ['a'] }), null) })).toEqual(['b']);
    expect(expiredSlugs(old, NOW, { busy: busySlugs(job({ slugs: ['a'] }), job({ id: 'j2', status: 'queued', slugs: ['b'] })) })).toEqual([]);
    expect(expiredSlugs(old, NOW, { busy: busySlugs(job({ slugs: null }), null) })).toEqual([]);
    // A settled job covers nothing.
    expect(expiredSlugs(old, NOW, { busy: busySlugs(job({ status: 'success', slugs: null }), null) })).toEqual(['a', 'b']);
  });
});

describe('card state', () => {
  it('queued wins over syncing; a settled slug in a running job is no longer syncing', () => {
    const running = job({ slugs: ['a', 'b'], results: [{ slug: 'b', status: 'ok' }] });
    const pending = job({ id: 'j2', status: 'queued', slugs: ['c'] });
    expect(cardSyncState('a', running, pending)).toBe('syncing');
    expect(cardSyncState('b', running, pending)).toBeNull();
    expect(cardSyncState('c', running, pending)).toBe('queued');
    expect(cardSyncState(undefined, running, pending)).toBeNull();
  });

  it('the skip reason: the job said so, or this machine confirmed upstream unchanged after the fetch', () => {
    expect(freshReason(summary('a'), { status: 'fresh', reason: 'ttl' })).toBe('ttl');
    expect(freshReason(summary('a'), { status: 'fresh', reason: 'upstream-unchanged' })).toBe('upstream-unchanged');
    expect(freshReason(summary('a', { fetchedAt: minutesAgo(90), checkedAt: minutesAgo(2) }))).toBe('upstream-unchanged');
    expect(freshReason(summary('a'))).toBeNull();
    expect(freshReason(summary('a'), { status: 'ok' })).toBeNull();
  });
});

describe('BoardPage wiring', () => {
  const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/board/BoardPage.tsx'), 'utf8');

  it('the automatic path is planAutomaticSync -> startSync.mutate(req) with no force', () => {
    const start = src.indexOf('const autoSync = useCallback(');
    const end = src.indexOf('const autoSyncRef', start);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    expect(body).toMatch(/planAutomaticSync\(summaries, now,/);
    expect(body).toMatch(/startSync\.mutate\(req,/);
    expect(body).not.toMatch(/force/);
  });

  it('Sync board is an explicit user request', () => {
    expect(src).toMatch(/startSync\.mutate\(\{ force: 'user', slugs \}/);
  });

  it('re-checks on a 60 s timer and on visibilitychange', () => {
    expect(src).toMatch(/setInterval\(\(\) => autoSyncRef\.current\(\), RECHECK_MS\)/);
    expect(src).toMatch(/addEventListener\('visibilitychange', onVisible\)/);
  });
});
