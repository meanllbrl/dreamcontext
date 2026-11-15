/**
 * The machine-wide account wait (2026-11-15, Second-brain): one wait recorded from readings held
 * every routine for 32 hours, and the owner heard nothing until he asked the member why it had not
 * run. Three rules:
 *   1. the wait GATES a start only for `ACCOUNT_WAIT_RECHECK_MS`, then the next start decides
 *      afresh; the Settings page still shows when it ends;
 *   2. a reading whose reset has passed, and a refusal whose end has passed, never count as full;
 *   3. EVERY routine deferred for an account is told to the owner ONCE per wait (Mac banner and
 *      the Telegram bot, opted in or not), never on every tick or recheck, and the message never
 *      promises a run its catch-up window will drop.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_WAIT_RECHECK_MS, accountWaitHolds, heldAccountWait, protectedAutomationAccount, readAccountWait, recordAccountWait,
} from '../../src/lib/automations/account.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { accountWaitFactOf, runAutomation, type RunOutcome, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { createAutomation, readAutomationCache } from '../../src/lib/automations/store.js';
import { tickProject } from '../../src/lib/automations/tick.js';
import { sandboxDirFor, upsertClaudeAccount } from '../../src/lib/claude-accounts.js';
import { FakeTelegram } from '../helpers/fake-telegram.js';
import { buildRoutineForward, waitWhen, type ForwardInput } from '../../src/lib/telegram/member-forward.js';
import { scopeOfContextRoot, writeBinding } from '../../src/lib/telegram/config.js';

vi.mock('../../src/lib/claude-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/claude-path.js')>()),
  findClaudeBin: () => '/fake/bin/claude',
}));

const NOW = new Date('2026-11-15T16:34:00.000Z');
const T = NOW.getTime();
let projectRoot: string;
let contextRoot: string;
let home: string;

let realHome: string | undefined;
beforeEach(() => {
  realHome = process.env.HOME;
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wait-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wait-home-')));
  process.env.HOME = home;
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function account(id: string, preferred = false): void {
  upsertClaudeAccount({
    id, accountUuid: `uuid-${id}`, email: `${id}@example.test`, organizationUuid: 'org',
    organizationName: 'Example Org', tier: 'max', configDir: sandboxDirFor(id, home), preferred,
  }, home);
  mkdirSync(sandboxDirFor(id, home), { recursive: true });
}
/** A cached reading in `dir`'s `.claude.json`, fetched `ageMs` before T. */
function cacheIn(dir: string, email: string, session: number, weekly: number, resets: { session: number; weekly: number }, ageMs = 0): void {
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: email },
    cachedUsageUtilization: {
      fetchedAtMs: T - ageMs,
      utilization: {
        five_hour: { utilization: session, resets_at: new Date(resets.session).toISOString() },
        seven_day: { utilization: weekly, resets_at: new Date(resets.weekly).toISOString() },
      },
    },
  }));
}

describe('the wait gates a start only for a while', () => {
  it('holds inside the recheck window, then lets the next start decide; Settings still shows its end', () => {
    const wakeAt = T + 32 * 3_600_000;
    recordAccountWait(wakeAt, home, T);
    expect(accountWaitHolds(home, T + 10 * 60_000)).toBe(wakeAt);
    expect(accountWaitHolds(home, T + ACCOUNT_WAIT_RECHECK_MS)).toBeNull();
    expect(readAccountWait(home, T + ACCOUNT_WAIT_RECHECK_MS)).toBe(wakeAt);
  });

  it('a due routine during a held wait reaches the runner (which defers it); past the recheck window the wait no longer holds', async () => {
    const fire = new Date(T - 3_600_000);
    const at = `${String(fire.getHours()).padStart(2, '0')}:${String(fire.getMinutes()).padStart(2, '0')}`;
    createAutomation(contextRoot, { slug: 'pt-gunluk', title: 'Günlük ritim', prompt: 'Write.', days: 'daily', at } as never);
    recordAccountWait(T + 32 * 3_600_000, home, T);
    const seen: boolean[] = [];
    const runImpl = vi.fn(async (_c: string, slug: string, o: { now?: () => Date }) => {
      seen.push(accountWaitHolds(home, (o.now?.() ?? new Date()).getTime()) !== null);
      return { slug, status: 'deferred' } as unknown as RunOutcome;
    });
    const during = await tickProject(projectRoot, { now: new Date(T + 10 * 60_000), home, runImpl: runImpl as never });
    expect(during.verdicts).toContainEqual({ slug: 'pt-gunluk', verdict: 'waiting-for-account' });
    await tickProject(projectRoot, { now: new Date(T + ACCOUNT_WAIT_RECHECK_MS + 60_000), home, runImpl: runImpl as never });
    expect(seen).toEqual([true, false]);
  });
});

describe('old readings and ended refusals never count as full', () => {
  it('a week whose reset has passed and a refusal whose end has passed leave the account free', async () => {
    account('one', true);
    cacheIn(sandboxDirFor('one', home), 'one@example.test', 10, 100, { session: T + 3_600_000, weekly: T - 9 * 86_400_000 }, 12 * 86_400_000);
    writeFileSync(join(home, '.dreamcontext', 'claude-account-limits.json'), JSON.stringify({
      rejected: { one: { until: T - 9 * 86_400_000, window: 'weekly', at: T - 12 * 86_400_000 } },
    }));
    const probe = vi.fn(async () => ({ status: 'unknown' }) as never);
    const pick = await protectedAutomationAccount({ home, probe, now: T });
    expect('account' in pick && pick.account.id).toBe('one');
  });

  it('no reading says when an account frees up: the wait is marked unknown, not full', async () => {
    account('one', true);
    rmSync(join(sandboxDirFor('one', home), '.claude.json'), { force: true });
    const pick = await protectedAutomationAccount({ home, probe: async () => ({ status: 'unknown' }) as never, now: T });
    expect(pick).toEqual({ waitUntil: expect.any(Number), unknown: true });
  });
});

describe('a deferred routine is told once', () => {
  function spawnNever(): { impl: SpawnImpl; calls: number } {
    const box = { calls: 0 } as { impl: SpawnImpl; calls: number };
    box.impl = vi.fn(() => {
      box.calls += 1;
      const child = Object.assign(new EventEmitter(), { pid: 9100, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => {} });
      setImmediate(() => child.emit('close', 0));
      return child;
    }) as unknown as SpawnImpl;
    return box;
  }
  const noProbe = async () => ({ status: 'unknown' }) as never;
  function fullWeek(reset: number): void {
    account('one', true);
    cacheIn(sandboxDirFor('one', home), 'one@example.test', 10, 95, { session: T + 3_600_000, weekly: reset });
  }
  function routine(slug: string, title = slug): void {
    approveAutomation(projectRoot, createAutomation(contextRoot, { slug, title, prompt: 'Write.', days: 'daily', at: '19:00' }), NOW, home);
  }

  it('the first deferral notifies and records the fact; a later one for the same reset stays silent', async () => {
    // One registered account, its week at 95% until Tuesday (the threshold is 80 here).
    const reset = T + 35 * 3_600_000 + 26_000;
    fullWeek(reset);
    routine('pt-haftalik', 'Haftalık değerlendirme');
    const notify = vi.fn();
    const spawn = spawnNever();
    const run = (now: Date) => runAutomation(contextRoot, 'pt-haftalik', {
      now: () => now, home, spawnImpl: spawn.impl, killImpl: vi.fn(), notify, log: () => {}, unattended: true, probeUsage: noProbe,
    });
    const first = await run(NOW);
    expect(first.status, String(first.error)).toBe('deferred');
    expect(spawn.calls).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('Haftalık değerlendirme: waiting for an account');
    expect(readAutomationCache(contextRoot, 'pt-haftalik')?.history[0]?.toldFact)
      .toBe(accountWaitFactOf({ until: reset, kind: 'full', day: '2026-11-15' }));
    // Past the recheck window it decides afresh, finds the same reset, and says nothing new.
    const again = await run(new Date(T + ACCOUNT_WAIT_RECHECK_MS + 60_000));
    expect(again.status).toBe('deferred');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('every routine due in a held wait is deferred without a probe, queued and told once', async () => {
    fullWeek(T + 35 * 3_600_000);
    recordAccountWait(T + 35 * 3_600_000, home, T - 60_000);
    routine('pt-gunluk');
    routine('pt-haftalik');
    const notify = vi.fn();
    const probe = vi.fn(noProbe);
    const spawn = spawnNever();
    for (const slug of ['pt-gunluk', 'pt-haftalik', 'pt-gunluk']) {
      const out = await runAutomation(contextRoot, slug, { now: () => NOW, home, spawnImpl: spawn.impl, killImpl: vi.fn(), notify, log: () => {}, unattended: true, probeUsage: probe });
      expect(out.status).toBe('deferred');
    }
    expect(probe).not.toHaveBeenCalled();
    expect(spawn.calls).toBe(0);
    expect(notify.mock.calls.map((c) => c[0])).toEqual(['pt-gunluk: waiting for an account', 'pt-haftalik: waiting for an account']);
    // The held wait was not re-recorded: its recheck clock still runs out.
    expect(heldAccountWait(home, T - 60_000 + ACCOUNT_WAIT_RECHECK_MS)).toBeNull();
    const queue = readFileSync(join(home, '.dreamcontext', 'automations-queue.json'), 'utf-8');
    expect(queue).toContain('pt-gunluk');
    expect(queue).toContain('pt-haftalik');
  });

  it('a wait past the catch-up window says this run is skipped, never that it runs later', async () => {
    fullWeek(T + 35 * 3_600_000);
    routine('uzun');
    const out = await runAutomation(contextRoot, 'uzun', { now: () => NOW, home, spawnImpl: spawnNever().impl, killImpl: vi.fn(), notify: vi.fn(), log: () => {}, unattended: true, probeUsage: noProbe });
    expect(out.error).toContain('this run is skipped');
  });

  it('two readings of the same reset are one fact; another reset is a new one; a wait with no reset is one fact a day', () => {
    const f = (until: number, kind: 'full' | 'none-open' | 'unknown' = 'full', day = '2026-11-15') => accountWaitFactOf({ until, kind, day });
    expect(f(1794887999642)).toBe(f(1794888000000));
    expect(f(1794888000000)).not.toBe(f(1794888000000 + 3_600_000));
    // `unknown` and `none-open` move their `until` on every recheck: their fact does not.
    expect(f(T + 30 * 60_000, 'unknown')).toBe(f(T + 90 * 60_000, 'unknown'));
    expect(f(T, 'unknown')).not.toBe(f(T, 'unknown', '2026-11-16'));
    expect(f(T, 'none-open')).toBe('account-wait:none-open:2026-11-15');
  });

  it('the member bot says it did not run and why, without an opt-in', async () => {
    const TOKEN = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    mkdirSync(join(contextRoot, 'agents'), { recursive: true });
    writeFileSync(join(contextRoot, 'agents', 'ege.md'), '---\nname: Ege\n---\n');
    const tg = new FakeTelegram(); tg.addBot(TOKEN, 'ege_bot');
    writeBinding(scopeOfContextRoot(contextRoot), 'ege', { token: TOKEN, botId: 222222, botUsername: 'ege_bot', chatId: 777, userId: 777, boundAt: 'now' }, home);
    const until = T + 35 * 3_600_000;
    const input: ForwardInput = {
      contextRoot, slug: 'pt-haftalik', title: 'Haftalık değerlendirme', agent: 'ege', approvalHash: 'h1', status: 'deferred',
      error: 'every account is near its usage limit', reviewPending: false, scheduled: true, runId: NOW.toISOString(),
      entries: [], verified: new Set(), home, fetchImpl: tg.fetch, sleep: async () => {}, accountWait: { until, kind: 'full', runsLater: true },
    };
    const last = () => tg.texts().at(-1)!;
    await buildRoutineForward(input)!();
    expect(last()).toContain('<b>Haftalık değerlendirme</b>');
    expect(last()).toContain('kullanım sınırına yakın');
    expect(last()).toContain(waitWhen(until));
    expect(last()).toContain('kendiliğinden çalışır');
    expect(last()).not.toContain('—');
    await buildRoutineForward({ ...input, accountWait: { until, kind: 'full', runsLater: false } })!();
    expect(last()).toContain('Bu çalıştırma atlanır');
    expect(last()).not.toContain('kendiliğinden');
    await buildRoutineForward({ ...input, accountWait: { until, kind: 'none-open', runsLater: false } })!();
    expect(last()).toContain('yalnız senin sohbetlerine');
    await buildRoutineForward({ ...input, accountWait: { until, kind: 'unknown', runsLater: false } })!();
    expect(last()).toContain('hiçbir hesap rutin çalıştıramıyor');
    expect(last()).not.toContain('sınırına yakın');
    // A plain deferral (a busy lock, a sleep) still sends nothing.
    expect(buildRoutineForward({ ...input, accountWait: undefined })).toBeNull();
  });
});
