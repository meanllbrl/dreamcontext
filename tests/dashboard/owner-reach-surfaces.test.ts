/**
 * The owner's surfaces for what waits on him (uye-bildirim K4, K5, K11, criterion 12), drawn as
 * the approved drawing has them (mockups A1-A7, B1-B2, C1-C2, D):
 *  - the bar answers IN PLACE per kind: a refused command (Stopped, the command, Allow once,
 *    Always, Not needed), a permission once-only with its reason, a question's options and
 *    Reply…, a stalled member (Open, Not needed), a routine by its own title with Review, and
 *    Open where this window cannot answer (no call to show);
 *  - the Super chat's member card shows the whole command with the sizes, the rule in full and
 *    the "not checked" line, and only the sizes the server offers;
 *  - counts and head for the new kinds (`needsOwner`, `queueHead`), the agenda rows, the side
 *    menu count;
 *  - the profile's Permissions: rules listed, a removal and its 403, the empty line, level changes.
 * Fictional members and commands (synthetic-fixtures pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

// Keys come back as themselves, except the sentences whose filled-in words are what is checked.
const { TEMPLATES, TITLES } = vi.hoisted(() => ({
  TEMPLATES: {
    'owner.answer.stalled': 'Left its job open: “{text}”',
    'owner.answer.refusedLead': '{name} wanted to run this. Nothing ran.',
  } as Record<string, string>,
  TITLES: { turing: 'Turing', otobot: 'Otobot', herodot: 'Herodot' } as Record<string, string>,
}));
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => TEMPLATES[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({}), useVaultId: () => ({ vault: 'acme' }) }));
vi.mock('../../dashboard/src/hooks/useAgents.js', () => ({
  useAgent: (slug: string | null) => ({ data: slug ? { agent: { slug, title: TITLES[slug] ?? slug, hasPhoto: false } } : undefined }),
}));
vi.mock('../../dashboard/src/hooks/useAutomations.js', () => ({
  useAutomation: (slug: string | null) => ({ data: slug ? { automation: { slug, title: 'Günün haberi' } } : undefined }),
}));
vi.mock('../../dashboard/src/components/agents/AgentAvatar.js', () => ({ AgentAvatar: () => null }));
// The question card's survey and the phone's permission card are not what is pinned here.
vi.mock('../../dashboard/src/components/sleepy/chat/SurveyCard.js', () => ({ SurveyCard: () => null, SurveyReceipt: () => null }));
vi.mock('../../dashboard/src/components/sleepy/super/SuperPermissionCard.js', () => ({ RemotePermission: () => null }));

const { JobBar } = await import('../../dashboard/src/components/sleepy/super/JobBar.js');
const { SuperQuestionTail } = await import('../../dashboard/src/components/sleepy/super/SuperQuestionCard.js');
const { publishSuperQuestions } = await import('../../dashboard/src/components/sleepy/super/superJobsStore.js');
const { _resetOwnerItems } = await import('../../dashboard/src/components/sleepy/super/ownerAnswer.js');
const { needsOwner, ownerQueueCount, queueHead, superNotepad, ownerWaitOf } = await import('../../dashboard/src/components/sleepy/super/superHandover.js');
const { SuperAgenda } = await import('../../dashboard/src/components/sleepy/super/SuperAgenda.js');
const { digestToNotepadInput } = await import('../../dashboard/src/components/sleepy/super/PhoneAgenda.js');
const { RefusalCard } = await import('../../dashboard/src/components/sleepy/chat/RefusalCard.js');
const { PermissionsBody, levelChangeKey, readMemberPermissions, removeMemberRule } = await import('../../dashboard/src/components/agents/AgentPermissionsSection.js');
const { buildEkip, ekipCount, ekipAskingCount, memberWaitCounts } = await import('../../dashboard/src/components/aiteam/teamModel.js');
const { RequestError } = await import('../../dashboard/src/api/client.js');
type SuperQueueItem = import('../../dashboard/src/lib/superTypes.js').SuperQueueItem;
type SuperDigestWire = import('../../dashboard/src/lib/superTypes.js').SuperDigestWire;

const SCRIPT = 'node _dream_context/tmp/turing/pay.cjs --funnel headway --amount 13.41';
const refusal = (input = SCRIPT, whole = true) => ({ tool: 'Bash', input, whole, source: 'classifier' as const });
const mirror = (over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
  id: 'q-m1', sessionId: 'member-sid', kind: 'member', state: 'pending', createdAt: 10, member: 'turing', answers: 'mq-1', of: 'owner',
  ...over,
} as SuperQueueItem);
const refusedMirror = (over: Partial<SuperQueueItem> = {}) => mirror({
  ownerText: `Bash ${SCRIPT}`, wait: { kind: 'refusal', id: 'rf-1', refusal: refusal() },
  offer: { sizes: ['once', 'job', 'member'], notChecked: 'What it loads from its folder and the project is not checked.', rule: 'node _dream_context/tmp/turing/pay.cjs …' },
  ...over,
});

const look = { live: () => null, titleFor: (sid: string) => sid.slice(0, 8), superTitle: 'Super Agent' };
const bar = (head: SuperQueueItem, waiting = 1) => renderToStaticMarkup(createElement(JobBar, {
  state: { queue: [head], session: 'S' } as never, head, waiting, look, superSession: undefined, vault: 'acme',
  sessionFor: () => undefined, titleFor: (s: string) => `title-${s}`, onReplyToSuper: () => {}, onShowChild: () => {},
}));
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

beforeEach(() => _resetOwnerItems());

describe('the bar answers in place (A1-A7)', () => {
  it("a member's refused command: Stopped, the command, Allow once, Always, Not needed (A3)", () => {
    const html = bar(refusedMirror());
    expect(has(html, 'super-queue-member')).toBe(true);
    expect(html).toContain('Turing');
    expect(has(html, 'super-queue-stopped')).toBe(true);
    expect(html).toContain('owner.answer.refusedBar');
    expect(html).toContain(SCRIPT);
    expect(has(html, 'super-queue-allow-once')).toBe(true);
    expect(has(html, 'super-queue-always')).toBe(true);
    expect(html).toContain('owner.answer.notNeeded');
    // Not the old single Open button any more.
    expect(has(html, 'super-queue-open-member')).toBe(false);
  });

  it('an outward command offered once only: no Always, its reason on the row (A4)', () => {
    const html = bar(refusedMirror({ offer: { sizes: ['once'], onceOnlyReason: 'sends out, asked every time' } }));
    expect(has(html, 'super-queue-allow-once')).toBe(true);
    expect(has(html, 'super-queue-always')).toBe(false);
    expect(has(html, 'super-queue-once-only')).toBe(true);
    expect(html).toContain('sends out, asked every time');
  });

  it("a member's permission with its call: tool, command, Allow once, Always, Deny (A1)", () => {
    const html = bar(mirror({ of: 'permission', call: { tool: 'Bash', input: 'curl -s https://api.example.test/v1/top', whole: true }, offer: { sizes: ['once', 'job', 'member'] } }));
    expect(html).toContain('curl -s https://api.example.test/v1/top');
    expect(has(html, 'super-queue-allow-once')).toBe(true);
    expect(has(html, 'super-queue-always')).toBe(true);
    expect(html).toContain('owner.answer.deny');
    expect(has(html, 'super-queue-stopped')).toBe(false);
  });

  it('a permission whose command the bar cannot show is Open, never a blind Allow', () => {
    const html = bar(mirror({ of: 'permission', offer: { sizes: ['once', 'job'] } }));
    expect(has(html, 'super-queue-open-member')).toBe(true);
    expect(has(html, 'super-queue-allow-once')).toBe(false);
    expect(has(html, 'super-queue-always')).toBe(false);
  });

  it('a command stored cut gets no Allow and says why', () => {
    const html = bar(refusedMirror({ wait: { kind: 'refusal', id: 'rf-1', refusal: refusal(SCRIPT, false) } }));
    expect(has(html, 'super-queue-allow-once')).toBe(false);
    expect(has(html, 'super-queue-open-member')).toBe(true);
    expect(html).toContain('owner.answer.cut');
  });

  it("a member's question: its options and Reply… on the bar (A5)", () => {
    const ask = { questions: [{ question: 'Haftalık özeti Ali’ye DM olarak göndereyim mi?', options: [{ label: 'Gönder' }, { label: 'Gönderme' }] }] };
    const html = bar(mirror({ member: 'otobot', of: 'ask', ownerText: 'Haftalık özeti Ali’ye DM olarak göndereyim mi?', ask }));
    expect(html.match(/data-testid="super-queue-member-option"/g)?.length).toBe(2);
    expect(html).toContain('Gönder');
    expect(html).toContain('Gönderme');
    expect(has(html, 'super-queue-member-reply')).toBe(true);
  });

  it('a stalled member: Stopped, its last sentence, Open and Not needed (A6)', () => {
    const html = bar(mirror({ ownerText: 'İzin kuralı verilirse baştan yürüyüp devam ederim.', wait: { kind: 'stalled', id: 'st-req1' } }));
    expect(has(html, 'super-queue-stopped')).toBe(true);
    expect(html).toContain('Left its job open: “İzin kuralı verilirse baştan yürüyüp devam ederim.”');
    expect(has(html, 'super-queue-open-member')).toBe(true);
    expect(html).toContain('owner.answer.notNeeded');
  });

  it('a routine by its own title with Review (A7), with or without a member', () => {
    const withMember = bar({ id: 'q-r1', sessionId: 'S', kind: 'routine', state: 'pending', createdAt: 1, routine: 'gunun-haberi', fact: 'not-approved:abc', member: 'herodot', ownerText: 'Did not run at 03:00' } as SuperQueueItem);
    expect(withMember).toContain('Herodot · Günün haberi');
    expect(has(withMember, 'super-queue-review')).toBe(true);
    expect(withMember).toContain('owner.answer.review');
    const alone = bar({ id: 'q-r2', sessionId: 'S', kind: 'routine', state: 'pending', createdAt: 1, routine: 'gece-yedek', fact: 'orphaned:t' } as SuperQueueItem);
    expect(alone).toContain('Günün haberi');
    expect(alone).not.toContain('Herodot');
  });

  it("main's own refused command: its own name, Allow once and Always, and the answer never names a member", () => {
    const own = { id: 'q-o1', sessionId: 'S', kind: 'owner', state: 'escalated', createdAt: 1, own: true, ownerText: 'Bash x', wait: { kind: 'refusal', id: 'rf-9', refusal: refusal() }, offer: { sizes: ['once', 'job', 'member'] } } as SuperQueueItem;
    const html = bar(own);
    expect(html).toContain('Super Agent');
    expect(has(html, 'super-queue-allow-once')).toBe(true);
    expect(has(html, 'super-queue-always')).toBe(true);
  });

  it("a member's own refused command and its own question on its own bar carry the member's name, never main's", () => {
    const own = { id: 'q-o2', sessionId: 'S', kind: 'owner', state: 'escalated', createdAt: 1, own: true, ownerText: 'Bash x', wait: { kind: 'refusal', id: 'rf-8', refusal: refusal() }, offer: { sizes: ['once', 'job', 'member'] } } as SuperQueueItem;
    const ask = { id: 'q-a2', sessionId: 'S', kind: 'ask', state: 'pending', createdAt: 1, ownerText: 'Which discount?' } as SuperQueueItem;
    const memberLook = { ...look, memberTitleFor: (slug: string) => TITLES[slug] ?? slug };
    const onMember = (head: SuperQueueItem) => renderToStaticMarkup(createElement(JobBar, {
      state: { queue: [head], session: 'S', member: 'turing' } as never, head, waiting: 1, look: memberLook, superSession: undefined, vault: 'acme',
      sessionFor: () => undefined, titleFor: (s: string) => `title-${s}`, onReplyToSuper: () => {}, onShowChild: () => {},
    }));
    for (const head of [own, ask]) {
      const html = onMember(head);
      expect(html).toContain('>Turing<');
      expect(html).not.toContain('Super Agent');
    }
  });

  it('a command is drawn with control and bidi characters as visible escapes', () => {
    const html = bar(refusedMirror({ wait: { kind: 'refusal', id: 'rf-1', refusal: refusal('node run.mjs \u202etxt.exe') } }));
    expect(html).toContain('\\u{202e}');
    expect(html).not.toContain('\u202e');
  });
});

describe("the Super chat's member card (B1, B2)", () => {
  const tail = (item: SuperQueueItem) => {
    publishSuperQuestions('S', { open: [], members: [item], superSession: undefined, sessionFor: () => undefined }, `k-${item.id}-${JSON.stringify(item.offer ?? null)}`);
    return renderToStaticMarkup(createElement(SuperQuestionTail, { session: { claudeId: 'S' } as never, anchored: new Set<string>() }));
  };

  it('a refusal: the whole command, the three sizes, the rule in full and the not-checked line', () => {
    const html = tail(refusedMirror());
    expect(has(html, 'grant-decision')).toBe(true);
    expect(html).toContain('Turing wanted to run this. Nothing ran.');
    expect(html).toContain(SCRIPT);
    expect(has(html, 'grant-size-once')).toBe(true);
    expect(has(html, 'grant-size-job')).toBe(true);
    expect(has(html, 'grant-size-member')).toBe(true);
    expect(has(html, 'grant-rule')).toBe(true);
    expect(has(html, 'grant-not-checked')).toBe(true);
    expect(html).toContain('owner.answer.notNeeded');
  });

  it('once only: no size list, the reason, and "Allow once" (B2)', () => {
    const html = tail(refusedMirror({ id: 'q-m2', of: 'permission', wait: undefined, call: { tool: 'Bash', input: 'git push origin rakip-analizi', whole: true }, offer: { sizes: ['once'], onceOnlyReason: 'This sends something out of this Mac, so it is asked every time.' } }));
    expect(has(html, 'grant-size-job')).toBe(false);
    expect(has(html, 'grant-once-only')).toBe(true);
    expect(html).toContain('owner.answer.allowOnce');
    expect(html).toContain('owner.answer.deny');
  });

  it('a card the member page draws (a sign-in) is Open, as before', () => {
    const html = tail(mirror({ id: 'q-m3', ownerText: 'run gcloud auth login', wait: { kind: 'run', id: 'login' } }));
    expect(has(html, 'super-member-open')).toBe(true);
    expect(has(html, 'grant-decision')).toBe(false);
  });

  it('a call the card cannot allow is Open with the real reason, never only a button that refuses', () => {
    // A member's file edit: the server never stores a non-Bash request whole.
    const edit = tail(mirror({ id: 'q-m5', of: 'permission', call: { tool: 'Edit', input: 'src/pricing.ts', whole: false } }));
    expect(has(edit, 'grant-open')).toBe(true);
    expect(has(edit, 'grant-allow')).toBe(false);
    expect(edit).toContain('owner.answer.decideInChat');
    expect(edit).not.toContain('owner.answer.cut');
    // A Bash command really kept cut: "too long", and Open.
    const cut = tail(refusedMirror({ id: 'q-m6', wait: { kind: 'refusal', id: 'rf-6', refusal: refusal(`${SCRIPT} …`, false) } }));
    expect(has(cut, 'grant-open')).toBe(true);
    expect(cut).toContain('owner.answer.cut');
  });

  it("the member's own question takes his words (a reply field and Send)", () => {
    const html = tail(mirror({ id: 'q-m4', member: 'otobot', of: 'ask', ownerText: 'Which list?', ask: { questions: [{ question: 'Which list?', options: [{ label: 'Growth' }, { label: 'Sales' }] }] } }));
    expect(html.match(/data-testid="super-member-option"/g)?.length).toBe(2);
    expect(has(html, 'super-member-reply')).toBe(true);
    expect(has(html, 'super-member-send')).toBe(true);
  });
});

describe("a refusal card in a member's own chat", () => {
  it('draws the command whole and the offered sizes; main has no member size', () => {
    const own = { id: 'q-o2', sessionId: 'S', kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'refusal', id: 'rf-2', refusal: refusal() }, offer: { sizes: ['once', 'job', 'member'] } } as SuperQueueItem;
    const html = renderToStaticMarkup(createElement(RefusalCard, { record: 'main', item: own, who: 'Super Agent' }));
    expect(has(html, 'refusal-card')).toBe(true);
    expect(html).toContain(SCRIPT);
    expect(has(html, 'grant-size-job')).toBe(true);
    expect(has(html, 'grant-size-member')).toBe(false);
    // The same plain owner item in a MEMBER's own record is that member's: its size is offered.
    const mine = renderToStaticMarkup(createElement(RefusalCard, { record: 'turing', item: own, who: 'Turing', memberName: 'Turing' }));
    expect(has(mine, 'grant-size-member')).toBe(true);
  });

  it('a cut refusal in the chat that is already open never tells him to open it', () => {
    const cut = { id: 'q-o3', sessionId: 'S', kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'refusal', id: 'rf-3', refusal: refusal(`${SCRIPT} …`, false) } } as SuperQueueItem;
    const html = renderToStaticMarkup(createElement(RefusalCard, { record: 'turing', item: cut, who: 'Turing' }));
    expect(html).toContain('owner.answer.cannotAllowHere');
    expect(html).not.toContain('owner.answer.cut');
    expect(has(html, 'grant-open')).toBe(false);
  });
});

describe('counts and head for the new kinds', () => {
  const routine = { id: 'r', sessionId: 'S', kind: 'routine', state: 'pending', createdAt: 5, routine: 'gunun-haberi', fact: 'q:1' } as SuperQueueItem;
  const nudge = { id: 'n', sessionId: 'S', kind: 'nudge', state: 'pending', createdAt: 1 } as SuperQueueItem;
  const own = { id: 'o', sessionId: 'S', kind: 'question', state: 'pending', createdAt: 2, own: true } as SuperQueueItem;
  const stalled = mirror({ id: 's', createdAt: 3, wait: { kind: 'stalled', id: 'st-1' } });
  const refused = refusedMirror({ id: 'f', createdAt: 9 });

  it('a routine, an own item, a refusal and a stall count; a nudge never does', () => {
    expect(needsOwner(routine)).toBe(true);
    expect(needsOwner(own)).toBe(true);
    expect(needsOwner(stalled)).toBe(true);
    expect(needsOwner(refused)).toBe(true);
    expect(needsOwner(nudge)).toBe(false);
    expect(needsOwner({ ...routine, state: 'done' })).toBe(false);
    expect(ownerQueueCount({ queue: [routine, nudge, own, stalled, refused] })).toBe(4);
  });

  it('a refused command heads the line with the permissions; a nudge never heads', () => {
    expect(queueHead({ queue: [routine, own, stalled, refused] })?.id).toBe('f');
    expect(queueHead({ queue: [nudge] })).toBeNull();
    expect(ownerWaitOf(refused)).toBe('refusal');
    expect(ownerWaitOf(mirror({ offer: { sizes: ['once'] } }))).toBe('refusal');
    expect(ownerWaitOf(stalled)).toBe('stalled');
  });

  it('the agenda lists them: a routine by its title, a refusal and a stall by their chips', () => {
    const rows = superNotepad({ queue: [routine, stalled, refused], pad: [] }, { ...look, routineTitleFor: (s: string) => (s === 'gunun-haberi' ? 'Günün haberi' : '') }).waiting;
    const byItem = Object.fromEntries(rows.map((r) => [r.item, r]));
    expect(byItem.r).toMatchObject({ text: 'Günün haberi', chip: 'routine', routine: 'gunun-haberi' });
    expect(byItem.s.chip).toBe('stalled');
    expect(byItem.f.chip).toBe('refusal');
  });

  it("the phone's agenda says where a refused command can be allowed, and offers nothing", () => {
    const digest = {
      pad: [], ownerBatches: [], names: {}, key: 'k',
      waiting: [
        { id: 'f', kind: 'member', state: 'pending', createdAt: 1, sessionId: 'x', text: 'Bash node pay.cjs', member: 'turing', of: 'owner', wait: 'refusal', title: 'Turing · Funnel QA' },
        { id: 'r', kind: 'routine', state: 'pending', createdAt: 2, sessionId: 'S', text: 'Did not run at 03:00', routine: 'gunun-haberi', member: 'herodot', title: 'Günün haberi' },
      ],
    } as unknown as SuperDigestWire;
    const input = digestToNotepadInput(digest, 'Super Agent');
    const html = renderToStaticMarkup(createElement(SuperAgenda, {
      state: input.state, look: input.look, variant: 'full', canShowChild: () => false, canOpenMember: false, remote: true,
      onShowChild: () => {}, onShowQuestion: () => {},
    }));
    expect(has(html, 'super-agenda-phone-refusal')).toBe(true);
    expect(html).toContain('owner.answer.phoneRefusal');
    expect(html).not.toContain('owner.answer.allowOnce');
    // Each row is named by the title the Mac resolved (contracts-w5b), never its slug.
    expect(html).toContain('Turing · Funnel QA');
    expect(html).toContain('Günün haberi');
    const rows = superNotepad(input.state, input.look).waiting;
    expect(rows.map((r) => [r.item, r.text, r.chip])).toEqual([['f', 'Turing · Funnel QA', 'refusal'], ['r', 'Günün haberi', 'routine']]);
  });

  it('an older digest (no title, no wait) names rows by slug and claims no refusal', () => {
    const digest = {
      pad: [], ownerBatches: [], names: {}, key: 'k',
      waiting: [{ id: 'f', kind: 'member', state: 'pending', createdAt: 1, sessionId: 'x', text: 'waits', member: 'turing', of: 'owner' }],
    } as unknown as SuperDigestWire;
    const input = digestToNotepadInput(digest, 'Super Agent');
    const rows = superNotepad(input.state, input.look).waiting;
    expect(rows.map((r) => [r.text, r.chip])).toEqual([['turing', 'needsYou']]);
  });

  it('the side menu counts every item main holds for a member (D), a nudge never', () => {
    const queue = [refused, stalled, { ...routine, member: 'turing' }, nudge, { ...refused, id: 'gone', state: 'done' }];
    const waits = memberWaitCounts(queue);
    expect(waits).toEqual({ turing: 3 });
    const summary = { slug: 'turing', global: false, enabled: true, ownerWorking: 0, asking: false, approval: false, unread: 0, superOnly: false, lastAt: 1, pending: 0 };
    const members = buildEkip([summary], [{ slug: 'turing', title: 'Turing', hasPhoto: false }], [], waits);
    expect(members[0]).toMatchObject({ asking: true, waiting: 3 });
    expect(ekipCount(members)).toBe(3);
    expect(ekipAskingCount(members)).toBe(3);
    // Without the reads it is what it was: the summary's one question.
    expect(ekipCount(buildEkip([{ ...summary, asking: true }], []))).toBe(1);
  });
});

describe('an item already allowed, waiting for its chat to open (`allowed`)', () => {
  const allowedRefusal = (over: Partial<SuperQueueItem> = {}) => refusedMirror({ id: 'q-al', allowed: 'once', ...over });
  const noAllow = (html: string) => {
    expect(html).not.toContain('owner.answer.allowOnce');
    expect(html).not.toContain('owner.answer.always');
    expect(has(html, 'super-queue-allow-once')).toBe(false);
    expect(has(html, 'super-queue-always')).toBe(false);
    expect(has(html, 'grant-allow')).toBe(false);
    expect(has(html, 'grant-decision')).toBe(false);
  };

  it('the bar: the command, the line and Open; no Allow, no Always (a member mirror and main\'s own)', () => {
    const member = bar(allowedRefusal());
    expect(member).toContain('owner.answer.allowedWaiting');
    expect(member).toContain(SCRIPT);
    expect(has(member, 'super-queue-open-member')).toBe(true);
    noAllow(member);
    const own = bar({ id: 'q-ao', sessionId: 'S', kind: 'owner', state: 'escalated', createdAt: 1, own: true, wait: { kind: 'refusal', id: 'rf-9', refusal: refusal() }, offer: { sizes: ['once', 'job'] }, allowed: 'once' } as SuperQueueItem);
    expect(own).toContain('owner.answer.allowedWaiting');
    noAllow(own);
    const perm = bar(mirror({ id: 'q-ap', of: 'permission', call: { tool: 'Bash', input: 'curl -s https://api.example.test/v1/top', whole: true }, offer: { sizes: ['once', 'job', 'member'] }, allowed: 'job' }));
    expect(perm).toContain('owner.answer.allowedWaiting');
    noAllow(perm);
  });

  it("the Super chat's member card and the member's refusal card: the line and Open", () => {
    publishSuperQuestions('S', { open: [], members: [allowedRefusal()], superSession: undefined, sessionFor: () => undefined }, 'k-allowed');
    const card = renderToStaticMarkup(createElement(SuperQuestionTail, { session: { claudeId: 'S' } as never, anchored: new Set<string>() }));
    expect(has(card, 'super-member-allowed')).toBe(true);
    expect(has(card, 'super-member-open')).toBe(true);
    noAllow(card);
    const own = renderToStaticMarkup(createElement(RefusalCard, { record: 'turing', item: allowedRefusal(), who: 'Turing', onOpen: () => {} }));
    expect(has(own, 'grant-allowed')).toBe(true);
    expect(has(own, 'grant-open')).toBe(true);
    noAllow(own);
  });

  it('the agenda: the row says it is allowed instead of its words', () => {
    const rows = superNotepad({ queue: [allowedRefusal()], pad: [] }, look).waiting;
    expect(rows[0].allowed).toBe(true);
    const html = renderToStaticMarkup(createElement(SuperAgenda, {
      state: { queue: [allowedRefusal()], pad: [] }, look, variant: 'full', canShowChild: () => false,
      onShowChild: () => {}, onShowQuestion: () => {},
    }));
    expect(has(html, 'super-agenda-allowed')).toBe(true);
    expect(html).toContain('owner.answer.allowedWaiting');
  });

  it('a done item is not waiting any more', async () => {
    const { allowedWaiting } = await import('../../dashboard/src/components/sleepy/super/ownerAnswer.js');
    expect(allowedWaiting({ allowed: 'once', state: 'pending' })).toBe(true);
    expect(allowedWaiting({ allowed: 'once', state: 'done' })).toBe(false);
    expect(allowedWaiting({ state: 'pending' })).toBe(false);
  });
});

describe("the profile's Permissions (C1, C2)", () => {
  const rule = { id: 'g-1', member: 'turing', form: 'script' as const, rule: 'node _dream_context/tmp/turing/pay.cjs …', createdAt: Date.UTC(2026, 10, 10) };
  const data = { level: 'balanced', rules: [rule], applies: { narrowing: 'now' as const, widening: 'next_session' as const } };
  const body = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PermissionsBody, {
    data, failed: false, busy: null, note: null, name: 'Turing', onRemove: () => {}, ...over,
  }));

  it('lists each rule with Remove, and the level', () => {
    const html = body();
    expect(html.match(/data-testid="agent-permissions-rule"/g)?.length).toBe(1);
    expect(html).toContain('node _dream_context/tmp/turing/pay.cjs …');
    expect(has(html, 'agent-permissions-remove')).toBe(true);
    expect(html).toContain('aiteam.autonomy.label');
  });

  it('an empty list says so (C2)', () => {
    const html = body({ data: { ...data, rules: [] } });
    expect(has(html, 'agent-permissions-empty')).toBe(true);
    expect(has(html, 'agent-permissions-rules')).toBe(false);
  });

  it('a rule never shows a control or bidi character raw', () => {
    const html = body({ data: { ...data, rules: [{ ...rule, rule: 'node a.mjs \u202egnp.exe' }] } });
    expect(html).toContain('\\u{202e}');
    expect(html).not.toContain('\u202e');
  });

  it('removes one with the owner key; a 403 says it can only be changed in the app', async () => {
    const ok = { get: vi.fn(), ownerPost: vi.fn(async () => ({ ok: true })) };
    expect(await removeMemberRule(ok, 'turing', 'g-1')).toBe('ok');
    expect(ok.ownerPost).toHaveBeenCalledWith('/agents/turing/permissions/remove', { id: 'g-1' });
    const refused = { get: vi.fn(), ownerPost: vi.fn(async () => { throw new RequestError('Only the owner', 403, 'owner_page_only'); }) };
    expect(await removeMemberRule(refused, 'turing', 'g-1')).toBe('app_only');
    const down = { get: vi.fn(), ownerPost: vi.fn(async () => { throw new Error('offline'); }) };
    expect(await removeMemberRule(down, 'turing', 'g-1')).toBe('failed');
    expect(body({ note: 'agents.permissions.appOnly' })).toContain('agents.permissions.appOnly');
  });

  it('explains a level change: stricter now (or next session), freer at the next session', () => {
    expect(levelChangeKey('balanced', 'ask', data.applies)).toBe('agents.permissions.narrowNow');
    expect(levelChangeKey('free', 'balanced', { narrowing: 'next_session', widening: 'next_session' })).toBe('agents.permissions.narrowNext');
    expect(levelChangeKey('balanced', 'free', data.applies)).toBe('agents.permissions.widen');
    expect(levelChangeKey('balanced', 'balanced', data.applies)).toBeNull();
    expect(body({ chosenLevel: 'free' })).toContain('agents.permissions.widen');
  });

  it('reads the route answer whole or not at all', () => {
    expect(readMemberPermissions({ level: 'ask', rules: [rule, { id: 3 }], applies: { narrowing: 'now' } })).toEqual({
      level: 'ask', rules: [rule], applies: { narrowing: 'now', widening: 'next_session' },
    });
    expect(readMemberPermissions({ rules: [] })).toBeNull();
    expect(readMemberPermissions(null)).toBeNull();
  });
});
