/**
 * The page a dock message was written from (owner 2026-10-25, super dock): a message sent from the
 * Super dock ends with ONE block, its whole last paragraph,
 *
 *   <his words>
 *
 *   [On page tasks view="Current Version" filters=1]
 *
 * so the About/Reply heads at the start still match on the server. Pinned here: the block and its
 * cleaning, the splitter (only the whole last paragraph is a block; anything else is his text),
 * the window mirror, the composer's order (About first, page last, a slash command neither), that
 * the chip survives a send and never counts as content, the page store, and the server's heads.
 * Fictional names throughout.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as server from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import {
  __resetScratchForTests, composeOutgoing, countsAsContent, dropSentAttachments, readScratch, setAbout, setPageContext,
  addAttachments, type Attachment,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { pageBlockOf, pageChipName, pageKeyOf, publishPage, publishPageDetail, readPageContext } from '../../dashboard/src/lib/pageContext.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

describe('the page block', () => {
  it('round-trips the four kinds and any other page', () => {
    const cases: [server.PageContextRef, string][] = [
      [{ page: 'tasks', view: 'Current Version', filters: 1 }, '[On page tasks view="Current Version" filters=1]'],
      [{ page: 'whiteboards', board: 'launch-plan' }, '[On page whiteboards board=launch-plan]'],
      [{ page: 'lab' }, '[On page lab]'],
      [{ page: 'lab', insight: 'weekly-active-users' }, '[On page lab insight=weekly-active-users]'],
      [{ page: 'knowledge' }, '[On page knowledge]'],
    ];
    for (const [ref, block] of cases) {
      expect(server.pageContextBlock(ref)).toBe(block);
      const back = server.splitPageContext(`Is this ready?\n\n${block}`);
      expect(back.text).toBe('Is this ready?');
      expect(back.page).toEqual(ref);
    }
  });

  it('cleans what it writes: a quoted name loses control characters, quotes and ], and is cut at 60', () => {
    expect(server.pageContextBlock({ page: 'tasks', view: 'Sprint "A"]\nnext' })).toBe('[On page tasks view="Sprint A next"]');
    const long = server.pageContextBlock({ page: 'tasks', view: 'x'.repeat(90) });
    expect(long).toBe(`[On page tasks view="${'x'.repeat(60)}"]`);
    expect(server.splitPageContext(`hi\n\n${long}`).page?.view).toHaveLength(60);
    // Zero filters, a slug that is not one, a page that is not an id: left out / nothing.
    expect(server.pageContextBlock({ page: 'tasks', view: 'All', filters: 0 })).toBe('[On page tasks view="All"]');
    expect(server.pageContextBlock({ page: 'whiteboards', board: '../etc' })).toBe('[On page whiteboards]');
    expect(server.pageContextBlock({ page: 'Tasks!' })).toBe('');
    expect(server.pageContextBlock(null)).toBe('');
  });

  it('is a block only as the WHOLE last paragraph; anything else is his text, untouched', () => {
    const not = [
      '[On page lab]',                                  // no paragraph before it
      'see\n[On page lab]',                             // one newline: not its own paragraph
      'see\n\n[On page lab] and more',                  // text after it
      'see\n\n[On page lab]\n\nthen this',              // not the last paragraph
      'see\n\n[On page lab insight=Bad Slug]',          // malformed
      'see\n\n[On page lab nonsense=1]',
    ];
    for (const t of not) expect(server.splitPageContext(t)).toEqual({ text: t, page: null });
  });

  it('the window mirrors the server exactly', () => {
    expect(String(client.PAGE_CONTEXT_RE)).toBe(String(server.PAGE_CONTEXT_RE));
    expect(client.MAX_PAGE_VIEW).toBe(server.MAX_PAGE_VIEW);
    const refs = [{ page: 'tasks', view: ' Ödev "x" ', filters: 3 }, { page: 'lab', insight: 'mrr' }, { page: 'whiteboards', board: 'q3' }, { page: 'nope!' }];
    for (const r of refs) expect(client.pageContextBlock(r)).toBe(server.pageContextBlock(r));
    for (const t of ['a\n\n[On page lab]', 'a\n\n[On page tasks view="V" filters=2]', 'plain', '\n\n[On page x-y]']) {
      expect(client.splitPageContext(t)).toEqual(server.splitPageContext(t));
    }
  });

  it('leaves the About and Reply heads at the start, so the server still matches them', () => {
    const about = '[About agenda line item=q-12 section=waiting]';
    const msg = `${about}\n\nyes, go\n\n[On page tasks view="Current Version" filters=1]`;
    expect(server.ABOUT_AGENDA_RE.exec(msg)?.[2]).toBe('q-12');
    const reply = '[Reply to message ref=k3f9q0 from=super]\nquote: "Shall I merge?"';
    expect(server.REPLY_TO_RE.exec(`${reply}\n\nnot yet\n\n[On page lab]`)?.[1]).toBe('k3f9q0');
    const chat = read('src/server/routes/agent-chat.ts');
    // The server reads every head with `aboutHeads` (several references per message); the page
    // block, a last paragraph of its own, never hides one.
    expect(chat).toMatch(/aboutHeads\(text\)/);
    expect(server.aboutHeads(msg).map((h) => h.id)).toEqual(['q-12']);
    // The briefing names the block (rev 13).
    expect(server.SUPER_BRIEF_REV).toBeGreaterThanOrEqual(13);
    expect(read('src/server/chat-modes.ts')).toContain('A message ending \\`[On page <page> …]\\` was written from the dock');
  });
});

describe('the composer', () => {
  beforeEach(() => __resetScratchForTests());
  const quote = (p: string) => `"${p}"`;
  const page: Attachment = { id: 'p1', kind: 'page', name: 'Tasks · Current Version', text: '[On page tasks view="Current Version" filters=1]' };
  const about: Attachment = { id: 'a1', kind: 'about', name: 'About: Ship it', text: '[About agenda line note=n7 section=waiting]\nline: "Ship it"' };

  it('writes About first, the page block last, and a slash command with neither', () => {
    expect(composeOutgoing('looks off', [page], null, quote).message).toBe(`looks off\n\n${page.text}`);
    expect(composeOutgoing('looks off', [about, page], null, quote).message).toBe(`${about.text}\n\nlooks off\n\n${page.text}`);
    expect(composeOutgoing('/compact', [about, page], null, quote).message).toBe('/compact');
    // A file chip still rides on his line, before the block.
    const file: Attachment = { id: 'f1', kind: 'file', name: 'a.png', path: '/tmp/a.png' };
    expect(composeOutgoing('see', [file, page], null, quote).message).toBe(`see "/tmp/a.png"\n\n${page.text}`);
    // Nothing typed: nothing to send, the block never makes a message alone.
    expect(composeOutgoing('', [page], null, quote).quoted).toBe('');
    expect(countsAsContent(page)).toBe(false);
    // The block it wrote is the one the bubble splits off.
    expect(server.splitPageContext(composeOutgoing('looks off', [about, page], null, quote).message).page?.view).toBe('Current Version');
  });

  it('a send keeps the page chip (the next message is from the same page); one chip per conversation, always last', () => {
    setPageContext('conv-1', page);
    addAttachments('conv-1', [{ id: 'f1', kind: 'file', name: 'a.png', path: '/tmp/a.png' }]);
    setAbout('conv-1', about);
    expect(readScratch('conv-1').attachments.map((a) => a.kind)).toEqual(['about', 'page', 'file']);
    dropSentAttachments('conv-1');
    expect(readScratch('conv-1').attachments.map((a) => a.kind)).toEqual(['page']);
    setPageContext('conv-1', { ...page, id: 'p2', name: 'Insights', text: '[On page lab]' });
    expect(readScratch('conv-1').attachments).toEqual([{ ...page, id: 'p2', name: 'Insights', text: '[On page lab]' }]);
    setPageContext('conv-1', null);
    expect(readScratch('conv-1').attachments).toEqual([]);
    // Another conversation never sees it.
    setPageContext('conv-1', page);
    expect(readScratch('conv-2').attachments).toEqual([]);
  });

  it('a queued and a steered message carry the block baked at commit; an @peer message carries none', () => {
    const composer = read('dashboard/src/components/sleepy/chat/Composer.tsx');
    expect(composer).toMatch(/const \{ message, quoted, slash \} = composeOutgoing\(text, readScratch\(convId\)\.attachments, liveQuote, quotePath, \{ superView \}\);/);
    expect(composer).toMatch(/if \(mode === 'queue'\) session\.enqueue\(message\);/);
    expect(composer).toMatch(/if \(!session\.steer\(message\)\) session\.enqueue\(message, \{ steerWhenPossible: true \}\);/);
    // The peer's body is cut from `quoted` (no page block), also when a picture chip opens it.
    expect(composer).toMatch(/: onPeerMessage \? addressedPeer\(quoted, peers\) : null;/);
    expect(composer).toMatch(/body: quoted\.replace\(/);
  });
});

describe('the page store (one per project instance)', () => {
  it('composes the Shell page with the page\'s own detail; a withdrawn detail and another page drop it', () => {
    const bus = new EventTarget();
    const other = new EventTarget();
    publishPage(bus, 'tasks');
    expect(readPageContext(bus)).toEqual({ page: 'tasks' });
    publishPageDetail(bus, 'tasks', { page: 'tasks', view: 'Current Version', filters: 1 });
    expect(pageBlockOf(readPageContext(bus))).toBe('[On page tasks view="Current Version" filters=1]');
    expect(readPageContext(other)).toBeNull();
    // A detail for a page that is not shown counts for nothing.
    publishPage(bus, 'lab');
    expect(readPageContext(bus)).toEqual({ page: 'lab' });
    publishPageDetail(bus, 'lab-board', { page: 'lab', insight: 'mrr' });
    expect(pageKeyOf(readPageContext(bus))).toBe('[On page lab insight=mrr]');
    publishPageDetail(bus, 'lab-board', null);
    expect(readPageContext(bus)).toEqual({ page: 'lab' });
    publishPage(bus, null);
    expect(readPageContext(bus)).toBeNull();
  });

  it('names the chip with the sidebar\'s page name, then the open item', () => {
    const label = (p: string) => ({ tasks: 'Görevler', whiteboards: 'Beyaz tahta', lab: 'Insights' } as Record<string, string>)[p] ?? '';
    expect(pageChipName({ page: 'tasks', view: 'Current Version', filters: 1 }, label)).toBe('Görevler · Current Version');
    expect(pageChipName({ page: 'whiteboards', board: 'launch-plan' }, label)).toBe('Beyaz tahta · launch-plan');
    expect(pageChipName({ page: 'lab' }, label)).toBe('Insights');
    expect(pageChipName({ page: 'core' }, label)).toBe('core');
  });

  it('every page that has a detail publishes it, withdrawn in its effect cleanup', () => {
    expect(read('dashboard/src/components/layout/Shell.tsx')).toMatch(/publishPage\(bus, activePage\);\s*return \(\) => publishPage\(bus, null\);/);
    expect(read('dashboard/src/components/tasks/KanbanBoard.tsx')).toMatch(/publishPageDetail\(bus, 'tasks', \{ page: 'tasks', view: viewName, filters: filterCount \}\);\s*return \(\) => publishPageDetail\(bus, 'tasks', null\);/);
    expect(read('dashboard/src/pages/WhiteboardsPage.tsx')).toMatch(/publishPageDetail\(bus, 'whiteboards', \{ page: 'whiteboards', board: openSlug \}\);/);
    expect(read('dashboard/src/pages/LabPage.tsx')).toMatch(/publishPageDetail\(bus, 'lab-route', \{ page: 'lab', insight: route\.slug \}\);/);
    expect(read('dashboard/src/components/lab/board/BoardPage.tsx')).toMatch(/publishPageDetail\(bus, 'lab-board', \{ page: 'lab', insight: openSlug \}\);/);
  });
});

describe('a whiteboard selection on the page block (board writing field, 2026-11-11)', () => {
  const sel = { n: 9, box: [120, -40, 860, 410] as [number, number, number, number], ids: ['rect-a', 'txt_b', 'Card-3'] };

  it('rides the block as one tail: true count, rounded box, ids; round-trips on both sides', () => {
    const ref: server.PageContextRef = { page: 'whiteboards', board: 'launch-plan', sel };
    const block = '[On page whiteboards board=launch-plan sel=9 box=120,-40,860,410 ids=rect-a,txt_b,Card-3]';
    expect(server.pageContextBlock(ref)).toBe(block);
    expect(client.pageContextBlock(ref)).toBe(block);
    for (const side of [server, client]) {
      const back = side.splitPageContext(`3 sunuma düşür\n\n${block}`);
      expect(back.text).toBe('3 sunuma düşür');
      expect(back.page).toEqual(ref);
    }
  });

  it('without a selection the block is byte-identical to before', () => {
    expect(server.pageContextBlock({ page: 'whiteboards', board: 'launch-plan' })).toBe('[On page whiteboards board=launch-plan]');
    expect(server.pageContextBlock({ page: 'whiteboards', board: 'launch-plan', sel: { n: 2, box: [0, 0, 1, 1], ids: [] } })).toBe('[On page whiteboards board=launch-plan]');
  });

  it('filters ids outside the charset, keeps at most 12, clamps n (never below the ids it names) and the box', () => {
    const ids = ['ok-1', 'bad id', '../x', ...Array.from({ length: 15 }, (_, i) => `e${i}`)];
    const tail = server.pageSelectionTail({ n: 123456, box: [1.6, -2.4, 3.5, -7], ids });
    expect(tail).toBe(` sel=9999 box=2,-2,4,0 ids=ok-1,${Array.from({ length: 11 }, (_, i) => `e${i}`).join(',')}`);
    expect(server.pageSelectionTail({ n: 1, box: [0, 0, 1, 1], ids: ['a', 'b'] })).toBe(' sel=2 box=0,0,1,1 ids=a,b');
    expect(server.pageSelectionTail({ n: 3, box: [99_999_999, -99_999_999, 1, 1], ids: ['a'] })).toBe(' sel=3 box=9999999,-9999999,1,1 ids=a');
    expect(server.pageSelectionTail({ n: 3, box: [0, 0, 1, 1], ids: ['bad id'] })).toBe('');
    expect(client.pageSelectionTail({ n: 123456, box: [1.6, -2.4, 3.5, -7], ids })).toBe(tail);
    // What the field may build is always a block the regex reads back.
    const built = server.pageContextBlock({ page: 'whiteboards', board: 'q3', sel: { n: 123456, box: [1.6, -2.4, 3.5, -7], ids } });
    expect(server.splitPageContext(`x\n\n${built}`).page?.sel?.ids).toHaveLength(12);
  });

  it('a malformed tail is his text, untouched', () => {
    for (const t of [
      'x\n\n[On page whiteboards board=q3 sel=0 box=0,0,1,1 ids=a]',
      'x\n\n[On page whiteboards board=q3 sel=2 ids=a]',
      'x\n\n[On page whiteboards board=q3 sel=2 box=0,0,-1,1 ids=a]',
      `x\n\n[On page whiteboards board=q3 sel=2 box=0,0,1,1 ids=${Array.from({ length: 13 }, (_, i) => `e${i}`).join(',')}]`,
    ]) expect(server.splitPageContext(t)).toEqual({ text: t, page: null });
  });

  it('the bubble draws ONE page chip with the count', () => {
    const label = (p: string) => (p === 'whiteboards' ? 'Whiteboard' : p);
    expect(pageChipName({ page: 'whiteboards', board: 'launch-plan', sel }, label, (n) => `${n} seçili öğe`)).toBe('Whiteboard · launch-plan · 9 seçili öğe');
    expect(pageChipName({ page: 'whiteboards', board: 'launch-plan' }, label, (n) => `${n} seçili öğe`)).toBe('Whiteboard · launch-plan');
    expect(read('dashboard/src/components/sleepy/chat/TranscriptItem.tsx')).toContain("(n) => t('whiteboard.field.selCount').replace('{n}', String(n))");
  });

  it('an empty region rides after the selection tail, with or without sel=, and round-trips on both sides', () => {
    const cases: server.PageContextRef[] = [
      { page: 'whiteboards', board: 'launch-plan', area: [40, -80, 320, 240] },
      { page: 'whiteboards', board: 'launch-plan', sel, area: [40, -80, 320, 240] },
    ];
    expect(server.pageContextBlock(cases[0])).toBe('[On page whiteboards board=launch-plan area=40,-80,320,240]');
    expect(server.pageContextBlock(cases[1])).toBe('[On page whiteboards board=launch-plan sel=9 box=120,-40,860,410 ids=rect-a,txt_b,Card-3 area=40,-80,320,240]');
    for (const ref of cases) {
      expect(client.pageContextBlock(ref)).toBe(server.pageContextBlock(ref));
      for (const side of [server, client]) expect(side.splitPageContext(`buraya elma\n\n${side.pageContextBlock(ref)}`)).toEqual({ text: 'buraya elma', page: ref });
    }
    // Rounded and clamped like box; a region without a size or with a non-number is left out.
    expect(server.pageAreaTail([1.6, -2.4, 300.5, 99_999_999])).toBe(' area=2,-2,301,9999999');
    expect(client.pageAreaTail([1.6, -2.4, 300.5, 99_999_999])).toBe(' area=2,-2,301,9999999');
    for (const bad of [[0, 0, 0, 10], [0, 0, 10, -4], [0, 0, NaN, 10], [0, 0, 10], null]) expect(server.pageAreaTail(bad as never)).toBe('');
    expect(server.splitPageContext('x\n\n[On page whiteboards board=q3 area=0,0,-1,1]').page).toBeNull();
  });

  it('the Super is told what area= means', () => {
    expect(read('src/server/chat-modes.ts')).toMatch(/\\`area=<x>,<y>,<w>,<h>\\` is an empty region the owner chose: draw inside it; pass it verbatim/);
  });

  it('the Super is told what sel/box/ids mean and to delegate with them verbatim', () => {
    const prompt = read('src/server/chat-modes.ts');
    expect(prompt).toMatch(/sel=<n> box=<x>,<y>,<w>,<h> ids=<id>/);
    expect(prompt).toMatch(/delegate it with board, ids and box verbatim/);
  });
});
