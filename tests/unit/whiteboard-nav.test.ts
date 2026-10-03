import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createWhiteboard, mutateWhiteboard, readWhiteboard } from '../../src/lib/whiteboards/store.js';
import { parseWhiteboard, serializeWhiteboard } from '../../src/lib/whiteboards/format.js';
import {
  DEFAULT_WIDGET_SIZES, WIDGET_SIZES, makeWidgetElement, widgetPayloadOf, type WhiteboardElement, type WidgetSize,
} from '../../src/lib/whiteboards/widgets.js';
import { validateElement } from '../../src/lib/whiteboards/validate.js';
import { WhiteboardValidationError } from '../../src/lib/whiteboards/errors.js';
import { mergeElements, stripTombstone } from '../../src/lib/whiteboards/merge.js';
import { mergeWhiteboardMd } from '../../src/lib/git-sync/semantic-merge.js';
import { describeElement, prepareImport, tombstone } from '../../src/lib/whiteboards/ops.js';
import {
  MAX_NAV_PAGES, MAX_NAV_SECTIONS, addPage, addSection, applyWikiEdit, emptyNav, movePage, moveSection, removePage,
  readWikiSections, removeSection, resolveWikiCard, validateNav, wikiCards, wikiNavOf, type WikiNav,
} from '../../src/lib/whiteboards/nav.js';
import { clearPageIndexCache, searchPages } from '../../src/lib/whiteboards/pages.js';
import * as routes from '../../src/server/routes/whiteboards.js';
import { handleWhiteboardGet, handleWhiteboardPages, handleWhiteboardPut } from '../../src/server/routes/whiteboards.js';

/**
 * The wiki card (kind `wiki`): its list of sections and pages lives in the widget's own payload
 * (`customData.dc.sections`), is validated by the widget validator, edited by the pure nav ops,
 * survives the element merge and a format round-trip, and is stripped from a tombstone. The
 * board-level menu (frontmatter + nav routes) is gone. Plus the page search walker (pages.ts).
 * Every test runs in its own scratch project; nothing reaches the real brain or home.
 */

let project: string;
let root: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-nav-')));
  root = join(project, '_dream_context');
  mkdirSync(root);
  clearPageIndexCache();
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const NAV: WikiNav = {
  sections: [
    { id: 's-intro', title: 'Başlangıç', pages: [{ ref: 'architecture/overview' }, { ref: 'docs/spec.pdf', label: 'Spec "v2"' }] },
    { id: 's-ref', title: 'Reference', pages: [] },
  ],
};

function note(index: string): WhiteboardElement {
  return makeWidgetElement('note', { markdown: 'x' }, { x: 0, y: 0 }, index);
}

// ─── fake http ──────────────────────────────────────────────────────────────

function call(
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>,
  opts: { method?: string; url?: string; params?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  let status = 0;
  let body: unknown = null;
  const res = {
    headersSent: false,
    writeHead(s: number) { status = s; this.headersSent = true; },
    setHeader() {},
    end(data?: string) { body = data ? JSON.parse(data) : null; },
  } as unknown as ServerResponse;
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  const req = Object.assign(Readable.from(chunks), {
    method: opts.method ?? 'GET', url: opts.url ?? '/', headers: { host: 'localhost:4000' },
  }) as unknown as IncomingMessage;
  return handler(req, res, opts.params ?? {}, root).then(() => ({ status, body }));
}

// ─── model ──────────────────────────────────────────────────────────────────

describe('wiki nav: validation and path safety', () => {
  it('accepts knowledge slugs and project-relative .md/.pdf/.html/.htm paths', () => {
    const nav = validateNav({ sections: [{ id: 'a', title: 'A', pages: [
      { ref: 'patterns/x' }, { ref: 'docs/a.md' }, { ref: 'docs/b.pdf' }, { ref: 'site/c.html' }, { ref: 'site/d.htm' },
    ] }] });
    expect(nav.sections[0].pages).toHaveLength(5);
  });

  it.each([
    '../secret.md', 'docs/../../etc/passwd.md', '/etc/passwd.md', '~/notes.md', 'C:/x.md', 'a\\b.md',
    'docs//a.md', './a.md', 'docs/a.txt', 'docs/run.sh', '',
  ])('refuses the page ref %j', (ref) => {
    expect(() => validateNav({ sections: [{ id: 'a', title: 'A', pages: [{ ref }] }] })).toThrow(WhiteboardValidationError);
  });

  it('refuses unknown keys, duplicate section ids, empty titles and bad ids', () => {
    expect(() => validateNav({ sections: [], extra: 1 })).toThrow(/unexpected wiki keys/);
    expect(() => validateNav({ sections: [{ id: 'a', title: 'A', pages: [], x: 1 }] })).toThrow(/unexpected section keys/);
    expect(() => validateNav({ sections: [{ id: 'a', title: 'A', pages: [{ ref: 'x', html: '<b>' }] }] })).toThrow(/unexpected page keys/);
    expect(() => validateNav({ sections: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] })).toThrow(/duplicate section id/);
    expect(() => validateNav({ sections: [{ id: 'a', title: '  ' }] })).toThrow(/must not be empty/);
    expect(() => validateNav({ sections: [{ id: 'a b', title: 'A' }] })).toThrow(/invalid section id/);
    expect(() => validateNav([])).toThrow(/must be an object/);
  });

  it('add / remove / move sections and pages, by id or title, with clamped indices', () => {
    let nav = emptyNav();
    nav = addSection(nav, 'One', { id: 's1' }).nav;
    nav = addSection(nav, 'Two', { id: 's2' }).nav;
    nav = addSection(nav, 'Zero', { id: 's0', at: 0 }).nav;
    expect(nav.sections.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    nav = addPage(nav, 'one', { ref: 'a' });
    nav = addPage(nav, 's1', { ref: 'b.md' });
    nav = addPage(nav, 's1', { ref: 'c.pdf', label: 'C' }, { at: 0 });
    expect(nav.sections[1].pages.map((p) => p.ref)).toEqual(['c.pdf', 'a', 'b.md']);
    expect(() => addPage(nav, 's1', { ref: 'a' })).toThrow(/already in section/);
    expect(() => addPage(nav, 'nope', { ref: 'a' })).toThrow(/no section 'nope'/);

    nav = movePage(nav, 's1', 'b.md', 0);
    expect(nav.sections[1].pages.map((p) => p.ref)).toEqual(['b.md', 'c.pdf', 'a']);
    nav = movePage(nav, 's1', '#2', -1);
    expect(nav.sections[1].pages.map((p) => p.ref)).toEqual(['b.md', 'c.pdf', 'a']);
    nav = movePage(nav, 's1', 'c.pdf', 0, 'Two');
    expect(nav.sections[1].pages.map((p) => p.ref)).toEqual(['b.md', 'a']);
    expect(nav.sections[2].pages).toEqual([{ ref: 'c.pdf', label: 'C' }]);

    nav = moveSection(nav, 'Zero', 99);
    expect(nav.sections.map((s) => s.id)).toEqual(['s1', 's2', 's0']);
    nav = removePage(nav, 's1', '#0').nav;
    expect(nav.sections[0].pages.map((p) => p.ref)).toEqual(['a']);
    const r = removeSection(nav, 's2');
    expect(r.removed.title).toBe('Two');
    expect(r.nav.sections.map((s) => s.id)).toEqual(['s1', 's0']);
  });

  it('ops never mutate their input', () => {
    const before = JSON.stringify(NAV);
    addSection(NAV, 'X');
    addPage(NAV, 's-ref', { ref: 'x' });
    movePage(NAV, 's-intro', '#0', 1);
    removeSection(NAV, 's-ref');
    expect(JSON.stringify(NAV)).toBe(before);
  });

  it('an ambiguous section title is refused; the id still works', () => {
    const nav = validateNav({ sections: [{ id: 'a', title: 'Dup' }, { id: 'b', title: 'dup' }] });
    expect(() => addPage(nav, 'Dup', { ref: 'x' })).toThrow(/more than one section/);
    expect(addPage(nav, 'b', { ref: 'x' }).sections[1].pages).toEqual([{ ref: 'x' }]);
  });
});

// ─── the wiki card ─────────────────────────────────────────────────────────

function wiki(index: string, sections: WikiNav['sections'] = [], title = 'Handbook'): WhiteboardElement {
  return makeWidgetElement('wiki', { title, sections }, { x: 0, y: 0 }, index);
}

function sectionsOf(el: WhiteboardElement): unknown {
  return widgetPayloadOf(el)?.sections;
}

describe('wiki card: the payload contract', () => {
  it('a wiki widget with sections validates; default size is l; every size is allowed', () => {
    expect(DEFAULT_WIDGET_SIZES.wiki).toBe('l');
    const el = wiki('a0', NAV.sections);
    expect(widgetPayloadOf(el)?.size).toBe('l');
    expect([el.width, el.height]).toEqual(WIDGET_SIZES.l);
    expect(() => validateElement(el)).not.toThrow();
    for (const size of Object.keys(WIDGET_SIZES) as WidgetSize[]) {
      expect(() => validateElement(makeWidgetElement('wiki', { title: 'T', size, sections: [] }, { x: 0, y: 0 }, 'a0'))).not.toThrow();
    }
    // A card without a list yet reads as an empty one.
    const bare = makeWidgetElement('wiki', { title: 'Bare' }, { x: 0, y: 0 }, 'a0');
    expect(() => validateElement(bare)).not.toThrow();
    expect(wikiNavOf(bare)).toEqual(emptyNav());
  });

  it.each([
    ['a traversal ref', [{ id: 'a', title: 'A', pages: [{ ref: '../secret.md' }] }], /invalid page ref/],
    ['an absolute ref', [{ id: 'a', title: 'A', pages: [{ ref: '/etc/passwd.md' }] }], /invalid page ref/],
    ['a non-page file', [{ id: 'a', title: 'A', pages: [{ ref: 'docs/run.sh' }] }], /invalid page ref/],
    ['an unknown page key', [{ id: 'a', title: 'A', pages: [{ ref: 'x', html: '<b>' }] }], /unexpected page keys/],
    ['a duplicate section id', [{ id: 'a', title: 'A', pages: [] }, { id: 'a', title: 'B', pages: [] }], /duplicate section id/],
    ['a bad section id', [{ id: 'a b', title: 'A', pages: [] }], /invalid section id/],
    ['a section without pages', [{ id: 'a', title: 'A' }], /needs a pages array/],
    ['a non-array list', { a: 1 }, /must be an array/],
  ])('refuses %s', (_what, sections, msg) => {
    const el = makeWidgetElement('wiki', { title: 'T' }, { x: 0, y: 0 }, 'a0');
    (el.customData!.dc as Record<string, unknown>).sections = sections;
    expect(() => validateElement(el)).toThrow(msg);
    expect(() => validateElement(el)).toThrow(/^wiki card: /);
  });

  it('enforces the nav limits (sections per card, pages per section)', () => {
    const many = Array.from({ length: MAX_NAV_SECTIONS + 1 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, pages: [] }));
    expect(() => validateElement(wiki('a0', many))).toThrow(/too many wiki sections/);
    expect(() => validateElement(wiki('a0', many.slice(0, MAX_NAV_SECTIONS)))).not.toThrow();
    const pages = Array.from({ length: MAX_NAV_PAGES + 1 }, (_, i) => ({ ref: `p/${i}` }));
    expect(() => validateElement(wiki('a0', [{ id: 's', title: 'S', pages }]))).toThrow(/too many pages/);
    let nav: WikiNav = { sections: many.slice(0, MAX_NAV_SECTIONS) };
    expect(() => addSection(nav, 'one more')).toThrow(/too many wiki sections/);
    nav = { sections: [{ id: 's', title: 'S', pages: pages.slice(0, MAX_NAV_PAGES) }] };
    expect(() => addPage(nav, 's', { ref: 'last' })).toThrow(/too many pages/);
  });

  it('sections belong to wiki cards only', () => {
    const el = note('a0');
    (el.customData!.dc as Record<string, unknown>).sections = [];
    expect(() => validateElement(el)).toThrow(/sections apply to wiki widgets, not note/);
  });

  it('a tombstoned wiki card drops its sections and keeps the rest', () => {
    const dead = stripTombstone(tombstone(wiki('a0', NAV.sections)));
    const dc = widgetPayloadOf(dead)!;
    expect(dc.sections).toBeUndefined();
    expect(dc.title).toBe('Handbook');
    expect(dc.kind).toBe('wiki');
    expect(() => validateElement(dead)).not.toThrow();
  });
});

describe('wiki card: a section without pages', () => {
  function pagesless(index: string): WhiteboardElement {
    const el = wiki(index);
    (el.customData!.dc as Record<string, unknown>).sections = [{ id: 'a', title: 'A' }];
    return el;
  }

  it('is refused on write: validateElement, the scene PUT and import never store it', async () => {
    expect(() => validateElement(pagesless('a0'))).toThrow(/wiki card: section 'a' needs a pages array/);
    const { slug, path } = createWhiteboard(root, 'Strict');
    const before = readFileSync(path, 'utf-8');
    const r = await call(handleWhiteboardPut, { method: 'PUT', params: { slug }, body: { elements: [pagesless('a0')] } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/needs a pages array/);
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(() => prepareImport([pagesless('a0')], [], {})).toThrow(/needs a pages array/);
    // A complete empty list is fine.
    const ok = await call(handleWhiteboardPut, { method: 'PUT', params: { slug }, body: { elements: [wiki('a0', [{ id: 'a', title: 'A', pages: [] }])] } });
    expect(ok.status).toBe(200);
  });

  it('one that reached disk anyway (git sync does not validate) reads as pages: [], and the next edit writes them', () => {
    const el = pagesless('a0');
    expect(wikiNavOf(el)).toEqual({ sections: [{ id: 'a', title: 'A', pages: [] }] });
    expect(readWikiSections([{ id: 'a' }, null, 'x', { id: 'b', title: 'B', pages: [{ ref: 'k' }, null, { label: 'no ref' }] }]))
      .toEqual([{ id: 'a', title: '', pages: [] }, { id: 'b', title: 'B', pages: [{ ref: 'k' }] }]);
    expect(readWikiSections(undefined)).toEqual([]);
    expect(readWikiSections({ nope: 1 })).toEqual([]);
    expect(describeElement(el).sections).toEqual([{ id: 'a', title: 'A', pages: [] }]);
    const next = applyWikiEdit(el, (n) => addPage(n, 'a', { ref: 'docs/x.md' }));
    expect(sectionsOf(next)).toEqual([{ id: 'a', title: 'A', pages: [{ ref: 'docs/x.md' }] }]);
    expect(() => validateElement(next)).not.toThrow();
  });
});

describe('wiki card: nav ops target one card', () => {
  it('applyWikiEdit runs an op on the card, bumps its version and leaves the input alone', () => {
    const card = wiki('a0', NAV.sections);
    const before = JSON.stringify(card);
    const next = applyWikiEdit(card, (n) => addPage(n, 's-ref', { ref: 'docs/later.md', label: 'Later' }));
    expect(JSON.stringify(card)).toBe(before);
    expect(next.version).toBe(card.version + 1);
    expect(next.versionNonce).not.toBe(card.versionNonce);
    expect(wikiNavOf(next).sections[1].pages).toEqual([{ ref: 'docs/later.md', label: 'Later' }]);
    expect(widgetPayloadOf(next)?.title).toBe('Handbook');
    expect(() => applyWikiEdit(note('a1'), (n) => n)).toThrow(/not a wiki card/);
    expect(() => applyWikiEdit(card, () => ({ sections: [{ id: 'x', title: 'X', pages: [{ ref: '../x.md' }] }] }))).toThrow(/invalid page ref/);
  });

  it('resolveWikiCard: by id, the only card, or a refusal for none / several / a non-wiki id', () => {
    const n = note('a0');
    expect(() => resolveWikiCard([n], 'b')).toThrow(/b has no wiki card\. Add one: dreamcontext whiteboard add b wiki --title/);
    const one = wiki('a1', [], 'One');
    expect(resolveWikiCard([n, one], 'b')).toBe(one);
    const two = wiki('a2', [], 'Two');
    expect(() => resolveWikiCard([n, one, two], 'b')).toThrow(new RegExp(`2 wiki cards; pick one with --card <id>: ${one.id} "One", ${two.id} "Two"`));
    expect(resolveWikiCard([n, one, two], 'b', two.id)).toBe(two);
    expect(() => resolveWikiCard([n, one, two], 'b', n.id)).toThrow(/is not a wiki card/);
    expect(() => resolveWikiCard([n, one, two], 'b', 'nope')).toThrow(/no wiki card 'nope'/);
    // A deleted card does not count.
    expect(resolveWikiCard([n, one, tombstone(two)], 'b')).toBe(one);
    expect(wikiCards([n, one, tombstone(two)])).toEqual([one]);
  });
});

describe('wiki card: the list survives the element merge, a round-trip and git sync', () => {
  it('element merge: both sides edit the card, the higher version wins with its whole list', () => {
    const base = wiki('a0', NAV.sections);
    const disk = applyWikiEdit(base, (n) => removeSection(n, 's-ref').nav);
    const browser = applyWikiEdit(applyWikiEdit(base, (n) => moveSection(n, 's-ref', 0)), (n) => addPage(n, 's-ref', { ref: 'x' }));
    const other = wiki('a1', [{ id: 'o', title: 'Other', pages: [{ ref: 'docs/o.md' }] }], 'Other');
    const { elements } = mergeElements([disk, other], [browser]);
    const won = elements.find((e) => e.id === base.id)!;
    expect(won.version).toBe(browser.version);
    expect(sectionsOf(won)).toEqual([
      { id: 's-ref', title: 'Reference', pages: [{ ref: 'x' }] },
      NAV.sections[0],
    ]);
    // Several wiki cards on one board keep their own lists.
    expect(sectionsOf(elements.find((e) => e.id === other.id)!)).toEqual(sectionsOf(other));
    // And the other way round: disk at the higher version wins.
    const later = applyWikiEdit(applyWikiEdit(disk, (n) => n), (n) => n);
    const back = mergeElements([later], [browser]).elements[0];
    expect(sectionsOf(back)).toEqual([NAV.sections[0]]);
  });

  it('serialize -> parse leaves every card\'s list unchanged, byte for byte', () => {
    const { path } = createWhiteboard(root, 'Wiki');
    const board = parseWhiteboard(readFileSync(path, 'utf-8'));
    board.elements.push(wiki('a0', NAV.sections), wiki('a1', [], 'Empty'), note('a2'));
    const once = serializeWhiteboard(board);
    const parsed = parseWhiteboard(once);
    expect(parsed.elements.map(sectionsOf)).toEqual(board.elements.map(sectionsOf));
    expect(sectionsOf(parsed.elements[0])).toEqual(NAV.sections);
    expect(serializeWhiteboard(parsed)).toBe(once);
    expect(once).not.toContain('dreamcontext-wiki');
    // The card's title is the board's human-readable surface, like any widget title.
    expect(once).toContain(`Handbook ^${board.elements[0].id}`);
  });

  it('the store: an edit through mutateWhiteboard is on disk, and a scene PUT of a stale copy cannot undo it', async () => {
    const { slug } = createWhiteboard(root, 'Store');
    const card = wiki('a0');
    await mutateWhiteboard(root, slug, (b) => { b.elements.push(card); });
    await mutateWhiteboard(root, slug, (b) => {
      const i = b.elements.findIndex((e) => e.id === card.id);
      b.elements[i] = applyWikiEdit(b.elements[i], (n) => addSection(n, 'Docs', { id: 'docs' }).nav);
    });
    const r = await call(handleWhiteboardPut, { method: 'PUT', params: { slug }, body: { elements: [card] } });
    expect(r.status).toBe(200);
    const onDisk = readWhiteboard(root, slug).board.elements.find((e) => e.id === card.id)!;
    expect(sectionsOf(onDisk)).toEqual([{ id: 'docs', title: 'Docs', pages: [] }]);
  });

  it('git sync: a list edited on one side and a widget added on the other both land', () => {
    const { path } = createWhiteboard(root, 'Sync');
    const start = parseWhiteboard(readFileSync(path, 'utf-8'));
    const card = wiki('a0', NAV.sections);
    start.elements.push(card);
    const base = serializeWhiteboard(start);
    const oursBoard = parseWhiteboard(base);
    oursBoard.elements[0] = applyWikiEdit(oursBoard.elements[0], (n) => moveSection(n, 's-ref', 0));
    const theirsBoard = parseWhiteboard(base);
    theirsBoard.elements.push(note('a1'));
    const { merged, needsAgent } = mergeWhiteboardMd(base, serializeWhiteboard(oursBoard), serializeWhiteboard(theirsBoard));
    expect(needsAgent).toBe(false);
    const m = parseWhiteboard(merged!);
    expect(m.elements).toHaveLength(2);
    expect((sectionsOf(m.elements.find((e) => e.id === card.id)!) as { id: string }[]).map((s) => s.id)).toEqual(['s-ref', 's-intro']);
  });
});

describe('the board-level wiki menu is gone', () => {
  it('an unknown frontmatter key (an old `dreamcontext-wiki` included) is kept byte for byte through a write', async () => {
    const { slug, path } = createWhiteboard(root, 'Legacy');
    const lines = ['"dreamcontext-wiki": {"sections":[{"id":"a","title":"A","pages":[{"ref":"../x.md"}]}]}', '"x-custom": "kept"'];
    const raw = readFileSync(path, 'utf-8').replace('excalidraw-plugin: parsed\n', `excalidraw-plugin: parsed\n${lines.join('\n')}\n`);
    writeFileSync(path, raw);
    await mutateWhiteboard(root, slug, (b) => { b.elements.push(note('a0')); });
    const after = readFileSync(path, 'utf-8');
    for (const line of lines) expect(after).toContain(`${line}\n`);
    expect(readWhiteboard(root, slug).board.elements).toHaveLength(1);
  });

  it('GET board carries no nav fields; the nav routes are not exported or routed', async () => {
    const { slug } = createWhiteboard(root, 'Routes');
    const r = await call(handleWhiteboardGet, { params: { slug } });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['description', 'elements', 'name', 'rev', 'slug']);
    expect('handleWhiteboardNavGet' in routes).toBe(false);
    expect('handleWhiteboardNavPut' in routes).toBe(false);
    const index = readFileSync(join(__dirname, '../../src/server/index.ts'), 'utf-8');
    expect(index).not.toMatch(/whiteboards\/:slug\/nav/);
    expect(index).toContain("router.get('/api/whiteboards/pages', handleWhiteboardPages)");
  });

  it('pages is a reserved board slug', () => {
    expect(createWhiteboard(root, 'Pages').slug).toBe('pages-2');
  });
});

// ─── widget contract ────────────────────────────────────────────────────────

describe('page widgets: a knowledge widget ref may be a slug or a project path', () => {
  it('accepts old slugs and new paths; refuses traversal; other kinds stay slug-only', () => {
    for (const ref of ['architecture/overview', 'docs/spec.pdf', 'site/index.html', 'Notes/Plan.md']) {
      expect(() => validateElement(makeWidgetElement('knowledge', { ref }, { x: 0, y: 0 }, 'a0'))).not.toThrow();
    }
    for (const ref of ['../x.md', '/abs.md', 'docs/a.exe']) {
      expect(() => validateElement(makeWidgetElement('knowledge', { ref }, { x: 0, y: 0 }, 'a0'))).toThrow(/invalid widget ref/);
    }
    expect(() => validateElement(makeWidgetElement('task', { ref: 'docs/spec.pdf' }, { x: 0, y: 0 }, 'a0'))).toThrow(/invalid widget ref/);
  });
});

// ─── page search ────────────────────────────────────────────────────────────

describe('page search (pages.ts)', () => {
  function seed(): void {
    const k = join(root, 'knowledge');
    mkdirSync(join(k, 'architecture'), { recursive: true });
    writeFileSync(join(k, 'architecture', 'overview.md'), '---\nname: "System Overview"\n---\nbody');
    writeFileSync(join(k, 'glossary.md'), 'no frontmatter');
    mkdirSync(join(project, 'docs'), { recursive: true });
    writeFileSync(join(project, 'docs', 'spec.pdf'), '%PDF');
    writeFileSync(join(project, 'docs', 'guide.md'), '# g');
    writeFileSync(join(project, 'docs', 'site.html'), '<p>');
    writeFileSync(join(project, 'docs', 'notes.txt'), 'x');
    for (const d of ['node_modules/pkg', '.git', 'dist', 'build', '.hidden']) {
      mkdirSync(join(project, d), { recursive: true });
      writeFileSync(join(project, d, 'skip.md'), 'x');
    }
    mkdirSync(join(root, 'whiteboards', 'b'), { recursive: true });
    writeFileSync(join(root, 'whiteboards', 'b', 'b.excalidraw.md'), 'x');
  }

  it('lists knowledge (by slug) and project .md/.pdf/.html files with a kind; skips junk dirs', () => {
    seed();
    const { pages, truncated } = searchPages(root, '');
    expect(truncated).toBe(false);
    const refs = pages.map((p) => p.ref);
    expect(refs).toEqual(['architecture/overview', 'glossary', 'docs/guide.md', 'docs/site.html', 'docs/spec.pdf']);
    expect(pages[0]).toEqual({
      ref: 'architecture/overview', kind: 'md', source: 'knowledge', title: 'System Overview',
      path: '_dream_context/knowledge/architecture/overview.md',
    });
    expect(pages.find((p) => p.ref === 'docs/spec.pdf')).toMatchObject({ kind: 'pdf', source: 'file' });
    expect(pages.find((p) => p.ref === 'docs/site.html')).toMatchObject({ kind: 'html', source: 'file' });
  });

  it('matches every term against title or ref, case-insensitive; kind filter and limit', () => {
    seed();
    expect(searchPages(root, 'system').pages.map((p) => p.ref)).toEqual(['architecture/overview']);
    expect(searchPages(root, 'DOCS spec').pages.map((p) => p.ref)).toEqual(['docs/spec.pdf']);
    expect(searchPages(root, '', { kind: 'pdf' }).pages.map((p) => p.ref)).toEqual(['docs/spec.pdf']);
    const limited = searchPages(root, '', { limit: 2 });
    expect(limited.pages).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it('never follows a symlink out of the project', () => {
    seed();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-nav-out-')));
    try {
      writeFileSync(join(outside, 'secret.md'), 'x');
      symlinkSync(outside, join(project, 'docs', 'linked'));
      symlinkSync(join(outside, 'secret.md'), join(project, 'docs', 'secret.md'));
      clearPageIndexCache();
      expect(searchPages(root, 'secret').pages).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('the route returns hits and refuses an unknown kind', async () => {
    seed();
    let r = await call(handleWhiteboardPages, { url: '/api/whiteboards/pages?q=guide' });
    expect(r.status).toBe(200);
    expect(r.body.pages.map((p: { ref: string }) => p.ref)).toEqual(['docs/guide.md']);
    r = await call(handleWhiteboardPages, { url: '/api/whiteboards/pages?kind=exe' });
    expect(r.status).toBe(400);
  });
});
