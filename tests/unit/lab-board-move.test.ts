/**
 * Move to board between two STILL-DERIVED boards must not 409.
 *
 * On a derived vault the first write materializes every board (src/lib/lab/boards.ts
 * `materializeWithEdit`). Today a materialized file's rev equals the derived rev
 * (`revOf(serializeBoardSpec(spec))` on both sides), but only while the derivation at that
 * moment is byte-identical to what the client read (prefs or insights changing in between
 * break it). So the client does not lean on it: `moveCardToBoard` awaits the target write
 * (the materializing one) and re-reads the source for its CURRENT rev before the source write.
 *
 * Driven through the real save queue (`createBoardSaver`) against a fake server whose
 * materialize gives every board a NEW rev, the worst case.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/src/context/VaultContext', () => ({ useApi: () => null }));

import { RequestError } from '../../dashboard/src/api/client';
import { createBoardSaver, type BoardSaveSignal } from '../../dashboard/src/hooks/useBoards';
import { MoveBlockedError, moveCardToBoard, specOf } from '../../dashboard/src/components/lab/board/boardEdits';
import type { Board, BoardSpec, Card } from '../../dashboard/src/components/lab/board/boardTypes';

const card = (id: string, x = 0, y = 0): Card => ({ id, at: { x, y, w: 4, h: 3 }, insight: id.slice(2) });

/** A board store with the server's rev rules: rev-checked PUT, derived until the first write. */
function fakeServer() {
  let derived = true;
  let seq = 0;
  const boards = new Map<string, Board>();
  const add = (slug: string, cards: Card[]) => boards.set(slug, {
    slug, title: slug, order: boards.size + 1, cards, body: '', rev: `d-${slug}`, derived: true, error: null, warnings: [],
  });
  add('growth', [card('c-signups'), card('c-mrr', 4)]);
  add('revenue', [card('c-arpu')]);
  const puts: { slug: string; rev: string; status: number }[] = [];

  return {
    puts,
    isDerived: () => derived,
    get: async (slug: string): Promise<Board> => structuredClone(boards.get(slug)!),
    put: async (slug: string, spec: BoardSpec, rev: string): Promise<Board> => {
      const current = boards.get(slug)!;
      if (current.rev !== rev) {
        puts.push({ slug, rev, status: 409 });
        throw new RequestError('rev-conflict', 409, 'rev-conflict');
      }
      if (derived) {
        // Materialize: every board becomes a file, and (worst case) every rev moves.
        derived = false;
        for (const [s, b] of boards) boards.set(s, { ...b, derived: false, rev: `m-${s}-${++seq}` });
      }
      const next: Board = { ...boards.get(slug)!, ...spec, rev: `w-${slug}-${++seq}` };
      boards.set(slug, next);
      puts.push({ slug, rev, status: 200 });
      return structuredClone(next);
    },
  };
}

function setup() {
  const server = fakeServer();
  const signals: BoardSaveSignal[] = [];
  const saver = createBoardSaver({ put: server.put, onSignal: (s) => signals.push(s) });
  const deps = {
    fetchBoard: server.get,
    saveAndWait: saver.saveAndWait,
    idle: saver.idle,
    unsaved: saver.unsaved,
  };
  return { server, saver, signals, deps };
}

describe('a move never drops the source board\'s unsaved edits', () => {
  it('is refused while the source holds a FAILED save (the edits stay pending for Retry)', async () => {
    const { server, saver, deps } = setup();
    const b = await server.get('growth');
    const edited = specOf(b, [...b.cards, card('c-new', 8)]);
    const realPut = server.put;
    let fail = true;
    const flaky = createBoardSaver({ put: (slug, spec, rev) => (fail ? Promise.reject(new RequestError('down', 500, 'x')) : realPut(slug, spec, rev)) });
    await expect(flaky.saveAndWait('growth', edited, b.rev)).rejects.toMatchObject({ status: 500 });
    expect(flaky.status('growth')).toBe('failed');

    const flakyDeps = { ...deps, saveAndWait: flaky.saveAndWait, idle: flaky.idle, unsaved: flaky.unsaved };
    await expect(moveCardToBoard(flakyDeps, 'growth', 'revenue', 'c-signups')).rejects.toBeInstanceOf(MoveBlockedError);
    // Nothing written anywhere, and the failed edit is still there to retry.
    expect(server.puts).toEqual([]);
    expect(flaky.unsaved('growth')?.cards.map((c) => c.id)).toEqual(['c-signups', 'c-mrr', 'c-new']);
    fail = false;
    flaky.retry('growth');
    await flaky.idle('growth');
    expect((await server.get('growth')).cards.map((c) => c.id)).toEqual(['c-signups', 'c-mrr', 'c-new']);
    void saver;
  });

  it('an edit made on the source DURING the move is the base of the source write, not the server copy', async () => {
    const server = fakeServer();
    // The user's racing edit is still on the wire when the move reads the source again.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const saver = createBoardSaver({
      put: async (slug, spec, rev) => {
        if (spec.cards.some((c) => c.id === 'c-late')) await held;
        return server.put(slug, spec, rev);
      },
    });
    const deps = { fetchBoard: server.get, idle: saver.idle, unsaved: saver.unsaved,
      saveAndWait: async (slug: string, spec: BoardSpec, rev: string) => {
        const saved = await saver.saveAndWait(slug, spec, rev);
        const cur = await server.get('growth');
        saver.save('growth', specOf(cur, [...cur.cards, card('c-late', 8)]), cur.rev);
        return saved;
      } };
    const moved = await moveCardToBoard(deps, 'growth', 'revenue', 'c-signups');
    expect(moved!.sourceSpec.cards.map((c) => c.id)).toEqual(['c-mrr', 'c-late']);
    release();
    await saver.idle('growth');
  });
});

describe('a move never drops the TARGET board\'s unsaved edits', () => {
  /** A saver over the fake server whose PUTs for specs holding `holdId` wait for `release()`, or fail while `failing`. */
  function gated(server: ReturnType<typeof fakeServer>, holdId: string) {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const state = { failing: false };
    const saver = createBoardSaver({
      put: async (slug, spec, rev) => {
        if (state.failing) throw new RequestError('down', 503, 'busy');
        if (spec.cards.some((c) => c.id === holdId)) await held;
        return server.put(slug, spec, rev);
      },
    });
    const deps = { fetchBoard: server.get, saveAndWait: saver.saveAndWait, idle: saver.idle, unsaved: saver.unsaved };
    return { saver, deps, release, state };
  }

  it('case A: the target holds a FAILED save (not on screen) -> the move is refused, the edit survives for Retry', async () => {
    const server = fakeServer();
    const { saver, deps, state } = gated(server, 'none');
    const b = await server.get('revenue');
    state.failing = true;
    await expect(saver.saveAndWait('revenue', specOf(b, [...b.cards, card('c-edit', 4)]), b.rev)).rejects.toMatchObject({ status: 503 });
    state.failing = false;

    const err = await moveCardToBoard(deps, 'growth', 'revenue', 'c-signups').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoveBlockedError);
    expect((err as MoveBlockedError).slug).toBe('revenue');
    expect(server.puts).toEqual([]);
    expect(saver.unsaved('revenue')?.cards.map((c) => c.id)).toEqual(['c-arpu', 'c-edit']);
    // Retry still saves it; then the same move goes through and keeps it.
    saver.retry('revenue');
    await saver.idle('revenue');
    const moved = await moveCardToBoard(deps, 'growth', 'revenue', 'c-signups');
    expect(moved!.target.cards.map((c) => c.id)).toEqual(['c-arpu', 'c-edit', 'c-signups']);
  });

  it('case B: the target\'s edit is IN FLIGHT when the move starts -> the move waits for it and keeps it', async () => {
    const server = fakeServer();
    const { saver, deps, release } = gated(server, 'c-edit');
    const b = await server.get('revenue');
    const edit = saver.saveAndWait('revenue', specOf(b, [...b.cards, card('c-edit', 4)]), b.rev);
    const move = moveCardToBoard(deps, 'growth', 'revenue', 'c-signups');
    await new Promise((r) => setTimeout(r, 5));
    release();
    await edit;
    const moved = await move;
    await saver.idle('revenue');
    expect(moved!.target.cards.map((c) => c.id)).toEqual(['c-arpu', 'c-edit', 'c-signups']);
    expect((await server.get('revenue')).cards.map((c) => c.id)).toEqual(['c-arpu', 'c-edit', 'c-signups']);
    expect(server.puts.every((p) => p.status === 200)).toBe(true);
  });

  it('an edit that reaches the target\'s queue after the check is the base of the target write', async () => {
    const server = fakeServer();
    const { saver, deps, release } = gated(server, 'c-late');
    const racing = {
      ...deps,
      fetchBoard: async (slug: string) => {
        const board = await server.get(slug);
        if (slug === 'revenue' && !saver.unsaved('revenue')) saver.save('revenue', specOf(board, [...board.cards, card('c-late', 4)]), board.rev);
        return board;
      },
    };
    const move = moveCardToBoard(racing, 'growth', 'revenue', 'c-signups');
    await new Promise((r) => setTimeout(r, 5));
    release();
    const moved = await move;
    await saver.idle('revenue');
    expect(moved!.target.cards.map((c) => c.id)).toEqual(['c-arpu', 'c-late', 'c-signups']);
  });
});

describe('Move to board across derived boards', () => {
  it('moves without a 409: the target write materializes, the source is re-read for its new rev', async () => {
    const { server, saver, signals, deps } = setup();
    const moved = await moveCardToBoard(deps, 'growth', 'revenue', 'c-signups');
    expect(moved).not.toBeNull();
    expect(server.isDerived()).toBe(false);
    // The source was re-read AFTER materialize: its rev is the materialized one, not `d-growth`.
    expect(moved!.sourceRev).toMatch(/^m-growth-/);
    // What the page then does: save the source spec against that rev.
    await saver.saveAndWait('growth', moved!.sourceSpec, moved!.sourceRev);

    expect(server.puts.map((p) => p.status)).toEqual([200, 200]);
    expect(signals).toEqual([]);
    expect((await server.get('growth')).cards.map((c) => c.id)).toEqual(['c-mrr']);
    expect((await server.get('revenue')).cards.map((c) => c.id)).toEqual(['c-arpu', 'c-signups']);
  });

  it('control: writing the source with the rev read BEFORE the move 409s on this server', async () => {
    const { server, saver, deps } = setup();
    const staleSource = await server.get('growth');
    await moveCardToBoard(deps, 'growth', 'revenue', 'c-signups');
    await expect(
      saver.saveAndWait('growth', specOf(staleSource, staleSource.cards.slice(1)), staleSource.rev),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a target that refuses the write leaves the source untouched (the card never vanishes)', async () => {
    const { server, deps } = setup();
    const failing = { ...deps, saveAndWait: () => Promise.reject(new RequestError('boom', 500, 'board_failed')) };
    await expect(moveCardToBoard(failing, 'growth', 'revenue', 'c-signups')).rejects.toMatchObject({ status: 500 });
    expect(server.puts).toEqual([]);
    expect((await server.get('growth')).cards.map((c) => c.id)).toEqual(['c-signups', 'c-mrr']);
  });

  it('an error board is never a target; a card already gone is a no-op', async () => {
    const { server, deps } = setup();
    const errorTarget = { ...deps, fetchBoard: async (slug: string) => (slug === 'revenue'
      ? { ...(await server.get(slug)), error: { kind: 'conflict' as const, message: 'markers' } }
      : server.get(slug)) };
    await expect(moveCardToBoard(errorTarget, 'growth', 'revenue', 'c-signups')).rejects.toThrow('markers');
    expect(await moveCardToBoard(deps, 'growth', 'revenue', 'c-nope')).toBeNull();
    expect(server.puts).toEqual([]);
  });

  it('saveAndWait settles on 409 with the error, and the conflict signal still fires', async () => {
    const { server, saver, signals } = setup();
    const b = await server.get('growth');
    await expect(saver.saveAndWait('growth', specOf(b), 'wrong-rev')).rejects.toMatchObject({ status: 409 });
    expect(signals).toEqual([{ kind: 'conflict', slug: 'growth' }]);
  });
});
