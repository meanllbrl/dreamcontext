/**
 * Both directions of one class (run-kart-altta, 13 Nov): a child whose command a permission check
 * refused also leaves the owner a run card with that SAME command, so one command holds two waits.
 *  - he RUNS the card: the refusal of that command closes too (registry, `refusalsSettledByRun`);
 *  - he ANSWERS the refusal (Allow, or Not needed): the run card of that command settles in its
 *    place, done with its own result line (`allowed` / `not_needed`), its wait and its card record
 *    closed, so nothing asks him to run what is already decided (`runCardsSettledByRefusal`).
 * A run card of any other command stays open either way. Real record, registry and answer path.
 * Fictional commands (synthetic-fixtures).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/refusal-settles-run-home-`);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetChatRegistry, ownerWaitAnswered, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem } from '../../src/lib/super/types.js';
import { _resetSuperInbox, _superInboxDrained, setGrantEnvForTest, wireSuperInbox } from '../../src/lib/super/inbox.js';
import { _resetOwnerAnswers, answerOwnerItem, runCardsSettledByRefusal } from '../../src/lib/super/answer.js';
import { refusalWait, refusalWaitId } from '../../src/lib/super/owner-wait.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { buildRunReport } from '../../dashboard/src/components/sleepy/chat/runReport.js';
import type { Resolver } from '../../src/lib/grants/eligible.js';

const MAIN = 'sess-main-refusal-1';
const CHILD = '22222222-3333-4444-8555-666666666666';
const CMD = 'bash /tmp/acme-release/verify_tagged.sh';
const OTHER = 'bash /tmp/acme-release/other.sh';
const RESOLVER: Resolver = { which: () => null, realpath: (p) => p, isRegularFile: () => true, sha256: () => 'b'.repeat(64) };

let dir: string;
let root: string;

const refusalItem = (): SuperQueueItem => {
  const w = refusalWait('Bash', CMD, 4000, { source: 'classifier' } as never);
  return { id: 'q-refusal', sessionId: CHILD, kind: 'owner', state: 'escalated', createdAt: 1_000, ownerText: w.line, wait: { kind: 'refusal', id: w.id, refusal: w.refusal } } as SuperQueueItem;
};
const runItem = (id: string, cardId: string, command: string): SuperQueueItem => ({
  id, sessionId: CHILD, kind: 'owner', state: 'escalated', createdAt: 1_100, ownerText: `run ${command}`,
  wait: { kind: 'run', id: cardId },
  card: {
    cardRef: (cardId === 'verify' ? 'a' : 'b').repeat(32), postingSession: CHILD, vault: 'acme', postingConversationId: CHILD,
    spec: { type: 'run', id: cardId, command } as never, childRecordId: 'main', childId: CHILD, deliverTo: CHILD,
  },
} as SuperQueueItem);

beforeEach(() => {
  rmSync(join(process.env.HOME as string, '.dreamcontext'), { recursive: true, force: true });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'refusal-settles-run-')));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
  resetWindowControl();
  resetSuperIndex();
  _resetSuperInbox();
  _resetChatRegistry();
  _resetOwnerAnswers();
  setGrantEnvForTest({ resolver: () => RESOLVER, roots: (p) => [p, '/tmp'] });
  wireSuperInbox();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: MAIN, enabled: true,
    children: { [CHILD]: { sessionId: CHILD, brief: 'Acme release', adopted: false, startedAt: 500, row: 'waiting', rowAt: 1_000 } },
    queue: [refusalItem(), runItem('q-run', 'verify', CMD), runItem('q-other', 'other', OTHER)],
  }));
});
afterEach(async () => {
  await _superInboxDrained();
  setGrantEnvForTest({ resolver: null, roots: null });
  rmSync(dir, { recursive: true, force: true });
});

const itemOf = async (id: string) => (await readSuperState(root)).queue.find((q) => q.id === id);

describe('the run card settles when he answers the refusal of the same command', () => {
  it('picks only the open run card of the same child and the same whole shell command', () => {
    const queue = [refusalItem(), runItem('q-run', 'verify', CMD), runItem('q-other', 'other', OTHER)];
    expect(runCardsSettledByRefusal({ queue }, refusalItem()).map((q) => q.id)).toEqual(['q-run']);
    const cut = { ...refusalItem(), wait: { ...refusalItem().wait!, refusal: { ...refusalItem().wait!.refusal!, whole: false } } } as SuperQueueItem;
    expect(runCardsSettledByRefusal({ queue }, cut)).toEqual([]);
  });

  it('Not needed on the refusal: the run card is done with its line, its wait answered; the other card stays', async () => {
    registerChat({ sessionId: CHILD, conversationId: null, vault: 'acme', mode: 'super', crew: true, permissionMode: 'auto' }).userSent('go');
    const r = await answerOwnerItem(root, { record: 'main', item: 'q-refusal', via: 'bar', answer: { kind: 'refusal', action: 'not_needed' } });
    expect(r).toEqual({ ok: true, outcome: 'dismissed' });
    expect(await itemOf('q-run')).toMatchObject({ state: 'done', delivery: 'not_needed' });
    expect(ownerWaitAnswered(CHILD, 'run', 'verify')).toBe(true);
    expect((await itemOf('q-other'))?.state).toBe('escalated');
  });

  it('Allow on the refusal: the run card is done with "allowed"; the other card stays', async () => {
    registerChat({ sessionId: CHILD, conversationId: null, vault: 'acme', mode: 'super', crew: true, permissionMode: 'auto' }).userSent('go');
    const q = (await readSuperState(root)).queue.find((x) => x.id === 'q-refusal')!;
    const r = await answerOwnerItem(root, {
      record: 'main', item: 'q-refusal', via: 'bar', shown: { tool: 'Bash', input: q.wait!.refusal!.input },
      answer: { kind: 'refusal', action: 'allow', size: 'once' },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await itemOf('q-run')).toMatchObject({ state: 'done', delivery: 'allowed' });
    expect(ownerWaitAnswered(CHILD, 'run', 'verify')).toBe(true);
    expect((await itemOf('q-other'))?.state).toBe('escalated');
  });
});

describe('the other direction: his run of the card closes the refusal of the same command', () => {
  it('the delivered run report answers the run wait AND the refusal, by id', () => {
    const h = registerChat({ sessionId: CHILD, conversationId: null, vault: 'acme', mode: 'basic' });
    h.userSent('go');
    h.userSent(buildRunReport(CMD, { code: 0, tail: 'verified 20/20', seconds: 4 }, { includeOutput: true }), { server: true, ownerReceipt: { kind: 'run', id: 'verify' } });
    expect(ownerWaitAnswered(CHILD, 'run', 'verify')).toBe(true);
    expect(ownerWaitAnswered(CHILD, 'refusal', refusalWaitId('Bash', CMD))).toBe(true);
    expect(ownerWaitAnswered(CHILD, 'refusal', refusalWaitId('Bash', OTHER))).toBe(false);
  });
});
