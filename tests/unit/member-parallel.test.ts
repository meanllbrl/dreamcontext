/**
 * One member, several jobs at once (owner, 2026-11-01): every new ask holds its own slot and
 * session, and only a follow-up in one conversation waits, behind that conversation.
 *
 * Driven through the real `runAutomation` and `resumeWithMessage` with a spawn the test finishes
 * by hand, so two turns truly overlap and the assertions read the files they would leave.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { killRunGroup, outputPathFor, runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { proposeFromRun, resumeWithMessage } from '../../src/lib/automations/verdict.js';
import {
  automationCachePath, createAutomation, getAutomation, listRunSidecars, listRunSlots, lockPathFor,
  readAutomationCache, recordRun, recordLesson, readPattern, readRunSidecar, runSlotKey, sidecarPathFor, slotLockPath, writeRunSidecar,
} from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { createQuestion, listQuestions, pendingQuestionOfRun } from '../../src/lib/automations/hitl.js';
import { latestBoundSession, recordAutomationSession, sessionForRun } from '../../src/lib/automations/session-registry.js';
import { appendThreadEntry, readThread } from '../../src/lib/automations/threads.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
const SLUG = 'digest';

/** A child per spawn that stays alive until the test finishes it. */
function liveSpawn() {
  const children: { args: string[]; pid: number; finish: (session: string | null, result?: string, code?: number) => void }[] = [];
  let pid = process.pid; // a live pid, so nothing reads a held slot as litter
  const impl = vi.fn((_cmd: string, args: string[]) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: ++pid, stdout, stderr, kill: () => {} });
    children.push({
      args,
      pid: child.pid,
      finish: (session, result = 'done', code = 0) => {
        stdout.emit('data', Buffer.from(JSON.stringify({ session_id: session, result, is_error: code !== 0, permission_denials: [] }), 'utf-8'));
        child.emit('close', code);
      },
    });
    return child;
  }) as unknown as SpawnImpl;
  return { impl, children };
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};

const ask = (spawnImpl: SpawnImpl, text: string, fireAt: Date) => runAutomation(contextRoot, SLUG, {
  ask: text, fireAt, parallel: true, spawnImpl, home, notify: () => {}, sendTelegram: async () => {},
  killImpl: () => {},
});

const iso = (n: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, n)).toISOString();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-parallel-home-'));
  vi.stubEnv('HOME', home);
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-parallel-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  const m = createAutomation(contextRoot, { slug: SLUG, title: 'Digest', days: 'daily', at: '18:00', prompt: 'go', review: 'agent' });
  approveAutomation(projectRoot, m, new Date(), home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('three asks of one member at once', () => {
  it('all three spawn before any ends, each in its own thread, and every slot dies with its turn', async () => {
    const { impl, children } = liveSpawn();
    const runs = [0, 1, 2].map((n) => ask(impl, `question ${n}`, new Date(iso(n))));
    await until(() => children.length === 3);
    expect(new Set(listRunSidecars(contextRoot, SLUG).map((s) => s.fireAt))).toEqual(new Set([iso(0), iso(1), iso(2)]));
    expect(listRunSlots(contextRoot, SLUG).map((s) => s.run).sort()).toEqual([iso(0), iso(1), iso(2)]);

    // Each answer comes back on its own outcome and its own session, finished out of order.
    children[1].finish('sess-1', 'answer one');
    children[2].finish('sess-2', 'answer two');
    children[0].finish('sess-0', 'answer zero');
    const [a, b, c] = await Promise.all(runs);
    expect([a.status, b.status, c.status]).toEqual(['ok', 'ok', 'ok']);
    expect([a.result, b.result, c.result]).toEqual(['answer zero', 'answer one', 'answer two']);

    // Three documents, none overwritten.
    const texts = [a, b, c].map((r) => readFileSync(r.outputPath!, 'utf-8'));
    expect(texts.join()).toContain('answer zero');
    expect(new Set([a.outputPath, b.outputPath, c.outputPath]).size).toBe(3);
    // All three on record, whichever finished first.
    expect(readAutomationCache(contextRoot, SLUG)?.history.map((e) => e.firedAt).sort()).toEqual([iso(0), iso(1), iso(2)]);
    // Each thread's start and end are its own.
    for (const n of [0, 1, 2]) expect(readThread(contextRoot, SLUG, { runId: iso(n) }).map((e) => e.event)).toEqual(['started', 'ok']);

    expect(listRunSlots(contextRoot, SLUG)).toEqual([]);
    expect(listRunSidecars(contextRoot, SLUG)).toEqual([]);
    const left = readdirSync(dirname(automationCachePath(contextRoot, SLUG))).filter((f) => f.includes('slot-') || f.endsWith('.lock'));
    expect(left).toEqual([]);
  });

  it('one falls and the others go on to their own answers', async () => {
    const { impl, children } = liveSpawn();
    const runs = [0, 1].map((n) => ask(impl, `question ${n}`, new Date(iso(n))));
    await until(() => children.length === 2);
    children[0].finish(null, 'it broke', 1);
    const first = await runs[0];
    expect(first.status).toBe('failed');
    expect(listRunSlots(contextRoot, SLUG).map((s) => s.run)).toEqual([iso(1)]);
    children[1].finish('sess-1', 'still fine');
    expect((await runs[1]).result).toBe('still fine');
  });

  it('a question another run left open does not stop a new ask, and stays that run\'s', async () => {
    createQuestion(contextRoot, { slug: SLUG, runFiredAt: iso(9), kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'which one?', choices: [], nowISO: iso(9) });
    const { impl, children } = liveSpawn();
    const run = ask(impl, 'something else', new Date(iso(1)));
    await until(() => children.length === 1);
    children[0].finish('sess-1', 'answered');
    expect((await run).status).toBe('ok');
    expect(pendingQuestionOfRun(contextRoot, SLUG, iso(9))).not.toBeNull();
    expect(pendingQuestionOfRun(contextRoot, SLUG, iso(1))).toBeNull();
  });

  it('a scheduled fire still does not overlap itself, and an ask runs beside it', async () => {
    const { impl, children } = liveSpawn();
    const fire = runAutomation(contextRoot, SLUG, { fireAt: new Date(iso(0)), spawnImpl: impl, home, notify: () => {}, sendTelegram: async () => {}, killImpl: () => {} });
    await until(() => children.length === 1);
    const again = await runAutomation(contextRoot, SLUG, { fireAt: new Date(iso(1)), spawnImpl: impl, home, notify: () => {}, sendTelegram: async () => {}, killImpl: () => {} });
    expect(again.status).toBe('deferred');
    const beside = ask(impl, 'now please', new Date(iso(2)));
    await until(() => children.length === 2);
    children[1].finish('sess-a', 'mine');
    expect((await beside).result).toBe('mine');
    children[0].finish('sess-b', 'fire');
    expect((await fire).status).toBe('ok');
  });
});

describe('a follow-up stays in its own conversation', () => {
  const reply = (spawnImpl: SpawnImpl, run: string, text: string, extra = {}) => resumeWithMessage(contextRoot, SLUG, text, {
    run, surface: 'thread', spawnImpl, home, lockWaitMs: 2_000, lockPollMs: 2,
    env: { DREAMCONTEXT_AUTOMATION_SLUG: SLUG, DREAMCONTEXT_AUTOMATION_RUN: run }, ...extra,
  });
  const resumed = (args: string[]) => args[args.indexOf('--resume') + 1];

  it('reaches the session of the run it was typed under, not the newest', async () => {
    recordAutomationSession(SLUG, 'sess-old', home, Date.now() - 2_000, undefined, iso(0));
    recordAutomationSession(SLUG, 'sess-new', home, Date.now() - 1_000, undefined, iso(1));
    expect(latestBoundSession(SLUG, home)).toBe('sess-new');
    const { impl, children } = liveSpawn();
    const turn = reply(impl, iso(0), 'about the old one');
    await until(() => children.length === 1);
    expect(resumed(children[0].args)).toBe('sess-old');
    children[0].finish('sess-old', 'ok');
    expect((await turn).status).toBe('ok');
  });

  it('two sessions take follow-ups side by side; two follow-ups in one session take turns', async () => {
    recordAutomationSession(SLUG, 'sess-a', home, Date.now() - 2_000, undefined, iso(0));
    recordAutomationSession(SLUG, 'sess-b', home, Date.now() - 1_000, undefined, iso(1));
    const { impl, children } = liveSpawn();
    const a1 = reply(impl, iso(0), 'a one');
    const b1 = reply(impl, iso(1), 'b one');
    await until(() => children.length === 2);
    const a2 = reply(impl, iso(0), 'a two');
    await new Promise((r) => setTimeout(r, 30));
    expect(children).toHaveLength(2);
    children[0].finish('sess-a', 'a done');
    await a1;
    await until(() => children.length === 3);
    expect(resumed(children[2].args)).toBe('sess-a');
    children[1].finish('sess-b', 'b done');
    children[2].finish('sess-a', 'a done 2');
    expect((await b1).status).toBe('ok');
    expect((await a2).status).toBe('ok');
  });

  it('a follow-up to a run in flight waits for it and takes the session it binds', async () => {
    const { impl, children } = liveSpawn();
    const run = ask(impl, 'start', new Date(iso(0)));
    await until(() => children.length === 1);
    const follow = reply(impl, iso(0), 'and also');
    await new Promise((r) => setTimeout(r, 30));
    expect(children).toHaveLength(1);
    children[0].finish('sess-fresh', 'first');
    await run;
    await until(() => children.length === 2);
    expect(resumed(children[1].args)).toBe('sess-fresh');
    children[1].finish('sess-fresh', 'second');
    expect((await follow).status).toBe('ok');
  });

  it('never borrows another named run\'s session', () => {
    recordAutomationSession(SLUG, 'sess-a', home, Date.now() - 2_000, undefined, iso(0));
    expect(sessionForRun(contextRoot, SLUG, iso(5), home, true)).toBeNull();
  });

  it('an exclusive lock held for another run, or by a dead process, holds no follow-up back', async () => {
    recordAutomationSession(SLUG, 'sess-a', home, Date.now(), undefined, iso(0));
    mkdirSync(dirname(lockPathFor(contextRoot, SLUG)), { recursive: true });
    for (const lock of [{ pid: process.pid, at: Date.now(), run: iso(7) }, { pid: 2 ** 22 + 99, at: Date.now() }]) {
      writeFileSync(lockPathFor(contextRoot, SLUG), JSON.stringify(lock));
      const { impl, children } = liveSpawn();
      const turn = reply(impl, iso(0), 'go on');
      await until(() => children.length === 1);
      children[0].finish('sess-a', 'went on');
      expect((await turn).status).toBe('ok');
    }
  });

  it('a sibling\'s open question does not refuse this conversation', async () => {
    recordAutomationSession(SLUG, 'sess-a', home, Date.now() - 2_000, undefined, iso(0));
    createQuestion(contextRoot, { slug: SLUG, runFiredAt: iso(1), kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'q', choices: [], nowISO: iso(1) });
    const { impl, children } = liveSpawn();
    const turn = reply(impl, iso(0), 'go on');
    await until(() => children.length === 1);
    children[0].finish('sess-a', 'went on');
    expect((await turn).status).toBe('ok');
  });
});

describe('old records', () => {
  it('a binding and a history row from before parallel runs still resume', () => {
    recordAutomationSession(SLUG, 'sess-legacy', home, Date.now() - 2_000);
    // The latest binding only for the newest thread: an older one has no way to name it.
    expect(sessionForRun(contextRoot, SLUG, iso(0), home, true)).toBe('sess-legacy');
    expect(sessionForRun(contextRoot, SLUG, iso(0), home)).toBeNull();
    recordAutomationSession(SLUG, 'sess-history', home, Date.now() - 1_000, undefined, iso(3));
    recordRun(contextRoot, SLUG, {
      firedAt: iso(1), startedAt: iso(1), finishedAt: iso(1), status: 'ok', durationMs: 1, outputPath: null, error: null,
      exitCode: 0, sessionId: 'sess-legacy', costUsd: null, numTurns: null, permissionDenials: 0,
    });
    expect(sessionForRun(contextRoot, SLUG, iso(1), home)).toBe('sess-legacy');
  });

  it('a synced history row naming a session this machine never bound is not believed', () => {
    recordRun(contextRoot, SLUG, {
      firedAt: iso(1), startedAt: iso(1), finishedAt: iso(1), status: 'ok', durationMs: 1, outputPath: null, error: null,
      exitCode: 0, sessionId: 'sess-planted', costUsd: null, numTurns: null, permissionDenials: 0,
    });
    expect(sessionForRun(contextRoot, SLUG, iso(1), home)).toBeNull();
  });

  it('the exclusive lock and sidecar of an older build are still read', () => {
    mkdirSync(dirname(lockPathFor(contextRoot, SLUG)), { recursive: true });
    writeFileSync(lockPathFor(contextRoot, SLUG), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const side = { slug: SLUG, runnerPid: process.pid, childPid: 777, childPgid: 777, fireAt: iso(0), startedAt: iso(0), timeoutAt: iso(9) };
    writeRunSidecar(contextRoot, SLUG, side);
    expect(readRunSidecar(contextRoot, SLUG)?.fireAt).toBe(iso(0));
    expect(listRunSidecars(contextRoot, SLUG)).toHaveLength(1);
  });
});

describe('shared files and dead keys', () => {
  it('an older fire ending last never moves the watermark back', () => {
    const row = (n: number) => ({
      firedAt: iso(n), startedAt: iso(n), finishedAt: iso(n), status: 'ok' as const, durationMs: 1, outputPath: null, error: null,
      exitCode: 0, sessionId: null, costUsd: null, numTurns: null, permissionDenials: 0,
    });
    recordRun(contextRoot, SLUG, row(5));
    expect(recordRun(contextRoot, SLUG, row(1)).lastFireAt).toBe(iso(5));
  });

  it('a slot in a sidecar\'s JSON is not believed: the file\'s name is', () => {
    const slot = runSlotKey('run:y');
    writeRunSidecar(contextRoot, SLUG, { slug: SLUG, runnerPid: process.pid, childPid: 7, childPgid: 7, fireAt: iso(0), startedAt: iso(0), timeoutAt: iso(9), slot });
    expect(readRunSidecar(contextRoot, SLUG, slot)?.slot).toBe(slot);
    writeFileSync(sidecarPathFor(contextRoot, SLUG), JSON.stringify({ slug: SLUG, runnerPid: process.pid, childPid: 8, childPgid: 8, fireAt: iso(1), startedAt: iso(1), timeoutAt: iso(9), slot }));
    expect(readRunSidecar(contextRoot, SLUG, '')?.slot).toBeUndefined();
  });

  it('kill reads the turn fresh: one that ended while the operator was asked is not found', () => {
    expect(killRunGroup(contextRoot, SLUG, { slot: runSlotKey('run:gone') }).found).toBe(false);
  });

  it('a slot whose holder died is removed on the next read', () => {
    const slot = runSlotKey('run:x');
    const path = slotLockPath(contextRoot, SLUG, slot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 4242, at: Date.now(), run: 'x' }));
    expect(listRunSlots(contextRoot, SLUG)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it('propose finds the caller\'s own turn among several and files on its own run', () => {
    for (const n of [0, 1]) {
      writeRunSidecar(contextRoot, SLUG, {
        slug: SLUG, runnerPid: process.pid, childPid: 500 + n, childPgid: 500 + n, fireAt: iso(n), startedAt: iso(n), timeoutAt: iso(9), slot: runSlotKey(`run:${iso(n)}`),
      });
    }
    createQuestion(contextRoot, { slug: SLUG, runFiredAt: iso(1), kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'sibling', choices: [], nowISO: iso(1) });
    const r = proposeFromRun(contextRoot, SLUG, { question: 'mine?', choices: [] } as never, { ancestryProbe: () => [500] });
    expect(r.ok).toBe(true);
    expect(listQuestions(contextRoot, SLUG).filter((q) => q.runFiredAt === iso(0))).toHaveLength(1);
  });

  it('lessons recorded one after another both land, under the mutex', () => {
    recordLesson(contextRoot, SLUG, { lesson: 'first' });
    recordLesson(contextRoot, SLUG, { lesson: 'second' });
    expect(readPattern(getAutomation(contextRoot, SLUG)!).lessons.map((l) => l.text)).toEqual(['second', 'first']);
  });

  it('a parallel turn\'s output name is its own even when the day already has one', () => {
    const m = getAutomation(contextRoot, SLUG)!;
    const a = outputPathFor(contextRoot, m, new Date(iso(0)), true);
    const b = outputPathFor(contextRoot, m, new Date(iso(1)), true);
    expect(a).not.toBe(b);
  });
});
