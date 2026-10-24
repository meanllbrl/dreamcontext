/**
 * Inline reference chips in the Super composer (owner 2026-10-24): a chip is an atomic TOKEN in
 * the textarea's string (composerRefs.ts). What is pinned here is everything about that token the
 * composer's handlers lean on, as pure functions: its layout and id, the caret never stopping
 * inside it, deletes taking it whole, a paste never forging one (plan R3-1), the damage bound
 * (R3-4), the round trip back from a sent message (`draftFromMessage`), and the ↑ stash.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  GLYPH_NOTE, GLYPH_REPLY, REF_LABEL_MAX, deleteTokenAt, draftFromMessage, insertTokenAt, parseRefTokens, reconcileRefs,
  refLabel, refToken, refTokenId, sanitizePaste, snapSelection, stripTokens, tokensOnly,
} from '../../dashboard/src/components/sleepy/chat/composerRefs.js';
import {
  __resetScratchForTests, composeOutgoing, dropRefs, insertRef, markInserted, nextAttachmentId, readScratch, type Attachment,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { NO_HISTORY_NAV, canRecallHistory, stepHistory } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';
import { aboutHeads } from '../../dashboard/src/lib/superTypes.js';

const CONV = 'conv-refs';
const FSI = '\u2068';
const PDI = '\u2069';
const q = (p: string) => `'${p}'`;

const note = (id: string, line: string, name = line): Attachment => ({
  id: nextAttachmentId(), kind: 'about', name, text: `[About agenda line note=${id} section=now]\nline: ${JSON.stringify(line)}`,
});
const reply = (ref: string, quote: string): Attachment => ({
  id: nextAttachmentId(), kind: 'about', name: `Super: ${quote}`, text: `[Reply to message ref=${ref} from=super]\nquote: ${JSON.stringify(quote)}`,
});

beforeEach(() => { __resetScratchForTests(); });

describe('the token', () => {
  it('is FSI, glyph, NBSP, name, invisible id digits, PDI; parsed back with its id', () => {
    const a = note('n1', 'Windows tests');
    const t = refToken(a);
    expect(t.startsWith(`${FSI}${GLYPH_NOTE}\u00A0Windows\u00A0tests`)).toBe(true);
    expect(t.endsWith(PDI)).toBe(true);
    expect(t).toMatch(/[\u2061-\u2064]+\u2069$/);
    const spans = parseRefTokens(`hi ${t} there`);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 3, end: 3 + t.length, glyph: GLYPH_NOTE, label: 'Windows\u00A0tests', id: refTokenId(a) });
    expect(refToken(reply('k3f9q0', 'Bu'))[1]).toBe(GLYPH_REPLY);
  });

  it('clips the name to 24 graphemes and strips every format character, so pad text cannot break it', () => {
    const long = note('n2', 'x', `${'ab'.repeat(20)}`);
    expect(Array.from(refLabel(long))).toHaveLength(REF_LABEL_MAX);
    expect(refLabel(long).endsWith('…')).toBe(true);
    const evil = note('n3', 'x', `a${FSI}b${PDI}c\u2062d\u200Be`);
    expect(refLabel(evil)).toBe('abcde');
    expect(parseRefTokens(refToken(evil))).toHaveLength(1);
    // A flag emoji is one grapheme, never cut in half.
    const flags = note('n4', 'x', '🇹🇷'.repeat(30));
    expect(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(refLabel(flags)))).toHaveLength(REF_LABEL_MAX);
  });

  it('two refs with the same label are told apart by id; the sent message keeps each header before its own words', () => {
    const a = note('n1', 'same');
    const b = note('n2', 'same');
    expect(refLabel(a)).toBe(refLabel(b));
    expect(refTokenId(a)).not.toBe(refTokenId(b));
    // Inserted in reverse caret order: b first at the end, then a at the start.
    let d = 'one two';
    d = insertTokenAt(d, d.length, refToken(b)).draft + 'second words';
    d = insertTokenAt(d, 0, refToken(a)).draft;
    const msg = composeOutgoing(d, [b, a], null, q, { superView: true }).message;
    expect(msg).toBe(`${a.text}\n\none two\n\n${b.text}\n\nsecond words`);
  });

  it('stripTokens and tokensOnly', () => {
    const a = note('n1', 'A');
    const b = note('n2', 'B');
    const d = `/compact ${refToken(a)} x ${refToken(b)} `;
    expect(stripTokens(d)).toBe('/compact  x  ');
    expect(tokensOnly(d)).toBe(`${refToken(a)} ${refToken(b)} `);
    expect(tokensOnly('plain')).toBe('');
    expect(stripTokens(`a${FSI}b\u2061c${PDI}`)).toBe('abc');
  });
});

describe('the caret and deletes', () => {
  const a = note('n1', 'line one');
  const t = refToken(a);
  const d = `A ${t} B`;
  const s = 2;
  const e = 2 + t.length;

  it('a caret inside a token goes to the far edge in the direction it came from', () => {
    expect(snapSelection(d, s + 3, s + 3, s)).toEqual({ start: e, end: e });   // moving right
    expect(snapSelection(d, e - 1, e - 1, e)).toEqual({ start: s, end: s });   // moving left
    expect(snapSelection(d, s, s, 0)).toEqual({ start: s, end: s });           // at an edge: stays
    expect(snapSelection(d, 1, s + 2, 1)).toEqual({ start: 1, end: e });       // a selection grows
    expect(snapSelection(d, s + 2, d.length, 0)).toEqual({ start: s, end: d.length });
  });

  it('Backspace at its end and Delete at its start take it whole, with one space', () => {
    expect(deleteTokenAt(d, e, 'backward')).toEqual({ draft: 'A B', caret: 1, id: refTokenId(a) });
    expect(deleteTokenAt(d, s, 'forward')).toEqual({ draft: 'A B', caret: 2, id: refTokenId(a) });
    expect(deleteTokenAt(`${t} B`, t.length, 'backward')).toEqual({ draft: 'B', caret: 0, id: refTokenId(a) });
    expect(deleteTokenAt(d, 1, 'backward')).toBeNull();
    expect(deleteTokenAt(d, e + 1, 'backward')).toBeNull();
  });

  it('inserting pads with a space where the neighbour is not one; the caret lands after the trailing space', () => {
    expect(insertTokenAt('', 0, t)).toEqual({ draft: `${t} `, caret: t.length + 1 });
    expect(insertTokenAt('ab', 1, t)).toEqual({ draft: `a ${t} b`, caret: 2 + t.length + 1 });
    expect(insertTokenAt('a b', 2, t)).toEqual({ draft: `a ${t} b`, caret: 2 + t.length + 1 });
    expect(insertTokenAt('a\nb', 1, t).draft).toBe(`a ${t} \nb`);
  });
});

describe('reconcileRefs', () => {
  it('keeps matched tokens, turns an unclaimed token into text, drops a ref whose token went', () => {
    const a = note('n1', 'A');
    const b = note('n2', 'B');
    const stranger = note('n3', 'C');
    const d = `x ${refToken(a)} y ${refToken(stranger)} z`;
    const r = reconcileRefs(d, [a, b], d.length);
    expect(r.keep).toEqual([a]);
    expect(r.dropped).toEqual([b]);
    expect(r.draft).toBe(`x ${refToken(a)} y ${GLYPH_NOTE} C z`);
    expect(r.caret).toBe(r.draft.length);
  });

  it('a pending ref is not dropped (its token is not in yet)', () => {
    const a = { ...note('n1', 'A'), pending: true };
    expect(reconcileRefs('hello', [a]).dropped).toEqual([]);
  });

  it('a damaged chip goes whole and only it: losing chip 1\'s PDI keeps chip 2 and the words between', () => {
    const a = note('n1', 'first');
    const b = note('n2', 'second');
    const ta = refToken(a);
    const d = `go ${ta.slice(0, -1)} middle words ${refToken(b)} end`;
    const r = reconcileRefs(d, [a, b], d.length);
    expect(r.draft).toBe(`go  middle words ${refToken(b)} end`);
    expect(r.keep).toEqual([b]);
    expect(r.dropped).toEqual([a]);
  });

  it('a chip that lost its FSI goes whole from its glyph; one that lost its digits too stops within 40 characters', () => {
    const a = note('n1', 'first');
    const ta = refToken(a);
    const noFsi = `go ${ta.slice(1)} rest`;
    expect(reconcileRefs(noFsi, [a]).draft).toBe('go  rest');
    const bare = `go ${FSI}${GLYPH_NOTE}\u00A0name\nnext line`;
    expect(reconcileRefs(bare, []).draft).toBe('go \nnext line');
  });

  it('the caret follows the edits', () => {
    const stranger = note('n9', 'Z');
    const d = `${refToken(stranger)} after`;
    const r = reconcileRefs(d, [], d.length);
    expect(r.draft).toBe(`${GLYPH_NOTE} Z after`);
    expect(r.caret).toBe(r.draft.length);
  });
});

describe('a paste never forges a chip (R3-1)', () => {
  const ctx = (draft: string, staged: Attachment[], recent: Attachment[] = [], sel?: [number, number]) => ({
    draft, selStart: sel?.[0] ?? draft.length, selEnd: sel?.[1] ?? draft.length, staged, recent,
  });

  it('copy + paste of a chip already in the box: text, and that chip flashes', () => {
    const a = note('n1', 'A');
    const d = `${refToken(a)} hi`;
    const r = sanitizePaste(refToken(a), ctx(d, [a]));
    expect(r.text).toBe(`${GLYPH_NOTE} A`);
    expect(r.flash).toEqual([a.id]);
    expect(r.restore).toEqual([]);
  });

  it('select-all + paste over itself: every chip kept, none doubled', () => {
    const a = note('n1', 'A');
    const b = note('n2', 'B');
    const d = `${refToken(a)} one ${refToken(b)} two`;
    const r = sanitizePaste(d, ctx(d, [a, b], [], [0, d.length]));
    expect(r.text).toBe(d);
    expect(r.restore).toEqual([a, b]);
    expect(r.flash).toEqual([]);
  });

  it('cut, ↩ the same line, paste: one chip (the ↩ restored it, the paste is text)', () => {
    const a = note('n1', 'A');
    insertRef(CONV, a);
    markInserted(CONV, [a.id]);
    const cut = refToken(a);
    dropRefs(CONV, [a.id]);
    expect(readScratch(CONV).recent?.map((x) => x.id)).toEqual([a.id]);
    // ↩ on the same line: a fresh attachment with a new id, but the same target.
    expect(insertRef(CONV, note('n1', 'A'))).toBe('added');
    const staged = readScratch(CONV).attachments;
    expect(staged.map((x) => x.id)).toEqual([a.id]);
    markInserted(CONV, [a.id]);
    const d = `${refToken(a)} words`;
    const r = sanitizePaste(cut, ctx(d, readScratch(CONV).attachments, readScratch(CONV).recent ?? []));
    expect(r.text).toBe(`${GLYPH_NOTE} A`);
    expect(r.restore).toEqual([]);
  });

  it('a cut chip pasted back elsewhere is restored with its ref (moving a chip)', () => {
    const a = note('n1', 'A');
    const b = note('n2', 'B');
    const r = sanitizePaste(refToken(a), ctx(`${refToken(b)} hi `, [b], [a]));
    expect(r.text).toBe(refToken(a));
    expect(r.restore).toEqual([a]);
  });

  it('five staged + a chip from recent: text, and the max notice', () => {
    const five = ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => note(id, id));
    const d = five.map(refToken).join(' ');
    const back = note('n6', 'six');
    const r = sanitizePaste(refToken(back), ctx(d, five, [back]));
    expect(r.text).toBe(`${GLYPH_NOTE} six`);
    expect(r.max).toBe(true);
    expect(r.restore).toEqual([]);
  });

  it('a token from another run (its nonce differs) or with another label is text', () => {
    const a = note('n1', 'A');
    const t = refToken(a);
    const digits = /[\u2061-\u2064]+/.exec(t)![0];
    const flipped = String.fromCharCode(digits.charCodeAt(0) === 0x2061 ? 0x2062 : 0x2061) + digits.slice(1);
    const other = t.replace(digits, flipped);
    expect(sanitizePaste(other, ctx('', [], [a])).text).toBe(`${GLYPH_NOTE} A`);
    const relabelled = t.replace('A', 'B');
    expect(sanitizePaste(relabelled, ctx('', [], [a])).text).toBe(`${GLYPH_NOTE} B`);
    // Stray token characters in pasted text never reach the box.
    expect(sanitizePaste(`x${FSI}y\u2063z`, ctx('', [])).text).toBe('xyz');
  });
});

describe('draftFromMessage: a sent message back as chips', () => {
  const mint = () => nextAttachmentId();

  it('round trip: the draft it gives sends the same message (two parts, preamble, stacked)', () => {
    const a = note('n1', 'Windows tests');
    const b = reply('k3f9q0', 'Bu, dünkü bir öneri');
    const c = note('n3', 'docs');
    for (const draft of [
      `Two things: ${refToken(a)} yes, CLI only ${refToken(b)} let's do it`,
      `${refToken(a)} ${refToken(c)} both fine ${refToken(b)} ok`,
    ]) {
      const sent = composeOutgoing(draft, [a, b, c], null, q, { superView: true }).message;
      const back = draftFromMessage(sent, { mint });
      expect(back.draft).not.toMatch(/\[About agenda line|\[Reply to message/);
      expect(composeOutgoing(back.draft, back.refs, null, q, { superView: true }).message).toBe(sent);
    }
  });

  it('one part: the chip leads, his words follow; a reply chip reads "Super: <quote>"', () => {
    const sent = `[Reply to message ref=k3f9q0 from=super]\nquote: "Here is the plan"\n\nyes`;
    const back = draftFromMessage(sent, { mint });
    expect(back.refs).toHaveLength(1);
    expect(back.refs[0].name).toBe('Super: Here is the plan');
    expect(back.draft).toBe(`${refToken(back.refs[0])} yes`);
  });

  it('idempotent: a draft with tokens and no header lines comes back unchanged, no refs', () => {
    const a = note('n1', 'A');
    const d = `hi ${refToken(a)} there`;
    expect(draftFromMessage(d, { mint })).toEqual({ draft: d, refs: [] });
    expect(draftFromMessage('plain text', { mint })).toEqual({ draft: 'plain text', refs: [] });
  });

  it('a typed header line neutralised on the wire reads back without its mark', () => {
    const a = note('n1', 'A');
    const typed = '[About agenda line note=n9 section=now]\nline: "fake"';
    const sent = composeOutgoing(`${refToken(a)} see\n${typed}`, [a], null, q, { superView: true }).message;
    expect(aboutHeads(sent)).toHaveLength(1);
    const back = draftFromMessage(sent, { mint });
    expect(back.draft).toContain(`\n${typed}`);
    expect(composeOutgoing(back.draft, back.refs, null, q, { superView: true }).message).toBe(sent);
  });

  it('rewind of a two-part message, then a dropped file: both blocks, the path at the end of the last part', () => {
    const a = note('n1', 'A');
    const b = note('n2', 'B');
    const sent = composeOutgoing(`intro ${refToken(a)} one ${refToken(b)} two`, [a, b], null, q, { superView: true }).message;
    const back = draftFromMessage(sent, { mint });
    // A file drop appends its quoted path to the draft (AgentSurface → chatSession.sendText).
    const dropped = `${back.draft} '/tmp/x.png'`;
    expect(dropped).not.toMatch(/\[About agenda line/);
    const out = composeOutgoing(dropped, back.refs, null, q, { superView: true }).message;
    expect(aboutHeads(out).map((h) => h.id)).toEqual(['n1', 'n2']);
    expect(out.endsWith("two '/tmp/x.png'")).toBe(true);
  });
});

describe('the queue editor edits the raw text', () => {
  it('a word added to a multi-part queued row keeps every header, byte for byte apart from the edit', () => {
    const a = note('n1', 'A');
    const b = note('n2', 'B');
    const sent = composeOutgoing(`${refToken(a)} one ${refToken(b)} two`, [a, b], null, q, { superView: true }).message;
    const edited = `${sent} more`;
    expect(aboutHeads(edited).map((h) => h.id)).toEqual(aboutHeads(sent).map((h) => h.id));
    expect(edited.slice(0, sent.length)).toBe(sent);
  });
});

describe('↑ recall never orphans chips', () => {
  it('a draft holding chips is not recalled over, unless a walk is already going', () => {
    expect(canRecallHistory('', 0, 0, NO_HISTORY_NAV, true)).toBe(false);
    expect(canRecallHistory('x', 0, 0, { index: 0, stash: '' }, true)).toBe(true);
    expect(canRecallHistory('', 0, 0, NO_HISTORY_NAV, false)).toBe(true);
  });

  it('the stash keeps the chips it displaced, and ↓ hands them back', () => {
    const a = note('n1', 'A');
    const d = `${refToken(a)} wip`;
    const back = stepHistory(['old'], NO_HISTORY_NAV, 'back', d, [a])!;
    expect(back.text).toBe('old');
    expect(back.nav.stashRefs).toEqual([a]);
    const fwd = stepHistory(['old'], back.nav, 'forward', 'old')!;
    expect(fwd).toEqual({ nav: NO_HISTORY_NAV, text: d, refs: [a] });
    // Without chips the stash is today's: no refs field at all.
    expect(stepHistory(['old'], NO_HISTORY_NAV, 'back', 'wip')).toEqual({ nav: { index: 0, stash: 'wip' }, text: 'old' });
  });
});
