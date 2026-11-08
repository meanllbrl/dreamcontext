/**
 * The window side of Telegram turns (W3 lane A): the sentinel rule mirrored into the import-free
 * chat protocol, the owner_echo and hub_command frames, the ref a Telegram item carries through
 * history, writeUser and reply links, and the `answer_pending` / `html_snapshot` hub verbs.
 * Fictional words throughout.
 */
import { describe, it, expect } from 'vitest';
import {
  TG_REF_RE, TG_SENTINEL, HUB_VERBS, parseTelegramPrefix, stripSentinels, withTelegramRef, buildQuestionPicks,
} from '../../src/lib/telegram/contract.js';
import {
  TG_REF_SHAPE, TG_SENTINEL_CHAR, parseChatLine, parseTelegramClaim, stripSentinelChars, stripTgPrefix,
} from '../../dashboard/src/lib/chatProtocol.js';
import { isHubVerb, parseAnswerPending, parseSnapshotArgs, picksMatchOptions, planHubAnswer, runHtmlSnapshot } from '../../dashboard/src/lib/hubCommands.js';
import { keepTelegramRef } from '../../dashboard/src/components/sleepy/chat/QueuedMessages.js';
import { pendingSince } from '../../dashboard/src/components/telegram/TelegramBindSheet.js';
import { historyChatItem, type ChatItem, type PendingItem } from '../../dashboard/src/components/sleepy/chatSession.js';
import { ownerRefOf, replyGroups } from '../../dashboard/src/components/sleepy/chat/replyLinks.js';
import { msgRef } from '../../dashboard/src/lib/superTypes.js';
import { replyAboutBlock, replySelectionBlock } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { WINDOW_VERBS } from '../../src/server/routes/window-control.js';

const S = TG_SENTINEL;
const meta = (o: Record<string, unknown>) => parseChatLine(JSON.stringify({ type: '_meta', ...o }));

describe('the sentinel rule mirrored in chatProtocol stays the contract\'s', () => {
  const corpus = [
    '', 'evet', `${S}abc123${S}evet`, `${S}abc123${S}${S}zzz999${S}x`, `${S}ABC123${S}x`, `${S}abc12${S}x`,
    `x${S}abc123${S}y`, `${S}abc123`, `${S}${S}evet`, `${S}abc123${S}`, `Şimdi ${S}çalış`, `${S}0a9z8y${S}Türkçe ğüşiöç`,
  ];
  it('same code point, same ref shape', () => {
    expect(TG_SENTINEL_CHAR).toBe(TG_SENTINEL);
    expect(TG_REF_SHAPE.source).toBe(TG_REF_RE.source);
  });
  it.each(corpus)('parse and strip agree on %j', (text) => {
    expect(parseTelegramClaim(text)).toEqual(parseTelegramPrefix(text));
    expect(stripSentinelChars(text)).toBe(stripSentinels(text));
  });
  it('a resubmitted text shows its body; an owner-typed sentinel is no claim', () => {
    expect(stripTgPrefix(withTelegramRef('k3x9a1', 'Tamam, devam et'))).toBe('Tamam, devam et');
    expect(parseTelegramClaim(`merhaba ${S}k3x9a1${S}`)).toEqual({ ref: null, body: 'merhaba k3x9a1' });
  });
});

describe('owner_echo keeps the Telegram ref; hub_command has its own event', () => {
  it('a hub echo carries ref and source', () => {
    expect(meta({ subtype: 'owner_echo', text: 'Raporu gönder', ref: 'q1w2e3', source: 'telegram' }))
      .toEqual({ kind: 'owner-echo', text: 'Raporu gönder', ref: 'q1w2e3', source: 'telegram' });
  });
  it('a raw resubmit echo (sentinel pair in the text) is parsed the same way, the text shown clean', () => {
    expect(meta({ subtype: 'owner_echo', text: withTelegramRef('q1w2e3', 'evet') }))
      .toEqual({ kind: 'owner-echo', text: 'evet', ref: 'q1w2e3', source: 'telegram' });
  });
  it('a malformed ref or a source without a ref marks nothing', () => {
    expect(meta({ subtype: 'owner_echo', text: 'evet', ref: 'NOPE!!', source: 'telegram' })).toEqual({ kind: 'owner-echo', text: 'evet' });
    expect(meta({ subtype: 'owner_echo', text: 'evet' })).toEqual({ kind: 'owner-echo', text: 'evet' });
    expect(meta({ subtype: 'owner_echo', text: `${S}${S}` }).kind).toBe('ignored');
  });
  it('hub_command parses; one without id or verb is ignored', () => {
    expect(meta({ subtype: 'hub_command', id: 'h1', verb: 'answer_pending', args: { requestId: 'r' } }))
      .toEqual({ kind: 'hub-command', id: 'h1', verb: 'answer_pending', args: { requestId: 'r' } });
    expect(meta({ subtype: 'hub_command', verb: 'answer_pending' }).kind).toBe('ignored');
  });
  it('hub verbs are never window verbs (contract A2), and the window knows them', () => {
    for (const v of HUB_VERBS) {
      expect(isHubVerb(v)).toBe(true);
      expect((WINDOW_VERBS as readonly string[]).includes(v)).toBe(false);
    }
    expect(isHubVerb('open_page')).toBe(false);
  });
});

describe('a Telegram item keeps its ref through history and reply links', () => {
  it('history: source + valid ref mark the item; a bad ref does not', () => {
    expect(historyChatItem({ kind: 'user', text: 'Durum ne?', at: 5, source: 'telegram', ref: 'p0o9i8' }, 'h1'))
      .toMatchObject({ kind: 'user', text: 'Durum ne?', ref: 'p0o9i8', source: 'telegram' });
    const plain = historyChatItem({ kind: 'user', text: 'Durum ne?', at: 5, source: 'telegram', ref: 'bad ref' }, 'h2');
    expect(plain).not.toHaveProperty('ref');
    expect(plain).not.toHaveProperty('source');
  });

  it('a user item with ref is the target of a re:<ref> block (C1), not its hashed words', () => {
    const tg: ChatItem = { kind: 'user', id: 'u1', text: 'evet', ts: 1, ref: 'tg0001', source: 'telegram' };
    const mac: ChatItem = { kind: 'user', id: 'u2', text: 'evet', ts: 2 };
    const answer: ChatItem = { kind: 'text', id: 't1', index: 0, text: 'Tamam, yaptım.', done: true, ts: 3, replyTo: ['tg0001'] };
    expect(ownerRefOf(tg as { text: string; ref?: string })).toBe('tg0001');
    expect(ownerRefOf(mac as { text: string })).toBe(msgRef('evet'));
    expect(replyGroups([tg, mac, answer]).get('t1')).toMatchObject({ targets: ['u1'] });
    // The Mac "evet" beside it is answered by its own hashed ref, never by the Telegram one.
    const macAnswer: ChatItem = { kind: 'text', id: 't2', index: 0, text: 'Bu da tamam.', done: true, ts: 4, replyTo: [msgRef('evet')] };
    expect(replyGroups([tg, mac, macAnswer]).get('t2')).toMatchObject({ targets: ['u2'] });
  });

  it('a reply to a Telegram message names its ref, not its words\' hash', () => {
    expect(replyAboutBlock('evet', 'owner', 'evet', 'tg0001')).toContain('[Reply to message ref=tg0001 from=owner]');
    expect(replyAboutBlock('evet', 'owner')).toContain(`ref=${msgRef('evet')}`);
    expect(replySelectionBlock('evet', 'owner', 'evet', 'tg0001')).toContain('ref=tg0001');
  });

});

describe('answer_pending: only this chat\'s card, only permission and question', () => {
  const perm: PendingItem = { kind: 'permission', requestId: 'r-perm', toolName: 'Bash', input: { command: 'ls' } };
  const question: PendingItem = {
    kind: 'question', requestId: 'r-q', toolName: 'AskUserQuestion',
    questions: [
      { question: 'Hangi renk?', header: 'Renk', multiSelect: false, options: [{ label: 'Mor', description: '' }, { label: 'Yeşil', description: '' }] },
      { question: 'Hangi günler?', header: 'Gün', multiSelect: true, options: [{ label: 'Pzt', description: '' }, { label: 'Sal', description: '' }, { label: 'Çar', description: '' }] },
    ],
    input: { questions: [] },
  } as PendingItem;
  const plan: PendingItem = { kind: 'plan', requestId: 'r-plan', toolName: 'ExitPlanMode', plan: 'p', input: {} };
  const pending = [perm, question, plan];

  it('allow once echoes the tool input exactly as the Mac card; deny is the Mac denial', () => {
    expect(planHubAnswer({ kind: 'permission', requestId: 'r-perm', choice: 'allow_once' }, pending))
      .toEqual({ ok: true, requestId: 'r-perm', behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(planHubAnswer({ kind: 'permission', requestId: 'r-perm', choice: 'deny' }, pending))
      .toEqual({ ok: true, requestId: 'r-perm', behavior: 'deny', message: 'Denied by user.' });
  });

  it('a request not pending here, a plan approval, a wrong kind and an always-allow are refused', () => {
    expect(planHubAnswer({ kind: 'permission', requestId: 'r-other', choice: 'allow_once' }, pending)).toEqual({ ok: false, error: 'not_pending' });
    expect(planHubAnswer({ kind: 'permission', requestId: 'r-plan', choice: 'allow_once' }, pending)).toEqual({ ok: false, error: 'refused_kind' });
    expect(planHubAnswer({ kind: 'question', requestId: 'r-perm', picked: { x: 'y' } }, pending)).toEqual({ ok: false, error: 'refused_kind' });
    expect(planHubAnswer({ kind: 'permission', requestId: 'r-perm', choice: 'always' }, pending)).toEqual({ ok: false, error: 'bad_args' });
    expect(planHubAnswer({ kind: 'secret', requestId: 'r-perm' }, pending)).toEqual({ ok: false, error: 'bad_args' });
    expect(planHubAnswer('nope', pending)).toEqual({ ok: false, error: 'bad_args' });
    expect(planHubAnswer({ kind: 'question', requestId: 'r-q', item: 'q-7', picked: {} }, pending)).toEqual({ ok: false, error: 'unsupported' });
  });

  it('a question is answered with the hub\'s picks through buildQuestionAnswer; foreign labels are dropped', () => {
    const qs = (question as { questions: { question: string; multiSelect?: boolean; options: { label: string }[] }[] }).questions;
    const picked = buildQuestionPicks(qs, { 'Hangi renk?': ['Yeşil'], 'Hangi günler?': ['Çar', 'Pzt'] });
    const plan1 = planHubAnswer({ kind: 'question', requestId: 'r-q', picked }, pending);
    expect(plan1.ok).toBe(true);
    if (plan1.ok) {
      expect(plan1.behavior).toBe('allow');
      expect(JSON.stringify(plan1.updatedInput)).toContain('Pzt, Çar');
      expect(JSON.stringify(plan1.updatedInput)).toContain('Yeşil');
    }
    expect(planHubAnswer({ kind: 'question', requestId: 'r-q', picked: { 'Hangi renk?': 'Kırmızı' } }, pending)).toEqual({ ok: false, error: 'no_choice' });
    expect(planHubAnswer({ kind: 'question', requestId: 'r-q', picked: { 'Başka soru': 'Mor' } }, pending)).toEqual({ ok: false, error: 'no_choice' });
  });

  it('unclear denies with the survey\'s re-ask text, carrying what was typed', () => {
    const p = planHubAnswer({ kind: 'unclear', requestId: 'r-q', unclear: 'anlamadım' }, pending);
    expect(p).toMatchObject({ ok: true, behavior: 'deny' });
    if (p.ok) expect(p.message).toContain('anlamadım');
  });

  it('the args parser accepts exactly the contract\'s union', () => {
    expect(parseAnswerPending({ kind: 'permission', requestId: 'r', choice: 'deny' })).toEqual({ kind: 'permission', requestId: 'r', choice: 'deny' });
    expect(parseAnswerPending({ kind: 'question', requestId: 'r', picked: { a: 1 } })).toBeNull();
    expect(parseAnswerPending({ kind: 'permission', requestId: '', choice: 'deny' })).toBeNull();
  });
});

describe('html_snapshot passes the page to the shell and its refusals back', () => {
  it('outside the app: unsupported; bad args: refused before the shell', async () => {
    expect(await runHtmlSnapshot({ html: '<p>x</p>' }, null)).toEqual({ ok: false, error: 'unsupported' });
    expect(await runHtmlSnapshot({ html: '' }, async () => ({ ok: true }))).toEqual({ ok: false, error: 'bad_args' });
    expect(parseSnapshotArgs({ html: '<p>x</p>', width: 720 })).toEqual({ html: '<p>x</p>', width: 720 });
    expect(parseSnapshotArgs({ html: '<p>x</p>', width: -1 })).toEqual({ html: '<p>x</p>' });
  });
  it('the shell\'s answer and its named errors come back as the hub result', async () => {
    const calls: unknown[] = [];
    const ok = await runHtmlSnapshot({ html: '<p>x</p>' }, async (cmd, a) => { calls.push([cmd, a]); return { ok: true, pngs: ['iVBO'], width: 720, height: 10, truncated: false }; });
    expect(ok).toEqual({ ok: true, pngs: ['iVBO'], width: 720, height: 10, truncated: false });
    expect(calls).toEqual([['html_snapshot', { html: '<p>x</p>', width: null }]]);
    for (const code of ['busy', 'rate', 'blank', 'timeout', 'too_large']) {
      expect(await runHtmlSnapshot({ html: 'x' }, async () => { throw code; })).toEqual({ ok: false, error: code });
    }
    expect(await runHtmlSnapshot({ html: 'x' }, async () => { throw new Error('/Users/someone/secret path'); })).toEqual({ ok: false, error: 'failed' });
  });
});

describe('end-review r1 fixes', () => {
  it('a multiSelect label that itself holds ", " still matches, in option order only', () => {
    const labels = ['Yes, ship it', 'Wait', 'No, drop it'];
    expect(picksMatchOptions('Yes, ship it, No, drop it', labels, true)).toBe(true);
    expect(picksMatchOptions('Yes, ship it', labels, true)).toBe(true);
    expect(picksMatchOptions('No, drop it, Yes, ship it', labels, true)).toBe(false);
    expect(picksMatchOptions('Yes', labels, true)).toBe(false);
    expect(picksMatchOptions('Wait', labels, false)).toBe(true);
    expect(picksMatchOptions('Yes, ship it, Wait', labels, false)).toBe(false);
  });

  it('a plan approval or a question shaped as a permission is never allowed once from Telegram', () => {
    for (const toolName of ['ExitPlanMode', 'AskUserQuestion']) {
      const pending: PendingItem[] = [{ kind: 'permission', requestId: 'r1', toolName, input: {} }];
      expect(planHubAnswer({ kind: 'permission', requestId: 'r1', choice: 'allow_once' }, pending)).toEqual({ ok: false, error: 'refused_kind' });
    }
  });

  it('editing a queued Telegram turn keeps its ref; a Mac turn stays plain', () => {
    const tg = withTelegramRef('k3x9a1', 'evet');
    expect(keepTelegramRef(tg, stripTgPrefix(tg))).toBe(tg);
    expect(parseTelegramClaim(keepTelegramRef(tg, 'evet, ama yarın'))).toEqual({ ref: 'k3x9a1', body: 'evet, ama yarın' });
    expect(keepTelegramRef('normal', 'normal 2')).toBe('normal 2');
    expect(keepTelegramRef(tg, '   ')).toBe('   ');
  });

  it('a pending row read before this pairing began never raises its confirm', () => {
    const row = { scope: '0123456789abcdef', target: 'super', state: 'pending' as const, botUsername: 'b', userLabel: 'deniz' };
    expect(pendingSince(row, 1000, 2000)).toBe(false);
    expect(pendingSince(row, 2001, 2000)).toBe(true);
    expect(pendingSince({ ...row, userLabel: undefined }, 3000, 2000)).toBe(false);
    expect(pendingSince({ ...row, state: 'active' }, 3000, 2000)).toBe(false);
    expect(pendingSince(null, 3000, 2000)).toBe(false);
  });
});
