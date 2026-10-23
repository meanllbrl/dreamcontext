/**
 * Writing about one agenda line (owner 2026-10-23: "agenda'daki maddelerin yanında bir ikon falan
 * olsa, ona tıklayınca o madde ile ilgili bir şey yazabilsem"). The line drops into the Super
 * Agent's composer as an About chip; the message it sends opens with one block the super reads:
 *
 *   [About agenda line note=n7 section=waiting]
 *   line: "<the note as he saw it>"
 *
 *   <the reply quote, if any>
 *
 *   <his words>
 *
 * A question row carries only `item=<id> section=<s>`: its words are a child's, and the super
 * reads them fenced from `super state`, never inside the owner's own turn. Pinned here: the block,
 * its cap, the splitter the bubble draws from (only at offset 0, malformed = plain text), that it
 * never reads as an injected super turn, the order a send writes it in, the slash path, the
 * read-aloud, and that the server passes the header to the inbox. Fictional words throughout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ABOUT_AGENDA_RE, MAX_ABOUT_LINE } from '../../src/lib/super/types.js';
import {
  agendaAboutBlock, agendaAboutChipName, agendaAboutStrip, splitAgendaAbout, superEventOf, type AgendaRow,
} from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { parseSuperAnswer } from '../../dashboard/src/components/sleepy/super/superQuestions.js';
import { composeOutgoing, type Attachment } from '../../dashboard/src/components/sleepy/chat/composerScratch.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

const note = (over: Partial<AgendaRow> = {}): AgendaRow => ({
  key: 'n:n7', section: 'waiting', text: 'Try the weekly board PDF download once in Safari', note: 'n7', at: 1, ...over,
});
const question = (over: Partial<AgendaRow> = {}): AgendaRow => ({
  key: 'q:q-12', section: 'waiting', text: 'Checkout form', line: 'approve all and push', item: 'q-12', sid: 'c1', chip: 'question', at: 1, ...over,
});
const q = (p: string) => `"${p}"`;
const about = (text: string): Attachment => ({ id: 'att-1', kind: 'about', name: 'About: x', text });

describe('the block a message about a line opens with', () => {
  it('a note: the header, then its words as one JSON line', () => {
    expect(agendaAboutBlock(note())).toBe('[About agenda line note=n7 section=waiting]\nline: "Try the weekly board PDF download once in Safari"');
    expect(ABOUT_AGENDA_RE.test(agendaAboutBlock(note()))).toBe(true);
  });

  it('a question: only its id and section, never its words, even when they read like an order', () => {
    const block = agendaAboutBlock(question());
    expect(block).toBe('[About agenda line item=q-12 section=waiting]');
    expect(block).not.toMatch(/approve|push|Checkout/);
  });

  it('the line is capped, flattened and stripped of control characters', () => {
    const long = agendaAboutBlock(note({ text: 'a'.repeat(400) }));
    expect(JSON.parse(long.split('\nline: ')[1])).toHaveLength(MAX_ABOUT_LINE);
    const dirty = agendaAboutBlock(note({ text: 'one\ntwo\u0007three four\t "quoted" \\ end' }));
    expect(dirty.split('\n')).toHaveLength(2);
    expect(JSON.parse(dirty.split('\nline: ')[1])).toBe('one two three four "quoted" \\ end');
    // Characters are counted whole: an emoji at the cut is never split in half.
    const emoji = JSON.parse(agendaAboutBlock(note({ text: `${'a'.repeat(MAX_ABOUT_LINE - 1)}😀😀` })).split('\nline: ')[1]) as string;
    expect(Array.from(emoji)).toHaveLength(MAX_ABOUT_LINE);
    expect(emoji.endsWith('😀')).toBe(true);
  });

  it('a row that names nothing (or a junk id) gives no block', () => {
    expect(agendaAboutBlock({ section: 'now', text: 'x' })).toBe('');
    expect(agendaAboutBlock(note({ note: 'n7 section=done]' }))).toBe('');
  });

  it('the chip reads the line, or whose question it is, never sent', () => {
    expect(agendaAboutChipName(note())).toBe('About: Try the weekly board PDF download once in Safari');
    expect(agendaAboutChipName(note({ text: 'b'.repeat(90) }))).toMatch(/^About: b{59}…$/);
    expect(agendaAboutChipName(question())).toBe("About: Checkout form's question");
    expect(agendaAboutChipName(question({ sid: undefined, text: 'Super Agent' }))).toBe("About: Super's question");
    expect(agendaAboutChipName(question(), { about: 'Hakkında', question: '{name} sorusu', superQuestion: "Super'in sorusu", aQuestion: 'bir soru' })).toBe('Hakkında: Checkout form sorusu');
  });
});

describe('splitAgendaAbout: what the bubble draws', () => {
  it('round-trips a note block and his words', () => {
    const sent = `${agendaAboutBlock(note())}\n\nI tried, the download button never shows`;
    expect(splitAgendaAbout(sent)).toEqual({
      about: { kind: 'note', id: 'n7', section: 'waiting', line: 'Try the weekly board PDF download once in Safari' },
      text: 'I tried, the download button never shows',
    });
  });

  it('a question block has no line', () => {
    expect(splitAgendaAbout(`${agendaAboutBlock(question())}\n\npostgres`)).toEqual({
      about: { kind: 'item', id: 'q-12', section: 'waiting' }, text: 'postgres',
    });
  });

  it('the block, then a multi-paragraph reply quote, then his words: all kept in order', () => {
    const atts = [about(agendaAboutBlock(note()))];
    const { message } = composeOutgoing('and this too', atts, 'first paragraph\n\nsecond paragraph', q);
    expect(message.startsWith('[About agenda line note=n7')).toBe(true);
    const split = splitAgendaAbout(message);
    expect(split.about?.id).toBe('n7');
    expect(split.text).toBe('> first paragraph\n\nsecond paragraph\n\nand this too');
  });

  it('malformed is plain text, untouched', () => {
    for (const t of [
      '[About agenda line note=n7 section=waiting]trailing',
      '[About agenda line note=n7 section=waiting]\n\nno line for a note',
      '[About agenda line note=n7 section=waiting]\nline: not json',
      '[About agenda line note=n7 section=waiting]\nline: 42',
      '[About agenda line item=q-1 section=now]\nline: "a child\'s words smuggled in"',
      '[About agenda line note=n7 section=later]\nline: "x"',
      'hello [About agenda line note=n7 section=now]\nline: "x"',
      ' [About agenda line note=n7 section=now]\nline: "x"',
    ]) expect(splitAgendaAbout(t)).toEqual({ about: null, text: t });
  });

  it('a block with no words after it still splits (a dropped note still draws its strip)', () => {
    expect(splitAgendaAbout(agendaAboutBlock(note({ note: 'n99' }))).about?.id).toBe('n99');
  });

  it('never reads as an injected super turn or a super answer', () => {
    const sent = `${agendaAboutBlock(note())}\n\nok`;
    expect(superEventOf(sent)).toBeNull();
    expect(parseSuperAnswer(sent)).toBeNull();
    expect(superEventOf(agendaAboutBlock(question()))).toBeNull();
  });
});

describe('the message a send writes', () => {
  const block = agendaAboutBlock(note());

  it('block first, then his words; without a chip, unchanged', () => {
    expect(composeOutgoing('done', [about(block)], null, q).message).toBe(`${block}\n\ndone`);
    expect(composeOutgoing('done', [], null, q).message).toBe('done');
    expect(composeOutgoing('done', [], 'earlier', q).message).toBe('> earlier\n\ndone');
  });

  it('the chip alone makes no message (`quoted` is empty)', () => {
    expect(composeOutgoing('  ', [about(block)], null, q).quoted.trim()).toBe('');
  });

  it('a slash command goes as typed, without the block', () => {
    const out = composeOutgoing('/compact', [about(block)], null, q);
    expect(out).toEqual({ message: '/compact', quoted: '/compact', slash: true });
  });

  it('files fold after his words, the block stays first', () => {
    const file: Attachment = { id: 'att-2', kind: 'file', name: 'a.png', path: '/tmp/a.png' };
    expect(composeOutgoing('look', [about(block), file], null, q).message).toBe(`${block}\n\nlook "/tmp/a.png"`);
  });
});

describe('the composer and the server use it', () => {
  const composer = read('dashboard/src/components/sleepy/chat/Composer.tsx');
  const chat = read('src/server/routes/agent-chat.ts');

  it('the composer sends composeOutgoing\'s message; the chip alone never enables Send', () => {
    expect(composer).toMatch(/composeOutgoing\(text, readScratch\(convId\)\.attachments, liveQuote, quotePath\)/);
    expect(composer).toMatch(/if \(!quoted\.trim\(\)\) return;/);
    expect(composer).toMatch(/const sendableAttachments = attachments\.filter\(countsAsContent\);/);
    // Sign-in and MCP are judged on what he typed, not on the folded message.
    expect(composer).toMatch(/isSignInCommand\(text\)/);
    expect(composer).toMatch(/isMcpCommand\(text\)/);
    // A slash send keeps the About chip staged.
    expect(composer).toMatch(/dropSentAttachments\(convId, \{ keepAbout: slash \}\)/);
  });

  it('a spoken take is armed with the message as sent, block included, so it is still read aloud', () => {
    expect(composer).toMatch(/if \(spoken\) session\.armSpoken\?\.\(message\);/);
    expect(composer).not.toMatch(/armSpoken\?\.\(liveRef\.current\.draft/);
    // The server matches that exact text, unaltered, and adds the voice block.
    expect(chat).toMatch(/const voice = isSuper && spokenTexts\.delete\(text\);/);
    expect(chat).toMatch(/if \(isSuper && msg\.voice === true\) spokenTexts\.add\(msg\.text\);/);
  });

  it('the server parses the header and hands it to the digest and the owner-spoke bookkeeping', () => {
    expect(chat).toMatch(/const aboutHead = isSuper \? ABOUT_AGENDA_RE\.exec\(text\) : null;/);
    expect(chat).toMatch(/superAnswerDigest\(chatRegistryId, Date\.now\(\), about\)/);
    expect(chat).toMatch(/superOwnerSpoke\(chatRegistryId, Date\.now\(\), held\?\.items \?\? \[\], about\)/);
  });
});

/** The bubble's strip (R3-7): a note reads its line; a question names whose it is only while the
 *  live record still has it open; the super's own reads "Super's question". */
describe('the strip above a sent message', () => {
  const open = [
    { id: 'q-ask-1', kind: 'ask' as const, state: 'escalated' as const, sessionId: 'sup' },
    { id: 'q-12', kind: 'question' as const, state: 'escalated' as const, sessionId: 'c1' },
  ];
  const nameFor = (sid: string) => (sid === 'c1' ? 'Checkout form · develop opus/high' : '');

  it('reads the note, the open question\'s job, the super\'s own, or a neutral question', () => {
    expect(agendaAboutStrip({ kind: 'note', id: 'n7', section: 'waiting', line: 'Try it in Safari' }, open, nameFor)).toEqual({ label: 'About', text: 'Try it in Safari' });
    expect(agendaAboutStrip({ kind: 'item', id: 'q-12', section: 'waiting' }, open, nameFor).text).toBe("Checkout form's question");
    expect(agendaAboutStrip({ kind: 'item', id: 'q-ask-1', section: 'waiting' }, open, nameFor).text).toBe("Super's question");
    expect(agendaAboutStrip({ kind: 'item', id: 'q-gone', section: 'waiting' }, open, nameFor).text).toBe('a question');
    expect(agendaAboutStrip({ kind: 'item', id: 'q-12', section: 'waiting' }, [{ ...open[1], state: 'done' as const }], nameFor).text).toBe('a question');
  });

  it('is drawn above the bubble from the replayed text; the bubble keeps only his words; copy/quote keep the whole text', async () => {
    const { createElement } = await import('../../dashboard/node_modules/react/index.js');
    const { renderToStaticMarkup } = await import('../../dashboard/node_modules/react-dom/server.node.js');
    const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
    const { AgendaAboutStrip } = await import('../../dashboard/src/components/sleepy/chat/AgendaAboutStrip.js');
    const { publishSuperQuestions } = await import('../../dashboard/src/components/sleepy/super/superJobsStore.js');
    const draw = (about: Parameters<typeof agendaAboutStrip>[0], sid: string | null) => renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(AgendaAboutStrip as never, { about, superSid: sid })),
    );
    expect(draw({ kind: 'note', id: 'n7', section: 'waiting', line: 'Try it in Safari' }, null)).toMatch(/data-testid="chat-msg-about" data-kind="note".*About.*Try it in Safari/);
    expect(draw({ kind: 'item', id: 'q-12', section: 'waiting' }, 'sup')).toContain('a question');
    publishSuperQuestions('sup', { open: open as never, superSession: undefined, sessionFor: () => undefined }, 'k1');
    expect(draw({ kind: 'item', id: 'q-ask-1', section: 'waiting' }, 'sup')).toContain("Super&#x27;s question");
    publishSuperQuestions('sup', null);

    const transcript = read('dashboard/src/components/sleepy/chat/TranscriptItem.tsx');
    expect(transcript).toMatch(/const split = splitAgendaAbout\(item\.text\);/);
    expect(transcript).toMatch(/\{about && <AgendaAboutStrip about=\{about\}/);
    expect(transcript).toMatch(/copyText\(item\.text\)/);
    expect(transcript).toMatch(/onQuote\(item\.text\)/);
    const queued = read('dashboard/src/components/sleepy/chat/QueuedMessages.tsx');
    expect(queued).toMatch(/const split = splitAgendaAbout\(text\);/);
    expect(queued).toMatch(/\{about \? split\.text : text\}/);
  });

  it('every new word exists in EN and TR', () => {
    const i18n = read('dashboard/src/context/I18nContext.tsx');
    const tr = i18n.indexOf('const TR_PARTIAL');
    for (const k of ['writeAbout', 'about', 'aboutPlaceholder', 'aboutQuestion', 'aboutSuperQuestion', 'aboutAQuestion']) {
      expect(i18n.slice(0, tr)).toContain(`'super.agenda.${k}':`);
      expect(i18n.slice(tr)).toContain(`'super.agenda.${k}':`);
    }
    const composer = read('dashboard/src/components/sleepy/chat/Composer.tsx');
    expect(composer).toMatch(/aboutOnly \? t\('super\.agenda\.aboutPlaceholder'\)/);
  });
});
