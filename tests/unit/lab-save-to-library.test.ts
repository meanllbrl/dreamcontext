/**
 * "Save HTML to library" (dashboard/src/components/lab/board/SaveToLibraryDialog.tsx): the slug
 * is validated like the engine's, the request is `PUT /api/lab/blocks/:slug` with the fields the
 * route reads (rev-guarded when it replaces an entry), and after the save the block on the card
 * is reused by ref: `html: {ref, inputs}` in the board file.
 *
 * Pure-function tests over editorModel.ts (this repo runs no DOM harness). The engine functions
 * are imported alongside to prove the client mirrors agree with what the server enforces and
 * writes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import catalogJson from '../../dashboard/src/generated/block-catalog.json';
import type { Block, BlockCatalog, Card } from '../../dashboard/src/components/lab/board/boardTypes';
import {
  cardProblems, inlineToRef, isSafeSlug, libraryDraftFrom, libraryDraftProblems, libraryPutRequest, refToInline,
  slugSuggestion, updateBlock, type LibraryDraft,
} from '../../dashboard/src/components/lab/board/editorModel';
import { isSafeInsightSlug } from '../../src/lib/lab/store';
import { validateLibraryBlock } from '../../src/lib/lab/block-library';
import { boardSpecToFile, validateBoardSpec } from '../../src/lib/lab/boards';

const catalog = catalogJson as unknown as BlockCatalog;
const SRC = join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/board');

const inline: Block = { type: 'html', options: { html: '<div id="g"></div>', inputs: { cohorts: 'daily-signups/by-week', extra: 'mrr' } } };
const draft = (patch: Partial<LibraryDraft> = {}): LibraryDraft => ({
  slug: 'cohort-grid', title: 'Cohort grid', description: '', inputs: [{ name: 'cohorts', kind: 'table' }], ...patch,
});

describe('slug validation', () => {
  it('mirrors the engine slug rule exactly', () => {
    for (const s of ['cohort-grid', 'a', 'a1-b2', 'x-', '-x', 'a--b', 'Cohort', 'a_b', 'a b', '../x', 'a%2Fb', 'a/b', '', 'ğ']) {
      expect(isSafeSlug(s), JSON.stringify(s)).toBe(isSafeInsightSlug(s));
    }
  });

  it('suggests an ASCII kebab slug from the title, Turkish letters folded', () => {
    expect(slugSuggestion('Cohort Grid')).toBe('cohort-grid');
    expect(slugSuggestion('Haftalık Büyüme Özeti')).toBe('haftalik-buyume-ozeti');
    expect(slugSuggestion('  Çağrı / İş -- Şablonu!! ')).toBe('cagri-is-sablonu');
    expect(slugSuggestion('!!!')).toBe('');
    expect(isSafeSlug(slugSuggestion('Haftalık Büyüme Özeti'))).toBe(true);
  });

  it('draft problems: slug, title, html, input names and duplicates', () => {
    expect(libraryDraftProblems(draft(), '<p/>')).toEqual([]);
    expect(libraryDraftProblems(draft({ slug: 'Bad Slug' }), '<p/>')).toEqual(['slug']);
    expect(libraryDraftProblems(draft({ title: '  ' }), '<p/>')).toEqual(['title']);
    expect(libraryDraftProblems(draft(), '   ')).toEqual(['html']);
    expect(libraryDraftProblems(draft({ inputs: [{ name: '1x', kind: null }] }), '<p/>')).toEqual(['input-name']);
    expect(libraryDraftProblems(draft({ inputs: [{ name: 'a', kind: null }, { name: 'a', kind: 'table' }] }), '<p/>')).toEqual(['input-duplicate']);
  });

  it('agrees with the server validation: a clean draft passes, a flagged one fails', () => {
    const cases: Array<[LibraryDraft, string]> = [
      [draft(), '<p/>'], [draft({ slug: 'x-' }), '<p/>'], [draft({ title: '' }), '<p/>'], [draft(), ''],
      [draft({ inputs: [{ name: 'bad name', kind: null }] }), '<p/>'],
    ];
    for (const [d, html] of cases) {
      const req = libraryPutRequest(d, html, null);
      const server = validateLibraryBlock(d.slug, { title: req.body.title, description: req.body.description, inputs: req.body.inputs, html });
      expect(libraryDraftProblems(d, html).length === 0, JSON.stringify(d)).toBe(server.length === 0);
    }
  });
});

describe('the request', () => {
  it('first values come from the inline block: its input names, kinds unset', () => {
    expect(libraryDraftFrom(inline)).toEqual({
      slug: '', title: '', description: '', inputs: [{ name: 'cohorts', kind: null }, { name: 'extra', kind: null }],
    });
  });

  it('is PUT /lab/blocks/:slug with title, description, inputs, html and rev null for a new entry', () => {
    const req = libraryPutRequest(draft({ slug: ' cohort-grid ', title: ' Cohort grid ', description: '  ' }), '<div id="g"></div>', null);
    expect(req).toEqual({
      path: '/lab/blocks/cohort-grid',
      body: { title: 'Cohort grid', description: null, inputs: [{ name: 'cohorts', kind: 'table' }], html: '<div id="g"></div>', rev: null },
    });
  });

  it('replacing an existing entry sends its rev (the route answers 409 if it moved)', () => {
    const req = libraryPutRequest(draft({ description: 'Retention' }), '<p/>', { rev: 'abc123' });
    expect(req.body.rev).toBe('abc123');
    expect(req.body.description).toBe('Retention');
  });

  it('the dialog sends the request through the library PUT hook, never a board PUT', () => {
    const dialog = readFileSync(join(SRC, 'SaveToLibraryDialog.tsx'), 'utf8');
    const hook = readFileSync(join(SRC, 'useSaveLibraryBlock.ts'), 'utf8');
    expect(dialog).toMatch(/save\.mutate\(libraryPutRequest\(draft, html, existing\)/);
    expect(hook).toMatch(/api\.put<\{ block: LibraryBlock \}>\(req\.path, req\.body\)/);
    expect(dialog + hook).not.toMatch(/\/lab\/boards/);
    expect(dialog).not.toMatch(/—/);
  });
});

describe('reuse by ref', () => {
  const saved = { slug: 'cohort-grid', inputs: [{ name: 'cohorts', kind: 'table' as const }] };

  it('the inline block becomes {ref, inputs}; bindings for declared names are kept, others dropped', () => {
    expect(inlineToRef(inline, saved)).toEqual({ type: 'html', options: { ref: 'cohort-grid', inputs: { cohorts: 'daily-signups/by-week' } } });
  });

  it('the board file carries html: {ref, inputs}, and the engine strict validation accepts it', () => {
    const card: Card = { id: 'c-grid', at: { x: 0, y: 0, w: 6, h: 6 }, blocks: [inline] };
    const next = updateBlock(card, [0], (b) => inlineToRef(b, saved));
    expect(cardProblems(catalog, next)).toEqual([]);
    const spec = { title: 'Growth', order: 1, cards: [next], body: '' };
    const file = boardSpecToFile(spec) as { cards: Array<{ blocks: unknown[] }> };
    expect(file.cards[0].blocks).toEqual([{ html: { ref: 'cohort-grid', inputs: { cohorts: 'daily-signups/by-week' } } }]);
    const checked = validateBoardSpec(file, 'growth');
    expect(checked.errors).toEqual([]);
    expect(checked.spec.cards[0].blocks![0]).toEqual({ type: 'html', options: { ref: 'cohort-grid', inputs: { cohorts: 'daily-signups/by-week' } } });
  });

  it('the same library entry is reusable on another card', () => {
    const other: Block = { type: 'html', options: { html: '<p>x</p>', inputs: { cohorts: 'weekly-trials' } } };
    expect(inlineToRef(other, saved).options).toEqual({ ref: 'cohort-grid', inputs: { cohorts: 'weekly-trials' } });
  });

  it('"edit a copy" turns a ref back into inline markup with its bindings', () => {
    const ref = inlineToRef(inline, saved);
    expect(refToInline(ref, { html: '<div id="g"></div>' })).toEqual({
      type: 'html', options: { html: '<div id="g"></div>', inputs: { cohorts: 'daily-signups/by-week' } },
    });
  });

  it('the inspector turns the block into a ref after the save, as one card edit', () => {
    const src = readFileSync(join(SRC, 'BlockInspector.tsx'), 'utf8');
    expect(src).toMatch(/onSaved=\{\(entry\) => \{[\s\S]*?editSelected\(\(b\) => inlineToRef\(b, entry\)\)/);
  });
});
