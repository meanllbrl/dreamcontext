/**
 * Saved blocks — the store, and the report composed out of them.
 *
 * The two things worth pinning here are the ones that bite later: a title is user text that
 * becomes a PATH (so traversal is a real question, not a hypothetical), and the recall body
 * must be the block's WORDS rather than its markup, or every saved artifact matches "div"
 * and none of them match what the user actually searches for.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveArtifact, getArtifact, listArtifacts, deleteArtifact, artifactPath,
  slugifyArtifact, isSafeArtifactSlug, extractBlockText, uniqueArtifactSlug, ArtifactError,
} from '../../src/lib/artifacts-store.js';
import { buildCorpus, CORPUS_TYPES } from '../../src/lib/recall.js';
import { artifactReportToHtml } from '../../dashboard/src/lib/artifactReport.js';

let root: string;

const BLOCK = '<div class="dc-doc"><h2 class="dc-h2">Pay el değiştiriyor</h2>'
  + '<p class="dc-p">Üç çeyrekte ikinci sıraya düştük.</p>'
  + '<script>document.title = "x"</script></div>';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-artifacts-'));
  mkdirSync(join(root, 'state'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('slugs — a title is user text that becomes a path', () => {
  it.each([
    ['Pay el değiştiriyor', 'pay-el-degistiriyor'],
    ['Uyku borcu EŞİKLERİ', 'uyku-borcu-esikleri'],
    ['  spaced  out  ', 'spaced-out'],
    ['', 'block'],
    ['!!!', 'block'],
  ])('%s -> %s', (title, expected) => {
    expect(slugifyArtifact(title)).toBe(expected);
  });

  it('cannot traverse out of the artifacts directory', () => {
    // Both halves: the slugifier never PRODUCES one, and the gate never ACCEPTS one — the
    // second matters because a slug can also arrive from the request body on a re-save.
    expect(slugifyArtifact('../../etc/passwd')).toBe('etc-passwd');
    for (const evil of ['../x', 'a/b', '..', '/abs', 'a..b/../c', '.hidden', 'A-Upper']) {
      expect(isSafeArtifactSlug(evil), evil).toBe(false);
    }
    expect(isSafeArtifactSlug('pay-el-degistiriyor')).toBe(true);
  });

  it('saving twice under one name never silently overwrites the first', () => {
    const a = saveArtifact(root, { title: 'Panel', html: BLOCK });
    const b = saveArtifact(root, { title: 'Panel', html: BLOCK });
    expect(a.slug).toBe('panel');
    expect(b.slug).toBe('panel-2');
    expect(uniqueArtifactSlug(root, 'panel')).toBe('panel-3');
    expect(listArtifacts(root)).toHaveLength(2);
  });
});

describe('the saved file', () => {
  it('keeps the markup byte-exact, so re-opening is not a re-render', () => {
    saveArtifact(root, { title: 'Panel', html: BLOCK });
    expect(getArtifact(root, 'panel')?.html).toBe(BLOCK);
  });

  it('carries the conversation it came from — the provenance the request asks for', () => {
    saveArtifact(root, {
      title: 'Panel', html: BLOCK, sourceTitle: 'marketing-os', sourceSession: 'chat-7',
    });
    const a = getArtifact(root, 'panel');
    expect(a?.sourceTitle).toBe('marketing-os');
    expect(a?.sourceSession).toBe('chat-7');
  });

  it('stores the block in a fence and its WORDS as prose above it', () => {
    saveArtifact(root, { title: 'Panel', html: BLOCK });
    const raw = readFileSync(artifactPath(root, 'panel'), 'utf-8');
    expect(raw).toContain('```dream-html');
    expect(raw.indexOf('Üç çeyrekte')).toBeLessThan(raw.indexOf('```dream-html'));
  });

  it('refuses an empty block and a nameless one, loudly', () => {
    expect(() => saveArtifact(root, { title: '', html: BLOCK })).toThrow(ArtifactError);
    expect(() => saveArtifact(root, { title: 'x', html: '   ' })).toThrow(ArtifactError);
  });

  it('lists newest first, and deleting really deletes', () => {
    saveArtifact(root, { title: 'One', html: BLOCK });
    saveArtifact(root, { title: 'Two', html: BLOCK });
    expect(listArtifacts(root).map((a) => a.slug).sort()).toEqual(['one', 'two']);
    expect(deleteArtifact(root, 'one')).toBe(true);
    expect(existsSync(artifactPath(root, 'one'))).toBe(false);
    expect(deleteArtifact(root, 'one')).toBe(false);
    expect(deleteArtifact(root, '../../etc/passwd')).toBe(false);
  });

  it('a stray file in the folder is skipped, not a crash', () => {
    saveArtifact(root, { title: 'Real', html: BLOCK });
    writeFileSync(join(root, 'artifacts', 'notes.md'), '# just a note\n');
    expect(listArtifacts(root).map((a) => a.slug)).toEqual(['real']);
  });
});

describe('the text extraction — what recall actually matches on', () => {
  it('keeps the words and drops the markup', () => {
    const text = extractBlockText(BLOCK);
    expect(text).toContain('Pay el değiştiriyor');
    expect(text).toContain('Üç çeyrekte ikinci sıraya düştük.');
    expect(text).not.toContain('dc-doc');
    expect(text).not.toContain('<');
  });

  it('drops script and style CONTENT, not just their tags', () => {
    // Otherwise every artifact indexes its own JavaScript, and a search for "document"
    // returns the lot of them.
    expect(extractBlockText(BLOCK)).not.toContain('document.title');
    expect(extractBlockText('<style>.a{color:red}</style><p>hi</p>')).toBe('hi');
  });

  it('unescapes entities so a search for the real word hits', () => {
    expect(extractBlockText('<p>a &lt; b &amp; c</p>')).toBe('a < b & c');
  });
});

describe('recall', () => {
  it('artifact is a first-class corpus channel', () => {
    expect(CORPUS_TYPES).toContain('artifact');
  });

  it('a saved block is findable by what it SAYS, not by its tag names', () => {
    saveArtifact(root, { title: 'Pay el değiştiriyor', html: BLOCK, sourceTitle: 'marketing-os' });
    const docs = buildCorpus(root, { types: ['artifact'] });
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Pay el değiştiriyor');
    expect(docs[0].body).toContain('Üç çeyrekte');
    // The markup IS in the file (it has to be — it is the artifact), but the words come
    // first and are what a human's query will land on.
    expect(docs[0].tokenSet.has('div')).toBe(false);
  });

  it('an empty artifacts folder contributes nothing and throws nothing', () => {
    expect(buildCorpus(root, { types: ['artifact'] })).toEqual([]);
  });
});

describe('the composed report', () => {
  const tokens = { '--color-text': '#111', '--color-accent': '#7c9cff' };
  const doc = artifactReportToHtml({
    title: 'Q3 okuması',
    intro: 'Üç blok.',
    tokens,
    blocks: [
      { title: 'Pay', html: BLOCK, prose: 'Bu düşüş\n\nikinci çeyrekte başladı.', source: 'marketing-os', date: '2026-09-02' },
      { title: 'Borç', html: '<div class="dc-doc"><p class="dc-p">x</p></div>' },
    ],
  });

  it('wears the Reports masthead — the same family of document, visibly', () => {
    expect(doc).toContain('rp-masthead');
    expect(doc).toContain('rp-logotype');
    expect(doc).toContain('rp-rule');
  });

  it('carries the kit BEFORE the report template, so the template wins the cascade', () => {
    // The kit styles what is inside each block; the template styles the page around them.
    // Reversed, the kit's `body` rule would beat the sheet's and the report would lose its
    // measure. Same ordering `reportToHtml` uses, same reason.
    expect(doc.indexOf('.dc-doc')).toBeLessThan(doc.indexOf('.rp-sheet'));
  });

  it('holds every block, its prose and its provenance', () => {
    expect(doc).toContain('Pay el değiştiriyor');
    expect(doc).toContain('ikinci çeyrekte başladı.');
    expect(doc).toContain('marketing-os');
    expect(doc).toContain('2026-09-02');
    expect(doc.match(/rp-section"/g)).toHaveLength(2);
  });

  it('is self-contained and keeps the CSP — same inheritance as one block', () => {
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toMatch(/<link[^>]+href|@import\s/);
  });

  it('escapes the prose it is given but not the blocks it composes', () => {
    const hostile = artifactReportToHtml({
      title: '<script>t()</script>', tokens, blocks: [{ title: 'x', html: '<p class="dc-p">ok</p>' }],
    });
    expect(hostile).toContain('&lt;script&gt;t()&lt;/script&gt;');
    expect(hostile).toContain('<p class="dc-p">ok</p>');
  });

  it('says so honestly when nothing was picked', () => {
    expect(artifactReportToHtml({ title: 'x', tokens, blocks: [] })).toContain('No blocks selected');
  });
});
