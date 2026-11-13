/**
 * Every interactive card in the Super chat leaves the TAIL once the thing it waited for ended,
 * and sits in its place in history, drawn once (owner 2026-11-13, the third stuck-card report in a
 * day: "bu tip takılı kalmalar çok can sıkıyor"; a teammate's finished run card stayed at the
 * bottom of the Super chat, twice). One walk per kind: waiting -> ended -> settled, in place, once.
 * The rule lives in super/cardPlacement.ts. Fictional jobs and commands (synthetic-fixtures).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const { TEMPLATES } = vi.hoisted(() => ({
  TEMPLATES: {
    'ownerCard.needsYouTitle': '{name} needs you',
    'ownerCard.doneTitle': '{name}: done',
    'ownerCard.runningTitle': '{name}: running',
    'ownerCard.endedTitle': '{name}: ended',
    'ownerCard.delivery.sent': 'Sent to {child}.',
    'ownerCard.delivery.ended': '{child} was ended; the Super has the result.',
    'ownerCard.mcpLine': 'Connect: {names}',
  } as Record<string, string>,
}));
vi.mock('../../dashboard/src/context/I18nContext.js', () => {
  const t = (key: string) => TEMPLATES[key] ?? key;
  return {
    useI18n: () => ({ locale: 'en', setLocale: () => {}, t }),
    useOwnerCardT: () => t,
    I18nProvider: ({ children }: { children: unknown }) => children,
  };
});
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({ get: async () => ({}), ownerPost: async () => ({}) }), useVaultId: () => ({ vault: 'acme-shop' }) }));
vi.mock('../../dashboard/src/hooks/useAgents.js', () => ({
  useAgent: (slug: string | null) => ({ data: slug ? { agent: { slug, title: slug, hasPhoto: false } } : undefined }),
}));
vi.mock('../../dashboard/src/hooks/useAutomations.js', () => ({ useAutomation: () => ({ data: undefined }) }));
vi.mock('../../dashboard/src/components/agents/AgentAvatar.js', () => ({ AgentAvatar: () => null }));
vi.mock('../../dashboard/src/components/sleepy/chat/SurveyCard.js', () => ({ SurveyCard: () => null, SurveyReceipt: () => null }));
vi.mock('../../dashboard/src/components/sleepy/super/SuperPermissionCard.js', () => ({ RemotePermission: () => null }));
vi.mock('../../dashboard/src/components/sleepy/chat/InlineTerminal.js', () => ({ InlineTerminal: () => null }));
(globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {}, matchMedia: () => ({ matches: false }) };

const { SuperQuestionTail } = await import('../../dashboard/src/components/sleepy/super/SuperQuestionCard.js');
const { publishSuperQuestions, _resetOwnerSlots, slotCardItems } = await import('../../dashboard/src/components/sleepy/super/superJobsStore.js');
const { placeOwnerCards, anchorSettledCards, tailHolds, ownerCardItemsOf } = await import('../../dashboard/src/components/sleepy/super/cardPlacement.js');
const { openOwnerQuestions, openMemberMirrors } = await import('../../dashboard/src/components/sleepy/super/superQuestions.js');
const { refusalItemsOf, _resetOwnerItems } = await import('../../dashboard/src/components/sleepy/super/ownerAnswer.js');
const { _resetCardRecords } = await import('../../dashboard/src/lib/cardRecords.js');
const { needsOwner } = await import('../../dashboard/src/components/sleepy/super/superHandover.js');
type SuperQueueItem = import('../../dashboard/src/lib/superTypes.js').SuperQueueItem;
type ChatItem = import('../../dashboard/src/components/sleepy/chatSession.js').ChatItem;

const CHILD = '11111111-2222-4333-8444-555555555555';
const SPECS = {
  run: { type: 'run', id: 'deploy', command: 'cd ~/acme-shop && node release.mjs feat/cart' },
  secret: { type: 'secret', id: 'stripe', title: 'Stripe test key', file: '.env', fields: [{ key: 'STRIPE_SECRET_KEY' }] },
  checklist: { type: 'checklist', id: 'store', title: 'Store setup', items: [{ id: 'a', text: 'Create the app' }] },
  mcp: { type: 'mcp', id: 'ph', servers: ['posthog'] },
} as const;
type Kind = keyof typeof SPECS;

const card = (kind: Kind, over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
  id: `q-${kind}`, sessionId: CHILD, kind: 'owner', state: 'escalated', createdAt: 2_000, ownerText: `the ${kind} card`,
  wait: { kind, id: SPECS[kind].id },
  card: {
    cardRef: kind.padEnd(32, 'x'), postingSession: CHILD, vault: 'acme-shop', postingConversationId: CHILD,
    spec: SPECS[kind] as never, childRecordId: 'main', childId: CHILD, deliverTo: CHILD,
  },
  ...over,
} as SuperQueueItem);

/** The Super chat's transcript: a turn before the card was posted, and one after. */
const TRANSCRIPT: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'ship the cart', ts: 1_000 },
  { kind: 'text', id: 'a1', index: 0, text: 'Started the job.', done: true, ts: 1_500 },
  { kind: 'user', id: 'u2', text: 'how is it going?', ts: 3_000 },
  { kind: 'text', id: 'a2', index: 0, text: 'Still running.', done: true, ts: 3_500 },
];

let n = 0;
const tail = (cards: SuperQueueItem[]) => {
  publishSuperQuestions('SUPER', {
    open: [], cards, superSession: undefined, sessionFor: () => undefined, titleFor: () => 'Cart release', pausedFor: () => false,
  } as never, `k${++n}`);
  return renderToStaticMarkup(createElement(SuperQuestionTail, { session: { claudeId: 'SUPER' } as never, anchored: new Set() }));
};
const cardsIn = (html: string) => (html.match(/data-testid="super-owner-card"/g) ?? []).length;

beforeEach(() => { _resetOwnerItems(); _resetOwnerSlots(); _resetCardRecords(); publishSuperQuestions('SUPER', null); });

describe('an owner card (run, secret, checklist, mcp): waiting in the tail, then in its place', () => {
  for (const kind of Object.keys(SPECS) as Kind[]) {
    it(`${kind}: waiting -> tail once; ended -> out of the tail, under the turn it was posted in, once`, () => {
      // Waiting on the owner: the tail draws it, once.
      const html1 = tail(slotCardItems([card(kind)]));
      expect(cardsIn(html1)).toBe(1);
      expect(html1).toContain(`data-kind="${kind}"`);

      // He acted, or the child was ended: the record closes the item with its result line.
      for (const delivery of ['sent', 'ended'] as const) {
        const queue = slotCardItems([card(kind, { state: 'done', delivery })]);
        // The record still names it (the window saw it open: its result line is worth showing)...
        expect(queue.map((q) => q.id)).toEqual([`q-${kind}`]);
        // ...but never in the tail (13 Nov: the finished card sat under every new message).
        expect(cardsIn(tail(queue))).toBe(0);
        // In history: under the last message from before it was posted (a1), not at the end.
        const placed = placeOwnerCards(queue);
        expect(placed.tail).toEqual([]);
        const at = anchorSettledCards(TRANSCRIPT, placed.settled);
        expect([...at.keys()]).toEqual(['a1']);
        expect(at.get('a1')!.map((q) => q.id)).toEqual([`q-${kind}`]);
      }
    });
  }

  it('acted on, result still on its way (held for a full crew, the phone, a closed window; waking; sent): out of the tail', () => {
    for (const delivery of ['held:cap', 'held:phone', 'held:no_window', 'waking', 'sent'] as const) {
      const queue = slotCardItems([card('run', { state: 'escalated', delivery })]);
      expect(cardsIn(tail(queue))).toBe(0);
      expect(placeOwnerCards(queue).settled.map((q) => q.id)).toEqual(['q-run']);
    }
    expect(tailHolds({ state: 'escalated', delivery: 'held:cap' })).toBe(false);
  });

  it("an AI Team member's mirror carrying a card follows the same rule: waiting in the tail, acted on in its place", () => {
    const mirror = card('secret', { id: 'q-m', kind: 'member', member: 'turing', of: 'owner' } as Partial<SuperQueueItem>);
    const draw = (m: SuperQueueItem) => {
      publishSuperQuestions('SUPER', { open: [], members: [m], cards: [], superSession: undefined, sessionFor: () => undefined, titleFor: () => '', pausedFor: () => false } as never, `m${++n}`);
      return renderToStaticMarkup(createElement(SuperQuestionTail, { session: { claudeId: 'SUPER' } as never, anchored: new Set() }));
    };
    expect(cardsIn(draw(mirror))).toBe(1);
    const held = { ...mirror, delivery: 'held:cap' } as SuperQueueItem;
    expect(cardsIn(draw(held))).toBe(0);
    expect(placeOwnerCards(ownerCardItemsOf({ members: [held] })).settled.map((q) => q.id)).toEqual(['q-m']);
  });

  it('an undated row (time 0) never anchors a card', () => {
    const undated: ChatItem[] = [...TRANSCRIPT, { kind: 'text', id: 'z', index: 0, text: 'replayed', done: true, ts: 0 }];
    expect([...anchorSettledCards(undated, [card('mcp', { state: 'done', delivery: 'sent' })]).keys()]).toEqual(['a1']);
  });

  it('closed across a restart without a result line (a fresh window never saw it open): not drawn at all', () => {
    expect(slotCardItems([card('run', { id: 'q-cold', state: 'done', delivery: 'sent' })])).toEqual([]);
  });

  it('one card record named by two items (re-posted, a successor) is drawn once: the open one, else the newest', () => {
    const old = card('run', { id: 'q-old', state: 'done', delivery: 'sent', createdAt: 2_000 });
    const again = card('run', { id: 'q-new', state: 'done', delivery: 'sent', createdAt: 2_500 });
    expect(placeOwnerCards([old, again]).settled.map((q) => q.id)).toEqual(['q-new']);
    const open = card('run', { id: 'q-open', createdAt: 1_000 });
    const both = placeOwnerCards([old, open]);
    expect(both.tail.map((q) => q.id)).toEqual(['q-open']);
    expect(both.settled).toEqual([]);
    expect(cardsIn(tail([old, open]))).toBe(1);
  });

  it('a card posted before the first message on screen has no place there: not drawn, never in the tail', () => {
    const early = card('secret', { state: 'done', delivery: 'sent', createdAt: 500 });
    expect(anchorSettledCards(TRANSCRIPT, [early]).size).toBe(0);
  });

  it('a child\'s run card relayed into the Super chat: pressed (running), finished, then the Super talks on: never last (run-bildirim-hemen ek-1)', () => {
    // Posted after a2, waiting: the tail holds it, titled "needs you".
    const waiting = card('run', { createdAt: 4_000 });
    const h0 = tail(slotCardItems([waiting]));
    expect(cardsIn(h0)).toBe(1);
    expect(h0).toContain('Cart release needs you');
    // He pressed ▶ Run: the server closes the item as `running` at the START. The card stays where
    // he pressed it, its terminal live, but no longer says "needs you" (and needsOwner is false).
    const runningItem = card('run', { id: 'q-run-pressed', createdAt: 4_000, state: 'done', delivery: 'running' });
    const running = slotCardItems([runningItem]);
    expect(running.map((q) => q.id)).toEqual(['q-run-pressed']);
    const h1 = tail(running);
    expect(cardsIn(h1)).toBe(1);
    expect(h1).toContain('Cart release: running');
    expect(h1).not.toContain('needs you');
    expect(tailHolds({ state: 'done', delivery: 'running' })).toBe(true);
    expect(needsOwner(runningItem)).toBe(false);
    expect(placeOwnerCards(running).settled).toEqual([]);
    // It finished (exit 1), the result went to the child, the Super posts two more messages.
    const done = slotCardItems([card('run', { createdAt: 4_000, state: 'done', delivery: 'sent' })]);
    const later: ChatItem[] = [...TRANSCRIPT,
      { kind: 'text', id: 'a3', index: 0, text: 'The publish is waiting.', done: true, ts: 6_000 },
      { kind: 'text', id: 'a4', index: 0, text: 'The upload stopped.', done: true, ts: 7_000 }];
    expect(cardsIn(tail(done))).toBe(0);
    const at = anchorSettledCards(later, placeOwnerCards(done).settled);
    expect([...at.keys()]).toEqual(['a2']);
    expect(at.has('a4')).toBe(false);
  });

  it('several relayed run cards finished in a row: each settles in its own place, none piles up at the bottom (owner 13 Nov: "bu terminaller birikiyor")', () => {
    const relayed = (i: number, createdAt: number, over: Partial<SuperQueueItem> = {}) => {
      const base = card('run', { id: `q-run-${i}`, createdAt, ...over });
      return { ...base, card: { ...base.card!, cardRef: `run${i}`.padEnd(32, 'x'), spec: { ...SPECS.run, id: `deploy-${i}` } as never } } as SuperQueueItem;
    };
    const chat: ChatItem[] = [...TRANSCRIPT,
      { kind: 'text', id: 'a3', index: 0, text: 'Merged; the deploy is next.', done: true, ts: 5_000 },
      { kind: 'text', id: 'a4', index: 0, text: 'Prices are live.', done: true, ts: 7_000 },
      { kind: 'text', id: 'a5', index: 0, text: 'Watching the deploy.', done: true, ts: 9_000 }];
    // Seen waiting, then pressed (running), then finished: one after another.
    slotCardItems([relayed(1, 4_000), relayed(2, 6_000), relayed(3, 8_000)]);
    slotCardItems([relayed(1, 4_000, { state: 'done', delivery: 'running' }), relayed(2, 6_000, { state: 'done', delivery: 'running' }), relayed(3, 8_000)]);
    const done = slotCardItems([1, 2, 3].map((i) => relayed(i, 2_000 + i * 2_000, { state: 'done', delivery: i === 2 ? 'finished' : 'sent' })));
    expect(done.map((q) => q.id)).toEqual(['q-run-1', 'q-run-2', 'q-run-3']);
    // Not one of them in the tail above the composer.
    expect(cardsIn(tail(done))).toBe(0);
    const placed = placeOwnerCards(done);
    expect(placed.tail).toEqual([]);
    const at = anchorSettledCards(chat, placed.settled);
    // Each under the message from before it was posted; the chat's last message has none below it.
    expect([...at.entries()].map(([k, v]) => [k, v.map((q) => q.id)])).toEqual([['a2', ['q-run-1']], ['a3', ['q-run-2']], ['a4', ['q-run-3']]]);
    expect(at.has('a5')).toBe(false);
  });

  it('a fresh window that first sees the card RUNNING still draws it, in place, after the exit (sent or finished)', () => {
    for (const end of ['sent', 'finished'] as const) {
      _resetOwnerSlots();
      const id = `q-fresh-${end}`;
      expect(slotCardItems([card('run', { id, createdAt: 4_000, state: 'done', delivery: 'running' })]).map((q) => q.id)).toEqual([id]);
      const after = slotCardItems([card('run', { id, createdAt: 4_000, state: 'done', delivery: end })]);
      expect(after.map((q) => q.id)).toEqual([id]);
      expect(cardsIn(tail(after))).toBe(0);
      expect([...anchorSettledCards(TRANSCRIPT, placeOwnerCards(after).settled).keys()]).toEqual(['a2']);
    }
  });

  it('a card posted after the last message sits under it, and stays there when the chat moves on', () => {
    const late = card('checklist', { state: 'done', delivery: 'sent', createdAt: 4_000 });
    expect([...anchorSettledCards(TRANSCRIPT, [late]).keys()]).toEqual(['a2']);
    const later: ChatItem[] = [...TRANSCRIPT,
      { kind: 'user', id: 'u3', text: 'next', ts: 5_000 },
      { kind: 'text', id: 'a3', index: 0, text: 'On it.', done: true, ts: 5_500 }];
    expect([...anchorSettledCards(later, [late]).keys()]).toEqual(['a2']);
  });
});

describe('the other tail kinds (question, ask, member wait, refusal) leave it when they close', () => {
  const base = { sessionId: CHILD, createdAt: 2_000 } as const;
  it("the Super's own question and a child question it escalated", () => {
    const ask = { ...base, id: 'q-ask', kind: 'ask', state: 'escalated' } as SuperQueueItem;
    const q = { ...base, id: 'q-q', kind: 'question', state: 'escalated' } as SuperQueueItem;
    expect(openOwnerQuestions([ask, q]).map((x) => x.id)).toEqual(['q-ask', 'q-q']);
    expect(openOwnerQuestions([{ ...ask, state: 'done' }, { ...q, state: 'done' }])).toEqual([]);
  });
  it("an AI Team member's wait (its permission or question, mirrored in main)", () => {
    const m = { ...base, id: 'q-m', kind: 'member', member: 'turing', of: 'permission', state: 'pending' } as SuperQueueItem;
    expect(openMemberMirrors([m])).toHaveLength(1);
    expect(openMemberMirrors([{ ...m, state: 'done' }])).toEqual([]);
  });
  it('a refused call', () => {
    const r = { ...base, id: 'q-r', kind: 'owner', state: 'escalated', wait: { kind: 'refusal', id: 'rf-1', refusal: { tool: 'Bash', input: 'rm -rf build' } } } as unknown as SuperQueueItem;
    expect(refusalItemsOf({ record: 'main', items: [r] } as never)).toHaveLength(1);
    expect(refusalItemsOf({ record: 'main', items: [{ ...r, state: 'done' }] } as never)).toEqual([]);
  });
  it('the one tail test agrees: open holds, done does not', () => {
    expect(tailHolds({ state: 'escalated' })).toBe(true);
    expect(tailHolds({ state: 'pending' })).toBe(true);
    expect(tailHolds({ state: 'done' })).toBe(false);
  });
});
