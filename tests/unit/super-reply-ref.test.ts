/**
 * Which answer is to which message (owner 2026-10-23: "Super'e art arda 5 mesaj atınca hangi
 * cevabın hangi mesaja olduğu kayboluyor"; and a reply re-sent the Super's whole message). The
 * contract pinned here:
 *
 *  - a message's reference: `msgRef(text)`, six base-36 characters, one code on both sides;
 *  - every owner message reaches the super with `<owner-msg ref="…"/>` (the server's `<`-block);
 *  - his reply to one message opens with `[Reply to message ref=<6> from=super|owner]` and
 *    `quote: "<at most 100 characters>"`, never the whole message; it is an About chip in the
 *    composer and a strip on his bubble (`splitAbout`), and the server reads it as "about" that
 *    message, so the open question stays open.
 *
 * Fictional words throughout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as server from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import {
  agendaAboutBlock, replyAboutBlock, replyAboutChipName, splitAbout, splitAgendaAbout, superEventOf, type AgendaRow,
} from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { parseSuperAnswer } from '../../dashboard/src/components/sleepy/super/superQuestions.js';
import { composeOutgoing, type Attachment } from '../../dashboard/src/components/sleepy/chat/composerScratch.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');
const chip = (text: string): Attachment => ({ id: 'att-1', kind: 'about', name: 'Reply to Super: x', text });
const q = (p: string) => `"${p}"`;

describe('msgRef: one reference on both sides', () => {
  const inputs = ['', 'hi', '  hi \n', 'Fix the login page of Orbit', 'Ödev formları — çağrı', '😀 two emoji 😀', 'a'.repeat(5000)];

  it('six base-36 characters, the same on the server and in the window', () => {
    for (const t of inputs) {
      expect(server.msgRef(t)).toMatch(/^[0-9a-z]{6}$/);
      expect(client.msgRef(t)).toBe(server.msgRef(t));
    }
  });

  it('fixed vectors (a change here re-links every transcript already written)', () => {
    expect(server.msgRef('')).toBe(server.msgRef('   '));
    expect(server.msgRef('hi')).toBe(server.msgRef('  hi \n'));
    expect(['', 'hi', 'Fix the login page of Orbit'].map(server.msgRef)).toEqual(['ztntfp', 'sx4lga', 'cl6um2']);
  });

  it('different words, different references', () => {
    const refs = new Set(Array.from({ length: 500 }, (_, i) => server.msgRef(`message number ${i}`)));
    expect(refs.size).toBe(500);
  });

  it('the owner-msg block carries the reference and starts with `<` (the replay drops it)', () => {
    expect(server.ownerMsgBlock('one')).toBe(`<owner-msg ref="${server.msgRef('one')}"/>`);
    expect(server.ownerMsgBlock('one').startsWith('<')).toBe(true);
  });
});

describe('the reply block', () => {
  const answer = `Here is the plan for Orbit. ${'The checkout form gets a second step. '.repeat(55)}`;

  it('header, then at most 100 characters of the message, then his words', () => {
    expect(answer.length).toBeGreaterThan(2000);
    const block = replyAboutBlock(answer, 'super');
    expect(block.split('\n')[0]).toBe(`[Reply to message ref=${client.msgRef(answer)} from=super]`);
    const quote = JSON.parse(block.split('\nquote: ')[1]) as string;
    expect(Array.from(quote).length).toBeLessThanOrEqual(server.MAX_REPLY_QUOTE);
    expect(answer.startsWith(quote)).toBe(true);
    const sent = composeOutgoing('yes, do the second step', [chip(block)], null, q).message;
    expect(sent).toBe(`${block}\n\nyes, do the second step`);
    // The 2,000-character answer is never re-sent: at most 100 characters of it ride along.
    expect(sent.length).toBeLessThan(block.length + 30);
    expect(sent).not.toContain(answer.slice(0, 101));
    expect(server.REPLY_TO_RE.test(sent)).toBe(true);
  });

  it('control characters and line breaks flatten to one line; emoji are never cut in half', () => {
    const block = replyAboutBlock('one\ntwo\u0007three\t"quoted" \\ end', 'super');
    expect(JSON.parse(block.split('\nquote: ')[1])).toBe('one two three "quoted" \\ end');
    expect(block.split('\n')).toHaveLength(2);
    const emoji = JSON.parse(replyAboutBlock(`${'a'.repeat(99)}😀😀`, 'owner').split('\nquote: ')[1]) as string;
    expect(Array.from(emoji)).toHaveLength(100);
    expect(emoji.endsWith('😀')).toBe(true);
  });

  it('a reply to his own message hashes what he sent and quotes his own words', () => {
    const row: AgendaRow = { key: 'n:n7', section: 'waiting', text: 'Try it in Safari', note: 'n7', at: 1 };
    const sent = `${agendaAboutBlock(row)}\n\nthe button never shows`;
    const block = replyAboutBlock(sent, 'owner', splitAbout(sent).text);
    expect(block).toBe(`[Reply to message ref=${client.msgRef(sent)} from=owner]\nquote: "the button never shows"`);
  });

  it('round trip: the bubble draws only his words, the strip reads the quote', () => {
    const sent = `${replyAboutBlock(answer, 'super')}\n\nyes`;
    expect(splitAbout(sent)).toEqual({
      about: { kind: 'reply', ref: client.msgRef(answer), from: 'super', quote: Array.from(answer).slice(0, 100).join('').trim() },
      text: 'yes',
    });
    expect(splitAbout(replyAboutBlock('hello', 'owner'))).toEqual({ about: { kind: 'reply', ref: client.msgRef('hello'), from: 'owner', quote: 'hello' }, text: '' });
  });

  it('malformed: null, and the text untouched', () => {
    for (const t of [
      '[Reply to message ref=abc from=super]\nquote: "x"\n\nhi',
      '[Reply to message ref=abcdef from=someone]\nquote: "x"',
      '[Reply to message ref=abcdef from=super]\n\nhi',
      '[Reply to message ref=abcdef from=super]\nquote: x',
      '[Reply to message ref=abcdef from=super]\nquote: 12',
      '[Reply to message ref=abcdef from=super] junk\nquote: "x"',
      '[Reply to message ref=abcdef from=super]\nquote: "x" junk',
      'hi\n[Reply to message ref=abcdef from=super]\nquote: "x"',
    ]) expect(splitAbout(t)).toEqual({ about: null, text: t });
  });

  it('an agenda About still splits as before, and splitAgendaAbout never reads a reply', () => {
    const row: AgendaRow = { key: 'n:n7', section: 'waiting', text: 'Try it in Safari', note: 'n7', at: 1 };
    const sent = `${agendaAboutBlock(row)}\n\nok`;
    expect(splitAbout(sent)).toEqual(splitAgendaAbout(sent));
    const reply = `${replyAboutBlock('hello', 'super')}\n\nok`;
    expect(splitAgendaAbout(reply)).toEqual({ about: null, text: reply });
  });

  it('the chip name reads whose message and the quote, clipped', () => {
    expect(replyAboutChipName('Here is the plan', 'super')).toBe('Reply to Super: Here is the plan');
    expect(replyAboutChipName('b'.repeat(90), 'owner')).toMatch(/^Your message: b{59}…$/);
    expect(replyAboutChipName('x', 'super', { chipSuper: "Super'e yanıt", chipOwn: 'Kendi mesajına' })).toBe("Super'e yanıt: x");
  });

  it('never reads as an injected super turn, a super answer or an agenda About, and vice versa', () => {
    const reply = `${replyAboutBlock('hello', 'super')}\n\nok`;
    expect(superEventOf(reply)).toBeNull();
    expect(parseSuperAnswer(reply)).toBeNull();
    expect(server.ABOUT_AGENDA_RE.test(reply)).toBe(false);
    const row: AgendaRow = { key: 'n:n7', section: 'waiting', text: 'x', note: 'n7', at: 1 };
    expect(server.REPLY_TO_RE.test(agendaAboutBlock(row))).toBe(false);
    for (const p of server.SUPER_EVENT_PREFIXES) expect(server.REPLY_TO_RE.test(`${p} x`)).toBe(false);
  });

  it('the chip alone sends nothing; a slash command goes as typed', () => {
    const block = replyAboutBlock('hello', 'super');
    expect(composeOutgoing('  ', [chip(block)], null, q).quoted.trim()).toBe('');
    expect(composeOutgoing('/compact', [chip(block)], null, q)).toEqual({ message: '/compact', quoted: '/compact', slash: true });
  });
});

describe('the server', () => {
  const chat = read('src/server/routes/agent-chat.ts');

  it('every owner message to the super carries its reference block; a slash command does not', () => {
    expect(chat).toMatch(/if \(isSuper && !text\.startsWith\('\/'\)\) content\.push\(\{ type: 'text', text: ownerMsgBlock\(text\) \}\);/);
    // Only writeOwnerTurn writes it: the event turns and deliveries never carry one.
    expect(chat.split('ownerMsgBlock(').length - 1).toBe(1);
  });

  it('a reply is "about" its message: the digest and the owner-spoke bookkeeping keep the open ask', () => {
    // Every header of the message, a reply's included (`aboutHeads`, kind 'reply'), goes to both.
    expect(chat).toMatch(/const abouts = isSuper \? aboutHeads\(text\)\.map\(\(\{ kind, id \}\) => \(\{ kind, id \}\)\) : \[\];/);
    expect(server.aboutHeads('[Reply to message ref=k3f9q0 from=super]\nquote: "x"\n\nok').map((h) => [h.kind, h.id])).toEqual([['reply', 'k3f9q0']]);
  });
});
