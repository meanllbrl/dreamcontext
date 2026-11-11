/**
 * sahip-karti-yerinde W2 lane A, criterion 2 (K2) and the attribution rows of criterion 4:
 * a card a crew child leaves on the owner is a RECORD the server holds, not only a line in a chat.
 *
 *  - its owner item carries the card handle (K1), equal to the chat's own parse;
 *  - the wait outlives the process: a park says `parked` ONCE (never `gone`), a real exit says
 *    `gone` with the item still open, a resume re-adopts it at the entry's live edge, a restart
 *    and a `/clear` rotation keep it;
 *  - the 11 Nov replay (post, park, resume, idle, park) ends with ONE open item and no `gone`;
 *  - a fifth card is the one not tracked (an open card is never evicted), and the child is told;
 *  - only the owner's words or a server-marked receipt close a card: a `window send` into a child
 *    tab, a crew-handle server turn and a receipt-looking Super send close nothing;
 *  - succession moves the open item (deliverTo = the successor), never the record.
 *
 * Through the REAL registry and inbox, on a fake clock. Red on 6fece93a: `addGone` closed every
 * owner item, no item carried a handle, and a server turn that looked like a receipt closed one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-card-life-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CARD_OVERFLOW_TEXT, _resetChatRegistry, dropOwnerWait, getChat, registerChat, registerCrewHandle, type ChatHandle,
} from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem } from '../../src/lib/super/types.js';
import {
  PARKED_LINE, _resetSuperInbox, _superInboxDrained, attachSuperInbox, lookupOwnerCard, moveCardItems, noteChatStarted, noteChildParking,
  startSuperInbox, writeSuper, type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { _resetSuperSends, noteSuperSend } from '../../src/lib/super/owner-wait.js';
import { _resetCardsForTests, cardRefOf, listCards, setCardsHomeForTests } from '../../src/lib/cards/records.js';
import { _resetOwnerReceiptsForTests } from '../../src/server/owner-receipts.js';
import { deliverWindowResult, mintWindowToken, resetWindowControl, sendWindowCommand } from '../../src/lib/window-control.js';
import { buildRunReport } from '../../dashboard/src/components/sleepy/chat/runReport.js';

// Every test starts with an EMPTY machine store under this file's own HOME (the receipts, the
// closed-card files, the outbox, the parked tabs): nothing a test leaves on disk reaches the next,
// so the file passes whole and in any order.
beforeEach(() => { rmSync(join(process.env.HOME!, '.dreamcontext'), { recursive: true, force: true }); });

const SUPER = 'sup-1';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const MSG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let dir: string;
let root: string;

const fence = (o: Record<string, unknown>) => `\`\`\`dream-view\n${JSON.stringify(o)}\n\`\`\``;
const RUN = { type: 'run', id: 'gcloud-login', command: 'gcloud auth login owner@example.com', why: 'it opens a browser for your sign-in' };
const runCard = (id: string) => ({ type: 'run', id, command: `echo ${id}`, why: `run ${id}` });
/** An assistant frame WITH its message uuid (the card record and the handle are keyed by it). */
const say = (h: ChatHandle, text: string, uuid = MSG) => h.observe({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: `conv-${sid.slice(0, 4)}`, vault: 'acme', mode, crew: mode !== 'super' });
const runReport = (command = RUN.command) => buildRunReport(command, { code: 0, tail: 'Logged in.', seconds: 9 }, { includeOutput: true });

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await _superInboxDrained();
  }
}
async function advance(ms: number, step = 5_000): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, left));
    await drain();
  }
}

async function boot(children: string[]) {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  const kids = Object.fromEntries(children.map((sid) => [sid, { sessionId: sid, brief: `brief of ${sid.slice(0, 4)}`, adopted: false, startedAt: 1, row: 'working' }]));
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, children: kids }));
  const sup = reg(SUPER, 'super');
  sup.userSent('');
  sup.observe({ type: 'result' });
  const hs = children.map((sid) => { const h = reg(sid); h.userSent('go'); return h; });
  await startSuperInbox([root]);
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`, sessionId: SUPER, attached: () => true, idle: () => true,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
  };
  attachSuperInbox(inbox);
  await drain();
  return { sup, hs, delivered };
}

const state = () => readSuperState(root);
const ofKind = async (kind: string, sid?: string) => (await state()).queue.filter((q) => q.kind === kind && (!sid || q.sessionId === sid));
const openCards = async (sid: string) => (await ofKind('owner', sid)).filter((q) => q.state !== 'done');

/** A park as agent-chat does it: recorded first, then the process drains and exits. */
async function park(h: ChatHandle, sid: string): Promise<void> {
  noteChildParking(sid);
  h.exited();
  await advance(60_000);
}

/** A resume as `super resume` / the wake does it: a new process of the same pin id. */
async function resume(sid: string): Promise<ChatHandle> {
  const h = reg(sid);
  void noteChatStarted(sid);
  h.userSent('');
  await drain();
  h.observe({ type: 'result' });
  await drain();
  return h;
}

describe('an owner card a crew child leaves is a record the server holds (K1, K2)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    dir = mkdtempSync(join(tmpdir(), 'owner-card-life-'));
    setCardsHomeForTests(process.env.HOME!);
    _resetChatRegistry();
    _resetSuperSends();
    _resetCardsForTests();
    _resetOwnerReceiptsForTests();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
  });
  afterEach(async () => {
    await drain().catch(() => undefined);
    vi.useRealTimers();
    _resetSuperInbox();
    setCardsHomeForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the owner item carries the card handle, its spec the chat\'s own parse (K1)', async () => {
    const { hs } = await boot([C1]);
    say(hs[0], `Needs your sign-in.\n\n${fence(RUN)}`);
    await drain();
    const [item] = await openCards(C1);
    expect(item.card).toMatchObject({
      postingSession: C1, vault: 'acme', postingConversationId: `conv-${C1.slice(0, 4)}`,
      childRecordId: 'main', childId: C1, deliverTo: C1,
      cardRef: cardRefOf(C1, MSG, 0, item.card!.spec),
      spec: { type: 'run', id: 'gcloud-login', command: RUN.command },
    });
    // The handle survives the store's sanitizer (re-parsed with the chat's rules).
    expect(sanitizeSuperState(await state()).queue.find((q) => q.id === item.id)?.card).toEqual(item.card);
    // Lane B's lookup finds it with no live chat: by (posting session, cardRef).
    const l = lookupOwnerCard(C1, item.card!.cardRef);
    expect(l).toMatchObject({ itemId: item.id, itemOpen: true, target: { childRecordId: 'main', childId: C1 }, superSession: SUPER });
  });

  it('a park with an open card says `parked` once, never `gone`; the row stays waiting and the item open', async () => {
    const { hs, delivered } = await boot([C1]);
    say(hs[0], fence(RUN));
    hs[0].observe({ type: 'result' });
    await drain();
    await park(hs[0], C1);
    expect(await ofKind('gone', C1)).toHaveLength(0);
    const parked = await ofKind('parked', C1);
    expect(parked).toHaveLength(1);
    expect(parked[0].wait).toMatchObject({ kind: 'run', id: 'gcloud-login' });
    expect(await openCards(C1)).toHaveLength(1);
    expect((await state()).children[C1].row).toBe('waiting');
    const ev = delivered.map((d) => d.text).join('\n');
    expect(ev).toMatch(new RegExp(`child=${C1} event=parked wait=run`));
    expect(ev).toContain(PARKED_LINE);
    expect(ev).not.toMatch(/event=gone/);
  });

  it('a real exit (no park) still says `gone`, with the card item still open (K2)', async () => {
    const { hs, delivered } = await boot([C1]);
    say(hs[0], fence(RUN));
    hs[0].observe({ type: 'result' });
    await drain();
    hs[0].exited();
    await advance(60_000);
    expect(await ofKind('gone', C1)).toHaveLength(1);
    expect(await ofKind('parked', C1)).toHaveLength(0);
    expect(await openCards(C1)).toHaveLength(1);
    expect((await state()).children[C1].row).toBe('waiting');
    expect(delivered.map((d) => d.text).join('\n')).toMatch(/event=gone/);
  });

  it('the 11 Nov replay: post, park, resume, idle, park ends with ONE open item and zero gone events', async () => {
    const { hs, delivered } = await boot([C1]);
    say(hs[0], fence(RUN));
    hs[0].observe({ type: 'result' });
    await drain();
    await park(hs[0], C1);
    const h2 = await resume(C1);
    // Re-adopted at the resumed entry's live edge: the registry holds the wait again.
    expect(getChat(C1)?.ownerWaits?.map((w) => `${w.kind}:${w.id}`)).toEqual(['run:gcloud-login']);
    expect((await state()).children[C1].row).toBe('waiting');
    await park(h2, C1);
    expect(await openCards(C1)).toHaveLength(1);
    expect(await ofKind('gone', C1)).toHaveLength(0);
    expect(delivered.map((d) => d.text).join('\n')).not.toMatch(/event=gone/);
    // The same card's park is told once.
    expect(await ofKind('parked', C1)).toHaveLength(1);
  });

  it('a server restart and a `/clear` rotation keep the wait; the resumed entry adopts it', async () => {
    const { hs } = await boot([C1]);
    say(hs[0], fence(RUN));
    hs[0].observe({ type: 'result' });
    await drain();
    // `/clear`: the stream moves to a new transcript; the wait and the handle stay.
    hs[0].observe({ type: 'system', subtype: 'init', session_id: 'conv-new-transcript' });
    await drain();
    expect(getChat(C1)?.ownerWaits?.map((w) => w.id)).toEqual(['gcloud-login']);
    const [item] = await openCards(C1);
    expect(item.card?.postingConversationId).toBe(`conv-${C1.slice(0, 4)}`);
    // The server restarts: memory is gone, the record holds the item.
    hs[0].exited();
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    await startSuperInbox([root]);
    await drain();
    expect(await openCards(C1)).toHaveLength(1);
    await resume(C1);
    expect(getChat(C1)?.ownerWaits?.map((w) => w.id)).toEqual(['gcloud-login']);
    expect(await openCards(C1)).toHaveLength(1);
    expect(lookupOwnerCard(C1, item.card!.cardRef)?.itemOpen).toBe(true);
  });

  it('a fifth card is the one not tracked: no open card is evicted, and the child is told', async () => {
    const { hs } = await boot([C1]);
    const told: string[] = [];
    registerCrewHandle(C1, { sendServerTurn: (t) => { told.push(t); return true; } });
    say(hs[0], ['a', 'b', 'c', 'd'].map((id) => fence(runCard(id))).join('\n'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await drain();
    say(hs[0], fence(runCard('e')), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await drain();
    expect(getChat(C1)?.ownerWaits?.map((w) => w.id)).toEqual(['a', 'b', 'c', 'd']);
    expect((await openCards(C1)).map((q) => q.wait?.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(told).toEqual([CARD_OVERFLOW_TEXT({ kind: 'run', id: 'e' })]);
    expect(told[0]).toMatch(/already has 4 open cards/);
  });

  it('succession moves the open item (deliverTo = the successor), never the record; it survives a restart', async () => {
    const { hs } = await boot([C1, C2]);
    say(hs[0], fence(RUN));
    hs[0].observe({ type: 'result' });
    await drain();
    const [item] = await openCards(C1);
    await writeSuper(root, (s) => { moveCardItems(s, C1, C2); });
    await drain();
    const moved = (await state()).queue.find((q) => q.id === item.id) as SuperQueueItem;
    expect(moved.sessionId).toBe(C2);
    expect(moved.card).toMatchObject({ postingSession: C1, childId: C1, deliverTo: C2, cardRef: item.card!.cardRef });
    // The record is still looked up under the session that posted it.
    expect(lookupOwnerCard(C1, item.card!.cardRef)).toMatchObject({ itemId: item.id, target: { childId: C2 } });
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    await startSuperInbox([root]);
    await drain();
    expect(lookupOwnerCard(C1, item.card!.cardRef)).toMatchObject({ itemId: item.id, itemOpen: true, target: { childId: C2 } });
  });
});

describe('who closes a card (K4 attribution)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    _resetChatRegistry();
    _resetSuperSends();
    resetWindowControl();
  });

  const posted = (): ChatHandle => {
    const h = reg(C1);
    h.userSent('go');
    say(h, fence(RUN));
    return h;
  };
  const waits = () => getChat(C1)?.ownerWaits?.map((w) => w.id) ?? [];

  it('a `window send` into a child tab closes no wait, even a receipt-looking one (gap 7)', async () => {
    const h = posted();
    const frames: Array<Record<string, unknown>> = [];
    const { token } = mintWindowToken({ send: (f) => { frames.push(f); return true; }, vault: 'acme', contextRoot: '/x/_dream_context', sessionId: 'other-agent', mode: 'basic' });
    const p = sendWindowCommand(token, 'send', { tab: C1, text: runReport() });
    deliverWindowResult(token, frames[0].id, { ok: true, result: { delivered: 'sent' } });
    expect((await p).ok).toBe(true);
    // The window writes it into the child as a user frame.
    h.userSent(runReport());
    expect(waits()).toEqual(['gcloud-login']);
  });

  it('a send that never reached a window takes its note back: his own report still closes the card', async () => {
    const h = posted();
    const { token, release } = mintWindowToken({ send: () => false, vault: 'acme', contextRoot: '/x/_dream_context', sessionId: 'other-agent', mode: 'basic' });
    expect((await sendWindowCommand(token, 'send', { tab: C1, text: runReport() })).ok).toBe(false);
    release();
    h.userSent(runReport());
    expect(waits()).toEqual([]);
  });

  it('a Super send that looks like a receipt closes nothing; a crew-handle server turn closes nothing', () => {
    const h = posted();
    noteSuperSend(C1, runReport());
    h.userSent(runReport());
    expect(waits()).toEqual(['gcloud-login']);
    h.userSent(runReport(), { server: true, closesNothing: true });
    expect(waits()).toEqual(['gcloud-login']);
  });

  it('dropping a wait closes its card RECORD for every card kind, with or without a live entry, under the posting session', () => {
    setCardsHomeForTests(process.env.HOME!);
    _resetCardsForTests();
    const h = reg(C1);
    h.userSent('go');
    const kinds = [
      { type: 'run', id: 'r1', command: 'echo r1' },
      { type: 'secret', id: 's1', title: 'Key', fields: [{ key: 'K', label: 'K' }] },
      { type: 'checklist', id: 'k1', title: 'Steps', items: [{ id: '1', text: 'Do it' }] },
      { type: 'mcp', id: 'm1', servers: ['linear'] },
    ];
    say(h, kinds.map((k) => fence(k)).join('\n'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    const open = () => listCards(C1).filter((c) => c.state === 'open').map((c) => c.id).sort();
    expect(open()).toEqual(['k1', 'm1', 'r1', 's1']);
    dropOwnerWait(C1, 'checklist', 'k1');
    dropOwnerWait(C1, 'mcp', 'm1');
    expect(open()).toEqual(['r1', 's1']);
    // No live entry any more (parked, gone, restarted): the record still closes.
    h.exited();
    _resetChatRegistry();
    dropOwnerWait(C1, 'secret', 's1');
    expect(open()).toEqual(['r1']);
    // A succeeded card: its item names the successor, its record the session that posted it.
    dropOwnerWait(C2, 'run', 'r1', { postingSession: C1 });
    expect(open()).toEqual([]);
    setCardsHomeForTests(null);
  });

  it('a server-marked receipt closes its card BY ID (whatever its text), and only that card', () => {
    const h = posted();
    say(h, fence(runCard('other')), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(waits()).toEqual(['gcloud-login', 'other']);
    // A mark naming no open card closes nothing.
    h.userSent('[ran in chat]\n$ echo nope', { server: true, ownerReceipt: { kind: 'run', id: 'nope' } });
    expect(waits()).toEqual(['gcloud-login', 'other']);
    h.userSent('anything at all', { server: true, ownerReceipt: { kind: 'run', id: 'other' } });
    expect(waits()).toEqual(['gcloud-login']);
  });
});
