/**
 * The ONE client the owner's in-place answers go through (uye-bildirim K4/K5, criterion 12):
 *  - what a row is, read from the item alone (a mirror's `of`, an owner item's wait, a routine);
 *  - the sizes a surface may draw: exactly `offer.sizes`, Allow once only without an offer, never
 *    a member size on main's own crew, nothing for a call stored cut (consent matches display);
 *  - control and bidi characters drawn as visible escapes;
 *  - the route answer: a 403 (no owner key) falls back to Open, a second answer is told, a closed
 *    window falls back too; the owner key rides `ownerPost`;
 *  - first answer wins across the bar and the chat card of one window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({}), useVaultId: () => ({ vault: 'acme' }) }));

const {
  MAIN_RECORD, OWNER_ANSWER_PATH, _resetOwnerItems, mainCrewItem, recordOf, allowAnswer, answerRequest, answerStateAfter, callOf, claimOwnerItem, declineAnswer, grantChoices,
  oneChoiceQuestion, ownerItemClaimed, ownerRowKind, permissionItemOf, questionAnswer, refusalItemsOf, releaseOwnerItem, sendOwnerAnswer, visibleText,
} = await import('../../dashboard/src/components/sleepy/super/ownerAnswer.js');
const { RequestError } = await import('../../dashboard/src/api/client.js');
type SuperQueueItem = import('../../dashboard/src/lib/superTypes.js').SuperQueueItem;

const refusal = { tool: 'Bash', input: 'node _dream_context/tmp/turing/pay.cjs --funnel headway', whole: true, source: 'classifier' as const };
const item = (over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
  id: 'q-1', sessionId: 'sid-1', kind: 'member', state: 'pending', createdAt: 1, member: 'turing', answers: 'mq-1', of: 'owner',
  ...over,
} as SuperQueueItem);

beforeEach(() => _resetOwnerItems());

describe('what a row is', () => {
  it('reads each kind from the item', () => {
    expect(ownerRowKind(item({ of: 'permission' }))).toBe('permission');
    expect(ownerRowKind(item({ of: 'ask' }))).toBe('question');
    expect(ownerRowKind(item({ of: 'question' }))).toBe('question');
    expect(ownerRowKind(item({ wait: { kind: 'refusal', id: 'rf-1', refusal } }))).toBe('refusal');
    expect(ownerRowKind(item({ wait: { kind: 'stalled', id: 'st-1' } }))).toBe('stalled');
    expect(ownerRowKind(item({ wait: { kind: 'run', id: 'r' } }))).toBe('open');
    expect(ownerRowKind(item({ of: 'approval' }))).toBe('open');
    expect(ownerRowKind(item({ kind: 'routine', routine: 'gunun-haberi', fact: 'not-approved:abc' }))).toBe('routine');
    expect(ownerRowKind(item({ kind: 'owner', of: undefined, wait: { kind: 'refusal', id: 'rf-1', refusal } }))).toBe('refusal');
    expect(ownerRowKind(item({ kind: 'owner', of: undefined, wait: { kind: 'secret', id: 's' } }))).toBe('open');
  });

  it('an owner mirror carrying an offer and no wait yet is a refusal (an offer rides nothing else)', () => {
    expect(ownerRowKind(item({ offer: { sizes: ['once'] } }))).toBe('refusal');
  });
});

describe('the sizes a surface may draw', () => {
  const withCall = (over: Partial<SuperQueueItem> = {}) => item({ wait: { kind: 'refusal', id: 'rf-1', refusal }, ...over });

  it('no offer: Allow once only (an older record)', () => {
    const it0 = withCall();
    expect(grantChoices(it0, callOf(it0), 'main').sizes).toEqual(['once']);
  });

  it('exactly the offered sizes, in order, with the rule and the not-checked line', () => {
    const it1 = withCall({ offer: { sizes: ['member', 'once', 'job'], notChecked: 'What it loads is not checked.', rule: 'node pay.cjs …' } });
    const c = grantChoices(it1, callOf(it1), 'main');
    expect(c.sizes).toEqual(['once', 'job', 'member']);
    expect(c.notChecked).toBe('What it loads is not checked.');
    expect(c.rule).toBe('node pay.cjs …');
    expect(c.onceOnlyReason).toBeUndefined();
  });

  it('the once-only reason only when once is all there is', () => {
    const it2 = withCall({ offer: { sizes: ['once'], onceOnlyReason: 'This sends something out of this Mac, so it is asked every time.' } });
    expect(grantChoices(it2, callOf(it2), 'main')).toEqual({ sizes: ['once'], onceOnlyReason: 'This sends something out of this Mac, so it is asked every time.' });
  });

  it("main's own crew never shows a member size, even if one arrived", () => {
    const own = item({ kind: 'owner', of: undefined, member: undefined, own: true, wait: { kind: 'refusal', id: 'rf-1', refusal }, offer: { sizes: ['once', 'job', 'member'] } });
    expect(grantChoices(own, callOf(own), 'main').sizes).toEqual(['once', 'job']);
  });

  it("whose crew an item is comes from the RECORD it lives in, never its kind alone", () => {
    const sizes = { offer: { sizes: ['once' as const, 'job' as const, 'member' as const] } };
    // A plain owner item in a member's OWN record is that member's: the member size stays.
    const memberOwn = item({ kind: 'owner', of: undefined, wait: { kind: 'refusal', id: 'rf-1', refusal }, ...sizes });
    expect(grantChoices(memberOwn, callOf(memberOwn), 'turing').sizes).toEqual(['once', 'job', 'member']);
    expect(grantChoices(memberOwn, callOf(memberOwn), 'main').sizes).toEqual(['once', 'job']);
    // A permission in a member's own record keeps it too; in main's record only a mirror does.
    const perm = item({ kind: 'permission', of: undefined, call: { tool: 'Bash', input: 'node x.mjs', whole: true }, ...sizes });
    expect(grantChoices(perm, callOf(perm), 'turing').sizes).toContain('member');
    expect(grantChoices(perm, callOf(perm), 'main').sizes).not.toContain('member');
    const mirrorPerm = item({ of: 'permission', call: { tool: 'Bash', input: 'node x.mjs', whole: true }, ...sizes });
    expect(grantChoices(mirrorPerm, callOf(mirrorPerm), 'main').sizes).toContain('member');
    expect(mainCrewItem('main', { kind: 'owner' })).toBe(true);
    expect(mainCrewItem('main', { kind: 'member' })).toBe(false);
    expect(mainCrewItem('turing', { kind: 'owner' })).toBe(false);
    expect(recordOf({ member: 'turing' })).toBe('turing');
    expect(recordOf({})).toBe(MAIN_RECORD);
    expect(recordOf(null)).toBe('main');
  });

  it('a call stored cut, or no call at all, gets nothing (he never allows what he did not see)', () => {
    const cut = withCall({ wait: { kind: 'refusal', id: 'rf-1', refusal: { ...refusal, whole: false } }, offer: { sizes: ['once', 'job'] } });
    expect(grantChoices(cut, callOf(cut), 'main').sizes).toEqual([]);
    const blind = item({ of: 'permission', offer: { sizes: ['once', 'job'] } });
    expect(callOf(blind)).toBeNull();
    expect(grantChoices(blind, callOf(blind), 'main').sizes).toEqual([]);
  });

  it('an empty offer (a settings rule forbids it) offers no Allow', () => {
    const ruled = withCall({ offer: { sizes: [] } });
    expect(grantChoices(ruled, callOf(ruled), 'main').sizes).toEqual([]);
  });
});

describe('a command drawn as it runs', () => {
  it('control and bidi characters become visible escapes; a block keeps its newlines', () => {
    expect(visibleText('rm -rf \u202e/cod.exe')).toBe('rm -rf \\u{202e}/cod.exe');
    expect(visibleText('a\u200bb\u0007c')).toBe('a\\u{200b}b\\u{7}c');
    expect(visibleText('echo a\necho b')).toBe('echo a\\necho b');
    expect(visibleText('echo a\necho b', true)).toBe('echo a\necho b');
    expect(visibleText('git status\r')).toBe('git status\\u{d}');
    expect(visibleText('Türkçe ğüşıöç İ')).toBe('Türkçe ğüşıöç İ');
  });
});

describe('the answers it sends', () => {
  it('allow, decline and a picked option, by what the row is', () => {
    expect(allowAnswer('refusal', 'job')).toEqual({ kind: 'refusal', action: 'allow', size: 'job' });
    expect(allowAnswer('permission', 'once')).toEqual({ kind: 'permission', behavior: 'allow', size: 'once' });
    expect(declineAnswer('permission')).toEqual({ kind: 'permission', behavior: 'deny' });
    expect(declineAnswer('refusal')).toEqual({ kind: 'refusal', action: 'not_needed' });
    expect(declineAnswer('stalled')).toEqual({ kind: 'dismiss' });
    expect(questionAnswer('Send it?', 'Gönder')).toEqual({ kind: 'question', answers: { 'Send it?': 'Gönder' } });
    // The item is named, never its command or a rule: the server builds the grant from what it stored.
    expect(answerRequest('main', item(), allowAnswer('refusal', 'once'), 'bar')).toEqual({ record: 'main', item: 'q-1', answer: { kind: 'refusal', action: 'allow', size: 'once' }, via: 'bar' });
  });

  it('a one-tap question is exactly one single-choice question with up to four plain options', () => {
    const ask = (q: Record<string, unknown>[]) => ({ ask: { questions: q } } as unknown as SuperQueueItem);
    expect(oneChoiceQuestion(ask([{ question: 'DM Ali?', options: [{ label: 'Gönder' }, { label: 'Gönderme' }] }])))
      .toEqual({ question: 'DM Ali?', options: ['Gönder', 'Gönderme'] });
    expect(oneChoiceQuestion(ask([{ question: 'a', options: [{ label: 'x' }] }, { question: 'b', options: [{ label: 'y' }] }]))).toBeNull();
    expect(oneChoiceQuestion(ask([{ question: 'a', multiSelect: true, options: [{ label: 'x' }] }]))).toBeNull();
    expect(oneChoiceQuestion(ask([{ question: 'a', options: [{ label: 'x', preview: '<p>' }] }]))).toBeNull();
    expect(oneChoiceQuestion({} as SuperQueueItem)).toBeNull();
  });
});

describe('the route', () => {
  const poster = (impl: () => Promise<unknown>) => ({ ownerPost: vi.fn(impl) as <T>(path: string, body: unknown) => Promise<T> });

  it('posts to the owner-answer route with the owner key path (ownerPost)', async () => {
    const api = poster(async () => ({ ok: true, outcome: 'allowed' }));
    const req = answerRequest('main', item(), allowAnswer('refusal', 'once'), 'chat');
    expect(await sendOwnerAnswer(api, req)).toEqual({ ok: true, outcome: 'allowed' });
    expect(api.ownerPost).toHaveBeenCalledWith(OWNER_ANSWER_PATH, req);
    expect(OWNER_ANSWER_PATH).toBe('/super/owner-answer');
  });

  it('a 403 (no owner key: a plain browser, an older shell) falls back to Open', async () => {
    const r = await sendOwnerAnswer(poster(async () => { throw new RequestError('Only the owner', 403, 'owner_page_only'); }), answerRequest('main', item(), { kind: 'dismiss' }, 'bar'));
    expect(r).toMatchObject({ ok: false, error: 'owner_page_only', openInstead: true });
    expect(answerStateAfter(r)).toEqual({ busy: false, fallback: true, note: 'owner.answer.openInstead' });
  });

  it('a 409 that is no window or no longer offered is Open, never "answered already"', async () => {
    for (const code of ['no_window', 'not_offered']) {
      const r = await sendOwnerAnswer(poster(async () => { throw new RequestError('Conflict', 409, code); }), answerRequest('main', item(), { kind: 'dismiss' }, 'bar'));
      expect(r).toMatchObject({ ok: false, error: code, openInstead: true });
      expect(answerStateAfter(r)).toMatchObject({ fallback: true });
    }
  });

  it('a second answer is told, never offered Open', async () => {
    const r = await sendOwnerAnswer(poster(async () => { throw new RequestError('Answered', 409, 'already_answered'); }), answerRequest('main', item(), { kind: 'dismiss' }, 'bar'));
    expect(r).toMatchObject({ ok: false, error: 'already_answered', openInstead: false });
    expect(answerStateAfter(r)).toEqual({ busy: false, fallback: false, note: 'owner.answer.answered' });
  });

  it('a closed window falls back to Open; a failure may be tried again; allowed-but-waiting says so', async () => {
    const closed = await sendOwnerAnswer(poster(async () => ({ ok: false, error: 'no_window', message: 'closed' })), answerRequest('main', item(), { kind: 'dismiss' }, 'bar'));
    expect(answerStateAfter(closed).fallback).toBe(true);
    const down = await sendOwnerAnswer(poster(async () => { throw new Error('offline'); }), answerRequest('main', item(), { kind: 'dismiss' }, 'bar'));
    expect(answerStateAfter(down)).toEqual({ busy: false, fallback: false, note: 'owner.answer.failed' });
    expect(answerStateAfter({ ok: true, outcome: 'allowed_waiting' }).note).toBe('owner.answer.allowedWaiting');
  });
});

describe('first answer wins in this window', () => {
  it('a second claim of the same item is refused until the first is released', () => {
    expect(claimOwnerItem('q-1')).toBe(true);
    expect(claimOwnerItem('q-1')).toBe(false);
    expect(ownerItemClaimed('q-1')).toBe(true);
    releaseOwnerItem('q-1');
    expect(claimOwnerItem('q-1')).toBe(true);
  });
});

describe("a session's own items, for its own chat cards", () => {
  it('finds the open permission of a request and the open refusals, oldest first', () => {
    const perm = item({ id: 'p', kind: 'permission', of: undefined, requestId: 'req-1' });
    const r2 = item({ id: 'r2', kind: 'owner', of: undefined, createdAt: 9, wait: { kind: 'refusal', id: 'rf-2', refusal } });
    const r1 = item({ id: 'r1', kind: 'owner', of: undefined, createdAt: 3, wait: { kind: 'refusal', id: 'rf-1', refusal } });
    const done = item({ id: 'r0', kind: 'owner', of: undefined, state: 'done', wait: { kind: 'refusal', id: 'rf-0', refusal } });
    const view = { record: 'turing', items: [perm, r2, r1, done] };
    expect(permissionItemOf(view, 'req-1')?.id).toBe('p');
    expect(permissionItemOf(view, 'req-2')).toBeNull();
    expect(refusalItemsOf(view).map((q) => q.id)).toEqual(['r1', 'r2']);
    expect(refusalItemsOf(null)).toEqual([]);
  });
});
