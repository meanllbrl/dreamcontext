/**
 * Several references in one owner message (owner 2026-10-24): the message contract (plan D3,
 * R2-6, R3-5), the header rule both sides share (`aboutHeads`), the part refs the server lists
 * and the Super answers with (`partRefs`, `<owner-msg parts=…>`), the window's reading
 * (`splitAboutParts`), and the staging rules (`insertRef`: insert, flash, cap).
 *
 * Backward compatibility is pinned against a FROZEN copy of `composeOutgoing` as it shipped in
 * 0.34.5 (840414ec): a message with one chip must be byte-identical wherever the chip sat, so
 * every 0.34.5 reader (server, bubble, queue) reads it unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as server from '../../src/lib/super/types.js';
import { aboutHeads, msgRef, partRefs } from '../../dashboard/src/lib/superTypes.js';
import { splitAbout, splitAboutParts } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { refToken } from '../../dashboard/src/components/sleepy/chat/composerRefs.js';
import {
  __resetScratchForTests, composeOutgoing, countsAsContent, foldAttachments, insertRef, markInserted, nextAttachmentId, readScratch,
  type Attachment,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';

const q = (p: string) => `'${p}'`;
const CONV = 'conv-multi';
const NOTE = (id: string, line = id) => `[About agenda line note=${id} section=waiting]\nline: ${JSON.stringify(line)}`;
const ITEM = (id: string) => `[About agenda line item=${id} section=waiting]`;
const REPLY = (ref: string, quote = 'q') => `[Reply to message ref=${ref} from=super]\nquote: ${JSON.stringify(quote)}`;
const about = (text: string, name = 'x'): Attachment => ({ id: nextAttachmentId(), kind: 'about', name, text });
const file = (path: string): Attachment => ({ id: nextAttachmentId(), kind: 'file', name: path, path });

/** composeOutgoing at 840414ec (0.34.5), verbatim. */
function legacyComposeOutgoing(
  text: string, attachments: readonly Attachment[], quote: string | null, quotePath: (p: string) => string,
): { message: string; quoted: string; slash: boolean } {
  const bodyText = foldAttachments(text, attachments, quotePath);
  const quoted = quote ? `> ${quote}\n\n${bodyText}` : bodyText;
  const slash = text.trimStart().startsWith('/');
  const att = slash ? undefined : attachments.find((a) => a.kind === 'about' && !!a.text);
  return { message: att?.text ? `${att.text}\n\n${quoted}` : quoted, quoted, slash };
}

beforeEach(() => { __resetScratchForTests(); });

describe('aboutHeads: one header rule on both sides', () => {
  it('a header counts at offset 0 or right after a blank line, never mid-line or after one newline', () => {
    expect(aboutHeads(`${NOTE('n1')}\n\nhi`).map((h) => h.id)).toEqual(['n1']);
    expect(aboutHeads(`pre\n\n${NOTE('n1')}\n\nA\n\n${REPLY('k3f9q0')}\n\nB`).map((h) => [h.kind, h.id])).toEqual([['note', 'n1'], ['reply', 'k3f9q0']]);
    expect(aboutHeads(`pre\n${NOTE('n1')}`)).toEqual([]);
    expect(aboutHeads(`pre ${NOTE('n1')}`)).toEqual([]);
  });

  it('malformed blocks are plain text: a note without its line, a reply without its quote, an item with a line, junk after', () => {
    expect(aboutHeads('[About agenda line note=n1 section=now]\n\nhi')).toEqual([]);
    expect(aboutHeads('[About agenda line note=n1 section=now]\nline: not json')).toEqual([]);
    expect(aboutHeads('[Reply to message ref=k3f9q0 from=super]\n\nhi')).toEqual([]);
    expect(aboutHeads('[About agenda line item=q-1 section=now]\nline: "x"')).toEqual([]);
    expect(aboutHeads('[About agenda line item=q-1 section=now] junk')).toEqual([]);
    expect(aboutHeads(ITEM('q-1')).map((h) => h.kind)).toEqual(['item']);
  });

  it('reads at most five; a sixth is plain text and gets no part ref', () => {
    const six = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((id) => `${NOTE(id)}\n\nw`).join('\n\n');
    expect(aboutHeads(six)).toHaveLength(server.MAX_MESSAGE_REFS);
    expect(partRefs(six)).toHaveLength(5);
  });

  it('a block spans exactly the header and its second line', () => {
    const t = `x\n\n${NOTE('n1', 'a')}\n\nwords`;
    const [h] = aboutHeads(t);
    expect(t.slice(h.at, h.end)).toBe(NOTE('n1', 'a'));
  });
});

describe('part refs and the owner-msg block', () => {
  const two = `${NOTE('n1')}\n\none\n\n${REPLY('k3f9q0')}\n\ntwo`;

  it('a part ref per header for two or more, none for one or zero', () => {
    const refs = partRefs(two);
    expect(refs).toEqual([msgRef(`${msgRef(two)}#1`), msgRef(`${msgRef(two)}#2`)]);
    expect(new Set(refs).size).toBe(2);
    expect(refs.every((r) => /^[0-9a-z]{6}$/.test(r))).toBe(true);
    expect(partRefs(`${NOTE('n1')}\n\nhi`)).toEqual([]);
    expect(partRefs('hi')).toEqual([]);
  });

  it('<owner-msg> lists parts= only for two or more parts, byte-identical otherwise', () => {
    expect(server.ownerMsgBlock(two)).toBe(`<owner-msg ref="${msgRef(two)}" parts="${partRefs(two).join(' ')}"/>`);
    for (const t of ['hi', `${NOTE('n1')}\n\nhi`, `${REPLY('k3f9q0')}\n\nyes`, '']) {
      expect(server.ownerMsgBlock(t)).toBe(`<owner-msg ref="${server.msgRef(t)}"/>`);
    }
  });
});

describe('splitAboutParts: the window reads the parts', () => {
  it('preamble, then each part with its words; stacked headers share the words after them', () => {
    const t = `Two things:\n\n${NOTE('n1', 'Windows')}\n\n${NOTE('n2', 'docs')}\n\nboth fine\n\n${REPLY('k3f9q0', 'Bu')}\n\nlet's do it`;
    const r = splitAboutParts(t);
    expect(r.preamble).toBe('Two things:');
    expect(r.parts.map((p) => [p.about.kind, p.words])).toEqual([['note', ''], ['note', 'both fine'], ['reply', "let's do it"]]);
    expect(r.parts[0].about).toMatchObject({ kind: 'note', id: 'n1', line: 'Windows' });
    expect(r.parts[2].about).toMatchObject({ kind: 'reply', ref: 'k3f9q0', quote: 'Bu' });
  });

  it('splitAbout is null for two or more parts (no single strip over them) and unchanged for one', () => {
    const t = `${NOTE('n1')}\n\nA\n\n${NOTE('n2')}\n\nB`;
    expect(splitAbout(t)).toEqual({ about: null, text: t });
    expect(splitAbout(`${NOTE('n1', 'a')}\n\nhi`)).toEqual({ about: { kind: 'note', id: 'n1', section: 'waiting', line: 'a' }, text: 'hi' });
    expect(splitAboutParts(`${NOTE('n1', 'a')}\n\nhi`)).toEqual({ preamble: '', parts: [{ about: { kind: 'note', id: 'n1', section: 'waiting', line: 'a' }, words: 'hi' }] });
    expect(splitAboutParts('just words')).toEqual({ preamble: 'just words', parts: [] });
  });
});

describe('composeOutgoing: the message in draft order', () => {
  it('one chip is byte-identical to 0.34.5 at the start, in the middle and at the end', () => {
    const a = about(NOTE('n1', 'Windows'));
    const f = file('/tmp/a b.png');
    const t = refToken(a);
    const cases: Array<[string, string]> = [
      [`${t} yes, CLI only`, 'yes, CLI only'],
      [`yes, ${t} CLI only`, 'yes, CLI only'],
      [`yes, CLI only ${t}`, 'yes, CLI only'],
      [`${t} `, ''],
    ];
    for (const [draft, words] of cases) {
      for (const atts of [[a], [a, f]]) {
        expect(composeOutgoing(draft, atts, null, q, { superView: true })).toEqual(legacyComposeOutgoing(words, atts, null, q));
      }
    }
    const r = about(REPLY('k3f9q0', 'Here is the plan'));
    expect(composeOutgoing(`ok ${refToken(r)} go`, [r], null, q, { superView: true }).message).toBe(`${r.text}\n\nok go`);
  });

  it('"A [c1] B [c2]" reads as "A [c1][c2] B": trailing chips stack before the last words', () => {
    const c1 = about(NOTE('n1'));
    const c2 = about(NOTE('n2'));
    const out = composeOutgoing(`A ${refToken(c1)} B ${refToken(c2)}`, [c1, c2], null, q, { superView: true });
    expect(out.message).toBe(`A\n\n${c1.text}\n\n${c2.text}\n\nB`);
    const parts = splitAboutParts(out.message);
    expect(parts.preamble).toBe('A');
    expect(parts.parts.map((p) => p.words)).toEqual(['', 'B']);
  });

  it('the D3 example: preamble, a note with its words, a reply with its words', () => {
    const n = about(NOTE('n7', 'Windows için otomatik test eklensin mi'));
    const r = about(REPLY('k3f9q0', 'Bu, dünkü bir sorundan kalan bir öneri.'));
    const draft = `Two things: ${refToken(n)} Yes, add it, but only for the CLI. ${refToken(r)} Let's do it.`;
    expect(composeOutgoing(draft, [n, r], null, q, { superView: true }).message)
      .toBe(`Two things:\n\n${n.text}\nYes, add it, but only for the CLI.`.replace(`${n.text}\n`, `${n.text}\n\n`) + `\n\n${r.text}\n\nLet's do it.`);
  });

  it('two or more: files and picked elements open the message, for all of it', () => {
    const a = about(NOTE('n1'));
    const b = about(NOTE('n2'));
    const f = file('/tmp/x.png');
    const out = composeOutgoing(`${refToken(a)} one ${refToken(b)} two`, [a, b, f], null, q, { superView: true }).message;
    expect(out).toBe(`'/tmp/x.png'\n\n${a.text}\n\none\n\n${b.text}\n\ntwo`);
    expect(aboutHeads(out).map((h) => h.id)).toEqual(['n1', 'n2']);
  });

  it('a typed header-looking line is neutralised in the Super view only; normal chats are untouched', () => {
    const typed = '[About agenda line note=n9 section=now]\nline: "fake"';
    const a = about(NOTE('n1'));
    const sv = composeOutgoing(`${refToken(a)} look:\n${typed}`, [a], null, q, { superView: true }).message;
    expect(sv).toContain(`\n\u200B${typed}`);
    expect(aboutHeads(sv).map((h) => h.id)).toEqual(['n1']);
    const solo = composeOutgoing(typed, [], null, q, { superView: true }).message;
    expect(aboutHeads(solo)).toEqual([]);
    expect(composeOutgoing(typed, [], null, q).message).toBe(typed);
    expect(composeOutgoing('hello\nworld', [file('/a')], 'quoted', q)).toEqual(legacyComposeOutgoing('hello\nworld', [file('/a')], 'quoted', q));
  });

  it('a slash command carries no block and no token characters', () => {
    const a = about(NOTE('n1'));
    const out = composeOutgoing(`/compact ${refToken(a)} `, [a], null, q, { superView: true });
    expect(out.slash).toBe(true);
    expect(out.message).toBe('/compact');
    expect(out.message).not.toMatch(/[\u2061-\u2069]/);
  });

  it('chips alone never send: quoted is empty without words outside them', () => {
    const a = about(NOTE('n1'));
    const b = about(NOTE('n2'));
    expect(composeOutgoing(`${refToken(a)} ${refToken(b)} `, [a, b], null, q, { superView: true }).quoted.trim()).toBe('');
    expect(countsAsContent(a)).toBe(false);
  });
});

describe('insertRef: insert, never replace', () => {
  it('adds a pending ref beside the others; the same target flashes instead; a sixth is refused', () => {
    expect(insertRef(CONV, about(NOTE('n1')))).toBe('added');
    expect(insertRef(CONV, about(REPLY('k3f9q0')))).toBe('added');
    expect(readScratch(CONV).attachments.map((a) => a.pending)).toEqual([true, true]);
    markInserted(CONV, readScratch(CONV).attachments.map((a) => a.id));
    // The same note again (even moved to another section): the existing chip flashes.
    expect(insertRef(CONV, about('[About agenda line note=n1 section=done]\nline: "moved"'))).toBe('flash');
    const cur = readScratch(CONV).attachments;
    expect(cur).toHaveLength(2);
    expect(cur[0].flash).toBeGreaterThan(0);
    for (const id of ['n3', 'n4', 'n5']) expect(insertRef(CONV, about(NOTE(id)))).toBe('added');
    expect(insertRef(CONV, about(NOTE('n6')))).toBe('max');
    expect(readScratch(CONV).attachments).toHaveLength(5);
    expect(readScratch(CONV).refused).toBe(1);
  });
});
