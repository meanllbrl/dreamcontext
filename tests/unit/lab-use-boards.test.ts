/**
 * useBoards' save queue and bulk cache read, driven directly (no React): the hooks are thin
 * wrappers over `createBoardSaver`, `fetchCaches` and `seedInsightDetails`.
 *
 * The rules under test (plan D3, r3.2):
 * - ONE PUT in flight per board; edits made during it coalesce into the next PUT, which carries
 *   the rev the previous PUT returned (a drag burst never 409s against itself).
 * - 409: pending edits dropped, the caller refetches, a 'conflict' signal fires (undo clears).
 * - network / 500 / 503: pending edits KEPT and still shown; a 'failed' signal; resent on the
 *   next edit or on retry, never on their own.
 * - `?slugs=` chunked by 60, every entry seeding its per-insight cache query (`useInsightCache`).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/src/context/VaultContext', () => ({ useApi: () => null }));

import { RequestError } from '../../dashboard/src/api/client';
import {
  CACHES_CHUNK, chunkSlugs, createBoardSaver, fetchCaches, legacyInsightSlugs, seedInsightCaches,
  type BoardSaveSignal,
} from '../../dashboard/src/hooks/useBoards';
import type { Board, BoardSpec, Card } from '../../dashboard/src/components/lab/board/boardTypes';

const spec = (n: number): BoardSpec => ({
  title: 'Growth',
  order: 1,
  body: '',
  cards: [{ id: 'c-a', at: { x: 0, y: n, w: 4, h: 3 }, insight: 'a' }],
});

const board = (s: BoardSpec, rev: string): Board => ({
  ...s, slug: 'growth', rev, derived: false, error: null, warnings: [],
});

interface Call {
  spec: BoardSpec;
  rev: string;
  resolve: (rev: string) => void;
  reject: (err: unknown) => void;
}

function harness() {
  const calls: Call[] = [];
  const signals: BoardSaveSignal[] = [];
  const saved: Board[] = [];
  const conflicts: string[] = [];
  const saver = createBoardSaver({
    put: (_slug, s, rev) => new Promise<Board>((resolve, reject) => {
      calls.push({ spec: s, rev, resolve: (next) => resolve(board(s, next)), reject });
    }),
    onSaved: (b) => saved.push(b),
    onConflict: (slug) => conflicts.push(slug),
    onSignal: (s) => signals.push(s),
  });
  return { saver, calls, signals, saved, conflicts };
}

describe('board save queue', () => {
  it('keeps one PUT in flight and coalesces a burst into ONE next PUT with the returned rev', async () => {
    const h = harness();
    h.saver.save('growth', spec(1), 'r1');
    h.saver.save('growth', spec(2), 'r1');
    h.saver.save('growth', spec(3), 'r1');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ rev: 'r1', spec: spec(1) });
    expect(h.saver.status('growth')).toBe('saving');
    expect(h.saver.unsaved('growth')).toEqual(spec(3));

    h.calls[0].resolve('r2');
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    // The middle edit never went on the wire; the newest did, on the rev the first PUT returned.
    expect(h.calls[1]).toMatchObject({ rev: 'r2', spec: spec(3) });

    h.calls[1].resolve('r3');
    await h.saver.idle('growth');
    expect(h.calls).toHaveLength(2);
    expect(h.saved.map((b) => b.rev)).toEqual(['r2', 'r3']);
    expect(h.saver.status('growth')).toBe('idle');
    expect(h.saver.unsaved('growth')).toBeNull();
    expect(h.signals).toEqual([]);
  });

  it('owns the rev while saving: a stale rev from a render that has not caught up is ignored', async () => {
    const h = harness();
    h.saver.save('growth', spec(1), 'r1');
    h.saver.save('growth', spec(2), 'r1'); // queued during the flight, with the caller's (old) rev
    h.calls[0].resolve('r2');
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[1].rev).toBe('r2');
  });

  it('409: drops pending edits, asks for a refetch and signals a conflict', async () => {
    const h = harness();
    h.saver.save('growth', spec(1), 'r1');
    h.saver.save('growth', spec(2), 'r1');
    h.calls[0].reject(new RequestError('changed elsewhere', 409, 'rev_conflict'));
    await h.saver.idle('growth');
    expect(h.calls).toHaveLength(1);
    expect(h.conflicts).toEqual(['growth']);
    expect(h.signals).toEqual([{ kind: 'conflict', slug: 'growth' }]);
    expect(h.saver.unsaved('growth')).toBeNull();
    expect(h.saver.status('growth')).toBe('idle');

    // The next edit starts over on the rev the refetched board carries.
    h.saver.save('growth', spec(5), 'r9');
    expect(h.calls[1]).toMatchObject({ rev: 'r9', spec: spec(5) });
  });

  for (const [name, err, status] of [
    ['network', new TypeError('Failed to fetch'), null],
    ['500', new RequestError('boom', 500, 'x'), 500],
    ['503 (board lock busy)', new RequestError('busy', 503, 'busy'), 503],
  ] as const) {
    it(`${name}: keeps the edits pending and on screen, signals, and resends only on retry`, async () => {
      const h = harness();
      h.saver.save('growth', spec(1), 'r1');
      h.calls[0].reject(err);
      await h.saver.idle('growth');
      expect(h.signals).toEqual([{ kind: 'failed', slug: 'growth', status }]);
      expect(h.saver.status('growth')).toBe('failed');
      expect(h.saver.unsaved('growth')).toEqual(spec(1));
      expect(h.calls).toHaveLength(1); // no retry storm

      h.saver.retry('growth');
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]).toMatchObject({ rev: 'r1', spec: spec(1) });
      h.calls[1].resolve('r2');
      await h.saver.idle('growth');
      expect(h.saver.status('growth')).toBe('idle');
      expect(h.saver.unsaved('growth')).toBeNull();
    });
  }

  it('a failed PUT keeps the NEWER edit made during it, and the next edit resends', async () => {
    const h = harness();
    h.saver.save('growth', spec(1), 'r1');
    h.saver.save('growth', spec(2), 'r1');
    h.calls[0].reject(new RequestError('boom', 500, 'x'));
    await h.saver.idle('growth');
    expect(h.saver.unsaved('growth')).toEqual(spec(2));

    h.saver.save('growth', spec(3), 'r1');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ rev: 'r1', spec: spec(3) });
  });

  it('boards save independently', () => {
    const h = harness();
    h.saver.save('growth', spec(1), 'r1');
    h.saver.save('money', spec(1), 'm1');
    expect(h.calls.map((c) => c.rev)).toEqual(['r1', 'm1']);
  });
});

describe('bulk caches', () => {
  const slugs = Array.from({ length: 130 }, (_, i) => `s-${String(i).padStart(3, '0')}`);

  it('chunks ?slugs= by 60, deduped', () => {
    expect(CACHES_CHUNK).toBe(60);
    const chunks = chunkSlugs([...slugs, ...slugs.slice(0, 5)]);
    expect(chunks.map((c) => c.length)).toEqual([60, 60, 10]);
    expect(chunks.flat()).toEqual(slugs);
    expect(chunkSlugs([])).toEqual([]);
  });

  it('one request per chunk (never one per card), merged, and every entry seeds the per-slug cache', async () => {
    const paths: string[] = [];
    const get = async <T,>(path: string): Promise<T> => {
      paths.push(path);
      const asked = decodeURIComponent(path.split('slugs=')[1]).split(',');
      // The route's shape: summaries + caches; a slug it does not know is absent from both.
      const known = asked.filter((s) => s !== 's-129');
      return {
        summaries: Object.fromEntries(known.map((s) => [s, { slug: s }])),
        caches: Object.fromEntries(known.map((s) => [s, s === 's-000' ? null : { slug: s }])),
      } as T;
    };
    const details = await fetchCaches(get, slugs);
    expect(paths).toHaveLength(3);
    for (const p of paths) {
      expect(p.startsWith('/lab/caches?slugs=')).toBe(true);
      expect(p.split('slugs=')[1].split(',').length).toBeLessThanOrEqual(60);
    }
    expect(Object.keys(details)).toHaveLength(129);
    expect(details['s-001']).toEqual({ summary: { slug: 's-001' }, cache: { slug: 's-001' } });
    expect(details['s-000']).toEqual({ summary: { slug: 's-000' }, cache: null }); // never synced

    const setQueryData = vi.fn();
    seedInsightCaches({ setQueryData } as never, details);
    expect(setQueryData).toHaveBeenCalledTimes(129);
    expect(setQueryData).toHaveBeenCalledWith(['lab', 'caches', 's-001'], details['s-001']);
  });

  it('asks only for the slugs legacy insight blocks draw', () => {
    const cards: Card[] = [
      { id: 'c-a', at: { x: 0, y: 0, w: 4, h: 3 }, insight: 'a' }, // no blocks = one insight block
      { id: 'c-b', at: { x: 4, y: 0, w: 4, h: 3 }, insight: 'b', blocks: [{ type: 'line', data: 'b', options: {} }] },
      { id: 'c-c', at: { x: 8, y: 0, w: 4, h: 3 }, insight: 'c', blocks: [{ type: 'insight', options: {} }] },
      {
        id: 'c-t', at: { x: 0, y: 3, w: 12, h: 3 },
        blocks: [{ type: 'tabs', options: {}, tabs: [{ label: 'x', blocks: [{ type: 'insight', data: 'd', options: {} }] }] }],
      },
    ];
    expect(legacyInsightSlugs(cards)).toEqual(['a', 'c', 'd']);
  });
});
