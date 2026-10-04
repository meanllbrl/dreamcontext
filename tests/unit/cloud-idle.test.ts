import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudIdle, IDLE_AFTER_MS, QUIESCE_REVERT_MS, QUIESCING_CAP_MS, STOP_REQUEST_FILE, TRANSFER_GRACE_MS, TURN_CAP_MS,
  computeStopAt, quiescingVerdict, type IdleInputs,
} from '../../src/server/cloud-idle.js';
import type { CloudPhase } from '../../src/server/cloud-mode.js';
import type { LiveChatSnapshotEntry } from '../../src/server/routes/agent-chat-live.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function inputs(over: Partial<IdleInputs> = {}): IdleInputs {
  return {
    now: T0, bootAt: T0, lastActionAt: null, lastTurnEndAt: null, busyTurnStarts: [], lastTransferAt: null,
    installStarts: [], phase: 'active', goingSince: null, quiescingSince: null, ...over,
  };
}

describe('computeStopAt (D14 schedule)', () => {
  it('a fresh boot sleeps 15 min after the boot', () => {
    expect(computeStopAt(inputs())).toBe(T0 + IDLE_AFTER_MS);
  });

  it('counts from the LATER of the last action and the last turn end', () => {
    expect(computeStopAt(inputs({ now: T0 + 30 * MIN, lastActionAt: T0 + 20 * MIN, lastTurnEndAt: T0 + 10 * MIN }))).toBe(T0 + 35 * MIN);
    expect(computeStopAt(inputs({ now: T0 + 30 * MIN, lastActionAt: T0 + 5 * MIN, lastTurnEndAt: T0 + 25 * MIN }))).toBe(T0 + 40 * MIN);
  });

  it('a live turn defers it, but never past 2 h from that turn\'s start', () => {
    const start = T0 + 10 * MIN;
    const during = inputs({ now: T0 + 90 * MIN, busyTurnStarts: [start] });
    expect(computeStopAt(during)).toBeGreaterThan(during.now);
    const after = inputs({ now: start + TURN_CAP_MS + MIN, busyTurnStarts: [start] });
    expect(computeStopAt(after)).toBeLessThanOrEqual(after.now);
    expect(computeStopAt(after)).toBe(Math.max(T0 + IDLE_AFTER_MS, start + TURN_CAP_MS));
  });

  it('a transfer keeps it up for its grace after the last byte', () => {
    const at = T0 + 40 * MIN;
    expect(computeStopAt(inputs({ now: at, lastTransferAt: at - MIN }))).toBe(at - MIN + TRANSFER_GRACE_MS);
    expect(computeStopAt(inputs({ now: at, lastTransferAt: at - 10 * MIN }))).toBeLessThanOrEqual(at);
  });

  it('quiescing defers it at most 2 h; an install and phase going defer it too', () => {
    const q = T0 + 5 * MIN;
    expect(computeStopAt(inputs({ now: T0 + 60 * MIN, phase: 'quiescing', quiescingSince: q }))).toBeGreaterThan(T0 + 60 * MIN);
    expect(computeStopAt(inputs({ now: q + QUIESCING_CAP_MS + MIN, phase: 'quiescing', quiescingSince: q }))).toBe(q + QUIESCING_CAP_MS);
    expect(computeStopAt(inputs({ now: T0 + 60 * MIN, installStarts: [T0 + 30 * MIN] }))).toBeGreaterThan(T0 + 60 * MIN);
    expect(computeStopAt(inputs({ now: T0 + 60 * MIN, goingSince: T0 + 50 * MIN, phase: 'sealed' }))).toBeGreaterThan(T0 + 60 * MIN);
  });
});

describe('quiescingVerdict (AC13 + the 2 h backstop)', () => {
  const base = { phase: 'quiescing' as CloudPhase, quiescingSince: T0 };
  it('reverts after 30 min without laptop progress ONLY while the snapshot was never served', () => {
    expect(quiescingVerdict({ ...base, now: T0 + QUIESCE_REVERT_MS, served: false, lastLaptopProgressAt: T0 })).toBe('revert');
    expect(quiescingVerdict({ ...base, now: T0 + QUIESCE_REVERT_MS, served: true, lastLaptopProgressAt: T0 })).toBe('none');
    expect(quiescingVerdict({ ...base, now: T0 + QUIESCE_REVERT_MS, served: false, lastLaptopProgressAt: T0 + 20 * MIN })).toBe('none');
  });
  it('a recovery quiesce never reverts', () => {
    expect(quiescingVerdict({ ...base, now: T0 + QUIESCE_REVERT_MS, served: false, lastLaptopProgressAt: T0, noRevert: true })).toBe('none');
  });
  it('seals itself after 2 h when served and the laptop made no progress', () => {
    expect(quiescingVerdict({ ...base, now: T0 + QUIESCING_CAP_MS, served: true, lastLaptopProgressAt: T0 + 10 * MIN })).toBe('seal');
    expect(quiescingVerdict({ ...base, now: T0 + QUIESCING_CAP_MS, served: true, lastLaptopProgressAt: T0 + QUIESCING_CAP_MS - MIN })).toBe('none');
    expect(quiescingVerdict({ phase: 'active', quiescingSince: null, now: T0 + QUIESCING_CAP_MS, served: true, lastLaptopProgressAt: null })).toBe('none');
  });
});

describe('CloudIdle (injected clock)', () => {
  let dir: string;
  let now: number;
  let live: LiveChatSnapshotEntry[];
  let trip: { phase: CloudPhase; goingSince: number | null; quiescingSince: number | null; servedEpoch: number | null; epoch: number; lastLaptopProgressAt: number | null };
  let reverted: number;
  let sealed: number;

  const make = () => new CloudIdle({
    now: () => now,
    liveChats: () => live,
    trip: () => trip,
    onRevert: () => { reverted++; trip = { ...trip, phase: 'active', quiescingSince: null }; },
    onSeal: () => { sealed++; trip = { ...trip, phase: 'sealed', quiescingSince: null }; },
    publicDir: dir,
    bootId: 'boot-1',
  });
  const request = () => join(dir, STOP_REQUEST_FILE);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloud-idle-'));
    now = T0;
    live = [];
    trip = { phase: 'active', goingSince: null, quiescingSince: null, servedEpoch: null, epoch: 1, lastLaptopProgressAt: null };
    reverted = 0;
    sealed = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the boot-tied stop request 15 min after the last real action, not before', () => {
    const idle = make();
    now = T0 + 10 * MIN;
    idle.recordAction();
    now = T0 + 24 * MIN;
    idle.tick();
    expect(existsSync(request())).toBe(false);
    now = T0 + 25 * MIN;
    idle.tick();
    const [due, boot] = readFileSync(request(), 'utf-8').trim().split(' ');
    expect(boot).toBe('boot-1');
    expect(Number(due)).toBe(Math.floor((T0 + 25 * MIN) / 1000));
  });

  it('keeps its own last-turn-end: a reaped busy child still counts as a turn that just ended', () => {
    const idle = make();
    live = [{ conversationId: 'c1', projectRoot: '/p', busy: true, turnStartedAt: T0 + MIN, lastTurnEndedAt: null }];
    now = T0 + 20 * MIN;
    idle.tick();
    expect(existsSync(request())).toBe(false);
    live = []; // reaped: it left the snapshot without a turn end
    now = T0 + 30 * MIN;
    idle.tick();
    expect(existsSync(request())).toBe(false);
    now = T0 + 45 * MIN;
    idle.tick();
    expect(existsSync(request())).toBe(true);
  });

  it('a turn that runs past 2 h is no longer a reason to stay up', () => {
    const idle = make();
    live = [{ conversationId: 'c1', projectRoot: '/p', busy: true, turnStartedAt: T0, lastTurnEndedAt: null }];
    now = T0 + TURN_CAP_MS - MIN;
    idle.tick();
    expect(existsSync(request())).toBe(false);
    now = T0 + TURN_CAP_MS;
    idle.tick();
    expect(existsSync(request())).toBe(true);
  });

  it('a transfer in flight defers it; its end starts the grace', () => {
    const idle = make();
    now = T0 + 14 * MIN;
    const done = idle.transferBegin();
    now = T0 + 40 * MIN;
    idle.tick();
    expect(existsSync(request())).toBe(false);
    done();
    now = T0 + 40 * MIN + TRANSFER_GRACE_MS;
    idle.tick();
    expect(existsSync(request())).toBe(true);
  });

  it('quiescing defers it, reverts an unserved quiesce after 30 min and seals a served one at 2 h', async () => {
    trip = { ...trip, phase: 'quiescing', quiescingSince: T0, lastLaptopProgressAt: T0 };
    const idle = make();
    now = T0 + QUIESCE_REVERT_MS;
    idle.tick();
    expect(reverted).toBe(1);
    // Back to active with nothing going on: the idle cloud stops right away.
    expect(existsSync(request())).toBe(true);
    rmSync(request());

    trip = { phase: 'quiescing', goingSince: null, quiescingSince: now, servedEpoch: 1, epoch: 1, lastLaptopProgressAt: now };
    const q = now;
    const idle2 = make();
    idle2.recordAction();
    now = q + 90 * MIN;
    idle2.tick();
    expect(sealed).toBe(0);
    expect(existsSync(request())).toBe(false);
    now = q + QUIESCING_CAP_MS;
    idle2.tick();
    // The self-seal is async (it wipes the secret class first, D21) and blocks the stop meanwhile.
    expect(existsSync(request())).toBe(false);
    await idle2.sealInFlight();
    expect(sealed).toBe(1);
  });

  it('pings, polls and reconnects are not actions: only recordAction moves the clock', () => {
    const idle = make();
    // A live idle child with no turn edges (a phone that keeps reconnecting) changes nothing.
    live = [{ conversationId: 'c1', projectRoot: '/p', busy: false, turnStartedAt: null, lastTurnEndedAt: null }];
    now = T0 + IDLE_AFTER_MS;
    idle.tick();
    expect(existsSync(request())).toBe(true);
  });
});

describe('cloud trip state persistence', () => {
  it('laptop progress survives a restart; a revert bumps the epoch', async () => {
    const { CloudStateStore } = await import('../../src/server/cloud-state.js');
    const dir = mkdtempSync(join(tmpdir(), 'cloud-state-'));
    try {
      let now = T0;
      const a = new CloudStateStore({ dir, now: () => now });
      a.startTrip({ tripId: 't1', laptopId: 'l1', go: {}, rootIds: [], takeOver: false });
      a.activate('t1');
      a.quiesce('t1');
      now = T0 + 20 * MIN;
      a.touchLaptopProgress();
      const b = new CloudStateStore({ dir, now: () => now });
      expect(b.get().lastLaptopProgressAt).toBe(T0 + 20 * MIN);
      expect(b.get().epoch).toBe(1);
      expect(b.unquiesce()).toBe(true);
      expect(b.get().epoch).toBe(2);
      expect(b.quiescingEpoch(1)).toBe('epoch_mismatch');
      expect(b.quiescingEpoch(2)).toBe('not_quiescing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

