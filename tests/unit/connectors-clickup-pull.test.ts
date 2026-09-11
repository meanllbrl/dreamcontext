import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { applyCaps, pullConnector } from '../../src/lib/connectors/clickup-pull.js';
import {
  consumeConnectorEvents,
  createConnector,
  readConnectorCache,
} from '../../src/lib/connectors/store.js';
import type { ConnectorEvent, ConnectorManifest } from '../../src/lib/connectors/types.js';

const NOW = Date.parse('2026-08-07T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-connectors-pull-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface FakeTask {
  id: string;
  name: string;
  date_created: string;
  date_updated: string;
}
interface FakeComment {
  id: string;
  comment_text: string;
  date: string;
  user?: { username: string };
}

/**
 * In-memory ClickUp v2 fake: honours `date_updated_gt` on the list endpoint
 * (the cursor contract under test) and records every request.
 */
function fakeClickUp(data: {
  lists: Record<string, FakeTask[]>;
  comments: Record<string, FakeComment[]>;
  failLists?: string[];
}) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url });
    const u = new URL(url);

    const listMatch = u.pathname.match(/\/list\/([^/]+)\/task$/);
    if (listMatch) {
      const listId = listMatch[1];
      if (data.failLists?.includes(listId)) {
        return new Response('boom', { status: 500 });
      }
      const since = Number(u.searchParams.get('date_updated_gt') ?? 0);
      const tasks = (data.lists[listId] ?? []).filter((t) => Number(t.date_updated) > since);
      return new Response(JSON.stringify({ tasks, last_page: true }), { status: 200 });
    }

    const commentMatch = u.pathname.match(/\/task\/([^/]+)\/comment$/);
    if (commentMatch) {
      return new Response(JSON.stringify({ comments: data.comments[commentMatch[1]] ?? [] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };

  let t = 0;
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.test/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl,
    now: () => t,
    sleep: async (ms) => { t += ms; },
  });
  return { adapter, calls };
}

function makeManifest(): ConnectorManifest {
  return createConnector(root, {
    slug: 'clickup-team',
    title: 'Team ClickUp',
    lists: [
      { id: 'L1', name: 'Alpha' },
      { id: 'L2', name: 'Beta' },
    ],
  });
}

const server = () => fakeClickUp({
  lists: {
    L1: [{ id: 't1', name: 'Task One', date_created: String(NOW - DAY), date_updated: String(NOW - HOUR) }],
    L2: [{ id: 't2', name: 'Task Two', date_created: String(NOW - 30 * DAY), date_updated: String(NOW - 2 * HOUR) }],
  },
  comments: {
    t1: [
      { id: 'c1', comment_text: 'hello', date: String(NOW - HOUR), user: { username: 'anil' } },
      { id: 'c0', comment_text: 'ancient', date: String(NOW - 30 * DAY), user: { username: 'anil' } },
    ],
    t2: [{ id: 'c2', comment_text: 'yo', date: String(NOW - 2 * HOUR), user: { username: 'mehmet' } }],
  },
});

describe('pullConnector', () => {
  it('pulls every list, emitting comments + new-task context only', async () => {
    const manifest = makeManifest();
    const { adapter, calls } = server();

    const outcome = await pullConnector(root, manifest, { cycle: 4, deps: { adapter, nowMs: () => NOW } });

    expect(outcome.error).toBeNull();
    expect(outcome.added).toBe(3);
    const cache = readConnectorCache(root, 'clickup-team');
    const ids = cache.events.map((e) => e.id).sort();
    // t1 was created inside the window → context event; t2 was not (only its
    // fresh comment lands). The ancient comment c0 stays outside the cursor.
    expect(ids).toEqual(['t1:c:c1', 't1:created', 't2:c:c2']);
    const comment = cache.events.find((e) => e.id === 't1:c:c1')!;
    expect(comment).toMatchObject({ kind: 'comment', list: 'Alpha', task: 'Task One', author: 'anil', text: 'hello' });
    expect(comment.link).toBe('https://app.clickup.com/t/t1');

    // Per-list cursors advanced to each list's own watermark.
    expect(cache.cursors.L1).toBe(NOW - HOUR);
    expect(cache.cursors.L2).toBe(NOW - 2 * HOUR);
    expect(cache.pulledCycle).toBe(4);
    expect(cache.history).toHaveLength(1);

    // Read-only contract: a pull never issues anything but GETs.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('re-pull adds nothing new, re-offers unconsumed events, and drains after consume', async () => {
    const manifest = makeManifest();
    await pullConnector(root, manifest, { cycle: 4, deps: { adapter: server().adapter, nowMs: () => NOW } });

    const second = await pullConnector(root, manifest, { cycle: 5, deps: { adapter: server().adapter, nowMs: () => NOW + HOUR } });
    expect(second.added).toBe(0);
    expect(second.pending).toBe(3); // aborted cycles re-offer, nothing is lost

    expect(consumeConnectorEvents(root, 'clickup-team')).toBe(3);
    const third = await pullConnector(root, manifest, { cycle: 6, deps: { adapter: server().adapter, nowMs: () => NOW + 2 * HOUR } });
    expect(third.pending).toBe(0);
  });

  it('isolates a failing list: others pull, its cursor stays put', async () => {
    const manifest = makeManifest();
    const broken = fakeClickUp({
      lists: { L1: [{ id: 't1', name: 'Task One', date_created: String(NOW - DAY), date_updated: String(NOW - HOUR) }] },
      comments: { t1: [{ id: 'c1', comment_text: 'hello', date: String(NOW - HOUR), user: { username: 'anil' } }] },
      failLists: ['L2'],
    });

    const outcome = await pullConnector(root, manifest, { cycle: 1, deps: { adapter: broken.adapter, nowMs: () => NOW } });

    expect(outcome.added).toBe(2);
    expect(outcome.error).toContain('Beta');
    expect(outcome.perList.find((l) => l.id === 'L1')?.error).toBeNull();
    expect(outcome.perList.find((l) => l.id === 'L2')?.error).toBeTruthy();

    const cache = readConnectorCache(root, 'clickup-team');
    expect(cache.cursors.L1).toBe(NOW - HOUR);
    expect(cache.cursors.L2).toBeUndefined(); // failed window re-offers next pull
    expect(cache.error).toContain('Beta');
  });

  it('never advances the cursor past an unprocessed task — an over-cap window drains across pulls without loss', async () => {
    // 60 tasks updated inside the window, newest-first from the server (the
    // pull must not trust remote ordering). The per-pull cap is 50: pull #1
    // processes the OLDEST 50, pull #2 drains the newest 10 — nothing skipped.
    const many: FakeTask[] = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      name: `Task ${i}`,
      date_created: String(NOW - DAY + i * 1000),
      date_updated: String(NOW - DAY + i * 1000),
    })).reverse();
    const bigServer = () => fakeClickUp({ lists: { L1: many, L2: [] }, comments: {} });
    const manifest = createConnector(root, {
      slug: 'busy',
      title: 'Busy',
      lists: [{ id: 'L1', name: 'Alpha' }, { id: 'L2', name: 'Beta' }],
    });
    // Caps must not eat the backlog while it drains.
    manifest.caps = { max_events: 200, max_chars: 100_000 };

    const first = await pullConnector(root, manifest, { cycle: 1, deps: { adapter: bigServer().adapter, nowMs: () => NOW } });
    expect(first.added).toBe(50);
    expect(first.perList.find((l) => l.id === 'L1')?.truncated).toBe(true);
    // Cursor = newest PROCESSED task, not the newest task in the window.
    expect(readConnectorCache(root, 'busy').cursors.L1).toBe(NOW - DAY + 49 * 1000);

    const second = await pullConnector(root, manifest, { cycle: 2, deps: { adapter: bigServer().adapter, nowMs: () => NOW } });
    expect(second.added).toBe(10);
    const ids = new Set(readConnectorCache(root, 'busy').events.map((e) => e.id));
    expect(ids.size).toBe(60); // full window covered, no silent loss
  });

  it('sends the stored cursor as date_updated_gt on the next pull', async () => {
    const manifest = makeManifest();
    await pullConnector(root, manifest, { cycle: 1, deps: { adapter: server().adapter, nowMs: () => NOW } });

    const { adapter, calls } = server();
    await pullConnector(root, manifest, { cycle: 2, deps: { adapter, nowMs: () => NOW + HOUR } });
    const listCalls = calls.filter((c) => c.url.includes('/list/'));
    expect(listCalls.length).toBe(2);
    for (const c of listCalls) {
      const since = Number(new URL(c.url).searchParams.get('date_updated_gt'));
      expect([NOW - HOUR, NOW - 2 * HOUR]).toContain(since);
    }
  });
});

describe('applyCaps', () => {
  function ev(id: string, tOffset: number, text = 'x'.repeat(10)): ConnectorEvent {
    return { id, t: new Date(NOW + tOffset).toISOString(), kind: 'comment', list: 'L', task: 'T', author: null, text, link: null };
  }

  it('drops the OLDEST events past max_events', () => {
    const { kept, dropped } = applyCaps([ev('a', 0), ev('b', 1), ev('c', 2), ev('d', 3)], { max_events: 2, max_chars: 1000 });
    expect(kept.map((e) => e.id)).toEqual(['c', 'd']);
    expect(dropped).toBe(2);
  });

  it('enforces the total char budget but always keeps the newest event', () => {
    const { kept, dropped } = applyCaps([ev('a', 0), ev('b', 1), ev('c', 2)], { max_events: 100, max_chars: 15 });
    expect(kept.map((e) => e.id)).toEqual(['c']);
    expect(dropped).toBe(2);
  });
});
