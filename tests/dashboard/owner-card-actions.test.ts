/**
 * The dashboard's card-action client and records (sahip-karti-yerinde K1, K4, K6, K7;
 * criterion 8):
 *  - a record host finds its card by `(posting session, cardRef)` and draws the HANDLE's spec;
 *    checklist and MCP records are accepted like run and secret;
 *  - ▶ Run's ticket carries the drawn command as `shown`, the action of the press, and rides the
 *    terminal URL (never on the phone's path);
 *  - a 403 reads "Open dreamcontext to run it";
 *  - the bar's ▶ Run lands in the slot only when one is mounted for that item;
 *  - the window acks a held report only when its socket send returned true (postToSession).
 * Fictional sessions and commands (synthetic-fixtures pattern).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  OWNER_ONLY_LINE, _resetCardRecords, applyCardsFrame, byRecord, cardNotNeeded, cardTerminalUrl, hostSession,
  matchCard, mintCardTicket, recordFromHandle, ticketActionOf, type CardRecordView,
} from '../../dashboard/src/lib/cardRecords.js';
import { RequestError } from '../../dashboard/src/api/client.js';
import type { OwnerCardHandle } from '../../dashboard/src/lib/superTypes.js';
import {
  _resetOwnerSlots, isOwnerCardItem, mountOwnerSlot, requestSlotRun, showOwnerSlot, slotCardItems,
} from '../../dashboard/src/components/sleepy/super/superJobsStore.js';
import { postToSession } from '../../dashboard/src/components/sleepy/chat/postToSession.js';
import type { ChatSession } from '../../dashboard/src/components/sleepy/chatSession.js';
import type { SuperQueueItem } from '../../dashboard/src/lib/superTypes.js';

const SID = '11111111-2222-4333-8444-555555555555';
const REF = 'a'.repeat(32);
const RUN = { type: 'run', id: 'look', command: 'node scripts/verify/look-export.mjs --widths 1440,390' } as const;
const handle: OwnerCardHandle = {
  cardRef: REF, postingSession: SID, vault: 'acme-shop', postingConversationId: SID,
  spec: RUN as OwnerCardHandle['spec'], childRecordId: 'main', childId: SID, deliverTo: SID,
};

function api(over: { throws?: unknown; reply?: unknown } = {}) {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    calls,
    ownerPost: async <T,>(path: string, body: unknown): Promise<T> => {
      calls.push({ path, body });
      if (over.throws) throw over.throws;
      return (over.reply ?? { ticket: 'T'.repeat(22), expiresAt: 1 }) as T;
    },
  };
}

beforeEach(() => { _resetCardRecords(); _resetOwnerSlots(); });

describe('records on either host', () => {
  it('a record host finds its card by (posting session, cardRef)', () => {
    const rec: CardRecordView = { id: 'look', cardRef: REF, kind: 'run', spec: RUN, state: 'open', run: null };
    applyCardsFrame(SID, [rec]);
    expect(byRecord(SID, REF)).toEqual(rec);
    expect(byRecord(SID, 'b'.repeat(32))).toBeNull();
    expect(hostSession({ record: handle })).toBe(SID);
    expect(hostSession({ session: 'x' })).toBe('x');
  });

  it('a card the list does not hold is drawn from the handle, its spec the handle spec', () => {
    const r = recordFromHandle(handle, true);
    expect(r).toMatchObject({ cardRef: REF, kind: 'run', spec: RUN, state: 'open', run: null });
    expect(recordFromHandle(handle, false).state).toBe('closed');
  });

  it('checklist and MCP records match like run and secret', () => {
    const cl = { type: 'checklist', id: 'setup', title: 'Setup', items: [{ id: 'a', text: 'A' }] } as const;
    const mcp = { type: 'mcp', id: 'ph', servers: ['posthog'] } as const;
    const cards: CardRecordView[] = [
      { id: 'setup', cardRef: 'c'.repeat(32), kind: 'checklist', spec: cl as never, state: 'open', run: null },
      { id: 'ph', cardRef: 'd'.repeat(32), kind: 'mcp', spec: mcp as never, state: 'open', run: null },
    ];
    expect(matchCard(cards, cl as never)?.cardRef).toBe('c'.repeat(32));
    expect(matchCard(cards, mcp as never)?.cardRef).toBe('d'.repeat(32));
  });
});

describe('the ticket (K4)', () => {
  it('carries the drawn command as shown and the press action', async () => {
    const a = api();
    const r = await mintCardTicket(a, { session: SID, card: REF, action: ticketActionOf({ start: true }), shown: RUN.command });
    expect(r).toEqual({ ok: true, value: 'T'.repeat(22) });
    expect(a.calls).toEqual([{ path: '/agent/card-ticket', body: { session: SID, card: REF, action: 'start', shown: RUN.command } }]);
    expect(ticketActionOf({ start: true, rerun: true })).toBe('rerun');
    expect(ticketActionOf({ start: false })).toBe('attach');
  });

  it('rides the Mac terminal URL, never the phone path', () => {
    const mac = cardTerminalUrl({ sessionId: SID, cardRef: REF, start: true }, 'dark', 'T'.repeat(22));
    expect(new URL(mac, 'http://x').searchParams.get('ticket')).toBe('T'.repeat(22));
    const phone = cardTerminalUrl({ sessionId: SID, cardRef: REF, start: true, phone: true }, 'dark', 'T'.repeat(22));
    expect(phone).not.toContain('ticket=');
  });

  it('a 403 reads the one line, the server own when it sent one', async () => {
    const bare = await mintCardTicket(api({ throws: new RequestError('Request failed: 403', 403, 'owner_only') }), { session: SID, card: REF, action: 'start', shown: RUN.command });
    expect(bare).toEqual({ ok: false, error: 'owner_only', message: OWNER_ONLY_LINE });
    const remote = await mintCardTicket(api({ throws: new RequestError('Open dreamcontext to run it on this Mac', 403, 'owner_only') }), { session: SID, card: REF, action: 'start', shown: RUN.command });
    expect(remote.ok === false && remote.message).toBe('Open dreamcontext to run it on this Mac');
  });

  it('Not needed is the owner own post, routed by record', async () => {
    const a = api({ reply: { ok: true } });
    expect(await cardNotNeeded(a, { session: SID, card: REF })).toEqual({ ok: true, value: true });
    expect(a.calls).toEqual([{ path: '/agent/cards/not-needed', body: { session: SID, card: REF } }]);
  });
});

describe('the slot (K7)', () => {
  const item = (over: Partial<SuperQueueItem>): SuperQueueItem => ({
    id: 'q1', sessionId: SID, kind: 'owner', state: 'escalated', createdAt: 1, card: handle, ...over,
  } as SuperQueueItem);

  it('draws open card items, and a closed one it saw open while its result line is set', () => {
    expect(slotCardItems([item({})]).map((q) => q.id)).toEqual(['q1']);
    expect(slotCardItems([item({ state: 'done', delivery: 'sent' })]).map((q) => q.id)).toEqual(['q1']);
    expect(slotCardItems([item({ id: 'q2', state: 'done', delivery: 'sent' })])).toEqual([]);
    expect(slotCardItems([item({ card: undefined })])).toEqual([]);
    expect(isOwnerCardItem({ kind: 'member', card: handle })).toBe(true);
  });

  it('the bar ▶ Run lands only in a mounted slot, with the command it drew', () => {
    expect(requestSlotRun('q1', RUN.command)).toBe(false);
    const off = mountOwnerSlot('q1');
    expect(requestSlotRun('q1', RUN.command)).toBe(true);
    off();
    expect(requestSlotRun('q1', RUN.command)).toBe(false);
  });

  it('the agenda line and the bar verbs bring the slot card into view', () => {
    let scrolled = false;
    const el = { dataset: { item: 'q1' }, isConnected: true, scrollIntoView: () => { scrolled = true; }, querySelector: () => null };
    (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) };
    const root = { querySelectorAll: () => [el] } as unknown as ParentNode;
    expect(showOwnerSlot('q1', root)).toBe(true);
    expect(scrolled).toBe(true);
    expect(showOwnerSlot('q9', root)).toBe(false);
  });
});

describe('the window acks only what its socket took (K6)', () => {
  const session = (over: Partial<{ busy: boolean; send: () => unknown; steer: () => boolean }>) => {
    const queued: string[] = [];
    return {
      queued,
      s: { busy: false, send: () => true, steer: () => false, enqueue: (t: string) => { queued.push(t); }, ...over } as unknown as ChatSession,
    };
  };

  it('a dead socket is not an ack', () => {
    expect(postToSession(session({ send: () => false }).s, '[ran in chat]\n$ ls')).toBe(false);
  });

  it('a live send or steer is', () => {
    expect(postToSession(session({}).s, '[ran in chat]\n$ ls')).toBe(true);
    expect(postToSession(session({ busy: true, steer: () => true }).s, 'x')).toBe(true);
  });

  it('a running turn that cannot take it queues it in the chat', () => {
    const { s, queued } = session({ busy: true, steer: () => false });
    expect(postToSession(s, 'x')).toBe(true);
    expect(queued).toEqual(['x']);
  });

  it('empty text is never sent', () => {
    expect(postToSession(session({}).s, '  ')).toBe(false);
  });
});
