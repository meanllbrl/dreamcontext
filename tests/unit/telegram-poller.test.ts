/**
 * At-least-once delivery, exactly-once effect; a journal replay after a crash; nothing sent while
 * the Mac slept is processed; one poller per token; managed_bot updates parse (plan E2, H10, I5, X1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramPoller, parseManagedBot, sleptBetween, type PollStateIO, type UpdateDisposition } from '../../src/lib/telegram/poller.js';
import { EMPTY_POLL, readPollState, writePollState, bindingDir } from '../../src/lib/telegram/config.js';
import { TelegramError } from '../../src/lib/telegram/transport.js';
import type { PollState } from '../../src/lib/telegram/contract.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tg-poll-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** A fake Telegram queue: getUpdates returns every update with id >= offset (Telegram's rule). */
function fakeTelegram(ids: number[]) {
  const queue = ids.map((id) => ({ update_id: id, message: { text: `m${id}` } }));
  const calls: { offset?: number; timeout?: number }[] = [];
  return {
    calls,
    queue,
    push(id: number) { queue.push({ update_id: id, message: { text: `m${id}` } }); },
    getUpdates: async (p: { offset?: number; timeout?: number }) => {
      calls.push(p);
      return queue.filter((u) => u.update_id >= (p.offset ?? 0));
    },
  };
}

function diskState(): PollStateIO {
  const dir = bindingDir('abcdef0123456789', 'super', home);
  return { read: () => readPollState(dir, home), write: (s: PollState) => writePollState(dir, s, home) };
}

function memState(init: PollState = { ...EMPTY_POLL, seenIds: [], notifiedIds: [], pending: [] }): PollStateIO & { s: PollState } {
  const box = { s: init, read: () => box.s, write: (s: PollState) => { box.s = { ...s }; } };
  return box;
}

describe('confirmation and replay', () => {
  it('confirms each accepted update, never handles one twice', async () => {
    const tg = fakeTelegram([10, 11, 12]);
    const seen: number[] = [];
    const state = diskState();
    const p = new TelegramPoller({ transport: tg, token: TOKEN, state, allowedUpdates: ['message'], home, timeoutS: 0, onUpdate: async (u) => { seen.push(u.update_id as number); return 'accepted'; } });
    await p.handle(await tg.getUpdates({ offset: 0 }) as never);
    expect(seen).toEqual([10, 11, 12]);
    expect(state.read().offset).toBe(13);
    // Telegram re-delivers (offset lost in flight): replays are skipped by the ring.
    state.write({ ...state.read(), offset: 0 });
    await p.handle(await tg.getUpdates({ offset: 0 }) as never);
    expect(seen).toEqual([10, 11, 12]);
  });

  it('a "retry" keeps the offset (at-least-once) and is dropped after 3 tries', async () => {
    const tg = fakeTelegram([20, 21]);
    const state = memState();
    let tries = 0;
    const handled: number[] = [];
    const p = new TelegramPoller({
      transport: tg, token: TOKEN, state, allowedUpdates: ['message'], home, timeoutS: 0,
      onUpdate: async (u): Promise<UpdateDisposition> => {
        if (u.update_id === 20) { tries++; return 'retry'; }
        handled.push(u.update_id as number);
        return 'accepted';
      },
    });
    await p.handle(await tg.getUpdates({ offset: state.read().offset }) as never);
    expect(state.read().offset).toBe(0);
    expect(handled).toEqual([]);
    await p.handle(await tg.getUpdates({ offset: state.read().offset }) as never);
    await p.handle(await tg.getUpdates({ offset: state.read().offset }) as never);
    expect(tries).toBe(3);
    expect(handled).toEqual([21]);
    expect(state.read().offset).toBe(22);
  });

  it('a thrown handler counts as retry, never as handled', async () => {
    const tg = fakeTelegram([30]);
    const state = memState();
    const p = new TelegramPoller({ transport: tg, token: TOKEN, state, allowedUpdates: ['message'], home, timeoutS: 0, onUpdate: async () => { throw new Error('boom'); } });
    await p.handle(await tg.getUpdates({ offset: 0 }) as never);
    expect(state.read().offset).toBe(0);
  });

  it('journal entries the handler writes survive the confirmation write (crash → replay from the journal)', async () => {
    const tg = fakeTelegram([40]);
    const state = diskState();
    const p = new TelegramPoller({
      transport: tg, token: TOKEN, state, allowedUpdates: ['message'], home, timeoutS: 0,
      onUpdate: async (u) => {
        const s = state.read();
        state.write({ ...s, pending: [...s.pending, { updateId: u.update_id as number, kind: 'text', written: false, at: 1, ref: 'ab12cd' }] });
        return 'accepted';
      },
    });
    await p.handle(await tg.getUpdates({ offset: 0 }) as never);
    // "Crash": a fresh read from disk still has the journal entry and the confirmed offset.
    const after = state.read();
    expect(after.offset).toBe(41);
    expect(after.pending).toEqual([{ updateId: 40, kind: 'text', written: false, at: 1, ref: 'ab12cd' }]);
    expect(JSON.stringify(after)).not.toContain('m40');
  });
});

describe('nothing sent while the Mac was away is processed', () => {
  it('the start drain confirms the backlog without processing it', async () => {
    const tg = fakeTelegram([1, 2, 3]);
    const state = memState();
    const handled: unknown[] = [];
    let drained = 0;
    const p = new TelegramPoller({ transport: tg, token: TOKEN, state, allowedUpdates: ['message'], home, timeoutS: 0, onUpdate: async (u) => { handled.push(u); return 'accepted'; }, onDrained: (n) => { drained += n; } });
    expect(await p.drain('start')).toBe(3);
    expect(handled).toEqual([]);
    expect(drained).toBe(3);
    expect(state.read().offset).toBe(4);
    tg.push(4);
    await p.pollOnce();
    expect(handled.map((u) => (u as { update_id: number }).update_id)).toEqual([4]);
  });

  it('a 1 h poll gap: the response that carries the sleep-time messages is dropped, then drained', async () => {
    const tg = fakeTelegram([5, 6]);
    const state = memState();
    let wall = 0;
    let mono = 0;
    const handled: number[] = [];
    const p = new TelegramPoller({
      transport: { getUpdates: async (q) => { wall += 3_600_000; mono += 10; return tg.getUpdates(q); } },
      token: TOKEN, state, allowedUpdates: ['message'], home, timeoutS: 50,
      now: () => wall, monotonic: () => mono,
      onUpdate: async (u) => { handled.push(u.update_id as number); return 'accepted'; },
    });
    await p.pollOnce();
    expect(handled).toEqual([]);
    expect(state.read().offset).toBe(7);
  });

  it('sleptBetween: wall jumps past monotonic, or a request far past the wait', () => {
    expect(sleptBetween(0, 50_000, 0, 50_000)).toBe(false);
    expect(sleptBetween(0, 3_600_000, 0, 50_000)).toBe(true);
    expect(sleptBetween(0, 400_000, 0, 400_000)).toBe(true);
  });
});

describe('one poller per token, stop reasons', () => {
  it('a second poller on the same token cannot take the lock', () => {
    const a = new TelegramPoller({ transport: fakeTelegram([]), token: TOKEN, state: memState(), allowedUpdates: ['message'], home, onUpdate: async () => 'accepted' });
    const b = new TelegramPoller({ transport: fakeTelegram([]), token: TOKEN, state: memState(), allowedUpdates: ['message'], home, onUpdate: async () => 'accepted' });
    expect(a.acquire()).toBe(true);
    expect(b.acquire()).toBe(false);
    a.release();
    expect(b.acquire()).toBe(true);
    b.release();
  });

  it('409 stops the loop as conflict, 401 as unauthorized, a network error backs off', async () => {
    for (const [code, why] of [[409, 'conflict'], [401, 'unauthorized']] as const) {
      let n = 0;
      const p = new TelegramPoller({
        transport: { getUpdates: async (q: { timeout?: number }) => { if (q.timeout === 0) return []; n++; throw new TelegramError('getUpdates', code, 'x'); } },
        token: TOKEN, state: memState(), allowedUpdates: ['message'], home, timeoutS: 50, sleep: async () => {},
        onUpdate: async () => 'accepted',
      });
      expect(await p.run()).toBe(why);
      expect(n).toBe(1);
    }
    const waits: number[] = [];
    let calls = 0;
    const p = new TelegramPoller({
      transport: { getUpdates: async (q: { timeout?: number }) => { if (q.timeout === 0) return []; calls++; if (calls >= 3) { p.stop(); return []; } throw new TelegramError('getUpdates', 0, 'down'); } },
      token: TOKEN, state: memState(), allowedUpdates: ['message'], home, timeoutS: 50, sleep: async (ms) => { waits.push(ms); },
      onUpdate: async () => 'accepted',
    });
    expect(await p.run()).toBe('stopped');
    expect(waits).toEqual([1000, 2000]);
  });

  it('the start drain: a network error backs off and drains again, a 401 stops as unauthorized', async () => {
    const waits: number[] = [];
    let drains = 0;
    const stops: string[] = [];
    const p = new TelegramPoller({
      transport: { getUpdates: async (q: { timeout?: number }) => {
        if (q.timeout === 0) { drains++; if (drains <= 2) throw new TelegramError('getUpdates', 0, 'offline'); return []; }
        p.stop(); return [];
      } },
      token: TOKEN, state: memState(), allowedUpdates: ['message'], home, timeoutS: 50, sleep: async (ms) => { waits.push(ms); },
      onUpdate: async () => 'accepted', onStop: (why) => stops.push(why),
    });
    await expect(p.run()).resolves.toBe('stopped');
    expect(waits).toEqual([1000, 2000]);
    expect(stops).toEqual(['stopped']);
    const q = new TelegramPoller({
      transport: { getUpdates: async () => { throw new TelegramError('getUpdates', 401, 'Unauthorized'); } },
      token: TOKEN, state: memState(), allowedUpdates: ['message'], home, timeoutS: 50, sleep: async () => {},
      onUpdate: async () => 'accepted', onStop: (why) => stops.push(why),
    });
    await expect(q.run()).resolves.toBe('unauthorized');
    expect(stops).toEqual(['stopped', 'unauthorized']);
  });
});

describe('managed_bot updates', () => {
  it('parses the new bot and its creator, both spellings', () => {
    expect(parseManagedBot({ update_id: 9, managed_bot: { bot: { id: 5, is_bot: true, username: 'x_bot' }, user: { id: 42, first_name: 'M' } } }))
      .toEqual({ updateId: 9, bot: { id: 5, is_bot: true, username: 'x_bot' }, creator: { id: 42, first_name: 'M' } });
    expect(parseManagedBot({ update_id: 9, managed_bot: { bot: { id: 5 }, creator: { id: 42 } } })?.creator.id).toBe(42);
  });
  it('refuses a malformed one: no creator, a bot creator, a human "bot", same id, not a managed_bot', () => {
    expect(parseManagedBot({ update_id: 9, managed_bot: { bot: { id: 5 } } })).toBeNull();
    expect(parseManagedBot({ update_id: 9, managed_bot: { bot: { id: 5 }, user: { id: 6, is_bot: true } } })).toBeNull();
    expect(parseManagedBot({ update_id: 9, managed_bot: { bot: { id: 5, is_bot: false }, user: { id: 6 } } })).toBeNull();
    expect(parseManagedBot({ update_id: 9, managed_bot: { bot: { id: 5 }, user: { id: 5 } } })).toBeNull();
    expect(parseManagedBot({ update_id: 9, message: {} })).toBeNull();
  });
});
