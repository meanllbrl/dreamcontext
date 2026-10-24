/**
 * What piles up while the owner has a question open is never dropped silently (owner 2026-10-22:
 * "Aradan çok şey kaçıyor, söylemesini unuttuğu çok şey oluyor").
 *
 * The single-question rule holds every event turn back while a question is open. Before, the
 * pile went out after the answer as an ordinary `[super events]` turn whose last line says
 * "write no text at all", and a `done` whose child moved on meanwhile was dropped unseen. Now
 * every held event is written to the record's `held` ledger and told:
 *   - the super's own `ask` open → in the SAME message as the owner's answer (`superAnswerDigest`);
 *   - a child's question open → in the first event turn after it closes, rendered in full;
 * each with an instruction to tell or ask them one at a time; moved-on items are told as such.
 * Fictional project and words (synthetic-fixtures pattern).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-held-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperChild, type SuperState } from '../../src/lib/super/types.js';
import {
  HELD_OPEN, _resetSuperInbox, _superInboxDrained, attachSuperInbox, clearOwnerLease, noteHeld, pumpSuper, startSuperInbox, superAnswerDigest,
  superOwnerSpoke, superTurnEnded, writeSuper, type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
const SUPER = 'sup-1';
const W = { timeout: 10_000 };

const child = (sid: string, over: Partial<SuperChild> = {}): SuperChild => ({ sessionId: sid, brief: `brief of ${sid}`, adopted: true, startedAt: 1, ...over } as SuperChild);
function makeVault(state: Partial<SuperState>): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...state }));
}
const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode });
const askQuestion = (h: ChatHandle, requestId: string, question = 'Which database?') => h.observe({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question, options: [{ label: 'postgres' }, { label: 'sqlite' }] }] } },
});
const settle = (h: ChatHandle) => { h.userSent(''); h.observe({ type: 'result' }); };
function fakeInbox() {
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`, sessionId: SUPER, attached: () => true, idle: () => true,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
  };
  return { inbox, delivered };
}
const openAsk = () => writeSuper(root, (s) => {
  s.queue.push({ id: 'q-ask-1', sessionId: SUPER, kind: 'ask', state: 'escalated', ownerText: 'Ship the login fix now?', createdAt: Date.now() });
});
const finish = (sid: string, id: string) => writeSuper(root, (s) => {
  s.children[sid].row = 'done';
  s.queue.push({ id, sessionId: sid, kind: 'done', state: 'pending', createdAt: Date.now() });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-held-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
});
afterEach(async () => {
  let cap: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([_superInboxDrained(), new Promise((r) => { cap = setTimeout(r, 8_000); })]);
  clearTimeout(cap);
  _resetSuperInbox();
  rmSync(dir, { recursive: true, force: true });
});

describe('the held ledger', () => {
  it('notes only while a question is open, only event kinds, once each', () => {
    const s = sanitizeSuperState({
      ...emptySuperState(), session: SUPER, enabled: true,
      queue: [{ id: 'q-d1', sessionId: 'c1', kind: 'done', state: 'pending', createdAt: 1 }],
    });
    expect(noteHeld(s)).toBe(false);
    s.queue.push({ id: 'q-ask-1', sessionId: SUPER, kind: 'ask', state: 'escalated', createdAt: 2 });
    s.queue.push({ id: 'q-p1', sessionId: 'c1', kind: 'permission', state: 'pending', createdAt: 3 });
    expect(noteHeld(s)).toBe(true);
    expect(s.held).toEqual([{ item: 'q-d1', child: 'c1', kind: 'done', at: 1 }]);
    expect(noteHeld(s)).toBe(false);
  });

  it('the record keeps a held entry only while its item is on the queue', () => {
    const s = sanitizeSuperState({
      ...emptySuperState(), session: SUPER, enabled: true,
      queue: [{ id: 'q-d1', sessionId: 'c1', kind: 'done', state: 'pending', createdAt: 1 }],
      held: [{ item: 'q-d1', child: 'c1', kind: 'done', at: 1 }, { item: 'q-gone', child: 'c1', kind: 'done', at: 1 }, { item: 'q-d1', child: 'c1', kind: 'done', at: 1 }, 'junk'],
    });
    expect(s.held).toEqual([{ item: 'q-d1', child: 'c1', kind: 'done', at: 1 }]);
  });
});

describe('the super\'s own question open: the pile rides WITH the owner\'s answer', () => {
  it('a finished job, a result he waits on, a child\'s question and one that moved on: all told, none as a silent batch', async () => {
    makeVault({ children: { c1: child('c1'), c2: child('c2', { awaited: true }), c3: child('c3') } });
    await startSuperInbox([root]);
    settle(reg(SUPER, 'super'));
    const c1 = reg('c1');
    reg('c2');
    reg('c3');
    const { inbox, delivered } = fakeInbox();
    attachSuperInbox(inbox);
    await openAsk();
    // While it is open: c1 asks, c2 (the owner waits on it) and c3 finish, then c3 moves on.
    askQuestion(c1, 'req-1');
    await finish('c2', 'q-done-c2');
    await finish('c3', 'q-done-c3');
    await writeSuper(root, (s) => { s.children.c3.row = 'working'; });
    await vi.waitFor(async () => expect((await readSuperState(root)).held?.map((h) => h.kind).sort()).toEqual(['done', 'done', 'question']), W);
    await new Promise((r) => setTimeout(r, 60));
    expect(delivered).toHaveLength(0); // the single-question rule held every event turn back

    const digest = superAnswerDigest(SUPER);
    expect(digest).not.toBeNull();
    const text = digest!.text;
    expect(text.split('\n')[0]).toBe(`${HELD_OPEN} items=3>`);
    expect(text).toMatch(/- item=q-done-c2 child=c2 event=done awaited=owner status=/);
    expect(text).toMatch(/- item=q-[a-z0-9-]+ child=c1 event=question status=asking question=req-1/);
    expect(text).toContain('<untrusted-project-output vault="acme">Question: Which database?</untrusted-project-output>');
    expect(text).toMatch(/- item=q-done-c3 child=c3 event=done moved-on/);
    expect(text).toMatch(/ONE AT A TIME/);
    expect(text.trimEnd().endsWith('</super-while-you-asked>')).toBe(true);
    expect(digest!.items).toHaveLength(3);

    // The owner's answer is written with that block; the ask closes, the pile is delivered with it.
    superOwnerSpoke(SUPER, Date.now(), digest!.items);
    await vi.waitFor(async () => {
      const s = await readSuperState(root);
      expect(s.queue.find((q) => q.id === 'q-ask-1')?.state).toBe('done');
      expect(s.queue.find((q) => q.id === 'q-done-c2')?.state).toBe('delivered');
      expect(s.queue.find((q) => q.kind === 'question')?.state).toBe('delivered');
      expect(s.held).toBeUndefined();
    }, W);
    expect(superAnswerDigest(SUPER)).toBeNull();

    // That turn ends: the result counts as told; the owner's job stays his until the child is gone
    // (its later results reach him too); the question it did not settle comes back once, as an
    // ordinary event (never lost).
    superTurnEnded(SUPER);
    await vi.waitFor(async () => {
      const s = await readSuperState(root);
      expect(s.queue.find((q) => q.id === 'q-done-c2')?.state).toBe('done');
      expect(s.children.c2.awaited).toBe(true);
      expect(s.queue.find((q) => q.kind === 'question')).toMatchObject({ state: 'pending', attempts: 1 });
    }, W);
    // No event turn re-tells the done items silently.
    for (const d of delivered) expect(d.text).not.toMatch(/q-done-c2|q-done-c3/);
  });

  it('no question open: no block, the owner\'s message goes alone', async () => {
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    settle(reg(SUPER, 'super'));
    attachSuperInbox(fakeInbox().inbox);
    await finish('c1', 'q-done-c1');
    expect(superAnswerDigest(SUPER)).toBeNull();
  });
});

describe('a child\'s question open: the pile goes in the first event turn after it, told in full', () => {
  it('held while the escalation is open, then one batch with the held block, rendered in full', async () => {
    makeVault({ children: { c1: child('c1'), c2: child('c2', { awaited: true }) } });
    await startSuperInbox([root]);
    settle(reg(SUPER, 'super'));
    const c1 = reg('c1');
    reg('c2');
    const { inbox, delivered } = fakeInbox();
    attachSuperInbox(inbox);
    askQuestion(c1, 'req-9');
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    // The super escalates it to the owner and ends its turn.
    await writeSuper(root, (s) => { const q = s.queue.find((x) => x.requestId === 'req-9'); if (q) { q.state = 'escalated'; q.ownerText = 'Postgres or sqlite?'; } });
    superTurnEnded(SUPER);
    await finish('c2', 'q-done-c2');
    await vi.waitFor(async () => expect((await readSuperState(root)).held?.map((h) => h.item)).toEqual(['q-done-c2']), W);
    await new Promise((r) => setTimeout(r, 60));
    expect(delivered).toHaveLength(1);
    expect(superAnswerDigest(SUPER)).toBeNull(); // not the super's own ask: no answer message to ride

    // The owner answers the child in its card: the escalation closes, the pump goes.
    c1.answered('req-9');
    await vi.waitFor(() => expect(delivered).toHaveLength(2), W);
    const text = delivered[1].text;
    expect(text).toMatch(/^\[super events\] batch=b-[a-z0-9-]+ items=1/);
    expect(text).toContain(`${HELD_OPEN} items=1>`);
    expect(text).toMatch(/- item=q-done-c2 child=c2 event=done awaited=owner/);
    // The held block comes after the no-text rule: it is the exception the super acts on.
    expect(text.indexOf(HELD_OPEN)).toBeGreaterThan(text.indexOf('write no text at all'));
    await vi.waitFor(async () => {
      const s = await readSuperState(root);
      expect(s.held).toBeUndefined();
      expect(s.queue.find((q) => q.id === 'q-done-c2')?.state).toBe('delivered');
      expect(s.ownerBatches).toContain(delivered[1].event.batch);
    }, W);
  });
});

/**
 * The owner writes ABOUT one agenda line (owner 2026-10-23: "Write about this"). About another
 * line, his message is not the answer to the super's open question: it stays open, and what
 * was held while it was open stays held, never folded into a message about something else.
 * About the question's own row, it answers it as any message does.
 */
describe('a message about one agenda line', () => {
  const noteAbout = { kind: 'note' as const, id: 'n7' };
  async function heldWhileAsked() {
    makeVault({ children: { c1: child('c1', { awaited: true }) } });
    await startSuperInbox([root]);
    settle(reg(SUPER, 'super'));
    reg('c1');
    const { inbox, delivered } = fakeInbox();
    attachSuperInbox(inbox);
    await openAsk();
    await finish('c1', 'q-done-c1');
    await vi.waitFor(async () => expect((await readSuperState(root)).held?.map((h) => h.item)).toEqual(['q-done-c1']), W);
    return delivered;
  }

  it('about another line: no held block rides with it, the question stays open, the pile stays held', async () => {
    const delivered = await heldWhileAsked();
    expect(superAnswerDigest(SUPER, Date.now(), [noteAbout])).toBeNull();
    // A child's question row is another line too.
    expect(superAnswerDigest(SUPER, Date.now(), [{ kind: 'item', id: 'q-someone-else' }])).toBeNull();
    superOwnerSpoke(SUPER, Date.now(), [], [noteAbout]);
    await new Promise((r) => setTimeout(r, 120));
    const s = await readSuperState(root);
    expect(s.queue.find((q) => q.id === 'q-ask-1')?.state).toBe('escalated');
    expect(s.held?.map((h) => h.item)).toEqual(['q-done-c1']);
    expect(s.queue.find((q) => q.id === 'q-done-c1')?.state).toBe('pending');
    expect(delivered).toHaveLength(0);

    // His words answered it anyway: the super closes it (`super queue done <ask>`), and the held
    // events reach it in the next event turn, none lost.
    await writeSuper(root, (x) => { const q = x.queue.find((y) => y.id === 'q-ask-1'); if (q) q.state = 'done'; });
    clearOwnerLease(root); // the owner's lease (15 s) ran out
    void pumpSuper(root); // what the queue-done route does after the same write (routes/super.ts)
    await vi.waitFor(() => expect(delivered.length).toBeGreaterThanOrEqual(1), W);
    const text = delivered.map((d) => d.text).join('\n');
    expect(text).toContain(`${HELD_OPEN} items=1>`);
    expect(text).toMatch(/- item=q-done-c1 child=c1 event=done awaited=owner/);
    await vi.waitFor(async () => {
      const after = await readSuperState(root);
      expect(after.held).toBeUndefined();
      expect(after.queue.find((q) => q.id === 'q-done-c1')?.state).toBe('delivered');
    }, W);
  });

  it('about the question\'s own row: it is the answer, the pile rides with it', async () => {
    await heldWhileAsked();
    const own = { kind: 'item' as const, id: 'q-ask-1' };
    const digest = superAnswerDigest(SUPER, Date.now(), [own]);
    expect(digest?.items).toEqual(['q-done-c1']);
    superOwnerSpoke(SUPER, Date.now(), digest!.items, [own]);
    await vi.waitFor(async () => {
      const s = await readSuperState(root);
      expect(s.queue.find((q) => q.id === 'q-ask-1')?.state).toBe('done');
      expect(s.held).toBeUndefined();
    }, W);
  });

  it('two questions open: about either one answers them (today\'s close-all); about a note keeps both', async () => {
    await heldWhileAsked();
    await writeSuper(root, (s) => {
      s.queue.push({ id: 'q-ask-2', sessionId: SUPER, kind: 'ask', state: 'escalated', ownerText: 'And the docs?', createdAt: Date.now() });
    });
    expect(superAnswerDigest(SUPER, Date.now(), [noteAbout])).toBeNull();
    superOwnerSpoke(SUPER, Date.now(), [], [noteAbout]);
    await new Promise((r) => setTimeout(r, 120));
    let s = await readSuperState(root);
    expect(s.queue.filter((q) => q.kind === 'ask').map((q) => q.state)).toEqual(['escalated', 'escalated']);

    const second = { kind: 'item' as const, id: 'q-ask-2' };
    const digest = superAnswerDigest(SUPER, Date.now(), [second]);
    expect(digest).not.toBeNull();
    superOwnerSpoke(SUPER, Date.now(), digest!.items, [second]);
    await vi.waitFor(async () => {
      s = await readSuperState(root);
      expect(s.queue.filter((q) => q.kind === 'ask').map((q) => q.state)).toEqual(['done', 'done']);
    }, W);
  });

  // Owner 2026-10-23: his ↩ on one message (`[Reply to message ref=…]`) is about that message,
  // never the answer to the open question.
  it('a reply to one message: the question stays open, the pile stays held, no held block rides with it', async () => {
    const delivered = await heldWhileAsked();
    const reply = { kind: 'reply' as const, id: 'k3f9q0' };
    expect(superAnswerDigest(SUPER, Date.now(), [reply])).toBeNull();
    superOwnerSpoke(SUPER, Date.now(), [], [reply]);
    await new Promise((r) => setTimeout(r, 120));
    const s = await readSuperState(root);
    expect(s.queue.find((q) => q.id === 'q-ask-1')?.state).toBe('escalated');
    expect(s.held?.map((h) => h.item)).toEqual(['q-done-c1']);
    expect(delivered).toHaveLength(0);
  });

  it('a plain message (no About header) still answers the open question', async () => {
    await heldWhileAsked();
    expect(superAnswerDigest(SUPER)).not.toBeNull();
  });

  // Owner 2026-10-24: several references in one message. Other lines keep the question open; a
  // part that IS the question answers it, and the held events ride with that message once.
  it('several parts, none the question: it stays open and the pile stays held', async () => {
    const delivered = await heldWhileAsked();
    const parts = [noteAbout, { kind: 'reply' as const, id: 'k3f9q0' }, { kind: 'item' as const, id: 'q-someone-else' }];
    expect(superAnswerDigest(SUPER, Date.now(), parts)).toBeNull();
    superOwnerSpoke(SUPER, Date.now(), [], parts);
    await new Promise((r) => setTimeout(r, 120));
    const s = await readSuperState(root);
    expect(s.queue.find((q) => q.id === 'q-ask-1')?.state).toBe('escalated');
    expect(s.held?.map((h) => h.item)).toEqual(['q-done-c1']);
    expect(delivered).toHaveLength(0);
  });

  it('several parts, one of them the question: it is answered and the pile is delivered once', async () => {
    const delivered = await heldWhileAsked();
    const parts = [noteAbout, { kind: 'item' as const, id: 'q-ask-1' }];
    const digest = superAnswerDigest(SUPER, Date.now(), parts);
    expect(digest?.items).toEqual(['q-done-c1']);
    superOwnerSpoke(SUPER, Date.now(), digest!.items, parts);
    await vi.waitFor(async () => {
      const s = await readSuperState(root);
      expect(s.queue.find((q) => q.id === 'q-ask-1')?.state).toBe('done');
      expect(s.held).toBeUndefined();
      expect(s.queue.find((q) => q.id === 'q-done-c1')?.state).toBe('delivered');
    }, W);
    // Carried by that message: no event turn repeats it.
    clearOwnerLease(root);
    void pumpSuper(root);
    await new Promise((r) => setTimeout(r, 150));
    expect(delivered.map((d) => d.text).join('\n')).not.toContain('q-done-c1');
  });
});
