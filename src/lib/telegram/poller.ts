/**
 * One long-poll loop for one bot token.
 *
 * - A pid lockfile per token (`acquireFileLock` with pid liveness): the server, the tick and a
 *   second server never poll the same token (Telegram answers a second consumer with 409).
 * - At-least-once delivery, exactly-once effect: an update is confirmed (offset advanced, id in
 *   the `seenIds` ring, poll.json written) only after `onUpdate` accepted it, which for the hub
 *   means "written to the journal or fully handled" (E2). A replayed id is skipped.
 * - Sleep/wake (H10, I5): every response is checked against the time its request was sent
 *   (wall clock vs monotonic); a gap means the Mac slept, so that response's updates are
 *   confirmed WITHOUT processing and the queue is drained (`getUpdates(timeout=0)` until empty).
 *   The same drain runs at start. Nothing sent while the Mac was away is ever processed.
 * - Backoff on network errors; 409 or 401 stops the loop and reports why (the hub raises the
 *   banner and announces the loss, C3).
 */
import { createHash } from 'node:crypto';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { acquireFileLock } from '../file-lock.js';
import { POLL_RING_SIZE, TG_LONG_POLL_TIMEOUT_S, TG_WAKE_GAP_MS, type ManagedBotUpdate, type PollState, type TgUserRef } from './contract.js';
import { telegramBase } from './config.js';
import { TelegramError, type TelegramTransport } from './transport.js';

export interface PollStateIO {
  read(): PollState;
  write(state: PollState): void;
}

/** What the handler did with an update. `accepted` = journaled or handled: confirm it. `retry` =
 *  not yet (the poller keeps the offset and asks again; after 3 tries it is confirmed and dropped). */
export type UpdateDisposition = 'accepted' | 'retry';

export type PollerStop = 'stopped' | 'conflict' | 'unauthorized';

export interface PollerOptions {
  transport: Pick<TelegramTransport, 'getUpdates'>;
  /** sha256(token) names the lock; the token itself never touches the disk here. */
  token: string;
  state: PollStateIO;
  allowedUpdates: readonly string[];
  onUpdate(update: Record<string, unknown>): Promise<UpdateDisposition>;
  /** Updates dropped by a drain (start or wake): counted, never processed. */
  onDrained?(count: number, why: 'start' | 'wake'): void;
  onStop?(why: PollerStop): void;
  home?: string;
  now?: () => number;
  monotonic?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Long-poll wait, seconds (tests pass 0). */
  timeoutS?: number;
}

export function lockPathFor(token: string, home: string = homedir()): string {
  const id = createHash('sha256').update(`telegram-poll:${token}`).digest('hex').slice(0, 16);
  return join(telegramBase(home), 'locks', `${id}.lock`);
}

const LOCK_STALE_MS = 5 * 60_000;
const MAX_TRIES = 3;

/** Remembers an id in a bounded ring. */
function remember(ring: number[], id: number): number[] {
  if (ring.includes(id)) return ring;
  const next = [...ring, id];
  return next.length > POLL_RING_SIZE ? next.slice(-POLL_RING_SIZE) : next;
}

export class TelegramPoller {
  private running = false;
  private ctl: AbortController | null = null;
  private tries = new Map<number, number>();
  private readonly now: () => number;
  private readonly mono: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lockPath: string;
  private holdsLock = false;

  constructor(private readonly o: PollerOptions) {
    this.now = o.now ?? Date.now;
    this.mono = o.monotonic ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.lockPath = lockPathFor(o.token, o.home);
  }

  /** Takes the token's lock. False = another process polls this token. */
  acquire(): boolean {
    if (this.holdsLock) return true;
    this.holdsLock = acquireFileLock(this.lockPath, this.now(), LOCK_STALE_MS, { verifyPidLiveness: true, meta: { what: 'telegram-poll' } });
    return this.holdsLock;
  }

  release(): void {
    if (!this.holdsLock) return;
    try {
      const info = JSON.parse(readFileSync(this.lockPath, 'utf-8')) as { pid?: number };
      if (info.pid === process.pid) rmSync(this.lockPath, { force: true });
    } catch { /* gone */ }
    this.holdsLock = false;
  }

  /** Confirms everything queued WITHOUT processing (start, wake). Returns how many were dropped. */
  async drain(why: 'start' | 'wake'): Promise<number> {
    let state = this.o.state.read();
    let dropped = 0;
    for (let round = 0; round < 50; round++) {
      let batch: Record<string, unknown>[];
      try {
        batch = (await this.o.transport.getUpdates({ offset: state.offset, timeout: 0, allowed_updates: this.o.allowedUpdates })) as Record<string, unknown>[];
      } catch (err) {
        // A 409 during a drain retries instead of stopping the binding (I5).
        if (err instanceof TelegramError && err.code === 409) { await this.sleep(1000); continue; }
        throw err;
      }
      if (!batch.length) break;
      for (const u of batch) {
        const id = Number(u.update_id);
        if (!Number.isSafeInteger(id)) continue;
        state = { ...state, offset: Math.max(state.offset, id + 1), seenIds: remember(state.seenIds, id) };
        dropped++;
      }
      this.o.state.write(state);
    }
    if (dropped) this.o.onDrained?.(dropped, why);
    return dropped;
  }

  /** Handles one response's updates in order, confirming each accepted one. */
  async handle(batch: Record<string, unknown>[]): Promise<void> {
    let state = this.o.state.read();
    for (const u of batch) {
      const id = Number(u.update_id);
      if (!Number.isSafeInteger(id)) continue;
      if (id < state.offset || state.seenIds.includes(id)) {
        state = { ...state, offset: Math.max(state.offset, id + 1) };
        continue;
      }
      let disposition: UpdateDisposition;
      try {
        disposition = await this.o.onUpdate(u);
      } catch {
        disposition = 'retry';
      }
      if (disposition === 'retry') {
        const n = (this.tries.get(id) ?? 0) + 1;
        this.tries.set(id, n);
        if (n < MAX_TRIES) break; // keep the offset: Telegram re-delivers from here
      }
      this.tries.delete(id);
      state = { ...this.o.state.read(), offset: Math.max(state.offset, id + 1) };
      state.seenIds = remember(state.seenIds, id);
      this.o.state.write(state);
    }
    this.o.state.write({ ...this.o.state.read(), offset: Math.max(this.o.state.read().offset, state.offset) });
  }

  /** One request + its handling. Returns false when the loop must stop. */
  async pollOnce(): Promise<boolean> {
    const state = this.o.state.read();
    const wall0 = this.now();
    const mono0 = this.mono();
    this.ctl = new AbortController();
    const batch = (await this.o.transport.getUpdates(
      { offset: state.offset, timeout: this.o.timeoutS ?? TG_LONG_POLL_TIMEOUT_S, allowed_updates: this.o.allowedUpdates },
      this.ctl.signal,
    )) as Record<string, unknown>[];
    if (sleptBetween(wall0, this.now(), mono0, this.mono(), this.o.timeoutS ?? TG_LONG_POLL_TIMEOUT_S)) {
      // The response may carry what was sent while the Mac slept: confirm, never process.
      let s = this.o.state.read();
      for (const u of batch) {
        const id = Number(u.update_id);
        if (Number.isSafeInteger(id)) s = { ...s, offset: Math.max(s.offset, id + 1), seenIds: remember(s.seenIds, id) };
      }
      this.o.state.write(s);
      if (batch.length) this.o.onDrained?.(batch.length, 'wake');
      await this.drain('wake');
      return true;
    }
    await this.handle(batch);
    return true;
  }

  /** The loop. Resolves when stopped; reports why. */
  async run(): Promise<PollerStop> {
    if (!this.acquire()) return 'conflict';
    this.running = true;
    let backoff = 1000;
    let why: PollerStop = 'stopped';
    try {
      let drained = false;
      while (this.running) {
        try {
          if (!drained) { await this.drain('start'); drained = true; }
          await this.pollOnce();
          backoff = 1000;
        } catch (err) {
          if (!this.running) break;
          if (err instanceof TelegramError && err.code === 409) { why = 'conflict'; break; }
          if (err instanceof TelegramError && err.code === 401) { why = 'unauthorized'; break; }
          const wait = err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : backoff;
          await this.sleep(wait);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    } finally {
      this.running = false;
      this.release();
    }
    this.o.onStop?.(why);
    return why;
  }

  stop(): void {
    this.running = false;
    this.ctl?.abort();
  }
}

/**
 * Did the Mac sleep during a request? On macOS the monotonic clock stops while asleep and the
 * wall clock does not: a wall/monotonic difference beyond the gap, or a wall time far past the
 * long-poll wait, means it did. No comparison with message dates (H10).
 */
export function sleptBetween(wall0: number, wall1: number, mono0: number, mono1: number, timeoutS: number = TG_LONG_POLL_TIMEOUT_S): boolean {
  const wall = wall1 - wall0;
  const mono = mono1 - mono0;
  return wall - mono > TG_WAKE_GAP_MS || wall > timeoutS * 1000 + TG_WAKE_GAP_MS;
}

// ─── Managed bots (X1, X3) ──────────────────────────────────────────────────

function userRef(v: unknown): TgUserRef | null {
  if (!v || typeof v !== 'object') return null;
  const u = v as Record<string, unknown>;
  if (!Number.isSafeInteger(u.id)) return null;
  return {
    id: u.id as number,
    ...(typeof u.is_bot === 'boolean' ? { is_bot: u.is_bot } : {}),
    ...(typeof u.first_name === 'string' ? { first_name: u.first_name } : {}),
    ...(typeof u.username === 'string' ? { username: u.username } : {}),
  };
}

/**
 * A `managed_bot` update, normalised; null for anything else or a malformed one. The created bot
 * must be a bot. Field names: `bot` for the new bot, `user` (or `creator` / `from`) for who
 * created it; the spike pins which one Telegram sends.
 */
export function parseManagedBot(update: Record<string, unknown>): ManagedBotUpdate | null {
  const id = Number(update.update_id);
  const m = update.managed_bot;
  if (!Number.isSafeInteger(id) || !m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  const bot = userRef(o.bot ?? o.managed_bot);
  const creator = userRef(o.user ?? o.creator ?? o.from);
  if (!bot || !creator || bot.is_bot === false || creator.is_bot === true || bot.id === creator.id) return null;
  return { updateId: id, bot, creator };
}
