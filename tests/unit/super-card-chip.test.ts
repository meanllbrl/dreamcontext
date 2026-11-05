/**
 * A card dropped on the Super chat is a chip (owner 2026-10-31), in the composer and in the sent
 * bubble, never the raw `@card:<id> “<title>”`. The wire is unchanged: a send writes exactly the
 * words `cardReference` always put in the draft, where the chip stands.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cardGlyph, cardMentionText, cardMentions, CARD_REF_TITLE_MAX, GROUP_GLYPH, KIND_GLYPH, UNKNOWN_CARD_GLYPH,
} from '../../dashboard/src/lib/cardMention.js';
import { cardReference, replyAboutBlock, splitAbout } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { aboutHeads } from '../../dashboard/src/lib/superTypes.js';
import { draftFromMessage, isMediaRef, isTokenRef, parseRefTokens, refToken } from '../../dashboard/src/components/sleepy/chat/composerRefs.js';
import {
  __resetScratchForTests, addAttachments, composeOutgoing, dropSentAttachments, insertRef, nextAttachmentId, readScratch,
  stageRefs, type Attachment,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { coerceDraft, keptChips, restoreDraftBody } from '../../dashboard/src/components/sleepy/chat/composerDrafts.js';
import { chipIcon, refMirrorSegments } from '../../dashboard/src/components/sleepy/chat/ComposerRefLayer.js';
import { inlineRuns } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

beforeEach(() => { __resetScratchForTests(); });

const ROOT = join(__dirname, '..', '..');
const q = (p: string) => (/\s/.test(p) ? `'${p}'` : p);
/** The chip a drop stages (AgentSurface.askAboutCard). */
const card = (id: string, title: string, over: Partial<Attachment> = {}): Attachment => ({
  id: nextAttachmentId(), kind: 'card', name: title, text: cardMentionText(id, title), inline: true, ...over,
});
const tok = (a: Attachment) => refToken({ ...a, chip: a.name });

describe('the card mention: its words and where it stands in a text', () => {
  it('is exactly what a drop always wrote (cardReference, O11)', () => {
    expect(cardMentionText('chat-4c3e85d386f2', 'Başlık')).toBe('@card:chat-4c3e85d386f2 “Başlık”');
    expect(cardReference('c3', 'Fix the login bug', '')).toBe(`${cardMentionText('c3', 'Fix the login bug')} `);
    expect(cardMentionText('c3', 'a\u0007b\n“c”"d"\t e')).toBe('@card:c3 “a b c d e”');
    const long = cardMentionText('c3', 'x'.repeat(200));
    expect(long.slice(long.indexOf('“') + 1, long.indexOf('”')).length).toBeLessThanOrEqual(CARD_REF_TITLE_MAX);
  });

  it('finds each mention with its id and title; a bare one too; never a header or a word', () => {
    const t = 'look at @card:chat-1 “Login fix” and @card:img-2 “Ödeme ekranı”, also @card:grp-3';
    expect(cardMentions(t).map((m) => [m.id, m.title, t.slice(m.start, m.end)])).toEqual([
      ['chat-1', 'Login fix', '@card:chat-1 “Login fix”'],
      ['img-2', 'Ödeme ekranı', '@card:img-2 “Ödeme ekranı”'],
      ['grp-3', '', '@card:grp-3'],
    ]);
    expect(cardMentions('[About card @card:c1]\nquote: "x"')).toEqual([]);
    expect(cardMentions('[Selected element on card @card:c1 “Site”]')).toEqual([]);
    expect(cardMentions('mail me@card:c1')).toEqual([]);
    expect(cardMentions('nothing here')).toEqual([]);
  });

  it('every card kind has its icon; a group its own; an unknown card a neutral one', () => {
    for (const k of Object.keys(KIND_GLYPH)) expect(cardGlyph(k)).toBe(KIND_GLYPH[k as keyof typeof KIND_GLYPH]);
    expect(cardGlyph('group')).toBe(GROUP_GLYPH);
    expect(cardGlyph(undefined)).toBe(UNKNOWN_CARD_GLYPH);
    expect(cardGlyph('nonsense')).toBe(UNKNOWN_CARD_GLYPH);
  });
});

describe('in the composer: a chip, never the raw words', () => {
  it('is an inline chip drawn in the picture room: its picture, or its kind\'s icon', () => {
    const img = card('img-1', 'Ekran', { cardKind: 'image', url: '/api/agent/file?path=a.png&raw=1' });
    const chat = card('chat-1', 'Login fix', { cardKind: 'chat' });
    expect(isTokenRef(img) && isMediaRef(img)).toBe(true);
    const draft = `bak ${tok(img)} ve ${tok(chat)} şuna`;
    expect(draft).not.toContain('@card:');
    const segs = refMirrorSegments(draft, [], [img, chat]).filter((s) => s.kind === 'ref');
    expect(segs.map((s) => [s.img, s.icon])).toEqual([[img.url, undefined], [undefined, KIND_GLYPH.chat]]);
    expect(chipIcon({ kind: 'card', cardKind: 'group' })).toBe(GROUP_GLYPH);
    expect(chipIcon({ kind: 'card' })).toBe(UNKNOWN_CARD_GLYPH);
  });

  it('the drop stages the chip the way a picked element arrives (AgentSurface)', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf-8');
    const drop = src.slice(src.indexOf('const chipCard = useCallback'), src.indexOf('/** A card chip in a Super message was clicked'));
    expect(drop).toMatch(/addAttachments\(convId, \[\{/);
    expect(drop).toMatch(/kind: 'card'/);
    expect(drop).toMatch(/text: cardMentionText\(id, title\)/);
    expect(drop).toMatch(/inline: true, pending: true/);
  });
});

describe('on the wire: today\'s words, where the chip stands', () => {
  it('one card among his words: exactly what the raw drop sent', () => {
    const c = card('chat-4c3e85d386f2', 'Başlık');
    const raw = `bak ${cardReference('chat-4c3e85d386f2', 'Başlık', 'bak ')}şuna`.trim();
    for (const superView of [true, false]) {
      expect(composeOutgoing(`bak ${tok(c)} şuna`, [c], null, q, { superView }).message).toBe(raw);
    }
    expect(composeOutgoing(tok(c), [c], null, q, { superView: true }).message).toBe('@card:chat-4c3e85d386f2 “Başlık”');
  });

  it('words typed right against the chip still stand apart from it', () => {
    const c = card('c1', 'T');
    expect(composeOutgoing(`bak${tok(c)}şuna`, [c], null, q, { superView: true }).message).toBe('bak @card:c1 “T” şuna');
  });

  it('beside an About chip (a reply): the header still opens its part and parses', () => {
    const reply: Attachment = { id: nextAttachmentId(), kind: 'about', name: 'Super: done', text: replyAboutBlock('All done.', 'super') };
    const c = card('img-9', 'Mockup');
    const { message } = composeOutgoing(`${tok(reply)} compare with ${tok(c)} please`, [reply, c], null, q, { superView: true });
    expect(message).toBe(`${reply.text}\n\ncompare with @card:img-9 “Mockup” please`);
    expect(aboutHeads(message).map((h) => h.kind)).toEqual(['reply']);
    expect(splitAbout(message).about?.kind).toBe('reply');
    expect(splitAbout(message).text).toBe('compare with @card:img-9 “Mockup” please');
  });

  it('beside a picture: the picture line as before, the card in his words', () => {
    const p: Attachment = { id: nextAttachmentId(), kind: 'image', name: 'a.png', inline: true, path: '/v/a.png' };
    const c = card('c1', 'T');
    const { message } = composeOutgoing(`${tok(p)} like ${tok(c)}`, [p, c], null, q, { superView: true });
    expect(message).toBe('[Picture 1: /v/a.png]\nlike @card:c1 “T”');
  });

  it('a card chip is gone after the send (a slash command\'s too: its words went out)', () => {
    const c = card('c1', 'T');
    addAttachments('s', [c]);
    dropSentAttachments('s', { keepInline: true });
    expect(readScratch('s').attachments).toEqual([]);
  });

  it('a card chip whose token left the draft sends nothing', () => {
    const c = card('c1', 'T');
    expect(composeOutgoing('just words', [c], null, q, { superView: true }).message).toBe('just words');
  });

  it('an About chip still counts toward the reference cap; a card does not take a slot', () => {
    addAttachments('s', [card('c1', 'T')]);
    for (let i = 0; i < 5; i += 1) {
      expect(insertRef('s', { id: nextAttachmentId(), kind: 'about', name: `n${i}`, text: `[About agenda line n${i}]\nline: "x${i}"` })).toBe('added');
    }
  });
});

describe('read back (↑ recall, a rewind, a kept draft): chips again', () => {
  it('a sent message comes back with its card chips, and sends the same bytes', () => {
    const sent = 'bak @card:chat-1 “Login fix” ve @card:img-2 “Ekran” şuna';
    let n = 0;
    const back = draftFromMessage(sent, {
      mint: () => `att-${++n}`,
      card: (id) => (id === 'img-2' ? { kind: 'image', img: '/api/agent/file?path=e.png&raw=1' } : null),
    });
    expect(back.draft).not.toContain('@card:');
    expect(back.refs.map((r) => [r.kind, r.name, r.cardKind, r.url])).toEqual([
      ['card', 'Login fix', undefined, undefined],
      ['card', 'Ekran', 'image', '/api/agent/file?path=e.png&raw=1'],
    ]);
    expect(parseRefTokens(back.draft)).toHaveLength(2);
    expect(composeOutgoing(back.draft, back.refs, null, q, { superView: true }).message).toBe(sent);
    stageRefs('s', back.refs, back.draft);
    expect(readScratch('s').attachments.map((a) => [a.kind, a.inline, a.pending])).toEqual([['card', true, false], ['card', true, false]]);
    // Stepping to another message: the recalled card chips leave with their draft.
    stageRefs('s', [], 'other words');
    expect(readScratch('s').attachments).toEqual([]);
  });

  it('a recalled message with a reply header and a card: both chips', () => {
    const sent = `${replyAboutBlock('All done.', 'super')}\n\nsee @card:c1 “T”`;
    let n = 0;
    const back = draftFromMessage(sent, { mint: () => `att-${++n}` });
    expect(back.refs.map((r) => r.kind).sort()).toEqual(['about', 'card']);
    expect(composeOutgoing(back.draft, back.refs, null, q, { superView: true }).message).toBe(sent);
  });

  it('a kept draft keeps a card chip, its icon and its picture; a foreign URL is refused', () => {
    const c = card('img-1', 'Ekran', { cardKind: 'image', url: '/api/agent/file?path=e.png&raw=1' });
    const chips = keptChips([c]).map((x) => ({ ...x, tid: '1' }));
    expect(chips[0]).toMatchObject({ kind: 'card', cardKind: 'image', url: c.url, inline: true });
    const saved = coerceDraft({ text: tok(c), quote: null, chips, savedAt: 1 });
    expect(saved?.chips[0]).toMatchObject({ kind: 'card', cardKind: 'image', url: c.url });
    const restored = restoreDraftBody(saved!);
    expect(restored.attachments[0]).toMatchObject({ kind: 'card', text: '@card:img-1 “Ekran”' });
    const evil = coerceDraft({ text: 'x', quote: null, chips: [{ ...chips[0], url: 'https://evil.example/x.png' }], savedAt: 1 });
    expect(evil?.chips[0].url).toBeUndefined();
    const breakOut = coerceDraft({ text: 'x', quote: null, chips: [{ ...chips[0], url: '/api/agent/file?path=a")' }], savedAt: 1 });
    expect(breakOut?.chips[0].url).toBeUndefined();
  });
});

describe('in the sent bubble: chips where the words stood', () => {
  it('splits each mention out of his words, around pictures too', () => {
    expect(inlineRuns('bak @card:c1 “Login fix” şuna')).toEqual([
      { kind: 'text', text: 'bak ' }, { kind: 'card', id: 'c1', title: 'Login fix' }, { kind: 'text', text: ' şuna' },
    ]);
    const runs = inlineRuns('[Picture 1: /v/a.png]\nlike @card:c1 “T”') ?? [];
    expect(runs.map((r) => r.kind)).toEqual(['picture', 'text', 'card']);
    expect(inlineRuns('plain words')).toBeNull();
  });

  it('the bubble draws a card run as the composer\'s chip, clickable only while the card is there', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/chat/TranscriptItem.tsx'), 'utf-8');
    expect(src).toMatch(/r\.kind === 'card' \? <SentCardChip/);
    expect(src).toMatch(/onOpen=\{stage && card \? \(\) => stage\.open\(id\) : undefined\}/);
    expect(src).toMatch(/state=\{card \? 'ready' : 'gone'\}/);
    expect(src).toMatch(/text && \(inlineRuns\(text\)/);
  });
});

describe('a card\'s words inside a reply\'s quote', () => {
  it('stay in the block as sent (the header still parses)', () => {
    const sent = `${replyAboutBlock('Opened @card:c1 “T” for you.', 'super')}\n\nok`;
    let n = 0;
    const back = draftFromMessage(sent, { mint: () => `att-${++n}` });
    expect(back.refs.map((r) => r.kind)).toEqual(['about']);
    expect(composeOutgoing(back.draft, back.refs, null, q, { superView: true }).message).toBe(sent);
  });
});

// ─── End-review findings (multi-review 2026-10-31) ─────────────────────────────────────────

import * as serverDrafts from '../../src/server/routes/agent-sessions.js';
import { CARD_PICTURE_URL_RE, DRAFT_CHIP_KINDS } from '../../dashboard/src/components/sleepy/chat/composerDrafts.js';
import { expandCardChips } from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { refTokenId, stripTokens, tokensOnly } from '../../dashboard/src/components/sleepy/chat/composerRefs.js';
import { addressedPeer } from '../../dashboard/src/lib/agentComposer.js';

describe('a kept draft with a card chip survives the server too (restart)', () => {
  const U = '11111111-2222-4333-8444-555555555555';
  it('the server keeps the chip, its icon and its picture; the lists match the client (drift)', () => {
    expect([...serverDrafts.DRAFT_CHIP_KINDS]).toEqual([...DRAFT_CHIP_KINDS]);
    expect(serverDrafts.CARD_PICTURE_URL_RE.source).toBe(CARD_PICTURE_URL_RE.source);
    const c = card('img-1', 'Ekran', { cardKind: 'image', url: '/api/agent/file?path=e%20%282%29.png&raw=1' });
    // The chip's own token id, as a real save writes it (its text's token is matched by it).
    const chips = keptChips([c]);
    expect(chips[0].tid).toBe(refTokenId(c));
    const map = serverDrafts.coerceDraftMap({ [U]: { text: tok(c), quote: null, chips, savedAt: 1 } })!;
    expect(map[U].chips[0]).toMatchObject({ kind: 'card', cardKind: 'image', url: c.url, text: '@card:img-1 “Ekran”', inline: true });
    const back = restoreDraftBody(coerceDraft(map[U])!);
    expect(composeOutgoing(back.text, back.attachments, null, q, { superView: true }).message).toBe('@card:img-1 “Ekran”');
    const evil = serverDrafts.coerceDraftMap({ [U]: { text: 'x', quote: null, chips: [{ ...chips[0], url: 'https://evil.example/a.png' }], savedAt: 1 } })!;
    expect(evil[U].chips[0].url).toBeUndefined();
  });
});

describe('the composer reads a card chip as the words it sends (Composer.commit)', () => {
  const peers = [{ vault: 'acme-payments', agent: 'peer-acme-payments', whatItIs: '' }] as Parameters<typeof addressedPeer>[1];
  const wordsOf = (draft: string, staged: Attachment[]) => stripTokens(expandCardChips(draft, staged).text);

  it('a card before @peer keeps the message the Super\'s, as the raw words did', () => {
    const c = card('c-1', 'T');
    const words = wordsOf(`${tok(c)} @acme-payments check this`, [c]);
    expect(words.startsWith('@card:c-1 “T”')).toBe(true);
    expect(addressedPeer(words, peers)).toBeNull();
    expect(addressedPeer(stripTokens(`${tok(c)} @acme-payments check this`), peers)).not.toBeNull();
  });

  it('a slash command\'s card token leaves the box with it; other chips stay', () => {
    const c = card('c-1', 'T');
    const about: Attachment = { id: nextAttachmentId(), kind: 'about', name: 'n', text: '[About agenda line note=n1]\nline: "x"' };
    const draft = `/skill ${tok(c)} ${tok(about)}`;
    const cardIds = new Set([c].map((a) => refTokenId(a)));
    const left = tokensOnly(draft, (s) => !cardIds.has(s.id));
    expect(parseRefTokens(left).map((t) => t.id)).toEqual([refTokenId(about)]);
  });

  it('commit reads the expanded words and drops card tokens on a slash send (source)', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/chat/Composer.tsx'), 'utf-8');
    expect(src).toMatch(/const wire = expandCardChips\(text, staged\)\.text;/);
    expect(src).toMatch(/const words = superView \|\| parseRefTokens\(wire\)\.length \? stripTokens\(wire\) : wire;/);
    expect(src).toMatch(/const left = slash \? tokensOnly\(text, \(s\) => !cardIds\.has\(s\.id\)\)/);
  });

  it('a picture card\'s URL escapes ( ) \' so a kept draft keeps it', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf-8');
    expect(src).toMatch(/\.replace\(\/\[\(\)'\]\/g/);
    expect(CARD_PICTURE_URL_RE.test('/api/agent/file?path=a%20%282%29.png&raw=1')).toBe(true);
    expect(CARD_PICTURE_URL_RE.test('/api/agent/file?path=a (2).png')).toBe(false);
  });
});
