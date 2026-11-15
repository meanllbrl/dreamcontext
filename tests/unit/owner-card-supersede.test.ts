/**
 * "Waiting on you" closes what the owner no longer owes (bekleyen-kapanmaz, owner 2026-11-15:
 * "bana bekleyen bir şey yok, bakıyorum o tarafta bekleyen çok").
 *
 * Field record: one child posted `run:notary-profile`, then re-asked under NEW ids
 * (`notary-profile-2`, `-3`, `-4`) and a checklist `apple-agreement-holder` then
 * `apple-agreement-2`. He did the newest each time (the last run exited 0); the replaced cards
 * stood in the agenda as "Needs you" until the Super closed them by hand. The rule now
 * (`supersedesCard`): a later card of the same kind replaces the child's earlier open one, in the
 * registry, in the Super record (a restart's re-adopted copy too) and in the chat's card record.
 * His run closes its card whatever its exit code. The drawer's Super mark reads the agenda's rule.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-card-supersede-home-`);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetChatRegistry, getChat, onOwnerWaitChange, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { emptySuperState, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';
import { syncOwnerDraft } from '../../src/lib/super/inbox.js';
import { _resetSuperSends, noteSuperSend, supersedesCard } from '../../src/lib/super/owner-wait.js';
import { needsOwnerItem } from '../../src/lib/super/owner-needs.js';
import { rosterSummary } from '../../src/server/routes/agent-sessions.js';
import { _resetCardsForTests, listCards, noteAssistantCards, rebuildCards, setCardsHomeForTests } from '../../src/lib/cards/records.js';
import { TG_SENTINEL } from '../../src/lib/telegram/contract.js';
import { buildRunReport } from '../../dashboard/src/components/sleepy/chat/runReport.js';
import { agendaWaitingCount, needsOwner, type JobLook } from '../../dashboard/src/components/sleepy/super/superHandover.js';

const fence = (o: Record<string, unknown>) => `\`\`\`dream-view\n${JSON.stringify(o)}\n\`\`\``;
const run = (id: string, command = `xcrun notarytool store-credentials ${id}`) => ({ type: 'run', id, command, why: 'Apple asks for your app-specific password' });
const checklist = (id: string, title: string) => ({ type: 'checklist', id, title, items: [{ id: '1', text: 'Accept the agreement' }] });
const say = (h: ChatHandle, text: string, uuid: string) => h.observe({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
const reg = (sid: string): ChatHandle => registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode: 'basic' });
/** A respawned child the Super resumed (its own send: nothing of his that could answer a wait). */
const resumed = (sid: string): void => { const h = reg(sid); noteSuperSend(sid, 'go on'); h.userSent('go on'); h.observe({ type: 'result' }); };
const record = (sid: string, queue: SuperQueueItem[] = []): SuperState => ({
  ...emptySuperState(), session: 'sup-1', enabled: true,
  children: { [sid]: { sessionId: sid, brief: '', adopted: false, startedAt: 1, row: 'working' } },
  queue,
});
const open = (s: SuperState) => s.queue.filter((q) => q.kind === 'owner' && q.state !== 'done').map((q) => q.wait?.id);
const look: JobLook = { live: () => null, titleFor: (sid) => sid, superTitle: 'Super Agent' };

beforeEach(() => {
  rmSync(join(process.env.HOME!, '.dreamcontext'), { recursive: true, force: true });
  _resetChatRegistry();
  _resetSuperSends();
});

describe('supersedesCard: the one rule', () => {
  it('a card replaces an earlier card of the SAME kind only; a refusal or a stall is no card', () => {
    expect(supersedesCard({ kind: 'run' }, { kind: 'run' })).toBe(true);
    expect(supersedesCard({ kind: 'checklist' }, { kind: 'checklist' })).toBe(true);
    expect(supersedesCard({ kind: 'checklist' }, { kind: 'run' })).toBe(false);
    expect(supersedesCard({ kind: 'refusal' }, { kind: 'refusal' })).toBe(false);
    expect(supersedesCard({ kind: 'stalled' }, { kind: 'stalled' })).toBe(false);
  });
});

describe('the field case: re-asked under a new id, the old card leaves Waiting on you', () => {
  it('a new run card and a new checklist replace the old ones; nothing he no longer owes is counted', () => {
    const h = reg('c1');
    h.userSent('go');
    const s = record('c1');
    say(h, `Apple needs your password.\n\n${fence(run('notary-profile-2'))}`, 'm1');
    syncOwnerDraft(s, 'c1', getChat('c1'), 1_000);
    expect(open(s)).toEqual(['notary-profile-2']);
    h.observe({ type: 'result' });
    // The next message: a checklist and a run card again, under new ids.
    say(h, `Accept the agreement, then the password again.\n\n${fence(checklist('apple-agreement-holder', 'VANGO: Account Holder'))}\n\n${fence(run('notary-profile-3'))}`, 'm2');
    syncOwnerDraft(s, 'c1', getChat('c1'), 2_000);
    expect(open(s)).toEqual(['apple-agreement-holder', 'notary-profile-3']);
    h.observe({ type: 'result' });
    say(h, `One more agreement.\n\n${fence(checklist('apple-agreement-2', 'VANGO: pending agreement'))}\n\n${fence(run('notary-profile-4'))}`, 'm3');
    syncOwnerDraft(s, 'c1', getChat('c1'), 3_000);
    expect(open(s)).toEqual(['apple-agreement-2', 'notary-profile-4']);
    expect(getChat('c1')?.ownerWaits?.map((w) => w.id)).toEqual(['apple-agreement-2', 'notary-profile-4']);
    expect(agendaWaitingCount(s, look)).toBe(2);
    // He runs it; it fails (exit 1): the card is still done, nothing waits on him for it.
    h.observe({ type: 'result' });
    h.userSent(buildRunReport(run('notary-profile-4').command, { code: 1, tail: 'Error: password rejected', seconds: 4 }, { includeOutput: true }), { server: true });
    syncOwnerDraft(s, 'c1', getChat('c1'), 4_000);
    expect(open(s)).toEqual(['apple-agreement-2']);
    // The re-posted run card after the failure is a new ask, the only one beside the checklist.
    h.observe({ type: 'result' });
    say(h, `It was rejected, try once more.\n\n${fence(run('notary-profile-5'))}`, 'm4');
    syncOwnerDraft(s, 'c1', getChat('c1'), 5_000);
    expect(open(s)).toEqual(['apple-agreement-2', 'notary-profile-5']);
  });

  it('two cards of one kind in ONE message are two asks: neither replaces the other', () => {
    const h = reg('c2');
    h.userSent('go');
    const s = record('c2');
    say(h, `${fence(run('firebase', 'firebase login'))}\n\n${fence(run('gcloud', 'gcloud auth login'))}`, 'm1');
    syncOwnerDraft(s, 'c2', getChat('c2'), 1_000);
    expect(open(s)).toEqual(['firebase', 'gcloud']);
  });

  it('two asks of one kind in ONE turn, across a tool call (two frames), stay two asks', () => {
    const h = reg('c5');
    h.userSent('go');
    const s = record('c5');
    say(h, fence(run('firebase', 'firebase login')), 'f1');
    h.observe({ type: 'assistant', uuid: 'f2', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
    h.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    say(h, fence(run('gcloud', 'gcloud auth login')), 'f3');
    syncOwnerDraft(s, 'c5', getChat('c5'), 1_000);
    expect(open(s)).toEqual(['firebase', 'gcloud']);
    // The next turn's run card replaces both.
    h.observe({ type: 'result' });
    say(h, fence(run('firebase-2', 'firebase login --reauth')), 'f4');
    syncOwnerDraft(s, 'c5', getChat('c5'), 2_000);
    expect(open(s)).toEqual(['firebase-2']);
  });

  it('after a restart an orphan closes only when its card record says it was REPLACED (the turn rule), never by age', () => {
    const home = mkdtempSync(join(tmpdir(), 'cards-home-'));
    setCardsHomeForTests(home);
    _resetCardsForTests();
    try {
      const sid = '22222222-3333-4444-8555-666666666666';
      resumed(sid);
      // The transcript read back: holder (turn 1), then two run cards of ONE turn across a tool
      // call, and agreement-2 (turn 2), which replaced holder.
      const row = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
      const his = (uuid: string) => JSON.stringify({ type: 'user', uuid, message: { content: [{ type: 'text', text: `${TG_SENTINEL}abc123${TG_SENTINEL}ok` }] } });
      const tool = JSON.stringify({ type: 'user', uuid: 'tr', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
      rebuildCards(sid, 'acme', [his('u0'), row('m1', fence(checklist('holder', 'Holder'))), his('u1'),
        row('m2', fence(run('fb', 'firebase login'))), tool, row('m3', fence(run('gc', 'gcloud auth login'))), row('m4', fence(checklist('agreement-2', 'Pending')))].join('\n'));
      const ref = (id: string) => listCards(sid).find((c) => c.id === id)!.cardRef;
      const item = (id: string, kind: 'run' | 'checklist', wid: string, at: number): SuperQueueItem => ({
        id, sessionId: sid, kind: 'owner', state: 'escalated', createdAt: at, wait: { kind, id: wid, key: wid }, ownerText: wid,
        card: { cardRef: ref(wid), postingSession: sid } as never,
      });
      const s = record(sid, [item('q-holder', 'checklist', 'holder', 1), item('q-fb', 'run', 'fb', 2), item('q-gc', 'run', 'gc', 3), item('q-ag', 'checklist', 'agreement-2', 4)]);
      syncOwnerDraft(s, sid, getChat(sid), 10);
      // fb is OLDER than gc but of the same turn: it stays.
      expect(open(s)).toEqual(['fb', 'gc', 'agreement-2']);
      expect(getChat(sid)?.ownerWaits?.map((w) => w.id)).toEqual(['fb', 'gc', 'agreement-2']);
      // Settled for good: a second pass changes nothing and opens no new item.
      syncOwnerDraft(s, sid, getChat(sid), 20);
      expect(open(s)).toEqual(['fb', 'gc', 'agreement-2']);
      expect(s.queue).toHaveLength(4);
    } finally {
      setCardsHomeForTests(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('the SAME card posted again (same id, a later message): the item follows the new copy, the old one settles (kart-alta-yapisma-2)', () => {
    // Field case, 15 Nov: the child re-posted `run:dreamcontext-super-delegate-task-askida`. Its
    // record closed the old copy as superseded, but the Super's item kept the OLD handle: under the
    // chat's last message stood "needs you" around a card that said "Replaced", with only Not
    // needed, and the new copy never reached the Super chat.
    const home = mkdtempSync(join(tmpdir(), 'cards-home-'));
    setCardsHomeForTests(home);
    _resetCardsForTests();
    try {
      const sid = '33333333-4444-4555-8666-777777777777';
      const h = reg(sid);
      h.userSent('go');
      const s = record(sid);
      // The inbox syncs only when the registry says the child's waits changed (inbox.ts
      // onOwnerWaitChange): the test drives it the same way, never by calling it by hand.
      let now = 1_000;
      const off = onOwnerWaitChange((e) => { if (e.sessionId === sid) syncOwnerDraft(s, sid, e, now); });
      const card = run('dreamcontext-super-delegate-task-askida', 'xcrun notarytool store-credentials dreamcontext-notary');
      say(h, `Apple needs your password.\n\n${fence(card)}`, 'm1');
      const first = s.queue.find((q) => q.kind === 'owner')!;
      expect(first.card?.cardRef).toBeTruthy();
      h.observe({ type: 'result' });
      now = 2_000;
      say(h, `Still waiting on this one.\n\n${fence(card)}`, 'm2');
      off();
      const live = s.queue.filter((q) => q.kind === 'owner' && q.state !== 'done');
      // One item waits, and it is the NEW copy, placed at its own time.
      expect(live).toHaveLength(1);
      expect(live[0].id).not.toBe(first.id);
      expect(live[0].card?.cardRef).not.toBe(first.card?.cardRef);
      expect(live[0].createdAt).toBe(2_000);
      // The old item settled: nothing he owes, it never holds the chat's bottom.
      expect(first.state).toBe('done');
      expect(listCards(sid).find((c) => c.cardRef === first.card!.cardRef)?.closedBy).toBe('superseded');
      expect(agendaWaitingCount(s, look)).toBe(1);
      // A later frame of the same message (same copy) changes nothing.
      syncOwnerDraft(s, sid, getChat(sid), 3_000);
      expect(s.queue.filter((q) => q.kind === 'owner')).toHaveLength(2);
    } finally {
      setCardsHomeForTests(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a card he already acted on (its result on its way) is never replaced', () => {
    resumed('c4');
    const s = record('c4', [
      { id: 'q-a', sessionId: 'c4', kind: 'owner', state: 'escalated', createdAt: 1, delivery: 'sent', wait: { kind: 'run', id: 'a' } },
      { id: 'q-b', sessionId: 'c4', kind: 'owner', state: 'escalated', createdAt: 2, wait: { kind: 'run', id: 'b' } },
    ]);
    syncOwnerDraft(s, 'c4', getChat('c4'), 10);
    expect(s.queue.find((q) => q.id === 'q-a')?.state).toBe('escalated');
  });
});

describe('the chat\'s card record follows the same rule', () => {
  const SID = '11111111-2222-4333-8444-555555555555';
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cards-home-')); setCardsHomeForTests(home); _resetCardsForTests(); });
  afterEach(() => { setCardsHomeForTests(null); rmSync(home, { recursive: true, force: true }); });

  it('live: a later message\'s card of the same kind closes the old one as superseded; same message never', () => {
    noteAssistantCards(SID, 'acme', 'm1', `${fence(run('a'))}\n${fence(run('b'))}\n${fence(checklist('c', 'Steps'))}`);
    expect(listCards(SID).map((c) => c.state)).toEqual(['open', 'open', 'open']);
    noteAssistantCards(SID, 'acme', 'm2', fence(run('a-2')));
    expect(listCards(SID).map((c) => [c.id, c.state, c.closedBy ?? ''])).toEqual([
      ['a', 'closed', 'superseded'], ['b', 'closed', 'superseded'], ['c', 'open', ''], ['a-2', 'open', ''],
    ]);
  });

  it('live: two messages of ONE turn never replace each other', () => {
    noteAssistantCards(SID, 'acme', 'm1', fence(run('a')), `${SID}:3`);
    noteAssistantCards(SID, 'acme', 'm2', fence(run('b')), `${SID}:3`);
    expect(listCards(SID).map((c) => c.state)).toEqual(['open', 'open']);
    noteAssistantCards(SID, 'acme', 'm3', fence(run('c')), `${SID}:4`);
    expect(listCards(SID).map((c) => c.state)).toEqual(['closed', 'closed', 'open']);
  });

  it('read back: a turn is everything between two of his messages', () => {
    const row = (type: string, uuid: string, text: string) => JSON.stringify({ type, uuid, message: { content: [{ type: 'text', text }] } });
    const tool = JSON.stringify({ type: 'user', uuid: 'tr', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
    // His turns here are Telegram blocks: they start a turn but answer no card (a plain line would
    // close these pre-tracking cards by the legacy rule, which is not what this checks).
    const his = (uuid: string) => row('user', uuid, `${TG_SENTINEL}abc123${TG_SENTINEL}go on`);
    rebuildCards(SID, 'acme', [his('u0'), row('assistant', 'm1', fence(run('a'))), tool, row('assistant', 'm2', fence(run('b'))), his('u1'), row('assistant', 'm3', fence(checklist('c', 'Steps'))), his('u2'), row('assistant', 'm4', fence(run('d')))].join('\n'));
    expect(listCards(SID).map((c) => [c.id, c.state])).toEqual([['a', 'closed'], ['b', 'closed'], ['c', 'open'], ['d', 'open']]);
    expect(listCards(SID).map((c) => c.closedBy ?? '')).toEqual(['superseded', 'superseded', '', '']);
  });

  it('read back after a restart: the same', () => {
    const row = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
    const his = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: `${TG_SENTINEL}abc123${TG_SENTINEL}ok` }] } });
    rebuildCards(SID, 'acme', [row('m1', fence(checklist('holder', 'Holder'))), his, row('m2', fence(checklist('agreement-2', 'Pending')))].join('\n'));
    expect(listCards(SID).map((c) => [c.id, c.state])).toEqual([['holder', 'closed'], ['agreement-2', 'open']]);
  });
});

describe('the drawer\'s Super mark and the agenda count from ONE rule', () => {
  const items: SuperQueueItem[] = [
    { id: '1', sessionId: 'c', kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'run', id: 'x' } },
    { id: '2', sessionId: 'c', kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'run', id: 'x' }, delivery: 'sent', card: { cardRef: 'r' } as never },
    { id: '3', sessionId: 'c', kind: 'owner', state: 'done', createdAt: 1 },
    { id: '4', sessionId: 'c', kind: 'permission', state: 'pending', createdAt: 1 },
    { id: '5', sessionId: 'c', kind: 'permission', state: 'pending', createdAt: 1, toSuper: true },
    { id: '6', sessionId: 'c', kind: 'nudge', state: 'pending', createdAt: 1 },
    { id: '7', sessionId: 'c', kind: 'question', state: 'pending', createdAt: 1, direct: true },
    { id: '8', sessionId: 'c', kind: 'question', state: 'pending', createdAt: 1, direct: true, team: true } as never,
    { id: '9', sessionId: 'c', kind: 'question', state: 'escalated', createdAt: 1 },
    { id: '10', sessionId: 'c', kind: 'member', state: 'pending', createdAt: 1 },
    { id: '11', sessionId: 'c', kind: 'routine', state: 'pending', createdAt: 1 },
    { id: '12', sessionId: 'c', kind: 'ask', state: 'pending', createdAt: 1, own: true },
    { id: '13', sessionId: 'c', kind: 'done', state: 'pending', createdAt: 1 },
    { id: '14', sessionId: 'c', kind: 'owner-result', state: 'pending', createdAt: 1 },
  ];

  it('the server\'s copy agrees with the window\'s needsOwner on every kind', () => {
    for (const q of items) expect([q.id, needsOwnerItem(q)]).toEqual([q.id, needsOwner(q)]);
  });

  it('a card he acted on lights no Super mark (it used to: the old copy counted any open owner item)', () => {
    const summary = (queue: SuperQueueItem[]) => rosterSummary({ sessions: [], windows: [] } as never, { enabled: true, session: 'sup', queue });
    expect(summary([items[1]]).superAsking).toBe(false);
    expect(summary([items[5], items[4]]).superAsking).toBe(false);
    expect(summary([items[0]]).superAsking).toBe(true);
  });
});
