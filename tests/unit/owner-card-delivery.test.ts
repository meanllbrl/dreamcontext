/**
 * sahip-karti-yerinde W2 lane A, criterion 6 (K6, the deliver / wake / notice rows): the owner's
 * result on a crew child's card is held by the server until THAT child has taken it.
 *
 *  - a live child (no window needed) gets it as an `ownerReceipt` frame (its FULL form), the wait
 *    closes by the card id, the entry leaves the store, the Super hears ONE `owner-result`;
 *  - a receipt file that does not verify under this boot's key delivers nothing, wakes nothing,
 *    closes nothing and tells the Super nothing;
 *  - a not-live child is woken; each `held:*` outcome keeps the receipt, says its line on the item
 *    and tells the Super once, and is delivered by its REAL clearing trigger (a child of the
 *    project ends; the owning Super's window socket comes up), never by calling the retry;
 *  - an ended child: no delivery, the Super has the kept form, the item closes `ended`;
 *  - a typed checklist secret reaches only the child; the event and the store hold its mark;
 *  - two actions on one child keep their own entries; delivering one leaves the other;
 *  - a run cut off by a restart: ONE `server` notice per entry per boot, built from the card's
 *    command, closing nothing; a hand-written placeholder for a card the child lacks says nothing.
 *
 * Through the REAL registry, inbox and receipt store, with a fake crew handle and a fake waker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-card-deliver-home-`);
});

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetChatRegistry, getChat, registerChat, registerCrewHandle, type ChatHandle, type OwnerReceiptMark,
} from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type OwnerWakeOutcome, type SuperQueueItem } from '../../src/lib/super/types.js';
import {
  OWNER_RESULT_LINE, _resetSuperInbox, _superInboxDrained, attachSuperInbox, deliverHeldOwnerReceipts, startSuperInbox, writeSuper,
  type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { _resetSuperSends } from '../../src/lib/super/owner-wait.js';
import { _resetCardsForTests, setCardsHomeForTests } from '../../src/lib/cards/records.js';
import {
  CUT_OFF_NOTICE_TAIL, _resetOwnerReceiptsForTests, _restartOwnerReceiptsForTests, checklistReceipt, deliverOwnerReceipt, holdOwnerReceipt, readOwnerReceipts,
  registerOwnerCardWaker, registerOwnerReceiptDeliverer, type OwnerReceiptTarget,
} from '../../src/server/owner-receipts.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
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
const CHECKLIST = { type: 'checklist', id: 'asc', title: 'App Store Connect key', items: [{ id: '1', text: 'Paste the key id', wants: 'secret' }, { id: '2', text: 'Done' }] };
const say = (h: ChatHandle, text: string, uuid = MSG) => h.observe({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: `conv-${sid.slice(0, 4)}`, vault: 'acme', mode, crew: mode !== 'super' });
const report = (code = 0) => buildRunReport(RUN.command, { code, tail: 'Logged in.', seconds: 9 }, { includeOutput: true });
const T1: OwnerReceiptTarget = { childRecordId: 'main', childId: C1 };

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

/** The fake crew handle: an `ownerReceipt` goes through the registry exactly as agent-chat's
 *  writeOwnerTurn sends it; `failNext` makes the next one not go in. */
function crew(sid: string, h: ChatHandle) {
  const got: Array<{ text: string; mark: OwnerReceiptMark }> = [];
  const server: string[] = [];
  const ctl = { failNext: 0 };
  registerCrewHandle(sid, {
    sendServerTurn: (t) => { server.push(t); h.userSent(t, { server: true, closesNothing: true }); return true; },
    sendOwnerReceipt: async (text, mark) => {
      if (ctl.failNext > 0) { ctl.failNext -= 1; return false; }
      got.push({ text, mark });
      h.userSent(text, { server: true, ownerReceipt: mark });
      return true;
    },
  });
  return { got, server, ctl };
}

let wakeOutcome: OwnerWakeOutcome = 'woken';
const wakes: OwnerReceiptTarget[] = [];

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
  return { sup, hs, delivered, inbox };
}

const state = () => readSuperState(root);
const ofKind = async (kind: string, sid?: string) => (await state()).queue.filter((q) => q.kind === kind && (!sid || q.sessionId === sid));
const cardItem = async (sid = C1): Promise<SuperQueueItem> => (await ofKind('owner')).find((q) => q.card && q.card.postingSession === sid) as SuperQueueItem;

async function postCard(h: ChatHandle, card: Record<string, unknown> = RUN): Promise<SuperQueueItem> {
  say(h, `Only you can do this.\n\n${fence(card)}`);
  h.observe({ type: 'result' });
  await drain();
  return cardItem();
}

async function deliver(t: OwnerReceiptTarget = T1) {
  const p = deliverOwnerReceipt(t);
  await drain();
  return p;
}

describe('the owner\'s card result reaches the child that asked (K6)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    dir = mkdtempSync(join(tmpdir(), 'owner-card-deliver-'));
    setCardsHomeForTests(process.env.HOME!);
    _resetChatRegistry();
    _resetSuperSends();
    _resetCardsForTests();
    _resetOwnerReceiptsForTests();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
    registerOwnerReceiptDeliverer(deliverHeldOwnerReceipts);
    wakeOutcome = 'woken';
    wakes.length = 0;
    registerOwnerCardWaker(async (t) => { wakes.push(t); return wakeOutcome; });
  });
  afterEach(async () => {
    await drain().catch(() => undefined);
    vi.useRealTimers();
    _resetSuperInbox();
    _resetOwnerReceiptsForTests();
    setCardsHomeForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('hold → a live child with no window gets it as `ownerReceipt`, the card closes by id, the Super hears it once', async () => {
    const { hs, delivered } = await boot([C1]);
    const item = await postCard(hs[0]);
    const c = crew(C1, hs[0]);
    holdOwnerReceipt(T1, { id: 'run-1', cardRef: item.card!.cardRef, kind: 'run', text: report() });
    expect(await deliver()).toBe('delivered');
    expect(c.got).toEqual([{ text: report(), mark: { kind: 'run', id: 'gcloud-login' } }]);
    expect(getChat(C1)?.ownerWaits ?? []).toEqual([]);
    expect(readOwnerReceipts(T1)).toEqual([]);
    expect((await state()).queue.find((q) => q.id === item.id)).toMatchObject({ state: 'done', delivery: 'sent' });
    const results = await ofKind('owner-result', C1);
    expect(results).toHaveLength(1);
    expect(results[0].ownerResult).toMatchObject({ card: 'run', cardRef: item.card!.cardRef, outcome: 0 });
    const ev = delivered.map((d) => d.text).join('\n');
    expect(ev).toMatch(new RegExp(`child=${C1} event=owner-result card=run exit=0`));
    expect(ev).toContain(OWNER_RESULT_LINE);
    // Nothing more to send: no second frame, no second event.
    expect(await deliver()).toBe('nothing');
    expect(c.got).toHaveLength(1);
    expect(await ofKind('owner-result', C1)).toHaveLength(1);
  });

  it('a receipt file that does not verify (from before a restart, or written by hand) delivers nothing and tells nothing', async () => {
    const { hs, delivered } = await boot([C1]);
    const item = await postCard(hs[0]);
    const c = crew(C1, hs[0]);
    holdOwnerReceipt(T1, { id: 'run-1', cardRef: item.card!.cardRef, kind: 'run', text: report() });
    _restartOwnerReceiptsForTests();
    // And one written by hand beside it.
    const file = join(process.env.HOME!, '.dreamcontext', 'cards', 'receipts', `main__${C1}.json`);
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { v: 1; entries: Array<Record<string, unknown>> };
    raw.entries.push({ id: 'forged', cardRef: item.card!.cardRef, kind: 'run', text: report(), at: 1, mac: 'f'.repeat(64) });
    writeFileSync(file, JSON.stringify(raw));
    const before = delivered.length;
    expect(await deliver()).toBe('nothing');
    expect(c.got).toEqual([]);
    expect(wakes).toEqual([]);
    expect(getChat(C1)?.ownerWaits?.map((w) => w.id)).toEqual(['gcloud-login']);
    expect(await ofKind('owner-result')).toHaveLength(0);
    expect(delivered).toHaveLength(before);
    expect(readOwnerReceipts(T1)).toHaveLength(2);
  });

  it('a parked child is woken; `held:cap` keeps it, tells the Super once, and a child of the project ending delivers it', async () => {
    const { hs } = await boot([C1, C2]);
    const item = await postCard(hs[0]);
    hs[0].exited();
    await advance(60_000);
    wakeOutcome = 'held:cap';
    holdOwnerReceipt(T1, { id: 'run-1', cardRef: item.card!.cardRef, kind: 'run', text: report(3) });
    expect(await deliver()).toBe('held:cap');
    expect(wakes).toHaveLength(1);
    expect((await state()).queue.find((q) => q.id === item.id)).toMatchObject({ state: expect.not.stringMatching(/^done$/), delivery: 'held:cap' });
    expect(readOwnerReceipts(T1)).toHaveLength(1);
    expect((await ofKind('owner-result', C1)).map((q) => q.ownerResult?.outcome)).toEqual([3]);
    // The clearing edge: another child of this project ends (or is parked).
    wakeOutcome = 'woken';
    hs[1].exited();
    await advance(5_000, 1_000);
    expect(wakes).toHaveLength(2);
    expect((await state()).queue.find((q) => q.id === item.id)?.delivery).toBe('waking');
    // The woken child's live edge (its first turn end) takes it.
    const h = reg(C1);
    const c = crew(C1, h);
    h.userSent('');
    await drain();
    h.observe({ type: 'result' });
    await drain();
    expect(c.got.map((g) => g.mark)).toEqual([{ kind: 'run', id: 'gcloud-login' }]);
    expect(readOwnerReceipts(T1)).toEqual([]);
    // Exactly one owner-result for the one action, across held and delivered.
    expect(await ofKind('owner-result', C1)).toHaveLength(1);
  });

  it('`held:no_window` keeps it until the owning Super\'s window socket comes up', async () => {
    const { hs, delivered } = await boot([C1]);
    const item = await postCard(hs[0]);
    hs[0].exited();
    await advance(60_000);
    wakeOutcome = 'held:no_window';
    holdOwnerReceipt(T1, { id: 'run-1', cardRef: item.card!.cardRef, kind: 'run', text: report() });
    expect(await deliver()).toBe('held:no_window');
    expect((await state()).queue.find((q) => q.id === item.id)?.delivery).toBe('held:no_window');
    wakeOutcome = 'woken';
    // The Super's window attaches again (agent-chat: a Super-mode spawn or `adoptSocket`).
    attachSuperInbox({ id: `inbox-${Math.random()}`, sessionId: SUPER, attached: () => true, idle: () => true, deliver: async (text, event) => { delivered.push({ text, event }); return true; } });
    await drain();
    expect(wakes).toHaveLength(2);
    expect((await state()).queue.find((q) => q.id === item.id)?.delivery).toBe('waking');
  });

  it.todo('`held:phone` is delivered when the phone lets go of the child (agent-chat `phoneLetGo`: driven in the live walk, scripts/verify/verify-owner-card.mjs)');

  it('an ended child: no delivery, the Super has the kept form, the item closes `ended`', async () => {
    const { hs, delivered } = await boot([C1]);
    const item = await postCard(hs[0]);
    hs[0].exited();
    await writeSuper(root, (s) => { s.children[C1].endedAt = Date.now(); });
    await drain();
    holdOwnerReceipt(T1, { id: 'run-1', cardRef: item.card!.cardRef, kind: 'run', text: report() });
    expect(await deliver()).toBe('ended');
    expect(wakes).toEqual([]);
    expect(readOwnerReceipts(T1)).toEqual([]);
    expect((await state()).queue.find((q) => q.id === item.id)).toMatchObject({ state: 'done', delivery: 'ended' });
    const [r] = await ofKind('owner-result', C1);
    expect(r.ownerResult?.text).toContain('$ gcloud auth login');
    expect(delivered.map((d) => d.text).join('\n')).toMatch(/event=owner-result card=run exit=0/);
  });

  it('a typed checklist secret reaches only the live child: the store and the Super hold its mark', async () => {
    const { hs, delivered } = await boot([C1]);
    const item = await postCard(hs[0], CHECKLIST);
    const c = crew(C1, hs[0]);
    const forms = checklistReceipt(item.card!.spec as never, { checked: { 1: true, 2: true }, notes: {}, files: {} }, { 1: 'KEY-ID-SECRET-1234' });
    holdOwnerReceipt(T1, { id: 's-abc', cardRef: item.card!.cardRef, kind: 'checklist', text: forms.kept, full: forms.full });
    const dirFiles = join(process.env.HOME!, '.dreamcontext', 'cards', 'receipts');
    expect(readdirSync(dirFiles).map((f) => readFileSync(join(dirFiles, f), 'utf-8')).join('')).not.toContain('KEY-ID-SECRET-1234');
    expect(await deliver()).toBe('delivered');
    expect(c.got[0].text).toContain('KEY-ID-SECRET-1234');
    const [r] = await ofKind('owner-result', C1);
    expect(r.ownerResult).toMatchObject({ card: 'checklist', outcome: 'submitted' });
    expect(r.ownerResult?.text).not.toContain('KEY-ID-SECRET-1234');
    expect(r.ownerResult?.text).toMatch(/\[secret, 18 chars, sha256:[0-9a-f]{8}\]/);
    expect(delivered.map((d) => d.text).join('\n')).not.toContain('KEY-ID-SECRET-1234');
  });

  it('two actions on one child keep their own entries; one that did not go in stays held', async () => {
    const { hs } = await boot([C1]);
    const item = await postCard(hs[0]);
    const c = crew(C1, hs[0]);
    holdOwnerReceipt(T1, { id: 'run-1', cardRef: item.card!.cardRef, kind: 'run', text: report(1) });
    holdOwnerReceipt(T1, { id: 'run-2', cardRef: item.card!.cardRef, kind: 'run', text: report(0) });
    expect(readOwnerReceipts(T1).map((e) => e.id)).toEqual(['run-1', 'run-2']);
    c.ctl.failNext = 1;
    expect(await deliver()).toBe('delivered');
    expect(readOwnerReceipts(T1).map((e) => e.id)).toEqual(['run-1']);
    // The next live edge takes the one left; its wait is already closed and it is still delivered.
    expect(await deliver()).toBe('delivered');
    expect(c.got).toHaveLength(2);
    expect(readOwnerReceipts(T1)).toEqual([]);
    expect(await ofKind('owner-result', C1)).toHaveLength(2);
  });

  it('a run cut off by a restart: ONE server notice per boot from the card\'s command; a forged placeholder says nothing', async () => {
    const { hs } = await boot([C1]);
    const item = await postCard(hs[0]);
    holdOwnerReceipt(T1, { id: 'run-1', cardRef: item.card!.cardRef, kind: 'run', text: 'placeholder', pending: true });
    holdOwnerReceipt(T1, { id: 'run-x', cardRef: 'f'.repeat(32), kind: 'run', text: 'rm -rf /', pending: true });
    _restartOwnerReceiptsForTests();
    const c = crew(C1, hs[0]);
    // A live edge: a turn of the child's ends (a server turn: the owner's own words would answer
    // the wait, which is not what this row is about).
    hs[0].userSent('go on', { server: true, closesNothing: true });
    hs[0].observe({ type: 'result' });
    await drain();
    expect(c.server).toHaveLength(1);
    expect(c.server[0]).toContain(`$ ${RUN.command}`);
    expect(c.server[0]).toContain(CUT_OFF_NOTICE_TAIL);
    expect(c.server[0]).not.toContain('rm -rf');
    // It closed nothing and delivered nothing.
    expect(getChat(C1)?.ownerWaits?.map((w) => w.id)).toEqual(['gcloud-login']);
    expect(c.got).toEqual([]);
    // A second edge in the same boot says nothing more.
    hs[0].userSent('again', { server: true, closesNothing: true });
    hs[0].observe({ type: 'result' });
    await drain();
    expect(c.server).toHaveLength(1);
  });
});
