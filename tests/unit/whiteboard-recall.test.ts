import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bm25Search, buildCorpus, CORPUS_TYPES, docKey } from '../../src/lib/recall.js';
import { createWhiteboard, mutateWhiteboard, nextIndices, trashWhiteboard } from '../../src/lib/whiteboards/store.js';
import { makeWidgetElement, type WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';
import { htmlVisibleText, whiteboardRecallText, MAX_HTML_TEXT } from '../../src/lib/whiteboards/recall-text.js';

/** Scratch context root per test (injectable-root isolation): the real brain is never read. */
let root: string;

beforeEach(() => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-recall-')));
  root = join(project, '_dream_context');
  mkdirSync(root);
});
afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

function text(id: string, originalText: string, extra: Record<string, unknown> = {}): WhiteboardElement {
  return { id, type: 'text', version: 1, originalText, text: originalText, x: 1234, y: 5678, ...extra };
}

async function addAll(slug: string, make: (idx: string[]) => WhiteboardElement[]): Promise<void> {
  await mutateWhiteboard(root, slug, (b) => {
    b.elements.push(...make(nextIndices(b.elements, 12)));
  });
}

describe('whiteboardRecallText', () => {
  it('reads text elements and every widget payload, never the scene', () => {
    const els: WhiteboardElement[] = [
      text('t1', 'Quarterly kraken roadmap'),
      makeWidgetElement('note', { title: 'Note title', markdown: 'pelican **migration** plan' }, { x: 0, y: 0 }, 'a1'),
      makeWidgetElement('todo', { title: 'Todos', items: [{ id: 'i1', text: 'ship walrus export', done: false }] }, { x: 0, y: 0 }, 'a2'),
      makeWidgetElement('wiki', {
        title: 'Handbook',
        sections: [{ id: 's1', title: 'Onboarding narwhal', pages: [{ ref: 'docs/guide.md', label: 'Setup guide' }, { ref: 'recall-engine-v2' }] }],
      }, { x: 0, y: 0 }, 'a3'),
      makeWidgetElement('html', { title: 'Report', html: '<style>.x{color:red}</style><h1>Otter &amp; badger</h1><script>evilToken()</script>' }, { x: 0, y: 0 }, 'a4'),
      makeWidgetElement('task', { ref: 'fix-login-bug', title: 'Login bug' }, { x: 0, y: 0 }, 'a5'),
      makeWidgetElement('knowledge', { ref: 'docs/spec.pdf' }, { x: 0, y: 0 }, 'a6'),
      { id: 'f1', type: 'frame', version: 1, name: 'Sprint lane' },
    ];
    const { body, refs } = whiteboardRecallText(els);
    for (const w of ['kraken', 'pelican', 'walrus', 'narwhal', 'Setup guide', 'recall-engine-v2', 'Otter & badger', 'Login bug', 'fix-login-bug', 'Sprint lane']) {
      expect(body).toContain(w);
    }
    expect(body).not.toMatch(/evilToken|color:red|1234|5678|customData|<h1>/);
    // Slug refs become links; a page card's file path does not.
    expect(refs.sort()).toEqual(['fix-login-bug', 'recall-engine-v2']);
  });

  it('skips deleted elements (tombstones are kept forever)', () => {
    const gone = makeWidgetElement('note', { markdown: 'erased secret plan' }, { x: 0, y: 0 }, 'a1');
    gone.isDeleted = true;
    const { body } = whiteboardRecallText([gone, text('t1', 'kept', { isDeleted: true }), text('t2', 'visible')]);
    expect(body).toBe('visible');
  });

  it('caps an HTML block so an embedded report cannot drown the board', () => {
    const big = makeWidgetElement('html', { html: `<p>${'word '.repeat(2000)}</p>` }, { x: 0, y: 0 }, 'a1');
    expect(whiteboardRecallText([big]).body.length).toBeLessThanOrEqual(MAX_HTML_TEXT);
  });

  it('decodes entities and folds whitespace', () => {
    expect(htmlVisibleText('<p>a&nbsp;&lt;b&gt;\n\n  &#231;&#x131;</p>')).toBe('a <b> çı');
  });
});

describe('buildCorpus — whiteboard channel', () => {
  it('is a corpus type and indexes a board by its card contents', async () => {
    expect(CORPUS_TYPES).toContain('whiteboard');
    const { slug } = createWhiteboard(root, 'Growth wall', 'where the funnel lives');
    await addAll(slug, (idx) => [
      makeWidgetElement('note', { markdown: 'zebrafish onboarding experiment' }, { x: 0, y: 0 }, idx[0]),
      makeWidgetElement('todo', { items: [{ id: 'i1', text: 'audit platypus paywall', done: false }] }, { x: 0, y: 0 }, idx[1]),
    ]);

    const corpus = buildCorpus(root, { types: ['whiteboard'] });
    expect(corpus.map(docKey)).toEqual([`whiteboard/${slug}`]);
    const [doc] = corpus;
    expect(doc.title).toBe('Growth wall');
    expect(doc.description).toBe('where the funnel lives');
    expect(doc.tags).not.toContain('excalidraw');
    expect(doc.capture).toBeFalsy();
    expect(doc.relPath).toBe(`whiteboards/${slug}/${slug}.excalidraw.md`);

    const hits = bm25Search('platypus paywall', buildCorpus(root));
    expect(hits[0]?.doc.type).toBe('whiteboard');
  });

  it('is not loaded when the type filter leaves it out', () => {
    createWhiteboard(root, 'Board');
    expect(buildCorpus(root, { types: ['knowledge'] })).toEqual([]);
  });

  it('never indexes the trash or a symlinked board folder', async () => {
    const { slug } = createWhiteboard(root, 'Doomed');
    await trashWhiteboard(root, slug);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-recall-out-')));
    try {
      mkdirSync(join(outside, 'evil'));
      writeFileSync(join(outside, 'evil', 'evil.excalidraw.md'), '---\nname: evil\n---\n## Text Elements\nleaked ^abcd1234\n');
      symlinkSync(join(outside, 'evil'), join(root, 'whiteboards', 'evil'));
      expect(buildCorpus(root, { types: ['whiteboard'] })).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('falls back to the Text Elements of a board it cannot parse (Obsidian compressed-json)', () => {
    mkdirSync(join(root, 'whiteboards', 'obs'), { recursive: true });
    writeFileSync(
      join(root, 'whiteboards', 'obs', 'obs.excalidraw.md'),
      '---\nname: Obsidian board\ntags: [excalidraw]\n---\n## Text Elements\nmanatee label ^abcd1234\n\n%%\n## Drawing\n```compressed-json\nN4Ig\n```\n%%\n',
    );
    const [doc] = buildCorpus(root, { types: ['whiteboard'] });
    expect(doc.slug).toBe('obs');
    expect(doc.body).toContain('manatee label');
    expect(doc.body).not.toContain('N4Ig');
  });
});
