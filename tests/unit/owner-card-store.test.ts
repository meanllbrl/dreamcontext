/**
 * sahip-karti-yerinde W2 lane A, the pure parts:
 *  - the record keeps an owner item's card handle, its Remind mark and its result line, and the
 *    `parked` and `owner-result` events (store.ts `sanitizeQueue`), and drops what does not read;
 *  - both new kinds are Super pump turns (so every one ends with the owner-language line);
 *  - the outbox delivers an Allow the SERVER kept for a closed chat in this same run (build note:
 *    it waited for a relaunch), and still never a message this run's window queued.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-card-store-home-`);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState, superKey } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';
import { SUPER_TURN_KINDS, _resetSuperInbox, _superInboxDrained, setMemberGateForTest, syncMemberMirrors, writeSuper } from '../../src/lib/super/inbox.js';
import { OUTBOX_BOOT, addToOutbox, pumpOutbox, readOutbox } from '../../src/lib/super/outbox.js';

// Every test starts with an EMPTY machine store under this file's own HOME (the receipts, the
// closed-card files, the outbox, the parked tabs): nothing a test leaves on disk reaches the next,
// so the file passes whole and in any order.
beforeEach(() => { rmSync(join(process.env.HOME!, '.dreamcontext'), { recursive: true, force: true }); });

const C1 = '11111111-1111-4111-8111-111111111111';
const CARD = {
  cardRef: 'a'.repeat(32), postingSession: C1, vault: 'acme', postingConversationId: C1,
  spec: { type: 'run', id: 'gcloud-login', command: 'gcloud auth login' },
  childRecordId: 'main', childId: C1, deliverTo: C1,
};

function record(queue: unknown[]) {
  return sanitizeSuperState({
    ...emptySuperState(), session: 'sup-1', enabled: true,
    children: { [C1]: { sessionId: C1, brief: 'b', adopted: false, startedAt: 1 } },
    queue,
  });
}

describe('the record keeps an owner card\'s fields and its two events', () => {
  it('an owner item keeps its card handle, Remind mark and result line; its mirror too', () => {
    const s = record([
      { id: 'q-1', sessionId: C1, kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'run', id: 'gcloud-login' }, card: CARD, remindAt: 5, delivery: 'held:cap' },
      { id: 'q-2', sessionId: C1, kind: 'member', state: 'pending', createdAt: 2, member: 'ops', answers: 'q-9', of: 'owner', wait: { kind: 'run', id: 'gcloud-login' }, card: CARD, delivery: 'sent' },
    ]);
    expect(s.queue[0]).toMatchObject({ card: { cardRef: CARD.cardRef, deliverTo: C1, spec: { type: 'run', command: 'gcloud auth login' } }, remindAt: 5, delivery: 'held:cap' });
    expect(s.queue[1]).toMatchObject({ card: { cardRef: CARD.cardRef }, delivery: 'sent' });
  });

  it('a hand-edited handle, an unknown line or a handle on another kind is dropped', () => {
    const s = record([
      { id: 'q-1', sessionId: C1, kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'run', id: 'x' }, card: { ...CARD, spec: { type: 'pin', id: 'x', facts: [] } }, delivery: 'sent' },
      { id: 'q-2', sessionId: C1, kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'run', id: 'y' }, card: CARD, delivery: 'teleported' },
      { id: 'q-3', sessionId: C1, kind: 'done', state: 'pending', createdAt: 1, card: CARD, delivery: 'sent' },
    ]);
    expect(s.queue[0].card).toBeUndefined();
    expect(s.queue[0].delivery).toBeUndefined();
    expect(s.queue[1].card).toBeDefined();
    expect(s.queue[1].delivery).toBeUndefined();
    expect(s.queue[2].card).toBeUndefined();
  });

  it('`parked` keeps the card it names; `owner-result` lives only with its fact', () => {
    const s = record([
      { id: 'q-1', sessionId: C1, kind: 'parked', state: 'pending', createdAt: 1, wait: { kind: 'run', id: 'gcloud-login' } },
      { id: 'q-2', sessionId: C1, kind: 'owner-result', state: 'pending', createdAt: 2, ownerResult: { card: 'run', cardRef: CARD.cardRef, outcome: 0, text: '[ran in chat]' } },
      { id: 'q-3', sessionId: C1, kind: 'owner-result', state: 'pending', createdAt: 3 },
      { id: 'q-4', sessionId: C1, kind: 'owner-result', state: 'pending', createdAt: 4, ownerResult: { card: 'run', cardRef: 'nope', outcome: 0, text: '' } },
    ]);
    expect(s.queue.map((q) => q.id)).toEqual(['q-1', 'q-2']);
    expect(s.queue[0].wait).toEqual({ kind: 'run', id: 'gcloud-login' });
    expect(s.queue[1].ownerResult).toEqual({ card: 'run', cardRef: CARD.cardRef, outcome: 0, text: '[ran in chat]' });
  });

  it('both are Super pump turns', () => {
    expect(SUPER_TURN_KINDS).toContain('parked');
    expect(SUPER_TURN_KINDS).toContain('owner-result');
  });
});

describe('the outbox: an Allow the server kept goes out in this same run', () => {
  const deps = (sent: string[]) => ({
    boot: OUTBOX_BOOT, isIdle: () => true, isChild: () => true, superToken: () => 'tok', transcript: () => null,
    send: async (_t: string, _c: string, text: string) => { sent.push(text); return 'sent'; },
  });
  it('server-kept: delivered at the chat\'s first idle; window-queued: still the window\'s', async () => {
    const root = `/tmp/owner-card-outbox-${Math.random().toString(36).slice(2)}/_dream_context`;
    await addToOutbox(root, C1, 'window queued it', Date.now());
    await addToOutbox(root, C1, 'the owner allowed this call', Date.now(), { server: true });
    const sent: string[] = [];
    const r = await pumpOutbox(root, C1, deps(sent));
    expect(sent).toEqual(['the owner allowed this call']);
    expect(r.delivered).toHaveLength(1);
    expect((await readOutbox(root)).map((i) => i.text)).toEqual(['window queued it']);
  });
});

describe('a member mirror\'s Remind mark is the mirror\'s own (mirror-only-mark-overwritten-by-sync)', () => {
  it('a mirror marked `remindAt` keeps it through a sync another member write triggers; the fields the member owns still follow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owner-card-store-'));
    try {
      const root = join(dir, 'acme', '_dream_context');
      mkdirSync(join(root, 'state'), { recursive: true });
      writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true }));
      resetSuperIndex();
      _resetSuperInbox();
      setMemberGateForTest(() => null);
      const memberKey = superKey(root, 'm:rota');
      const own: SuperQueueItem = {
        id: 'q-own1', sessionId: C1, kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'run', id: 'gcloud-login' }, ownerText: 'sign in',
        card: { ...CARD, childRecordId: 'm:rota' } as SuperQueueItem['card'],
      };
      const member = (q: SuperQueueItem): SuperState => ({ ...emptySuperState(), member: 'rota', session: 'rota-sess', enabled: true, queue: [q] });
      await syncMemberMirrors(memberKey, member(own));
      await _superInboxDrained();
      let mirror = (await readSuperState(root)).queue.find((q) => q.kind === 'member' && q.answers === 'q-own1');
      expect(mirror).toMatchObject({ of: 'owner', card: { cardRef: CARD.cardRef } });
      expect(mirror?.remindAt).toBeUndefined();
      // Telegram's "Mac'e dönünce hatırlat" marks the mirror in MAIN's record (lane B, asks.ts).
      await writeSuper(root, (s) => { const m = s.queue.find((q) => q.id === mirror!.id); if (m) m.remindAt = 1234; });
      // Another write of the member's record: its item's line and its result line changed.
      await syncMemberMirrors(memberKey, member({ ...own, ownerText: 'sign in again', delivery: 'held:cap' }));
      await _superInboxDrained();
      mirror = (await readSuperState(root)).queue.find((q) => q.kind === 'member' && q.answers === 'q-own1');
      expect(mirror).toMatchObject({ ownerText: 'sign in again', delivery: 'held:cap', remindAt: 1234 });
      // And once more with nothing of the member's changed: the mark still stands.
      await syncMemberMirrors(memberKey, member({ ...own, ownerText: 'sign in again', delivery: 'held:cap' }));
      await _superInboxDrained();
      expect((await readSuperState(root)).queue.find((q) => q.id === mirror!.id)?.remindAt).toBe(1234);
    } finally {
      setMemberGateForTest(null);
      _resetSuperInbox();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
