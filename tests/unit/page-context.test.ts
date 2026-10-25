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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as server from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import {
  __resetScratchForTests, composeOutgoing, countsAsContent, dropSentAttachments, readScratch, setAbout, setPageContext,
  addAttachments, type Attachment,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { pageBlockOf, pageChipName, pageKeyOf, publishPage, publishPageDetail, readPageContext } from '../../dashboard/src/lib/pageContext.js';

const ROOT = new URL('../../', import.meta.url).pathname;
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
    expect(chat).toMatch(/const aboutHead = isSuper \? ABOUT_AGENDA_RE\.exec\(text\) : null;/);
    // The briefing names the block (rev 11).
    expect(server.SUPER_BRIEF_REV).toBe(11);
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
    expect(composer).toMatch(/const \{ message, quoted, slash \} = composeOutgoing\(text, readScratch\(convId\)\.attachments, liveQuote, quotePath\);/);
    expect(composer).toMatch(/if \(mode === 'queue'\) session\.enqueue\(message\);/);
    expect(composer).toMatch(/if \(!session\.steer\(message\)\) session\.enqueue\(message, \{ steerWhenPossible: true \}\);/);
    expect(composer).toMatch(/const addressed = onPeerMessage \? addressedPeer\(quoted, peers\) : null;/);
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
