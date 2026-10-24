/**
 * The hand-over's decisions, pure (plan-r7 D5, D7, D9, D13, D16, D17 window side; AC1, AC2,
 * AC5, AC6 client half, AC8 client trigger, AC11 window re-checks). The window owns the state
 * and the DOM; every rule it applies is asked here with plain data.
 */
import { describe, it, expect } from 'vitest';
import {
  DELEGATE_MARK_GRACE_MS, OPEN_LATCH, RECAP_AWAY_MS, actionGeneration, adoptionBody, childMarks, delegateArgs,
  delegateExpired, delegateMarkUntil, elapsedLabel, shownChild, hasOwnKey, headAlarmOnce, _resetRaisedHeads, linkOpensSuperStage, presenceChatId, homedSessions,
  isSuperSession, knownEventKind, lastLineOf, latchClick, latchSeen, markedChildren, optionsFit, ownerQueueCount, permissionSummary,
  placeDelegatedChild, queueHead, shouldRecap, superAnswerPicks, superEventOf, superEventText,
  superSendRefusal, superWindowRefusal, terminalTabs, windowTabsFor, type HandoverTab,
  CARD_REF_TITLE_MAX, backgroundOf, cardReference, doingOf, lastLinesOf,
} from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { SUPER_EVENT_PREFIXES, SUPER_STATE_VERSION, type SuperQueueItem, type SuperState } from '../../dashboard/src/lib/superTypes.js';

const SUPER = 'super-0001';
const emptyState = (): SuperState => ({
  v: SUPER_STATE_VERSION, session: null, enabled: false, containers: [], children: {}, queue: [], notes: {}, away: { since: null, events: 0 },
});
const state = (over: Partial<SuperState> = {}): SuperState => ({ ...emptyState(), session: SUPER, ...over });
const child = (sessionId: string) => ({ sessionId, brief: '', adopted: true, startedAt: 1 });
const item = (id: string, over: Partial<SuperQueueItem>): SuperQueueItem =>
  ({ id, sessionId: 'c1', kind: 'question', state: 'pending', createdAt: 1, ...over });

describe('isSuperSession — D9\'s one predicate', () => {
  it('mode super OR the recorded session id', () => {
    expect(isSuperSession({ mode: 'super', claudeId: 'x' }, null)).toBe(true);
    expect(isSuperSession({ mode: 'basic', claudeId: SUPER }, SUPER)).toBe(true);
    expect(isSuperSession({ mode: 'basic', claudeId: 'other' }, SUPER)).toBe(false);
    expect(isSuperSession({ claudeId: 'x' }, null)).toBe(false);
    expect(isSuperSession(undefined, SUPER)).toBe(false);
  });
});

describe('adoptionBody — what POST /api/super/enable carries (D17)', () => {
  const tabs: HandoverTab[] = [
    { id: 'chat-1', claudeId: 'aaaa-1', title: 'Fix login', kind: 'chat' },
    { id: 'chat-2', claudeId: 'bbbb-2', title: 'Plan', kind: 'chat', mode: 'plan' },
    { id: 'chat-3', claudeId: SUPER, title: 'Claude', kind: 'chat', mode: 'super' },
    { id: 'chat-4', claudeId: 'cccc-4', title: 'Notch', kind: 'chat', mode: 'assistant' },
    { id: 'agent-5', claudeId: 'dddd-5', title: 'Terminal 5', kind: 'shell' },
    { id: 'restored-0', claudeId: 'eeee-6', title: 'Old', kind: 'chat', dormant: true },
    { id: 'chat-7', claudeId: 'aaaa-1', title: 'Dup', kind: 'chat' },
    { id: 'chat-8', claudeId: 'bad id with spaces', title: 'Bad', kind: 'chat' },
    { id: 'chat-9', claudeId: 'ffff-9', title: 'Line\nbreak', kind: 'chat' },
  ];

  it('every open chat, never the Super Agent itself, never the Assistant, never a terminal or a dormant tab, never twice', () => {
    const body = adoptionBody(tabs, SUPER);
    expect(body.adopt).toEqual(['aaaa-1', 'bbbb-2', 'ffff-9']);
    expect(body.titles).toEqual({ 'aaaa-1': 'Fix login', 'bbbb-2': 'Plan', 'ffff-9': 'Line break' });
  });

  it('the super never adopts itself even before the record names it (mode super)', () => {
    expect(adoptionBody(tabs, null).adopt).not.toContain(SUPER);
  });

  it('terminals go to their own row', () => {
    expect(terminalTabs([...tabs, { id: 'agent-6', claudeId: 'gggg', title: 'Agent 6', kind: 'agent' }]).map((t) => t.id)).toEqual(['agent-5', 'agent-6']);
  });
});

describe('marked children (D16)', () => {
  it('only while handed over', () => {
    const children = { c1: child('c1'), c2: child('c2') };
    expect([...markedChildren(state({ enabled: true, children }))].sort()).toEqual(['c1', 'c2']);
    expect(markedChildren(state({ enabled: false, children })).size).toBe(0);
    expect(markedChildren(null).size).toBe(0);
  });
});

describe('a child just opened for a delegate stays marked until the record names it (D16, AC6)', () => {
  const on = (children: Record<string, ReturnType<typeof child>> = {}) => state({ enabled: true, children });

  it('marked from the spawn on, before the server\'s push names it', () => {
    const pending = new Map([['kid', 10_000]]);
    const m = childMarks(on({ c1: child('c1') }), pending, 1_000);
    expect([...m.marked].sort()).toEqual(['c1', 'kid']);
    expect([...m.delegated.keys()]).toEqual(['kid']);
    expect(m.nextExpiry).toBe(10_000);
    // Without the pending map (the old effect), the fresh child read as unmarked: the bug.
    expect(markedChildren(on({ c1: child('c1') })).has('kid')).toBe(false);
  });

  it('leaves the pending map once the record names it (still marked, now by the record)', () => {
    const m = childMarks(on({ kid: child('kid') }), new Map([['kid', 10_000]]), 1_000);
    expect(m.marked.has('kid')).toBe(true);
    expect(m.delegated.size).toBe(0);
    expect(m.nextExpiry).toBe(null);
  });

  it('a delegate the server never recorded runs out: the child is an ordinary chat again', () => {
    const m = childMarks(on(), new Map([['kid', 10_000]]), 10_000);
    expect(m.marked.has('kid')).toBe(false);
    expect(m.delegated.size).toBe(0);
  });

  it('nothing is marked, and nothing stays pending, once the mode is off', () => {
    const m = childMarks(state({ enabled: false, children: { c1: child('c1') } }), new Map([['kid', 10_000]]), 1_000);
    expect(m.marked.size).toBe(0);
    expect(m.delegated.size).toBe(0);
    expect(childMarks(null, new Map([['kid', 10_000]]), 1_000).marked.size).toBe(0);
  });

  it('the mark lasts past the server\'s own deadline by the grace; no deadline falls back to its 35 s wait', () => {
    expect(delegateMarkUntil({ deadline: 50_000 }, 1_000)).toBe(50_000 + DELEGATE_MARK_GRACE_MS);
    expect(delegateMarkUntil({}, 1_000)).toBe(1_000 + 35_000 + DELEGATE_MARK_GRACE_MS);
    expect(delegateMarkUntil({ deadline: 'soon' }, 1_000)).toBe(1_000 + 35_000 + DELEGATE_MARK_GRACE_MS);
  });

  it('the earliest pending mark decides when the window looks again', () => {
    expect(childMarks(on(), new Map([['a', 9_000], ['b', 4_000]]), 1_000).nextExpiry).toBe(4_000);
  });
});

describe('a hand-over result that belongs to a reversed action is dropped (AC6)', () => {
  it('only the newest action\'s result may write the state', () => {
    const gen = actionGeneration();
    const takeBack = gen.begin();
    expect(gen.isCurrent(takeBack)).toBe(true);
    // The owner reverses the take-back mid-flight: settleReversed begins a new action.
    const reEnable = gen.begin();
    // The take-back's late `disable` answer lands now: stale, so the children stay marked.
    expect(gen.isCurrent(takeBack)).toBe(false);
    expect(gen.isCurrent(reEnable)).toBe(true);
  });

  it('each window has its own counter', () => {
    const a = actionGeneration();
    const b = actionGeneration();
    const ga = a.begin();
    b.begin(); b.begin();
    expect(a.isCurrent(ga)).toBe(true);
  });
});

describe('one answer per queue head (the strip\'s Allow / Deny / options)', () => {
  it('a double-click sends one answer', () => {
    const first = latchClick(OPEN_LATCH, 'q1:r1', true);
    expect(first.send).toBe(true);
    const second = latchClick(first.latch, 'q1:r1', true);
    expect(second.send).toBe(false);
  });

  it('a click the child\'s socket cannot carry sends nothing and leaves the strip open', () => {
    const r = latchClick(OPEN_LATCH, 'q1:r1', false);
    expect(r.send).toBe(false);
    expect(r.latch).toBe(OPEN_LATCH);
  });

  it('stays locked while the answered request is gone; a new head reopens it', () => {
    let l = latchClick(OPEN_LATCH, 'q1:r1', true).latch;
    l = latchSeen(l, 'q1:r1', false);
    expect(l).toEqual({ key: 'q1:r1', cleared: true });
    expect(latchClick(l, 'q1:r1', true).send).toBe(false);
    expect(latchSeen(l, 'q2:r2', true)).toBe(OPEN_LATCH);
    expect(latchSeen(l, null, false)).toBe(OPEN_LATCH);
  });

  it('the same request sent again after it left the cards (the answer never landed) reopens it', () => {
    let l = latchClick(OPEN_LATCH, 'q1:r1', true).latch;
    // Still on the card in the same render (before the optimistic removal re-renders): locked.
    expect(latchSeen(l, 'q1:r1', true)).toEqual({ key: 'q1:r1', cleared: false });
    l = latchSeen(l, 'q1:r1', false);
    expect(latchSeen(l, 'q1:r1', true)).toBe(OPEN_LATCH);
  });
});

describe('ids from a frame or the server never read the prototype', () => {
  it('hasOwnKey is true only for the record\'s own keys', () => {
    const children = { c1: child('c1') };
    expect(hasOwnKey(children, 'c1')).toBe(true);
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope']) expect(hasOwnKey(children, id)).toBe(false);
    expect(hasOwnKey(null, 'c1')).toBe(false);
  });

  it('a shown card whose ref is a prototype key is no child', () => {
    for (const ref of ['__proto__', 'constructor', 'toString']) {
      const s = state({ children: { c1: child('c1') }, containers: [{ id: 'k', kind: 'chat', ref, shape: 'tall', place: 'float' }], view: { mode: 'half', card: 'k' } });
      expect(shownChild(s)).toBe(null);
    }
  });
});

describe('the queue strip\'s head (D7)', () => {
  it('a permission jumps the line, oldest first; then the oldest escalated question', () => {
    const q = [
      item('q1', { kind: 'question', state: 'escalated', createdAt: 1 }),
      item('p2', { kind: 'permission', state: 'pending', createdAt: 5 }),
      item('p1', { kind: 'permission', state: 'pending', createdAt: 3 }),
    ];
    expect(queueHead({ queue: q })?.id).toBe('p1');
    expect(queueHead({ queue: [q[0]] })?.id).toBe('q1');
  });

  it('nothing the Super Agent handles itself reaches the owner (pending/delivered questions, idle, gone, done)', () => {
    const q = [
      item('a', { kind: 'question', state: 'pending' }),
      item('b', { kind: 'question', state: 'delivered' }),
      item('c', { kind: 'idle', state: 'pending' }),
      item('d', { kind: 'gone', state: 'delivered' }),
      item('e', { kind: 'permission', state: 'done' }),
    ];
    expect(queueHead({ queue: q })).toBe(null);
    expect(ownerQueueCount({ queue: q })).toBe(0);
    expect(ownerQueueCount({ queue: [...q, item('f', { kind: 'permission' }), item('g', { state: 'escalated' })] })).toBe(2);
  });

  it('ONE alarm per item, ever: re-pushed, remounted, or back at the head after another, it rings once (AC6)', () => {
    _resetRaisedHeads();
    const p = item('p1', { kind: 'permission' });
    expect(headAlarmOnce('acme', p)).toBe(true);
    // The same head re-pushed, or the strip remounted (a ref would have forgotten): silent.
    expect(headAlarmOnce('acme', p)).toBe(false);
    const q = item('q9', { state: 'escalated' });
    expect(headAlarmOnce('acme', q)).toBe(true);
    expect(headAlarmOnce('acme', null)).toBe(false);
    expect(headAlarmOnce('acme', q)).toBe(false);
    // Another project is its own bucket; a plain question never rings.
    expect(headAlarmOnce('other', p)).toBe(true);
    expect(headAlarmOnce('acme', item('q', { state: 'pending' }))).toBe(false);
  });

  it('the presence report names the super agent while handed over, the focused pane otherwise (AC3)', () => {
    const base = { expanded: true, isMobile: false, handedOver: true, superSession: 'sup', focusedChat: 'hidden-pane' };
    expect(presenceChatId(base)).toBe('sup');
    expect(presenceChatId({ ...base, handedOver: false })).toBe('hidden-pane');
    expect(presenceChatId({ ...base, expanded: false })).toBe(null);
    expect(presenceChatId({ ...base, isMobile: true })).toBe(null);
    expect(presenceChatId({ ...base, handedOver: false, focusedChat: null })).toBe(null);
  });

  it('a link to the handed-over super agent opens its stage, any other link resumes as before (AC4)', () => {
    expect(linkOpensSuperStage('sup', { enabled: true, session: 'sup' })).toBe(true);
    expect(linkOpensSuperStage('child', { enabled: true, session: 'sup' })).toBe(false);
    expect(linkOpensSuperStage('sup', { enabled: false, session: 'sup' })).toBe(false);
    expect(linkOpensSuperStage('sup', null)).toBe(false);
  });

  it('options at full width or not at all: hide on overflow, back only once the row is as wide as they needed (end review r8)', () => {
    // A new head is shown, to be measured; it fits.
    let f = optionsFit(null, 'q1', 720, 0, true);
    expect(f).toEqual({ show: true, fit: null });
    // It overflows by 90 px at 600: hide, remembering the 690 px it needed.
    f = optionsFit(f.fit, 'q1', 600, 90, true);
    expect(f).toEqual({ show: false, fit: { key: 'q1', need: 690 } });
    // Hidden, the row no longer overflows: it stays hidden below the need (no flip-flop)...
    expect(optionsFit(f.fit, 'q1', 600, 0, false).show).toBe(false);
    expect(optionsFit(f.fit, 'q1', 689, 0, false).show).toBe(false);
    // ...and comes back once the band is that wide.
    expect(optionsFit(f.fit, 'q1', 690, 0, false)).toEqual({ show: true, fit: { key: 'q1', need: 690 } });
    // A sub-pixel overflow is not an overflow.
    expect(optionsFit(null, 'q1', 600, 1, true).show).toBe(true);
    // A new head forgets the old need and is measured shown.
    expect(optionsFit(f.fit, 'q2', 400, 0, false)).toEqual({ show: true, fit: null });
  });
});

describe('injected turns (D13): chips, live and replayed', () => {
  it('each kind maps to its prefix, and the text carries no markup', () => {
    expect(superEventText('question', 'c1')).toBe('[super event] question c1');
    expect(superEventText('recap', '')).toBe('[super recap] recap');
    expect(superEventText('handover', SUPER)).toBe(`[super handover] handover ${SUPER}`);
    expect(superEventText('idle', '<b>x</b>')).toBe('[super event] idle bxb');
  });

  it('recognises every prefix the server writes, and nothing else', () => {
    for (const p of SUPER_EVENT_PREFIXES) expect(superEventOf(`${p} something`)?.prefix).toBe(p);
    expect(superEventOf('please [super event] do it')).toBe(null);
    expect(superEventOf('hello')).toBe(null);
    expect(knownEventKind('question')).toBe(true);
    expect(knownEventKind('permission')).toBe(false);
  });
});

describe('placement while handed over (D5, D9)', () => {
  const panes = [{ id: 'p1', tabs: ['a', 'b'], active: 'a' }, { id: 'p2', tabs: ['c'], active: 'c' }];

  it('a delegated child is a NON-active tab of the active pane: the owner\'s layout is untouched', () => {
    const out = placeDelegatedChild(panes, 'p2', 'kid', () => 'new');
    expect(out.panes).toEqual([{ id: 'p1', tabs: ['a', 'b'], active: 'a' }, { id: 'p2', tabs: ['c', 'kid'], active: 'c' }]);
    expect(out.activePaneId).toBe('p2');
  });

  it('a stale active pane falls back to the first; no pane at all makes one; never twice', () => {
    expect(placeDelegatedChild(panes, 'gone', 'kid', () => 'new').panes[0].tabs).toEqual(['a', 'b', 'kid']);
    expect(placeDelegatedChild([], '', 'kid', () => 'pane-9')).toEqual({ panes: [{ id: 'pane-9', tabs: ['kid'], active: 'kid' }], activePaneId: 'pane-9' });
    expect(placeDelegatedChild([{ id: 'p1', tabs: ['kid'], active: 'kid' }], 'p1', 'kid', () => 'x').panes).toEqual([{ id: 'p1', tabs: ['kid'], active: 'kid' }]);
  });

  it('homing: only the centre and the shown child while handed over; the pane actives otherwise', () => {
    expect([...homedSessions({ handedOver: true, superSid: 'chat-9', shownSid: 'chat-2', paneActives: ['a', 'c'] })]).toEqual(['chat-9', 'chat-2']);
    expect([...homedSessions({ handedOver: true, superSid: 'chat-9', shownSid: null, paneActives: ['a'] })]).toEqual(['chat-9']);
    expect([...homedSessions({ handedOver: false, superSid: 'chat-9', shownSid: 'chat-2', paneActives: ['a', 'c'] })]).toEqual(['a', 'c']);
  });

  it('the shown child is the half card\'s child, else the first presented chat; never a non-chat', () => {
    const k = { id: 'k', kind: 'chat' as const, ref: 'c1', shape: 'tall' as const, place: 'float' as const };
    const w = { id: 'w', kind: 'web' as const, ref: 'https://x.dev', shape: 'tall' as const, place: 'float' as const };
    const s = state({ children: { c1: child('c1') }, containers: [w, k], view: { mode: 'half', card: 'k' } });
    expect(shownChild(s)).toBe('c1');
    expect(shownChild({ ...s, view: { mode: 'present', cards: ['w', 'k'] } })).toBe('c1');
    expect(shownChild({ ...s, view: { mode: 'half', card: 'w' } })).toBe(null);
    expect(shownChild({ ...s, view: { mode: 'float' } })).toBe(null);
    expect(shownChild({ ...s, children: {} })).toBe(null);
  });
});

describe('window verbs while handed over (D4b, the browser re-check)', () => {
  it('the Super Agent drives with `super` verbs only; a child cannot open or split; anyone else is untouched', () => {
    expect(superWindowRefusal('super', 'state', true)).toMatch(/super/);
    expect(superWindowRefusal('super', 'join', false)).toMatch(/super/);
    // A child verb (`super send`/`super update`) with no child resolved is refused all the same.
    expect(superWindowRefusal('super', 'mode', false)).not.toBe(null);
    for (const verb of ['new', 'split', 'join', 'focus', 'close', 'state']) {
      expect(superWindowRefusal('super', verb, true, { target: { sid: 'chat-2', pin: 'c1', conversation: 'c1' }, superSession: SUPER, children: new Set(['c1']) }), verb).not.toBe(null);
    }
    expect(superWindowRefusal('child', 'new', true)).toMatch(/cannot open/);
    expect(superWindowRefusal('child', 'split', true)).toMatch(/cannot open/);
    expect(superWindowRefusal('child', 'focus', true)).toBe(null);
    expect(superWindowRefusal('child', 'new', false)).toBe(null);
    expect(superWindowRefusal('other', 'new', true)).toBe(null);
  });

  it('`send` is the ONE window verb the Super Agent may run, and only into a marked child (sid, pin and conversation agree)', () => {
    const children = new Set(['c1']);
    const send = (target: Parameters<typeof superSendRefusal>[0], kids: ReadonlySet<string> = children) =>
      superWindowRefusal('super', 'send', true, { target, superSession: SUPER, children: kids });
    expect(send({ sid: 'chat-2', pin: 'c1', conversation: 'c1' })).toBe(null);
    // Not a child, the super's own tab, a tab whose live conversation is another, nothing resolved.
    expect(send({ sid: 'chat-3', pin: 'free', conversation: 'free' })).toMatch(/only a child/);
    expect(send({ sid: 'chat-9', pin: SUPER, conversation: SUPER }, new Set([SUPER]))).toMatch(/itself/);
    expect(send({ sid: 'chat-2', pin: 'c1', conversation: 'other' })).toMatch(/not running/);
    expect(send({ sid: 'chat-2', pin: 'c1', conversation: null })).toMatch(/not running/);
    expect(send(null)).toMatch(/no such child/);
    // Not handed over: no child is marked, so nothing can be sent to.
    expect(send({ sid: 'chat-2', pin: 'c1', conversation: 'c1' }, new Set())).toMatch(/only a child/);
    expect(superSendRefusal({ sid: '', pin: 'c1', conversation: 'c1' }, SUPER, children)).toMatch(/no such child/);
  });

  it('`super update` travels as `window model|effort|mode`: allowed only into a marked child, like `send`', () => {
    const children = new Set(['c1']);
    for (const verb of ['model', 'effort', 'mode']) {
      const run = (target: Parameters<typeof superSendRefusal>[0], kids: ReadonlySet<string> = children) =>
        superWindowRefusal('super', verb, true, { target, superSession: SUPER, children: kids });
      expect(run({ sid: 'chat-2', pin: 'c1', conversation: 'c1' }), verb).toBe(null);
      expect(run({ sid: 'chat-3', pin: 'free', conversation: 'free' }), verb).toMatch(/only a child/);
      expect(run({ sid: 'chat-9', pin: SUPER, conversation: SUPER }, new Set([SUPER])), verb).toMatch(/itself/);
      expect(run({ sid: 'chat-2', pin: 'c1', conversation: null }), verb).toMatch(/not running/);
      expect(run(null), verb).toMatch(/no such child/);
      // Without the verb's target resolved (no `send` arg at all) it is refused.
      expect(superWindowRefusal('super', verb, true), verb).not.toBe(null);
    }
  });

  it('the Super Agent\'s own tab list holds only its marked children', () => {
    const tabs = [{ tab: SUPER, kind: 'chat' }, { tab: 'c1', kind: 'chat' }, { tab: 'free', kind: 'chat' }, { tab: 'sh', kind: 'shell' }];
    expect(windowTabsFor(tabs, { caller: 'super', self: SUPER, superSession: SUPER, children: new Set(['c1']) }).map((t) => t.tab)).toEqual(['c1']);
  });

  it('no tab list ever shows the Super Agent; a child sees no sibling', () => {
    const tabs = [
      { tab: SUPER, kind: 'chat' }, { tab: 'c1', kind: 'chat' }, { tab: 'c2', kind: 'chat' },
      { tab: 'free', kind: 'chat' }, { tab: 'sh', kind: 'shell' },
    ];
    const children = new Set(['c1', 'c2']);
    expect(windowTabsFor(tabs, { caller: 'other', self: 'free', superSession: SUPER, children }).map((t) => t.tab)).toEqual(['c1', 'c2', 'free', 'sh']);
    expect(windowTabsFor(tabs, { caller: 'child', self: 'c1', superSession: SUPER, children }).map((t) => t.tab)).toEqual(['c1', 'free', 'sh']);
  });
});

describe('`super answer` re-checked in the window (D7)', () => {
  const one = [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }];
  const multi = [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }];
  const two = [{ question: 'Q1', options: [{ label: 'x' }] }, { question: 'Q2', options: [{ label: 'y' }, { label: 'z' }] }];

  it('maps option labels onto the questions in order', () => {
    expect(superAnswerPicks(one, ['SQLite'])).toEqual({ ok: true, picked: { 'Which DB?': 'SQLite' } });
    expect(superAnswerPicks(multi, ['A', 'B'])).toEqual({ ok: true, picked: { Pick: 'A, B' } });
    expect(superAnswerPicks(two, ['x', 'z'])).toEqual({ ok: true, picked: { Q1: 'x', Q2: 'z' } });
  });

  it('refuses a label the question does not offer, two picks on a single-choice question, or nothing at all', () => {
    expect(superAnswerPicks(one, ['MySQL'])).toEqual({ ok: false, error: 'unknown_choice' });
    expect(superAnswerPicks(one, ['Postgres', 'SQLite'])).toEqual({ ok: false, error: 'one_choice_only' });
    expect(superAnswerPicks(two, ['x', 'nope'])).toEqual({ ok: false, error: 'unknown_choice' });
    expect(superAnswerPicks(one, [])).toEqual({ ok: false, error: 'empty_answer' });
    expect(superAnswerPicks([], ['x'])).toEqual({ ok: false, error: 'no_question' });
  });

  it('free text alone is the answer; beside a pick it rides as the note', () => {
    expect(superAnswerPicks(one, [], 'Use DuckDB')).toEqual({ ok: true, picked: { 'Which DB?': 'Use DuckDB' } });
    expect(superAnswerPicks(one, ['SQLite'], 'small app')).toEqual({ ok: true, picked: { 'Which DB?': 'SQLite' }, notes: { 'Which DB?': 'small app' } });
  });
});

describe('`super delegate` arguments', () => {
  it('needs a prompt; an agent may only start basic, plan or develop; titles are one clean line', () => {
    expect(delegateArgs({})).toEqual({ ok: false, error: 'no_prompt' });
    expect(delegateArgs({ prompt: 'go', mode: 'super' })).toMatchObject({ ok: true, mode: 'basic' });
    expect(delegateArgs({ prompt: 'go', mode: 'assistant' })).toMatchObject({ ok: true, mode: 'basic' });
    expect(delegateArgs({ prompt: 'go', mode: 'develop', brief: 'Ship\nit', model: 'opus', effort: 'high' }))
      .toEqual({ ok: true, prompt: 'go', mode: 'develop', model: 'opus', effort: 'high', title: 'Ship it', mcp: [] });
  });
});

describe('`super delegate` past its deadline', () => {
  it('expired only when a numeric deadline has passed; no deadline behaves as today', () => {
    expect(delegateExpired({ deadline: 1_000 }, 1_001)).toBe(true);
    expect(delegateExpired({ deadline: 1_000 }, 1_000)).toBe(false);
    expect(delegateExpired({ deadline: 1_000 }, 999)).toBe(false);
    expect(delegateExpired({}, 10 ** 15)).toBe(false);
    expect(delegateExpired({ deadline: '1000' }, 10 ** 15)).toBe(false);
  });
});

describe('the return recap trigger (D13, AC8 client)', () => {
  it('only on the edge back to focused, after ≥ 10 min away, while handed over', () => {
    expect(RECAP_AWAY_MS).toBe(600_000);
    expect(shouldRecap(false, true, RECAP_AWAY_MS, true)).toBe(true);
    expect(shouldRecap(false, true, RECAP_AWAY_MS - 1, true)).toBe(false);
    expect(shouldRecap(true, true, RECAP_AWAY_MS * 2, true)).toBe(false);
    expect(shouldRecap(false, false, RECAP_AWAY_MS * 2, true)).toBe(false);
    expect(shouldRecap(false, true, RECAP_AWAY_MS * 2, false)).toBe(false);
  });
});

describe('what a card and the strip print', () => {
  it('the last line a child wrote, markdown marks dropped, clipped', () => {
    const items = [
      { kind: 'user', text: 'do it' },
      { kind: 'text', text: '## Done\n\n**Migrated** the `users` table.\n' },
      { kind: 'tool' },
    ];
    expect(lastLineOf(items)).toBe('Migrated the users table.');
    expect(lastLineOf([{ kind: 'text', text: 'x'.repeat(300) }], 20)).toHaveLength(20);
    expect(lastLineOf([])).toBe('');
  });

  it('elapsed is coarse', () => {
    expect(elapsedLabel(30_000)).toBe('<1m');
    expect(elapsedLabel(4 * 60_000)).toBe('4m');
    expect(elapsedLabel(72 * 60_000)).toBe('1h 12m');
  });

  it('a permission is summarised from the CHILD\'s own tool input', () => {
    expect(permissionSummary({ command: 'rm -rf build\n  && ls' })).toBe('rm -rf build && ls');
    expect(permissionSummary({ file_path: '/x/y.ts', content: 'z' })).toBe('/x/y.ts');
    expect(permissionSummary({ a: 1 })).toBe('{"a":1}');
  });
});

describe('what a card shows (plan-r8 F11, O10)', () => {
  const tool = (name: string, input: unknown, status: 'running' | 'done' = 'running') => ({ kind: 'tool', name, input, status });

  it('the doing-line is the NEWEST tool still running, as a verb and a short subject', () => {
    expect(doingOf([tool('Bash', { command: 'npm test', description: 'Run the unit tests' })])).toEqual({ verb: 'run', subject: 'Run the unit tests' });
    expect(doingOf([tool('Bash', { command: 'npm   test' })])).toEqual({ verb: 'run', subject: 'npm test' });
    expect(doingOf([tool('Edit', { file_path: '/Users/x/project/src/lib/a.ts' })])).toEqual({ verb: 'edit', subject: '…/lib/a.ts' });
    expect(doingOf([tool('Read', { file_path: 'a.ts' })])).toEqual({ verb: 'read', subject: 'a.ts' });
    expect(doingOf([tool('Grep', { pattern: 'TODO' })])).toEqual({ verb: 'search', subject: 'TODO' });
    expect(doingOf([tool('WebFetch', { url: 'https://example.com' })])).toEqual({ verb: 'fetch', subject: 'https://example.com' });
    expect(doingOf([tool('Agent', { description: 'Review the diff' })])).toEqual({ verb: 'agent', subject: 'Review the diff' });
    expect(doingOf([tool('mcp__x__y', {})])).toEqual({ verb: 'tool', subject: 'mcp__x__y' });
    // The newest running one wins; finished ones and text never count.
    expect(doingOf([tool('Read', { file_path: 'a.ts' }), tool('Bash', { command: 'ls' }, 'done'), { kind: 'text', status: 'running' }])).toEqual({ verb: 'read', subject: 'a.ts' });
    expect(doingOf([tool('Bash', { command: 'ls' }, 'done')])).toBeNull();
    expect(doingOf([tool('Bash', null)])).toEqual({ verb: 'run', subject: '' });
  });

  it('a long subject is one line and clipped', () => {
    const d = doingOf([tool('Bash', { description: `a\n${'x'.repeat(200)}` })])!;
    expect(d.subject).not.toMatch(/\n/);
    expect(d.subject.length).toBeLessThanOrEqual(80);
    expect(d.subject.endsWith('…')).toBe(true);
  });

  it('the background chip counts running shells and agents only', () => {
    expect(backgroundOf([])).toEqual({ shells: 0, agents: 0 });
    expect(backgroundOf([
      { status: 'running', taskType: 'local_bash' }, { status: 'running', taskType: 'local_bash' },
      { status: 'running', taskType: 'local_agent' }, { status: 'completed', taskType: 'local_bash' }, { status: 'stopped' },
    ])).toEqual({ shells: 2, agents: 1 });
  });

  it('a tall card\'s last lines: from the newest text, markdown stripped, at most n', () => {
    expect(lastLinesOf([{ kind: 'text', text: 'one\n**two**\n\n`three`\n# four\nfive' }, { kind: 'tool' }], 4)).toEqual(['two', 'three', 'four', 'five']);
    expect(lastLinesOf([{ kind: 'text', text: 'old' }, { kind: 'text', text: '  ' }])).toEqual(['old']);
    expect(lastLinesOf([])).toEqual([]);
  });
});

describe('asking about a card: the @card reference (plan-r8 F6, O11)', () => {
  it('is @card:<id> “<title>” followed by a space', () => {
    expect(cardReference('c3', 'Fix the login bug', '')).toBe('@card:c3 “Fix the login bug” ');
  });

  it('puts a space first when the draft does not end in whitespace', () => {
    expect(cardReference('c3', 'T', 'look at')).toBe(' @card:c3 “T” ');
    expect(cardReference('c3', 'T', 'look at ')).toBe('@card:c3 “T” ');
    expect(cardReference('c3', 'T', 'line\n')).toBe('@card:c3 “T” ');
  });

  it('keeps the title on one line, without control characters or quotes, clipped to the limit', () => {
    const ref = cardReference('c3', 'a\u0007b\n“c”"d"\t e', '');
    expect(ref).toBe('@card:c3 “a b c d e” ');
    const long = cardReference('c3', 'ş'.repeat(200), '');
    const title = long.slice(long.indexOf('“') + 1, long.indexOf('”'));
    expect(title.length).toBeLessThanOrEqual(CARD_REF_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    // Turkish survives.
    expect(cardReference('c3', 'Ödeme sayfası çöküyor', '')).toContain('“Ödeme sayfası çöküyor”');
  });
});
