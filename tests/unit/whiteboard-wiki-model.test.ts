/**
 * The wiki card's pure half (dashboard/src/components/whiteboard/wikiCardModel.ts): the lenient
 * read of a card's list off its payload, and the list edits the card makes before
 * `commitWidget` writes them. Every edit must produce a list the server's strict validator
 * takes as-is, and must hand back the SAME object when it changes nothing.
 */
import { describe, it, expect } from 'vitest';
import * as server from '../../src/lib/whiteboards/nav.js';
import { validateWidgetPayload } from '../../src/lib/whiteboards/validate.js';
import {
  MAX_WIKI_PAGES, MAX_WIKI_SECTIONS, addFirstPage, addPage, addSection, cleanTitle, dropIndex, editWikiPayload,
  fitWikiRows, listPages, moveSection, movePage, newSectionId, readWikiList, removePage, removeSection, renameSection, renameWikiCard,
  sectionHasRef, stepPage, type WikiList,
} from '../../dashboard/src/components/whiteboard/wikiCardModel.js';
import type { WidgetPayload } from '../../dashboard/src/lib/whiteboardWidgets.js';

const list = (): WikiList => ({
  sections: [
    { id: 's-a', title: 'Start', pages: [{ ref: 'overview' }, { ref: 'features/whiteboards' }, { ref: 'docs/spec.pdf' }] },
    { id: 's-b', title: 'Deep', pages: [{ ref: 'patterns/ui/tokens', label: 'Tokens' }] },
    { id: 's-c', title: 'Empty', pages: [] },
  ],
});

const refs = (l: WikiList, id: string) => l.sections.find((s) => s.id === id)!.pages.map((p) => p.ref);
const ids = (l: WikiList) => l.sections.map((s) => s.id);

/** Every client edit must produce a list the server's strict validator takes as-is. */
const serverAccepts = (l: WikiList) => expect(server.validateNav(l)).toEqual(l);

describe('reading a card list off its payload', () => {
  it('a well-formed list reads as itself and the server takes it', () => {
    expect(readWikiList(list().sections)).toEqual(list());
    serverAccepts(readWikiList(list().sections));
  });

  it('no list, or not an array, is an empty card', () => {
    expect(readWikiList(undefined)).toEqual({ sections: [] });
    expect(readWikiList(null)).toEqual({ sections: [] });
    expect(readWikiList({ sections: [] })).toEqual({ sections: [] });
    expect(readWikiList('x')).toEqual({ sections: [] });
  });

  it('a hand-edited list never throws and reads as one the server accepts', () => {
    const raw = [
      null,
      'nope',
      [1, 2],
      { id: 's-a', title: 'Start' },                                   // no pages
      { id: 's-a', title: '  Dup id  ', pages: 'x' },                  // repeated id, pages not an array
      { title: 42, pages: [{ ref: 'ok-page' }, { ref: '../etc/passwd.md' }, { ref: 'ok-page' }, null, { label: 'x' }] },
      { id: 'bad id!', title: 'Line\nbreak', pages: [{ ref: 'docs/a.pdf', label: '  Annual  ' }, { ref: 'docs/b.md', label: '' }] },
    ];
    const read = readWikiList(raw, 'Section');
    expect(read.sections.map((s) => s.title)).toEqual(['Start', 'Dup id', 'Section', 'Line break']);
    expect(new Set(ids(read)).size).toBe(4);
    expect(read.sections[0].pages).toEqual([]);
    expect(read.sections[1].pages).toEqual([]);
    // A bad ref, a duplicate ref, a non-object and a page with no ref are dropped.
    expect(read.sections[2].pages).toEqual([{ ref: 'ok-page' }]);
    // Labels are cleaned; an empty label is no label.
    expect(read.sections[3].pages).toEqual([{ ref: 'docs/a.pdf', label: 'Annual' }, { ref: 'docs/b.md' }]);
    serverAccepts(read);
  });

  it('reads the same ids on every render (no random repair)', () => {
    const raw = [{ title: 'A', pages: [] }, { id: 's-0', title: 'B', pages: [] }];
    expect(readWikiList(raw)).toEqual(readWikiList(raw));
    expect(new Set(ids(readWikiList(raw))).size).toBe(2);
  });

  it('caps sections and pages at the server limits', () => {
    const many = Array.from({ length: MAX_WIKI_SECTIONS + 5 }, (_, i) => ({ id: `s-${i}`, title: `S${i}`, pages: [] }));
    expect(readWikiList(many).sections).toHaveLength(MAX_WIKI_SECTIONS);
    const pages = Array.from({ length: MAX_WIKI_PAGES + 5 }, (_, i) => ({ ref: `p-${i}` }));
    expect(readWikiList([{ id: 's-a', title: 'A', pages }]).sections[0].pages).toHaveLength(MAX_WIKI_PAGES);
  });

  it('listPages walks every page in reading order with its place', () => {
    expect(listPages(list()).map((r) => `${r.section.id}:${r.index}:${r.page.ref}`)).toEqual([
      's-a:0:overview', 's-a:1:features/whiteboards', 's-a:2:docs/spec.pdf', 's-b:0:patterns/ui/tokens',
    ]);
  });

  it('editWikiPayload writes the edited list and keeps the payload when nothing changed', () => {
    const payload: WidgetPayload = { v: 1, kind: 'wiki', title: 'Launch', size: 'l', sections: list().sections };
    const next = editWikiPayload(payload, (l) => removeSection(l, 's-c'));
    expect(next).not.toBe(payload);
    expect(next.title).toBe('Launch');
    expect(next.size).toBe('l');
    expect(next.sections?.map((s) => s.id)).toEqual(['s-a', 's-b']);
    expect(editWikiPayload(payload, (l) => l)).toBe(payload);
    expect(editWikiPayload(payload, (l) => removeSection(l, 'nope'))).toBe(payload);
    // A payload with no list at all still takes its first edit.
    const bare: WidgetPayload = { v: 1, kind: 'wiki', title: 'Wiki' };
    expect(editWikiPayload(bare, (l) => addSection(l, 'First', 's-1')).sections).toEqual([{ id: 's-1', title: 'First', pages: [] }]);
  });
});

/** A hand-broken list (a section without `pages`, a bad ref, a repeated id, an empty title): the
 *  server's widget validator refuses it as stored. */
const brokenWiki = (): WidgetPayload => ({
  v: 1,
  kind: 'wiki',
  title: 'Launch',
  sections: [
    { id: 's-a', title: 'Start' },
    { id: 's-a', title: '', pages: [{ ref: 'overview' }, { ref: '../etc/passwd.md' }] },
  ] as unknown as WidgetPayload['sections'],
});

describe('card edits on a hand-broken payload', () => {
  it('the broken payload is what the save refuses', () => {
    expect(() => validateWidgetPayload(brokenWiki())).toThrow();
  });

  it('renaming the card alone writes a payload the server accepts', () => {
    const renamed = renameWikiCard(brokenWiki(), '  Northwind launch  ');
    expect(renamed.title).toBe('Northwind launch');
    expect(() => validateWidgetPayload(renamed)).not.toThrow();
    expect(renamed.sections?.map((sec) => sec.pages.map((p) => p.ref))).toEqual([[], ['overview']]);
  });

  it('renaming to the same or an unusable title changes nothing', () => {
    const p = brokenWiki();
    expect(renameWikiCard(p, 'Launch')).toBe(p);
    expect(renameWikiCard(p, '   ')).toBe(p);
  });

  it('an untitled section is written with the fallback the card shows, not always English', () => {
    const renamed = renameWikiCard(brokenWiki(), 'Lansman', 'Bölüm');
    expect(renamed.sections?.[1].title).toBe('Bölüm');
    const edited = editWikiPayload(brokenWiki(), (l) => removeSection(l, 's-a'), 'Bölüm');
    expect(edited.sections?.map((sec) => sec.title)).toEqual(['Bölüm']);
    expect(() => validateWidgetPayload(edited)).not.toThrow();
  });
});

describe('section edits', () => {
  it('section ids match the server shape', () => {
    const id = newSectionId();
    expect(id).toMatch(/^s-[A-Za-z0-9]{8}$/);
    serverAccepts(addSection(list(), 'New', id));
  });

  it('cleanTitle trims, flattens to one line, and refuses empty or over-long titles', () => {
    expect(cleanTitle('  A  ')).toBe('A');
    expect(cleanTitle('a\nb\tc')).toBe('a b c');
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle('x'.repeat(201))).toBeNull();
    expect(cleanTitle(42)).toBeNull();
  });

  it('add a section: at the end, or at a position; a bad title, a taken id or a bad id changes nothing', () => {
    const added = addSection(list(), '  Later  ', 's-new');
    expect(added.sections.at(-1)).toEqual({ id: 's-new', title: 'Later', pages: [] });
    serverAccepts(added);
    expect(ids(addSection(list(), 'Top', 's-top', 0))).toEqual(['s-top', 's-a', 's-b', 's-c']);
    const l = list();
    expect(addSection(l, '   ', 's-x')).toBe(l);
    expect(addSection(l, 'Again', 's-a')).toBe(l);
    expect(addSection(l, 'Bad', 'has space')).toBe(l);
  });

  it('a full card takes no more sections', () => {
    const full: WikiList = { sections: Array.from({ length: MAX_WIKI_SECTIONS }, (_, i) => ({ id: `s-${i}`, title: 'S', pages: [] })) };
    expect(addSection(full, 'One more', 's-more')).toBe(full);
  });

  it('rename a section; the same title, an empty title or an unknown id changes nothing', () => {
    const renamed = renameSection(list(), 's-b', 'Deeper');
    expect(renamed.sections[1].title).toBe('Deeper');
    serverAccepts(renamed);
    const l = list();
    expect(renameSection(l, 's-b', 'Deep')).toBe(l);
    expect(renameSection(l, 's-b', '  ')).toBe(l);
    expect(renameSection(l, 'nope', 'X')).toBe(l);
  });

  it('remove a section takes its pages with it; an unknown id changes nothing', () => {
    expect(ids(removeSection(list(), 's-a'))).toEqual(['s-b', 's-c']);
    const l = list();
    expect(removeSection(l, 'nope')).toBe(l);
  });

  it('moveSection lands the section at the index asked for', () => {
    expect(ids(moveSection(list(), 's-a', 2))).toEqual(['s-b', 's-c', 's-a']);
    expect(ids(moveSection(list(), 's-c', 0))).toEqual(['s-c', 's-a', 's-b']);
    expect(ids(moveSection(list(), 's-c', 99))).toEqual(['s-a', 's-b', 's-c']);
    expect(ids(moveSection(list(), 's-b', -5))).toEqual(['s-b', 's-a', 's-c']);
    const l = list();
    expect(moveSection(l, 's-a', 0)).toBe(l);
    expect(moveSection(l, 'nope', 1)).toBe(l);
  });

  it('edits never mutate the list they were given', () => {
    const l = list();
    const before = JSON.stringify(l);
    renameSection(l, 's-a', 'X');
    moveSection(l, 's-a', 2);
    removeSection(l, 's-a');
    addPage(l, 's-c', { ref: 'x' });
    movePage(l, 's-a', 0, 's-b', 0);
    removePage(l, 's-a', 0);
    expect(JSON.stringify(l)).toBe(before);
  });
});

describe('page edits', () => {
  it('add / remove a page; a duplicate, a bad ref or an unknown section changes nothing', () => {
    const added = addPage(list(), 's-c', { ref: 'notes/plan.html' });
    expect(refs(added, 's-c')).toEqual(['notes/plan.html']);
    serverAccepts(added);
    expect(refs(addPage(list(), 's-a', { ref: 'about' }, 1), 's-a')).toEqual(['overview', 'about', 'features/whiteboards', 'docs/spec.pdf']);
    expect(addPage(list(), 's-c', { ref: 'x', label: '  Label ' }).sections[2].pages).toEqual([{ ref: 'x', label: 'Label' }]);
    const l = list();
    expect(addPage(l, 's-a', { ref: 'overview' })).toBe(l);
    expect(addPage(l, 's-a', { ref: '../etc/passwd.md' })).toBe(l);
    expect(addPage(l, 's-a', { ref: 'image.png' })).toBe(l);
    expect(addPage(l, 'nope', { ref: 'about' })).toBe(l);
    expect(refs(removePage(list(), 's-a', 1), 's-a')).toEqual(['overview', 'docs/spec.pdf']);
    expect(removePage(l, 's-a', 9)).toBe(l);
    expect(removePage(l, 's-a', -1)).toBe(l);
    expect(removePage(l, 'nope', 0)).toBe(l);
  });

  it('the same ref may sit in two sections, never twice in one', () => {
    const l = addPage(list(), 's-b', { ref: 'overview' });
    expect(refs(l, 's-b')).toEqual(['patterns/ui/tokens', 'overview']);
    expect(sectionHasRef(l, 's-b', 'overview')).toBe(true);
    expect(sectionHasRef(l, 's-c', 'overview')).toBe(false);
    expect(sectionHasRef(l, 'nope', 'overview')).toBe(false);
    serverAccepts(l);
  });

  it('a full section takes no more pages', () => {
    const full: WikiList = { sections: [{ id: 's-a', title: 'A', pages: Array.from({ length: MAX_WIKI_PAGES }, (_, i) => ({ ref: `p-${i}` })) }, { id: 's-b', title: 'B', pages: [{ ref: 'extra' }] }] };
    expect(addPage(full, 's-a', { ref: 'one-more' })).toBe(full);
    expect(movePage(full, 's-b', 0, 's-a', 0)).toBe(full);
  });

  it('addFirstPage: into the first section, or a new one when the card has none', () => {
    const fresh = addFirstPage({ sections: [] }, { ref: 'docs/spec.pdf' }, 'Pages', 's-first');
    expect(fresh).toEqual({ sections: [{ id: 's-first', title: 'Pages', pages: [{ ref: 'docs/spec.pdf' }] }] });
    serverAccepts(fresh);
    expect(refs(addFirstPage(list(), { ref: 'about' }, 'Pages', 's-x'), 's-a')).toEqual(['overview', 'features/whiteboards', 'docs/spec.pdf', 'about']);
    const empty: WikiList = { sections: [] };
    expect(addFirstPage(empty, { ref: '../bad.md' }, 'Pages', 's-first')).toBe(empty);
  });

  it('movePage reorders within a section and moves between sections', () => {
    expect(refs(movePage(list(), 's-a', 0, 's-a', 2), 's-a')).toEqual(['features/whiteboards', 'docs/spec.pdf', 'overview']);
    expect(refs(movePage(list(), 's-a', 2, 's-a', 0), 's-a')).toEqual(['docs/spec.pdf', 'overview', 'features/whiteboards']);
    const across = movePage(list(), 's-a', 1, 's-b', 0);
    expect(refs(across, 's-a')).toEqual(['overview', 'docs/spec.pdf']);
    expect(refs(across, 's-b')).toEqual(['features/whiteboards', 'patterns/ui/tokens']);
    serverAccepts(across);
    // Into an empty section, past its end: lands at its end.
    expect(refs(movePage(list(), 's-a', 0, 's-c', 99), 's-c')).toEqual(['overview']);
    // The label travels with the page.
    expect(movePage(list(), 's-b', 0, 's-c', 0).sections[2].pages).toEqual([{ ref: 'patterns/ui/tokens', label: 'Tokens' }]);
  });

  it('movePage to the same place, from a bad index, or into a section holding the ref changes nothing', () => {
    const l = list();
    expect(movePage(l, 's-a', 1, 's-a', 1)).toBe(l);
    expect(movePage(l, 's-a', 2, 's-a', 99)).toBe(l);
    expect(movePage(l, 's-a', 5, 's-b', 0)).toBe(l);
    expect(movePage(l, 's-a', 0, 'nope', 0)).toBe(l);
    expect(movePage(l, 'nope', 0, 's-a', 0)).toBe(l);
    const dup = addPage(list(), 's-b', { ref: 'overview' });
    expect(movePage(dup, 's-a', 0, 's-b', 0)).toBe(dup);
  });

  it('matches the server ops for the same moves', () => {
    const l = list();
    expect(movePage(l, 's-a', 0, 's-b', 1)).toEqual(server.movePage(l, 's-a', '0', 1, 's-b'));
    expect(movePage(l, 's-a', 0, 's-a', 2)).toEqual(server.movePage(l, 's-a', '0', 2));
    expect(moveSection(l, 's-a', 2)).toEqual(server.moveSection(l, 's-a', 2));
    expect(addPage(l, 's-c', { ref: 'docs/plan.html' })).toEqual(server.addPage(l, 's-c', { ref: 'docs/plan.html' }));
    expect(removePage(l, 's-a', 1)).toEqual(server.removePage(l, 's-a', '1').nav);
  });

  it('dropIndex: dropping before a row lower in the same section lands one higher', () => {
    // Drag row 0 onto "before row 2" of the same section: it lands at index 1.
    expect(dropIndex('s-a', 0, 's-a', 2)).toBe(1);
    expect(refs(movePage(list(), 's-a', 0, 's-a', dropIndex('s-a', 0, 's-a', 2)), 's-a')).toEqual(['features/whiteboards', 'overview', 'docs/spec.pdf']);
    // Dropped at the section's end.
    expect(refs(movePage(list(), 's-a', 0, 's-a', dropIndex('s-a', 0, 's-a', 3)), 's-a')).toEqual(['features/whiteboards', 'docs/spec.pdf', 'overview']);
    // Upward, or into another section: the row's index as is.
    expect(dropIndex('s-a', 2, 's-a', 0)).toBe(0);
    expect(dropIndex('s-a', 0, 's-b', 1)).toBe(1);
    // Dropped on its own place: no move.
    const l = list();
    expect(movePage(l, 's-a', 1, 's-a', dropIndex('s-a', 1, 's-a', 1))).toBe(l);
    expect(movePage(l, 's-a', 1, 's-a', dropIndex('s-a', 1, 's-a', 2))).toBe(l);
  });

  it('stepPage walks within a section, then across the boundary, and stops at the ends', () => {
    const l = list();
    expect(stepPage(l, 's-a', 1, -1)).toEqual({ section: 's-a', index: 0 });
    expect(stepPage(l, 's-a', 0, -1)).toBeNull();
    expect(stepPage(l, 's-a', 2, 1)).toEqual({ section: 's-b', index: 0 });
    expect(stepPage(l, 's-b', 0, -1)).toEqual({ section: 's-a', index: 3 });
    expect(stepPage(l, 's-b', 0, 1)).toEqual({ section: 's-c', index: 0 });
    const last = movePage(l, 's-b', 0, 's-c', 0);
    expect(stepPage(last, 's-c', 0, 1)).toBeNull();
    const t = stepPage(l, 's-a', 2, 1)!;
    expect(refs(movePage(l, 's-a', 2, t.section, t.index), 's-b')).toEqual(['docs/spec.pdf', 'patterns/ui/tokens']);
    // Unknown section or row, or a neighbour that already lists the ref: no step.
    expect(stepPage(l, 'nope', 0, 1)).toBeNull();
    expect(stepPage(l, 's-a', 7, 1)).toBeNull();
    const dup = addPage(list(), 's-b', { ref: 'docs/spec.pdf' });
    expect(stepPage(dup, 's-a', 2, 1)).toBeNull();
  });
});

describe('fitting an inactive card: whole rows, then "+N more"', () => {
  // Four 32px rows under 24px headings (section 1: rows at 56 and 88; section 2: 144 and 176).
  const bottoms = [56, 88, 144, 176];

  it('every row fits: all of them, no "+N more"', () => {
    expect(fitWikiRows(bottoms, 176, 28)).toBe(4);
    expect(fitWikiRows(bottoms, 300, 28)).toBe(4);
  });

  it('a row that would be cut is left out, with room kept for the "+N more" line', () => {
    // 150px tall: row 3 (144) would fit alone, but not with the 28px line under it.
    expect(fitWikiRows(bottoms, 150, 28)).toBe(2);
    expect(fitWikiRows(bottoms, 175, 28)).toBe(3);
    // A row ending exactly at the limit is whole.
    expect(fitWikiRows(bottoms, 116, 28)).toBe(2);
  });

  it('a card too small for any row shows none (only the "+N more" line)', () => {
    expect(fitWikiRows(bottoms, 40, 28)).toBe(0);
  });

  it('no rows: nothing to fit', () => {
    expect(fitWikiRows([], 100, 28)).toBe(0);
  });
});
